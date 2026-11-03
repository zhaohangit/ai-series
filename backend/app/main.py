import hashlib
import json
import os
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import create_engine, delete, event, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from .models import Asset, Base, Canvas, Episode, Ledger, Member, Project, Shot, Space, Task, Upload, User, now, uid
from .providers import OpenAICompatibleProvider
from .mcp_local import register_mcp
from .schemas import AssetInput, CanvasInput, EpisodeInput, ParseInput, ProfileInput, ProjectInput, ShotInput, TaskInput
from .storage import MediaStorage
from .exports import export_mp4, export_zip, validate_export
from .targets import apply_target, capture_target


def serialize(row):
    if isinstance(row, Task):
        return {"id": row.id, "kind": row.kind, "project_id": row.project_id, "status": row.status, "progress": row.progress, "result": row.result, "error": row.error, "created_at": row.created_at, "updated_at": row.updated_at, "prompt": row.data.get("prompt", ""), "parameters": row.data.get("parameters", {})}
    result = {**row.data, "id": row.id, "created_at": row.created_at, "updated_at": row.updated_at}
    if isinstance(row, (Episode, Shot)):
        result["project_id"] = row.project_id
    if isinstance(row, Shot):
        result["episode_id"] = row.episode_id
    return result


def envelope(items):
    return {"items": items, "total": len(items)}


def create_app(database_url=None, media_root=None, session_secret=None):
    database_url = database_url or os.getenv("DATABASE_URL", "sqlite:///./data/local.sqlite")
    if database_url.startswith("postgresql://"):
        database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    media_root = Path(media_root or os.getenv("MEDIA_ROOT", "./data/media")).resolve()
    media_root.mkdir(parents=True, exist_ok=True)
    if database_url.startswith("sqlite:///"):
        Path(database_url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(database_url, pool_pre_ping=True, connect_args={"check_same_thread": False} if database_url.startswith("sqlite") else {})
    if database_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def sqlite_foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
    factory = sessionmaker(engine, expire_on_commit=False)
    storage = MediaStorage(media_root)

    # Persist the local signing key across restarts, without embedding credentials in source.
    secret_path = media_root.parent / ".session-secret"
    if not session_secret:
        session_secret = os.getenv("SESSION_SECRET")
    if not session_secret:
        try:
            descriptor = os.open(secret_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w") as handle:
                handle.write(secrets.token_urlsafe(48))
        except FileExistsError:
            pass
        session_secret = secret_path.read_text().strip()

    @asynccontextmanager
    async def lifespan(app):
        Base.metadata.create_all(engine)
        app.state.storage.prepare()
        if os.getenv("TASK_EXECUTOR", "background") == "background":
            with factory() as session:
                interrupted = session.scalars(select(Task).where(Task.status.in_(["queued", "running"]))).all()
                interrupted_ids = [task.id for task in interrupted if task.data.get("executor") == "background"]
            for task_id in interrupted_ids:
                fail_task(app, task_id, "Local background worker interrupted by restart; credits refunded")
        yield
        engine.dispose()

    app = FastAPI(title="DramaBuddy local API", version="0.1.0", lifespan=lifespan)
    app.state.database_url = database_url
    app.state.media_root = media_root
    app.state.session_secret = session_secret
    app.state.session_factory = factory
    app.state.provider = OpenAICompatibleProvider()
    app.state.storage = storage
    app.add_middleware(SessionMiddleware, secret_key=session_secret, session_cookie="dramabuddy_local", same_site="lax", https_only=os.getenv("COOKIE_SECURE", "false").lower() == "true", max_age=60 * 60 * 24 * 365)
    allowed_origins = os.getenv("CORS_ORIGINS", "http://localhost:5175,http://127.0.0.1:5175,http://localhost:8001,http://127.0.0.1:8001").split(",")
    app.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def mutation_origin(request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.headers.get("origin") and request.headers["origin"] not in allowed_origins:
            return JSONResponse({"detail": "Origin is not allowed to mutate the local workspace"}, status_code=403)
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        details = "; ".join(".".join(str(p) for p in item["loc"][1:]) + ": " + item["msg"] for item in error.errors())
        return JSONResponse({"detail": details}, status_code=422)

    def database():
        with factory() as session:
            yield session

    def owner(request: Request):
        owner_id = request.session.get("user_id")
        with factory() as session:
            user = session.get(User, owner_id) if owner_id else None
            if user is None:
                user = User()
                session.add(user)
                session.flush()
                space = Space(owner_id=user.id)
                session.add(space)
                session.flush()
                session.add(Member(space_id=space.id, user_id=user.id))
                session.add(Ledger(owner_id=user.id, action="local_grant", amount=1000, description="本地演示额度，非付费余额"))
                session.commit()
                request.session["user_id"] = user.id
            return user.id

    def owned(session, model, row_id, owner_id, lock=False):
        query = select(model).where(model.id == row_id, model.owner_id == owner_id)
        item = session.scalar(query.with_for_update() if lock else query)
        if item is None:
            raise HTTPException(404, "Resource not found")
        return item

    def children(session, model, pid, oid):
        return session.scalars(select(model).where(model.project_id == pid, model.owner_id == oid).order_by(model.created_at)).all()

    def check_episode(session, episode_id, project_id, owner_id):
        if episode_id:
            episode = owned(session, Episode, episode_id, owner_id)
            if episode.project_id != project_id:
                raise HTTPException(422, "Episode belongs to another project")

    @app.get("/api/health")
    def health(session=Depends(database)):
        session.execute(text("SELECT 1"))
        return {"status": "ok", "database": "postgresql" if engine.dialect.name == "postgresql" else "sqlite-local", "mode": "local"}

    @app.get("/api/session")
    def session_info(oid=Depends(owner), session=Depends(database)):
        user = session.get(User, oid)
        space = session.scalar(select(Space).where(Space.owner_id == oid))
        return {"user": {"id": oid, "name": user.name, "avatar": ""}, "space": {"id": space.id, "name": space.name}, "credits": user.credits, "provider_status": {kind: app.state.provider.available(kind) for kind in ("text", "image", "video", "audio")}, "mode": "local"}

    @app.get("/api/catalog")
    def catalog():
        reference = json.loads(Path(__file__).with_name("reference_catalog.json").read_text())
        configured = [{"id": "configured-" + kind, "name": "自定义" + label + "模型", "kind": kind, "available": app.state.provider.available(kind)} for kind, label in (("text", "文本"), ("image", "图像"), ("audio", "音频"), ("video", "视频"))]
        return {"styles": reference["styles"], "models": configured + reference["reference_models"], "presets": [], "announcements": reference["announcements"], "examples": [], "main_image_templates": reference["main_image_templates"], "mode": "local", "fixture_notice": "参考站风格、模型与更新公告为只读目录，不代表本地模型已接入。", "source": reference["source"]}

    @app.get("/api/projects")
    def list_projects(kind: str | None = None, q: str = "", oid=Depends(owner), session=Depends(database)):
        rows = session.scalars(select(Project).where(Project.owner_id == oid).order_by(Project.updated_at.desc())).all()
        return envelope([serialize(row) for row in rows if (not kind or row.data.get("kind") == kind) and q.casefold() in row.data.get("name", "").casefold()])

    @app.post("/api/projects", status_code=201)
    def create_project(body: ProjectInput, oid=Depends(owner), session=Depends(database)):
        row = Project(owner_id=oid, data=body.model_dump())
        session.add(row)
        session.flush()
        session.add(Canvas(project_id=row.id, data={"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}))
        session.commit()
        return serialize(row)

    @app.get("/api/projects/{pid}")
    def get_project(pid: str, oid=Depends(owner), session=Depends(database)):
        return serialize(owned(session, Project, pid, oid))

    def patch_content(model, schema, row_id, body, oid, session):
        row = owned(session, model, row_id, oid, lock=True)
        unknown = set(body) - set(schema.model_fields)
        if unknown:
            raise HTTPException(422, "Unknown fields: " + ", ".join(sorted(unknown)))
        merged = {**row.data, **body}
        if model is Shot:
            merged["episode_id"] = body.get("episode_id", row.episode_id)
        try:
            validated = schema.model_validate(merged).model_dump()
        except ValueError:
            raise HTTPException(422, "Invalid field values")
        if model is Shot:
            check_episode(session, validated["episode_id"], row.project_id, oid)
            row.episode_id = validated.pop("episode_id")
        row.data = validated
        row.updated_at = now()
        session.commit()
        return serialize(row)

    @app.patch("/api/projects/{pid}")
    def patch_project(pid: str, body: dict, oid=Depends(owner), session=Depends(database)):
        return patch_content(Project, ProjectInput, pid, body, oid, session)

    @app.delete("/api/projects/{pid}", status_code=204)
    def delete_project(pid: str, oid=Depends(owner), session=Depends(database)):
        row = owned(session, Project, pid, oid)
        if session.scalar(select(Task.id).where(Task.project_id == pid, Task.status.in_(["queued", "running"]))) is not None:
            raise HTTPException(409, "Project has active tasks")
        session.delete(row)
        session.commit()
        return Response(status_code=204)

    @app.get("/api/projects/{pid}/episodes")
    def list_episodes(pid: str, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid)
        return envelope(sorted([serialize(row) for row in children(session, Episode, pid, oid)], key=lambda row: row["position"]))

    @app.post("/api/projects/{pid}/episodes", status_code=201)
    def create_episode(pid: str, body: EpisodeInput, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid)
        row = Episode(owner_id=oid, project_id=pid, data=body.model_dump())
        session.add(row)
        session.commit()
        return serialize(row)

    @app.patch("/api/episodes/{eid}")
    def patch_episode(eid: str, body: dict, oid=Depends(owner), session=Depends(database)):
        return patch_content(Episode, EpisodeInput, eid, body, oid, session)

    @app.delete("/api/episodes/{eid}", status_code=204)
    def delete_episode(eid: str, oid=Depends(owner), session=Depends(database)):
        session.delete(owned(session, Episode, eid, oid))
        session.commit()
        return Response(status_code=204)

    @app.get("/api/projects/{pid}/shots")
    def list_shots(pid: str, episode_id: str | None = None, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid)
        return envelope(sorted([serialize(row) for row in children(session, Shot, pid, oid) if not episode_id or row.episode_id == episode_id], key=lambda row: row["position"]))

    @app.post("/api/projects/{pid}/shots", status_code=201)
    def create_shot(pid: str, body: ShotInput, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid)
        check_episode(session, body.episode_id, pid, oid)
        data = body.model_dump()
        episode_id = data.pop("episode_id")
        row = Shot(owner_id=oid, project_id=pid, episode_id=episode_id, data=data)
        session.add(row)
        session.commit()
        return serialize(row)

    @app.patch("/api/shots/{sid}")
    def patch_shot(sid: str, body: dict, oid=Depends(owner), session=Depends(database)):
        return patch_content(Shot, ShotInput, sid, body, oid, session)

    @app.delete("/api/shots/{sid}", status_code=204)
    def delete_shot(sid: str, oid=Depends(owner), session=Depends(database)):
        session.delete(owned(session, Shot, sid, oid))
        session.commit()
        return Response(status_code=204)

    @app.get("/api/assets")
    def list_assets(kind: str | None = None, q: str = "", oid=Depends(owner), session=Depends(database)):
        rows = session.scalars(select(Asset).where(Asset.owner_id == oid).order_by(Asset.created_at.desc())).all()
        return envelope([serialize(row) for row in rows if (not kind or row.data["kind"] == kind) and q.casefold() in row.data["name"].casefold()])

    @app.post("/api/assets", status_code=201)
    def create_asset(body: AssetInput, oid=Depends(owner), session=Depends(database)):
        row = Asset(owner_id=oid, data=body.model_dump())
        session.add(row)
        session.commit()
        return serialize(row)

    @app.patch("/api/assets/{aid}")
    def patch_asset(aid: str, body: dict, oid=Depends(owner), session=Depends(database)):
        return patch_content(Asset, AssetInput, aid, body, oid, session)

    @app.delete("/api/assets/{aid}", status_code=204)
    def delete_asset(aid: str, oid=Depends(owner), session=Depends(database)):
        session.delete(owned(session, Asset, aid, oid))
        session.commit()
        return Response(status_code=204)

    @app.get("/api/projects/{pid}/canvas")
    def get_canvas(pid: str, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid)
        row = session.get(Canvas, pid)
        return {**row.data, "revision": row.revision}

    @app.put("/api/projects/{pid}/canvas")
    def put_canvas(pid: str, body: CanvasInput, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid)
        data = body.model_dump(exclude={"revision"})
        changed = session.execute(update(Canvas).where(Canvas.project_id == pid, Canvas.revision == body.revision).values(data=data, revision=body.revision + 1))
        if changed.rowcount != 1:
            raise HTTPException(409, "Canvas changed; reload before saving")
        session.commit()
        return {**data, "revision": body.revision + 1}

    @app.post("/api/projects/{pid}/duplicate", status_code=201)
    def duplicate(pid: str, oid=Depends(owner), session=Depends(database)):
        original = owned(session, Project, pid, oid)
        clone = Project(owner_id=oid, data={**original.data, "name": original.data["name"] + " 副本"})
        session.add(clone)
        session.flush()
        ids = {}
        for episode in children(session, Episode, pid, oid):
            copy = Episode(owner_id=oid, project_id=clone.id, data=episode.data)
            session.add(copy)
            session.flush()
            ids[episode.id] = copy.id
        for shot in children(session, Shot, pid, oid):
            session.add(Shot(owner_id=oid, project_id=clone.id, episode_id=ids.get(shot.episode_id), data=shot.data))
        canvas = session.get(Canvas, pid)
        session.add(Canvas(project_id=clone.id, data=canvas.data, revision=0))
        session.commit()
        return serialize(clone)

    @app.post("/api/projects/{pid}/parse-script")
    def parse_script(pid: str, body: ParseInput | None = None, oid=Depends(owner), session=Depends(database)):
        row = owned(session, Project, pid, oid)
        script = body.script if body and body.script is not None else row.data.get("script", "")
        episodes, shots = [], []
        current = None
        for line in script.splitlines():
            line = line.strip()
            if not line:
                continue
            if re.match(r"^(第[零一二三四五六七八九十百千万\d]+[集章节]|episode\s+\d+|ep\.?\s*\d+)", line, re.I):
                current = {"name": line[:200], "position": len(episodes), "script": "", "settings": {}}
                episodes.append(current)
            else:
                if current is None:
                    current = {"name": "第1集", "position": 0, "script": "", "settings": {}}
                    episodes.append(current)
                current["script"] += ("\n" if current["script"] else "") + line
                shots.append({"name": f"分镜 {len(shots)+1}", "position": len(shots), "episode_position": current["position"], "prompt": line, "dialogue": "", "duration": 5, "settings": {}})
        return {"episodes": episodes, "shots": shots, "mode": "deterministic_local_parser", "notice": "按章节标题和非空行拆分；未调用 AI，尚未保存。"}

    def store_bytes(session, oid, contents, filename, content_type):
        extension = Path(filename).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,8}", extension):
            extension = ".bin"
        path = f"{oid}/{uid()}{extension}"
        app.state.storage.put(path, contents, content_type)
        record = Upload(owner_id=oid, path=path, filename=filename[:200], content_type=content_type, size=len(contents))
        session.add(record)
        return {"url": "/media/" + path, "filename": filename[:200], "size": len(contents), "content_type": content_type}

    app.state.store_bytes = store_bytes

    @app.post("/api/uploads", status_code=201)
    async def upload(file: UploadFile = File(...), oid=Depends(owner), session=Depends(database)):
        limit = int(os.getenv("MAX_UPLOAD_BYTES", "52428800"))
        parts, size = [], 0
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                raise HTTPException(413, "Upload exceeds configured size limit")
            parts.append(chunk)
        if not size:
            raise HTTPException(422, "Upload is empty")
        name = Path((file.filename or "upload.bin").replace("\\", "/")).name
        result = store_bytes(session, oid, b"".join(parts), name, file.content_type or "application/octet-stream")
        session.commit()
        return result

    @app.get("/media/{media_path:path}")
    def media(media_path: str, request: Request, oid=Depends(owner), session=Depends(database)):
        record = session.scalar(select(Upload).where(Upload.path == media_path, Upload.owner_id == oid))
        if record is None:
            raise HTTPException(404, "Media not found")
        return app.state.storage.response(media_path, record.content_type, request)

    @app.get("/api/tasks")
    def list_tasks(project_id: str | None = None, oid=Depends(owner), session=Depends(database)):
        return envelope([serialize(row) for row in session.scalars(select(Task).where(Task.owner_id == oid).order_by(Task.created_at.desc())).all() if not row.data.get("deleted") and (not project_id or row.project_id == project_id)])

    @app.post("/api/tasks", status_code=202)
    def submit_task(body: TaskInput, background: BackgroundTasks, oid=Depends(owner), session=Depends(database)):
        payload = body.model_dump()
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        existing = session.scalar(select(Task).where(Task.owner_id == oid, Task.idempotency_key == body.idempotency_key))
        if existing:
            if existing.request_hash != fingerprint:
                raise HTTPException(409, "Idempotency key already used for different request")
            if existing.data.get("deleted"):
                raise HTTPException(410, "Completed task was deleted; use a new idempotency key for a new task")
            return serialize(existing)
        if body.project_id:
            owned(session, Project, body.project_id, oid)
        if body.kind == "export":
            if not body.project_id:
                raise HTTPException(422, "Export requires a project")
            validate_export(session, oid, body.project_id, body.parameters)
        elif not app.state.provider.available(body.kind):
            raise HTTPException(503, f"{body.kind} provider is not configured; no credits charged")
        cost = 0 if body.kind == "export" else 1
        charged = session.execute(update(User).where(User.id == oid, User.credits >= cost).values(credits=User.credits - cost))
        if charged.rowcount != 1:
            session.rollback()
            raise HTTPException(402, "Insufficient local credits")
        # This write serializes owner submissions on PostgreSQL before checking active targets.
        target = capture_target(session, oid, body.project_id, body.parameters) if body.kind != "export" else None
        task = Task(owner_id=oid, kind=body.kind, project_id=body.project_id, idempotency_key=body.idempotency_key, request_hash=fingerprint, data={"prompt": body.prompt, "parameters": body.parameters, "cost": cost, "target": target, "executor": os.getenv("TASK_EXECUTOR", "background")})
        session.add(task)
        try:
            session.flush()
            if cost:
                session.add(Ledger(owner_id=oid, task_id=task.id, action="reserve", amount=-cost, description="本地任务额度预留"))
            session.commit()
        except IntegrityError:
            session.rollback()
            task = session.scalar(select(Task).where(Task.owner_id == oid, Task.idempotency_key == body.idempotency_key))
            if task is None or task.request_hash != fingerprint:
                raise HTTPException(409, "Task submission conflict")
            return serialize(task)
        if os.getenv("TASK_EXECUTOR", "background") == "celery":
            try:
                from .worker import run_task
                run_task.delay(task.id)
            except Exception:
                fail_task(app, task.id, "Task queue unavailable; credits refunded")
                raise HTTPException(503, "Task queue unavailable; credits refunded")
        else:
            background.add_task(execute_task, app, task.id)
        return serialize(task)

    @app.get("/api/tasks/{tid}")
    def get_task(tid: str, oid=Depends(owner), session=Depends(database)):
        task = owned(session, Task, tid, oid)
        if task.data.get("deleted"):
            raise HTTPException(404, "Resource not found")
        return serialize(task)

    @app.delete("/api/tasks/{tid}", status_code=204)
    def delete_task(tid: str, oid=Depends(owner), session=Depends(database)):
        task = owned(session, Task, tid, oid)
        if task.status not in ("failed", "succeeded"):
            raise HTTPException(409, "Active tasks cannot be deleted")
        task.data = {**task.data, "deleted": True}
        session.commit()
        return Response(status_code=204)

    @app.get("/api/credits")
    def credits(oid=Depends(owner), session=Depends(database)):
        rows = session.scalars(select(Ledger).where(Ledger.owner_id == oid).order_by(Ledger.created_at.desc())).all()
        return {"balance": session.get(User, oid).credits, "items": [{"id": row.id, "task_id": row.task_id, "action": row.action, "amount": row.amount, "description": row.description, "created_at": row.created_at} for row in rows], "mode": "local", "notice": "本地演示额度，无真实购买或计费"}

    @app.patch("/api/profile")
    def profile(body: ProfileInput, oid=Depends(owner), session=Depends(database)):
        if not body.name.strip():
            raise HTTPException(422, "Name cannot be blank")
        user = session.get(User, oid)
        user.name = body.name.strip()
        session.commit()
        return {"id": oid, "name": user.name, "avatar": ""}

    @app.get("/api/spaces")
    def spaces(oid=Depends(owner), session=Depends(database)):
        rows = session.scalars(select(Space).where(Space.owner_id == oid)).all()
        return envelope([{"id": row.id, "name": row.name, "role": "owner", "mode": "local"} for row in rows])

    def string_tool(description, fields, required, handler):
        def invoke(arguments, oid, session):
            if set(arguments) - set(fields) or any(key not in arguments for key in required):
                raise ValueError("Invalid tool arguments")
            if any(not isinstance(value, str) or len(value) > 1000 for value in arguments.values()):
                raise ValueError("Invalid tool arguments")
            return handler(arguments, oid, session)
        return {"description": description, "inputSchema": {"type": "object", "properties": {name: {"type": "string"} for name in fields}, "required": list(required), "additionalProperties": False}, "fn": invoke}

    register_mcp(app, owner, database, {
        "list_projects": string_tool("List the local key owner's projects", ("kind", "q"), (), lambda a, o, s: list_projects(kind=a.get("kind"), q=a.get("q", ""), oid=o, session=s)),
        "get_project": string_tool("Read an owned project", ("project_id",), ("project_id",), lambda a, o, s: get_project(a["project_id"], oid=o, session=s)),
        "list_episodes": string_tool("List episodes in an owned project", ("project_id",), ("project_id",), lambda a, o, s: list_episodes(a["project_id"], oid=o, session=s)),
        "list_shots": string_tool("List shots in an owned project", ("project_id",), ("project_id",), lambda a, o, s: list_shots(a["project_id"], oid=o, session=s)),
        "list_assets": string_tool("List owned materials", ("kind", "q"), (), lambda a, o, s: list_assets(kind=a.get("kind"), q=a.get("q", ""), oid=o, session=s)),
        "list_tasks": string_tool("List owned generation and export tasks", ("project_id",), (), lambda a, o, s: list_tasks(project_id=a.get("project_id"), oid=o, session=s)),
        "get_task": string_tool("Inspect an owned generation or export task", ("task_id",), ("task_id",), lambda a, o, s: get_task(a["task_id"], oid=o, session=s)),
        "create_project": {"description": "Create a local project, without generating paid media", "inputSchema": ProjectInput.model_json_schema(), "fn": lambda a, o, s: create_project(ProjectInput.model_validate(a), oid=o, session=s)},
    })

    return app


def fail_task(app, task_id, message="Generation failed; reserved credits refunded"):
    with app.state.session_factory() as session:
        task = session.scalar(select(Task).where(Task.id == task_id).with_for_update())
        if not task or task.status in ("succeeded", "failed"):
            return
        task.status = "failed"
        task.error = message
        task.updated_at = now()
        cost = task.data.get("cost", 0)
        if cost:
            session.execute(update(User).where(User.id == task.owner_id).values(credits=User.credits + cost))
            session.add(Ledger(owner_id=task.owner_id, task_id=task.id, action="refund", amount=cost, description="任务失败，退回预留额度"))
        session.commit()


def execute_task(app, task_id, recover_interrupted=False):
    # Atomic claim: duplicate queue deliveries never repeat a provider call.
    with app.state.session_factory() as session:
        claim = session.execute(update(Task).where(Task.id == task_id, Task.status == "queued").values(status="running", progress=10, updated_at=now()))
        session.commit()
        if claim.rowcount != 1:
            if recover_interrupted:
                # A broker redelivery of a claimed task has an unknown external outcome.
                # Never call a paid provider again: fail and release the local reservation.
                fail_task(app, task_id, "Worker interrupted; provider result is unknown; reserved local credits refunded")
            return
        task = session.get(Task, task_id)
        kind, payload, oid, pid = task.kind, task.data, task.owner_id, task.project_id
    try:
        if kind == "export":
            with app.state.session_factory() as session:
                project = session.get(Project, pid)
                if project is None:
                    raise RuntimeError("Project unavailable")
                canvas = session.get(Canvas, pid)
                bundle = {"format": "dramabuddy-project-v1", "project": serialize(project), "episodes": [serialize(row) for row in session.scalars(select(Episode).where(Episode.project_id == pid)).all()], "shots": [serialize(row) for row in session.scalars(select(Shot).where(Shot.project_id == pid)).all()], "canvas": {**canvas.data, "revision": canvas.revision}}
                format = payload.get("parameters", {}).get("format", "json")
                if format == "zip":
                    contents, filename, content_type = export_zip(app, session, oid, bundle), "project.zip", "application/zip"
                elif format == "mp4":
                    contents, filename, content_type = export_mp4(app, session, oid, bundle), "timeline.mp4", "video/mp4"
                else:
                    contents, filename, content_type = json.dumps(bundle, ensure_ascii=False, indent=2).encode(), "project.json", "application/json"
                result = app.state.store_bytes(session, oid, contents, filename, content_type)
                session.commit()
        else:
            result = app.state.provider.generate(kind, payload["prompt"], payload["parameters"])
            byte_key = next((key for key in ("_image_bytes", "_audio_bytes", "_video_bytes") if key in result), None)
            if byte_key:
                data = result.pop(byte_key)
                defaults = {"_image_bytes": ("png", "image/png"), "_audio_bytes": ("mp3", "audio/mpeg"), "_video_bytes": ("mp4", "video/mp4")}
                extension, content_type = defaults[byte_key]
                extension = result.pop("extension", extension)
                content_type = result.pop("content_type", content_type)
                if extension not in {"png", "jpg", "jpeg", "webp", "mp3", "wav", "ogg", "flac", "aac", "mp4"} or not isinstance(data, bytes):
                    raise RuntimeError("Invalid generated media")
                with app.state.session_factory() as session:
                    result.update(app.state.store_bytes(session, oid, data, "generated." + extension, content_type))
                    session.commit()
        if not isinstance(result, dict) or not result:
            raise RuntimeError("Empty provider response")
        with app.state.session_factory() as session:
            task = session.scalar(select(Task).where(Task.id == task_id).with_for_update())
            if task.status != "running":
                return
            application = apply_target(session, task, result)
            if application:
                result["application"] = application
            task.result = result
            task.status = "succeeded"
            task.progress = 100
            task.updated_at = now()
            if payload.get("cost", 0):
                session.add(Ledger(owner_id=oid, task_id=task_id, action="settle", amount=0, description="任务成功，结算预留额度"))
            session.commit()
    except Exception:
        # Do not surface provider response bodies, URLs or credentials to UI/logs.
        fail_task(app, task_id)


app = create_app()
