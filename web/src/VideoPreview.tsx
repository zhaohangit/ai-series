import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Download,
  Play,
  Film,
  Plus,
  LoaderCircle,
  Check,
  ArrowRight,
  History,
  RefreshCw,
} from "lucide-react";
import { api, json } from "./api";
import { useApp, useResource, Loading, ErrorPanel, Empty, Modal } from "./App";
import type { Project, Shot, Task } from "./types";
export default function VideoPreview() {
  const { shotProjectId = "" } = useParams(),
    navigate = useNavigate(),
    { notify } = useApp(),
    {
      data: project,
      loading,
      error,
    } = useResource<Project | null>(`/projects/${shotProjectId}`, null),
    { data: shots } = useResource<{ items: Shot[] }>(
      `/projects/${shotProjectId}/shots`,
      { items: [] },
    ),
    { data: tasks, refresh } = useResource<{ items: Task[] }>(
      `/tasks?project_id=${shotProjectId}`,
      { items: [] },
    ),
    [selected, setSelected] = useState(""),
    [show, setShow] = useState(false),
    [format, setFormat] = useState("mp4"),
    [busy, setBusy] = useState(false);
  const sorted = [...shots.items].sort((a, b) => a.position - b.position),
    shot = sorted.find((s) => s.id === selected) || sorted[0];
  useEffect(() => {
    if (tasks.items.some((t) => ["queued", "running"].includes(t.status))) {
      const id = setInterval(refresh, 2500);
      return () => clearInterval(id);
    }
  }, [tasks.items, refresh]);
  async function exportTask() {
    setBusy(true);
    try {
      await api("/tasks", {
        method: "POST",
        body: json({
          kind: "export",
          project_id: shotProjectId,
          prompt: "",
          parameters: { format, shot_ids: sorted.map((s) => s.id) },
          idempotency_key: crypto.randomUUID(),
        }),
      });
      setShow(false);
      refresh();
      notify("导出任务已提交，请查看下方导出记录");
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Loading />;
  if (error || !project) return <ErrorPanel error={error || "作品不存在"} />;
  return (
    <div className="video-preview-page">
      <header>
        <button
          className="text-button"
          onClick={() => navigate(`/storyboard/${shotProjectId}`)}
        >
          <ArrowLeft size={17} />
          返回分镜
        </button>
        <h2>{project.name}</h2>
        <div>
          {["风格设置", "角色场景", "漫剧分镜", "视频预览"].map((s, i) => (
            <button
              key={s}
              className={i === 3 ? "active" : ""}
              onClick={() =>
                navigate(
                  `${["/style/", "/roleAndScene/", "/storyboard/", "/video/preview/"][i]}${shotProjectId}`,
                )
              }
            >
              {s}
              {i < 3 && <ArrowRight size={12} />}
            </button>
          ))}
        </div>
        <button className="primary" onClick={() => setShow(true)}>
          <Download size={15} />
          导出作品
        </button>
      </header>
      <section className="video-preview-center">
        <div className="preview-player">
          {shot?.video_url ? (
            <video key={shot.id} src={shot.video_url} controls autoPlay />
          ) : shot?.image_url ? (
            <>
              <img src={shot.image_url} alt={shot.name} />
              <span className="still-preview-label">
                静帧预览 · 此分镜尚无视频
              </span>
            </>
          ) : (
            <div>
              <Film size={48} />
              <p>暂无可预览的视频</p>
              <small>上传分镜媒体，或配置生成服务后创作视频</small>
              <button onClick={() => navigate(`/storyboard/${shotProjectId}`)}>
                <Plus size={15} />
                前往分镜创作
              </button>
            </div>
          )}
        </div>
        <div className="preview-info">
          <span>{shot?.name || "未选择分镜"}</span>
          <span>
            {project.aspect_ratio} ·{" "}
            {sorted.reduce((s, v) => s + v.duration, 0)} 秒 · {sorted.length}{" "}
            个分镜
          </span>
        </div>
      </section>
      <section className="preview-timeline">
        <div>
          <h3>分镜时间线</h3>
          <button
            className="text-button"
            onClick={() => navigate(`/storyboard/${shotProjectId}`)}
          >
            编辑分镜 <ArrowRight size={13} />
          </button>
        </div>
        <div className="preview-timeline-shots">
          {sorted.map((s, i) => (
            <button
              key={s.id}
              className={shot?.id === s.id ? "active" : ""}
              onClick={() => setSelected(s.id)}
            >
              <div>
                {s.image_url ? (
                  <img src={s.image_url} alt={s.name} />
                ) : (
                  <Film size={24} />
                )}
                <span>{s.duration}s</span>
                {s.video_url && <Play size={15} />}
              </div>
              <strong>
                {String(i + 1).padStart(2, "0")} · {s.name}
              </strong>
            </button>
          ))}
        </div>
      </section>
      <section className="preview-export-history">
        <header>
          <h3>导出记录</h3>
          <button className="text-button" onClick={refresh}>
            <RefreshCw size={13} />
            刷新
          </button>
        </header>
        {tasks.items.filter((t) => t.kind === "export").length ? (
          tasks.items
            .filter((t) => t.kind === "export")
            .map((t) => (
              <div key={t.id}>
                <span>{new Date(t.created_at).toLocaleString("zh-CN")}</span>
                <span className={`status ${t.status}`}>
                  {{
                    queued: "排队中",
                    running: "导出中",
                    succeeded: "已完成",
                    failed: "失败",
                  }[t.status] || t.status}
                </span>
                <small>{t.error}</small>
                {typeof t.result.url === "string" && (
                  <a href={t.result.url} download>
                    <Download size={14} />
                    下载
                  </a>
                )}
              </div>
            ))
        ) : (
          <p>暂无导出记录</p>
        )}
      </section>
      {show && (
        <Modal title="导出作品" onClose={() => setShow(false)}>
          <div className="form-body">
            <label>
              导出格式
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="mp4">MP4 · 合成分镜视频</option>
                <option value="zip">ZIP · 项目与媒体文件</option>
                <option value="json">JSON · 项目数据</option>
              </select>
            </label>
            <div className="generation-summary">
              <span>
                分镜数量 <strong>{sorted.length}</strong>
              </span>
              <span>
                已有视频{" "}
                <strong>{sorted.filter((s) => s.video_url).length}</strong>
              </span>
            </div>
            <p className="muted small">
              MP4
              需要已有视频素材。缺失媒体时导出会显示明确失败；数据和媒体打包可使用
              JSON 或 ZIP。
            </p>
          </div>
          <footer>
            <button onClick={() => setShow(false)}>取消</button>
            <button className="primary" disabled={busy} onClick={exportTask}>
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Download size={15} />
              )}
              开始导出
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
