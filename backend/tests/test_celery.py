import json
import os
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from test_api import client


def test_real_celery_redis_provider_boundary_and_ledger(client, tmp_path, monkeypatch):
    if not os.getenv("TEST_REDIS_URL"):
        pytest.skip("TEST_REDIS_URL is not configured")
    from app.providers import OpenAICompatibleProvider
    from app.worker import celery_app
    class Handler(BaseHTTPRequestHandler):
        fail = False

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            if self.fail:
                self.send_error(500, "Private provider error body must not escape into API")
                return
            body = json.dumps({"choices": [{"message": {"content": "Isolated HTTP test provider response, not generated AI content"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    queue = "test-" + uuid.uuid4().hex
    worker_name = queue + "@local"
    config = {"REDIS_URL": os.environ["TEST_REDIS_URL"], "TASK_EXECUTOR": "celery", "CELERY_QUEUE": queue, "DATABASE_URL": client.app.state.database_url, "MEDIA_ROOT": str(client.app.state.media_root), "TEXT_PROVIDER_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1", "TEXT_PROVIDER_API_KEY": "isolated-test-not-a-secret", "TEXT_PROVIDER_MODEL": "isolated-test"}
    for key, value in config.items():
        monkeypatch.setenv(key, value)
    client.app.state.provider = OpenAICompatibleProvider()
    celery_app.conf.broker_url = os.environ["TEST_REDIS_URL"]
    celery_app.conf.task_default_queue = queue
    logfile = (tmp_path / "worker.log").open("w+")
    process = subprocess.Popen([".venv/bin/celery", "-A", "app.worker.celery_app", "worker", "--pool=solo", "--concurrency=1", "--loglevel=warning", "--hostname=" + worker_name, "--queues=" + queue], env={**os.environ, **config}, stdout=logfile, stderr=subprocess.STDOUT)
    try:
        before = client.get("/api/credits").json()["balance"]
        payload = {"kind": "text", "prompt": "isolated HTTP test", "idempotency_key": uuid.uuid4().hex}
        submitted = client.post("/api/tasks", json=payload)
        assert submitted.status_code == 202, submitted.text
        task = submitted.json()
        deadline = time.monotonic() + 25
        state = {}
        while time.monotonic() < deadline:
            state = client.get(f"/api/tasks/{task['id']}").json()
            if state["status"] in ("failed", "succeeded"):
                break
            time.sleep(.2)
        assert state["status"] == "succeeded", state
        assert state["result"]["text"].startswith("Isolated HTTP test provider")
        assert client.post("/api/tasks", json=payload).json()["id"] == task["id"]
        from app.worker import run_task
        run_task.apply_async(args=[task["id"]], queue=queue)
        time.sleep(.3)
        ledger = client.get("/api/credits").json()
        assert ledger["balance"] == before - 1
        assert len([row for row in ledger["items"] if row["task_id"] == task["id"] and row["action"] == "settle"]) == 1
        Handler.fail = True
        failed = client.post("/api/tasks", json={**payload, "idempotency_key": uuid.uuid4().hex}).json()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = client.get(f"/api/tasks/{failed['id']}").json()
            if state["status"] == "failed":
                break
            time.sleep(.2)
        assert state["status"] == "failed"
        assert "Private" not in state["error"]
        assert client.get("/api/credits").json()["balance"] == before - 1
    finally:
        process.terminate()
        process.wait(timeout=10)
        server.shutdown()
        logfile.close()
