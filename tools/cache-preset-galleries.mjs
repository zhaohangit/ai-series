import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs';

process.umask(0o077);
process.on('uncaughtException', error => {
  // Playwright/fetch errors can carry request details. Never print raw errors.
  const code = /^[A-Z_0-9]+$/.test(error.message || '') ? error.message : 'GALLERY_CACHE_FAILED';
  console.error(JSON.stringify({ stage: 'failed', code }));
  process.exit(1);
});

// Read-only CDN GET/HEAD using URLs already observed in retained reference
// responses. No account cookies, mutation endpoints, Docker or cleanup actions.
// Public output never contains signed query parameters.
const root = path.resolve(import.meta.dirname, '..');
const captures = path.join(root, 'artifacts/reference/captures');
const publicDir = path.join(root, 'web/public/reference');
const output = path.join(root, 'backend/app/material_preset_galleries.json');
const publicOutput = path.join(publicDir, 'material-preset-galleries.json');
const sourceHost = 'yw-unite-aidramacdn.yuewen.com';
const maxNewBytes = 500_000_000;
const maxFileBytes = 15_000_000;
const minFreeBytes = 8_000_000_000;
const marginBytes = 65_536;
// Stop with a small reserve instead of probing thousands of additional files
// when the bounded cache is effectively full. This is not a target to exhaust.
const stopReserveBytes = 256_000;
const planning = process.argv.includes('--plan');
const verification = process.argv.includes('--verify');
const refreshCaptures = process.argv.includes('--refresh');
const digest = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const captionArtifact = 'roleAndScene-ChF9dq55.js';
const captionScript = await fs.readFile(path.join(root, 'artifacts/reference/raw', captionArtifact), 'utf8');
const typeCaptions = {
  character: { 1001: '正面', 1002: '背面', 1003: '侧面', 2001: '开心', 2002: '愤怒', 2003: '悲伤', 2004: '惊讶', 3001: '站立', 3002: '坐下', 3003: '奔跑', 3004: '行走', 4001: '眼部', 4002: '嘴部', 4003: '手部' },
  scene: { 1001: '清晨', 1002: '中午', 1003: '傍晚', 1004: '夜晚', 2001: '晴', 2002: '雨', 2003: '雪', 2004: '雾', 3001: '向左', 3002: '向右', 3003: '向上' },
};
const captionOffsets = {};
for (const [kind, mapping] of Object.entries(typeCaptions)) {
  const literal = '{' + Object.entries(mapping).map(([key, value]) => key + ':' + JSON.stringify(value)).join(',') + '}';
  captionOffsets[kind] = captionScript.indexOf(literal);
  if (captionOffsets[kind] < 0) throw new Error('TYPE_CAPTION_EVIDENCE_MISMATCH');
}
const sanitized = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== sourceHost || url.username || url.password || url.port) throw new Error('UNEXPECTED_IMAGE_SOURCE');
  return url.origin + url.pathname;
};
function imageFormat(bytes) {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return ['png', 'image/png'];
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return ['jpg', 'image/jpeg'];
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return ['gif', 'image/gif'];
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return ['webp', 'image/webp'];
  if (bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString())) return ['avif', 'image/avif'];
  throw new Error('INVALID_IMAGE_SIGNATURE');
}
async function bounded(values, concurrency, action) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) { const index = next++; if (index >= values.length) return; await action(values[index]); }
  }));
}
async function availableBytes() { const stats = await fs.statfs(root); return Number(stats.bavail) * Number(stats.bsize); }
async function writeJson(file, value, mode = 0o644) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  await fs.writeFile(file, serialized, { mode });
  return serialized;
}
const subjects = [];
const requests = new Map();
if (refreshCaptures && !verification && !planning) {
  const browser = await chromium.connectOverCDP(process.env.REFERENCE_CDP || 'http://127.0.0.1:9223');
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('REFERENCE_CONTEXT_UNAVAILABLE');
    for (const [catalogueName, kind] of [['material_presets.json', 'character'], ['material_presets_extra.json', 'scene']]) {
      const catalogue = await readJson(path.join(root, 'backend/app', catalogueName));
      for (const collection of catalogue.collections.filter(c => c.kind === kind)) {
        const endpoint = kind === 'character' ? '/api/roleLibrary/system/list' : '/api/backgroundLibrary/system/list';
        const query = { pageIndex: '1', pageSize: '1000', [kind === 'character' ? 'systemRoleLibraryId' : 'systemBackgroundLibraryId']: collection.id };
        const response = await context.request.get('https://aicomic.yuewen.com' + endpoint + '?' + new URLSearchParams(query), { timeout: 30_000 });
        if (!response.ok()) throw new Error('REFERENCE_REFRESH_REJECTED');
        const body = await response.json(); await response.dispose();
        if (body.code !== 0 || !Array.isArray(body.data?.items) || body.data.items.length !== Number(body.data.total)) throw new Error('INCOMPLETE_FRESH_CAPTURE');
        const capture = { kind, collection_id: collection.id, path: endpoint, request: query, captured_at: new Date().toISOString(), body };
        await writeJson(path.join(captures, `gallery-fresh-${kind}-${collection.id}.json`), capture, 0o600);
        console.log(JSON.stringify({ stage: 'capture_refreshed', kind, collection_id: collection.id, items: body.data.items.length }));
      }
    }
  } finally { await browser.close(); }
}
for (const [catalogueName, kind] of [['material_presets.json', 'character'], ['material_presets_extra.json', 'scene']]) {
  const catalogue = await readJson(path.join(root, 'backend/app', catalogueName));
  for (const collection of catalogue.collections.filter(c => c.kind === kind)) {
    let capture, fresh = false;
    try { capture = await readJson(path.join(captures, `gallery-fresh-${kind}-${collection.id}.json`)); fresh = true; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('INVALID_FRESH_CAPTURE'); }
    if (!capture) capture = await readJson(path.join(captures, kind === 'character' ? `material-library-${collection.id}.json` : `other-preset-scene-${collection.id}.json`));
    if (kind === 'character' && (capture.path !== '/api/roleLibrary/system/list' || capture.request?.systemRoleLibraryId !== collection.id || capture.body?.code !== 0)) throw new Error('INVALID_CHARACTER_CAPTURE');
    if (kind === 'scene' && fresh && (capture.path !== '/api/backgroundLibrary/system/list' || capture.request?.systemBackgroundLibraryId !== collection.id || capture.body?.code !== 0)) throw new Error('INVALID_SCENE_CAPTURE');
    if (kind === 'scene' && !fresh && (capture.kind !== kind || capture.library_id !== collection.id)) throw new Error('INVALID_SCENE_CAPTURE');
    const items = kind === 'character' || fresh ? capture.body.data.items : capture.items;
    if (items.length !== collection.material_count) throw new Error('INCOMPLETE_CAPTURE');
    for (const preset of collection.items) {
      const item = items.find(i => String(kind === 'character' ? i.castId : i.id) === preset.id);
      if (!item) throw new Error('PRESET_ID_NOT_IN_CAPTURE');
      const gallery = (item.settingImages || []).map((setting, index) => {
        const source = setting.imageUrl ? sanitized(setting.imageUrl) : null;
        if (source) requests.set(source, setting.imageUrl);
        const sourceId = setting.id === undefined || setting.id === null ? null : String(setting.id);
        const id = sourceId || 'observed-' + digest([kind, collection.id, preset.id, source || '', setting.category, setting.type, index].join('|')).slice(0, 24);
        const responseTypeName = typeof setting.typeName === 'string' && setting.typeName.trim() ? setting.typeName : null;
        const typeName = responseTypeName || typeCaptions[kind][setting.type] || null;
        const label = [setting.categoryName, typeName].filter(v => typeof v === 'string' && v.trim()).join(' · ');
        return {
          id, source_id: sourceId, id_source: sourceId ? 'reference' : 'deterministic_source_identity',
          name: label || `设定图 ${setting.type ?? index + 1}`,
          category: setting.category, type: setting.type,
          category_name: setting.categoryName ?? null, type_name: typeName,
          response_type_name: setting.typeName ?? null,
          type_name_source: responseTypeName ? 'reference_response' : typeName ? 'reference_bundle' : 'unknown',
          description: setting.description ?? null,
          ...(source ? { source_path: source } : {}),
        };
      });
      subjects.push({ kind, collection_id: collection.id, item_id: preset.id, item_name: preset.name, gallery });
    }
  }
}
const counts = ['character', 'scene'].map(kind => ({ kind, subjects: subjects.filter(s => s.kind === kind).length, gallery_entries: subjects.filter(s => s.kind === kind).reduce((n, s) => n + s.gallery.length, 0) }));
const summary = { counts, unique_source_images: requests.size, source_ids_present: subjects.reduce((n, s) => n + s.gallery.filter(g => g.source_id !== null).length, 0), max_new_bytes: maxNewBytes, max_file_bytes: maxFileBytes, min_host_free_bytes: minFreeBytes };
if (planning) {
  console.log(JSON.stringify({ stage: 'plan', ...summary, host_free_bytes: await availableBytes() }));
  process.exit(0);
}
if (verification) {
  const manifest = await readJson(output);
  if (await fs.readFile(output, 'utf8') !== await fs.readFile(publicOutput, 'utf8')) throw new Error('MANIFESTS_DIFFER');
  let verified = 0, bytes = 0;
  for (const item of manifest.items) for (const row of item.gallery) {
    if (row.source_path) sanitized(row.source_path);
    if (row.uncached) { if (!row.reason || row.url) throw new Error('INVALID_UNCACHED_ENTRY'); continue; }
    if (!/^\/reference\/[a-zA-Z0-9_.-]+$/.test(row.url)) throw new Error('UNSAFE_LOCAL_CACHE_PATH');
    const data = await fs.readFile(path.join(publicDir, path.basename(row.url)));
    const [, contentType] = imageFormat(data);
    if (data.length !== row.image.bytes || digest(data) !== row.image.sha256 || contentType !== row.image.content_type) throw new Error('CACHED_BYTES_MISMATCH');
    verified++; bytes += data.length;
  }
  console.log(JSON.stringify({ stage: 'verified', cached_entries: verified, gallery_bytes: bytes, manifest_sha256: digest(await fs.readFile(output)), manifests_identical: true }));
  process.exit(0);
}
const previous = new Map();
for (const file of ['material-presets.json', 'material-presets-extra.json', 'material-preset-galleries.json']) {
  try {
    const data = await readJson(path.join(publicDir, file));
    const rows = data.items ? data.items.flatMap(item => item.gallery) : data.collections.flatMap(c => [c, ...c.items]);
    for (const row of rows) {
      const image = row.image || row.metadata?.image;
      if (image?.source_path && row.url?.startsWith('/reference/') && !row.uncached && !image.uncached) previous.set(image.source_path, { url: row.url, image });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('INVALID_EXISTING_MANIFEST'); }
}
const existingGalleryFiles = (await fs.readdir(publicDir)).filter(name => /^preset-gallery-[a-f0-9]{20}\.(png|jpg|webp|gif|avif)$/.test(name));
const existingByPrefix = new Map(existingGalleryFiles.map(name => [name.split('.')[0], name]));
let storedNewBytes = 0;
for (const name of existingGalleryFiles) storedNewBytes += (await fs.stat(path.join(publicDir, name))).size;
if (storedNewBytes > maxNewBytes) throw new Error('EXISTING_GALLERY_BUDGET_EXCEEDED');
const initialNewBytes = storedNewBytes;
const cache = new Map();
const reasons = new Map();
const queue = [];
const seen = new Set();
// Alternate kinds and rotate subjects, so each subject's first setting image
// is attempted before any subject's second setting image.
const kinds = ['character', 'scene'].map(kind => subjects.filter(s => s.kind === kind));
const fairSubjects = [];
for (let i = 0; i < Math.max(...kinds.map(a => a.length)); i++) for (const rows of kinds) if (rows[i]) fairSubjects.push(rows[i]);
for (let round = 0; round < Math.max(...subjects.map(s => s.gallery.length)); round++) {
  for (const subject of fairSubjects) {
    const image = subject.gallery[round];
    if (image?.source_path && !seen.has(image.source_path)) { seen.add(image.source_path); queue.push(image.source_path); }
  }
}
let reserved = 0, networkBytes = 0, newImages = 0, reused = 0, finished = 0, accessFailures = 0;
const started = new Date().toISOString();
function outputManifest() {
  const items = subjects.map(subject => ({ ...subject, gallery: subject.gallery.map(g => {
    const cached = g.source_path ? cache.get(g.source_path) : undefined;
    if (cached) return { ...g, ...cached, uncached: false };
    const reason = g.source_path ? reasons.get(g.source_path) || 'not_yet_requested' : 'no_source_image';
    return { ...g, uncached: true, reason, image: { ...(g.source_path ? { source_path: g.source_path } : {}), uncached: true, reason } };
  }) }));
  const cachedEntries = items.reduce((n, s) => n + s.gallery.filter(g => !g.uncached).length, 0);
  return { source: 'Read-only settingImages from retained aicomic.yuewen.com preset responses; cached bytes preserve source files.', metadata: { schema_version: 1, captured_at: started, updated_at: new Date().toISOString(), ...summary, type_captions_evidence: { artifact: captionArtifact, sha256: digest(captionScript), character_offset: captionOffsets.character, scene_offset: captionOffsets.scene }, cached_entries: cachedEntries, uncached_entries: requests.size - cachedEntries, new_cache_bytes: storedNewBytes, new_images_this_run: newImages, reused_images: reused, downloaded_bytes_this_run: networkBytes, processing_complete: finished === queue.length }, items };
}
async function saveManifest() {
  const data = outputManifest();
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (/https?:[^"\n]*\?/.test(serialized)) throw new Error('PUBLIC_SIGNED_QUERY_REJECTED');
  await fs.writeFile(output, serialized, { mode: 0o644 });
  await fs.writeFile(publicOutput, serialized, { mode: 0o644 });
  return data;
}
async function fetchImage(source) {
  let reservation = 0;
  try {
    const existing = previous.get(source);
    if (existing) {
      if (!/^\/reference\/[a-zA-Z0-9_.-]+$/.test(existing.url)) throw new Error('UNSAFE_LOCAL_CACHE_PATH');
      const bytes = await fs.readFile(path.join(publicDir, path.basename(existing.url)));
      const [, contentType] = imageFormat(bytes);
      if (bytes.length !== existing.image.bytes || digest(bytes) !== existing.image.sha256 || contentType !== existing.image.content_type) throw new Error('EXISTING_CACHE_HASH_MISMATCH');
      cache.set(source, existing); reused++; return;
    }
    const retainedName = existingByPrefix.get('preset-gallery-' + digest(source).slice(0, 20));
    if (retainedName) {
      const bytes = await fs.readFile(path.join(publicDir, retainedName));
      const [, contentType] = imageFormat(bytes);
      cache.set(source, { url: '/reference/' + retainedName, image: { source_path: source, bytes: bytes.length, sha256: digest(bytes), content_type: contentType } });
      reused++; return;
    }
    if (accessFailures >= 3) { reasons.set(source, 'reference_url_access_unavailable'); return; }
    if (initialNewBytes + networkBytes + reserved >= maxNewBytes - stopReserveBytes) { reasons.set(source, 'download_byte_limit'); return; }
    if (await availableBytes() < minFreeBytes + reserved + maxFileBytes) { reasons.set(source, 'host_free_space_floor'); return; }
    const signed = requests.get(source);
    const options = { redirect: 'error', headers: { Referer: 'https://aicomic.yuewen.com/', 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(30_000) };
    const head = await fetch(signed, { ...options, method: 'HEAD' });
    if (!head.ok) throw new Error(`HTTP_${head.status}`);
    if (!(head.headers.get('content-type') || '').toLowerCase().startsWith('image/')) throw new Error('NON_IMAGE_RESPONSE');
    const expected = Number(head.headers.get('content-length'));
    if (!Number.isSafeInteger(expected) || expected <= 0) throw new Error('UNKNOWN_IMAGE_SIZE');
    if (expected > maxFileBytes) { reasons.set(source, 'per_file_byte_limit'); return; }
    reservation = Math.min(maxFileBytes, expected + marginBytes);
    if (initialNewBytes + networkBytes + reserved + reservation > maxNewBytes) { reasons.set(source, 'download_byte_limit'); reservation = 0; return; }
    reserved += reservation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let chunks, bytesRead = 0;
    try {
      const response = await fetch(signed, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('image/')) throw new Error('NON_IMAGE_RESPONSE');
      chunks = [];
      for await (const chunk of response.body) {
        bytesRead += chunk.length; networkBytes += chunk.length;
        if (bytesRead > reservation || bytesRead > maxFileBytes) { controller.abort(); throw new Error('IMAGE_EXCEEDS_RESERVED_BYTES'); }
        chunks.push(chunk);
      }
    } finally { clearTimeout(timer); }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) throw new Error('EMPTY_IMAGE');
    const [extension, contentType] = imageFormat(bytes);
    const url = '/reference/preset-gallery-' + digest(source).slice(0, 20) + '.' + extension;
    if (await availableBytes() < minFreeBytes + bytes.length) { reasons.set(source, 'host_free_space_floor'); return; }
    await fs.writeFile(path.join(publicDir, path.basename(url)), bytes, { mode: 0o644, flag: 'wx' });
    storedNewBytes += bytes.length; newImages++;
    cache.set(source, { url, image: { source_path: source, bytes: bytes.length, sha256: digest(bytes), content_type: contentType } });
  } catch (error) {
    // Raw fetch errors may include signed URLs; expose only fixed codes.
    const code = /^[A-Z_]+(?:_\d+)?$/.test(error.message || '') ? error.message.toLowerCase() : 'image_request_failed';
    if (code === 'http_403' || code === 'http_401') accessFailures++;
    reasons.set(source, code);
  } finally { reserved -= reservation; finished++; }
}
await saveManifest();
for (let index = 0; index < queue.length; index += 24) {
  await bounded(queue.slice(index, index + 24), 3, fetchImage);
  await saveManifest();
  console.log(JSON.stringify({ stage: 'progress', processed: finished, total: queue.length, cached: cache.size, new_images: newImages, new_cache_bytes: storedNewBytes }));
}
const manifest = await saveManifest();
const report = { ...manifest.metadata, uncached_by_reason: Object.fromEntries([...new Set(reasons.values())].map(reason => [reason, [...reasons.values()].filter(value => value === reason).length])), manifest_sha256: digest(JSON.stringify(manifest, null, 2) + '\n'), host_free_bytes: await availableBytes() };
await writeJson(path.join(captures, verification ? 'preset-gallery-verification.json' : 'preset-gallery-cache-report.json'), report, 0o600);
console.log(JSON.stringify({ stage: 'complete', ...report }));
