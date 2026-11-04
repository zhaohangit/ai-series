import { chromium } from '/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5175';
const output = path.resolve(process.env.SMOKE_OUTPUT_DIR || 'artifacts/verification/media-history');
const bundledFFmpeg = '/Users/zhaohan25/.cache/uv/archive-v0/jaXy6RpqXya1AqhW/lib/python3.14/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v9.0';
const ffmpeg = process.env.FFMPEG_BIN || (existsSync(bundledFFmpeg) ? bundledFFmpeg : 'ffmpeg');
await fs.mkdir(path.join(output, 'fixtures'), { recursive: true });
const fixture = name => path.join(output, 'fixtures', name);
const digest = data => createHash('sha256').update(data).digest('hex');
const render = (file, args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file], { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
render(fixture('source.png'), ['-f', 'lavfi', '-i', 'color=c=red:s=64x48,drawbox=x=32:y=0:w=32:h=48:color=blue:t=fill', '-frames:v', '1']);
render(fixture('source.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
render(fixture('source.wav'), ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2']);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const checks = [], errors = [], taskProof = [];
let projectId, canvasId;
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', async dialog => { if (dialog.type() === 'confirm') await dialog.accept(); else await dialog.dismiss(); });
async function request(method, route, data) {
  const response = await context.request.fetch(base + '/api' + route, { method, data });
  assert(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function until(check, description, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await check();
    if (result) return result;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function screenshot(name) { await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true }); }
async function uploaded(file, mimeType) {
  const bytes = await fs.readFile(file);
  const response = await context.request.post(base + '/api/uploads', { multipart: { file: { name: path.basename(file), mimeType, buffer: bytes } } });
  assert.equal(response.status(), 201, await response.text());
  return { ...(await response.json()), bytes, hash: digest(bytes) };
}
async function mediaBytes(url) {
  const response = await context.request.get(base + url);
  assert(response.ok(), `Owned media ${response.status()}`);
  return response.body();
}
async function inspect(url) { return request('GET', '/media/inspect?source_url=' + encodeURIComponent(url)); }
async function runOperation({ operation, kind, source, mode, fields, dimensions, duration }) {
  const shot = await request('POST', `/projects/${projectId}/shots`, { name: operation, [kind + '_url']: source.url, duration: 2 });
  await page.goto(base + `/edit/${projectId}/scene/${shot.id}`);
  await page.getByPlaceholder('描述你想要的画面、角色、动作、氛围…', { exact: true }).waitFor();
  if (kind !== 'image') await page.locator('.studio-tabs').getByRole('button', { name: kind === 'video' ? '视频' : '音频', exact: true }).click();
  await page.getByRole('button', { name: '媒体编辑', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '媒体编辑', exact: true });
  await panel.getByText('本地处理 · 不消耗积分', { exact: true }).waitFor();
  await panel.getByRole('button', { name: mode, exact: true }).click();
  await panel.locator('.media-source-info').first().waitFor();
  for (const [label, value] of Object.entries(fields)) {
    // Empty a frame-time input explicitly: this must not assign NaN to currentTime.
    if (label === '截帧时间') await panel.getByRole('spinbutton', { name: label, exact: true }).fill('');
    await panel.getByRole('spinbutton', { name: label, exact: true }).fill(String(value));
  }
  await screenshot(operation + '-before');
  const submitting = page.waitForResponse(response => response.url() === base + '/api/tasks' && response.request().method() === 'POST');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  const response = await submitting;
  assert.equal(response.status(), 202, await response.text());
  const accepted = await response.json();
  const submitted = response.request().postDataJSON();
  assert.equal(submitted.parameters.operation, operation);
  assert.equal(submitted.parameters.source_url, source.url);
  const statuses = [accepted.status];
  const task = await until(async () => {
    const candidate = await request('GET', '/tasks/' + accepted.id);
    if (!statuses.includes(candidate.status)) statuses.push(candidate.status);
    if (candidate.status === 'failed') throw new Error(`Media operation failed: ${operation} ${candidate.error}`);
    return candidate.status === 'succeeded' ? candidate : null;
  }, operation + ' queued worker completion', 480);
  await panel.getByText('处理完成，已应用到当前分镜。', { exact: true }).waitFor();
  assert.equal(task.result.operation, operation);
  assert.equal(task.result.source_url, source.url);
  assert.equal(task.result.application.status, 'applied');
  assert(task.result.url.startsWith('/media/') && task.result.url !== source.url);
  const resultKind = operation === 'extract_frame' ? 'image' : kind;
  const info = await inspect(task.result.url);
  assert.equal(info.kind, resultKind);
  assert.deepEqual([info.width, info.height], dimensions);
  if (duration === null) assert.equal(info.duration, null);
  else assert(Math.abs(info.duration - duration) <= .1, `${operation} duration: ${info.duration}`);
  const bytes = await mediaBytes(task.result.url);
  const extension = resultKind === 'image' ? 'png' : resultKind === 'video' ? 'mp4' : 'wav';
  const savedFile = path.join(output, operation + '.' + extension);
  await fs.writeFile(savedFile, bytes);
  if (resultKind === 'image') assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  if (resultKind === 'video') { assert(bytes.subarray(0, 40).includes(Buffer.from('ftyp'))); assert.equal(info.has_audio, true); }
  if (resultKind === 'audio') assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  if (operation === 'crop_image') {
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', savedFile, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30000 });
    assert.equal(pixels.length, 32 * 48 * 3);
    assert(pixels[2] > 240 && pixels[0] < 10, 'Image crop must select the blue source half');
  }
  const persistedShot = (await request('GET', `/projects/${projectId}/shots`)).items.find(item => item.id === shot.id);
  assert.equal(persistedShot[resultKind + '_url'], task.result.url);
  assert.equal(digest(await mediaBytes(source.url)), source.hash, 'Original media bytes must remain intact');
  const duplicate = await request('POST', '/tasks', submitted);
  assert.equal(duplicate.id, task.id, 'Retry must reuse the task');
  await screenshot(operation + '-complete');
  await panel.locator('footer').getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  if (kind !== 'image') await page.locator('.studio-tabs').getByRole('button', { name: kind === 'video' ? '视频' : '音频', exact: true }).click();
  await page.getByRole('button', { name: '媒体编辑', exact: true }).waitFor();
  const reloaded = (await request('GET', `/projects/${projectId}/shots`)).items.find(item => item.id === shot.id);
  assert.equal(reloaded[resultKind + '_url'], task.result.url);
  taskProof.push({ operation, taskId: task.id, shotId: shot.id, statuses, sourceUrl: source.url, resultUrl: task.result.url, resultHash: digest(bytes), metadata: info });
  checks.push(operation + '-ui-queued-persisted-original-preserved');
}

try {
  await request('GET', '/session');
  const initialCredits = await request('GET', '/credits');
  const image = await uploaded(fixture('source.png'), 'image/png');
  const video = await uploaded(fixture('source.mp4'), 'video/mp4');
  const audio = await uploaded(fixture('source.wav'), 'audio/wav');
  projectId = (await request('POST', '/projects', { name: '媒体工具浏览器验证 ' + Date.now(), kind: 'series' })).id;
  await runOperation({ operation: 'crop_image', kind: 'image', source: image, mode: '剪裁图片', fields: { '裁剪X': 32, '裁剪Y': 0, '裁剪宽度': 32, '裁剪高度': 48 }, dimensions: [32, 48], duration: null });
  await runOperation({ operation: 'trim_video', kind: 'video', source: video, mode: '裁剪时长', fields: { '开始时间': .5, '结束时间': 1.5 }, dimensions: [64, 48], duration: 1 });
  await runOperation({ operation: 'crop_video', kind: 'video', source: video, mode: '裁剪画面', fields: { '裁剪X': 2, '裁剪Y': 2, '裁剪宽度': 32, '裁剪高度': 24, '开始时间': .5, '结束时间': 1.5 }, dimensions: [32, 24], duration: 1 });
  await runOperation({ operation: 'extract_frame', kind: 'video', source: video, mode: '视频截帧', fields: { '截帧时间': .5 }, dimensions: [64, 48], duration: null });
  await runOperation({ operation: 'trim_audio', kind: 'audio', source: audio, mode: '裁剪音频', fields: { '开始时间': .25, '结束时间': 1 }, dimensions: [null, null], duration: .75 });
  const creditsAfter = await request('GET', '/credits');
  assert.equal(creditsAfter.balance, initialCredits.balance);
  assert.deepEqual(creditsAfter.items, initialCredits.items);
  assert.equal((await request('GET', '/tasks?project_id=' + projectId)).total, 5);
  checks.push('five-operations-no-credit-or-ledger-change-and-no-duplicate-tasks');

  canvasId = (await request('POST', '/projects', { name: '版本历史浏览器验证 ' + Date.now(), kind: 'canvas' })).id;
  await request('PUT', `/projects/${canvasId}/canvas`, { nodes: [{ id: 'history-node', type: 'media', position: { x: 120, y: 150 }, data: { kind: 'text', label: '恢复前的第一版', text: '原始画布文本' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, revision: 0 });
  await page.goto(base + '/canvas/' + canvasId);
  await page.getByRole('textbox', { name: '节点名称', exact: true }).waitFor();
  await page.getByRole('button', { name: '版本历史', exact: true }).click();
  let history = page.getByRole('dialog', { name: '画布版本历史', exact: true });
  await history.getByRole('textbox', { name: '版本名称', exact: true }).fill('浏览器命名检查点');
  await history.getByRole('button', { name: '保存版本', exact: true }).click();
  await history.getByText('版本已保存', { exact: true }).waitFor();
  const savedVersion = (await request('GET', `/projects/${canvasId}/canvas/versions`)).items.find(item => item.name === '浏览器命名检查点');
  assert(savedVersion);
  const savedGraph = await request('GET', `/projects/${canvasId}/canvas/versions/${savedVersion.id}`);
  assert.equal(savedGraph.nodes[0].data.label, '恢复前的第一版');
  await screenshot('canvas-manual-version-saved');
  await history.getByRole('button', { name: '关闭版本历史', exact: true }).click();
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('待备份的新修改');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const edited = await until(async () => {
    const graph = await request('GET', `/projects/${canvasId}/canvas`);
    return graph.nodes[0].data.label === '待备份的新修改' ? graph : null;
  }, 'canvas edit persistence');
  await page.getByRole('button', { name: '版本历史', exact: true }).click();
  history = page.getByRole('dialog', { name: '画布版本历史', exact: true });
  await history.locator('.canvas-version-row').filter({ hasText: '浏览器命名检查点' }).click();
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await history.getByText(/已恢复为修订/).waitFor();
  const restored = await request('GET', `/projects/${canvasId}/canvas`);
  assert(restored.revision > edited.revision, 'Restore revision must increase');
  assert.equal(restored.nodes[0].data.label, '恢复前的第一版');
  const versions = await request('GET', `/projects/${canvasId}/canvas/versions`);
  const backup = versions.items.find(item => item.kind === 'before_restore');
  assert(backup);
  const backupGraph = await request('GET', `/projects/${canvasId}/canvas/versions/${backup.id}`);
  assert.equal(backupGraph.nodes[0].data.label, '待备份的新修改');
  assert.equal((await request('GET', `/projects/${canvasId}/canvas/versions/${savedVersion.id}`)).nodes[0].data.label, '恢复前的第一版');
  await screenshot('canvas-version-restored-with-backup');
  await history.getByRole('button', { name: '关闭版本历史', exact: true }).click();
  await page.reload();
  await page.getByRole('textbox', { name: '节点名称', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '节点名称', exact: true }).inputValue(), '恢复前的第一版');
  checks.push('canvas-ui-save-named-version-edit-restore-backup-monotonic-reload');
  assert.deepEqual(errors, []);
  const report = { passed: true, checks, errors, projectId, canvasId, tasks: taskProof, creditsBefore: initialCredits.balance, creditsAfter: creditsAfter.balance };
  await fs.writeFile(path.join(output, 'browser-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks, errors, output }));
} catch (error) {
  await screenshot('failure').catch(() => {});
  await fs.writeFile(path.join(output, 'browser-smoke.json'), JSON.stringify({ passed: false, checks, errors, projectId, canvasId, tasks: taskProof, error: String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally { await browser.close(); }
