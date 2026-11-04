"""Object-store failures must not leak details or persist ghost upload records."""
import boto3
from botocore.config import Config
from botocore.exceptions import EndpointConnectionError
from botocore.stub import ANY, Stubber
import pytest
from sqlalchemy import func, select

from app.models import Upload
from test_api import client


@pytest.mark.parametrize("code,status,capacity", [
    ("XMinioStorageFull", 507, True),
    ("InsufficientStorage", 507, True),
    ("AccessDenied", 403, False),
    ("InternalError", 500, False),
])
def test_failed_object_store_upload_returns_sanitized_503_without_upload_record(client, code, status, capacity):
    storage = client.app.state.storage
    # The real SDK client and storage path run; Stubber returns only an isolated
    # backend error instead of reaching a cloud service or requiring credentials.
    storage.client = boto3.client("s3", endpoint_url="http://127.0.0.1:9", aws_access_key_id="isolated-test", aws_secret_access_key="isolated-test-secret", region_name="us-east-1", config=Config(retries={"max_attempts": 0}))
    with Stubber(storage.client) as responses:
        responses.add_client_error("put_object", service_error_code=code, service_message="PRIVATE_BACKEND_ERROR credential=FAKE_SECRET bucket=INTERNAL_BUCKET", http_status_code=status, expected_params={"Bucket": storage.bucket, "Key": ANY, "Body": b"fixture bytes", "ContentType": "image/png"})
        response = client.post("/api/uploads", files={"file": ("frame.png", b"fixture bytes", "image/png")})
        assert response.status_code == 503, response.text
        detail = response.json()["detail"]
        assert "capacity" in detail.lower() if capacity else "unavailable" in detail.lower()
        assert all(secret not in response.text for secret in ("PRIVATE_BACKEND_ERROR", "FAKE_SECRET", "INTERNAL_BUCKET", "127.0.0.1", code))
        responses.assert_no_pending_responses()
    with client.app.state.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Upload)) == 0
    assert list(storage.root.rglob("frame.png")) == []


def test_unreachable_object_store_upload_returns_sanitized_503_without_upload_record(client, monkeypatch):
    storage = client.app.state.storage
    storage.client = boto3.client("s3", endpoint_url="http://127.0.0.1:9", aws_access_key_id="isolated-test", aws_secret_access_key="isolated-test-secret", region_name="us-east-1")
    def unreachable(**_):
        raise EndpointConnectionError(endpoint_url="https://PRIVATE_STORAGE_HOST/?token=FAKE_SECRET")
    monkeypatch.setattr(storage.client, "put_object", unreachable)
    response = client.post("/api/uploads", files={"file": ("frame.png", b"fixture bytes", "image/png")})
    assert response.status_code == 503, response.text
    assert "unavailable" in response.json()["detail"].lower()
    assert "PRIVATE_STORAGE_HOST" not in response.text and "FAKE_SECRET" not in response.text
    with client.app.state.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Upload)) == 0
