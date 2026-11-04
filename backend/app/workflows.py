"""Project-linked subjects and atomic storyboard operations."""
from fastapi import Depends, HTTPException, Response
from pydantic import Field
from sqlalchemy import select

from .models import Asset, Episode, Project, Shot, now
from .schemas import AssetInput, ShotInput, StrictModel


class AssetImport(StrictModel):
    asset_ids: list[str] = Field(min_length=1, max_length=500)


class ShotBatch(StrictModel):
    shots: list[ShotInput] = Field(min_length=1, max_length=100)


class ShotOrder(StrictModel):
    ids: list[str] = Field(max_length=10000)


def register_workflows(app, owner, database, owned, serialize):
    def listed(rows):
        return {"items": [serialize(row) for row in rows], "total": len(rows)}

    def linked_ids(project):
        return project.data.get("settings", {}).get("asset_ids", [])

    def link(project, ids):
        settings = {**project.data.get("settings", {}), "asset_ids": list(dict.fromkeys(ids))}
        project.data = {**project.data, "settings": settings}
        project.updated_at = now()

    @app.get("/api/assets/{aid}")
    def get_asset(aid: str, oid=Depends(owner), session=Depends(database)):
        return serialize(owned(session, Asset, aid, oid))

    @app.get("/api/projects/{pid}/subjects")
    def subjects(pid: str, oid=Depends(owner), session=Depends(database)):
        project = owned(session, Project, pid, oid)
        ids = linked_ids(project)
        rows = session.scalars(select(Asset).where(Asset.owner_id == oid, Asset.id.in_(ids))).all()
        by_id = {row.id: row for row in rows}
        return listed([by_id[aid] for aid in dict.fromkeys(ids) if aid in by_id])

    @app.post("/api/projects/{pid}/subjects", status_code=201)
    def create_subject(pid: str, body: AssetInput, oid=Depends(owner), session=Depends(database)):
        project = owned(session, Project, pid, oid, lock=True)
        if body.kind not in ("character", "scene", "prop"):
            raise HTTPException(422, "Project subjects must be characters, scenes or props")
        row = Asset(owner_id=oid, data=body.model_dump())
        session.add(row)
        session.flush()
        link(project, [*linked_ids(project), row.id])
        session.commit()
        return serialize(row)

    @app.post("/api/projects/{pid}/subjects/import")
    def import_subjects(pid: str, body: AssetImport, oid=Depends(owner), session=Depends(database)):
        project = owned(session, Project, pid, oid, lock=True)
        rows = [owned(session, Asset, aid, oid) for aid in dict.fromkeys(body.asset_ids)]
        if any(row.data.get("kind") not in ("character", "scene", "prop") for row in rows):
            raise HTTPException(422, "Only character, scene and prop assets can be imported")
        link(project, [*linked_ids(project), *[row.id for row in rows]])
        session.commit()
        return listed(rows)

    @app.delete("/api/projects/{pid}/subjects/{aid}", status_code=204)
    def detach_subject(pid: str, aid: str, oid=Depends(owner), session=Depends(database)):
        project = owned(session, Project, pid, oid, lock=True)
        owned(session, Asset, aid, oid)
        if aid not in linked_ids(project):
            raise HTTPException(404, "Subject is not linked to this project")
        link(project, [value for value in linked_ids(project) if value != aid])
        session.commit()
        return Response(status_code=204)

    @app.post("/api/projects/{pid}/shots/batch", status_code=201)
    def add_shots(pid: str, body: ShotBatch, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid, lock=True)
        # Validate the complete batch before adding any database rows.
        for item in body.shots:
            if item.episode_id:
                episode = owned(session, Episode, item.episode_id, oid)
                if episode.project_id != pid:
                    raise HTTPException(422, "Episode belongs to another project")
        rows = []
        for item in body.shots:
            data = item.model_dump()
            row = Shot(owner_id=oid, project_id=pid, episode_id=data.pop("episode_id"), data=data)
            rows.append(row)
            session.add(row)
        session.commit()
        return listed(rows)

    @app.put("/api/projects/{pid}/shots/order")
    def order_shots(pid: str, body: ShotOrder, oid=Depends(owner), session=Depends(database)):
        owned(session, Project, pid, oid, lock=True)
        if len(set(body.ids)) != len(body.ids):
            raise HTTPException(422, "Shot IDs must be unique")
        rows = session.scalars(select(Shot).where(Shot.project_id == pid, Shot.owner_id == oid).order_by(Shot.id).with_for_update()).all()
        by_id = {row.id: row for row in rows}
        if set(body.ids) != set(by_id):
            raise HTTPException(409, "Shot list changed; reload the full project before ordering")
        for position, sid in enumerate(body.ids):
            row = by_id[sid]
            row.data = {**row.data, "position": position}
            row.updated_at = now()
        session.commit()
        return listed([by_id[sid] for sid in body.ids])
