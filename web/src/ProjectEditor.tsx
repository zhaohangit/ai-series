import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  Save,
  FileText,
  Film,
  Users,
  Palette,
  LayoutGrid,
  Sparkles,
  Upload,
  Trash2,
  Play,
  History,
  Download,
  LoaderCircle,
  Image as ImageIcon,
  Volume2,
  Video,
  Check,
  Settings,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import StyleWorkspace from "./StyleWorkspace";
import SubjectWorkspace from "./SubjectWorkspace";
import StoryboardWorkspace from "./StoryboardWorkspace";
import { api, json, upload } from "./api";
import { useApp, useResource, Loading, ErrorPanel, Empty, Modal } from "./App";
import type { Project, Episode, Shot, Asset, Task } from "./types";
const editorTabs = [
  { id: "script", label: "剧本创作", icon: FileText },
  { id: "style", label: "风格设置", icon: Palette },
  { id: "subject", label: "角色场景", icon: Users },
  { id: "work", label: "分镜创作", icon: Film },
];
const workflowTabs = [
  { id: "style", label: "风格设置", icon: Palette },
  { id: "subject", label: "角色场景", icon: Users },
  { id: "work", label: "漫剧分镜", icon: Film },
  { id: "video", label: "视频预览", icon: Video },
];
export function editorStepLabels(tab: string) {
  return (tab === "script" ? editorTabs : workflowTabs).map(
    (step) => step.label,
  );
}
export function taskStatusLabel(status: string) {
  return (
    (
      {
        queued: "排队中",
        running: "生成中",
        succeeded: "已完成",
        failed: "失败",
        canceled: "已取消",
      } as Record<string, string>
    )[status] || status
  );
}
export default function ProjectEditor() {
  const params = useParams(),
    id = params.id || params.seriesId || params.shotProjectId || "",
    nav = useNavigate(),
    location = useLocation(),
    { notify, catalog, session, refreshSession } = useApp();
  const {
    data: project,
    setData: setProject,
    loading,
    error,
    refresh,
  } = useResource<Project | null>(`/projects/${id}`, null);
  const { data: episodes, refresh: refreshEpisodes } = useResource<{
    items: Episode[];
  }>(`/projects/${id}/episodes`, { items: [] });
  const { data: shots, refresh: refreshShots } = useResource<{ items: Shot[] }>(
    `/projects/${id}/shots`,
    { items: [] },
  );
  const { data: assets, refresh: refreshAssets } = useResource<{
    items: Asset[];
  }>("/assets", { items: [] });
  const [tab, setTab] = useState(
      location.pathname.includes("/style/")
        ? "style"
        : location.pathname.includes("/subject/") ||
            location.pathname.includes("/roleAndScene/")
          ? "subject"
          : location.pathname.includes("/work/") ||
              location.pathname.includes("/storyboard")
            ? "work"
            : "script",
    ),
    [saving, setSaving] = useState(false),
    [dirty, setDirty] = useState(false),
    [selectedEpisode, setSelectedEpisode] = useState(""),
    [modal, setModal] = useState(""),
    [taskKind, setTaskKind] = useState("image"),
    [prompt, setPrompt] = useState(""),
    [targetShot, setTargetShot] = useState<Shot | null>(null),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<Task[]>([]),
    [exportFormat, setExportFormat] = useState("json"),
    [shotView, setShotView] = useState("grid"),
    [selectedAsset, setSelectedAsset] = useState("character");
  const latestProject = useRef(project);
  latestProject.current = project;
  useEffect(() => {
    setTab(
      location.pathname.includes("/style/")
        ? "style"
        : location.pathname.includes("/subject/") ||
            location.pathname.includes("/roleAndScene/")
          ? "subject"
          : location.pathname.includes("/work/") ||
              location.pathname.includes("/storyboard")
            ? "work"
            : "script",
    );
  }, [location.pathname]);
  async function save(announce = true) {
    if (!latestProject.current) return;
    setSaving(true);
    try {
      const current = latestProject.current;
      const snapshot = {
        name: current.name,
        script: current.script,
        description: current.description,
        style: current.style,
        aspect_ratio: current.aspect_ratio,
        settings: current.settings,
      };
      const stored = await api<Project>(`/projects/${id}`, {
        method: "PATCH",
        body: json({ ...snapshot, expected_updated_at: current.updated_at }),
      });
      setProject((latest) =>
        latest ? { ...latest, updated_at: stored.updated_at } : latest,
      );
      const latest = latestProject.current;
      setDirty(
        !latest ||
          JSON.stringify(snapshot) !==
            JSON.stringify({
              name: latest.name,
              script: latest.script,
              description: latest.description,
              style: latest.style,
              aspect_ratio: latest.aspect_ratio,
              settings: latest.settings,
            }),
      );
      if (announce) notify("作品已保存");
    } catch (e) {
      notify((e as Error).message, "error");
      throw e;
    } finally {
      setSaving(false);
    }
  }
  function update(patch: Partial<Project>) {
    if (project) setProject({ ...project, ...patch });
    setDirty(true);
  }
  async function goStep(step: string) {
    if (saving) return;
    try {
      if (dirty) await save(false);
      const routes: Record<string, string> = {
        style: `/style/${id}`,
        subject: `/roleAndScene/${id}`,
        work: `/storyboard/${id}`,
        video: `/video/preview/${id}`,
        script: `/project/${id}`,
      };
      nav(routes[step] || `/project/${id}`);
    } catch {
      /* save keeps the error and user input visible */
    }
  }
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function addEpisode() {
    const name = window.prompt("分集名称", `第${episodes.items.length + 1}集`);
    if (!name?.trim()) return;
    try {
      const e = await api<Episode>(`/projects/${id}/episodes`, {
        method: "POST",
        body: json({
          name: name.trim(),
          position: episodes.items.length,
          script: "",
        }),
      });
      refreshEpisodes();
      setSelectedEpisode(e.id);
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  async function parse() {
    if (!project?.script.trim()) return notify("请先输入剧本内容", "error");
    setBusy(true);
    try {
      await save();
      const result = await api<{ episodes: any[]; shots: any[] }>(
        `/projects/${id}/parse-script`,
        { method: "POST" },
      );
      const createdEpisodes: Episode[] = [];
      for (const e of result.episodes || [])
        createdEpisodes.push(
          await api<Episode>(`/projects/${id}/episodes`, {
            method: "POST",
            body: json(e),
          }),
        );
      for (const s of result.shots || []) {
        const { episode_position, ...fields } = s;
        await api(`/projects/${id}/shots`, {
          method: "POST",
          body: json({
            ...fields,
            episode_id: createdEpisodes[episode_position]?.id,
          }),
        });
      }
      refreshEpisodes();
      refreshShots();
      notify(
        `已按本地规则创建 ${result.episodes?.length || 0} 个分集、${result.shots?.length || 0} 个分镜`,
      );
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function addShot() {
    try {
      await api(`/projects/${id}/shots`, {
        method: "POST",
        body: json({
          name: `分镜 ${shots.items.length + 1}`,
          position: shots.items.length,
          episode_id: selectedEpisode || undefined,
          prompt: "",
          dialogue: "",
          duration: 5,
        }),
      });
      refreshShots();
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  async function editShot(shot: Shot, patch: Partial<Shot>) {
    try {
      await api(`/shots/${shot.id}`, { method: "PATCH", body: json(patch) });
      refreshShots();
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  async function removeShot(shot: Shot) {
    if (!window.confirm(`删除${shot.name}？`)) return;
    try {
      await api(`/shots/${shot.id}`, { method: "DELETE" });
      refreshShots();
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  function generate(kind: string, shot?: Shot) {
    setTaskKind(kind);
    setTargetShot(shot || null);
    setPrompt(shot?.prompt || project?.script || "");
    setModal("generate");
  }
  async function submitTask() {
    if (!prompt.trim() && taskKind !== "export")
      return notify("请输入生成描述", "error");
    setBusy(true);
    try {
      const task = await api<Task>("/tasks", {
        method: "POST",
        body: json({
          kind: taskKind,
          project_id: id,
          prompt,
          parameters: {
            shot_id: targetShot?.id,
            aspect_ratio: project?.aspect_ratio,
            style: project?.style,
            shot_ids: shots.items.map((s) => s.id),
            format: taskKind === "export" ? exportFormat : undefined,
          },
          idempotency_key: crypto.randomUUID(),
        }),
      });
      notify("任务已提交，请在任务中心查看进度");
      setModal("");
      refreshSession();
      const interval = setInterval(async () => {
        try {
          const t = await api<Task>(`/tasks/${task.id}`);
          if (["succeeded", "failed"].includes(t.status)) {
            clearInterval(interval);
            refreshShots();
            refreshSession();
            notify(
              t.status === "failed" ? t.error || "任务失败" : "任务已完成",
              t.status === "failed" ? "error" : "info",
            );
          }
        } catch {
          clearInterval(interval);
        }
      }, 2500);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function showHistory() {
    try {
      const d = await api<{ items: Task[] }>(`/tasks?project_id=${id}`);
      setHistory(d.items);
      setModal("history");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  async function importScript(file?: File) {
    if (!file) return;
    try {
      if (file.name.endsWith(".txt")) update({ script: await file.text() });
      else {
        const r = await upload(file);
        notify(`已上传 ${r.filename}；此格式内容提取未接入，请粘贴剧本正文。`);
      }
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  if (loading) return <Loading />;
  if (error || !project)
    return (
      <div className="page">
        <button onClick={() => nav("/work")}>
          <ArrowLeft size={15} />
          返回作品
        </button>
        <ErrorPanel error={error || "作品不存在"} onRetry={refresh} />
      </div>
    );
  return (
    <div className={`project-editor tab-${tab}`}>
      <header className="editor-header">
        <div className="editor-name">
          <button
            className="icon-button"
            onClick={async () => {
              try {
                if (dirty) await save();
                nav("/work");
              } catch {}
            }}
            aria-label="返回我的作品"
          >
            <ArrowLeft size={20} />
          </button>
          <span className="divider" />
          <input
            value={project.name}
            onChange={(e) => update({ name: e.target.value })}
            aria-label="作品名称"
          />
          <span className="tag">
            {project.kind === "series"
              ? "剧集"
              : project.kind === "script"
                ? "剧本"
                : "单集"}
          </span>
        </div>
        <div className="editor-header-actions">
          <span className="save-status">
            {dirty ? "有未保存修改" : "已保存到本地"}
          </span>
          {tab !== "script" && (
            <button
              className="workflow-next"
              disabled={saving}
              onClick={() =>
                void goStep(
                  tab === "style"
                    ? "subject"
                    : tab === "subject"
                      ? "work"
                      : "video",
                )
              }
            >
              {tab === "style"
                ? "设置角色场景"
                : tab === "subject"
                  ? "编辑分镜"
                  : "视频预览"}
              <ArrowRight size={14} />
            </button>
          )}
          <button onClick={showHistory}>
            <History size={16} />
            生成记录
          </button>
          <button
            className="primary"
            onClick={() => save().catch(() => {})}
            disabled={saving}
          >
            {saving ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            保存
          </button>
        </div>
      </header>
      <nav className="editor-steps">
        {(tab === "script" ? editorTabs : workflowTabs).map((t, i) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            disabled={saving}
            onClick={() => void goStep(t.id)}
          >
            <span>{i + 1}</span>
            <t.icon size={16} />
            {t.label}
            {i < 3 && <ArrowRight size={15} />}
          </button>
        ))}
      </nav>
      <div className="editor-body">
        <aside className="episode-panel">
          <header>
            <strong>
              分集列表 <small>{episodes.items.length}</small>
            </strong>
            <button
              className="icon-button"
              onClick={addEpisode}
              aria-label="新增分集"
            >
              <Plus size={17} />
            </button>
          </header>
          <button
            className={
              !selectedEpisode ? "episode-item active" : "episode-item"
            }
            onClick={() => setSelectedEpisode("")}
          >
            <FileText size={16} />
            <span>
              完整剧本<small>作品内容总览</small>
            </span>
          </button>
          {episodes.items.map((e, i) => (
            <div
              className={`episode-item ${selectedEpisode === e.id ? "active" : ""}`}
              key={e.id}
            >
              <button
                className="episode-select"
                onClick={() => setSelectedEpisode(e.id)}
              >
                <span className="episode-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>
                  {e.name}
                  <small>
                    {shots.items.filter((s) => s.episode_id === e.id).length}{" "}
                    个分镜
                  </small>
                </span>
              </button>
              <button
                className="icon-button"
                aria-label="删除分集"
                onClick={async () => {
                  if (!window.confirm(`删除 ${e.name}？`)) return;
                  try {
                    await api(`/episodes/${e.id}`, { method: "DELETE" });
                    refreshEpisodes();
                    setSelectedEpisode("");
                  } catch (er) {
                    notify((er as Error).message, "error");
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button className="dashed-button" onClick={addEpisode}>
            <Plus size={15} />
            添加分集
          </button>
          <div className="episode-foot">
            本地独立项目
            <br />
            内容保存在你的创作空间
          </div>
        </aside>
        <section className="editor-stage">
          {tab === "script" && (
            <>
              <div className="stage-toolbar">
                <div>
                  <h2>
                    {selectedEpisode
                      ? episodes.items.find((e) => e.id === selectedEpisode)
                          ?.name
                      : "剧本内容"}
                  </h2>
                  <p>好故事，是一切精彩的开始</p>
                </div>
                <div>
                  <label className="button upload-button">
                    <Upload size={15} />
                    导入剧本
                    <input
                      type="file"
                      accept=".txt,.doc,.docx,.pdf"
                      onChange={(e) => importScript(e.target.files?.[0])}
                    />
                  </label>
                  <button onClick={() => generate("text")}>
                    <Sparkles size={15} />
                    AI 创作
                  </button>
                  <button className="primary" onClick={parse} disabled={busy}>
                    <LayoutGrid size={15} />
                    {busy ? "正在解析" : "解析为分镜"}
                  </button>
                </div>
              </div>
              <div className="script-document">
                {selectedEpisode ? (
                  <EpisodeScript
                    key={selectedEpisode}
                    episode={episodes.items.find(
                      (e) => e.id === selectedEpisode,
                    )!}
                    onSave={async (script) => {
                      try {
                        await api(`/episodes/${selectedEpisode}`, {
                          method: "PATCH",
                          body: json({ script }),
                        });
                        refreshEpisodes();
                        notify("分集剧本已保存");
                      } catch (e) {
                        notify((e as Error).message, "error");
                      }
                    }}
                  />
                ) : (
                  <>
                    <input
                      className="document-title"
                      value={project.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                    <textarea
                      aria-label="剧本内容"
                      value={project.script || ""}
                      onChange={(e) => update({ script: e.target.value })}
                      placeholder="在这里写下你的故事…&#10;&#10;建议格式：&#10;第一集&#10;场景一：内景 · 客厅 · 日&#10;角色：主角&#10;画面：阳光穿过窗帘，落在桌上的信封。&#10;台词：故事，就从这里开始。"
                    />
                    <div className="document-footer">
                      <span>{project.script?.length || 0} 字</span>
                      <span>本地规则解析 · 非 AI 改编</span>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          {tab === "style" && (
            <StyleWorkspace
              project={project}
              catalog={catalog}
              update={update}
              save={() => {
                save().catch(() => {});
              }}
              next={() => void goStep("subject")}
            />
          )}
          {tab === "subject" && (
            <SubjectWorkspace project={project} onProjectChange={setProject} />
          )}
          {tab === "work" && (
            <StoryboardWorkspace
              project={project}
              onProjectChange={setProject}
            />
          )}
        </section>
      </div>
      {modal === "generate" && (
        <Modal
          title={
            {
              text: "AI 文本创作",
              image: "图片生成",
              video: "视频生成",
              audio: "音频生成",
              export: "合成导出",
            }[taskKind] || "生成"
          }
          onClose={() => setModal("")}
        >
          <div className="form-body">
            {taskKind !== "export" && (
              <label>
                创作描述
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={6}
                  placeholder="请描述你希望生成的内容"
                />
              </label>
            )}
            <div className="generation-summary">
              <span>
                画面比例 <strong>{project.aspect_ratio}</strong>
              </span>
              <span>
                风格 <strong>{project.style || "默认"}</strong>
              </span>
            </div>
            {taskKind !== "export" && !session?.provider_status?.[taskKind] && (
              <div className="notice">
                <Sparkles size={18} />
                当前
                {taskKind === "image"
                  ? "图片"
                  : taskKind === "video"
                    ? "视频"
                    : taskKind === "audio"
                      ? "音频"
                      : "文本"}
                服务尚未配置。提交会返回服务不可用，不会扣除积分。
              </div>
            )}
            {taskKind === "export" && (
              <>
                <label>
                  导出格式
                  <select
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value)}
                  >
                    <option value="json">JSON · 完整项目数据</option>
                    <option value="zip">ZIP · 项目与媒体文件</option>
                    <option value="mp4">MP4 · 按分镜合成视频</option>
                  </select>
                </label>
                <p className="muted">
                  MP4 合成需要已有视频素材；缺失可用媒体时会明确失败。
                </p>
              </>
            )}
          </div>
          <footer>
            <button onClick={() => setModal("")}>取消</button>
            <button className="primary" disabled={busy} onClick={submitTask}>
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Sparkles size={16} />
              )}
              提交任务
            </button>
          </footer>
        </Modal>
      )}
      {modal === "history" && (
        <Modal title="生成记录" onClose={() => setModal("")} wide>
          <div className="form-body">
            {history.length ? (
              history.map((t) => (
                <div className="history-row" key={t.id}>
                  <span>
                    {t.kind}
                    <small>
                      {new Date(t.created_at).toLocaleString("zh-CN")}
                    </small>
                  </span>
                  <span className={`status ${t.status}`}>
                    {taskStatusLabel(t.status)}
                  </span>
                  {t.error && <span className="danger-text">{t.error}</span>}
                </div>
              ))
            ) : (
              <Empty
                title="暂无生成记录"
                description="作品的生成任务会显示在这里"
              />
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
function EpisodeScript({
  episode,
  onSave,
}: {
  episode: Episode;
  onSave: (script: string) => void;
}) {
  const [script, setScript] = useState(episode?.script || "");
  return (
    <>
      <h2>{episode?.name}</h2>
      <textarea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        placeholder="编写本集剧本…"
      />
      <div className="document-footer">
        <span>{script.length} 字</span>
        <button className="primary" onClick={() => onSave(script)}>
          <Save size={14} />
          保存本集
        </button>
      </div>
    </>
  );
}
function ShotCard({
  shot,
  index,
  onSave,
  onDelete,
  onGenerate,
  onUpload,
}: {
  shot: Shot;
  index: number;
  onSave: (patch: Partial<Shot>) => void;
  onDelete: () => void;
  onGenerate: (kind: string) => void;
  onUpload: (file: File) => void;
}) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState(shot.prompt),
    [dialogue, setDialogue] = useState(shot.dialogue),
    [duration, setDuration] = useState(shot.duration),
    [name, setName] = useState(shot.name);
  const baseline = useRef({
    prompt: shot.prompt,
    dialogue: shot.dialogue,
    duration: shot.duration,
    name: shot.name,
  });
  useEffect(() => {
    const previous = baseline.current.prompt;
    setPrompt((current) => (current === previous ? shot.prompt : current));
    baseline.current.prompt = shot.prompt;
  }, [shot.prompt]);
  useEffect(() => {
    const previous = baseline.current.dialogue;
    setDialogue((current) => (current === previous ? shot.dialogue : current));
    baseline.current.dialogue = shot.dialogue;
  }, [shot.dialogue]);
  useEffect(() => {
    const previous = baseline.current.duration;
    setDuration((current) => (current === previous ? shot.duration : current));
    baseline.current.duration = shot.duration;
  }, [shot.duration]);
  useEffect(() => {
    const previous = baseline.current.name;
    setName((current) => (current === previous ? shot.name : current));
    baseline.current.name = shot.name;
  }, [shot.name]);
  return (
    <article className="shot-card">
      <header>
        <span className="shot-number">
          {String(index + 1).padStart(2, "0")}
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== shot.name) onSave({ name });
          }}
          aria-label="分镜名称"
        />
        <button
          className="icon-button"
          aria-label="删除分镜"
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </button>
      </header>
      <div className="shot-preview">
        {shot.video_url ? (
          <video src={shot.video_url} controls />
        ) : shot.image_url ? (
          <img src={shot.image_url} alt={name} />
        ) : (
          <div>
            <ImageIcon size={31} />
            <small>等待画面生成</small>
          </div>
        )}
        <label className="shot-upload">
          <Upload size={14} />
          <input
            type="file"
            accept="image/*,video/*,audio/*"
            onChange={(e) => {
              if (e.target.files?.[0]) onUpload(e.target.files[0]);
            }}
          />
        </label>
      </div>
      <div className="shot-fields">
        <label>
          画面描述
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => {
              if (prompt !== shot.prompt) onSave({ prompt });
            }}
            placeholder="描述场景、人物、动作与镜头…"
            rows={3}
          />
        </label>
        <label>
          台词 / 旁白
          <textarea
            value={dialogue}
            onChange={(e) => setDialogue(e.target.value)}
            onBlur={() => {
              if (dialogue !== shot.dialogue) onSave({ dialogue });
            }}
            placeholder="输入台词或旁白"
            rows={2}
          />
        </label>
        <label className="duration-label">
          时长{" "}
          <div>
            <input
              type="number"
              min={1}
              max={300}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              onBlur={() => {
                if (duration !== shot.duration)
                  onSave({ duration: Math.max(1, duration) });
              }}
            />
            秒
          </div>
        </label>
        {shot.audio_url && <audio src={shot.audio_url} controls />}
        <button
          className="shot-edit-button"
          onClick={() =>
            navigate(
              `/edit/${shot.project_id}/${shot.episode_id || "main"}/${shot.id}`,
            )
          }
        >
          编辑分镜 <ArrowRight size={14} />
        </button>
        <div className="shot-actions">
          <button onClick={() => onGenerate("image")}>
            <ImageIcon size={14} />
            生图
          </button>
          <button onClick={() => onGenerate("video")}>
            <Video size={14} />
            视频
          </button>
          <button onClick={() => onGenerate("audio")}>
            <Volume2 size={14} />
            配音
          </button>
        </div>
      </div>
    </article>
  );
}
