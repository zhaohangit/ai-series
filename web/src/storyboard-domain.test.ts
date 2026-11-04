import { describe, expect, it } from "vitest";
import type { Shot, Episode } from "./types";
import {
  groupStoryboards,
  moveShot,
  duplicateShot,
  gridShotInputs,
  gridUnits,
  ShotWriteQueue,
} from "./storyboard-domain";
const shot = (id: string, position = 0, extra: Partial<Shot> = {}): Shot => ({
  id,
  project_id: "p",
  name: id,
  position,
  prompt: "",
  dialogue: "",
  duration: 5,
  settings: {},
  ...extra,
});
const episode = (id: string, position: number): Episode => ({
  id,
  project_id: "p",
  name: id,
  position,
  script: "",
  settings: {},
});
describe("storyboard organization", () => {
  it("keeps empty episodes and unassigned shots without dropping any item", () => {
    const groups = groupStoryboards(
      [episode("second", 2), episode("first", 1)],
      [
        shot("a", 2),
        shot("b", 1, { episode_id: "first" }),
        shot("orphan", 3, { episode_id: "missing" }),
      ],
    );
    expect(groups.map((g) => g.id)).toEqual(["first", "second", "main"]);
    expect(groups.flatMap((g) => g.shots.map((s) => s.id))).toEqual([
      "b",
      "a",
      "orphan",
    ]);
  });
  it("reorders against the entire project list and leaves unrelated positions in place", () => {
    expect(
      moveShot([shot("a", 0), shot("x", 1), shot("b", 2)], "b", -1),
    ).toEqual(["a", "b", "x"]);
    expect(moveShot([shot("a")], "a", -1)).toEqual(["a"]);
  });
  it("moves to the next same-episode shot across interleaved episodes without changing their slots", () => {
    const shots = [
      shot("A1", 0, { episode_id: "A" }),
      shot("B1", 1, { episode_id: "B" }),
      shot("A2", 2, { episode_id: "A" }),
      shot("B2", 3, { episode_id: "B" }),
    ];
    expect(moveShot(shots, "A1", 1)).toEqual(["A2", "B1", "A1", "B2"]);
    expect(moveShot(shots, "A2", -1)).toEqual(["A2", "B1", "A1", "B2"]);
    expect(moveShot(shots, "B1", -1)).toEqual(["A1", "B1", "A2", "B2"]);
    expect(moveShot(shots, "A2", 1)).toEqual(["A1", "B1", "A2", "B2"]);
  });
  it("copies persisted media and independent settings, omitting identity/revision", () => {
    const source = {
      ...shot("a", 2, {
        image_url: "/media/a.png",
        audio_url: "/media/a.mp3",
        settings: { nested: { x: 1 } },
      }),
      updated_at: "r1",
    };
    const copy = duplicateShot(source, 3);
    expect(copy).toMatchObject({
      name: "a 副本",
      position: 3,
      image_url: "/media/a.png",
      audio_url: "/media/a.mp3",
    });
    expect(copy).not.toHaveProperty("id");
    expect(copy).not.toHaveProperty("updated_at");
    (copy.settings.nested as { x: number }).x = 2;
    expect(source.settings.nested).toEqual({ x: 1 });
  });
  it("creates atomic four/nine cell inputs in the chosen reading order", () => {
    const cells = gridShotInputs(4, "column", "g", 8, "ep");
    expect(cells.map((s) => s.settings.cell_index)).toEqual([0, 2, 1, 3]);
    expect(cells.map((s) => s.position)).toEqual([8, 9, 10, 11]);
    expect(
      cells.every(
        (s) => s.episode_id === "ep" && s.settings.storyboard_group === "g",
      ),
    ).toBe(true);
    expect(
      gridShotInputs(9, "snake", "g", 0).map((s) => s.settings.cell_index),
    ).toEqual([0, 1, 2, 5, 4, 3, 6, 7, 8]);
  });
  it("never hides repeated cell indexes or merges layouts from separate episodes", () => {
    const settings = { storyboard_group: "g", grid_size: 4, cell_index: 0 };
    const groups = gridUnits([
      shot("a", 0, { settings }),
      shot("b", 1, { settings }),
      shot("c", 2, { episode_id: "ep", settings }),
    ]);
    expect(groups.flatMap((g) => g.shots.map((s) => s.id)).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(groups).toHaveLength(3);
  });
});
describe("shot write queue", () => {
  it("preserves recoverable drafts with their original revision across editor unmounts", async () => {
    const queue = new ShotWriteQueue(async () => {
      throw Error("offline");
    });
    queue.register([{ ...shot("a"), updated_at: "r1" }]);
    queue.edit("a", { prompt: "unsaved" });
    const saved = JSON.parse(JSON.stringify(queue.drafts()));
    const calls: any[] = [];
    const reopened = new ShotWriteQueue(async (_id, patch, revision) => {
      calls.push({ patch, revision });
      return { ...shot("a"), ...patch, updated_at: "r3" };
    });
    reopened.register([{ ...shot("a"), updated_at: "r2" }]);
    reopened.restoreDrafts(saved);
    expect(reopened.value("a")?.prompt).toBe("unsaved");
    await reopened.flushAll();
    expect(calls).toEqual([{ patch: { prompt: "unsaved" }, revision: "r1" }]);
    expect(reopened.drafts()).toEqual([]);
  });
  it("clears a transient failure after a successful retry", async () => {
    let fail = true;
    const queue = new ShotWriteQueue(async (_id, patch) => {
      if (fail) throw Error("offline");
      return { ...shot("a"), ...patch };
    });
    queue.register([shot("a")]);
    queue.edit("a", { prompt: "kept" });
    await expect(queue.flush("a")).rejects.toThrow("offline");
    fail = false;
    await queue.flush("a");
    expect(queue.error("a")).toBeUndefined();
  });
  it("serializes writes and saves changes made while the prior request is in flight", async () => {
    let resolveFirst!: (s: Shot & { updated_at: string }) => void;
    const calls: any[] = [];
    const queue = new ShotWriteQueue(async (_id, patch, revision) => {
      calls.push({ patch, revision });
      if (calls.length === 1)
        return new Promise<Shot & { updated_at: string }>((resolve) => {
          resolveFirst = resolve;
        });
      return { ...shot("a"), ...patch, updated_at: "r3" };
    });
    queue.register([{ ...shot("a"), updated_at: "r1" }]);
    queue.edit("a", { prompt: "first" });
    const pending = queue.flush("a");
    queue.edit("a", { prompt: "latest", dialogue: "hello" });
    resolveFirst({ ...shot("a"), prompt: "first", updated_at: "r2" });
    await pending;
    expect(calls).toEqual([
      { patch: { prompt: "first" }, revision: "r1" },
      { patch: { prompt: "latest", dialogue: "hello" }, revision: "r2" },
    ]);
    expect(queue.dirtyIds()).toEqual([]);
  });
  it("keeps failed edits and rebases explicitly without discarding later changes", async () => {
    let fail = true;
    const seen: any[] = [];
    const queue = new ShotWriteQueue(async (_id, patch, revision) => {
      seen.push({ patch, revision });
      if (fail) throw Error("conflict");
      return { ...shot("a"), ...patch, updated_at: "r3" };
    });
    queue.register([{ ...shot("a"), updated_at: "r1" }]);
    queue.edit("a", { name: "kept" });
    await expect(queue.flush("a")).rejects.toThrow("conflict");
    queue.register([{ ...shot("a"), name: "remote", updated_at: "r2" }]);
    expect(queue.value("a")?.name).toBe("kept");
    queue.rebase({ ...shot("a"), name: "remote", updated_at: "r2" });
    fail = false;
    await queue.flush("a");
    expect(seen[1]).toEqual({ patch: { name: "kept" }, revision: "r2" });
  });
});
