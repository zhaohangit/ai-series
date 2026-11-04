import { describe, expect, it } from "vitest";
import { materialPresetItems } from "./domain";

describe("material preset catalogue", () => {
  it("falls back to the captured style catalogue when the API has no presets", () => {
    const styles = [{ id: "13", name: "动漫电影" }, { id: "4", name: "民俗克系" }];
    expect(materialPresetItems({ presets: [], styles })).toEqual(styles);
  });

  it("prefers an API preset catalogue when one is available", () => {
    const presets = [{ id: "preset-1", name: "我的预设" }];
    expect(materialPresetItems({ presets, styles: [{ id: "style-1" }] })).toEqual(presets);
  });
});
