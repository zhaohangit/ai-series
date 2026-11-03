import { describe, it, expect } from "vitest";
import {
  validateName,
  filterTasks,
  canvasSnapshot,
  uploadProblem,
} from "./domain";
describe("creation validation", () => {
  it("rejects blank names and preserves a trimmed name", () => {
    expect(validateName("  ")).toEqual({ error: "请输入名称" });
    expect(validateName(" 新剧集 ")).toEqual({ name: "新剧集" });
  });
  it("rejects oversized script uploads", () => {
    expect(
      uploadProblem({ name: "book.txt", size: 51 * 1024 * 1024 }, "script"),
    ).toContain("50 MB");
    expect(uploadProblem({ name: "book.txt", size: 12 }, "script")).toBe("");
    expect(uploadProblem({ name: "book.exe", size: 12 }, "script")).toContain(
      "txt",
    );
  });
});
describe("task filtering", () => {
  it("keeps export tasks in downloads and matches status", () => {
    const tasks = [
      { id: "1", kind: "export", status: "succeeded" },
      { id: "2", kind: "image", status: "failed" },
    ];
    expect(filterTasks(tasks, "download", "all").map((t) => t.id)).toEqual([
      "1",
    ]);
    expect(filterTasks(tasks, "generation", "failed").map((t) => t.id)).toEqual(
      ["2"],
    );
  });
});
describe("canvas persistence", () => {
  it("removes temporary selection state and preserves content and revision", () => {
    const shot = canvasSnapshot(
      [
        {
          id: "a",
          selected: true,
          position: { x: 1, y: 2 },
          data: { text: "hello" },
        },
      ],
      [],
      { x: 0, y: 0, zoom: 1 },
      4,
    );
    expect(shot.revision).toBe(4);
    expect(shot.nodes[0]).not.toHaveProperty("selected");
    expect(shot.nodes[0].data).toEqual({ text: "hello" });
  });
});
