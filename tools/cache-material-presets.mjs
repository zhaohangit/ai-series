import { chromium } from '/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Read only the collection IDs and endpoint already observed in the reference UI.
// Raw responses stay in the ignored private capture directory; public metadata
// contains local URLs and source origin/path only, never signed URL queries.
const root = path.resolve(import.meta.dirname, '..');
const captureDir = path.join(root, 'artifacts/reference/captures');
const publicDir = path.join(root, 'web/public/reference');
const origin = 'https://aicomic.yuewen.com';
const useCaptured = process.argv.includes('--captured');
const digest = value => createHash('sha256').update(value).digest('hex');
const sourcePath = value => { const url = new URL(value); return url.origin + url.pathname; };

function imageFormat(bytes) {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return { extension: '.png', contentType: 'image/png' };
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return { extension: '.jpg', contentType: 'image/jpeg' };
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return { extension: '.gif', contentType: 'image/gif' };
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { extension: '.webp', contentType: 'image/webp' };
  if (bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString())) return { extension: '.avif', contentType: 'image/avif' };
  throw new Error('Unrecognized image signature');
}

async function bounded(values, limit, action) {
  const result = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, limit) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await action(values[index], index);
    }
  }));
  return result;
}

async function privateJson(file, value) {
  await fs.writeFile(path.join(captureDir, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

const observed = JSON.parse(await fs.readFile(path.join(captureDir, 'material-library-response.json'), 'utf8'));
if (observed.path !== '/api/commonLibrary/getLibraryList' || observed.request?.libraryType !== 1 || observed.request?.type !== 2 || observed.request?.dataType !== 2) {
  throw new Error('Expected observed preset character collection response');
}
const libraries = observed.body?.data?.items;
if (!Array.isArray(libraries) || libraries.length !== 14) throw new Error('Expected 14 observed collections');
const browser = await chromium.connectOverCDP(process.env.REFERENCE_CDP || 'http://127.0.0.1:9223');
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error('Authenticated reference browser context unavailable');
  const captures = await bounded(libraries, 2, async library => {
    const query = { pageIndex: '1', pageSize: '1000', systemRoleLibraryId: String(library.id) };
    if (useCaptured) {
      const captured = JSON.parse(await fs.readFile(path.join(captureDir, `material-library-${library.id}.json`), 'utf8'));
      if (captured.path !== '/api/roleLibrary/system/list' || captured.request?.systemRoleLibraryId !== String(library.id) || !Array.isArray(captured.body?.data?.items) || captured.body.data.items.length !== Number(captured.body.data.total)) throw new Error('Invalid existing library capture');
      return captured;
    }
    const response = await context.request.get(origin + '/api/roleLibrary/system/list?' + new URLSearchParams(query));
    if (!response.ok()) throw new Error(`Library ${library.id} HTTP ${response.status()}`);
    const body = await response.json();
    if (body.code !== 0 || !Array.isArray(body.data?.items)) throw new Error(`Library ${library.id} unavailable`);
    if (body.data.items.length !== Number(body.data.total)) throw new Error(`Library ${library.id} truncated`);
    const capture = { path: '/api/roleLibrary/system/list', request: query, captured_at: new Date().toISOString(), body };
    await privateJson(`material-library-${library.id}.json`, capture);
    return capture;
  });

  const existing = new Map();
  const previousLocalPaths = new Set();
  try {
    const assets = JSON.parse(await fs.readFile(path.join(publicDir, 'assets.json'), 'utf8'));
    for (const item of assets) {
      if (item.source_url && item.local_url?.startsWith('/reference/')) {
        existing.set(sourcePath(item.source_url), path.join(publicDir, path.basename(item.local_url)));
      }
    }
  } catch {}
  try {
    const previous = JSON.parse(await fs.readFile(path.join(publicDir, 'material-presets.json'), 'utf8'));
    for (const collection of previous.collections) {
      for (const item of [collection, ...collection.items]) {
        if (item.url && item.metadata?.image?.source_path) {
          existing.set(item.metadata.image.source_path, path.join(publicDir, path.basename(item.url)));
          if (item.url.startsWith('/reference/preset-')) previousLocalPaths.add(path.join(publicDir, path.basename(item.url)));
        }
      }
    }
  } catch {}

  const imageRequests = new Map();
  for (let index = 0; index < libraries.length; index++) {
    for (const url of [libraries[index].libraryImgUrl, ...captures[index].body.data.items.map(item => item.imageUrl)]) {
      if (!url) continue;
      const normalized = sourcePath(url);
      if (new URL(url).hostname !== 'yw-unite-aidramacdn.yuewen.com') throw new Error('Unexpected observed image host');
      imageRequests.set(normalized, url);
    }
  }
  if (imageRequests.size > 160) throw new Error('Image download bound exceeded');
  const cached = new Map();
  const failures = [];
  await bounded([...imageRequests], 4, async ([normalized, observedUrl]) => {
    const extension = path.extname(new URL(normalized).pathname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'].includes(extension)) throw new Error('Unexpected image extension');
    try {
      let bytes;
      let contentType = `image/${extension.slice(1).replace('jpg', 'jpeg')}`;
      const cachedPath = existing.get(normalized);
      if (cachedPath) {
        try { bytes = await fs.readFile(cachedPath); } catch {}
      }
      if (!bytes) {
        const response = await context.request.get(observedUrl, { headers: { Referer: origin + '/' }, timeout: 45_000 });
        if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
        contentType = (response.headers()['content-type'] || '').split(';')[0];
        if (!contentType.startsWith('image/')) throw new Error('Response is not an image');
        bytes = await response.body();
      }
      if (!bytes.length) throw new Error('Empty image');
      const detected = imageFormat(bytes);
      contentType = detected.contentType;
      const filename = `preset-${digest(normalized).slice(0, 20)}${detected.extension}`;
      const destination = path.join(publicDir, filename);
      await fs.writeFile(destination, bytes, { mode: 0o644 });
      cached.set(normalized, { url: '/reference/' + filename, image: { source_path: normalized, sha256: digest(bytes), bytes: bytes.length, content_type: contentType } });
    } catch (error) {
      // Only a fixed status/class is logged. Request errors can include signed URLs.
      const reason = /^HTTP \d+$/.test(error.message) ? error.message : 'image_download_failed';
      failures.push({ source_path: normalized, reason });
    }
  });

  function imageFields(url) {
    if (!url) return { image: { uncached: true, reason: 'no_source_image' } };
    const normalized = sourcePath(url);
    return cached.get(normalized) || { image: { source_path: normalized, uncached: true } };
  }
  const catalogue = {
    source: 'Observed preset character collections and read-only roleLibrary/system/list responses from aicomic.yuewen.com on 2026-11-04.',
    collections: libraries.map((library, index) => {
      const cover = imageFields(library.libraryImgUrl);
      return {
        id: String(library.id), name: library.name, kind: 'character', ...(cover.url ? { url: cover.url } : {}),
        material_count: library.materialCount, count: captures[index].body.data.items.length,
        metadata: { image: cover.image },
        items: captures[index].body.data.items.map(item => {
          const main = imageFields(item.imageUrl);
          return {
            id: String(item.castId), name: item.castName, kind: 'character', description: item.appearance || '',
            ...(main.url ? { url: main.url } : {}),
            metadata: {
              identity: item.identity, age_group: item.ageGroup, voice_tts_id: item.voiceTtsId,
              aspect_ratio: item.aspectRatio, picked_style_id: item.pickedStyleId, style_prompt: item.stylePrompt,
              image: main.image,
              gallery: (item.settingImages || []).map(setting => ({
                category: setting.category, type: setting.type, type_name: setting.typeName,
                category_name: setting.categoryName, description: setting.description,
                ...(setting.imageUrl ? { source_path: sourcePath(setting.imageUrl), uncached: true } : {}),
              })),
            },
          };
        }),
      };
    }),
  };
  const serialized = JSON.stringify(catalogue, null, 2) + '\n';
  if (/\?(?:[^"\n]*&)?(?:sign|token|signature|t)=/i.test(serialized)) throw new Error('Signed query leaked into public catalogue');
  await fs.writeFile(path.join(publicDir, 'material-presets.json'), serialized, { mode: 0o644 });
  await fs.writeFile(path.join(root, 'backend/app/material_presets.json'), serialized, { mode: 0o644 });
  const currentLocalPaths = new Set([...cached.values()].map(item => path.join(publicDir, path.basename(item.url))));
  for (const previous of previousLocalPaths) {
    if (!currentLocalPaths.has(previous)) await fs.unlink(previous).catch(() => {});
  }
  await privateJson('material-preset-cache-report.json', {
    captured_at: new Date().toISOString(), collection_count: libraries.length,
    item_count: catalogue.collections.reduce((sum, collection) => sum + collection.items.length, 0),
    images_requested: imageRequests.size, images_cached: cached.size, failures,
    manifest_sha256: digest(serialized),
  });
  console.log(JSON.stringify({ collections: libraries.length, items: catalogue.collections.reduce((sum, collection) => sum + collection.items.length, 0), images: cached.size, failed_images: failures.length, manifest_sha256: digest(serialized) }));
} catch (error) {
  // Playwright's raw errors include request headers, so never print them.
  console.error(JSON.stringify({ error: 'Preset cache failed', code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'CACHE_ERROR' }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
