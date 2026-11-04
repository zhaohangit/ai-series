"""Canvas history retains real server states and rejects stale writes."""
import uuid

from fastapi.testclient import TestClient

from test_api import client, project


def graph(label, revision=0):
    return {"nodes": [{"id": "node", "position": {"x": 2, "y": 3}, "data": {"label": label, "kind": "text", "text": label}}], "edges": [], "viewport": {"x": 4, "y": 5, "zoom": 1.2}, "revision": revision}


def test_empty_canvas_history_is_a_paginated_metadata_envelope(client):
    pid = project(client, kind="canvas")["id"]
    response = client.get(f"/api/projects/{pid}/canvas/versions")
    assert response.status_code == 200, response.text
    assert response.json() == {"items": [], "total": 0, "limit": 20, "offset": 0}


def test_manual_auto_restore_retains_backup_and_immutable_old_versions(client):
    pid = project(client, kind="canvas")["id"]
    base = f"/api/projects/{pid}/canvas"
    assert client.put(base, json=graph("first")).json()["revision"] == 1
    saved = client.post(f"{base}/versions", json={"name": "第一版", "revision": 1})
    assert saved.status_code == 201, saved.text
    version = saved.json()
    assert version["kind"] == "manual"
    assert version["name"] == "第一版"
    assert "nodes" not in version and "data" not in version
    assert version["node_count"] == 1 and version["edge_count"] == 0
    assert client.put(base, json=graph("second", 1)).json()["revision"] == 2
    restored = client.post(f"{base}/versions/{version['id']}/restore", json={"revision": 2})
    assert restored.status_code == 200, restored.text
    assert restored.json() == graph("first", 3)
    assert client.get(base).json() == graph("first", 3)
    listing = client.get(f"{base}/versions").json()
    assert listing["total"] >= 4
    backup = next(row for row in listing["items"] if row["kind"] == "before_restore")
    restored_version = next(row for row in listing["items"] if row["kind"] == "restored")
    assert restored_version["revision"] == 3
    assert client.get(f"{base}/versions/{backup['id']}").json()["nodes"][0]["data"]["label"] == "second"
    original = client.get(f"{base}/versions/{version['id']}").json()
    assert original["nodes"][0]["data"]["label"] == "first"
    assert original["revision"] == 1
    page = client.get(f"{base}/versions?limit=1&offset=1").json()
    assert page["total"] == listing["total"]
    assert len(page["items"]) == 1
    assert page["limit"] == 1 and page["offset"] == 1
    assert all("nodes" not in row and "data" not in row for row in listing["items"])


def test_stale_manual_restore_and_failed_put_create_no_history(client):
    pid = project(client, kind="canvas")["id"]
    base = f"/api/projects/{pid}/canvas"
    client.put(base, json=graph("first"))
    version = client.post(f"{base}/versions", json={"name": "keep", "revision": 1}).json()
    client.put(base, json=graph("second", 1))
    before = client.get(f"{base}/versions").json()["total"]
    assert client.post(f"{base}/versions", json={"name": "stale", "revision": 1}).status_code == 409
    assert client.post(f"{base}/versions/{version['id']}/restore", json={"revision": 1}).status_code == 409
    assert client.put(base, json=graph("stale", 1)).status_code == 409
    assert client.get(f"{base}/versions").json()["total"] == before
    assert client.get(base).json() == graph("second", 2)


def test_history_rejects_other_account_project_and_arbitrary_graph(client):
    pid = project(client, kind="canvas")["id"]
    base = f"/api/projects/{pid}/canvas/versions"
    version = client.post(base, json={"name": "empty", "revision": 0}).json()
    other_pid = project(client, kind="canvas")["id"]
    for prefix in [f"/api/projects/{other_pid}/canvas/versions", f"/api/projects/{uuid.uuid4()}/canvas/versions"]:
        assert client.get(f"{prefix}/{version['id']}").status_code == 404
        assert client.post(f"{prefix}/{version['id']}/restore", json={"revision": 0}).status_code == 404
    with TestClient(client.app) as other:
        assert other.get(base).status_code == 404
        assert other.get(f"{base}/{version['id']}").status_code == 404
        assert other.post(base, json={"name": "no", "revision": 0}).status_code == 404
        assert other.post(f"{base}/{version['id']}/restore", json={"revision": 0}).status_code == 404
    assert client.get(f"{base}/{uuid.uuid4()}").status_code == 404
    assert client.post(f"{base}/{uuid.uuid4()}/restore", json={"revision": 0}).status_code == 404
    assert client.post(base, json={"name": "no", "revision": 0, "nodes": []}).status_code == 422
    assert client.post(base, json={"name": "no"}).status_code == 422
    assert client.post(f"{base}/{version['id']}/restore", json={"revision": 0, "nodes": []}).status_code == 422
    assert client.get(f"{base}?limit=101").status_code == 422
    assert client.get(f"{base}?offset=-1").status_code == 422


def test_checkpoint_copies_nested_graph_and_transaction_rollback(client):
    from app.canvas_versions import CanvasVersion, checkpoint
    from app.models import Project
    from sqlalchemy import select

    pid = project(client, kind="canvas")["id"]
    data = graph("original")
    with client.app.state.session_factory() as session:
        oid = session.get(Project, pid).owner_id
        row = checkpoint(session, pid, oid, data, 7)
        data["nodes"][0]["data"]["label"] = "mutated"
        session.commit()
        vid = row.id
    with client.app.state.session_factory() as session:
        assert session.get(CanvasVersion, vid).data["nodes"][0]["data"]["label"] == "original"
        checkpoint(session, pid, oid, graph("rolled back"), 8)
        session.rollback()
    with client.app.state.session_factory() as session:
        assert len(session.scalars(select(CanvasVersion).where(CanvasVersion.project_id == pid)).all()) == 1


def test_concurrent_restore_has_one_winner_and_only_one_backup(client):
    from concurrent.futures import ThreadPoolExecutor

    pid = project(client, kind="canvas")["id"]
    base = f"/api/projects/{pid}/canvas"
    saved = client.post(f"{base}/versions", json={"name": "empty", "revision": 0}).json()
    client.put(base, json=graph("current"))
    before = client.get(f"{base}/versions").json()["total"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(f"{base}/versions/{saved['id']}/restore", json={"revision": 1}), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    versions = client.get(f"{base}/versions").json()
    assert versions["total"] == before + 2
    assert len([item for item in versions["items"] if item["kind"] == "before_restore"]) == 1
    assert client.get(base).json()["revision"] == 2


def test_history_survives_restarting_the_application(client):
    from app.main import create_app

    pid = project(client, kind="canvas")["id"]
    base = f"/api/projects/{pid}/canvas"
    client.put(base, json=graph("persisted"))
    saved = client.post(f"{base}/versions", json={"name": "persisted", "revision": 1}).json()
    restarted = create_app(database_url=client.app.state.database_url, media_root=client.app.state.media_root, session_secret=client.app.state.session_secret)
    with TestClient(restarted, cookies=client.cookies) as other:
        result = other.get(f"{base}/versions/{saved['id']}")
        assert result.status_code == 200
        assert result.json()["nodes"][0]["data"]["label"] == "persisted"
        assert result.json()["revision"] == 1
