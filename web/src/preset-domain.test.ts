import { describe, expect, it } from "vitest";
import {
  cachedPresetURL,
  findPresetCollection,
  presetAssetInput,
  presetDetailPath,
  presetListPath,
  presetKindAtDetail,
} from "./preset-domain";

describe("preset categories and owned imports", () => {
  it("resolves overlapping collection ids within the selected category", () => {
    const collections = [
      { id: "101", kind: "character", name: "角色" },
      { id: "101", kind: "scene", name: "场景" },
    ];
    expect(findPresetCollection(collections, "101", "scene")?.name).toBe(
      "场景",
    );
    expect(findPresetCollection(collections, "101", "effect")).toBeUndefined();
  });
  it("preserves the prop and effect category on their shared observed detail route", () => {
    expect(presetDetailPath({ id: "101", kind: "prop" })).toBe(
      "/material/effectsDetail?id=101&type=system&category=3",
    );
    expect(presetDetailPath({ id: "101", kind: "effect" })).toBe(
      "/material/effectsDetail?id=101&type=system&category=4",
    );
    expect(presetDetailPath({ id: "a b", kind: "scene" })).toBe(
      "/material/sceneDetail?id=a%20b&type=system&category=2",
    );
    expect(presetListPath("prop")).toBe("/material?category=3&active=2");
    expect(presetListPath("effect", "own")).toBe(
      "/material?category=4&active=1",
    );
    expect(presetKindAtDetail("effect", "3")).toBe("prop");
    expect(presetKindAtDetail("effect", "4")).toBe("effect");
  });
  it("accepts cached image paths and refuses signed, external and traversal paths", () => {
    expect(cachedPresetURL("/reference/preset-extra-abcdef.jpg")).toBe(
      "/reference/preset-extra-abcdef.jpg",
    );
    for (const value of [
      "https://cdn.example/preset-image.jpg?signature=secret",
      "/reference/preset-image.jpg?signature=secret",
      "/reference/preset-../image.jpg",
      "//cdn.example/preset-image.jpg",
      undefined,
    ])
      expect(cachedPresetURL(value)).toBe("");
  });
  it("imports the actual medium with retained metadata and the owned upload URL", () => {
    const item = {
      id: "p1",
      name: "雨",
      kind: "effect",
      description: "夜雨",
      url: "/reference/preset-extra-a.jpg",
      metadata: {
        performance_info: "持续落雨",
        aspect_ratio: "16:9",
        image: { uncached: false },
      },
    };
    const input = presetAssetInput(
      item,
      { id: "101", name: "天气", kind: "effect" },
      "/media/owner/rain.jpg",
    );
    expect(input.kind).toBe("effect");
    expect(input.url).toBe("/media/owner/rain.jpg");
    expect(input.metadata).toEqual({
      performance_info: "持续落雨",
      aspect_ratio: "16:9",
      image: { uncached: false },
      in_library: true,
      reference_collection_id: "101",
      reference_collection_kind: "effect",
      reference_preset_id: "p1",
    });
    expect(item.metadata).not.toHaveProperty("in_library");
    expect(() =>
      presetAssetInput(
        item,
        { id: "101", name: "场景", kind: "scene" },
        "/media/owner/rain.jpg",
      ),
    ).toThrow();
    expect(() =>
      presetAssetInput(
        item,
        { id: "101", name: "天气", kind: "effect" },
        item.url,
      ),
    ).toThrow();
  });
});
