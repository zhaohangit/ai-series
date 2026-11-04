import { chromium } from "/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Local-only acceptance test. No reference-site, Docker or cleanup operations.
const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:5175";
assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const output = path.resolve(process.env.SMOKE_OUTPUT_DIR || "artifacts/verification/canvas-media");
const fixtures = path.join(output, "fixtures");
await fs.mkdir(fixtures, { recursive: true });
const previousFixtures = path.resolve("artifacts/verification/media-history/fixtures");
const bundled = "/Users/zhaohan25/.cache/uv/archive-v0/jaXy6RpqXya1AqhW/lib/python3.14/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v9.0";
const ffmpeg = process.env.FFMPEG_BIN || (existsSync(bundled) ? bundled : "ffmpeg");
const definitions = [
  ["source.png", ["-f", "lavfi", "-i", "color=c=red:s=64x48,drawbox=x=32:y=0:w=32:h=48:color=blue:t=fill", "-frames:v", "1"]],
  ["source.mp4", ["-f", "lavfi", "-i", "testsrc2=s=64x48:r=10:d=2", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]],
  ["source.wav", ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"]],
];
for (const [name, args] of definitions) {
  const destination = path.join(fixtures, name);
  if (existsSync(path.join(previousFixtures, name))) await fs.copyFile(path.join(previousFixtures, name), destination);
  else execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, destination], { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(25000);
const checks = [], errors = [], proof = [];
let delayedProof, releaseHeldTask = () => {};
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.type() === "confirm" ? dialog.accept() : dialog.dismiss());
async function request(method, route, data) {
  const response = await context.request.fetch(base + "/api" + route, { method, data });
  assert(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function until(check, description, attempts = 160) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
const screenshot = (name) => page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
async function upload(name, mimeType) {
  const bytes = await fs.readFile(path.join(fixtures, name));
  const response = await context.request.post(base + "/api/uploads", { multipart: { file: { name, mimeType, buffer: bytes } } });
  assert.equal(response.status(), 201, await response.text());
  return { ...(await response.json()), hash: digest(bytes) };
}
async function bytes(url) {
  const response = await context.request.get(base + url);
  assert(response.ok());
  return response.body();
}
async function setupCanvas(label, kind, source, nested = true) {
  const project = await request("POST", "/projects", { name: label + " " + Date.now(), kind: "canvas" });
  const node = { id: "media-source", type: "media", position: { x: 20, y: 30 }, data: { label, kind, text: "保留原始提示词", url: source.url } };
  const nodes = [];
  if (nested) {
    nodes.push({ id: "media-parent", type: "group", position: { x: 80, y: 70 }, data: {}, style: { width: 1100, height: 650 } });
    node.parentId = "media-parent";
  }
  nodes.push(node);
  await request("PUT", `/projects/${project.id}/canvas`, { nodes, edges: [], viewport: { x: 20, y: 30, zoom: .85 }, revision: 0 });
  await page.goto(base + "/canvas/" + project.id);
  await page.getByRole("button", { name: "编辑媒体 " + label, exact: true }).waitFor();
  return { projectId: project.id, node, label, source };
}
async function openPanel(canvas, mode, fields) {
  await page.getByRole("button", { name: "编辑媒体 " + canvas.label, exact: true }).click();
  const panel = page.getByRole("dialog", { name: "媒体编辑", exact: true });
  await panel.locator(".media-source-info").first().waitFor();
  await panel.getByRole("button", { name: mode, exact: true }).click();
  for (const [label, value] of Object.entries(fields)) await panel.getByRole("spinbutton", { name: label, exact: true }).fill(String(value));
  return panel;
}
async function submit(panel) {
  const responsePromise = page.waitForResponse((response) => response.url() === base + "/api/tasks" && response.request().method() === "POST");
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 202, await response.text());
  return { accepted: await response.json(), body: response.request().postDataJSON() };
}
async function completed(taskId) {
  return until(async () => {
    const task = await request("GET", "/tasks/" + taskId);
    assert.notEqual(task.status, "failed", JSON.stringify(task));
    return task.status === "succeeded" ? task : null;
  }, "worker task completion", 300);
}
async function operation(config, source) {
  const canvas = await setupCanvas(config.operation, config.sourceKind, source);
  const panel = await openPanel(canvas, config.mode, config.fields);
  await screenshot(config.operation + "-before");
  const { accepted, body } = await submit(panel);
  assert.equal(body.parameters.output_node, true);
  assert.equal(body.parameters.node_id, canvas.node.id);
  assert.equal(body.parameters.source_url, source.url);
  assert.equal(body.parameters.operation, config.operation);
  const before = await request("GET", `/projects/${canvas.projectId}/canvas`);
  const task = await completed(accepted.id);
  await panel.getByText("处理完成，已应用到画布的新节点。", { exact: true }).waitFor();
  const graph = await request("GET", `/projects/${canvas.projectId}/canvas`);
  const sourceNode = graph.nodes.find((node) => node.id === canvas.node.id);
  assert.deepEqual(sourceNode.data, canvas.node.data);
  assert.deepEqual(sourceNode.position, canvas.node.position);
  assert.equal(sourceNode.parentId, canvas.node.parentId);
  assert.equal(task.result.application.status, "applied");
  const result = graph.nodes.find((node) => node.id === task.result.application.output_node_id);
  assert(result && result.id !== sourceNode.id);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 1);
  assert.equal(result.data.kind, config.resultKind);
  assert.equal(result.data.url, task.result.url);
  assert.equal(result.parentId, sourceNode.parentId);
  assert.deepEqual(result.position, { x: sourceNode.position.x + 480, y: sourceNode.position.y });
  assert.deepEqual([graph.edges[0].source, graph.edges[0].target], [sourceNode.id, result.id]);
  assert.equal(new Set([sourceNode.id, result.id, graph.edges[0].id, "media-parent"]).size, 4);
  assert(graph.revision >= body.parameters.canvas_revision + 1);
  const metadata = await request("GET", "/media/inspect?source_url=" + encodeURIComponent(task.result.url));
  assert.equal(metadata.kind, config.resultKind);
  assert.deepEqual([metadata.width, metadata.height], config.dimensions);
  if (config.duration === null) assert.equal(metadata.duration, null);
  else assert(Math.abs(metadata.duration - config.duration) <= .1);
  assert.equal(digest(await bytes(source.url)), source.hash);
  const originalTask = await request("POST", "/tasks", body);
  assert.equal(originalTask.id, task.id);
  assert.equal((await request("GET", "/tasks?project_id=" + canvas.projectId)).total, 1);
  const versions = await request("GET", `/projects/${canvas.projectId}/canvas/versions`);
  assert(versions.items.some((version) => version.node_count === 3 && version.edge_count === 1));
  await panel.locator("footer").getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${result.id}"]`).waitFor();
  await screenshot(config.operation + "-linked-output");
  await page.reload();
  await page.locator(`.react-flow__node[data-id="${result.id}"]`).waitFor();
  const reloaded = await request("GET", `/projects/${canvas.projectId}/canvas`);
  assert.deepEqual(reloaded.nodes.find((node) => node.id === sourceNode.id).data, canvas.node.data);
  assert.equal(reloaded.nodes.find((node) => node.id === result.id).data.url, task.result.url);
  checks.push(config.operation + "-ui-new-linked-node-source-and-parent-preserved-reload");
  proof.push({ operation: config.operation, projectId: canvas.projectId, taskId: task.id, outputNodeId: result.id, outputKind: result.data.kind, metadata, responseRevision: graph.revision, graphObservedBeforeCompletion: before.revision });
}

try {
  await request("GET", "/session");
  assert.equal((await request("GET", "/projects")).total, 0, "Fresh browser account required");
  const credits = await request("GET", "/credits");
  const image = await upload("source.png", "image/png");
  const video = await upload("source.mp4", "video/mp4");
  const audio = await upload("source.wav", "audio/wav");
  const operations = [
    { operation: "crop_image", sourceKind: "image", resultKind: "image", mode: "剪裁图片", fields: { "裁剪X": 32, "裁剪Y": 0, "裁剪宽度": 32, "裁剪高度": 48 }, dimensions: [32, 48], duration: null, source: image },
    { operation: "trim_video", sourceKind: "video", resultKind: "video", mode: "裁剪时长", fields: { "开始时间": .5, "结束时间": 1.5 }, dimensions: [64, 48], duration: 1, source: video },
    { operation: "crop_video", sourceKind: "video", resultKind: "video", mode: "裁剪画面", fields: { "裁剪X": 2, "裁剪Y": 2, "裁剪宽度": 32, "裁剪高度": 24, "开始时间": .5, "结束时间": 1.5 }, dimensions: [32, 24], duration: 1, source: video },
    { operation: "extract_frame", sourceKind: "video", resultKind: "image", mode: "视频截帧", fields: { "截帧时间": .5 }, dimensions: [64, 48], duration: null, source: video },
    { operation: "trim_audio", sourceKind: "audio", resultKind: "audio", mode: "裁剪音频", fields: { "开始时间": .25, "结束时间": 1 }, dimensions: [null, null], duration: .75, source: audio },
  ];
  for (const config of operations) await operation(config, config.source);
  assert.deepEqual(await request("GET", "/credits"), credits);
  checks.push("five-canvas-media-operations-no-credits-or-ledger-change");

  const closedCanvas = await setupCanvas("关闭后接收结果", "image", image, false);
  let closedHeld = false, closedReleased = false;
  const closedGate = new Promise((resolve) => { releaseHeldTask = resolve; });
  const closedHandler = async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.status === "succeeded" && body.project_id === closedCanvas.projectId) {
      closedHeld = true;
      await closedGate;
      closedReleased = true;
    }
    await route.fulfill({ response }).catch(() => {});
  };
  await page.route("**/api/tasks/*", closedHandler);
  const closingPanel = await openPanel(closedCanvas, "剪裁图片", { "裁剪X": 32, "裁剪Y": 0, "裁剪宽度": 32, "裁剪高度": 48 });
  const closedSubmission = await submit(closingPanel);
  const closedTask = await completed(closedSubmission.accepted.id);
  await until(() => closedHeld, "delaying completion before closing clean canvas panel");
  await closingPanel.locator("footer").getByRole("button", { name: "关闭", exact: true }).click();
  releaseHeldTask();
  await until(() => closedReleased, "release completed task after clean panel close");
  const closedOutputId = closedTask.result.application.output_node_id;
  await page.locator(`.react-flow__node[data-id="${closedOutputId}"]`).waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 2);
  await page.unroute("**/api/tasks/*", closedHandler);
  const afterCloseText = "关闭媒体面板后依然可以保存的新编辑";
  await page.locator('.react-flow__node[data-id="media-source"] .node-prompt').fill(afterCloseText);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await until(async () => (await request("GET", `/projects/${closedCanvas.projectId}/canvas`)).nodes.find((node) => node.id === "media-source").data.text === afterCloseText, "saving edits after background completion without revision conflict");
  assert.equal(await page.getByText("保存失败", { exact: true }).count(), 0);
  await screenshot("closed-panel-background-result-and-subsequent-save");
  proof.push({ operation: "closed-panel-completion", projectId: closedCanvas.projectId, taskId: closedTask.id, outputNodeId: closedOutputId, subsequentEditPersisted: true });
  checks.push("closed-pending-panel-auto-reloads-linked-output-and-next-edit-saves");

  const canvas = await setupCanvas("延迟返回保护", "image", image, false);
  let held = false, responseReleased = false;
  const gate = new Promise((resolve) => { releaseHeldTask = resolve; });
  const handler = async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.status === "succeeded" && body.project_id === canvas.projectId) {
      held = true;
      await gate;
      responseReleased = true;
    }
    await route.fulfill({ response }).catch(() => {});
  };
  await page.route("**/api/tasks/*", handler);
  const panel = await openPanel(canvas, "剪裁图片", { "裁剪X": 32, "裁剪Y": 0, "裁剪宽度": 32, "裁剪高度": 48 });
  const submission = await submit(panel);
  const task = await completed(submission.accepted.id);
  await until(() => held, "holding real successful task response");
  await panel.locator("footer").getByRole("button", { name: "关闭", exact: true }).click();
  const sourcePrompt = page.locator('.react-flow__node[data-id="media-source"] .node-prompt');
  const newerDraft = "任务完成后仍需保留的本地新编辑";
  await sourcePrompt.fill(newerDraft);
  releaseHeldTask();
  await until(() => responseReleased, "release delayed task response");
  // Wait until the real autosave rejects the stale revision; no synthetic API
  // success or persisted graph is substituted in this race test.
  await page.getByText("保存失败", { exact: true }).waitFor();
  assert.equal(await sourcePrompt.inputValue(), newerDraft);
  assert.equal(await page.locator(".react-flow__node").count(), 1);
  const serverGraph = await request("GET", `/projects/${canvas.projectId}/canvas`);
  assert.equal(serverGraph.nodes.length, 2);
  assert.equal(serverGraph.nodes[0].data.text, canvas.node.data.text);
  assert(serverGraph.nodes.some((node) => node.data.url === task.result.url));
  assert.equal((await request("GET", "/tasks/" + task.id)).status, "succeeded");
  await screenshot("delayed-response-local-draft-retained");
  await page.unroute("**/api/tasks/*", handler);
  await page.getByRole("button", { name: "生成记录", exact: true }).click();
  const history = page.getByRole("dialog", { name: "画布生成记录", exact: true });
  const download = history.getByRole("link", { name: "下载结果", exact: true });
  await download.waitFor();
  assert.equal(await download.getAttribute("href"), task.result.url);
  assert.equal(await history.getByRole("link", { name: "预览结果", exact: true }).getAttribute("href"), task.result.url);
  await screenshot("delayed-response-result-in-history");
  delayedProof = { projectId: canvas.projectId, taskId: task.id, localDraftRetained: true, serverOutputRetained: true, originalSourceRetained: true };
  checks.push("delayed-task-response-does-not-overwrite-new-local-draft-and-output-remains-in-history");
  assert.deepEqual(await request("GET", "/credits"), credits);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, "browser-smoke.json"), JSON.stringify({ passed: true, checks, errors, operations: proof, delayedProof }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, errors, output }));
} catch (error) {
  releaseHeldTask();
  await screenshot("failure").catch(() => {});
  await fs.writeFile(path.join(output, "browser-smoke.json"), JSON.stringify({ passed: false, checks, errors, operations: proof, delayedProof, error: String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  releaseHeldTask();
  await browser.close();
}
