import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    url = os.getenv("TEST_DATABASE_URL", f"sqlite:///{tmp_path}/test.sqlite")
    admin_engine, schema = None, None
    if url.startswith("postgresql"):
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        admin_engine = create_engine(url)
        schema = "test_" + uuid.uuid4().hex
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        url = make_url(url).update_query_dict({"options": f"-csearch_path={schema}"}).render_as_string(hide_password=False)
    app = create_app(database_url=url, media_root=tmp_path / "media", session_secret=uuid.uuid4().hex)
    try:
        with TestClient(app) as client:
            yield client
    finally:
        if admin_engine:
            with admin_engine.begin() as connection:
                connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            admin_engine.dispose()


def project(client, **extra):
    response = client.post("/api/projects", json={"name": "雨夜", "kind": "series", **extra})
    assert response.status_code == 201, response.text
    return response.json()


def test_crud_persists_nested_content_and_cascades(client):
    item = project(client, script="第一集 雨夜\n雨落下来。\n第二集 清晨\n太阳升起。")
    pid = item["id"]
    parsed = client.post(f"/api/projects/{pid}/parse-script").json()
    assert parsed["mode"] == "deterministic_local_parser"
    assert len(parsed["episodes"]) == 2
    episode = client.post(f"/api/projects/{pid}/episodes", json={"name": "第一集", "script": "雨落下来。"}).json()
    shot = client.post(f"/api/projects/{pid}/shots", json={"name": "远景", "episode_id": episode["id"], "duration": 5, "prompt": "雨夜"}).json()
    assert client.patch(f"/api/shots/{shot['id']}", json={"dialogue": "回家吧"}).status_code == 200
    clone = client.post(f"/api/projects/{pid}/duplicate").json()
    duplicate_shot = client.get(f"/api/projects/{clone['id']}/shots").json()["items"][0]
    assert duplicate_shot["dialogue"] == "回家吧"
    assert duplicate_shot["episode_id"] != episode["id"]
    assert client.get(f"/api/projects/{pid}").json()["script"].startswith("第一集")
    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.patch(f"/api/shots/{shot['id']}", json={"name": "deleted"}).status_code == 404


def test_ownership_and_nested_foreign_keys(client):
    own = project(client)
    with TestClient(client.app) as other:
        assert other.get(f"/api/projects/{own['id']}").status_code == 404
        assert other.post(f"/api/projects/{own['id']}/episodes", json={"name": "no"}).status_code == 404
    second = project(client)
    episode = client.post(f"/api/projects/{second['id']}/episodes", json={"name": "other project"}).json()
    assert client.post(f"/api/projects/{own['id']}/shots", json={"name": "no", "episode_id": episode["id"]}).status_code == 422


def test_canvas_compare_and_swap_and_duplicate(client):
    pid = project(client, kind="canvas")["id"]
    graph = {"nodes": [{"id": "n1", "position": {"x": 1, "y": 2}}], "edges": [], "viewport": {"x": 4, "y": 5, "zoom": 1.2}, "revision": 0}
    assert client.put(f"/api/projects/{pid}/canvas", json=graph).json()["revision"] == 1
    assert client.put(f"/api/projects/{pid}/canvas", json=graph).status_code == 409
    duplicate = client.post(f"/api/projects/{pid}/duplicate").json()
    assert client.get(f"/api/projects/{duplicate['id']}/canvas").json()["nodes"][0]["id"] == "n1"


def test_upload_bytes_and_safe_paths(client):
    response = client.post("/api/uploads", files={"file": ("../../hello.txt", b"hello durable bytes", "text/plain")})
    assert response.status_code == 201
    saved = response.json()
    assert ".." not in saved["url"]
    assert client.get(saved["url"]).content == b"hello durable bytes"
    with TestClient(client.app) as other:
        assert other.get(saved["url"]).status_code == 404
    assert client.get("/media/%2e%2e/pyproject.toml").status_code == 404


def test_missing_provider_has_no_charge_or_task(client):
    balance = client.get("/api/credits").json()["balance"]
    for kind in ["text", "image", "video", "audio"]:
        response = client.post("/api/tasks", json={"kind": kind, "prompt": "test", "idempotency_key": uuid.uuid4().hex})
        assert response.status_code == 503
    assert client.get("/api/tasks").json()["total"] == 0
    assert client.get("/api/credits").json()["balance"] == balance


class Provider:
    def __init__(self, fail=False):
        self.fail = fail

    def available(self, kind):
        return kind == "text"

    def generate(self, kind, prompt, parameters):
        if self.fail:
            raise RuntimeError("provider failed, secret must not be leaked")
        return {"text": "A real boundary result from an isolated test double"}


def test_task_idempotency_charge_once_and_failure_refund(client):
    client.app.state.provider = Provider()
    before = client.get("/api/credits").json()["balance"]
    payload = {"kind": "text", "prompt": "story", "idempotency_key": uuid.uuid4().hex}
    first = client.post("/api/tasks", json=payload)
    assert first.status_code == 202
    tid = first.json()["id"]
    assert client.get(f"/api/tasks/{tid}").json()["status"] == "succeeded"
    assert client.post("/api/tasks", json=payload).json()["id"] == tid
    assert client.get("/api/credits").json()["balance"] == before - 1
    assert client.post("/api/tasks", json={**payload, "prompt": "changed"}).status_code == 409
    client.app.state.provider = Provider(fail=True)
    failed = client.post("/api/tasks", json={**payload, "idempotency_key": uuid.uuid4().hex}).json()
    state = client.get(f"/api/tasks/{failed['id']}").json()
    assert state["status"] == "failed"
    assert "secret" not in state["error"]
    assert client.get("/api/credits").json()["balance"] == before - 1


def test_asset_profile_catalog_and_export(client):
    assert client.patch("/api/profile", json={"name": "本地导演"}).json()["name"] == "本地导演"
    assert client.get("/api/session").json()["user"]["name"] == "本地导演"
    assert client.get("/api/spaces").json()["total"] == 1
    asset = client.post("/api/assets", json={"name": "主角", "kind": "character", "metadata": {"notes": "雨衣"}}).json()
    assert client.get("/api/assets?kind=character&q=主角").json()["items"][0]["metadata"]["notes"] == "雨衣"
    assert client.patch(f"/api/assets/{asset['id']}", json={"name": "改名"}).status_code == 200
    assert client.delete(f"/api/assets/{asset['id']}").status_code == 204
    assert client.get("/api/catalog").json()["styles"]
    pid = project(client)["id"]
    task = client.post("/api/tasks", json={"kind": "export", "project_id": pid, "parameters": {"format": "json"}, "idempotency_key": uuid.uuid4().hex}).json()
    finished = client.get(f"/api/tasks/{task['id']}").json()
    assert finished["status"] == "succeeded"
    assert client.get(finished["result"]["url"]).json()["project"]["id"] == pid


def test_data_and_session_survive_new_app_instance(client, tmp_path):
    item = project(client)
    another = create_app(database_url=client.app.state.database_url, media_root=client.app.state.media_root, session_secret=client.app.state.session_secret)
    with TestClient(another, cookies=client.cookies) as restarted:
        assert restarted.get(f"/api/projects/{item['id']}").json()["name"] == "雨夜"
