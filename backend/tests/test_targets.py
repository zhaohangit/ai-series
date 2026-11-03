import uuid

from test_api import client, project


class ImageProvider:
    def available(self, kind):
        return kind == "image"

    def generate(self, kind, prompt, parameters):
        return {"url": "https://provider.example/generated-result.png", "external_url": True}


def payload(pid, **parameters):
    return {"kind": "image", "prompt": "test", "project_id": pid, "parameters": parameters, "idempotency_key": uuid.uuid4().hex}


def test_generated_media_updates_owned_shot_and_rejects_other_project(client):
    client.app.state.provider = ImageProvider()
    pid = project(client)["id"]
    shot = client.post(f"/api/projects/{pid}/shots", json={"name": "shot"}).json()
    task = client.post("/api/tasks", json=payload(pid, shot_id=shot["id"])).json()
    result = client.get(f"/api/tasks/{task['id']}").json()["result"]
    assert result["application"]["status"] == "applied"
    assert client.get(f"/api/projects/{pid}/shots").json()["items"][0]["image_url"] == "https://provider.example/generated-result.png"
    another = project(client)["id"]
    assert client.post("/api/tasks", json=payload(another, shot_id=shot["id"])).status_code == 422


def test_generated_media_preserves_concurrent_shot_edit(client, monkeypatch):
    import app.main as module
    actual = module.execute_task
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    client.app.state.provider = ImageProvider()
    pid = project(client)["id"]
    shot = client.post(f"/api/projects/{pid}/shots", json={"name": "shot"}).json()
    task = client.post("/api/tasks", json=payload(pid, shot_id=shot["id"])).json()
    client.patch(f"/api/shots/{shot['id']}", json={"prompt": "newer user edit"})
    actual(client.app, task["id"])
    result = client.get(f"/api/tasks/{task['id']}").json()["result"]
    assert result["application"]["status"] == "conflict"
    assert result["url"] == "https://provider.example/generated-result.png"
    assert client.get(f"/api/projects/{pid}/shots").json()["items"][0]["image_url"] is None


def test_targeted_tasks_serialize_concurrent_owner_submissions(client, monkeypatch):
    import app.main as module
    from concurrent.futures import ThreadPoolExecutor
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    client.app.state.provider = ImageProvider()
    pid = project(client)["id"]
    shot = client.post(f"/api/projects/{pid}/shots", json={"name": "shot"}).json()
    before = client.get("/api/credits").json()["balance"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.post("/api/tasks", json=payload(pid, shot_id=shot["id"])), range(2)))
    assert sorted(result.status_code for result in results) == [202, 409]
    assert client.get("/api/credits").json()["balance"] == before - 1


def test_canvas_generation_uses_revision_cas_and_keeps_candidate(client, monkeypatch):
    import app.main as module
    actual = module.execute_task
    client.app.state.provider = ImageProvider()
    pid = project(client, kind="canvas")["id"]
    graph = {"nodes": [{"id": "node", "data": {"kind": "image"}}], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}, "revision": 0}
    client.put(f"/api/projects/{pid}/canvas", json=graph)
    task = client.post("/api/tasks", json=payload(pid, node_id="node", canvas_revision=1)).json()
    graph = client.get(f"/api/projects/{pid}/canvas").json()
    assert graph["revision"] == 2
    assert graph["nodes"][0]["data"]["url"] == "https://provider.example/generated-result.png"
    assert client.post("/api/tasks", json=payload(pid, node_id="node", canvas_revision=1)).status_code == 409
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    task = client.post("/api/tasks", json=payload(pid, node_id="node", canvas_revision=2)).json()
    graph["nodes"][0]["data"]["text"] = "newer edit"
    client.put(f"/api/projects/{pid}/canvas", json=graph)
    actual(client.app, task["id"])
    result = client.get(f"/api/tasks/{task['id']}").json()["result"]
    assert result["application"]["status"] == "conflict"
    assert client.get(f"/api/projects/{pid}/canvas").json()["nodes"][0]["data"]["text"] == "newer edit"


def test_concurrent_shot_patch_preserves_independent_fields_postgres(client):
    import pytest
    import time
    from concurrent.futures import ThreadPoolExecutor
    from sqlalchemy import select
    from app.models import Shot
    if not client.app.state.database_url.startswith("postgresql"):
        pytest.skip("Row lock integration test requires PostgreSQL")
    pid = project(client)["id"]
    shot = client.post(f"/api/projects/{pid}/shots", json={"name": "shot"}).json()
    with ThreadPoolExecutor(max_workers=2) as pool:
        with client.app.state.session_factory() as session:
            session.scalar(select(Shot).where(Shot.id == shot["id"]).with_for_update())
            first = pool.submit(client.patch, f"/api/shots/{shot['id']}", json={"prompt": "new prompt"})
            second = pool.submit(client.patch, f"/api/shots/{shot['id']}", json={"dialogue": "new dialogue"})
            time.sleep(.3)
            session.commit()
        assert first.result().status_code == 200
        assert second.result().status_code == 200
    saved = client.get(f"/api/projects/{pid}/shots").json()["items"][0]
    assert saved["prompt"] == "new prompt"
    assert saved["dialogue"] == "new dialogue"
