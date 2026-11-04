"""Optional import idempotency is durable, owner-scoped and race-safe."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import threading
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import event, func, select

from app.models import Asset
from test_api import client


def payload(**changes):
    return {"name": "预设角色", "kind": "character", "description": "原始设定",
            "metadata": {"gallery": [{"id": "front", "name": "正面", "url": "/media/local/front.png"}]}, **changes}


def create(client, body=None, key="same-import"):
    return client.post("/api/assets", json=body or payload(), headers={"Idempotency-Key": key})


@contextmanager
def same_initial_key_lookup(client):
    """Make both real transactions read the absent key before either can insert."""
    engine = client.app.state.session_factory.kw["bind"]
    barrier, lock, lookups = threading.Barrier(2), threading.Lock(), 0
    def rendezvous(connection, cursor, statement, parameters, context, executemany):
        nonlocal lookups
        if statement.lstrip().upper().startswith("SELECT") and "FROM asset_creation_requests" in statement:
            with lock:
                lookups += 1
                current = lookups
            if current <= 2:
                barrier.wait(timeout=5)
    event.listen(engine, "after_cursor_execute", rendezvous)
    try:
        yield
    finally:
        event.remove(engine, "after_cursor_execute", rendezvous)
    assert lookups >= 3, "The unique-key conflict must replay after rolling back the losing transaction"


def test_asset_create_replays_exact_request_without_second_asset(client):
    first = create(client)
    assert first.status_code == 201, first.text
    replay = create(client)
    assert replay.status_code == 201, replay.text
    assert replay.json()["id"] == first.json()["id"]
    assert client.get("/api/assets").json()["total"] == 1


def test_asset_create_hash_ignores_json_property_order_but_rejects_changed_payload(client):
    body = payload()
    first = create(client, body)
    reordered = dict(reversed(list(body.items())))
    reordered["metadata"] = {"gallery": [dict(reversed(list(body["metadata"]["gallery"][0].items())))]}
    assert create(client, reordered).json()["id"] == first.json()["id"]
    changed = create(client, payload(name="另一角色"))
    assert changed.status_code == 409
    assert client.get("/api/assets").json()["total"] == 1


def test_deleted_asset_is_not_recreated_by_old_import_key(client):
    first = create(client).json()
    assert client.delete(f"/api/assets/{first['id']}").status_code == 204
    replay = create(client)
    assert replay.status_code == 410, replay.text
    assert client.get("/api/assets").json()["total"] == 0
    fresh = create(client, key="new-import")
    assert fresh.status_code == 201 and fresh.json()["id"] != first["id"]


def test_asset_import_keys_do_not_cross_accounts(client):
    first = create(client).json()
    with TestClient(client.app) as other:
        second = create(other)
        assert second.status_code == 201, second.text
        assert second.json()["id"] != first["id"]
        assert other.get("/api/assets").json()["total"] == 1
        assert create(other).json()["id"] == second.json()["id"]
    assert client.get("/api/assets").json()["total"] == 1


def test_without_key_asset_create_remains_non_idempotent(client):
    first = client.post("/api/assets", json=payload()).json()
    second = client.post("/api/assets", json=payload()).json()
    assert first["id"] != second["id"]
    assert client.get("/api/assets").json()["total"] == 2


def test_asset_idempotency_survives_restarting_api_and_returns_current_asset(client):
    from app.main import create_app
    first = create(client).json()
    assert client.patch(f"/api/assets/{first['id']}", json={"name": "已编辑"}).status_code == 200
    restarted = create_app(database_url=client.app.state.database_url,
                           media_root=client.app.state.media_root, session_secret=client.app.state.session_secret)
    with TestClient(restarted) as new_client:
        new_client.cookies.update(client.cookies)
        replay = create(new_client)
        assert replay.status_code == 201, replay.text
        assert (replay.json()["id"], replay.json()["name"]) == (first["id"], "已编辑")
        assert new_client.get("/api/assets").json()["total"] == 1


def test_two_concurrent_same_imports_create_only_one_asset(client):
    # Bootstrap one owner before concurrent requests so cookie creation is not
    # confused with idempotency. Both requests deliberately share the same key.
    client.get("/api/session")
    barrier = threading.Barrier(2)
    key = uuid.uuid4().hex
    def submit(_):
        barrier.wait(timeout=5)
        return create(client, key=key)
    with same_initial_key_lookup(client):
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(submit, range(2)))
    assert [response.status_code for response in responses] == [201, 201]
    assert responses[0].json()["id"] == responses[1].json()["id"]
    with client.app.state.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Asset)) == 1


def test_concurrent_key_reuse_with_different_payload_rolls_back_losing_asset(client):
    client.get("/api/session")
    barrier = threading.Barrier(2)
    def submit(name):
        barrier.wait(timeout=5)
        return create(client, payload(name=name))
    with same_initial_key_lookup(client):
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(submit, ["角色甲", "角色乙"]))
    assert sorted(response.status_code for response in responses) == [201, 409]
    assert client.get("/api/assets").json()["total"] == 1


def test_idempotency_header_has_explicit_length_bounds(client):
    assert create(client, key="").status_code == 422
    assert create(client, key="x" * 129).status_code == 422
    assert client.get("/api/assets").json()["total"] == 0
