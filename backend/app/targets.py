from copy import deepcopy

from fastapi import HTTPException
from sqlalchemy import select, update

from .models import Canvas, Shot, Task, now


def capture_target(session, owner_id, project_id, parameters):
    shot_id, node_id = parameters.get("shot_id"), parameters.get("node_id")
    if shot_id and node_id:
        raise HTTPException(422, "A task may target either a shot or a canvas node")
    if not shot_id and not node_id:
        return None
    if not project_id:
        raise HTTPException(422, "Targeted generation requires a project")
    if shot_id:
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
    active = session.scalars(select(Task).where(Task.owner_id == owner_id, Task.project_id == project_id, Task.status.in_(["queued", "running"]))).all()
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
