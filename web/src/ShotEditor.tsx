import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Image,
  Video,
  Music,
  Plus,
  Upload,
  Users,
  Folder,
  Film,
  Play,
  Sparkles,
  Save,
  History,
  RefreshCw,
  Check,
  ChevronRight,
  Download,
  LoaderCircle,
  Trash2,
  Scissors,
} from "lucide-react";
import { api, json, upload } from "./api";
import { useApp, useResource, Loading, ErrorPanel, Modal, Empty } from "./App";
import type { Project, Shot, Task, Asset } from "./types";
import MediaTools from "./MediaTools";
import type { MediaKind } from "./media-tools-domain";
export function providerLabel(configured: boolean) {
  return configured ? "本地服务已配置" : "服务未配置 · 提交不扣费";
}
export function mediaEmptyLabel(tab: string) {
  const medium = tab === "image" ? "图" : tab === "video" ? "视频" : "音频";
  return `暂无预览${medium}，可拖拽至此上传${tab === "image" ? "图片" : "媒体"}`;
}
function shotTaskStatus(status: string) {
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
function modelDescription(model: string, tab: string) {
  if (tab === "video") {
    return model === "MiniMax H3"
      ? "全模态参考，复杂指令精准生成"
      : model === "Seedance 2.0"
        ? "动作连贯，适合镜头运动"
        : "参考模型名称 · 生成使用本地配置的服务";
  }
  if (tab === "image" && model === "生花 T1")
    return "精准表达构想，多主体参考更强";
  if (tab === "image" && model === "生花 G2")
    return "理解力更强，文字更准确，直出更真实";
  return "参考模型名称 · 生成使用本地配置的服务";
}
export default function ShotEditor() {
  const { shotProjectId = "", shotId = "" } = useParams(),
    nav = useNavigate(),
    { notify, session } = useApp();
  const {
      data: project,
      loading,
      error,
    } = useResource<Project | null>(`/projects/${shotProjectId}`, null),
    { data, refresh } = useResource<{ items: Shot[] }>(
      `/projects/${shotProjectId}/shots`,
      { items: [] },
    ),
    { data: tasks, refresh: refreshTasks } = useResource<{ items: Task[] }>(
      `/tasks?project_id=${shotProjectId}`,
      { items: [] },
    ),
    { data: assets } = useResource<{ items: Asset[] }>("/assets", {
      items: [],
    });
  const [tab, setTab] = useState("image"),
    [mode, setMode] = useState("reference"),
    [videoMode, setVideoMode] = useState("image-to-video"),
    [prompt, setPrompt] = useState(""),
    [dialogue, setDialogue] = useState(""),
    [duration, setDuration] = useState(5),
    [ratio, setRatio] = useState("16:9"),
    [resolution, setResolution] = useState("768P"),
    [cameraMotion, setCameraMotion] = useState("无运镜"),
    [model, setModel] = useState("生花 T1"),
    [busy, setBusy] = useState(false),
    [references, setReferences] = useState<string[]>([]),
    [modal, setModal] = useState(""),
    [showHistory, setShowHistory] = useState(true),
    [picked, setPicked] = useState<string[]>([]);
  const [editingSource, setEditingSource] = useState<{
    url: string;
    kind: MediaKind;
  } | null>(null);
  const shot = data.items.find((s) => s.id === shotId);
  useEffect(() => {
    if (shot) {
      setPrompt(shot.prompt);
      setDialogue(shot.dialogue);
      setDuration(shot.duration);
      setRatio(
        String(shot.settings?.aspect_ratio || project?.aspect_ratio || "16:9"),
      );
      setModel(String(shot.settings?.model || "生花 T1"));
      setResolution(String(shot.settings?.resolution || "768P"));
      setCameraMotion(String(shot.settings?.camera_motion || "无运镜"));
      setReferences((shot.settings?.references || []) as string[]);
      setPicked((shot.settings?.asset_ids || []) as string[]);
    }
  }, [shot?.id]);
  async function save() {
    if (!shot) return;
    return await api<Shot & { updated_at: string }>(`/shots/${shot.id}`, {
      method: "PATCH",
      body: json({
        prompt,
        dialogue,
        duration,
        settings: {
          ...shot.settings,
          aspect_ratio: ratio,
          model,
          references,
          asset_ids: picked,
          resolution,
          camera_motion: cameraMotion,
          generation_mode: tab === "video" ? videoMode : mode,
        },
      }),
    });
  }
  async function doSave() {
    try {
      await save();
      notify("分镜已保存");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  async function file(file?: File, apply = false) {
    if (!file) return;
    setBusy(true);
    try {
      const result = await upload(file);
      if (apply) {
        await api(`/shots/${shotId}`, {
          method: "PATCH",
          body: json({
            [file.type.startsWith("video/")
              ? "video_url"
              : file.type.startsWith("audio/")
                ? "audio_url"
                : "image_url"]: result.url,
          }),
        });
        refresh();
      } else setReferences((r) => [...r, result.url]);
      notify("素材已上传");
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!prompt.trim()) return notify("请输入生成提示词", "error");
    setBusy(true);
    try {
      await save();
      const task = await api<Task>("/tasks", {
        method: "POST",
        body: json({
          kind: tab,
          project_id: shotProjectId,
          prompt,
          parameters: {
            shot_id: shotId,
            model,
            aspect_ratio: ratio,
            duration,
            references,
            asset_ids: picked,
            resolution,
            camera_motion: cameraMotion,
            generation_mode: tab === "video" ? videoMode : mode,
          },
          idempotency_key: crypto.randomUUID(),
        }),
      });
      notify("任务已提交");
      refreshTasks();
      const interval = setInterval(async () => {
        try {
          const t = await api<Task>(`/tasks/${task.id}`);
          refreshTasks();
          if (["succeeded", "failed"].includes(t.status)) {
            clearInterval(interval);
            refresh();
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
  if (loading) return <Loading />;
  if (error) return <ErrorPanel error={error} />;
  if (!shot)
    return (
      <div className="page">
        <button onClick={() => nav(`/project/${shotProjectId}`)}>
          <ArrowLeft size={16} />
          返回作品
        </button>
        <Empty title="分镜不存在" description="请从作品分镜列表打开已有分镜" />
      </div>
    );
  const media =
    tab === "image"
      ? shot.image_url
      : tab === "video"
        ? shot.video_url
        : shot.audio_url;
  return (
    <div className="shot-studio">
      <header>
        <button
          className="text-button"
          onClick={async () => {
            try {
              await save();
              nav(`/storyboard/${shotProjectId}`);
            } catch (e) {
              notify((e as Error).message, "error");
            }
          }}
        >
          <ArrowLeft size={18} />
          返回
        </button>
        <span className="divider" />
        <strong>{shot.name}</strong>
        <button className="icon-button" onClick={doSave} title="保存分镜">
          <Save size={16} />
        </button>
        <div className="studio-header-actions">
          <span className="tag">本地创作</span>
          <button onClick={() => setShowHistory(!showHistory)}>
            <History size={15} />
            版本记录
          </button>
        </div>
      </header>
      <div className="shot-studio-body">
        <aside className="studio-config">
          <div className="tabs studio-tabs">
            {[
              ["image", "图片"],
              ["video", "视频"],
              ["audio", "音频"],
            ].map(([key, name]) => (
              <button
                className={tab === key ? "active" : ""}
                key={key}
                onClick={() => setTab(key)}
              >
                {name}
              </button>
            ))}
          </div>
          {tab === "image" && (
            <div className="generation-mode">
              <button
                className={mode === "reference" ? "active" : ""}
                onClick={() => setMode("reference")}
              >
                参考生图
              </button>
              <button
                className={mode === "text" ? "active" : ""}
                onClick={() => setMode("text")}
              >
                文生图
              </button>
            </div>
          )}
          {tab === "video" && (
            <div className="generation-mode video-mode">
              {[
                ["image-to-video", "图生视频"],
                ["reference-video", "参考生视频"],
                ["first-last-frame", "首尾帧"],
              ].map(([key, name]) => (
                <button
                  key={key}
                  className={videoMode === key ? "active" : ""}
                  onClick={() => setVideoMode(key)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          {tab !== "audio" && (
            <label>
              {tab === "image" ? "生图" : "视频"}比例
              <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
                {["16:9", "9:16", "1:1", "4:3", "3:4"].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
          )}
          {tab === "video" && (
            <>
              <label>
                分辨率
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                >
                  <option>768P</option>
                  <option>1080P</option>
                </select>
              </label>
              <label>
                视频运镜
                <select
                  value={cameraMotion}
                  onChange={(e) => setCameraMotion(e.target.value)}
                >
                  <option>无运镜</option>
                  <option>缓慢推近</option>
                  <option>环绕镜头</option>
                  <option>跟随主体</option>
                </select>
              </label>
            </>
          )}
          <label>
            {tab === "image" ? "生图" : tab === "video" ? "视频" : "音频"}模型
            <div className="studio-model">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {(tab === "image"
                  ? ["生花 T1", "生花 G2", "Seedream 4.0"]
                  : tab === "video"
                    ? [
                        "MiniMax H3",
                        "Seedance 2.0",
                        "Kling 4.0",
                        "本地视频模型",
                      ]
                    : ["Seed Audio 1.0", "本地音频模型"]
                ).map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <small>{modelDescription(model, tab)}</small>
            </div>
          </label>
          {(mode === "reference" || tab !== "image") && (
            <div className="studio-reference">
              <div>
                <strong>参考内容</strong>
                <label className="text-button">
                  <Plus size={15} />
                  本地上传
                  <input
                    type="file"
                    accept="image/*,audio/*,video/*"
                    onChange={(e) => file(e.target.files?.[0])}
                  />
                </label>
                <button
                  className="text-button"
                  onClick={() => setModal("assets")}
                >
                  <Plus size={15} />
                  主体
                </button>
              </div>
              {references.length ? (
                <div className="reference-thumbnails">
                  {references.map((url, i) => (
                    <div key={`${url}-${i}`}>
                      <img src={url} alt={`参考 ${i + 1}`} />
                      <button
                        className="icon-button"
                        onClick={() =>
                          setReferences((r) => r.filter((_, n) => n !== i))
                        }
                        aria-label="移除参考"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p>暂无素材，可上传参考图或从主体素材中选择</p>
              )}
            </div>
          )}
          <label className="studio-prompt">
            <span>
              {tab === "audio"
                ? "配音文本"
                : tab === "video"
                  ? "视频提示词"
                  : "绘图提示词"}
              <button
                className="text-button"
                onClick={() => {
                  setModal("optimize");
                }}
              >
                <Sparkles size={13} />
                提示词优化
              </button>
            </span>
            <textarea
              rows={6}
              maxLength={2000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述你想要的画面、角色、动作、氛围…"
            />
            <small>{prompt.length} / 2000</small>
          </label>
          {tab === "audio" && (
            <label>
              台词 / 旁白
              <textarea
                rows={3}
                value={dialogue}
                onChange={(e) => setDialogue(e.target.value)}
              />
            </label>
          )}
          {tab === "video" && (
            <label>
              时长（秒）
              <input
                type="number"
                min={1}
                max={120}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </label>
          )}
          <div className="studio-generate">
            <small>
              {providerLabel(Boolean(session?.provider_status?.[tab]))}
            </small>
            <button className="primary" disabled={busy} onClick={submit}>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Sparkles size={16} />
              )}
              生成{tab === "image" ? "图片" : tab === "video" ? "视频" : "音频"}
            </button>
          </div>
        </aside>
        <section className="studio-stage">
          <div
            className="studio-preview"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              file(e.dataTransfer.files[0], true);
            }}
          >
            {media ? (
              tab === "image" ? (
                <img src={media} alt={shot.name} />
              ) : tab === "video" ? (
                <video src={media} controls />
              ) : (
                <audio src={media} controls />
              )
            ) : (
              <div className="studio-empty-preview">
                <img src="/reference/embedded-016f974b60b1.png" alt="" />
                <p>{mediaEmptyLabel(tab)}</p>
              </div>
            )}
            <div className="studio-preview-tools">
              <button
                className="icon-button"
                title="选择素材"
                onClick={() => setModal("assets")}
              >
                <Folder size={20} />
              </button>
              <label className="icon-button" title="本地上传">
                <Upload size={20} />
                <input
                  type="file"
                  accept={`${tab}/*`}
                  onChange={(e) => file(e.target.files?.[0], true)}
                />
              </label>
              <button
                className="icon-button"
                title="主体"
                onClick={() => setModal("assets")}
              >
                <Users size={20} />
              </button>
              {media && (
                <button
                  className="icon-button"
                  title="媒体编辑"
                  aria-label="媒体编辑"
                  onClick={() => {
                    setEditingSource({ url: media, kind: tab as MediaKind });
                    setModal("media-tools");
                  }}
                >
                  <Scissors size={20} />
                </button>
              )}
              {media && (
                <a className="icon-button" href={media} download title="下载">
                  <Download size={20} />
                </a>
              )}
            </div>
          </div>
          <div className="studio-shot-strip">
            <button
              className="primary studio-preview-button"
              disabled={!media}
              onClick={() => setModal("preview")}
            >
              <Play size={16} />
              预览
            </button>
            <p>当前作品 · 共 {data.items.length} 镜</p>
            <div>
              {data.items.map((s, i) => (
                <button
                  className={s.id === shotId ? "active" : ""}
                  key={s.id}
                  onClick={async () => {
                    try {
                      await save();
                      nav(
                        `/edit/${shotProjectId}/${s.episode_id || "main"}/${s.id}`,
                      );
                    } catch (e) {
                      notify((e as Error).message, "error");
                    }
                  }}
                >
                  {s.image_url ? (
                    <img src={s.image_url} alt={s.name} />
                  ) : (
                    <span>无封面</span>
                  )}
                  <strong>{s.name || `镜头${i + 1}`}</strong>
                </button>
              ))}
            </div>
          </div>
        </section>
        {showHistory && (
          <aside className="studio-history">
            <header>
              <strong>
                版本记录{" "}
                <small>
                  {
                    tasks.items.filter(
                      (t) => (t as any).parameters?.shot_id === shotId,
                    ).length
                  }
                </small>
              </strong>
              <button
                className="icon-button"
                title="刷新记录"
                onClick={refreshTasks}
              >
                <RefreshCw size={15} />
              </button>
            </header>
            {tasks.items.filter(
              (t) => (t as any).parameters?.shot_id === shotId,
            ).length ? (
              tasks.items
                .filter((t) => (t as any).parameters?.shot_id === shotId)
                .map((t) => (
                  <article key={t.id}>
                    <span className={`status ${t.status}`}>
                      {shotTaskStatus(t.status)}
                    </span>
                    <small>
                      {new Date(t.created_at).toLocaleString("zh-CN")}
                    </small>
                    {typeof t.result.url === "string" &&
                      (t.kind === "image" ? (
                        <img src={t.result.url} alt="生成结果" />
                      ) : (
                        <a href={t.result.url} download>
                          下载结果
                        </a>
                      ))}
                    {t.error ? <p className="danger-text">{t.error}</p> : null}
                  </article>
                ))
            ) : (
              <p className="studio-no-history">没有符合筛选条件的历史记录</p>
            )}
          </aside>
        )}
      </div>
      {modal === "assets" && (
        <Modal title="选择主体素材" onClose={() => setModal("")} wide>
          <div className="form-body">
            {assets.items.length ? (
              <div className="asset-grid">
                {assets.items.map((a) => (
                  <button
                    className={`studio-asset-choice ${picked.includes(a.id) ? "active" : ""}`}
                    key={a.id}
                    onClick={() =>
                      setPicked((p) =>
                        p.includes(a.id)
                          ? p.filter((id) => id !== a.id)
                          : [...p, a.id],
                      )
                    }
                  >
                    {a.url ? (
                      <img src={a.url} alt={a.name} />
                    ) : (
                      <Users size={30} />
                    )}
                    <strong>{a.name}</strong>
                    {picked.includes(a.id) && <Check size={16} />}
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                title="暂无主体素材"
                description="先到素材库上传自己的角色、场景与道具"
              />
            )}
          </div>
          <footer>
            <button className="primary" onClick={() => setModal("")}>
              完成选择
            </button>
          </footer>
        </Modal>
      )}
      {modal === "optimize" && (
        <Modal title="提示词优化" onClose={() => setModal("")}>
          <div className="form-body">
            <p>
              提示词优化服务尚未配置。当前提示词会原样保存，你可以手动补充主体、场景、动作、光线与镜头语言。
            </p>
            <button className="primary" onClick={() => setModal("")}>
              继续编辑
            </button>
          </div>
        </Modal>
      )}
      {modal === "preview" && (
        <Modal title={shot.name} onClose={() => setModal("")} wide>
          <div className="form-body studio-modal-preview">
            {tab === "image" ? (
              <img src={media} alt={shot.name} />
            ) : tab === "video" ? (
              <video src={media} controls autoPlay />
            ) : (
              <audio src={media} controls autoPlay />
            )}
          </div>
        </Modal>
      )}
      {modal === "media-tools" && editingSource && (
        <MediaTools
          key={`${shotId}:${editingSource.url}`}
          sourceUrl={editingSource.url}
          kind={editingSource.kind}
          projectId={shotProjectId}
          prepare={async () => {
            const saved = await save();
            if (!saved) throw new Error("分镜不可用");
            return { shot_id: shotId, shot_updated_at: saved.updated_at };
          }}
          onComplete={() => {
            refresh();
            refreshTasks();
          }}
          onClose={() => {
            setModal("");
            refresh();
            refreshTasks();
          }}
        />
      )}
    </div>
  );
}
