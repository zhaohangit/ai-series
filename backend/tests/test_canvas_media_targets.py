"""Local canvas media edits create linked outputs without replacing source content."""
from copy import deepcopy
import uuid

import pytest
from fastapi.testclient import TestClient

from test_api import client, project
from test_media_tools import ffmpeg, image_source, video_source, render, upload


def make_canvas(client, source, kind="image", nested=False):
    pid = project(client, kind="canvas")["id"]
    node = {"id": "source", "type": "media", "position": {"x": 20, "y": 30}, "data": {"kind": kind, "label": "原素材", "text": "保留提示词", "url": source}}
    nodes = []
    if nested:
        nodes.append({"id": "parent", "type": "group", "position": {"x": 400, "y": 300}, "data": {}, "style": {"width": 1200, "height": 800}})
        node["parentId"] = "parent"
    nodes.append(node)
    graph = {"nodes": nodes, "edges": [], "viewport": {"x": 10, "y": 20, "zoom": .8}, "revision": 0}
    response = client.put(f"/api/projects/{pid}/canvas", json=graph)
    assert response.status_code == 200, response.text
    return pid, response.json(), node


def request_body(pid, source, revision=1, operation="crop_image", kind="image", **changes):
    parameters = {"operation": operation, "source_url": source, "node_id": "source", "canvas_revision": revision, "output_node": True, "x": 0, "y": 0, "width": 32, "height": 24, **changes}
    return {"kind": kind, "project_id": pid, "parameters": parameters, "idempotency_key": uuid.uuid4().hex}


def finish(client, body):
    response = client.post("/api/tasks", json=body)
    assert response.status_code == 202, response.text
    task = client.get("/api/tasks/" + response.json()["id"]).json()
    assert task["status"] == "succeeded", task
    return task


def test_crop_creates_distinct_parent_relative_node_edge_snapshot_and_preserves_source(client, ffmpeg, tmp_path):
    _, source = image_source(client, ffmpeg, tmp_path)
    pid, original, node = make_canvas(client, source, nested=True)
    credits = client.get("/api/credits").json()
    body = request_body(pid, source)
    task = finish(client, body)
    graph = client.get(f"/api/projects/{pid}/canvas").json()
    assert graph["revision"] == 2
    assert graph["viewport"] == original["viewport"]
    assert next(n for n in graph["nodes"] if n["id"] == "source") == node
    output = next(n for n in graph["nodes"] if n["id"] not in {"source", "parent"})
    assert output["parentId"] == "parent"
    assert output["position"] == {"x": 500, "y": 30}
    assert output["data"]["kind"] == "image" and output["data"]["url"] == task["result"]["url"] != source
    assert output["data"]["label"] == "原素材 - 剪裁 1"
    assert output["data"]["text"] == "保留提示词"
    assert len(graph["edges"]) == 1
    edge = graph["edges"][0]
    assert edge["source"] == "source" and edge["target"] == output["id"]
    assert len({edge["id"], output["id"], "source", "parent"}) == 4
    assert task["result"]["application"]["output_node_id"] == output["id"]
    assert task["result"]["application"]["source_node_id"] == "source"
    versions = client.get(f"/api/projects/{pid}/canvas/versions").json()["items"]
    assert len(versions) == 2 and versions[0]["node_count"] == 3
    assert client.get("/api/credits").json() == credits
    assert client.post("/api/tasks", json=body).json()["id"] == task["id"]
    assert client.get(f"/api/projects/{pid}/canvas").json() == graph


def test_repeated_crops_stack_as_numbered_siblings(client, ffmpeg, tmp_path):
    _, source = image_source(client, ffmpeg, tmp_path)
    pid, _, node = make_canvas(client, source)
    finish(client, request_body(pid, source))
    finish(client, request_body(pid, source, revision=2))
    graph = client.get(f"/api/projects/{pid}/canvas").json()
    first, second = graph["nodes"][1:]
    assert first["data"]["label"] == "原素材 - 剪裁 1"
    assert second["data"]["label"] == "原素材 - 剪裁 2"
    assert second["position"]["x"] == first["position"]["x"]
    assert second["position"]["y"] > first["position"]["y"]
    assert len(graph["edges"]) == 2 and graph["nodes"][0] == node


def test_output_labels_do_not_reuse_surviving_serial_after_earlier_result_deleted(client, ffmpeg, tmp_path):
    _, source = image_source(client, ffmpeg, tmp_path)
    pid, _, _ = make_canvas(client, source)
    finish(client, request_body(pid, source))
    finish(client, request_body(pid, source, revision=2))
    graph = client.get(f"/api/projects/{pid}/canvas").json()
    deleted = graph["nodes"][1]["id"]
    graph["nodes"] = [node for node in graph["nodes"] if node["id"] != deleted]
    graph["edges"] = [edge for edge in graph["edges"] if edge["target"] != deleted]
    assert client.put(f"/api/projects/{pid}/canvas", json=graph).json()["revision"] == 4
    finish(client, request_body(pid, source, revision=4))
    result = client.get(f"/api/projects/{pid}/canvas").json()
    assert result["nodes"][-1]["data"]["label"] == "原素材 - 剪裁 3"


@pytest.mark.parametrize("kind,operation,fields", [("video", "crop_video", {}), ("video", "trim_video", {"start": .2, "end": 1.2}), ("audio", "trim_audio", {"start": .2, "end": 1.2})])
def test_video_and_audio_edits_create_typed_outputs_without_changing_source(client, ffmpeg, tmp_path, kind, operation, fields):
    if kind == "audio":
        data = render(ffmpeg, tmp_path / "voice.wav", "-f", "lavfi", "-i", "sine=frequency=440:duration=2")
        _, source = upload(client, data, "voice.wav", "audio/wav")
    else:
        _, source = video_source(client, ffmpeg, tmp_path)
    pid, _, node = make_canvas(client, source, kind=kind)
    task = finish(client, request_body(pid, source, kind=kind, operation=operation, **fields))
    graph = client.get(f"/api/projects/{pid}/canvas").json()
    assert graph["nodes"][0] == node
    assert graph["nodes"][1]["data"]["kind"] == kind
    assert graph["nodes"][1]["data"]["url"] == task["result"]["url"]
    if kind == "audio":
        assert graph["nodes"][1]["data"]["label"] == "原素材_截取1"


def test_generated_node_and_edge_identifiers_skip_existing_ids(client, ffmpeg, tmp_path, monkeypatch):
    import app.targets as targets
    _, source = image_source(client, ffmpeg, tmp_path)
    pid, _, _ = make_canvas(client, source)
    ids = iter(["source", "new-node", "new-node", "new-edge"])
    monkeypatch.setattr(targets, "uid", lambda: next(ids))
    finish(client, request_body(pid, source))
    graph = client.get(f"/api/projects/{pid}/canvas").json()
    assert graph["nodes"][-1]["id"] == "new-node"
    assert graph["edges"][-1]["id"] == "new-edge"


def test_extract_frame_adds_image_child_and_preserves_video_node(client, ffmpeg, tmp_path):
    _, source = video_source(client, ffmpeg, tmp_path)
    pid, _, node = make_canvas(client, source, kind="video")
    task = finish(client, request_body(pid, source, operation="extract_frame", at=.5))
    graph = client.get(f"/api/projects/{pid}/canvas").json()
    assert graph["nodes"][0] == node
    assert graph["nodes"][1]["data"]["kind"] == "image"
    assert graph["nodes"][1]["data"]["label"] == "原素材-第0.50秒画面"
    assert client.get(task["result"]["url"]).content.startswith(b"\x89PNG")


def test_changed_graph_retains_output_in_history_without_new_node_or_snapshot(client, ffmpeg, tmp_path, monkeypatch):
    import app.main as main
    actual_execute = main.execute_task
    monkeypatch.setattr(main, "execute_task", lambda *_: None)
    _, source = image_source(client, ffmpeg, tmp_path)
    pid, original, _ = make_canvas(client, source)
    submitted = client.post("/api/tasks", json=request_body(pid, source)).json()
    edited = deepcopy(original)
    edited["nodes"][0]["data"]["text"] = "新编辑"
    saved = client.put(f"/api/projects/{pid}/canvas", json=edited).json()
    before = client.get(f"/api/projects/{pid}/canvas/versions").json()["total"]
    actual_execute(client.app, submitted["id"])
    task = client.get("/api/tasks/" + submitted["id"]).json()
    assert task["status"] == "succeeded"
    assert task["result"]["application"]["status"] == "conflict"
    assert client.get(f"/api/projects/{pid}/canvas").json() == saved
    assert client.get(f"/api/projects/{pid}/canvas/versions").json()["total"] == before
    assert client.get(task["result"]["url"]).status_code == 200


@pytest.mark.parametrize("flag", [0, 1, "true", None, [], {}])
def test_output_node_requires_actual_boolean(client, ffmpeg, tmp_path, flag):
    _, source = image_source(client, ffmpeg, tmp_path)
    pid, original, _ = make_canvas(client, source)
    response = client.post("/api/tasks", json=request_body(pid, source, output_node=flag))
    assert response.status_code == 422, response.text
    assert client.get(f"/api/projects/{pid}/canvas").json() == original
    assert client.get("/api/tasks").json()["total"] == 0


def test_output_node_requires_owned_matching_source_saved_revision_and_operation(client, ffmpeg, tmp_path):
    _, source = image_source(client, ffmpeg, tmp_path)
    pid, original, _ = make_canvas(client, source)
    _, different = image_source(client, ffmpeg, tmp_path)
    for changes in [{"node_id": None}, {"node_id": "missing"}, {"source_url": different}, {"canvas_revision": None}, {"canvas_revision": True}]:
        response = client.post("/api/tasks", json=request_body(pid, source, **changes))
        assert response.status_code == 422, response.text
    assert client.post("/api/tasks", json=request_body(pid, source, revision=0)).status_code == 409
    # Force provider availability so the target validation, not provider setup,
    # rejects a generator request that attempts to opt into linked-media mode.
    client.app.state.provider.available = lambda kind: True
    body = request_body(pid, source)
    del body["parameters"]["operation"]
    assert client.post("/api/tasks", json=body).status_code == 422
    with TestClient(client.app) as other:
        assert other.post("/api/tasks", json=request_body(pid, source)).status_code == 404
    assert client.get(f"/api/projects/{pid}/canvas").json() == original
    assert client.get("/api/tasks").json()["total"] == 0
