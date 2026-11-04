import { describe, expect, it } from "vitest";
import {
  subjectDraft,
  subjectPatch,
  updateGallery,
  subjectWithImage,
  subjectTaskParameters,
} from "./subject-domain";
import type { Asset, Project } from "./types";

const asset = {
  id: "subject-1",
  kind: "character",
  name: "小橙",
  description: "原描述",
  url: "/media/old.png",
  style: "anime",
  metadata: { custom: { keep: true }, voice: { custom: 2 } },
  created_at: "2026-11-04",
  updated_at: "2026-11-04T01:00:00Z",
} as Asset & { updated_at: string };

describe("subject persistence", () => {
  it("keeps appearance descriptions separate from episode performance information", () => {
    const draft = subjectDraft(asset);
    expect(draft.description).toBe("原描述");
    expect(draft.metadata.performance_info).toBe("");
    draft.metadata.performance_info = "第二集以雨衣造型登场";
    const patch = subjectPatch(asset, draft);
    expect(patch.description).toBe("原描述");
    expect(patch.metadata.performance_info).toBe("第二集以雨衣造型登场");
  });
  it("normalizes malformed optional metadata without losing unrelated fields", () => {
    const result = subjectDraft({
      ...asset,
      metadata: {
        ...asset.metadata,
        gallery: [
          null,
          { id: "front", name: "正面", url: "/media/front.png" },
          { id: 12 },
        ],
        versions: "invalid",
        age: 22,
      },
    });
    expect(result.metadata.gallery).toEqual([
      { id: "front", name: "正面", url: "/media/front.png" },
    ]);
    expect(result.metadata.age).toBe("");
    expect(result.metadata.versions).toEqual([]);
    expect(result.metadata.custom).toEqual({ keep: true });
    expect(result.metadata.voice.custom).toBe(2);
  });
  it("saves the original revision and unknown metadata while trimming names", () => {
    const draft = subjectDraft(asset);
    draft.name = "  新名字  ";
    draft.metadata.voice.description = "温柔";
    const patch = subjectPatch(asset, draft);
    expect(patch.expected_updated_at).toBe(asset.updated_at);
    expect(patch.name).toBe("新名字");
    expect(patch.metadata.custom).toEqual({ keep: true });
    expect(patch.metadata.voice).toMatchObject({
      custom: 2,
      description: "温柔",
    });
  });
  it("rejects a blank subject name before submitting", () => {
    expect(() =>
      subjectPatch(asset, { ...subjectDraft(asset), name: "  " }),
    ).toThrow("请输入名称");
  });
  it("updates only the selected gallery slot, preserving other views", () => {
    const gallery = [
      { id: "front", name: "正面", url: "a" },
      { id: "back", name: "背面", url: "b" },
    ];
    expect(
      updateGallery(gallery, { id: "front", name: "正面", url: "c" }),
    ).toEqual([{ id: "front", name: "正面", url: "c" }, gallery[1]]);
    expect(gallery[0].url).toBe("a");
  });
  it("keeps previous main images as restorable versions, without duplicating the same URL", () => {
    const draft = subjectDraft(asset);
    const changed = subjectWithImage(
      draft,
      "/media/new.png",
      "2026-11-04T02:00:00Z",
      "version-1",
    );
    expect(changed.url).toBe("/media/new.png");
    expect(changed.metadata.versions).toEqual([
      {
        id: "version-1",
        name: "历史主视觉",
        url: "/media/old.png",
        created_at: "2026-11-04T02:00:00Z",
      },
    ]);
    expect(
      subjectWithImage(changed, changed.url, "later", "other").metadata
        .versions,
    ).toHaveLength(1);
    expect(draft.metadata.versions).toEqual([]);
  });
  it("targets generation to the saved asset revision and selected view", () => {
    const draft = subjectDraft(asset);
    draft.metadata.image_model = "model-x";
    const parameters = subjectTaskParameters(
      asset,
      draft,
      { aspect_ratio: "9:16", style: "project-style" } as Project,
      "front",
    );
    expect(parameters).toMatchObject({
      asset_id: asset.id,
      asset_updated_at: asset.updated_at,
      gallery_slot: "front",
      model: "model-x",
      aspect_ratio: "9:16",
      style: "anime",
    });
  });
  it("retains generated versions that use backend kind and slot fields", () => {
    const result = subjectDraft({
      ...asset,
      metadata: {
        versions: [
          {
            id: "job",
            kind: "image",
            slot: "front",
            task_id: "task",
            url: "/media/result.png",
            created_at: "now",
          },
        ],
      },
    });
    expect(result.metadata.versions[0]).toMatchObject({
      id: "job",
      name: "生成图片 · front",
      task_id: "task",
      url: "/media/result.png",
    });
  });
  it("targets audio independently from the selected image slot", () => {
    const draft = subjectDraft(asset);
    draft.metadata.voice.model = "speech-model";
    draft.metadata.voice.description = "温柔青年女声";
    const parameters = subjectTaskParameters(
      asset,
      draft,
      { aspect_ratio: "16:9", style: "" } as Project,
      "front",
      "audio",
    );
    expect(parameters).toMatchObject({
      asset_id: asset.id,
      asset_updated_at: asset.updated_at,
      gallery_slot: "main",
      model: "speech-model",
      voice_description: "温柔青年女声",
    });
    expect(draft.metadata.gallery).toEqual([]);
  });
});
