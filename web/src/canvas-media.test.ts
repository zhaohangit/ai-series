import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasTaskMediaURL, watchCanvasMediaTask } from "./CanvasEditor";
import type { Task } from "./types";
import {
  canvasMediaBaseline,
  canvasMediaTarget,
  canApplyCanvasMediaResult,
} from "./canvas-media";
import type { CanvasGraph } from "./canvas-commands";

const graph: CanvasGraph = {
  nodes: [
    {
      id: "source",
      type: "media",
      position: { x: 20, y: 30 },
      data: {
        label: "视频",
        kind: "video",
        text: "保留",
        url: "/media/source.mp4",
      },
    },
  ],
  edges: [],
};
const viewport = { x: 20, y: 10, zoom: 0.7 };
describe("canvas media submission and completion guards", () => {
  it("targets a saved owned-media node with an explicit linked-output mode", () => {
    expect(canvasMediaTarget(graph, "source", "/media/source.mp4", 3)).toEqual({
      node_id: "source",
      canvas_revision: 3,
      output_node: true,
    });
    expect(() =>
      canvasMediaTarget(graph, "missing", "/media/source.mp4", 3),
    ).toThrow();
    expect(() =>
      canvasMediaTarget(graph, "source", "/media/other.mp4", 3),
    ).toThrow();
    expect(() =>
      canvasMediaTarget(
        {
          ...graph,
          nodes: [
            {
              ...graph.nodes[0],
              data: {
                ...graph.nodes[0].data,
                url: "https://example.com/movie.mp4",
              },
            },
          ],
        },
        "source",
        "https://example.com/movie.mp4",
        3,
      ),
    ).toThrow();
  });
  it("does not reload over newer local edits, viewport changes or revisions", () => {
    const baseline = canvasMediaBaseline(graph, viewport, 3);
    expect(canApplyCanvasMediaResult(baseline, graph, viewport, 3)).toBe(true);
    expect(
      canApplyCanvasMediaResult(
        baseline,
        {
          ...graph,
          nodes: [
            {
              ...graph.nodes[0],
              data: { ...graph.nodes[0].data, text: "新编辑" },
            },
          ],
        },
        viewport,
        3,
      ),
    ).toBe(false);
    expect(
      canApplyCanvasMediaResult(baseline, graph, { ...viewport, x: 40 }, 3),
    ).toBe(false);
    expect(canApplyCanvasMediaResult(baseline, graph, viewport, 4)).toBe(false);
    expect(canApplyCanvasMediaResult(null, graph, viewport, 3)).toBe(false);
  });
  it("selection alone does not invalidate a media result", () => {
    const baseline = canvasMediaBaseline(graph, viewport, 3);
    expect(
      canApplyCanvasMediaResult(
        baseline,
        { ...graph, nodes: [{ ...graph.nodes[0], selected: true }] },
        viewport,
        3,
      ),
    ).toBe(true);
  });
});

describe("canvas-owned media task watcher", () => {
  afterEach(() => vi.useRealTimers());
  const queued: Task = {
    id: "processing-task",
    kind: "image",
    status: "queued",
    progress: 0,
    result: {},
    created_at: "now",
  };
  const succeeded: Task = {
    ...queued,
    status: "succeeded",
    progress: 100,
    result: { url: "/media/cropped.png" },
  };
  it("offers history results only for succeeded local media paths", () => {
    expect(
      canvasTaskMediaURL({
        ...succeeded,
        result: { url: "/media/owner/cropped.png" },
      }),
    ).toBe("/media/owner/cropped.png");
    for (const url of [
      "javascript:alert(1)",
      "https://external.test/x.png",
      "//external.test/x.png",
      "/media/../x",
      "/media/owner/../x",
      "/media/owner/x.png?token=secret",
      "/media/owner/%2e%2e",
    ]) {
      expect(canvasTaskMediaURL({ ...succeeded, result: { url } })).toBe("");
    }
    expect(
      canvasTaskMediaURL({
        ...queued,
        result: { url: "/media/owner/pending.png" },
      }),
    ).toBe("");
  });
  it("retains its submitted baseline and applies a result only once", async () => {
    vi.useFakeTimers();
    const baseline = canvasMediaBaseline(graph, viewport, 3);
    const received: unknown[] = [];
    const watch = watchCanvasMediaTask(queued, baseline, {
      current: () => true,
      read: async () => succeeded,
      complete: (task, snapshot) => {
        received.push({ id: task.id, snapshot });
      },
      failed: () => {},
      unavailable: () => {},
      stopped: () => {},
    });
    baseline.revision = 99;
    await vi.advanceTimersByTimeAsync(4000);
    expect(received).toEqual([
      { id: queued.id, snapshot: { ...baseline, revision: 3 } },
    ]);
    watch.stop();
  });
  it("ignores delayed completion after navigation and prevents overlapping reads", async () => {
    vi.useFakeTimers();
    let resolve: (task: Task) => void = () => {};
    const delayed = new Promise<Task>((done) => {
      resolve = done;
    });
    let current = true,
      reads = 0,
      completions = 0;
    const watch = watchCanvasMediaTask(
      queued,
      canvasMediaBaseline(graph, viewport, 3),
      {
        current: () => current,
        read: () => {
          reads++;
          return delayed;
        },
        complete: () => {
          completions++;
        },
        failed: () => {},
        unavailable: () => {},
        stopped: () => {},
      },
    );
    await vi.advanceTimersByTimeAsync(4000);
    expect(reads).toBe(1);
    current = false;
    resolve(succeeded);
    await vi.advanceTimersByTimeAsync(4000);
    expect(completions).toBe(0);
    expect(reads).toBe(1);
    watch.stop();
  });
  it("retries a transient status read without dropping accepted work", async () => {
    vi.useFakeTimers();
    let reads = 0,
      completions = 0,
      warnings = 0;
    const watch = watchCanvasMediaTask(
      queued,
      canvasMediaBaseline(graph, viewport, 3),
      {
        current: () => true,
        read: async () => {
          if (++reads === 1) throw new Error("network interrupted");
          return succeeded;
        },
        complete: () => {
          completions++;
        },
        failed: () => {},
        unavailable: () => {
          warnings++;
        },
        stopped: () => {},
      },
    );
    await vi.advanceTimersByTimeAsync(4000);
    expect({ reads, completions, warnings }).toEqual({
      reads: 2,
      completions: 1,
      warnings: 1,
    });
    watch.stop();
  });
});
