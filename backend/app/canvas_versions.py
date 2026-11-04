"""Durable, owner-scoped canvas snapshots; callers commit with the graph write."""
from copy import deepcopy

from fastapi import Depends, HTTPException, Query
from pydantic import Field
from sqlalchemy import JSON, ForeignKey, Index, Integer, String, func, select, update
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, Canvas, Project, now, uid
from .schemas import StrictModel


class CanvasVersion(Base):
    __tablename__ = "canvas_versions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    data: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(30), default="auto")
    name: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    node_count: Mapped[int] = mapped_column(Integer)
    edge_count: Mapped[int] = mapped_column(Integer)
    __table_args__ = (Index("ix_canvas_versions_project_owner_created", "project_id", "owner_id", "created_at"),)


class SaveVersion(StrictModel):
    name: str = Field(default="", max_length=200)
    revision: int = Field(ge=0)


class RestoreVersion(StrictModel):
    revision: int = Field(ge=0)


def checkpoint(session, project_id, owner_id, data, revision, kind="auto", name=""):
    """Add an independent snapshot without committing the surrounding transaction."""
    graph = deepcopy({key: value for key, value in data.items() if key != "revision"})
    row = CanvasVersion(
        project_id=project_id, owner_id=owner_id, data=graph, revision=revision,
        kind=kind, name=name, node_count=len(graph.get("nodes", [])),
        edge_count=len(graph.get("edges", [])),
    )
    session.add(row)
    return row


_metadata = ("id", "project_id", "revision", "kind", "name", "created_at", "node_count", "edge_count")


def version_metadata(row):
    return {key: getattr(row, key) for key in _metadata}


def register_canvas_versions(app, owner, database, owned):
    def version(session, pid, vid, oid):
        owned(session, Project, pid, oid)
        row = session.scalar(select(CanvasVersion).where(
            CanvasVersion.id == vid, CanvasVersion.project_id == pid,
            CanvasVersion.owner_id == oid,
        ))
        if row is None:
            raise HTTPException(404, "Canvas version not found")
        return row

    @app.get("/api/projects/{pid}/canvas/versions")
    def list_versions(pid: str, limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0), oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid)
        scope = (CanvasVersion.project_id == pid, CanvasVersion.owner_id == oid)
        total = session.scalar(select(func.count()).select_from(CanvasVersion).where(*scope))
        # Query only summary columns: large graphs are fetched on selection, not on listing.
        rows = session.execute(select(*[getattr(CanvasVersion, key) for key in _metadata]).where(*scope)
                               .order_by(CanvasVersion.created_at.desc(), CanvasVersion.id.desc())
                               .limit(limit).offset(offset)).mappings().all()
        return {"items": [dict(row) for row in rows], "total": total, "limit": limit, "offset": offset}

    @app.post("/api/projects/{pid}/canvas/versions", status_code=201)
    def save_version(pid: str, body: SaveVersion, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid)
        # A no-op CAS both verifies the revision and holds the canvas write lock until
        # its snapshot is committed, even when a PUT races with manual save.
        changed = session.execute(update(Canvas).where(Canvas.project_id == pid, Canvas.revision == body.revision)
                                  .values(revision=body.revision))
        if changed.rowcount != 1:
            raise HTTPException(409, "Canvas changed; reload before saving a version")
        canvas = session.get(Canvas, pid, populate_existing=True)
        row = checkpoint(session, pid, oid, canvas.data, canvas.revision, "manual", body.name.strip())
        session.commit()
        return version_metadata(row)

    @app.get("/api/projects/{pid}/canvas/versions/{vid}")
    def get_version(pid: str, vid: str, oid=Depends(owner), session=Depends(database)):
        row = version(session, pid, vid, oid)
        return {**deepcopy(row.data), **version_metadata(row)}

    @app.post("/api/projects/{pid}/canvas/versions/{vid}/restore")
    def restore_version(pid: str, vid: str, body: RestoreVersion, oid=Depends(owner), session=Depends(database)):
        selected = version(session, pid, vid, oid)
        canvas = session.get(Canvas, pid)
        if canvas is None:
            raise HTTPException(404, "Canvas not found")
        if canvas.revision != body.revision:
            raise HTTPException(409, "Canvas changed; reload before restoring a version")
        previous = deepcopy(canvas.data)
        restored = deepcopy(selected.data)
        next_revision = body.revision + 1
        changed = session.execute(update(Canvas).where(Canvas.project_id == pid, Canvas.revision == body.revision)
                                  .values(data=restored, revision=next_revision))
        if changed.rowcount != 1:
            raise HTTPException(409, "Canvas changed; reload before restoring a version")
        checkpoint(session, pid, oid, previous, body.revision, "before_restore")
        checkpoint(session, pid, oid, restored, next_revision, "restored")
        session.commit()
        return {**restored, "revision": next_revision}
