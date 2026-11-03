import uuid

from sqlalchemy import select, update

from app.main import execute_task, fail_task
from app.models import Ledger, Task, User
from test_api import Provider, client, project


def test_duplicate_delivery_and_late_failure_cannot_charge_twice(client, monkeypatch):
    # Hold the accepted task in queued state, then exercise the actual worker twice.
    import app.main as module
    actual_execute = module.execute_task
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    client.app.state.provider = Provider()
    before = client.get("/api/credits").json()["balance"]
    task = client.post("/api/tasks", json={"kind": "text", "prompt": "story", "idempotency_key": uuid.uuid4().hex}).json()
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "queued"
    assert client.delete(f"/api/tasks/{task['id']}").status_code == 409
    actual_execute(client.app, task["id"])
    actual_execute(client.app, task["id"])
    fail_task(client.app, task["id"])
    balance = client.get("/api/credits").json()
    assert balance["balance"] == before - 1
    assert [row["action"] for row in balance["items"] if row["task_id"] == task["id"]].count("settle") == 1


def test_failed_task_refund_is_idempotent(client, monkeypatch):
    import app.main as module
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    client.app.state.provider = Provider()
    before = client.get("/api/credits").json()["balance"]
    task = client.post("/api/tasks", json={"kind": "text", "prompt": "story", "idempotency_key": uuid.uuid4().hex}).json()
    fail_task(client.app, task["id"])
    fail_task(client.app, task["id"])
    assert client.get("/api/credits").json()["balance"] == before
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "failed"


def test_worker_redelivery_refunds_interrupted_job_without_repeating_provider(client, monkeypatch):
    import app.main as module
    actual = module.execute_task
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    client.app.state.provider = Provider()
    before = client.get("/api/credits").json()["balance"]
    task = client.post("/api/tasks", json={"kind": "text", "prompt": "story", "idempotency_key": uuid.uuid4().hex}).json()
    with client.app.state.session_factory() as session:
        session.execute(update(Task).where(Task.id == task["id"]).values(status="running"))
        session.commit()
    actual(client.app, task["id"], recover_interrupted=True)
    actual(client.app, task["id"], recover_interrupted=True)
    state = client.get(f"/api/tasks/{task['id']}").json()
    assert state["status"] == "failed"
    assert "interrupted" in state["error"].lower()
    assert state["result"] == {}
    assert client.get("/api/credits").json()["balance"] == before


def test_background_restart_recovers_reserved_jobs_without_provider_retry(client, monkeypatch):
    import app.main as module
    from fastapi.testclient import TestClient
    monkeypatch.setattr(module, "execute_task", lambda *_: None)
    client.app.state.provider = Provider()
    before = client.get("/api/credits").json()["balance"]
    task = client.post("/api/tasks", json={"kind": "text", "prompt": "story", "idempotency_key": uuid.uuid4().hex}).json()
    restarted_app = module.create_app(database_url=client.app.state.database_url, media_root=client.app.state.media_root, session_secret=client.app.state.session_secret)
    with TestClient(restarted_app, cookies=client.cookies) as restarted:
        assert restarted.get(f"/api/tasks/{task['id']}").json()["status"] == "failed"
        assert restarted.get("/api/credits").json()["balance"] == before


def test_deleted_task_keeps_idempotency_history(client):
    client.app.state.provider = Provider()
    payload = {"kind": "text", "prompt": "story", "idempotency_key": uuid.uuid4().hex}
    task = client.post("/api/tasks", json=payload).json()
    before = client.get("/api/credits").json()["balance"]
    assert client.delete(f"/api/tasks/{task['id']}").status_code == 204
    assert client.get(f"/api/tasks/{task['id']}").status_code == 404
    assert client.post("/api/tasks", json=payload).status_code == 410
    assert client.get("/api/credits").json()["balance"] == before


def test_untrusted_origin_cannot_mutate_local_account(client):
    response = client.post("/api/projects", json={"name": "blocked", "kind": "series"}, headers={"Origin": "https://unrelated.example"})
    assert response.status_code == 403
    assert client.get("/api/projects").json()["items"] == []


def test_upload_limit_and_empty_file(client, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "4")
    assert client.post("/api/uploads", files={"file": ("large.txt", b"12345", "text/plain")}).status_code == 413
    assert client.post("/api/uploads", files={"file": ("empty.txt", b"", "text/plain")}).status_code == 422


def test_optional_s3_roundtrip_and_owner_check(client, monkeypatch):
    """Runs against a real isolated S3/MinIO bucket only when explicitly enabled."""
    import os
    import pytest
    from app.storage import MediaStorage
    if not os.getenv("TEST_S3_ENDPOINT_URL"):
        pytest.skip("TEST_S3_ENDPOINT_URL is not configured")
    monkeypatch.setenv("S3_ENDPOINT_URL", os.environ["TEST_S3_ENDPOINT_URL"])
    monkeypatch.setenv("S3_ACCESS_KEY", os.environ["TEST_S3_ACCESS_KEY"])
    monkeypatch.setenv("S3_SECRET_KEY", os.environ["TEST_S3_SECRET_KEY"])
    monkeypatch.setenv("S3_BUCKET", "dramabuddy-test-" + uuid.uuid4().hex)
    storage = MediaStorage(client.app.state.media_root)
    storage.prepare()
    client.app.state.storage = storage
    uploaded = client.post("/api/uploads", files={"file": ("proof.txt", b"real S3 bytes", "text/plain")}).json()
    assert client.get(uploaded["url"]).content == b"real S3 bytes"
    assert not (client.app.state.media_root / uploaded["url"].removeprefix("/media/")).exists()
    with client.app.state.session_factory() as session:
        from app.models import Upload
        paths = session.scalars(select(Upload.path)).all()
    for path in paths:
        storage.client.delete_object(Bucket=storage.bucket, Key=path)
    storage.client.delete_bucket(Bucket=storage.bucket)
