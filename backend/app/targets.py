from copy import deepcopy
import math
import re

from fastapi import HTTPException
from sqlalchemy import select, update

from .models import Asset, Canvas, Project, Shot, Task, now, uid
from .canvas_versions import checkpoint
from .media_tools import OPERATIONS


def validate_output_node(parameters):
    """The opt-in linked-output flag belongs only to local canvas media edits."""
    if "output_node" not in parameters:
        return
    if type(parameters["output_node"]) is not bool:
        raise HTTPException(422, "output_node must be a boolean")
    operation = parameters.get("operation")
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise HTTPException(422, "output_node requires a supported local media operation")
    if parameters["output_node"]:
        if not parameters.get("node_id") or parameters.get("shot_id") or parameters.get("asset_id"):
            raise HTTPException(422, "Linked media output requires one canvas source node")
        if type(parameters.get("canvas_revision")) is not int or parameters["canvas_revision"] < 0:
            raise HTTPException(422, "Linked media output requires a saved canvas revision")


def _coordinate(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _linked_source(graph, node, parameters, kind):
    operation = parameters["operation"]
    source_kind, output_kind = OPERATIONS[operation]
    data = node.get("data", {})
    if data.get("kind") != source_kind or kind != output_kind or data.get("url") != parameters.get("source_url"):
        raise HTTPException(422, "Media operation source must match the saved canvas node")
    position = node.get("position", {})
    if not all(_coordinate(position.get(axis)) for axis in ("x", "y")):
        raise HTTPException(422, "Source node position is invalid")
    if node.get("parentId") and not any(entry.get("id") == node["parentId"] for entry in graph.get("nodes", [])):
        raise HTTPException(422, "Source node parent is missing")
    if len(graph.get("nodes", [])) >= 2000 or len(graph.get("edges", [])) >= 6000:
        raise HTTPException(422, "Canvas limit reached; no space for a linked media result")


def _linked_output(graph, source, task, url):
    parameters = task.data["parameters"]
    operation = parameters["operation"]
    existing = {item.get("id") for item in [*graph["nodes"], *graph.get("edges", [])]}
    def new_id():
        for _ in range(32):
            candidate = uid()
            if candidate not in existing:
                existing.add(candidate)
                return candidate
        raise RuntimeError("Could not allocate a unique canvas result identifier")
    source_id = source["id"]
    parent = source.get("parentId")
    outputs = [node for node in graph["nodes"] if node.get("data", {}).get("source_node_id") == source_id and node.get("parentId") == parent]
    label = str(source.get("data", {}).get("label") or "素材")
    serials = []
    for node in outputs:
        data = node.get("data", {})
        if data.get("media_operation") != operation:
            continue
        number = data.get("media_sequence")
        if type(number) is not int or number < 1:
            trailing = re.search(r"(\d+)$", str(data.get("label", "")))
            number = int(trailing.group(1)) if trailing else 0
        serials.append(number)
    serial = max(serials, default=0) + 1
    if operation == "crop_image":
        label += f" - 剪裁 {serial}"
    elif operation == "extract_frame":
        label += f"-第{parameters['at']:.2f}秒画面"
    elif operation == "trim_audio":
        label += f"_截取{serial}"
    else:
        label += f" - 视频剪裁 {serial}"
    y = source["position"]["y"]
    for node in outputs:
        output_y = node.get("position", {}).get("y")
        height = node.get("measured", {}).get("height", node.get("height", 320))
        if not _coordinate(height) or height <= 0:
            height = 320
        if _coordinate(output_y):
            y = max(y, output_y + height + 40)
    node = {"id": new_id(), "type": "media", "position": {"x": source["position"]["x"] + 480, "y": y},
            "data": {"label": label, "kind": task.kind, "text": source.get("data", {}).get("text", ""), "url": url,
                     "generation_task_id": task.id, "source_node_id": source_id, "media_operation": operation, "media_sequence": serial}}
    if parent:
        node["parentId"] = parent
    if "origin" in source:
        node["origin"] = deepcopy(source["origin"])
    graph["nodes"].append(node)
    graph.setdefault("edges", []).append({"id": new_id(), "source": source_id, "target": node["id"]})
    return node


def capture_target(session, owner_id, project_id, parameters, kind=None):
    validate_output_node(parameters)
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
        if parameters.get("output_node"):
            node = next(node for node in canvas.data["nodes"] if node.get("id") == node_id)
            _linked_source(canvas.data, node, parameters, kind)
            target["output_node"] = True
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
    output = None
    if target.get("output_node"):
        validate_output_node(task.data["parameters"])
        _linked_source(graph, node, task.data["parameters"], task.kind)
        output = _linked_output(graph, node, task, url)
    else:
        patch = {"text": result["text"]} if task.kind == "text" and result.get("text") else {"url": url}
        node["data"] = {**node.get("data", {}), **patch, "generation_task_id": task.id}
    changed = session.execute(update(Canvas).where(Canvas.project_id == task.project_id, Canvas.revision == target["expected_revision"]).values(data=graph, revision=target["expected_revision"] + 1))
    if changed.rowcount == 1:
        checkpoint(session, task.project_id, task.owner_id, graph, target["expected_revision"] + 1, "generation")
    application = {"status": "applied" if changed.rowcount == 1 else "conflict", "target_id": target["id"], "canvas_revision": target["expected_revision"] + 1 if changed.rowcount == 1 else canvas.revision}
    if output and changed.rowcount == 1:
        application.update(source_node_id=target["id"], output_node_id=output["id"])
    return application
