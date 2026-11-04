import { chromium } from '/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Mutates only fresh local browser accounts. No reference-site traffic, Docker,
// cleanup or generation/payment operations are performed by this smoke test.
const root = path.resolve(import.meta.dirname, '..');
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5175';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Local smoke target required');
const output = path.resolve(process.env.SMOKE_OUTPUT_DIR || path.join(root, 'artifacts/verification/preset-gallery'));
await fs.mkdir(output, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(25_000);
const checks = [], pageErrors = [], consoleErrors = [], externalRequests = [], imports = [], simulatedFailures = [];
let uploadRequests = 0;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url });
});
page.on('request', request => {
  const url = new URL(request.url());
  if (url.protocol.startsWith('http') && url.origin !== new URL(base).origin) externalRequests.push({ origin: url.origin, pathname: url.pathname });
  if (request.method() === 'POST' && url.pathname === '/api/uploads') uploadRequests++;
});
page.on('requestfailed', request => {
  if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets') simulatedFailures.push(request.failure()?.errorText || 'failed');
});
async function request(method, route, data, requestContext = context) {
  const response = await requestContext.request.fetch(base + '/api' + route, { method, data });
  assert(response.ok(), `${method} ${route} returned ${response.status()}`);
  return response.status() === 204 ? null : response.json();
}
async function bytes(url) {
  assert(url.startsWith('/reference/') || url.startsWith('/media/'), 'Only local static or owned media may be read');
  const response = await context.request.get(base + url);
  assert(response.ok(), `Local media returned ${response.status()}`);
  return response.body();
}
async function until(test, description, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    const value = await test();
    if (value) return value;
    await page.waitForTimeout(150);
  }
  throw new Error('Timed out: ' + description);
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
}
async function deadline(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 30_000); })]); }
  finally { clearTimeout(timer); }
}
async function previewLoaded(dialog, sourceURL) {
  await until(async () => dialog.locator('.preset-selected-image img').evaluateAll((images, expected) => images.length === 1 && images[0].getAttribute('src') === expected && images[0].complete && images[0].naturalWidth > 0, sourceURL), 'cached preview image decoded');
}
function findSample(catalogue, manifest, kind) {
  const subject = manifest.items.find(row => row.kind === kind && row.gallery.some(g => !g.uncached && g.url) && row.gallery.some(g => g.uncached));
  assert(subject, `A mixed cached/uncached ${kind} gallery exists`);
  const collection = catalogue.collections.find(row => row.kind === kind && row.id === subject.collection_id);
  const item = collection?.items.find(row => row.id === subject.item_id);
  assert(item && collection, 'Gallery identity maps to catalogue');
  return { subject, collection, item };
}

try {
  await request('GET', '/session');
  const creditsBefore = await request('GET', '/credits');
  assert.equal((await request('GET', '/assets')).total, 0, 'Use a fresh owned account');
  const catalogue = await request('GET', '/material-presets');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'backend/app/material_preset_galleries.json'), 'utf8'));

  for (const [kind, code, noun, detail] of [['character', '1', '角色', 'roleDetail'], ['scene', '2', '场景', 'sceneDetail']]) {
    const { subject, collection, item } = findSample(catalogue, manifest, kind);
    const gallery = await request('GET', `/material-presets/${kind}/${collection.id}/${item.id}/gallery`);
    assert.equal(gallery.kind, kind);
    assert.equal(gallery.collection_id, collection.id);
    assert.equal(gallery.item_id, item.id);
    assert.equal(gallery.total, subject.gallery.length);
    assert.deepEqual(gallery.items, subject.gallery, 'Deployed full gallery metadata matches retained manifest');
    const cached = gallery.items.filter(row => !row.uncached && row.url);
    const uncached = gallery.items.filter(row => row.uncached);
    assert.equal(gallery.cached_count, cached.length);
    assert(cached.length && uncached.length);
    assert.equal(new Set(gallery.items.map(row => row.id)).size, gallery.total, 'Gallery identities are unique');
    checks.push(kind + '-full-gallery-metadata-count-and-stable-identities');

    await page.goto(base + `/material/${detail}?id=${collection.id}&type=system&category=${code}`);
    await page.getByRole('button', { name: `查看${noun} ${item.name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: item.name, exact: true });
    await dialog.getByRole('region', { name: '预设设定图集', exact: true }).waitFor();
    await dialog.getByText(`已缓存 ${gallery.cached_count}/${gallery.total}`, { exact: true }).waitFor();
    assert.equal(await dialog.locator('.preset-gallery-grid > button').count(), gallery.total + 1);
    await dialog.getByRole('button', { name: '查看设定图 ' + cached[0].name, exact: true }).click();
    await previewLoaded(dialog, cached[0].url);
    await screenshot(kind + '-cached-gallery-preview');
    assert.equal(await dialog.getByRole('link', { name: '下载设定图', exact: true }).getAttribute('href'), cached[0].url);
    checks.push(kind + '-cached-gallery-preview-decodes-real-image');

    await dialog.getByRole('button', { name: '查看设定图 ' + uncached[0].name, exact: true }).click();
    await dialog.getByText('该设定图尚未缓存', { exact: true }).waitFor();
    assert.equal(await dialog.locator('.preset-selected-image img').count(), 0);
    assert.equal(await dialog.getByRole('link', { name: '下载设定图', exact: true }).count(), 0);
    assert.deepEqual(externalRequests, [], 'Uncached source URLs must not be requested remotely');
    await screenshot(kind + '-uncached-gallery-placeholder');
    checks.push(kind + '-uncached-gallery-has-placeholder-and-no-remote-load');

    const assetsBefore = (await request('GET', '/assets')).total;
    const uploadsBefore = uploadRequests;
    const assetsURL = base + '/api/assets';
    const attempts = [];
    let committedAsset, routeError;
    let signalFirst, signalSecond;
    const firstCommitted = new Promise(resolve => { signalFirst = resolve; });
    const secondCommitted = new Promise(resolve => { signalSecond = resolve; });
    const handler = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      try {
        const key = route.request().headers()['idempotency-key'];
        assert(key, 'Import must send a stable Idempotency-Key');
        attempts.push({ key, body: route.request().postDataJSON() });
        const response = await route.fetch({ maxRetries: 0 });
        assert.equal(response.status(), 201, 'Real asset endpoint committed successfully');
        const body = await response.body();
        const asset = JSON.parse(body);
        if (attempts.length === 1) {
          committedAsset = asset;
          await route.abort('failed');
          signalFirst();
        } else {
          assert.equal(attempts.length, 2, 'Exactly one explicit retry expected');
          assert.equal(asset.id, committedAsset.id, 'Retry must replay the same committed asset');
          await route.fulfill({ response, body });
          signalSecond();
        }
      } catch (error) {
        routeError = error;
        await route.abort('failed').catch(() => {});
        signalFirst(); signalSecond();
      }
    };
    await page.route(assetsURL, handler);
    try {
      await dialog.getByRole('button', { name: '导入我的素材', exact: true }).click();
      await deadline(firstCommitted, 'First import did not commit');
      if (routeError) throw routeError;
      await dialog.locator('.error-panel').waitFor();
      await until(async () => dialog.getByRole('button', { name: '导入我的素材', exact: true }).isEnabled(), 'failed import retry enabled');
      assert.equal((await request('GET', '/assets')).total, assetsBefore + 1, 'Commit already exists despite lost browser response');
      assert.equal(uploadRequests - uploadsBefore, 1 + cached.length, 'Only main plus cached gallery images uploaded');
      const firstUploads = uploadRequests;
      await screenshot(kind + '-committed-response-lost');
      await dialog.getByRole('button', { name: '导入我的素材', exact: true }).click();
      await deadline(secondCommitted, 'Retry did not finish');
      if (routeError) throw routeError;
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].key, attempts[1].key, 'Import key survives the lost response');
      assert.deepEqual(attempts[0].body, attempts[1].body, 'Retry payload remains identical');
      assert.equal(uploadRequests, firstUploads, 'Retry must not upload any image again');
      assert.equal((await request('GET', '/assets')).total, assetsBefore + 1, 'Retry must not create a second asset');
    } finally { await page.unroute(assetsURL, handler); }
    checks.push(kind + '-lost-commit-response-retry-keeps-one-asset-and-no-repeat-uploads');

    const imported = await request('GET', '/assets/' + committedAsset.id);
    assert.equal(imported.kind, kind);
    assert.equal(imported.name, item.name);
    assert.equal(imported.metadata.reference_collection_id, collection.id);
    assert.equal(imported.metadata.reference_collection_kind, kind);
    assert.equal(imported.metadata.reference_preset_id, item.id);
    assert.deepEqual(imported.metadata.reference_gallery, gallery.items, 'All cached and uncached source metadata retained');
    assert.deepEqual(imported.metadata.reference_gallery_import, { total: gallery.total, cached: cached.length, imported: cached.length });
    for (const [key, value] of Object.entries(item.metadata).filter(([key]) => key !== 'gallery')) assert.deepEqual(imported.metadata[key], value, 'Preserve source metadata.' + key);
    assert.equal(imported.metadata.gallery.length, cached.length);
    const mediaPairs = [[imported.url, item.url, item.metadata.image]];
    for (const row of cached) {
      const owned = imported.metadata.gallery.find(g => g.reference_image_id === row.id);
      assert(owned, 'Imported gallery links to original source image identity');
      assert(owned.url.startsWith('/media/') && owned.url !== row.url);
      assert.deepEqual({ ...owned, url: row.url, reference_image_id: undefined }, { ...row, uncached: false, reference_image_id: undefined });
      mediaPairs.push([owned.url, row.url, row.image]);
    }
    const hashes = [];
    for (const [ownedURL, cachedURL, metadata] of mediaPairs) {
      assert(ownedURL.startsWith('/media/'));
      const [ownedBytes, cachedBytes] = await Promise.all([bytes(ownedURL), bytes(cachedURL)]);
      const sha = digest(ownedBytes);
      assert.equal(sha, digest(cachedBytes));
      assert.equal(sha, metadata.sha256);
      assert.equal(ownedBytes.length, metadata.bytes);
      hashes.push({ bytes: ownedBytes.length, sha256: sha });
    }
    checks.push(kind + '-owned-main-and-cached-gallery-byte-parity-and-source-metadata-preserved');

    const other = await browser.newContext();
    try {
      await request('GET', '/session', undefined, other);
      assert.equal((await other.request.get(base + '/api/assets/' + imported.id)).status(), 404);
      for (const [ownedURL] of mediaPairs) assert.equal((await other.request.get(base + ownedURL)).status(), 404);
    } finally { await other.close(); }
    checks.push(kind + '-owned-asset-and-every-imported-image-reject-other-account');
    await page.reload();
    const persisted = await request('GET', '/assets/' + imported.id);
    assert.deepEqual(persisted.metadata.gallery, imported.metadata.gallery);
    assert.deepEqual(persisted.metadata.reference_gallery, gallery.items);
    imports.push({ kind, collection_id: collection.id, item_id: item.id, asset_id: imported.id, total_gallery_entries: gallery.total, imported_gallery_images: cached.length, upload_requests: uploadRequests - uploadsBefore, post_attempts: attempts.length, same_idempotency_key: attempts[0].key === attempts[1].key, image_hashes: hashes });
  }

  const creditsAfter = await request('GET', '/credits');
  assert.deepEqual(creditsAfter, creditsBefore, 'Import and retries must not alter credits or ledger');
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);
  assert.equal(simulatedFailures.length, 2, 'Only the deliberately lost character/scene responses failed');
  const unexpectedConsole = consoleErrors.filter(row => !(row.text.includes('net::ERR_FAILED') && row.url === base + '/api/assets'));
  assert.deepEqual(unexpectedConsole, [], 'No unexpected console errors');
  checks.push('imports-retries-no-credit-or-ledger-change-and-no-unexpected-page-errors');
  const report = { passed: true, checks, imports, page_errors: pageErrors, expected_request_failures: simulatedFailures, unexpected_console_errors: unexpectedConsole, external_requests: externalRequests };
  await fs.writeFile(path.join(output, 'preset-gallery-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  await screenshot('failure').catch(() => {});
  const report = { passed: false, checks, imports, page_errors: pageErrors, console_errors: consoleErrors, external_requests: externalRequests, error: String(error) };
  await fs.writeFile(path.join(output, 'preset-gallery-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(error); process.exitCode = 1;
} finally { await browser.close(); }
