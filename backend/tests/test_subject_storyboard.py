import uuid

from fastapi.testclient import TestClient

from test_api import client, project


def subject(client, pid, **changes):
    response = client.post(f"/api/projects/{pid}/subjects", json={"name": "小橙", "kind": "character", "metadata": {"role": "主角", "gallery": [{"id": "front", "name": "正面", "url": ""}]}, **changes})
    assert response.status_code == 201, response.text
    return response.json()


def test_subject_details_persist_with_optimistic_conflict(client):
    pid = project(client)["id"]
    asset = subject(client, pid)
    response = client.patch(f"/api/assets/{asset['id']}", json={"expected_updated_at": asset["updated_at"], "metadata": {**asset["metadata"], "age": "青年", "voice": {"description": "温暖", "text": "早上好", "url": "/media/fixture.wav"}}})
    assert response.status_code == 200
    assert client.get(f"/api/projects/{pid}/subjects").json()["items"][0]["metadata"]["voice"]["text"] == "早上好"
    assert client.patch(f"/api/assets/{asset['id']}", json={"expected_updated_at": asset["updated_at"], "name": "stale"}).status_code == 409
    assert client.get(f"/api/assets/{asset['id']}").json()["name"] == "小橙"


def test_subject_import_is_atomic_and_detach_retains_library_asset(client):
    pid = project(client)["id"]
    asset = client.post("/api/assets", json={"name": "library", "kind": "scene"}).json()
    assert client.post(f"/api/projects/{pid}/subjects/import", json={"asset_ids": [asset["id"], "not-owned"]}).status_code == 404
    assert client.get(f"/api/projects/{pid}/subjects").json()["total"] == 0
    for _ in range(2):
        assert client.post(f"/api/projects/{pid}/subjects/import", json={"asset_ids": [asset["id"]]}).status_code == 200
    assert client.get(f"/api/projects/{pid}/subjects").json()["total"] == 1
    assert client.delete(f"/api/projects/{pid}/subjects/{asset['id']}").status_code == 204
    assert client.get(f"/api/assets/{asset['id']}").status_code == 200
    with TestClient(client.app) as other:
        assert other.get(f"/api/projects/{pid}/subjects").status_code == 404
        assert other.get(f"/api/assets/{asset['id']}").status_code == 404


class MediaProvider:
    def available(self, kind):
        return kind in ("image", "audio")

    def generate(self, kind, prompt, parameters):
        return {"url": f"https://provider.example/result.{ 'png' if kind == 'image' else 'wav'}"}


def generate(client, pid, asset, kind="image", **parameters):
    return client.post("/api/tasks", json={"kind": kind, "prompt": "isolated test", "project_id": pid, "idempotency_key": uuid.uuid4().hex, "parameters": {"asset_id": asset["id"], "asset_updated_at": asset["updated_at"], **parameters}})


def test_subject_generated_gallery_and_voice_apply_to_owned_unchanged_target(client):
    client.app.state.provider = MediaProvider()
    pid = project(client)["id"]
    asset = subject(client, pid)
    task = generate(client, pid, asset, gallery_slot="front")
    assert task.status_code == 202
    result = client.get("/api/tasks/" + task.json()["id"]).json()
    assert result["result"]["application"]["status"] == "applied"
    saved = client.get(f"/api/assets/{asset['id']}").json()
    assert saved["url"] == ""
    assert saved["metadata"]["gallery"][0]["url"].endswith("result.png")
    assert len(saved["metadata"]["versions"]) == 1
    assert generate(client, pid, saved, "audio", gallery_slot="unpersisted-image-slot").status_code == 202
    saved = client.get(f"/api/assets/{asset['id']}").json()
    assert saved["metadata"]["voice"]["url"].endswith("result.wav")
    assert len(saved["metadata"]["versions"]) == 2
    assert generate(client, project(client)["id"], saved).status_code == 422
    assert generate(client, pid, saved, gallery_slot="missing").status_code == 422


def test_subject_generation_preserves_concurrent_edits_and_balance(client, monkeypatch):
    import app.main as module
    actual = module.execute_task
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    client.app.state.provider = MediaProvider()
    pid = project(client)["id"]
    asset = subject(client, pid)
    task = generate(client, pid, asset).json()
    client.patch(f"/api/assets/{asset['id']}", json={"description": "new user edit"})
    actual(client.app, task["id"])
    result = client.get("/api/tasks/" + task["id"]).json()["result"]
    assert result["application"]["status"] == "conflict"
    assert client.get(f"/api/assets/{asset['id']}").json()["description"] == "new user edit"


def test_shot_batch_and_reorder_are_atomic_and_owned(client):
    pid = project(client)["id"]
    response = client.post(f"/api/projects/{pid}/shots/batch", json={"shots": [{"name": f"镜头{i}", "position": i, "settings": {"storyboard_group": "g", "grid_size": 4, "cell_index": i}} for i in range(4)]})
    assert response.status_code == 201, response.text
    ids = [shot["id"] for shot in response.json()["items"]]
    assert len(ids) == 4
    assert client.put(f"/api/projects/{pid}/shots/order", json={"ids": [ids[0]] * 4}).status_code == 422
    assert client.put(f"/api/projects/{pid}/shots/order", json={"ids": ids[:2]}).status_code == 409
    ordered = client.put(f"/api/projects/{pid}/shots/order", json={"ids": ids[::-1]})
    assert ordered.status_code == 200
    assert [s["id"] for s in client.get(f"/api/projects/{pid}/shots").json()["items"]] == ids[::-1]
    other_pid = project(client)["id"]
    episode = client.post(f"/api/projects/{other_pid}/episodes", json={"name": "other"}).json()
    invalid = client.post(f"/api/projects/{pid}/shots/batch", json={"shots": [{"name": "valid"}, {"name": "bad", "episode_id": episode["id"]}]})
    assert invalid.status_code == 422
    assert client.get(f"/api/projects/{pid}/shots").json()["total"] == 4
    with TestClient(client.app) as other:
        assert other.put(f"/api/projects/{pid}/shots/order", json={"ids": ids}).status_code == 404


def test_stale_shot_patch_does_not_reset_other_editor(client):
    pid = project(client)["id"]
    shot = client.post(f"/api/projects/{pid}/shots", json={"name": "one"}).json()
    assert client.patch(f"/api/shots/{shot['id']}", json={"prompt": "new", "expected_updated_at": shot["updated_at"]}).status_code == 200
    assert client.patch(f"/api/shots/{shot['id']}", json={"prompt": "stale", "expected_updated_at": shot["updated_at"]}).status_code == 409


def test_actual_material_catalogue_is_not_drawing_style_data(client):
    collections = client.get("/api/material-presets").json()["collections"]
    assert len(collections) == 14
    assert sum(len(row["items"]) for row in collections) == 146
    assert collections[0]["id"] == "101"
    assert collections[0]["items"][0]["name"] == "小邪童"
