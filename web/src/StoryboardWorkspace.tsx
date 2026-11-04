import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Film,
  Grid2X2,
  ImagePlus,
  LayoutGrid,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { api, json, upload } from "./api";
import type { Episode, Project } from "./types";
import {
  duplicateShot,
  gridShotInputs,
  gridUnits,
  groupStoryboards,
  moveShot,
  ShotWriteQueue,
  sortedShots,
} from "./storyboard-domain";
import type {
  GridUnit,
  ReadingOrder,
  ShotInput,
  ShotPatch,
  StoryboardShot,
} from "./storyboard-domain";
import "./storyboard-workspace.css";

type Dialog =
  | { kind: "episode" }
  | { kind: "grid"; episode: string }
  | { kind: "delete"; shot: StoryboardShot }
  | null;
export default function StoryboardWorkspace({
  project,
}: {
  project: Project;
  onProjectChange?: (project: Project) => void;
}) {
  const nav = useNavigate(),
    location = useLocation(),
    gridMode = location.pathname.includes("/storyboard-grid/");
  const [, render] = useState(0),
    [episodes, setEpisodes] = useState<Episode[]>([]),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selection, setSelection] = useState("all"),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [dialog, setDialog] = useState<Dialog>(null),
    [episodeName, setEpisodeName] = useState(""),
    [gridSize, setGridSize] = useState<4 | 9>(4),
    [readingOrder, setReadingOrder] = useState<ReadingOrder>("row");
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const draftKey = `dramabuddy:storyboard-drafts:${project.id}`;
  const queue = useMemo(
    () =>
      new ShotWriteQueue(
        async (id, patch, revision) => {
          if (patch.name !== undefined && !patch.name.trim())
            throw new Error("分镜名称不能为空，修改后将继续保存");
          if (
            patch.duration !== undefined &&
            (!Number.isFinite(patch.duration) ||
              patch.duration <= 0 ||
              patch.duration > 3600)
          )
            throw new Error("时长必须大于 0 且不超过 3600 秒");
          return api<StoryboardShot>(`/shots/${id}`, {
            method: "PATCH",
            body: json({
              ...patch,
              ...(revision ? { expected_updated_at: revision } : {}),
            }),
          });
        },
        () => {
          render((n) => n + 1);
          try {
            const drafts = queue.drafts();
            if (drafts.length)
              sessionStorage.setItem(draftKey, JSON.stringify(drafts));
            else sessionStorage.removeItem(draftKey);
          } catch {
            /* Server writes remain authoritative when storage is unavailable. */
          }
        },
      ),
    [project.id],
  );
  const shots = queue.values(),
    groups = groupStoryboards(episodes, shots),
    dirty = queue.dirtyIds();
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    setSelection("all");
    Promise.all([
      api<{ items: Episode[] }>(`/projects/${project.id}/episodes`),
      api<{ items: StoryboardShot[] }>(`/projects/${project.id}/shots`),
    ])
      .then(([e, s]) => {
        if (active) {
          setEpisodes(e.items);
          queue.register(s.items);
          try {
            const drafts = JSON.parse(sessionStorage.getItem(draftKey) || "[]");
            if (Array.isArray(drafts) && drafts.length) {
              queue.restoreDrafts(drafts);
              void queue.flushAll().catch(() => {});
            }
          } catch {
            /* Ignore invalid local drafts without changing server data. */
          }
          render((n) => n + 1);
        }
      })
      .catch((e) => {
        if (active) setLoadError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      void queue.flushAll().catch(() => {});
    };
  }, [project.id, queue]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (queue.dirtyIds().length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [queue]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = dialogRef.current;
    const controls = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
        ) || [],
      );
    (
      panel?.querySelector<HTMLElement>("[autofocus]") || controls()[0]
    )?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        setDialog(null);
      }
      if (e.key !== "Tab") return;
      const items = controls(),
        first = items[0],
        last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    panel?.addEventListener("keydown", keydown);
    return () => {
      panel?.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [dialog, busy]);
  function edit(id: string, patch: ShotPatch) {
    queue.edit(id, patch);
    const prior = timers.current.get(id);
    if (prior) clearTimeout(prior);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        void queue.flush(id).catch(() => {});
      }, 650),
    );
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveAll() {
    await queue.flushAll();
  }
  async function retry(id: string) {
    await perform(async () => {
      const response = await api<{ items: StoryboardShot[] }>(
        `/projects/${project.id}/shots`,
      );
      const fresh = response.items.find((s) => s.id === id);
      if (!fresh) throw Error("该分镜已被删除，请重新打开项目核对");
      queue.rebase(fresh);
      await queue.flush(id);
    });
  }
  const nextPosition = () =>
    Math.max(-1, ...queue.values().map((s) => s.position)) + 1;
  async function createShot(episode: string, input?: ShotInput) {
    await perform(async () => {
      await saveAll();
      const created = await api<StoryboardShot>(
        `/projects/${project.id}/shots`,
        {
          method: "POST",
          body: json(
            input || {
              name: `分镜 ${queue.values().length + 1}`,
              position: nextPosition(),
              episode_id: episode === "main" ? null : episode,
              prompt: "",
              dialogue: "",
              duration: 5,
              settings: {},
            },
          ),
        },
      );
      queue.register([created]);
      render((n) => n + 1);
    });
  }
  async function createEpisode() {
    await perform(async () => {
      if (!episodeName.trim()) throw Error("请输入幕名称");
      const created = await api<Episode>(`/projects/${project.id}/episodes`, {
        method: "POST",
        body: json({
          name: episodeName.trim(),
          position: Math.max(-1, ...episodes.map((e) => e.position)) + 1,
          script: "",
          settings: {},
        }),
      });
      setEpisodes((e) => [...e, created]);
      setSelection(created.id);
      setDialog(null);
    });
  }
  async function createGrid() {
    if (dialog?.kind !== "grid") return;
    const episode = dialog.episode;
    await perform(async () => {
      await saveAll();
      const cells = gridShotInputs(
        gridSize,
        readingOrder,
        crypto.randomUUID(),
        nextPosition(),
        episode === "main" ? undefined : episode,
      );
      const response = await api<{ items: StoryboardShot[] }>(
        `/projects/${project.id}/shots/batch`,
        { method: "POST", body: json({ shots: cells }) },
      );
      queue.register(response.items);
      render((n) => n + 1);
      setDialog(null);
    });
  }
  async function cloneShot(shot: StoryboardShot) {
    await perform(async () => {
      await saveAll();
      const source = queue.value(shot.id)!;
      const input = duplicateShot(source, nextPosition());
      if (typeof input.settings.storyboard_group === "string")
        input.settings.storyboard_group = crypto.randomUUID();
      const created = await api<StoryboardShot>(
        `/projects/${project.id}/shots`,
        { method: "POST", body: json(input) },
      );
      queue.register([created]);
      render((n) => n + 1);
    });
  }
  async function cloneGrid(unit: GridUnit) {
    await perform(async () => {
      await saveAll();
      const group = crypto.randomUUID(),
        start = nextPosition();
      const cells = unit.shots.map((shot, i) => {
        const input = duplicateShot(queue.value(shot.id)!, start + i);
        input.settings.storyboard_group = group;
        return input;
      });
      const response = await api<{ items: StoryboardShot[] }>(
        `/projects/${project.id}/shots/batch`,
        { method: "POST", body: json({ shots: cells }) },
      );
      queue.register(response.items);
      render((n) => n + 1);
    });
  }
  async function removeShot(shot: StoryboardShot) {
    await perform(async () => {
      await queue.flush(shot.id);
      await api(`/shots/${shot.id}`, { method: "DELETE" });
      queue.forget(shot.id);
      setDialog(null);
    });
  }
  async function reorder(shot: StoryboardShot, direction: -1 | 1) {
    await perform(async () => {
      await saveAll();
      const ids = moveShot(queue.values(), shot.id, direction);
      const response = await api<{ items: StoryboardShot[] }>(
        `/projects/${project.id}/shots/order`,
        { method: "PUT", body: json({ ids }) },
      );
      queue.register(response.items);
      render((n) => n + 1);
    });
  }
  async function openShot(shot: StoryboardShot) {
    await perform(async () => {
      await saveAll();
      nav(`/edit/${project.id}/${shot.episode_id || "main"}/${shot.id}`);
    });
  }
  async function switchMode(grid: boolean) {
    await perform(async () => {
      await saveAll();
      nav(`/${grid ? "storyboard-grid" : "storyboard"}/${project.id}`);
    });
  }
  async function uploadImage(shot: StoryboardShot, file?: File) {
    if (!file) return;
    await perform(async () => {
      if (!file.type.startsWith("image/")) throw Error("请选择图片文件");
      if (file.size > 20 * 1024 * 1024) throw Error("图片不能超过 20 MB");
      const result = await upload(file);
      edit(shot.id, { image_url: result.url });
      await queue.flush(shot.id);
    });
  }
  async function addCell(unit: GridUnit, index: number, episode: string) {
    const template = unit.shots[0];
    await createShot(episode, {
      name: `分镜 ${queue.values().length + 1}`,
      position: nextPosition(),
      episode_id: template.episode_id,
      prompt: "",
      dialogue: "",
      duration: 5,
      settings: { ...template.settings, cell_index: index },
    });
  }
  async function exportGrid(unit: GridUnit) {
    await perform(async () => {
      await saveAll();
      await downloadContactSheet(
        { ...unit, shots: unit.shots.map((s) => queue.value(s.id)!) },
        project.name,
      );
    });
  }
  function renderShot(shot: StoryboardShot, compact = false) {
    const position = sortedShots(shots).findIndex((s) => s.id === shot.id),
      siblings = sortedShots(
        shots.filter(
          (s) => (s.episode_id || "main") === (shot.episode_id || "main"),
        ),
      ),
      siblingPosition = siblings.findIndex((s) => s.id === shot.id),
      saveError = queue.error(shot.id),
      pending = dirty.includes(shot.id);
    return (
      <article
        className={`sb-shot${compact ? " sb-shot-compact" : ""}`}
        key={shot.id}
        aria-label={shot.name}
      >
        <button
          className="sb-shot-preview"
          aria-label={`编辑镜头 ${shot.name}`}
          onClick={() => void openShot(shot)}
          disabled={busy}
          style={{
            aspectRatio: project.aspect_ratio === "9:16" ? "9 / 12" : "16 / 10",
          }}
        >
          {shot.image_url ? (
            <img src={shot.image_url} alt={shot.name} />
          ) : shot.video_url ? (
            <video src={shot.video_url} muted preload="metadata" />
          ) : (
            <span>
              <Film size={26} />
              <span>编辑镜头 · 添加素材</span>
            </span>
          )}
          <span className="sb-shot-number">镜头 {position + 1}</span>
          <span className="sb-shot-seconds">{shot.duration} 秒</span>
        </button>
        <div className="sb-shot-content">
          <label className="sb-shot-title">
            <span className="sb-sr-only">分镜名称</span>
            <input
              aria-label={`分镜名称 ${shot.id}`}
              value={shot.name}
              maxLength={200}
              onChange={(e) => edit(shot.id, { name: e.target.value })}
            />
          </label>
          <label className="sb-field">
            <span>画面提示词</span>
            <textarea
              aria-label={`画面提示词 ${shot.name}`}
              placeholder="暂无提示词，描述画面、人物和镜头…"
              value={shot.prompt}
              maxLength={50000}
              rows={compact ? 2 : 3}
              onChange={(e) => edit(shot.id, { prompt: e.target.value })}
            />
          </label>
          <details className="sb-shot-details">
            <summary>
              台词与时长 {shot.dialogue && <span>· 已填写台词</span>}
            </summary>
            <label className="sb-field">
              <span>台词</span>
              <textarea
                aria-label={`台词 ${shot.name}`}
                value={shot.dialogue}
                maxLength={50000}
                rows={2}
                placeholder="输入台词或旁白"
                onChange={(e) => edit(shot.id, { dialogue: e.target.value })}
              />
            </label>
            <label className="sb-duration">
              时长（秒）
              <input
                type="number"
                aria-label={`时长 ${shot.name}`}
                min="0.1"
                max="3600"
                step="0.1"
                value={shot.duration}
                onChange={(e) =>
                  edit(shot.id, { duration: Number(e.target.value) })
                }
              />
            </label>
          </details>
          <div className="sb-shot-save" role="status">
            {saveError ? (
              <span className="sb-error-text">
                保存失败：{saveError.message}{" "}
                <button onClick={() => void retry(shot.id)} disabled={busy}>
                  保留编辑重试
                </button>
              </span>
            ) : pending ? (
              <span>
                <LoaderCircle size={12} /> 待保存
              </span>
            ) : (
              <span>
                <Check size={12} /> 已保存
              </span>
            )}
          </div>
          <div className="sb-shot-actions">
            <label className="sb-upload" title="上传镜头图片">
              <ImagePlus size={15} />
              <span>上传图片</span>
              <input
                type="file"
                accept="image/*"
                aria-label={`上传图片 ${shot.name}`}
                disabled={busy}
                onChange={(e) => {
                  void uploadImage(shot, e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              aria-label={`上移 ${shot.name}`}
              title="在当前幕中上移"
              disabled={busy || siblingPosition === 0}
              onClick={() => void reorder(shot, -1)}
            >
              <ArrowUp size={15} />
            </button>
            <button
              aria-label={`下移 ${shot.name}`}
              title="在当前幕中下移"
              disabled={busy || siblingPosition === siblings.length - 1}
              onClick={() => void reorder(shot, 1)}
            >
              <ArrowDown size={15} />
            </button>
            <button
              aria-label={`复制 ${shot.name}`}
              title="复制分镜（含素材）"
              disabled={busy}
              onClick={() => void cloneShot(shot)}
            >
              <Copy size={15} />
            </button>
            <button
              aria-label={`删除 ${shot.name}`}
              title="删除镜头"
              disabled={busy}
              onClick={() => setDialog({ kind: "delete", shot })}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      </article>
    );
  }
  if (loading)
    return (
      <div className="sb-state" role="status">
        <LoaderCircle className="sb-spin" /> 正在加载分镜…
      </div>
    );
  if (loadError)
    return (
      <div className="sb-state" role="alert">
        加载失败：{loadError}
        <button onClick={() => window.location.reload()}>重新加载</button>
      </div>
    );
  return (
    <div className="sb-workspace">
      <aside className="sb-scenes" aria-label="分幕导航">
        <div className="sb-scenes-title">
          <strong>共 {groups.length} 幕</strong>
          <button
            title="新增幕"
            aria-label="新增幕"
            disabled={busy}
            onClick={() => {
              setEpisodeName(`第${episodes.length + 1}幕`);
              setDialog({ kind: "episode" });
            }}
          >
            <Plus size={18} />
          </button>
        </div>
        <button
          className={selection === "all" ? "sb-scene selected" : "sb-scene"}
          onClick={() => setSelection("all")}
        >
          全部镜头 <span>{shots.length}</span>
        </button>
        {groups.map((g) => (
          <button
            key={g.id}
            className={selection === g.id ? "sb-scene selected" : "sb-scene"}
            onClick={() => setSelection(g.id)}
          >
            <span>{g.name}</span>
            <small>{g.shots.length}</small>
          </button>
        ))}
        <p className="sb-sidebar-help">
          按幕组织分镜
          <br />
          点击画面进入镜头编辑
        </p>
      </aside>
      <main className="sb-main">
        <div className="sb-toolbar">
          <div className="sb-mode" aria-label="分镜布局">
            <button
              className={!gridMode ? "active" : ""}
              disabled={busy}
              onClick={() => void switchMode(false)}
            >
              <LayoutGrid size={16} /> 漫剧分镜
            </button>
            <button
              className={gridMode ? "active" : ""}
              disabled={busy}
              onClick={() => void switchMode(true)}
            >
              <Grid2X2 size={16} /> 剧情多宫格
            </button>
          </div>
          <span className="sb-total">
            {shots.length} 个镜头 ·{" "}
            {shots.reduce((sum, s) => sum + s.duration, 0).toFixed(1)} 秒
          </span>
          <button
            className="sb-save-all"
            disabled={busy || !dirty.length}
            onClick={() => void perform(saveAll)}
          >
            <Save size={15} />
            {dirty.length ? `保存 ${dirty.length} 个镜头` : "全部已保存"}
          </button>
        </div>
        {error && (
          <div className="sb-error-banner" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {gridMode && (
          <p className="sb-manual-note">
            手动多宫格：选择 4 宫格或 9 宫格，逐格编辑、上传图片并导出
            PNG。这里不调用原站私有的 AI 剧情分镜。
          </p>
        )}
        {groups
          .filter((g) => selection === "all" || selection === g.id)
          .map((group) => (
            <section
              key={group.id}
              className="sb-section"
              aria-label={group.name}
            >
              <header className="sb-section-header">
                <h2>
                  {group.name}
                  <span>{group.shots.length} 个镜头</span>
                </h2>
                <button
                  className="sb-collapse"
                  aria-expanded={!collapsed.has(group.id)}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(group.id) ? (
                    <ChevronRight size={16} />
                  ) : (
                    <ChevronDown size={16} />
                  )}{" "}
                  {collapsed.has(group.id) ? "展开" : "收起"}
                </button>
                <div className="sb-section-add">
                  {gridMode && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setDialog({ kind: "grid", episode: group.id });
                      }}
                    >
                      <Grid2X2 size={16} /> 新增多宫格
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => void createShot(group.id)}
                  >
                    <Plus size={17} /> 新增镜头
                  </button>
                </div>
              </header>
              {!collapsed.has(group.id) &&
                (!group.shots.length ? (
                  <div className="sb-empty">
                    <Film size={36} />
                    <h3>这一幕还没有镜头</h3>
                    <p>从一个镜头开始，填写画面提示词并上传素材。</p>
                    <button
                      className="sb-primary"
                      disabled={busy}
                      onClick={() =>
                        gridMode
                          ? setDialog({ kind: "grid", episode: group.id })
                          : void createShot(group.id)
                      }
                    >
                      <Plus size={16} />
                      {gridMode ? "创建多宫格" : "新增镜头"}
                    </button>
                  </div>
                ) : gridMode ? (
                  <div className="sb-grid-units">
                    {gridUnits(group.shots).map((unit, index) =>
                      unit.size === 1 ? (
                        <div className="sb-single-grid" key={unit.id}>
                          {renderShot(unit.shots[0])}
                        </div>
                      ) : (
                        <div className="sb-layout" key={unit.id}>
                          <div className="sb-layout-header">
                            <strong>
                              {unit.size} 宫格 <span>#{index + 1}</span>
                            </strong>
                            <span>
                              {unit.shots.length}/{unit.size} 个镜头
                            </span>
                            <button
                              disabled={busy}
                              onClick={() => void cloneGrid(unit)}
                            >
                              <Copy size={14} /> 复制组
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => void exportGrid(unit)}
                            >
                              <Download size={14} /> 导出 PNG
                            </button>
                          </div>
                          <div className={`sb-cells sb-cells-${unit.size}`}>
                            {Array.from({ length: unit.size }, (_, i) => {
                              const cell = unit.shots.find(
                                (s) => s.settings.cell_index === i,
                              );
                              return cell ? (
                                renderShot(cell, true)
                              ) : (
                                <button
                                  className="sb-empty-cell"
                                  key={`empty-${i}`}
                                  disabled={busy}
                                  onClick={() =>
                                    void addCell(unit, i, group.id)
                                  }
                                >
                                  <Plus size={22} /> 补充第 {i + 1} 格
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                ) : (
                  <div className="sb-shot-list">
                    {group.shots.map((s) => renderShot(s))}
                  </div>
                ))}
            </section>
          ))}
        <p className="sb-footer-note">
          镜头文字与编排自动保存 ·
          生成素材请进入镜头编辑器，实际可用性取决于已配置的模型服务
        </p>
      </main>
      {dialog && (
        <div
          className="sb-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setDialog(null);
          }}
        >
          <div
            className="sb-modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sb-dialog-title"
          >
            <button
              className="sb-modal-close"
              aria-label="关闭弹窗"
              disabled={busy}
              onClick={() => setDialog(null)}
            >
              <X size={20} />
            </button>
            <h2 id="sb-dialog-title">
              {dialog.kind === "episode"
                ? "新增幕"
                : dialog.kind === "grid"
                  ? "创建手动多宫格"
                  : "删除镜头"}
            </h2>
            {dialog.kind === "episode" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void createEpisode();
                }}
              >
                <label className="sb-field">
                  <span>幕名称</span>
                  <input
                    autoFocus
                    aria-label="幕名称"
                    value={episodeName}
                    maxLength={200}
                    onChange={(e) => setEpisodeName(e.target.value)}
                  />
                </label>
                <div className="sb-modal-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDialog(null)}
                  >
                    取消
                  </button>
                  <button
                    className="sb-primary"
                    disabled={busy || !episodeName.trim()}
                  >
                    创建幕
                  </button>
                </div>
              </form>
            ) : dialog.kind === "grid" ? (
              <>
                <p>每一格会保存为独立镜头，图片与提示词可分别编辑。</p>
                <div className="sb-grid-options">
                  {([4, 9] as const).map((size) => (
                    <button
                      aria-pressed={gridSize === size}
                      className={gridSize === size ? "selected" : ""}
                      key={size}
                      onClick={() => setGridSize(size)}
                    >
                      <span className={`sb-grid-option sb-grid-option-${size}`}>
                        {Array.from({ length: size }, (_, i) => (
                          <i key={i} />
                        ))}
                      </span>
                      {size} 宫格
                    </button>
                  ))}
                </div>
                <label className="sb-field">
                  <span>镜头阅读顺序</span>
                  <select
                    aria-label="镜头阅读顺序"
                    value={readingOrder}
                    onChange={(e) =>
                      setReadingOrder(e.target.value as ReadingOrder)
                    }
                  >
                    <option value="row">横向：从左到右，从上到下</option>
                    <option value="column">纵向：从上到下，从左到右</option>
                    <option value="snake">蛇形：逐行往返</option>
                  </select>
                </label>
                <div className="sb-modal-actions">
                  <button disabled={busy} onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    className="sb-primary"
                    disabled={busy}
                    onClick={() => void createGrid()}
                  >
                    创建 {gridSize} 个镜头
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  确认删除「{dialog.shot.name}
                  」？该镜头的提示词、台词及素材关联将被移除。
                </p>
                <div className="sb-modal-actions">
                  <button disabled={busy} onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    className="sb-danger"
                    disabled={busy}
                    onClick={() => void removeShot(dialog.shot)}
                  >
                    确认删除
                  </button>
                </div>
              </>
            )}
            {busy && (
              <p className="sb-modal-progress" role="status">
                <LoaderCircle size={14} className="sb-spin" /> 正在保存…
              </p>
            )}
            {error && (
              <p className="sb-error-text" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

async function downloadContactSheet(unit: GridUnit, name: string) {
  const side = Math.sqrt(unit.size),
    cellWidth = 640,
    cellHeight = 440,
    gutter = 12,
    title = 64;
  const canvas = document.createElement("canvas");
  canvas.width = side * cellWidth + (side + 1) * gutter;
  canvas.height = side * cellHeight + (side + 1) * gutter + title;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("浏览器无法创建图片画布");
  const images = await Promise.all(
    Array.from({ length: unit.size }, async (_, i) => {
      const shot = unit.shots.find((s) => s.settings.cell_index === i);
      if (!shot?.image_url) return null;
      const url = new URL(shot.image_url, window.location.origin);
      if (url.origin !== window.location.origin)
        throw Error("请先将外部图片上传到本地，再导出多宫格");
      return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () =>
          reject(Error(`第 ${i + 1} 格图片无法读取，请重新上传`));
        image.src = url.href;
      });
    }),
  );
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#eeeeee";
  ctx.font = "26px sans-serif";
  ctx.fillText(`${name.slice(0, 45)} · ${unit.size} 宫格`, gutter, title - 20);
  for (let i = 0; i < unit.size; i++) {
    const x = gutter + (i % side) * (cellWidth + gutter),
      y = title + gutter + Math.floor(i / side) * (cellHeight + gutter),
      image = images[i],
      shot = unit.shots.find((s) => s.settings.cell_index === i);
    ctx.fillStyle = "#222222";
    ctx.fillRect(x, y, cellWidth, cellHeight);
    if (image) {
      const scale = Math.min(
          cellWidth / image.naturalWidth,
          (cellHeight - 40) / image.naturalHeight,
        ),
        w = image.naturalWidth * scale,
        h = image.naturalHeight * scale;
      ctx.drawImage(
        image,
        x + (cellWidth - w) / 2,
        y + (cellHeight - 40 - h) / 2,
        w,
        h,
      );
    } else {
      ctx.fillStyle = "#aaaaaa";
      ctx.font = "24px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`空白镜头 ${i + 1}`, x + cellWidth / 2, y + cellHeight / 2);
      ctx.textAlign = "left";
    }
    ctx.fillStyle = "#eeeeee";
    ctx.font = "20px sans-serif";
    ctx.fillText(
      `${i + 1}. ${shot?.name || "未添加镜头"}`.slice(0, 35),
      x + 12,
      y + cellHeight - 12,
    );
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(Error("图片导出失败"))),
      "image/png",
    ),
  );
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[\\/:*?"<>|]/g, "_")}-${unit.size}宫格.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
