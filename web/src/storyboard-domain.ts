import type { Episode, Shot } from "./types";
export type StoryboardShot = Shot & { updated_at?: string };
export type ShotPatch = Partial<
  Omit<StoryboardShot, "id" | "project_id" | "updated_at">
>;
export type ShotInput = Omit<
  StoryboardShot,
  "id" | "project_id" | "updated_at"
>;
export type ReadingOrder = "row" | "column" | "snake";
export function sortedShots(shots: Shot[]): StoryboardShot[] {
  return [...shots].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}
export function groupStoryboards(episodes: Episode[], shots: StoryboardShot[]) {
  const groups = [...episodes]
    .sort((a, b) => a.position - b.position)
    .map((e) => ({
      id: e.id,
      name: e.name,
      shots: sortedShots(shots.filter((s) => s.episode_id === e.id)),
    }));
  const ids = new Set(episodes.map((e) => e.id));
  const unassigned = sortedShots(
    shots.filter((s) => !s.episode_id || !ids.has(s.episode_id)),
  );
  if (unassigned.length || !groups.length)
    groups.push({
      id: "main",
      name: groups.length ? "未分幕镜头" : "第1幕",
      shots: unassigned,
    });
  return groups;
}
export function moveShot(
  shots: StoryboardShot[],
  id: string,
  direction: -1 | 1,
): string[] {
  const ordered = sortedShots(shots),
    ids = ordered.map((s) => s.id),
    shot = ordered.find((s) => s.id === id);
  if (!shot) return ids;
  const siblings = ordered.filter(
      (s) => (s.episode_id || "main") === (shot.episode_id || "main"),
    ),
    siblingIndex = siblings.findIndex((s) => s.id === id),
    target = siblings[siblingIndex + direction];
  if (target) {
    const index = ids.indexOf(id),
      next = ids.indexOf(target.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
  }
  return ids;
}
export function duplicateShot(
  shot: StoryboardShot,
  position: number,
): ShotInput {
  return {
    name: `${shot.name.slice(0, 195)} 副本`,
    episode_id: shot.episode_id,
    position,
    prompt: shot.prompt,
    dialogue: shot.dialogue,
    duration: shot.duration,
    image_url: shot.image_url,
    video_url: shot.video_url,
    audio_url: shot.audio_url,
    settings: structuredClone(shot.settings),
  };
}
export function gridShotInputs(
  size: 4 | 9,
  order: ReadingOrder,
  group: string,
  start: number,
  episode_id?: string,
): ShotInput[] {
  const side = Math.sqrt(size);
  return Array.from({ length: size }, (_, i) => {
    const row = Math.floor(i / side),
      column = i % side;
    const cell =
      order === "column"
        ? column * side + row
        : order === "snake" && row % 2
          ? row * side + side - 1 - column
          : i;
    return {
      name: `分镜 ${start + i + 1}`,
      episode_id,
      position: start + i,
      prompt: "",
      dialogue: "",
      duration: 5,
      settings: {
        storyboard_group: group,
        grid_size: size,
        cell_index: cell,
        reading_order: order,
      },
    };
  });
}
export interface GridUnit {
  id: string;
  size: 1 | 4 | 9;
  shots: StoryboardShot[];
}
export function gridUnits(shots: StoryboardShot[]): GridUnit[] {
  const units: GridUnit[] = [];
  for (const shot of sortedShots(shots)) {
    const settings = shot.settings,
      size = settings.grid_size,
      cell = settings.cell_index;
    if (
      typeof settings.storyboard_group !== "string" ||
      (size !== 4 && size !== 9) ||
      !Number.isInteger(cell) ||
      Number(cell) < 0 ||
      Number(cell) >= size
    ) {
      units.push({ id: shot.id, size: 1, shots: [shot] });
      continue;
    }
    const key = `${shot.episode_id || "main"}:${settings.storyboard_group}`;
    let group = units.find(
      (g) =>
        g.id === key &&
        g.size === size &&
        !g.shots.some((s) => s.settings.cell_index === cell),
    );
    if (!group) {
      group = {
        id: units.some((g) => g.id === key) ? `${key}:${shot.id}` : key,
        size,
        shots: [],
      };
      units.push(group);
    }
    group.shots.push(shot);
  }
  return units;
}
export interface StoredShotDraft {
  id: string;
  patch: ShotPatch;
  revision?: string;
}
interface WriteState {
  base: StoryboardShot;
  pending: ShotPatch;
  active: ShotPatch | null;
  promise: Promise<void> | null;
  error?: Error;
}
/** One serial writer per shot: edits arriving during a request remain pending. */
export class ShotWriteQueue {
  private rows = new Map<string, WriteState>();
  constructor(
    private persist: (
      id: string,
      patch: ShotPatch,
      revision?: string,
    ) => Promise<StoryboardShot>,
    private changed: () => void = () => {},
  ) {}
  register(shots: StoryboardShot[]) {
    for (const shot of shots) {
      const row = this.rows.get(shot.id);
      if (!row)
        this.rows.set(shot.id, {
          base: shot,
          pending: {},
          active: null,
          promise: null,
        });
      else if (!row.promise && !Object.keys(row.pending).length)
        row.base = shot;
    }
  }
  value(id: string): StoryboardShot | undefined {
    const row = this.rows.get(id);
    return row ? { ...row.base, ...row.active, ...row.pending } : undefined;
  }
  values(): StoryboardShot[] {
    return [...this.rows.keys()].map((id) => this.value(id)!);
  }
  edit(id: string, patch: ShotPatch) {
    const row = this.rows.get(id);
    if (!row) return;
    row.pending = { ...row.pending, ...patch };
    row.error = undefined;
    this.changed();
  }
  dirtyIds() {
    return [...this.rows]
      .filter(([, r]) => r.promise || Object.keys(r.pending).length)
      .map(([id]) => id);
  }
  drafts(): StoredShotDraft[] {
    return [...this.rows].flatMap(([id, row]) => {
      const patch = { ...row.active, ...row.pending };
      return Object.keys(patch).length
        ? [{ id, patch, revision: row.base.updated_at }]
        : [];
    });
  }
  restoreDrafts(drafts: StoredShotDraft[]) {
    for (const draft of drafts) {
      if (
        !draft ||
        typeof draft.id !== "string" ||
        !draft.patch ||
        typeof draft.patch !== "object" ||
        Array.isArray(draft.patch)
      )
        continue;
      const row = this.rows.get(draft.id);
      if (!row || row.promise) continue;
      row.base = { ...row.base, updated_at: draft.revision };
      row.pending = { ...draft.patch, ...row.pending };
    }
    this.changed();
  }
  error(id: string) {
    return this.rows.get(id)?.error;
  }
  forget(id: string) {
    this.rows.delete(id);
    this.changed();
  }
  rebase(shot: StoryboardShot) {
    const row = this.rows.get(shot.id);
    if (row && !row.promise) {
      row.base = shot;
      row.error = undefined;
    }
    this.changed();
  }
  flush(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve();
    if (row.promise) return row.promise;
    if (!Object.keys(row.pending).length) return Promise.resolve();
    row.promise = (async () => {
      while (Object.keys(row.pending).length) {
        const patch = row.pending;
        row.pending = {};
        row.active = patch;
        this.changed();
        try {
          row.base = await this.persist(id, patch, row.base.updated_at);
          row.error = undefined;
          row.active = null;
        } catch (error) {
          row.pending = { ...patch, ...row.pending };
          row.active = null;
          row.error = error instanceof Error ? error : new Error(String(error));
          throw row.error;
        }
      }
    })().finally(() => {
      row.promise = null;
      this.changed();
    });
    return row.promise;
  }
  async flushAll() {
    await Promise.all(this.dirtyIds().map((id) => this.flush(id)));
  }
}
