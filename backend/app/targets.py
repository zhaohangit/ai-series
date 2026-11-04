from copy import deepcopy

from fastapi import HTTPException
from sqlalchemy import select, update

from .models import Asset, Canvas, Project, Shot, Task, now, uid


def capture_target(session, owner_id, project_id, parameters, kind=None):
    shot_id, node_id, asset_id = parameters.get("shot_id"), parameters.get("node_id"), parameters.get("asset_id")
    if sum(bool(value) for value in (shot_id, node_id, asset_id)) > 1:
        raise HTTPException(422, "A task may target one shot, canvas node or subject")
    if not any((shot_id, node_id, asset_id)):
        return None
    if not project_id:
        raise HTTPException(422, "Targeted generation requires a project")
    if asset_id:
        asset = session.scalar(select(Asset).where(Asset.id == asset_id, Asset.owner_id == owner_id))
        if asset is None:
            raise HTTPException(404, "Target subject not found")
        project = session.scalar(select(Project).where(Project.id == project_id, Project.owner_id == owner_id))
        if project is None or asset_id not in project.data.get("settings", {}).get("asset_ids", []):
            raise HTTPException(422, "Target subject is not linked to this project")
        if parameters.get("asset_updated_at") and parameters["asset_updated_at"] != asset.updated_at:
            raise HTTPException(409, "Subject changed; reload before generating")
        slot = "main" if kind == "audio" else parameters.get("gallery_slot", "main")
        if slot != "main" and not any(item.get("id") == slot for item in asset.data.get("metadata", {}).get("gallery", [])):
            raise HTTPException(422, "Unknown gallery slot")
        target = {"kind": "asset", "id": asset.id, "expected_updated_at": asset.updated_at, "gallery_slot": slot}
    elif shot_id:
        shot = session.scalar(select(Shot).where(Shot.id == shot_id, Shot.owner_id == owner_id))
        if shot is None:
            raise HTTPException(404, "Target shot not found")
        if shot.project_id != project_id:
            raise HTTPException(422, "Target shot belongs to another project")
        if parameters.get("shot_updated_at") and parameters["shot_updated_at"] != shot.updated_at:
            raise HTTPException(409, "Shot changed; reload before generating")
        target = {"kind": "shot", "id": shot.id, "expected_updated_at": shot.updated_at}
    else:
        canvas = session.get(Canvas, project_id)
        if canvas is None or not any(node.get("id") == node_id for node in canvas.data.get("nodes", [])):
            raise HTTPException(422, "Save the target canvas node before submitting generation")
        if parameters.get("canvas_revision") is not None and parameters["canvas_revision"] != canvas.revision:
            raise HTTPException(409, "Canvas changed; reload before generating")
        target = {"kind": "canvas", "id": node_id, "expected_revision": canvas.revision, "project_id": project_id}
    active_query = select(Task).where(Task.owner_id == owner_id, Task.status.in_(["queued", "running"]))
    if not asset_id:
        active_query = active_query.where(Task.project_id == project_id)
    active = session.scalars(active_query).all()
    for task in active:
        existing = task.data.get("target") or {}
        if existing.get("kind") == target["kind"] and existing.get("id") == target["id"]:
            raise HTTPException(409, "Target already has an active generation task")
    return target


def apply_target(session, task, result):
    target = task.data.get("target")
    if not target:
        return None
    url = result.get("url") or result.get(task.kind + "_url")
    if task.kind != "text" and not url:
        return {"status": "result_only", "reason": "No media URL in provider result", "target_id": target["id"]}
    if target["kind"] == "asset":
        asset = session.scalar(select(Asset).where(Asset.id == target["id"], Asset.owner_id == task.owner_id))
        project = session.get(Project, task.project_id)
        if asset is None or project is None or asset.id not in project.data.get("settings", {}).get("asset_ids", []):
            return {"status": "target_missing", "target_id": target["id"]}
        if task.kind not in ("image", "audio"):
            return {"status": "result_only", "target_id": asset.id}
        data = deepcopy(asset.data)
        metadata = data.setdefault("metadata", {})
        slot = target.get("gallery_slot", "main")
        if task.kind == "image":
            if slot == "main":
                data["url"] = url
            else:
                cell = next((entry for entry in metadata.get("gallery", []) if entry.get("id") == slot), None)
                if cell is None:
                    return {"status": "conflict", "target_id": asset.id}
                cell["url"] = url
        else:
            metadata["voice"] = {**metadata.get("voice", {}), "url": url}
        metadata["versions"] = [*metadata.get("versions", []), {"id": uid(), "name": "生成结果", "url": url, "kind": task.kind, "slot": slot, "created_at": now(), "task_id": task.id}]
        changed = session.execute(update(Asset).where(Asset.id == asset.id, Asset.owner_id == task.owner_id, Asset.updated_at == target["expected_updated_at"]).values(data=data, updated_at=now()))
        return {"status": "applied" if changed.rowcount == 1 else "conflict", "target_id": asset.id}
    if target["kind"] == "shot":
        if task.kind == "text":
            return {"status": "result_only", "target_id": target["id"]}
        shot = session.scalar(select(Shot).where(Shot.id == target["id"], Shot.owner_id == task.owner_id, Shot.project_id == task.project_id))
        if shot is None:
            return {"status": "target_missing", "target_id": target["id"]}
        changed = session.execute(update(Shot).where(Shot.id == shot.id, Shot.owner_id == task.owner_id, Shot.updated_at == target["expected_updated_at"]).values(data={**shot.data, task.kind + "_url": url}, updated_at=now()))
        return {"status": "applied" if changed.rowcount == 1 else "conflict", "target_id": shot.id, "reason": "Result remains in task history"}
    canvas = session.get(Canvas, task.project_id)
    if canvas is None:
        return {"status": "target_missing", "target_id": target["id"]}
    if canvas.revision != target["expected_revision"]:
        return {"status": "conflict", "target_id": target["id"], "reason": "Canvas changed; result remains in task history"}
    graph = deepcopy(canvas.data)
    node = next((node for node in graph["nodes"] if node.get("id") == target["id"]), None)
    if node is None:
        return {"status": "target_missing", "target_id": target["id"]}
    patch = {"text": result["text"]} if task.kind == "text" and result.get("text") else {"url": url}
    node["data"] = {**node.get("data", {}), **patch, "generation_task_id": task.id}
    changed = session.execute(update(Canvas).where(Canvas.project_id == task.project_id, Canvas.revision == target["expected_revision"]).values(data=graph, revision=target["expected_revision"] + 1))
    return {"status": "applied" if changed.rowcount == 1 else "conflict", "target_id": target["id"], "canvas_revision": target["expected_revision"] + 1 if changed.rowcount == 1 else canvas.revision}
