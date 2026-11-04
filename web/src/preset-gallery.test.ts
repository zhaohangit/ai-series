import { describe, it, expect } from "vitest";
import {
  buildImportedPreset,
  importableGallery,
  galleryGroups,
} from "./preset-gallery";

const item = {
  id: "role1",
  name: "角色",
  kind: "character",
  description: "描述",
  url: "/reference/preset-cover.jpg",
  metadata: { performance_info: "表演信息" },
};
const collection = { id: "101", name: "角色库", kind: "character" };
const gallery = [
  {
    id: "g1",
    name: "正面",
    category: "a",
    category_name: "角度",
    url: "/reference/preset-gallery-a1.png",
    image: { content_type: "image/png" },
  },
  {
    id: "g2",
    name: "背面",
    category: "a",
    category_name: "角度",
    uncached: true,
    reason: "budget_limit",
  },
  {
    id: "g3",
    name: "高兴",
    category: "b",
    category_name: "表情",
    url: "https://untrusted.test/file.png",
    image: { content_type: "image/png" },
  },
];
describe("preset gallery import", () => {
  it("imports only local cached gallery images", () => {
    expect(importableGallery(gallery).map((x) => x.id)).toEqual(["g1"]);
    expect(galleryGroups(gallery).map((x) => [x.key, x.name])).toEqual([
      ["a", "角度"],
      ["b", "表情"],
    ]);
  });
  it("keeps source catalogue evidence separately from owned editable views", () => {
    const result = buildImportedPreset(
      item,
      collection,
      "/media/account/main.png",
      gallery,
      { g1: "/media/account/front.png" },
    );
    expect(result.metadata.gallery).toEqual([
      expect.objectContaining({
        id: "g1",
        name: "正面",
        url: "/media/account/front.png",
      }),
    ]);
    expect(result.metadata.performance_info).toBe("表演信息");
    expect(result.metadata.reference_gallery).toEqual(gallery);
    expect(result.metadata.reference_gallery_import).toEqual({
      total: 3,
      cached: 1,
      imported: 1,
    });
  });
  it("refuses incomplete or non-owned image copies", () => {
    expect(() =>
      buildImportedPreset(item, collection, "/media/a.png", gallery, {}),
    ).toThrow();
    expect(() =>
      buildImportedPreset(item, collection, "/media/a.png", gallery, {
        g1: "/reference/preset-gallery-a1.png",
      }),
    ).toThrow();
  });
});
