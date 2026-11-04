import { describe, expect, it } from "vitest";
import { editorStepLabels, taskStatusLabel } from "./ProjectEditor";
import { mediaEmptyLabel, providerLabel } from "./ShotEditor";

describe("DramaBuddy editor UI labels", () => {
  it("uses the four production workflow steps after script editing", () => {
    expect(editorStepLabels("style")).toEqual([
      "风格设置",
      "角色场景",
      "漫剧分镜",
      "视频预览",
    ]);
  });

  it("localizes task statuses while preserving unavailable provider states", () => {
    expect(taskStatusLabel("queued")).toBe("排队中");
    expect(taskStatusLabel("running")).toBe("生成中");
    expect(taskStatusLabel("failed")).toBe("失败");
    expect(providerLabel(false)).toBe("服务未配置 · 提交不扣费");
  });

  it("describes empty media by the selected medium", () => {
    expect(mediaEmptyLabel("image")).toContain("暂无预览图");
    expect(mediaEmptyLabel("video")).toContain("暂无预览视频");
    expect(mediaEmptyLabel("audio")).toContain("暂无预览音频");
  });
});
