import hashlib
import json

import pytest
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from app.mcp_local import ApiKey, register_mcp
from app.models import Base, Project, User


@pytest.fixture
def clients(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path}/mcp.sqlite", connect_args={"check_same_thread": False})
    factory = sessionmaker(engine, expire_on_commit=False)
    Base.metadata.create_all(engine)
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="isolated-test-session-key")

    def database():
        with factory() as session:
            yield session

    def owner(request: Request, session=Depends(database)):
        if not request.session.get("user_id"):
            user = User()
            session.add(user)
            session.commit()
            request.session["user_id"] = user.id
        return request.session["user_id"]

    def create_project(arguments, oid, session):
        if not isinstance(arguments.get("name"), str) or not arguments["name"].strip():
            raise HTTPException(422, "Name is required")
        project = Project(owner_id=oid, data={"name": arguments["name"]})
        session.add(project)
        session.commit()
        return {"id": project.id, "name": project.data["name"]}

    def get_project(arguments, oid, session):
        project = session.scalar(select(Project).where(Project.id == arguments["id"], Project.owner_id == oid))
        if project is None:
            raise HTTPException(404, "Resource not found")
        return {"id": project.id, "name": project.data["name"]}

    def list_projects(arguments, oid, session):
        return [{"id": row.id, "name": row.data["name"]} for row in session.scalars(select(Project).where(Project.owner_id == oid))]

    register_mcp(app, owner, database, {
        "create_project": {"description": "Create a local project", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}, "fn": create_project},
        "get_project": {"description": "Get my project", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}, "fn": get_project},
        "list_projects": {"description": "List my projects", "inputSchema": {"type": "object", "properties": {}}, "fn": list_projects},
    })
    with TestClient(app) as first, TestClient(app) as second:
        yield first, second, factory
    engine.dispose()


def new_key(client):
    response = client.post("/api/mcp/keys", json={"name": "Local integration"})
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def rpc(client, key, method, params=None, **extra):
    return client.post("/api/mcp", headers={"Authorization": f"Bearer {key['secret']}", "Accept": "application/json, text/event-stream"}, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}, **extra})


def call(client, key, name, arguments=None):
    return rpc(client, key, "tools/call", {"name": name, "arguments": arguments or {}}).json()


def content(response):
    return json.loads(response["result"]["content"][0]["text"])


def test_key_secret_only_returned_once_and_hash_persisted(clients):
    first, second, factory = clients
    key = new_key(first)
    assert key["secret"].startswith("dbmcp_")
    listing = first.get("/api/mcp/keys").json()
    assert listing["total"] == 1
    assert key["secret"] not in json.dumps(listing)
    assert "key_hash" not in listing["items"][0]
    assert "secret" not in listing["items"][0]
    assert second.get("/api/mcp/keys").json()["items"] == []
    with factory() as session:
        row = session.get(ApiKey, key["id"])
        assert row.key_hash == hashlib.sha256(key["secret"].encode()).hexdigest()
        assert key["secret"] not in str(row.__dict__)
    assert first.post("/api/mcp/keys", json={"name": "   "}).status_code == 422


def test_initialize_ping_tools_and_notifications(clients):
    first, _, _ = clients
    key = new_key(first)
    response = rpc(first, key, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["result"]["protocolVersion"] == "2025-03-26"
    assert "mcp-session-id" not in response.headers
    assert rpc(first, key, "ping").json()["result"] == {}
    tools = rpc(first, key, "tools/list").json()["result"]["tools"]
    assert {tool["name"] for tool in tools} == {"create_project", "get_project", "list_projects"}
    assert all("fn" not in tool for tool in tools)
    accepted = first.post("/api/mcp", headers={"Authorization": f"Bearer {key['secret']}"}, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert accepted.status_code == 202 and not accepted.content
    assert first.get("/api/mcp", headers={"Authorization": f"Bearer {key['secret']}"}).status_code == 405
    assert first.get("/api/mcp/keys").json()["items"][0]["last_used_at"]


def test_owner_isolation_comes_from_key_not_browser_cookie_or_arguments(clients):
    first, second, _ = clients
    first_key, second_key = new_key(first), new_key(second)
    project = content(call(first, first_key, "create_project", {"name": "Private"}))
    # A different browser session using the first token acts as the first key owner.
    assert content(call(second, first_key, "get_project", {"id": project["id"]}))["name"] == "Private"
    # A key cannot use caller-supplied owner_id to impersonate another local user.
    denied = call(first, second_key, "get_project", {"id": project["id"], "owner_id": "attacker-supplied"})
    assert denied["result"]["isError"]
    assert "404" in denied["result"]["content"][0]["text"]
    assert content(call(second, second_key, "list_projects")) == []
    assert second.delete(f"/api/mcp/keys/{first_key['id']}").status_code == 404
    assert first.delete(f"/api/mcp/keys/{first_key['id']}").status_code == 204
    assert rpc(first, first_key, "ping").status_code == 401
    assert first.get("/api/mcp/keys").json()["items"][0]["revoked"] is True
    assert rpc(second, second_key, "ping").status_code == 200


def test_auth_origin_malformed_json_rpc_and_tool_errors(clients):
    first, _, _ = clients
    key = new_key(first)
    headers = {"Authorization": f"Bearer {key['secret']}"}
    assert first.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    assert first.post("/api/mcp", headers={"Authorization": "Bearer wrong"}, json={}).status_code == 401
    assert first.post("/api/mcp", headers={**headers, "Origin": "https://untrusted.example"}, json={}).status_code == 403
    assert first.get("/api/mcp", headers={**headers, "Origin": "https://untrusted.example"}).status_code == 403
    assert first.post("/api/mcp", headers={**headers, "Content-Type": "text/plain"}, content="{}").status_code == 415
    malformed = first.post("/api/mcp", headers={**headers, "Content-Type": "application/json"}, content="{")
    assert malformed.status_code == 400 and malformed.json()["error"]["code"] == -32700
    assert rpc(first, key, 42).json()["error"]["code"] == -32600
    assert rpc(first, key, "missing").json()["error"]["code"] == -32601
    assert rpc(first, key, "initialize", {"protocolVersion": "2025-03-26"}).json()["error"]["code"] == -32602
    assert call(first, key, "unknown")["error"]["code"] == -32602
    assert call(first, key, "create_project")["result"]["isError"] is True
    assert first.post("/api/mcp", headers=headers, json=[]).status_code == 400
    batch = first.post("/api/mcp", headers=headers, json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}])
    assert batch.json() == [{"jsonrpc": "2.0", "id": 1, "result": {}}]
    # Notifications must not execute mutation tools.
    assert first.post("/api/mcp", headers=headers, json={"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "create_project", "arguments": {"name": "No mutation"}}}).status_code == 202
    assert content(call(first, key, "list_projects")) == []
