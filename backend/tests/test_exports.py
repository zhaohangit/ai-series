import io
import json
import os
import shutil
import subprocess
import uuid
import zipfile

import pytest

from test_api import client, project


def test_zip_export_contains_saved_project_and_owned_media(client):
    uploaded = client.post("/api/uploads", files={"file": ("reference.png", b"original media bytes", "image/png")}).json()
    pid = project(client)["id"]
    client.post(f"/api/projects/{pid}/shots", json={"name": "shot", "image_url": uploaded["url"]})
    task = client.post("/api/tasks", json={"kind": "export", "project_id": pid, "parameters": {"format": "zip"}, "idempotency_key": uuid.uuid4().hex})
    assert task.status_code == 202, task.text
    finished = client.get(f"/api/tasks/{task.json()['id']}").json()
    assert finished["status"] == "succeeded"
    download = client.get(finished["result"]["url"])
    with zipfile.ZipFile(io.BytesIO(download.content)) as bundle:
        assert json.loads(bundle.read("project.json"))["project"]["id"] == pid
        media = [name for name in bundle.namelist() if name.startswith("media/")]
        assert len(media) == 1
        assert bundle.read(media[0]) == b"original media bytes"


def test_mp4_export_unavailable_without_ffmpeg_or_source_media(client, monkeypatch):
    monkeypatch.setenv("FFMPEG_BIN", "/definitely-unavailable/ffmpeg")
    pid = project(client)["id"]
    response = client.post("/api/tasks", json={"kind": "export", "project_id": pid, "parameters": {"format": "mp4"}, "idempotency_key": uuid.uuid4().hex})
    assert response.status_code == 503
    assert client.get("/api/tasks").json()["total"] == 0


def test_mp4_export_renders_actual_uploaded_shot(client, tmp_path):
    ffmpeg = os.getenv("FFMPEG_BIN", "ffmpeg")
    if not shutil.which(ffmpeg):
        pytest.skip("FFmpeg is not installed")
    image = tmp_path / "shot.png"
    subprocess.run([ffmpeg, "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", str(image)], check=True, capture_output=True)
    uploaded = client.post("/api/uploads", files={"file": ("shot.png", image.read_bytes(), "image/png")}).json()
    pid = project(client)["id"]
    client.post(f"/api/projects/{pid}/shots", json={"name": "shot", "image_url": uploaded["url"], "duration": 1})
    task = client.post("/api/tasks", json={"kind": "export", "project_id": pid, "parameters": {"format": "mp4"}, "idempotency_key": uuid.uuid4().hex}).json()
    finished = client.get(f"/api/tasks/{task['id']}").json()
    assert finished["status"] == "succeeded", finished
    data = client.get(finished["result"]["url"]).content
    assert b"ftyp" in data[:40]
    assert len(data) > 500


def test_mp4_concat_keeps_uploaded_audio_and_video(client, tmp_path):
    ffmpeg = os.getenv("FFMPEG_BIN", "ffmpeg")
    if not shutil.which(ffmpeg):
        pytest.skip("FFmpeg is not installed")
    image, audio, video = tmp_path / "image.png", tmp_path / "voice.wav", tmp_path / "clip.mp4"
    commands = [
        ["-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", str(image)],
        ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", str(audio)],
        ["-f", "lavfi", "-i", "color=c=red:s=320x180:d=1", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video)],
    ]
    for command in commands:
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *command], check=True, capture_output=True)
    media = [client.post("/api/uploads", files={"file": (path.name, path.read_bytes(), kind)}).json()["url"] for path, kind in [(image, "image/png"), (audio, "audio/wav"), (video, "video/mp4")]]
    pid = project(client)["id"]
    client.post(f"/api/projects/{pid}/shots", json={"name": "image with uploaded voice", "image_url": media[0], "audio_url": media[1], "duration": 1})
    client.post(f"/api/projects/{pid}/shots", json={"name": "video with original audio", "video_url": media[2], "position": 1, "duration": 1})
    task = client.post("/api/tasks", json={"kind": "export", "project_id": pid, "parameters": {"format": "mp4"}, "idempotency_key": uuid.uuid4().hex}).json()
    finished = client.get(f"/api/tasks/{task['id']}").json()
    assert finished["status"] == "succeeded", finished
    output = tmp_path / "result.mp4"
    output.write_bytes(client.get(finished["result"]["url"]).content)
    decoded = subprocess.run([ffmpeg, "-v", "error", "-i", str(output), "-f", "s16le", "-ac", "1", "-ar", "48000", "pipe:1"], check=True, capture_output=True).stdout
    assert len(decoded) >= 190000  # Two seconds, 48 kHz, 16 bit mono.
    assert any(decoded[10000:20000])
    assert any(decoded[110000:120000])
