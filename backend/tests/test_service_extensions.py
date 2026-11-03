import uuid

from fastapi.testclient import TestClient

from app.main import create_app


def test_registered_mcp_tools_reuse_owned_project_routes(tmp_path):
    app = create_app(database_url=f"sqlite:///{tmp_path}/test.sqlite", media_root=tmp_path / "media", session_secret="isolated-mcp-integration")
    with TestClient(app) as client:
        key = client.post("/api/mcp/keys", json={"name": "isolated test"}).json()
        headers = {"Authorization": "Bearer " + key["secret"]}
        call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "create_project", "arguments": {"name": "MCP created", "kind": "series"}}}
        created = client.post("/api/mcp", headers=headers, json=call).json()
        assert created["result"]["isError"] is False
        projects = client.get("/api/projects").json()["items"]
        assert projects[0]["name"] == "MCP created"
        assert client.post("/api/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).json()["result"]["tools"]
        assert "secret" not in client.get("/api/mcp/keys").json()["items"][0]
        client.delete("/api/mcp/keys/" + key["id"])
        assert client.post("/api/mcp", headers=headers, json=call).status_code == 401


def test_worker_materializes_audio_and_video_bytes(tmp_path, monkeypatch):
    monkeypatch.setenv("TASK_EXECUTOR", "background")
    app = create_app(database_url=f"sqlite:///{tmp_path}/test.sqlite", media_root=tmp_path / "media", session_secret="isolated-media-integration")

    class IsolatedProvider:
        def available(self, kind):
            return kind in ("audio", "video")

        def generate(self, kind, prompt, parameters):
            # Adapter byte validation is separately tested against an HTTP fixture.
            return {f"_{kind}_bytes": b"isolated boundary bytes", "content_type": "audio/wav" if kind == "audio" else "video/mp4", "extension": "wav" if kind == "audio" else "mp4"}

    app.state.provider = IsolatedProvider()
    with TestClient(app) as client:
        for kind, mime in (("audio", "audio/wav"), ("video", "video/mp4")):
            response = client.post("/api/tasks", json={"kind": kind, "prompt": "test", "idempotency_key": uuid.uuid4().hex})
            assert response.status_code == 202
            task = client.get("/api/tasks/" + response.json()["id"]).json()
            assert task["status"] == "succeeded"
            assert "_audio_bytes" not in task["result"] and "_video_bytes" not in task["result"]
            media = client.get(task["result"]["url"])
            assert media.content == b"isolated boundary bytes"
            assert media.headers["content-type"].startswith(mime)
