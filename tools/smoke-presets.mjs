import { chromium } from "/Users/zhaohan25/Documents/my-code/rea/node_modules/playwright-core/index.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// This smoke test uses a fresh local session and only the deployed local app.
// It does not open the reference site or run any infrastructure commands.
const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:5175";
const output = path.resolve(
  process.env.SMOKE_OUTPUT_DIR || "artifacts/verification/presets",
);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const checks = [],
  errors = [],
  consoleErrors = [],
  imports = [],
  collectionCounts = {};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let canvasNavigation;
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("dialog", (dialog) =>
  dialog.type() === "confirm" ? dialog.accept() : dialog.dismiss(),
);
async function request(method, route, data) {
  const response = await context.request.fetch(base + "/api" + route, {
    method,
    data,
  });
  assert(response.ok(), `${method} ${route}: ${response.status()}`);
  return response.status() === 204 ? null : response.json();
}
async function bytes(url) {
  const response = await context.request.get(base + url);
  assert(response.ok(), `Local image response ${response.status()}`);
  return response.body();
}
async function until(check, description) {
  for (let i = 0; i < 100; i++) {
    const result = await check();
    if (result) return result;
    await page.waitForTimeout(150);
  }
  throw new Error(`Timed out: ${description}`);
}
async function screenshot(name) {
  await page.screenshot({
    path: path.join(output, name + ".png"),
    fullPage: true,
  });
}
function assertCategory(kind, code, source = "2") {
  const current = new URL(page.url());
  assert.equal(
    current.searchParams.get("category"),
    code,
    `${kind} category survives navigation`,
  );
  if (current.pathname === "/material")
    assert.equal(current.searchParams.get("active"), source);
}
const configs = [
  { kind: "scene", code: "2", noun: "场景", count: 14, detail: "sceneDetail" },
  { kind: "prop", code: "3", noun: "道具", count: 14, detail: "effectsDetail" },
  {
    kind: "effect",
    code: "4",
    noun: "特效",
    count: 19,
    detail: "effectsDetail",
  },
];

try {
  await request("GET", "/session");
  const initialCredits = await request("GET", "/credits");
  assert.equal(
    (await request("GET", "/assets")).total,
    0,
    "The browser uses a fresh account",
  );
  const catalogue = await request("GET", "/material-presets");
  const character101 = catalogue.collections.find(
    (item) => item.kind === "character" && item.id === "101",
  );
  const scene101 = catalogue.collections.find(
    (item) => item.kind === "scene" && item.id === "101",
  );
  assert(
    character101 && scene101,
    "Both overlapping collection identities must exist",
  );
  assert.notEqual(character101.items[0].id, scene101.items[0].id);
  assert.notEqual(character101.items[0].name, scene101.items[0].name);

  for (const config of configs) {
    const { kind, code, noun, count, detail } = config;
    const collections = catalogue.collections.filter(
      (item) => item.kind === kind,
    );
    collectionCounts[kind] = collections.length;
    assert.equal(collections.length, count);
    await page.goto(base + `/material?category=${code}&active=2`);
    await until(
      async () => (await page.locator(".preset-collection").count()) === count,
      `${kind} collection cards`,
    );
    assertCategory(kind, code);
    await screenshot(kind + "-collections");
    checks.push(kind + "-collection-count-" + count);

    const collection =
      kind === "scene"
        ? scene101
        : collections.find((item) =>
            item.items.some(
              (preset) =>
                typeof preset.metadata.performance_info === "string" &&
                preset.metadata.performance_info,
            ),
          ) || collections[0];
    assert(collection, `${kind} collection exists`);
    await page
      .getByRole("button", {
        name: `${collection.name} ${collection.material_count}个${noun}`,
        exact: true,
      })
      .click();
    await page.locator(".preset-detail-head h1").waitFor();
    assert.equal(new URL(page.url()).pathname, "/material/" + detail);
    assert.equal(new URL(page.url()).searchParams.get("id"), collection.id);
    assertCategory(kind, code);
    assert.equal(
      await page.locator(".preset-detail-head h1").textContent(),
      collection.name,
    );
    await until(
      async () =>
        (await page.locator(".preset-character").count()) ===
        collection.items.length,
      `${kind} detail item count`,
    );
    const index = collection.items.findIndex(
      (item) =>
        item.url?.startsWith("/reference/preset-") &&
        typeof item.metadata.performance_info === "string" &&
        item.metadata.performance_info,
    );
    const chosenIndex =
      index >= 0
        ? index
        : collection.items.findIndex((item) =>
            item.url?.startsWith("/reference/preset-"),
          );
    assert(chosenIndex >= 0, `${kind} cached main image exists`);
    const selected = collection.items[chosenIndex];
    await page.locator(".preset-character").nth(chosenIndex).click();
    const dialog = page.getByRole("dialog", {
      name: selected.name,
      exact: true,
    });
    await dialog.waitFor();
    if (
      typeof selected.metadata.performance_info === "string" &&
      selected.metadata.performance_info
    )
      await dialog
        .getByText(selected.metadata.performance_info, { exact: true })
        .first()
        .waitFor();
    await screenshot(kind + "-detail-import");
    const submitting = page.waitForResponse(
      (response) =>
        response.url() === base + "/api/assets" &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "导入我的素材", exact: true })
      .click();
    const importedResponse = await submitting;
    assert.equal(importedResponse.status(), 201, await importedResponse.text());
    const created = await importedResponse.json();
    await dialog.waitFor({ state: "hidden" });
    const imported = await request("GET", "/assets/" + created.id);
    assert.equal(imported.kind, kind);
    assert.equal(imported.name, selected.name);
    assert.equal(imported.description, selected.description);
    assert.equal(imported.style, collection.name);
    assert.equal(imported.metadata.reference_collection_id, collection.id);
    assert.equal(imported.metadata.reference_collection_kind, kind);
    assert.equal(imported.metadata.reference_preset_id, selected.id);
    assert.equal(imported.metadata.in_library, true);
    for (const [key, value] of Object.entries(selected.metadata).filter(([key]) => key !== "gallery"))
      assert.deepEqual(
        imported.metadata[key],
        value,
        `${kind} preserves metadata.${key}`,
      );
    const sourceGallery = await request("GET", `/material-presets/${kind}/${collection.id}/${selected.id}/gallery`);
    assert.deepEqual(imported.metadata.reference_gallery, sourceGallery.items);
    assert.equal(imported.metadata.gallery.length, sourceGallery.cached_count);
    assert(imported.url.startsWith("/media/"));
    assert.notEqual(imported.url, selected.url);
    const [ownedBytes, cachedBytes] = await Promise.all([
      bytes(imported.url),
      bytes(selected.url),
    ]);
    assert.equal(
      digest(ownedBytes),
      digest(cachedBytes),
      `${kind} owned media preserves actual cached bytes`,
    );
    if (selected.metadata.image?.sha256)
      assert.equal(digest(ownedBytes), selected.metadata.image.sha256);
    const other = await browser.newContext();
    try {
      assert.equal(
        (await other.request.get(base + "/api/session")).status(),
        200,
      );
      assert.equal(
        (await other.request.get(base + imported.url)).status(),
        404,
        "Owned media is private to the importing account",
      );
      assert.equal(
        (await other.request.get(base + "/api/assets/" + imported.id)).status(),
        404,
      );
    } finally {
      await other.close();
    }
    imports.push({
      kind,
      collection_id: collection.id,
      collection_name: collection.name,
      preset_id: selected.id,
      asset_id: imported.id,
      metadata_keys: Object.keys(selected.metadata),
      bytes: ownedBytes.length,
      sha256: digest(ownedBytes),
      performance_info_preserved:
        imported.metadata.performance_info ===
        selected.metadata.performance_info,
      performance_info_type:
        selected.metadata.performance_info === null
          ? "null"
          : typeof selected.metadata.performance_info,
    });
    checks.push(kind + "-owned-import-kind-metadata-and-byte-equality");
    checks.push(kind + "-owned-media-rejects-other-account");

    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.locator(".preset-collection").first().waitFor();
    assertCategory(kind, code);
    await page.getByRole("button", { name: "我的", exact: true }).click();
    await until(
      async () => new URL(page.url()).searchParams.get("active") === "1",
      `${kind} own-library navigation`,
    );
    assertCategory(kind, code, "1");
    await page
      .locator(".asset-name")
      .filter({ hasText: selected.name })
      .waitFor();
    await screenshot(kind + "-owned-library");
    await page.reload();
    await page
      .locator(".asset-name")
      .filter({ hasText: selected.name })
      .waitFor();
    assert.equal((await request("GET", "/assets/" + imported.id)).kind, kind);
    await page.getByRole("button", { name: "预设", exact: true }).click();
    await page.locator(".preset-collection").first().waitFor();
    assertCategory(kind, code);
    checks.push(kind + "-detail-back-own-preset-category-and-reload-persisted");
  }

  for (const [kind, code, route, collection] of [
    ["character", "1", "roleDetail", character101],
    ["scene", "2", "sceneDetail", scene101],
  ]) {
    await page.goto(
      base + `/material/${route}?id=101&type=system&category=${code}`,
    );
    await page.locator(".preset-detail-head h1").waitFor();
    assert.equal(
      await page.locator(".preset-detail-head h1").textContent(),
      collection.name,
    );
    await page.locator(".preset-character").first().waitFor();
    assert.equal(
      await page.locator(".preset-character strong").first().textContent(),
      collection.items[0].name,
    );
    await screenshot(kind + "-overlapping-101");
  }
  checks.push("overlapping-id-101-resolves-character-and-scene-independently");

  // Delay only an actual deployed restore response; all graphs and revisions
  // below are created and committed by the real local API, without fake data.
  const graph = (label, revision = 0) => ({
    nodes: [
      {
        id: "navigation-node",
        type: "media",
        position: { x: 120, y: 150 },
        data: { label, text: label, kind: "text" },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    revision,
  });
  const canvasA = await request("POST", "/projects", {
    name: "Preset QA canvas A " + Date.now(),
    kind: "canvas",
  });
  const canvasB = await request("POST", "/projects", {
    name: "Preset QA canvas B " + Date.now(),
    kind: "canvas",
  });
  await request("PUT", `/projects/${canvasA.id}/canvas`, graph("A original"));
  await request("PUT", `/projects/${canvasB.id}/canvas`, graph("B unchanged"));
  const version = await request(
    "POST",
    `/projects/${canvasA.id}/canvas/versions`,
    { name: "Navigation regression checkpoint", revision: 1 },
  );
  await request("PUT", `/projects/${canvasA.id}/canvas`, graph("A current", 1));
  let releaseRestore, signalCommitted, committedRestore;
  const responseGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const committed = new Promise((resolve) => {
    signalCommitted = resolve;
  });
  const cancelled = [];
  page.on("requestfailed", (response) => {
    if (response.url().endsWith(`/versions/${version.id}/restore`))
      cancelled.push(response.failure()?.errorText);
  });
  await page.route(
    base + `/api/projects/${canvasA.id}/canvas/versions/${version.id}/restore`,
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const body = await response.body();
      committedRestore = JSON.parse(body);
      signalCommitted();
      await responseGate;
      try {
        await route.fulfill({ response, body });
      } catch (error) {
        if (!cancelled.length) throw error;
      }
    },
  );
  try {
    await page.goto(base + "/canvas/" + canvasA.id);
    await page
      .getByRole("textbox", { name: "节点名称", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "版本历史", exact: true }).click();
    const panel = page.getByRole("dialog", {
      name: "画布版本历史",
      exact: true,
    });
    await panel
      .locator(".canvas-version-row")
      .filter({ hasText: "Navigation regression checkpoint" })
      .click();
    await panel
      .getByRole("button", { name: "恢复此版本", exact: true })
      .click();
    let commitTimeout;
    try {
      await Promise.race([
        committed,
        new Promise((_, reject) => {
          commitTimeout = setTimeout(
            () => reject(new Error("Restore did not commit")),
            20000,
          );
        }),
      ]);
    } finally {
      clearTimeout(commitTimeout);
    }
    await page.evaluate((projectId) => {
      history.pushState({}, "", "/canvas/" + projectId);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, canvasB.id);
    await until(
      async () =>
        (await page
          .getByRole("textbox", { name: "画布名称", exact: true })
          .inputValue()
          .catch(() => "")) === canvasB.name,
      "canvas B route",
    );
    releaseRestore();
    await until(async () => cancelled.length === 1, "old panel request abort");
    await page.waitForTimeout(400);
    assert.equal(
      await page
        .getByRole("textbox", { name: "节点名称", exact: true })
        .inputValue(),
      "B unchanged",
    );
    const actualA = await request("GET", `/projects/${canvasA.id}/canvas`),
      actualB = await request("GET", `/projects/${canvasB.id}/canvas`);
    assert.equal(actualA.nodes[0].data.label, "A original");
    assert.equal(actualA.revision, committedRestore.revision);
    assert(
      actualA.revision > version.revision,
      "Restore increments the actual current server revision",
    );
    assert.equal(actualB.nodes[0].data.label, "B unchanged");
    assert(
      actualB.revision >= 1,
      "The editor may persist measured node dimensions",
    );
    const versions = await request(
      "GET",
      `/projects/${canvasA.id}/canvas/versions`,
    );
    const backup = versions.items.find(
      (item) => item.kind === "before_restore",
    );
    assert(backup);
    assert.equal(
      (
        await request(
          "GET",
          `/projects/${canvasA.id}/canvas/versions/${backup.id}`,
        )
      ).nodes[0].data.label,
      "A current",
    );
    canvasNavigation = {
      canvas_a: canvasA.id,
      canvas_b: canvasB.id,
      a_restored_revision: actualA.revision,
      b_current_revision: actualB.revision,
      old_request_aborted: cancelled,
      backup_retained: true,
    };
    await screenshot("canvas-delayed-restore-route-navigation");
    checks.push(
      "deployed-delayed-restore-navigation-keeps-next-project-and-backup-intact",
    );
  } finally {
    releaseRestore();
    await page.unrouteAll({ behavior: "wait" });
  }

  const finalCredits = await request("GET", "/credits");
  assert.equal(finalCredits.balance, initialCredits.balance);
  assert.deepEqual(finalCredits.items, initialCredits.items);
  checks.push("local-preset-and-history-qa-no-credit-or-ledger-change");
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  const report = {
    passed: true,
    base,
    collection_counts: collectionCounts,
    checks,
    imports,
    canvas_navigation: canvasNavigation,
    page_errors: errors,
    console_errors: consoleErrors,
  };
  await fs.writeFile(
    path.join(output, "presets-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await screenshot("failure").catch(() => {});
  await fs.writeFile(
    path.join(output, "presets-smoke.json"),
    JSON.stringify(
      {
        passed: false,
        checks,
        imports,
        collection_counts: collectionCounts,
        canvas_navigation: canvasNavigation,
        error: String(error),
        page_errors: errors,
        console_errors: consoleErrors,
      },
      null,
      2,
    ) + "\n",
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
