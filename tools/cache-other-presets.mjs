import { chromium } from '/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Only replay endpoints and request schemas observed through this account's UI.
// Signed source URLs remain in ignored, mode-0600 captures. Public provenance
// keeps origin/path only. No mutation/generation/payment endpoint is called.
const root = path.resolve(import.meta.dirname, '..');
const captureDir = path.join(root, 'artifacts/reference/captures');
const publicDir = path.join(root, 'web/public/reference');
const origin = 'https://aicomic.yuewen.com';
const imageHost = 'yw-unite-aidramacdn.yuewen.com';
const maxNewImages = 400;
const maxBytes = 1_000_000_000;
const captured = process.argv.includes('--captured');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePath = value => { const u = new URL(value); return u.origin + u.pathname; };
const privateJson = (name, value) => fs.writeFile(path.join(captureDir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
function format(bytes) {
  const start = bytes.subarray(0, 16);
  if (start.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return ['.png', 'image/png'];
  if (start.subarray(0, 3).toString('hex') === 'ffd8ff') return ['.jpg', 'image/jpeg'];
  if (/^GIF8[79]a$/.test(start.subarray(0, 6).toString())) return ['.gif', 'image/gif'];
  if (start.subarray(0, 4).toString() === 'RIFF' && start.subarray(8, 12).toString() === 'WEBP') return ['.webp', 'image/webp'];
  if (start.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString())) return ['.avif', 'image/avif'];
  throw new Error('INVALID_IMAGE');
}
async function bounded(values, n, action) {
  const result = new Array(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, values.length) }, async () => {
    for (;;) { const i = next++; if (i >= values.length) return; result[i] = await action(values[i], i); }
  })); return result;
}
const configs = [];
for (const [kind, libraryType] of [['scene', 2], ['prop', 3], ['effect', 4]]) {
  const observation = await readJson(path.join(captureDir, `other-presets-${kind}-libraries-observed.json`));
  if (observation.path !== '/api/commonLibrary/getLibraryList' || observation.request.libraryType !== libraryType || observation.request.type !== 2 || observation.request.dataType !== 2 || observation.body.code !== 0) throw new Error('INVALID_OBSERVATION');
  const items = observation.body.data.items;
  if (!Array.isArray(items) || items.length !== Number(observation.body.data.total)) throw new Error('INCOMPLETE_LIBRARY_OBSERVATION');
  configs.push({ kind, libraryType, libraries: items });
}
const sceneObserved = (await readJson(path.join(captureDir, 'other-presets-scene-api-observed.json'))).find(x => x.path === '/api/backgroundLibrary/system/list');
const commonObserved = (await readJson(path.join(captureDir, 'other-presets-prop-detail-observed.json'))).find(x => x.path === '/api/commonLibrary/list');
if (!sceneObserved?.query?.systemBackgroundLibraryId || commonObserved?.request?.libraryType !== 3) throw new Error('MISSING_OBSERVED_DETAIL_REQUEST');
const browser = await chromium.connectOverCDP(process.env.REFERENCE_CDP || 'http://127.0.0.1:9223');
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error('NO_CONTEXT');
  const jobs = configs.flatMap(config => config.libraries.map(library => ({ ...config, libraries: undefined, library })));
  const details = await bounded(jobs, 2, async job => {
    const { kind, libraryType, library } = job;
    const captureName = `other-preset-${kind}-${library.id}.json`;
    if (captured) {
      const value = await readJson(path.join(captureDir, captureName));
      if (value.kind !== kind || value.library_id !== String(library.id) || value.items.length !== value.total) throw new Error('INVALID_CAPTURE');
      return value;
    }
    const pages = []; const items = []; let total;
    for (let pageIndex = 1; pageIndex <= 10; pageIndex++) {
      const endpoint = kind === 'scene' ? sceneObserved.path : commonObserved.path;
      const request = kind === 'scene'
        ? { ...sceneObserved.query, pageIndex: String(pageIndex), systemBackgroundLibraryId: String(library.id) }
        : { ...commonObserved.request, libraryType, libraryId: String(library.id), pageIndex };
      const response = kind === 'scene'
        ? await context.request.get(origin + endpoint + '?' + new URLSearchParams(request), { timeout: 45_000 })
        : await context.request.post(origin + endpoint, { data: request, timeout: 45_000 });
      if (!response.ok()) throw new Error(`HTTP_${response.status()}`);
      const body = await response.json();
      if (body.code !== 0 || !Array.isArray(body.data?.items)) throw new Error('INVALID_DETAIL_RESPONSE');
      total = Number(body.data.total); pages.push({ path: endpoint, request, body }); items.push(...body.data.items);
      if (items.length >= total) break;
      if (!body.data.items.length) throw new Error('EARLY_EMPTY_PAGE');
    }
    if (items.length !== total || new Set(items.map(x => String(x.id))).size !== total) throw new Error('INCOMPLETE_DETAIL');
    const value = { kind, library_id: String(library.id), captured_at: new Date().toISOString(), total, pages, items };
    await privateJson(captureName, value); console.log(JSON.stringify({ stage: 'detail_captured', kind, library_id: String(library.id), items: items.length })); return value;
  });
  const previous = new Map();
  for (const name of ['assets.json', 'material-presets.json', 'material-presets-extra.json']) {
    try {
      const value = await readJson(path.join(publicDir, name));
      const records = Array.isArray(value) ? value : value.collections.flatMap(c => [c, ...c.items, ...c.items.flatMap(i => i.metadata?.gallery || [])]);
      for (const item of records) {
        const source = item.source_url || item.metadata?.image?.source_path || item.image?.source_path || item.source_path;
        const local = item.local_url || item.url;
        if (source && local?.startsWith('/reference/')) previous.set(sourcePath(source), local);
      }
    } catch {}
  }
  const requests = new Map();
  const addImage = (url, priority) => {
    if (!url) return;
    const u = new URL(url); if (u.hostname !== imageHost || u.protocol !== 'https:') throw new Error('UNEXPECTED_OBSERVED_HOST');
    const normalized = sourcePath(url);
    if (!requests.has(normalized)) requests.set(normalized, { url, priority });
  };
  // Covers first, then one main item per collection per pass. This bounds new
  // downloads while preserving useful samples in every observed collection.
  jobs.forEach(job => addImage(job.library.libraryImgUrl, 'cover'));
  for (let i = 0; i < Math.max(...details.map(d => d.items.length)); i++) details.forEach(d => addImage(d.items[i]?.imageUrl, 'main'));
  // Gallery source metadata is preserved below; this pass caches covers and main images only.
  const cache = new Map(); const failures = []; let newImages = 0; let downloadedBytes = 0; let reservedBytes = 0; let reservedImages = 0; let reused = 0;
  // HEAD reserves a known byte size before each authenticated-context CDN GET.
  // Four bounded workers share one reservation budget and never export cookies.
  await bounded([...requests], 4, async ([normalized, request]) => {
    try {
      const cachedUrl = previous.get(normalized);
      let bytes; let localUrl = cachedUrl;
      if (cachedUrl) { try { bytes = await fs.readFile(path.join(publicDir, path.basename(cachedUrl))); } catch {} }
      if (bytes) reused++;
      else {
        if (reservedImages >= maxNewImages) { failures.push({ source_path: normalized, reason: 'new_image_limit', priority: request.priority }); return; }
        if (reservedBytes >= maxBytes) { failures.push({ source_path: normalized, reason: 'byte_limit', priority: request.priority }); return; }
        if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(new URL(normalized).pathname)) { failures.push({ source_path: normalized, reason: 'non_image_content_not_cached', priority: request.priority }); return; }
        const options = { headers: { Referer: origin + '/' }, timeout: 45_000 };
        const head = await context.request.head(request.url, options);
        if (!head.ok()) throw new Error(`HTTP_${head.status()}`);
        if (!(head.headers()['content-type'] || '').startsWith('image/')) throw new Error('NON_IMAGE_CONTENT');
        const length = Number(head.headers()['content-length'] || 0);
        await head.dispose();
        if (!Number.isSafeInteger(length) || length <= 0) throw new Error('UNKNOWN_IMAGE_SIZE');
        // The observed CDN can vary PNG encoding slightly between HEAD and GET.
        // Reserve an extra64KiB per image rather than discard valid images.
        const reservedLength = length + 65_536;
        if (reservedLength > maxBytes - reservedBytes || length > 30_000_000 || reservedImages >= maxNewImages) {
          failures.push({ source_path: normalized, reason: reservedLength > maxBytes - reservedBytes ? 'byte_limit' : 'image_limit', priority: request.priority }); return;
        }
        reservedBytes += reservedLength; reservedImages++;
        const response = await context.request.get(request.url, options);
        if (!response.ok()) throw new Error(`HTTP_${response.status()}`);
        bytes = await response.body(); await response.dispose(); downloadedBytes += bytes.length;
        if (bytes.length > reservedLength || downloadedBytes > maxBytes) throw new Error('IMAGE_SIZE_CHANGED');
        newImages++;
        const [extension] = format(bytes);
        localUrl = '/reference/preset-extra-' + hash(normalized).slice(0, 20) + extension;
        await fs.writeFile(path.join(publicDir, path.basename(localUrl)), bytes, { mode: 0o644 });
      }
      if (newImages > 0 && newImages % 50 === 0) console.log(JSON.stringify({ stage: 'images', new_images: newImages, downloaded_bytes: downloadedBytes }));
      const [, contentType] = format(bytes);
      cache.set(normalized, { url: localUrl, image: { source_path: normalized, sha256: hash(bytes), bytes: bytes.length, content_type: contentType } });
    } catch (error) {
      const reason = /^HTTP_\d+$/.test(error.message) ? error.message : ['NON_IMAGE_CONTENT', 'INVALID_IMAGE', 'BYTE_LIMIT', 'UNKNOWN_IMAGE_SIZE', 'IMAGE_SIZE_CHANGED'].includes(error.message) ? error.message.toLowerCase() : 'image_download_failed';
      failures.push({ source_path: normalized, reason, priority: request.priority });
    }
  });
  const failureByPath = new Map(failures.map(f => [f.source_path, f.reason]));
  const fields = url => {
    if (!url) return { image: { uncached: true, reason: 'no_source_image' } };
    const normalized = sourcePath(url);
    return cache.get(normalized) || { image: { source_path: normalized, uncached: true, reason: failureByPath.get(normalized) || 'gallery_not_requested' } };
  };
  const catalogue = {
    source: 'Observed preset scene, prop and effect collections and read-only detail responses from aicomic.yuewen.com on 2026-11-04.',
    metadata: { captured_at: new Date().toISOString(), new_image_limit: maxNewImages, download_byte_limit: maxBytes, videos_cached: false },
    collections: jobs.map((job, index) => {
      const cover = fields(job.library.libraryImgUrl); const detail = details[index];
      return {
        id: String(job.library.id), name: job.library.name, kind: job.kind, ...(cover.url ? { url: cover.url } : {}),
        material_count: job.library.materialCount, count: detail.items.length, metadata: { image: cover.image },
        items: detail.items.map(item => {
          const main = fields(item.imageUrl);
          return {
            id: String(item.id), name: item.name, kind: job.kind, description: item.info || item.description || item.summary || '',
            ...(main.url ? { url: main.url } : {}),
            metadata: {
              summary: item.summary, info: item.info, performance_info: item.performanceInfo, age_group: item.ageGroup,
              aspect_ratio: item.aspectRatio, picked_style_id: item.pickedStyleId, style_prompt: item.stylePrompt,
              generated_image_type: item.generatedImageType, group_id: item.groupId, variant_name: item.variantName, is_initial: item.isInitial,
              image: main.image,
              gallery: (item.settingImages || []).map(setting => {
                const image = fields(setting.imageUrl);
                return { id: String(setting.id), category: setting.category, type: setting.type, type_name: setting.typeName,
                  category_name: setting.categoryName, description: setting.description,
                  ...(image.url ? { url: image.url } : {}), image: image.image,
                  ...(image.image.source_path ? { source_path: image.image.source_path } : {}),
                  ...(image.image.uncached ? { uncached: true, reason: image.image.reason } : {}),
                };
              }),
            },
          };
        }),
      };
    }),
  };
  const serialized = JSON.stringify(catalogue, null, 2) + '\n';
  if (/https?:[^"\n]*\?/.test(serialized)) throw new Error('PUBLIC_QUERY_LEAK');
  await fs.writeFile(path.join(publicDir, 'material-presets-extra.json'), serialized, { mode: 0o644 });
  await fs.writeFile(path.join(root, 'backend/app/material_presets_extra.json'), serialized, { mode: 0o644 });
  const report = {
    captured_at: new Date().toISOString(), counts: configs.map(config => ({ kind: config.kind, collections: config.libraries.length, items: details.filter(d => d.kind === config.kind).reduce((s, d) => s + d.items.length, 0) })),
    unique_images_observed: requests.size, images_cached: cache.size, new_images: newImages, reused_images: reused, downloaded_bytes: downloadedBytes,
    gallery_images_observed: details.reduce((sum, detail) => sum + detail.items.reduce((count, item) => count + (item.settingImages || []).length, 0), 0),
    gallery_images_requested: 0, reserved_bytes: reservedBytes, uncached_images: failures.length, uncached_by_reason: Object.fromEntries([...new Set(failures.map(f => f.reason))].map(reason => [reason, failures.filter(f => f.reason === reason).length])),
    failures, manifest_sha256: hash(serialized),
  };
  await privateJson('other-presets-cache-report.json', report);
  console.log(JSON.stringify({ ...report, failures: undefined }));
} catch (error) {
  console.error(JSON.stringify({ error: 'Other preset cache failed', code: /^[A-Z_0-9]+$/.test(error.message || '') ? error.message : 'CACHE_ERROR' })); process.exitCode = 1;
} finally { await browser.close(); }
