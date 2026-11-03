# Local MCP connection

DramaBuddy exposes an optional local MCP endpoint at `http://127.0.0.1:8001/api/mcp` (use your configured API port). This is a local implementation with personal API keys. OAuth discovery is not implemented; compatibility depends on the MCP client.

Use the connection guide in the local application to explicitly create a named API key. Creating a key is `POST /api/mcp/keys` with `{"name":"My MCP client"}` and the existing local browser cookie. The response contains the key in `secret` exactly once and includes `Cache-Control: no-store`. Store it in your MCP client's secret or environment configuration. Listing keys with `GET /api/mcp/keys` shows metadata and prefixes only. `DELETE /api/mcp/keys/{id}` revokes your key immediately. Key management follows the same local cookie identity as the workspace; a bearer token does not authenticate those browser routes. The local demo cookie is not an Internet identity provider.

Configure a client that supports Streamable HTTP and custom headers:

```json
{
  "mcpServers": {
    "dramabuddy-local": {
      "url": "http://127.0.0.1:8001/api/mcp",
      "headers": {"Authorization": "Bearer <your-local-key>"}
    }
  }
}
```

Client configuration varies. Some clients require an explicit HTTP transport setting; consult that client's connection settings. Never commit a real key in a config file or screenshot. Keep the API on the loopback interface for local use.

The server negotiates MCP `2025-03-26`. It supports `initialize`, `ping`, `notifications/initialized`, `tools/list`, and `tools/call`. Send JSON-RPC using HTTP POST with `Content-Type: application/json` and `Accept: application/json, text/event-stream`. Responses use JSON; accepted notifications return HTTP 202 without a body. The endpoint is stateless and does not issue `Mcp-Session-Id`. GET returns HTTP 405 because there is no SSE notification stream. Batch JSON-RPC requests are supported. Invalid/missing/revoked bearer keys return HTTP 401. An unsupported explicit `MCP-Protocol-Version` header returns HTTP 400. Initialize may propose a different version; the response advertises the sole supported version so the client can accept it or disconnect.

Available tools are supplied by the application and discoverable using `tools/list`. The initial integration exposes `list_projects`, `get_project`, `list_episodes`, `list_shots`, `list_assets`, `list_tasks`, `get_task`, and `create_project`. All tools act as the API key's owner, including when a different browser cookie accompanies the request. Resource access uses the REST application's ownership checks. Tool failures return MCP `isError: true`; malformed JSON-RPC methods/arguments return JSON-RPC errors. This endpoint does not expose a generation or payment tool.

The database stores only a SHA-256 digest of each randomly generated 256-bit key, its display prefix, owner, name, creation/last-use/revocation timestamps, and revocation status. The raw key is never persisted by the implementation. Revocation retains the metadata for the local key list. The server validates any supplied Origin against `CORS_ORIGINS`; ordinary non-browser MCP clients omit Origin.

## Integration contract

Import the module before `Base.metadata.create_all` runs, so its SQLAlchemy table is included:

```python
from .mcp_local import register_mcp
```

Inside `create_app`, call `register_mcp(app, owner, database, tool_handlers)` after the existing route handlers are defined and before `return app`. A handler entry has this shape:

```python
{
    "get_project": {
        "description": "Get one of my local projects",
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": {"type": "string"}},
            "required": ["project_id"],
            "additionalProperties": False,
        },
        "fn": lambda args, oid, session: get_project(
            pid=args["project_id"], oid=oid, session=session
        ),
    }
}
```

Every adapter must validate arguments and pass `oid` and `session` explicitly. FastAPI `Depends` defaults do not resolve when a route function is invoked directly. For creating a project, use `ProjectInput.model_validate(args)` and invoke `create_project(body=validated, oid=oid, session=session)`. List adapters must provide explicit defaults such as `q=""` and `kind=None`. The transport passes a Python dictionary, the bearer key owner ID, and the request-scoped SQLAlchemy session to each function; synchronous and asynchronous functions are accepted. Application handlers retain responsibility for input validation, resource ownership, business policy, and transaction commits. Do not implement separate ownership or billing logic in adapters.

## Local verification

Run from the repository root:

```sh
uv run --project backend pytest backend/tests/test_mcp_local.py -q
```

The isolated tests use local SQLite and TestClient. They cover secret hashing and one-time disclosure, key listing/revocation isolation, bearer-owner tool access, malformed JSON-RPC, discovery/initialization, notifications, batches, origin rejection, and revoked-token rejection. They make no remote service or model calls. Application integration tests should additionally exercise the registered tool adapters against the real REST handlers.

Protocol reference: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
