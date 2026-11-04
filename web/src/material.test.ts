import { describe, it, expect } from "vitest";
import catalogue from "../public/reference/material-presets.json";

describe("captured material collections", () => {
  it("keeps actual role-library identities and counts separate from drawing styles", () => {
    expect(catalogue.collections).toHaveLength(14);
    expect(
      catalogue.collections.reduce((total, c) => total + c.items.length, 0),
    ).toBe(146);
    const first = catalogue.collections.find((c) => c.id === "101")!;
    expect(first.name).toBe("民俗克系");
    expect(first.material_count).toBe(8);
    expect(first.items[0].name).toBe("小邪童");
    expect(first.items[0].url).toMatch(/^\/reference\/preset-/);
    expect(catalogue.collections.find((c) => c.id === "108")?.name).toBe(
      "年代海报",
    );
  });
  it("never publishes signed access queries or credentials in cached metadata", () => {
    const serialized = JSON.stringify(catalogue);
    expect(serialized).not.toMatch(
      /q-signature=|q-sign-key-time=|X-Amz-Credential=|Bearer /i,
    );
    expect(
      catalogue.collections.every((c) => c.items.length === c.material_count),
    ).toBe(true);
  });
});
