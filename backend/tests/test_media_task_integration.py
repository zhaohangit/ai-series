"""API integration for actual owned-media tasks and their persistence boundaries."""
import uuid

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select

from app.models import Upload
from test_api import client, project
from test_media_tools import decoded, ffmpeg, image_source, render, upload, video_source


def payload(kind, source_url, operation, **parameters):
    return {"kind": kind, "parameters": {"operation": operation, "source_url": source_url, **parameters}, "idempotency_key": uuid.uuid4().hex}


def finished(client, body):
    accepted = client.post("/api/tasks", json=body)
    assert accepted.status_code == 202, accepted.text
    task = client.get(f"/api/tasks/{accepted.json()['id']}")
    assert task.status_code == 200, task.text
    assert task.json()["status"] == "succeeded", task.text
    return task.json()


def assert_no_charge(client, before):
    current = client.get("/api/credits").json()
    assert current["balance"] == before["balance"]
    assert current["items"] == before["items"]


def test_inspect_route_reports_owned_actual_dimensions_without_creating_task(client, ffmpeg, tmp_path):
    _, source = image_source(client, ffmpeg, tmp_path)
    before = client.get("/api/credits").json()
    response = client.get("/api/media/inspect", params={"source_url": source})
    assert response.status_code == 200, response.text
    info = response.json()
    assert (info["source_url"], info["kind"], info["width"], info["height"], info["duration"]) == (source, "image", 64, 48, None)
    assert client.get("/api/tasks").json()["total"] == 0
    assert_no_charge(client, before)


def test_crop_task_stores_transformed_pixels_once_for_duplicate_request_and_delivery(client, ffmpeg, tmp_path):
    from app.main import execute_task
    _, source = image_source(client, ffmpeg, tmp_path)
    before = client.get("/api/credits").json()
    body = payload("image", source, "crop_image", x=32, y=0, width=32, height=48)
    task = finished(client, body)
    result = task["result"]
    assert result["operation"] == "crop_image" and result["source_url"] == source
    assert result["url"] != source and result["content_type"] == "image/png"
    assert not any(key.startswith("_") and key.endswith("_bytes") for key in result)
    output = tmp_path / "task-crop.png"
    download = client.get(result["url"])
    assert download.status_code == 200
    output.write_bytes(download.content)
    pixels = decoded(ffmpeg, output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24")
    assert len(pixels) == 32 * 48 * 3 and pixels[2] > 240 and pixels[0] < 10
    replay = client.post("/api/tasks", json=body)
    assert replay.status_code == 202 and replay.json()["id"] == task["id"]
    execute_task(client.app, task["id"])
    assert client.get("/api/tasks").json()["total"] == 1
    with client.app.state.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Upload)) == 2
    assert client.get(f"/api/tasks/{task['id']}").json()["result"]["url"] == result["url"]
    changed = {**body, "parameters": {**body["parameters"], "width": 16}}
    assert client.post("/api/tasks", json=changed).status_code == 409
    assert_no_charge(client, before)


@pytest.mark.parametrize("kind,operation,parameters,signature,dimensions,duration", [
    ("video", "crop_video", {"x": 0, "y": 0, "width": 32, "height": 24}, b"ftyp", (32, 24), 2),
    ("video", "trim_video", {"start": .5, "end": 1.5}, b"ftyp", (64, 48), 1),
    ("image", "extract_frame", {"at": .5}, b"\x89PNG", (64, 48), None),
    ("audio", "trim_audio", {"start": .25, "end": 1}, b"RIFF", (None, None), .75),
])
def test_media_operations_complete_without_provider_and_without_credit_debit(client, ffmpeg, tmp_path, kind, operation, parameters, signature, dimensions, duration):
    if kind == "audio":
        contents = render(ffmpeg, tmp_path / "voice.wav", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2")
        _, source = upload(client, contents, "voice.wav", "audio/wav")
    else:
        _, source = video_source(client, ffmpeg, tmp_path)
    before = client.get("/api/credits").json()
    task = finished(client, payload(kind, source, operation, **parameters))
    result = task["result"]
    download = client.get(result["url"])
    assert download.status_code == 200 and signature in download.content[:40]
    inspection = client.get("/api/media/inspect", params={"source_url": result["url"]})
    assert inspection.status_code == 200, inspection.text
    info = inspection.json()
    assert info["kind"] == kind and (info["width"], info["height"]) == dimensions
    if duration is None:
        assert info["duration"] is None
    else:
        assert info["duration"] == pytest.approx(duration, abs=.1)
    assert_no_charge(client, before)


def test_media_task_applies_result_to_owned_unchanged_shot(client, ffmpeg, tmp_path):
    _, source = image_source(client, ffmpeg, tmp_path)
    pid = project(client)["id"]
    shot = client.post(f"/api/projects/{pid}/shots", json={"name": "crop target", "image_url": source}).json()
    before = client.get("/api/credits").json()
    body = {**payload("image", source, "crop_image", x=32, y=0, width=32, height=48, shot_id=shot["id"], shot_updated_at=shot["updated_at"]), "project_id": pid}
    task = finished(client, body)
    assert task["result"]["application"]["status"] == "applied"
    saved = client.get(f"/api/projects/{pid}/shots").json()["items"][0]
    assert saved["image_url"] == task["result"]["url"] and saved["image_url"] != source
    assert client.get(saved["image_url"]).content.startswith(b"\x89PNG")
    assert_no_charge(client, before)


def test_media_task_keeps_candidate_when_shot_changes_after_submission(client, ffmpeg, tmp_path, monkeypatch):
    import app.main as module
    actual_execute = module.execute_task
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    _, source = image_source(client, ffmpeg, tmp_path)
    pid = project(client)["id"]
    shot = client.post(f"/api/projects/{pid}/shots", json={"name": "crop target", "image_url": source}).json()
    before = client.get("/api/credits").json()
    body = {**payload("image", source, "crop_image", x=32, y=0, width=32, height=48, shot_id=shot["id"], shot_updated_at=shot["updated_at"]), "project_id": pid}
    accepted = client.post("/api/tasks", json=body)
    assert accepted.status_code == 202, accepted.text
    task_id = accepted.json()["id"]
    assert client.get(f"/api/tasks/{task_id}").json()["status"] == "queued"
    assert client.patch(f"/api/shots/{shot['id']}", json={"prompt": "newer edit"}).status_code == 200
    actual_execute(client.app, task_id)
    task = client.get(f"/api/tasks/{task_id}").json()
    assert task["status"] == "succeeded", task
    assert task["result"]["application"]["status"] == "conflict"
    assert client.get(task["result"]["url"]).content.startswith(b"\x89PNG")
    saved = client.get(f"/api/projects/{pid}/shots").json()["items"][0]
    assert saved["prompt"] == "newer edit" and saved["image_url"] == source
    assert_no_charge(client, before)


@pytest.mark.parametrize("source", [None, "/media/not-owned.png", "https://example.org/image.png", "file:///tmp/private.png"])
def test_missing_and_invalid_sources_create_no_task_or_debit(client, source):
    before = client.get("/api/credits").json()
    response = client.post("/api/tasks", json=payload("image", source, "crop_image", x=0, y=0, width=1, height=1))
    assert response.status_code == 422, response.text
    if source is not None:
        assert client.get("/api/media/inspect", params={"source_url": source}).status_code == 422
    else:
        assert client.get("/api/media/inspect").status_code == 422
    assert client.get("/api/tasks").json()["total"] == 0
    assert_no_charge(client, before)


def test_foreign_source_is_denied_for_inspection_and_task_without_debit(client, ffmpeg, tmp_path):
    _, source = image_source(client, ffmpeg, tmp_path)
    with TestClient(client.app) as other:
        before = other.get("/api/credits").json()
        assert other.get("/api/media/inspect", params={"source_url": source}).status_code == 422
        response = other.post("/api/tasks", json=payload("image", source, "crop_image", x=0, y=0, width=1, height=1))
        assert response.status_code == 422, response.text
        assert other.get("/api/tasks").json()["total"] == 0
        assert other.get(source).status_code == 404
        assert_no_charge(other, before)


@pytest.mark.parametrize("changes", [{"operation": "unknown"}, {"operation": []}, {"width": 65}, {"height": 0}, {"x": "movie=http://example.org"}])
def test_invalid_operations_do_not_create_tasks_or_debit(client, ffmpeg, tmp_path, changes):
    _, source = image_source(client, ffmpeg, tmp_path)
    before = client.get("/api/credits").json()
    body = payload("image", source, "crop_image", x=0, y=0, width=32, height=48)
    body["parameters"].update(changes)
    response = client.post("/api/tasks", json=body)
    assert response.status_code == 422, response.text
    assert client.get("/api/tasks").json()["total"] == 0
    assert_no_charge(client, before)


def test_declared_task_kind_cannot_override_operation_output_kind(client, ffmpeg, tmp_path):
    _, source = image_source(client, ffmpeg, tmp_path)
    before = client.get("/api/credits").json()
    response = client.post("/api/tasks", json=payload("video", source, "crop_image", x=0, y=0, width=32, height=48))
    assert response.status_code == 422, response.text
    assert client.get("/api/tasks").json()["total"] == 0
    assert_no_charge(client, before)


def test_missing_processor_returns_503_without_task_or_debit(client, ffmpeg, tmp_path, monkeypatch):
    _, source = image_source(client, ffmpeg, tmp_path)
    monkeypatch.setenv("FFMPEG_BIN", "/unavailable/ffmpeg")
    before = client.get("/api/credits").json()
    assert client.get("/api/media/inspect", params={"source_url": source}).status_code == 503
    response = client.post("/api/tasks", json=payload("image", source, "crop_image", x=0, y=0, width=32, height=48))
    assert response.status_code == 503, response.text
    assert client.get("/api/tasks").json()["total"] == 0
    assert_no_charge(client, before)


def test_playlist_upload_cannot_be_processed_as_video(client, ffmpeg):
    _, source = upload(client, b"#EXTM3U\nhttp://127.0.0.1:9999/private.mp4\n", "playlist.mp4", "video/mp4")
    before = client.get("/api/credits").json()
    response = client.post("/api/tasks", json=payload("video", source, "trim_video", start=0, end=1))
    assert response.status_code == 422, response.text
    assert client.get("/api/tasks").json()["total"] == 0
    assert_no_charge(client, before)
