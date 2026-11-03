"""Small local MCP transport; tool authorization stays in the application's handlers."""

import hashlib
import inspect
import json
import os
import secrets
from collections.abc import Mapping

from fastapi import Depends, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import Boolean, ForeignKey, String, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, User, now, uid

MCP_VERSION = "2025-03-26"


class ApiKey(Base):
    __tablename__ = "mcp_api_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    prefix: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    last_used_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    revoked_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class KeyInput(BaseModel):
    name: str = Field(default="本地 MCP 客户端", min_length=1, max_length=120)


def _public_key(row):
    return {field: getattr(row, field) for field in ("id", "name", "prefix", "created_at", "last_used_at", "revoked_at", "revoked")}


def _rpc_error(message_id, code, message):
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


def register_mcp(app, owner_dependency, database_dependency, tool_handlers):
    """Bind {name: {description, inputSchema, fn(args, owner_id, session)}}.

    Handlers must perform the same validation and ownership checks as REST routes.
    The transport derives owner_id exclusively from the authenticated API key.
    """
    handlers = dict(tool_handlers)
    for name, spec in handlers.items():
        if not isinstance(name, str) or not callable(spec.get("fn")) or not isinstance(spec.get("inputSchema"), Mapping):
            raise ValueError("MCP tools require a name, inputSchema and callable fn")

    allowed_origins = {origin.strip() for origin in os.getenv(
        "CORS_ORIGINS", "http://localhost:5175,http://127.0.0.1:5175,http://localhost:8001,http://127.0.0.1:8001"
    ).split(",") if origin.strip()}

    def validate_origin(request):
        if request.headers.get("origin") is not None and request.headers["origin"] not in allowed_origins:
            raise HTTPException(403, "Origin is not allowed")

    def bearer_owner(request: Request, session=Depends(database_dependency)):
        validate_origin(request)
        scheme, _, secret = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not secret or len(secret) > 256:
            raise HTTPException(401, "A valid local MCP API key is required", headers={"WWW-Authenticate": "Bearer"})
        digest = hashlib.sha256(secret.encode()).hexdigest()
        key = session.scalar(select(ApiKey).join(User, User.id == ApiKey.owner_id).where(ApiKey.key_hash == digest, ApiKey.revoked.is_(False)))
        if key is None:
            raise HTTPException(401, "A valid local MCP API key is required", headers={"WWW-Authenticate": "Bearer"})
        key.last_used_at = now()
        session.commit()
        return key.owner_id

    @app.get("/api/mcp/keys")
    def list_keys(oid=Depends(owner_dependency), session=Depends(database_dependency)):
        rows = session.scalars(select(ApiKey).where(ApiKey.owner_id == oid).order_by(ApiKey.created_at.desc())).all()
        return {"items": [_public_key(row) for row in rows], "total": len(rows)}

    @app.post("/api/mcp/keys", status_code=201)
    def create_key(body: KeyInput, oid=Depends(owner_dependency), session=Depends(database_dependency)):
        name = body.name.strip()
        if not name:
            raise HTTPException(422, "API key name cannot be blank")
        secret = "dbmcp_" + secrets.token_urlsafe(32)
        row = ApiKey(owner_id=oid, name=name, key_hash=hashlib.sha256(secret.encode()).hexdigest(), prefix=secret[:14])
        session.add(row)
        session.commit()
        return JSONResponse({**_public_key(row), "secret": secret}, status_code=201, headers={"Cache-Control": "no-store"})

    @app.delete("/api/mcp/keys/{key_id}", status_code=204)
    def revoke_key(key_id: str, oid=Depends(owner_dependency), session=Depends(database_dependency)):
        row = session.scalar(select(ApiKey).where(ApiKey.id == key_id, ApiKey.owner_id == oid))
        if row is None:
            raise HTTPException(404, "API key not found")
        row.revoked = True
        row.revoked_at = row.revoked_at or now()
        session.commit()
        return Response(status_code=204)

    async def dispatch(message, oid, session):
        if not isinstance(message, dict):
            return _rpc_error(None, -32600, "Invalid Request")
        message_id = message.get("id")
        if message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str) or (
            "id" in message and (not isinstance(message_id, (str, int)) or isinstance(message_id, bool))
        ):
            return _rpc_error(None, -32600, "Invalid Request")
        # Notifications never trigger tools or produce a JSON-RPC response.
        if "id" not in message:
            return None
        method = message["method"]
        params = message.get("params", {})
        if not isinstance(params, dict):
            return _rpc_error(message_id, -32602, "Invalid params")
        result = None
        if method == "initialize":
            client_info = params.get("clientInfo")
            if not isinstance(params.get("protocolVersion"), str) or not isinstance(params.get("capabilities"), dict) or not isinstance(client_info, dict) or not all(isinstance(client_info.get(field), str) for field in ("name", "version")):
                return _rpc_error(message_id, -32602, "Invalid initialize params")
            result = {"protocolVersion": MCP_VERSION, "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "dramabuddy-local", "version": "0.1.0"}, "instructions": "Local workspace only. Tools act as the API key owner."}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [{"name": name, "description": spec.get("description", ""), "inputSchema": spec["inputSchema"]} for name, spec in handlers.items()]}
        elif method == "tools/call":
            name, arguments = params.get("name"), params.get("arguments", {})
            if not isinstance(name, str) or name not in handlers or not isinstance(arguments, dict):
                return _rpc_error(message_id, -32602, "Unknown tool or invalid arguments")
            try:
                value = handlers[name]["fn"](arguments, oid, session)
                if inspect.isawaitable(value):
                    value = await value
                result = {"content": [{"type": "text", "text": json.dumps(jsonable_encoder(value), ensure_ascii=False)}], "isError": False}
            except HTTPException as error:
                session.rollback()
                # Application handlers supply public HTTP details, never raw provider errors.
                result = {"content": [{"type": "text", "text": f"{error.status_code}: {error.detail}"}], "isError": True}
            except (ValidationError, ValueError, TypeError, KeyError):
                session.rollback()
                result = {"content": [{"type": "text", "text": "Invalid tool arguments"}], "isError": True}
            except Exception:
                session.rollback()
                result = {"content": [{"type": "text", "text": "Local tool failed"}], "isError": True}
        else:
            return _rpc_error(message_id, -32601, "Method not found")
        return {"jsonrpc": "2.0", "id": message_id, "result": result}

    @app.post("/api/mcp")
    async def mcp(request: Request, oid=Depends(bearer_owner), session=Depends(database_dependency)):
        if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
            raise HTTPException(415, "MCP requests require application/json")
        version = request.headers.get("mcp-protocol-version")
        if version is not None and version != MCP_VERSION:
            raise HTTPException(400, "Unsupported MCP protocol version")
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JSONResponse(_rpc_error(None, -32700, "Parse error"), status_code=400)
        if isinstance(body, list):
            if not body:
                return JSONResponse(_rpc_error(None, -32600, "Invalid Request"), status_code=400)
            results = []
            for message in body:
                result = await dispatch(message, oid, session)
                if result is not None:
                    results.append(result)
            return JSONResponse(results) if results else Response(status_code=202)
        result = await dispatch(body, oid, session)
        return JSONResponse(result) if result is not None else Response(status_code=202)

    @app.get("/api/mcp")
    def no_event_stream(oid=Depends(bearer_owner)):
        return Response(status_code=405, headers={"Allow": "POST"})
