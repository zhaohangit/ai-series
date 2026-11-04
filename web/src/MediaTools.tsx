import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Crop, Scissors, ScanLine, LoaderCircle } from "lucide-react";
import { api, json, ApiError } from "./api";
import { ErrorPanel, Loading, Modal } from "./App";
import type { Task } from "./types";
import {
  mediaParameters,
  operationLabels,
  ratioCrop,
  type MediaInfo,
  type MediaKind,
  type MediaOperation,
} from "./media-tools-domain";
import "./media-tools.css";

type Props = {
  sourceUrl: string;
  kind: MediaKind;
  projectId: string;
  prepare: () => Promise<Record<string, unknown>>;
  onComplete: (task: Task) => void;
  onSubmitted?: (task: Task) => void;
  onClose: () => void;
  targetLabel?: string;
};
export default function MediaTools({
  sourceUrl,
  kind,
  projectId,
  prepare,
  onComplete,
  onSubmitted,
  onClose,
  targetLabel = "当前分镜",
}: Props) {
  const operations: MediaOperation[] =
    kind === "image"
      ? ["crop_image"]
      : kind === "video"
        ? ["trim_video", "crop_video", "extract_frame"]
        : ["trim_audio"];
  const [operation, setOperation] = useState<MediaOperation>(operations[0]);
  const [info, setInfo] = useState<MediaInfo | null>(null),
    [loadError, setLoadError] = useState(""),
    [error, setError] = useState("");
  const [retry, setRetry] = useState(0),
    [saving, setSaving] = useState(false),
    [task, setTask] = useState<Task | null>(null),
    [pollRetry, setPollRetry] = useState(0);
  const [values, setValues] = useState({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    start: 0,
    end: 0,
    at: 0,
  });
  const [ratio, setRatio] = useState(0);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const completed = useRef(onComplete);
  completed.current = onComplete;
  const active = !!task && ["queued", "running"].includes(task.status);
  const locked = saving || active || !!pending.current;
  useEffect(() => {
    let canceled = false;
    setInfo(null);
    setLoadError("");
    api<MediaInfo>(`/media/inspect?source_url=${encodeURIComponent(sourceUrl)}`)
      .then((data) => {
        if (canceled) return;
        if (data.kind !== kind) throw new Error("当前素材的实际类型不匹配");
        setInfo(data);
        setValues((v) => ({
          ...v,
          ...ratioCrop(data, 0),
          end: data.duration || 0,
        }));
      })
      .catch((e) => {
        if (!canceled) setLoadError(e.message);
      });
    return () => {
      canceled = true;
    };
  }, [sourceUrl, kind, retry]);
  useEffect(() => {
    if (!task || !active) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<Task>(`/tasks/${task!.id}`);
        if (canceled) return;
        setTask(result);
        setError("");
        if (["succeeded", "failed", "canceled"].includes(result.status)) {
          if (result.status === "succeeded") completed.current(result);
          else setError(result.error || "处理失败，原始素材已保留");
        } else timer = setTimeout(poll, 1200);
      } catch (e) {
        if (!canceled)
          setError(
            `状态读取失败：${(e as Error).message}。任务记录仍然保留，可重新查询。`,
          );
      }
    }
    void poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [task?.id, active, pollRetry]);
  function change(key: keyof typeof values, value: number) {
    setValues((v) => ({ ...v, [key]: value }));
    setError("");
  }
  function seek(at: number) {
    change("at", at);
    if (mediaRef.current && Number.isFinite(at))
      mediaRef.current.currentTime = at;
  }
  async function submit() {
    if (!info) return;
    setSaving(true);
    setError("");
    try {
      if (!pending.current) {
        const parameters = mediaParameters(info, operation, values);
        const target = await prepare();
        pending.current = {
          kind: operation === "extract_frame" ? "image" : kind,
          project_id: projectId,
          parameters: { ...target, ...parameters },
          idempotency_key: crypto.randomUUID(),
        };
      }
      const result = await api<Task>("/tasks", {
        method: "POST",
        body: json(pending.current),
      });
      pending.current = null;
      setTask(result);
      onSubmitted?.(result);
      if (result.status === "succeeded") completed.current(result);
      if (result.status === "failed") setError(result.error || "处理失败");
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500)
        pending.current = null;
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function point(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          info!.width! - 1,
          Math.round(((event.clientX - rect.left) / rect.width) * info!.width!),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          info!.height! - 1,
          Math.round(
            ((event.clientY - rect.top) / rect.height) * info!.height!,
          ),
        ),
      ),
    };
  }
  function dragCrop(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || locked || !info) return;
    const p = point(event),
      x = Math.min(p.x, drag.current.x),
      y = Math.min(p.y, drag.current.y);
    let width = Math.max(1, Math.abs(p.x - drag.current.x)),
      height = Math.max(1, Math.abs(p.y - drag.current.y));
    if (ratio > 0) {
      height = Math.min(height, Math.floor(width / ratio));
      width = Math.floor(height * ratio);
    }
    if (kind === "video") {
      width = Math.max(2, width - (width % 2));
      height = Math.max(2, height - (height % 2));
    }
    setValues((v) => ({
      ...v,
      x: Math.min(x, info.width! - width),
      y: Math.min(y, info.height! - height),
      width: Math.max(1, width),
      height: Math.max(1, height),
    }));
  }
  const crop = operation.startsWith("crop_");
  const resultUrl =
    typeof task?.result?.url === "string" ? task.result.url : "";
  const application = task?.result?.application as
    { status?: string } | undefined;
  return (
    <Modal
      title="媒体编辑"
      onClose={() => {
        if (!saving) onClose();
      }}
      wide
    >
      <div className="media-tools">
        <nav aria-label="媒体编辑方式">
          {operations.map((op) => (
            <button
              key={op}
              className={op === operation ? "active" : ""}
              disabled={locked}
              onClick={() => {
                setOperation(op);
                setError("");
                setTask(null);
              }}
            >
              {op.startsWith("crop") ? (
                <Crop size={16} />
              ) : op === "extract_frame" ? (
                <ScanLine size={16} />
              ) : (
                <Scissors size={16} />
              )}{" "}
              {operationLabels[op]}
            </button>
          ))}
        </nav>
        {loadError ? (
          <ErrorPanel
            error={loadError}
            onRetry={() => setRetry((x) => x + 1)}
          />
        ) : !info ? (
          <Loading />
        ) : (
          <>
            <div className="media-tool-stage">
              {kind === "audio" ? (
                <audio
                  src={sourceUrl}
                  ref={(el) => {
                    mediaRef.current = el;
                  }}
                  controls
                />
              ) : (
                <div
                  className="media-tool-picture"
                  style={{
                    aspectRatio: `${info.width}/${info.height}`,
                    maxWidth: `min(100%, ${Math.round((360 * info.width!) / info.height!)}px)`,
                  }}
                >
                  {kind === "image" ? (
                    <img src={sourceUrl} alt="裁剪原图" draggable={false} />
                  ) : (
                    <video
                      src={sourceUrl}
                      ref={(el) => {
                        mediaRef.current = el;
                      }}
                      controls={!crop}
                      onLoadedMetadata={() => {
                        if (mediaRef.current)
                          mediaRef.current.currentTime = values.at;
                      }}
                    />
                  )}
                  {crop && (
                    <div
                      className="media-crop-surface"
                      aria-label="拖动选择裁剪区域"
                      onPointerDown={(e) => {
                        if (locked) return;
                        e.currentTarget.setPointerCapture(e.pointerId);
                        drag.current = point(e);
                      }}
                      onPointerMove={dragCrop}
                      onPointerUp={(e) => {
                        dragCrop(e);
                        drag.current = null;
                      }}
                      onPointerCancel={() => {
                        drag.current = null;
                      }}
                    >
                      <div
                        className="media-crop-selection"
                        style={{
                          left: `${(values.x / info.width!) * 100}%`,
                          top: `${(values.y / info.height!) * 100}%`,
                          width: `${(values.width / info.width!) * 100}%`,
                          height: `${(values.height / info.height!) * 100}%`,
                        }}
                      >
                        <span>
                          {values.width} × {values.height}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <p className="media-source-info">
              原始素材 {info.width && `${info.width} × ${info.height}`}{" "}
              {info.duration !== null && ` · ${info.duration.toFixed(3)} 秒`}
            </p>
            <fieldset disabled={locked}>
              {crop ? (
                <>
                  <div className="media-ratios">
                    {[
                      [0, "自由裁剪"],
                      [16 / 9, "16:9"],
                      [4 / 3, "4:3"],
                      [1, "1:1"],
                      [3 / 4, "3:4"],
                      [9 / 16, "9:16"],
                    ].map(([r, label]) => (
                      <button
                        className={ratio === r ? "active" : ""}
                        key={label}
                        onClick={() => {
                          setRatio(Number(r));
                          setValues((v) => ({
                            ...v,
                            ...ratioCrop(info, Number(r)),
                          }));
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="media-numbers">
                    {(
                      [
                        ["x", "X"],
                        ["y", "Y"],
                        ["width", "宽度"],
                        ["height", "高度"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          type="number"
                          aria-label={`裁剪${label}`}
                          min={
                            key === "x" || key === "y"
                              ? 0
                              : kind === "video"
                                ? 2
                                : 1
                          }
                          step={
                            kind === "video" &&
                            (key === "width" || key === "height")
                              ? 2
                              : 1
                          }
                          value={Number.isNaN(values[key]) ? "" : values[key]}
                          onChange={(e) => change(key, e.target.valueAsNumber)}
                        />
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {operation === "extract_frame" && (
                    <div className="media-ratios" aria-label="快捷截帧位置">
                      <button onClick={() => seek(0)}>截取首帧</button>
                      <button
                        onClick={() =>
                          seek(Math.max(0, (info.duration || 0) - 0.001))
                        }
                      >
                        截取尾帧
                      </button>
                      <button
                        onClick={() =>
                          seek(
                            Math.min(
                              mediaRef.current?.currentTime || 0,
                              Math.max(0, (info.duration || 0) - 0.001),
                            ),
                          )
                        }
                      >
                        截取当前帧
                      </button>
                    </div>
                  )}
                  <label className="media-seek">
                    {operation === "extract_frame" ? "截帧位置" : "预览位置"}
                    <input
                      aria-label="媒体预览位置"
                      type="range"
                      min="0"
                      max={Math.max(0, (info.duration || 0) - 0.001)}
                      step="0.001"
                      value={values.at}
                      onChange={(e) => seek(Number(e.target.value))}
                    />
                    <span>{values.at.toFixed(3)} 秒</span>
                  </label>
                  <div className="media-numbers">
                    {(operation === "extract_frame"
                      ? [["at", "截帧时间"]]
                      : [
                          ["start", "开始时间"],
                          ["end", "结束时间"],
                        ]
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}（秒）
                        <input
                          type="number"
                          aria-label={label}
                          step="0.001"
                          min="0"
                          max={info.duration || 0}
                          value={
                            Number.isNaN(values[key as keyof typeof values])
                              ? ""
                              : values[key as keyof typeof values]
                          }
                          onChange={(e) =>
                            key === "at"
                              ? seek(e.target.valueAsNumber)
                              : change(
                                  key as keyof typeof values,
                                  e.target.valueAsNumber,
                                )
                          }
                        />
                      </label>
                    ))}
                  </div>
                </>
              )}
            </fieldset>
            {operation === "crop_video" && (
              <fieldset disabled={locked}>
                <p className="media-source-info">
                  时间剪裁 · 同时保留选中的画面区域与时间段
                </p>
                <div className="media-numbers">
                  {(
                    [
                      ["start", "开始时间"],
                      ["end", "结束时间"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}（秒）
                      <input
                        type="number"
                        aria-label={label}
                        step="0.001"
                        min="0"
                        max={info.duration || 0}
                        value={Number.isNaN(values[key]) ? "" : values[key]}
                        onChange={(e) => change(key, e.target.valueAsNumber)}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <p className="media-tool-note">
              处理后保存为新文件，原始素材保留。任务完成后应用到{targetLabel}
              ；期间若有其他修改，结果将保留在任务记录中。
            </p>
          </>
        )}
        {error && (
          <ErrorPanel
            error={error}
            onRetry={active ? () => setPollRetry((x) => x + 1) : undefined}
          />
        )}
        {active && (
          <p className="media-tool-status" role="status">
            <LoaderCircle size={16} className="spin" />
            {task.status === "queued" ? "排队中" : "正在处理"} · {task.progress}
            %
          </p>
        )}
        {task?.status === "succeeded" && (
          <div className="media-tool-result" role="status">
            <p>
              {application?.status === "applied"
                ? `处理完成，已应用到${targetLabel}。`
                : "处理完成。目标内容已发生变化，结果已保存在任务记录中。"}
            </p>
            {resultUrl && (
              <a className="button" href={resultUrl} download>
                下载处理结果
              </a>
            )}
          </div>
        )}
      </div>
      <footer>
        <span className="muted">本地处理 · 不消耗积分</span>
        <button onClick={onClose} disabled={saving}>
          关闭
        </button>
        <button
          className="primary"
          disabled={!info || saving || active || task?.status === "succeeded"}
          onClick={() => void submit()}
        >
          {saving ? <LoaderCircle size={16} className="spin" /> : null}
          {pending.current ? "重试提交" : "保存"}
        </button>
      </footer>
    </Modal>
  );
}
