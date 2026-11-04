import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Plus,
  Upload,
  Download,
  Trash2,
  Image as ImageIcon,
  LoaderCircle,
  Save,
  Library,
  Volume2,
  Sparkles,
  RefreshCw,
  Check,
} from "lucide-react";
import { api, json, upload } from "./api";
import { useApp, Modal } from "./App";
import type { Asset, Project, Task } from "./types";
import {
  subjectDraft,
  subjectPatch,
  subjectKinds,
  subjectSlots,
  subjectTaskParameters,
  subjectWithImage,
  updateGallery,
} from "./subject-domain";
import type {
  SubjectAsset,
  SubjectDraft,
  SubjectKind,
  SubjectImage,
  SubjectMetadata,
} from "./subject-domain";
import "./subject-workspace.css";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试";
const labels = Object.fromEntries(
  subjectKinds.map(({ kind, label }) => [kind, label]),
);
const taskLabels: Record<string, string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};
type SubjectTask = Task & { parameters?: Record<string, unknown> };
const activeTask = (task: Task) => ["queued", "running"].includes(task.status);

function FileButton({
  label,
  accept,
  disabled,
  onFile,
}: {
  label: string;
  accept: string;
  disabled?: boolean;
  onFile: (file: File) => void;
}) {
  const id = useId();
  return (
    <label
      className={`sw-upload-button ${disabled ? "disabled" : ""}`}
      htmlFor={id}
    >
      <Upload size={15} />
      {label}
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </label>
  );
}

export default function SubjectWorkspace({
  project,
  onProjectChange,
}: {
  project: Project;
  onProjectChange?: (project: Project) => void;
}) {
  const [subjects, setSubjects] = useState<SubjectAsset[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [createKind, setCreateKind] = useState<SubjectKind | null>(null),
    [importKind, setImportKind] = useState<SubjectKind | null>(null);
  const [params, setParams] = useSearchParams();
  const activeId = params.get("assetId") || params.get("castId") || "";
  const selected = subjects.find((asset) => asset.id === activeId);
  const { notify } = useApp();
  async function refreshProjectLinks() {
    if (!onProjectChange) return;
    try {
      const latest = await api<Project>(`/projects/${project.id}`);
      onProjectChange({
        ...project,
        updated_at: latest.updated_at,
        settings: { ...project.settings, asset_ids: latest.settings.asset_ids },
      });
    } catch (e) {
      setError(`主体已保存，作品关联刷新失败：${errorMessage(e)}`);
    }
  }
  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ items: SubjectAsset[] }>(
        `/projects/${project.id}/subjects`,
      );
      setSubjects(data.items);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError("");
    api<{ items: SubjectAsset[] }>(`/projects/${project.id}/subjects`)
      .then((data) => {
        if (!stopped) setSubjects(data.items);
      })
      .catch((e) => {
        if (!stopped) setError(errorMessage(e));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [project.id]);
  function open(asset?: SubjectAsset) {
    const next = new URLSearchParams(params);
    next.delete("castId");
    if (asset) next.set("assetId", asset.id);
    else next.delete("assetId");
    setParams(next, { replace: true });
  }
  function changed(asset: SubjectAsset) {
    setSubjects((items) =>
      items.map((item) => (item.id === asset.id ? asset : item)),
    );
  }
  async function detach(asset: SubjectAsset) {
    if (
      !window.confirm(
        `从当前作品移除「${asset.name}」？素材库中的原素材会保留。`,
      )
    )
      return;
    try {
      await api(`/projects/${project.id}/subjects/${asset.id}`, {
        method: "DELETE",
      });
      setSubjects((items) => items.filter((item) => item.id !== asset.id));
      await refreshProjectLinks();
      notify("已从作品移除");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="subject-workspace">
      {error && (
        <div className="sw-error" role="alert">
          {error}
          <button onClick={load}>
            <RefreshCw size={14} />
            重试
          </button>
        </div>
      )}
      {loading ? (
        <div className="sw-loading">
          <LoaderCircle size={20} className="spin" />
          正在加载角色场景
        </div>
      ) : (
        subjectKinds.map(({ kind, label }) => {
          const items = subjects.filter((asset) => asset.kind === kind);
          return (
            <section className="sw-section" key={kind} aria-label={label}>
              <header>
                <h2>
                  {label}
                  <small>共 {items.length} 项</small>
                </h2>
                <div>
                  <button onClick={() => setImportKind(kind)}>
                    <Library size={15} />从{label}库添加
                  </button>
                  <button onClick={() => setCreateKind(kind)}>
                    <Plus size={16} />
                    新增{label}
                  </button>
                </div>
              </header>
              {items.length ? (
                <div className="sw-card-grid">
                  {items.map((asset) => (
                    <article className="sw-card" key={asset.id}>
                      <button
                        className="sw-card-open"
                        onClick={() => open(asset)}
                        aria-label={`编辑${label} ${asset.name}`}
                      >
                        <div className="sw-card-art">
                          {asset.url ? (
                            <img src={asset.url} alt={asset.name} />
                          ) : (
                            <ImageIcon size={32} />
                          )}
                        </div>
                        <strong>{asset.name}</strong>
                        <span>{asset.description || "点击完善设定"}</span>
                        {kind === "character" && (
                          <small>
                            <Volume2 size={12} />
                            {subjectDraft(asset).metadata.voice.url
                              ? "已设置角色音频"
                              : "暂无音频"}
                          </small>
                        )}
                      </button>
                      <button
                        className="sw-card-detach"
                        aria-label={`移除 ${asset.name}`}
                        title="从当前作品移除"
                        onClick={() => detach(asset)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </article>
                  ))}
                  <button
                    className="sw-add-card"
                    onClick={() => setCreateKind(kind)}
                  >
                    <Plus size={28} />
                    新增{label}
                  </button>
                </div>
              ) : (
                <div className="sw-section-empty">
                  <button
                    className="sw-empty-add"
                    onClick={() => setCreateKind(kind)}
                  >
                    <Plus size={28} />
                    <strong>新增{label}</strong>
                  </button>
                  <p>
                    点击添加新{label}，您可以上传或生成{label}图片
                  </p>
                  <p>
                    您也可以选择
                    <button
                      className="sw-link"
                      onClick={() => setImportKind(kind)}
                    >
                      从{label}库中添加
                    </button>
                  </p>
                </div>
              )}
              <footer>以上内容由人工智能生成合成</footer>
            </section>
          );
        })
      )}
      {!loading && activeId && !selected && (
        <div className="sw-error" role="alert">
          该主体尚未关联到当前作品。
          <button onClick={() => open()}>关闭详情</button>
        </div>
      )}
      {createKind && (
        <CreateSubject
          kind={createKind}
          project={project}
          onClose={() => setCreateKind(null)}
          onCreated={(asset) => {
            setSubjects((items) => [...items, asset]);
            setCreateKind(null);
            open(asset);
            void refreshProjectLinks();
          }}
        />
      )}
      {importKind && (
        <ImportSubjects
          kind={importKind}
          projectId={project.id}
          linkedIds={subjects.map((asset) => asset.id)}
          onClose={() => setImportKind(null)}
          onImported={(assets) => {
            setSubjects((items) => [
              ...items.filter(
                (item) => !assets.some((asset) => asset.id === item.id),
              ),
              ...assets,
            ]);
            setImportKind(null);
            void refreshProjectLinks();
          }}
        />
      )}
      {selected && (
        <SubjectDetail
          key={`${project.id}:${selected.id}`}
          asset={selected}
          project={project}
          onChange={changed}
          onClose={() => open()}
        />
      )}
    </div>
  );
}

function CreateSubject({
  kind,
  project,
  onClose,
  onCreated,
}: {
  kind: SubjectKind;
  project: Project;
  onClose: () => void;
  onCreated: (asset: SubjectAsset) => void;
}) {
  const [name, setName] = useState(""),
    [role, setRole] = useState(""),
    [age, setAge] = useState(""),
    [description, setDescription] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const guard = useRef(false),
    label = labels[kind];
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (guard.current) return;
    if (!name.trim()) {
      setError("请输入名称");
      return;
    }
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      onCreated(
        await api<SubjectAsset>(`/projects/${project.id}/subjects`, {
          method: "POST",
          body: json({
            name: name.trim(),
            kind,
            description,
            style: project.style,
            metadata: {
              role,
              age,
              appearance: description,
              aspect_ratio: project.aspect_ratio,
              in_library: false,
            },
          }),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`新增${label}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="sw-form" onSubmit={submit}>
        <p className="sw-hint">
          提示：仅需填写名称即可快速新增，其他信息可后续补充完善
        </p>
        <fieldset disabled={busy}>
          <label>
            {label}名称
            <input
              autoFocus
              maxLength={200}
              required
              placeholder={`请输入${label}名称`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {kind === "character" && (
            <>
              <label>
                角色定位
                <input
                  placeholder="如：男主、女配、女二、路人"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                />
              </label>
              <label>
                年龄段
                <input
                  placeholder="如：儿童、青年、中年、老年"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            {label}描述
            <textarea
              rows={4}
              maxLength={200}
              placeholder={`请输入具体的${label}描述`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <small>{description.length} / 200</small>
          </label>
        </fieldset>
        {error && (
          <p className="sw-error" role="alert">
            {error}
          </p>
        )}
        <div className="sw-form-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="sw-primary" disabled={busy} type="submit">
            {busy && <LoaderCircle size={14} className="spin" />}确认
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImportSubjects({
  kind,
  projectId,
  linkedIds,
  onClose,
  onImported,
}: {
  kind: SubjectKind;
  projectId: string;
  linkedIds: string[];
  onClose: () => void;
  onImported: (assets: SubjectAsset[]) => void;
}) {
  const [assets, setAssets] = useState<SubjectAsset[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const guard = useRef(false);
  useEffect(() => {
    let stopped = false;
    api<{ items: SubjectAsset[] }>(`/assets?kind=${kind}`)
      .then((data) => {
        if (!stopped) setAssets(data.items);
      })
      .catch((e) => {
        if (!stopped) setError(errorMessage(e));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [kind]);
  async function submit() {
    if (guard.current || !selected.length) return;
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await api<{ items: SubjectAsset[] }>(
        `/projects/${projectId}/subjects/import`,
        { method: "POST", body: json({ asset_ids: selected }) },
      );
      onImported(response.items);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`从${labels[kind]}库添加`}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="sw-form">
        <p className="sw-hint">
          选择自己已有的素材关联到当前作品。修改关联素材会同步到素材库。
        </p>
        <input
          aria-label="搜索素材"
          placeholder="搜索名称"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && (
          <p role="alert" className="sw-error">
            {error}
          </p>
        )}
        {loading ? (
          <p>正在加载素材…</p>
        ) : (
          <div className="sw-import-grid">
            {assets
              .filter((asset) =>
                asset.name.toLowerCase().includes(query.toLowerCase()),
              )
              .map((asset) => {
                const linked = linkedIds.includes(asset.id),
                  checked = selected.includes(asset.id);
                return (
                  <button
                    key={asset.id}
                    className={checked ? "selected" : ""}
                    disabled={linked || busy}
                    onClick={() =>
                      setSelected((ids) =>
                        checked
                          ? ids.filter((id) => id !== asset.id)
                          : [...ids, asset.id],
                      )
                    }
                  >
                    {asset.url ? (
                      <img src={asset.url} alt="" />
                    ) : (
                      <ImageIcon size={26} />
                    )}
                    <strong>{asset.name}</strong>
                    <small>
                      {linked ? "已添加" : checked ? "已选择" : "选择素材"}
                    </small>
                    {checked && <Check size={16} />}
                  </button>
                );
              })}
            {!assets.length && (
              <p className="sw-hint">
                暂无{labels[kind]}素材，可先新建并存到素材库。
              </p>
            )}
          </div>
        )}
        <div className="sw-form-actions">
          <span>已选择 {selected.length} 项</span>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="sw-primary"
            disabled={!selected.length || busy}
            onClick={submit}
          >
            {busy && <LoaderCircle size={14} className="spin" />}添加到作品
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SubjectDetail({
  asset,
  project,
  onChange,
  onClose,
}: {
  asset: SubjectAsset;
  project: Project;
  onChange: (asset: SubjectAsset) => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState(asset),
    [draft, setDraft] = useState(() => subjectDraft(asset));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [slot, setSlot] = useState("main"),
    [tasks, setTasks] = useState<SubjectTask[]>([]);
  const [voicePicker, setVoicePicker] = useState(false),
    [voices, setVoices] = useState<Asset[]>([]);
  const [pollTick, setPollTick] = useState(0),
    [pollingFailed, setPollingFailed] = useState(false);
  const lock = useRef(false),
    dirty = JSON.stringify(draft) !== JSON.stringify(subjectDraft(saved)),
    dirtyRef = useRef(dirty);
  const voiceTextId = useId();
  dirtyRef.current = dirty;
  const { session, catalog, refreshSession, notify } = useApp();
  const label = labels[asset.kind] || "主体";
  const gallery = [
    ...subjectSlots,
    ...draft.metadata.gallery.filter(
      (item) => !subjectSlots.some((builtIn) => builtIn.id === item.id),
    ),
  ];
  const selectedImage =
    slot === "main"
      ? draft.url
      : draft.metadata.gallery.find((item) => item.id === slot)?.url || "";
  const selectedName =
    slot === "main"
      ? "主视觉"
      : gallery.find((item) => item.id === slot)?.name || "图片";
  const taskKey = tasks
    .filter(activeTask)
    .map((task) => task.id)
    .sort()
    .join(",");

  function edit(patch: Partial<SubjectDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }
  function metadata(patch: Partial<SubjectMetadata>) {
    setDraft((current) => ({
      ...current,
      metadata: { ...current.metadata, ...patch },
    }));
  }
  function voice(patch: Partial<SubjectMetadata["voice"]>) {
    setDraft((current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        voice: { ...current.metadata.voice, ...patch },
      },
    }));
  }
  function accept(updated: SubjectAsset) {
    setSaved(updated);
    setDraft(subjectDraft(updated));
    onChange(updated);
  }
  async function perform(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function persist(next = draft): Promise<SubjectAsset> {
    const response = await api<SubjectAsset>(`/assets/${saved.id}`, {
      method: "PATCH",
      body: json(subjectPatch(saved, next)),
    });
    accept(response);
    setNotice("已保存到本地");
    return response;
  }
  async function reload() {
    if (dirty && !window.confirm("重新加载将放弃未保存的修改，继续？")) return;
    await perform(async () => {
      accept(await api<SubjectAsset>(`/assets/${saved.id}`));
      setNotice("已重新加载最新内容");
    });
  }
  function close() {
    if (!busy && (!dirty || window.confirm("有未保存的修改，放弃修改并返回？")))
      onClose();
  }

  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !voicePicker &&
        !lock.current &&
        (!dirtyRef.current ||
          window.confirm("有未保存的修改，放弃修改并返回？"))
      )
        onClose();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("keydown", key);
    };
  }, [onClose, voicePicker]);
  useEffect(() => {
    let stopped = false;
    api<{ items: SubjectTask[] }>(`/tasks?project_id=${project.id}`)
      .then((data) => {
        if (!stopped)
          setTasks(
            data.items.filter((task) => task.parameters?.asset_id === asset.id),
          );
      })
      .catch((e) => {
        if (!stopped) setError(`生成记录加载失败：${errorMessage(e)}`);
      });
    return () => {
      stopped = true;
    };
  }, [asset.id, project.id]);
  useEffect(() => {
    if (!taskKey) return;
    let stopped = false;
    const timer = window.setTimeout(async () => {
      try {
        const updates = await Promise.all(
          taskKey.split(",").map((id) => api<SubjectTask>(`/tasks/${id}`)),
        );
        if (stopped) return;
        setTasks((current) =>
          current.map(
            (task) => updates.find((updated) => updated.id === task.id) || task,
          ),
        );
        if (updates.some((task) => !activeTask(task))) {
          refreshSession();
          if (updates.some((task) => task.status === "succeeded")) {
            if (dirtyRef.current || lock.current)
              setNotice(
                "生成已完成。当前有编辑内容，请先保存或重新加载以查看结果。",
              );
            else {
              const updated = await api<SubjectAsset>(`/assets/${asset.id}`);
              if (!stopped && !dirtyRef.current && !lock.current)
                accept(updated);
            }
          }
        }
        // A fresh task list triggers the next bounded polling cycle.
        if (updates.some(activeTask)) setPollTick((tick) => tick + 1);
      } catch (e) {
        if (!stopped) {
          setError(`无法更新任务进度：${errorMessage(e)}`);
          setPollingFailed(true);
        }
      }
    }, 2200);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // saved form changes must not restart or discard an in-flight task request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskKey, pollTick]);

  async function uploadImage(file: File) {
    await perform(async () => {
      if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
      const result = await upload(file);
      const next =
        slot === "main"
          ? subjectWithImage(
              draft,
              result.url,
              new Date().toISOString(),
              crypto.randomUUID(),
            )
          : {
              ...draft,
              metadata: {
                ...draft.metadata,
                gallery: updateGallery(draft.metadata.gallery, {
                  id: slot,
                  name: selectedName,
                  url: result.url,
                }),
              },
            };
      setDraft(next);
      await persist(next);
    });
  }
  async function generate(kind: "image" | "audio") {
    await perform(async () => {
      const prompt =
        kind === "image"
          ? draft.metadata.prompt.trim()
          : draft.metadata.voice.text.trim();
      if (!prompt)
        throw new Error(
          kind === "image" ? "请输入绘图提示词" : "请输入试听文本",
        );
      const pending =
        kind === "image" &&
        slot !== "main" &&
        !draft.metadata.gallery.some((item) => item.id === slot)
          ? {
              ...draft,
              metadata: {
                ...draft.metadata,
                gallery: updateGallery(draft.metadata.gallery, {
                  id: slot,
                  name: selectedName,
                  url: "",
                }),
              },
            }
          : draft;
      const current =
        dirty || pending !== draft ? await persist(pending) : saved;
      const normalized = subjectDraft(current);
      const parameters = {
        ...subjectTaskParameters(current, normalized, project, slot, kind),
        quality: normalized.metadata.quality,
        resolution: normalized.metadata.resolution,
      };
      const task = await api<SubjectTask>("/tasks", {
        method: "POST",
        body: json({
          kind,
          project_id: project.id,
          prompt,
          parameters,
          idempotency_key: crypto.randomUUID(),
        }),
      });
      setTasks((items) => [
        task,
        ...items.filter((item) => item.id !== task.id),
      ]);
      setNotice("任务已提交");
      refreshSession();
    });
  }
  function setMain(url: string) {
    setDraft((current) =>
      subjectWithImage(
        current,
        url,
        new Date().toISOString(),
        crypto.randomUUID(),
      ),
    );
    setSlot("main");
  }
  function clearImage() {
    if (!window.confirm(`移除「${selectedName}」图片？此操作会在保存后生效。`))
      return;
    if (slot === "main") setMain("");
    else
      metadata({
        gallery: draft.metadata.gallery.filter((item) => item.id !== slot),
      });
  }
  function addSlot() {
    const name = window.prompt("新增图片名称", "新视图");
    if (!name?.trim()) return;
    const id = crypto.randomUUID();
    metadata({
      gallery: [
        ...draft.metadata.gallery,
        { id, name: name.trim().slice(0, 100), url: "" },
      ],
    });
    setSlot(id);
  }
  async function importVoice() {
    await perform(async () => {
      const data = await api<{ items: Asset[] }>("/assets?kind=voice");
      setVoices(data.items);
      setVoicePicker(true);
    });
  }
  const modelOptions = (kind: string) =>
    catalog.models.filter(
      (model) => !model.kind || model.kind === kind || model.type === kind,
    );
  const inputModel = (
    kind: "image" | "audio",
    value: string,
    onChange: (value: string) => void,
  ) => (
    <>
      <input
        list={`sw-${kind}-models`}
        aria-label={kind === "image" ? "绘图模型" : "音频模型"}
        value={value}
        placeholder={
          kind === "image" ? "使用已配置的图片模型" : "请选择音频模型"
        }
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={`sw-${kind}-models`}>
        {modelOptions(kind).map((model, i) => (
          <option
            key={String(model.id || i)}
            value={String(model.id || model.name || "")}
          >
            {String(model.name || "")}
          </option>
        ))}
      </datalist>
    </>
  );

  return (
    <div
      className="sw-detail"
      role="dialog"
      aria-modal="true"
      aria-label={`${label}详情`}
    >
      <header className="sw-detail-header">
        <button onClick={close} disabled={busy}>
          <ArrowLeft size={16} />
          返回
        </button>
        <strong>{draft.name || label}</strong>
        <span className={`sw-save-state ${dirty ? "dirty" : ""}`} role="status">
          {busy ? "正在处理…" : dirty ? "有未保存修改" : "已保存到本地"}
        </span>
        <button disabled={busy} onClick={reload}>
          <RefreshCw size={14} />
          重新加载
        </button>
        <button
          disabled={busy || !dirty}
          onClick={() => perform(() => persist())}
        >
          <Save size={15} />
          保存设定
        </button>
        <button
          className="sw-primary"
          disabled={busy}
          onClick={() =>
            perform(async () => {
              const next = {
                ...draft,
                metadata: { ...draft.metadata, in_library: true },
              };
              setDraft(next);
              await persist(next);
              notify(`已存到${label}库`);
            })
          }
        >
          <Library size={15} />
          存到{label}库
        </button>
      </header>
      {(error || notice) && (
        <div
          className={error ? "sw-detail-message sw-error" : "sw-detail-message"}
          role={error ? "alert" : "status"}
        >
          {error || notice}
          {error && (
            <span>
              修改仍保留在表单中；若其他页面已更新素材，请重新加载后继续。
            </span>
          )}
        </div>
      )}
      <div className="sw-detail-columns">
        <section className="sw-settings">
          <header>
            <h2>{label}设定</h2>
            <p>生成分镜时将优先以主视觉为参考，建议生成或上传正面全身照</p>
          </header>
          <div className="sw-settings-grid">
            <fieldset className="sw-info" disabled={busy}>
              <label>
                {label}名称
                <input
                  maxLength={200}
                  required
                  value={draft.name}
                  onChange={(e) => edit({ name: e.target.value })}
                />
              </label>
              {asset.kind === "character" && (
                <>
                  <label>
                    角色定位
                    <input
                      placeholder="如：主角、反派、青梅竹马"
                      value={draft.metadata.role}
                      onChange={(e) => metadata({ role: e.target.value })}
                    />
                  </label>
                  <label>
                    年龄段
                    <input
                      placeholder="如：儿童、青年、中年、老年"
                      value={draft.metadata.age}
                      onChange={(e) => metadata({ age: e.target.value })}
                    />
                  </label>
                </>
              )}
              <label>
                出场信息
                <textarea
                  rows={3}
                  value={draft.metadata.performance_info}
                  aria-label="出场信息"
                  placeholder="请输入出场信息"
                  maxLength={20000}
                  onChange={(e) =>
                    metadata({ performance_info: e.target.value })
                  }
                />
              </label>
              <label>
                {label}描述
                <textarea
                  rows={3}
                  value={draft.description}
                  aria-label={`${label}描述`}
                  placeholder={`请输入${label}外观与特征`}
                  maxLength={10000}
                  onChange={(e) =>
                    edit({
                      description: e.target.value,
                      metadata: {
                        ...draft.metadata,
                        appearance: e.target.value,
                      },
                    })
                  }
                />
              </label>
              {asset.kind === "character" && (
                <>
                  <h3>角色音色</h3>
                  <label>
                    音频模型
                    {inputModel("audio", draft.metadata.voice.model, (model) =>
                      voice({ model }),
                    )}
                  </label>
                  <label>
                    音色描述
                    <textarea
                      rows={3}
                      maxLength={3000}
                      placeholder="请输入音色、语气与情绪描述"
                      value={draft.metadata.voice.description}
                      aria-label="音色描述"
                      onChange={(e) => voice({ description: e.target.value })}
                    />
                    <small>
                      {draft.metadata.voice.description.length} / 3000
                    </small>
                  </label>
                  <label htmlFor={voiceTextId}>
                    <span className="sw-label-row">
                      试听文本
                      <button
                        type="button"
                        className="sw-link"
                        onClick={() =>
                          voice({
                            text: "你好，很高兴认识你，今天想和你聊点什么呢？",
                          })
                        }
                      >
                        使用默认
                      </button>
                    </span>
                    <textarea
                      id={voiceTextId}
                      rows={3}
                      maxLength={3000}
                      placeholder="请输入试听文本"
                      value={draft.metadata.voice.text}
                      onChange={(e) => voice({ text: e.target.value })}
                    />
                    <small>{draft.metadata.voice.text.length} / 3000</small>
                  </label>
                  <button
                    className="sw-primary sw-full"
                    onClick={() => generate("audio")}
                    disabled={
                      busy ||
                      tasks.some(
                        (task) => activeTask(task) && task.kind === "audio",
                      )
                    }
                  >
                    <Volume2 size={15} />
                    生成试听音频
                  </button>
                  <small className="sw-provider">
                    {session?.provider_status.audio
                      ? "使用已配置的音频服务"
                      : "服务未配置 · 提交不扣费"}
                  </small>
                  <div className="sw-voice-actions">
                    <button onClick={importVoice}>
                      <Library size={13} />
                      从音色库导入
                    </button>
                    <FileButton
                      label="上传音频文件"
                      accept="audio/*"
                      disabled={busy}
                      onFile={(file) =>
                        perform(async () => {
                          if (!file.type.startsWith("audio/"))
                            throw new Error("请选择音频文件");
                          const result = await upload(file);
                          const next = {
                            ...draft,
                            metadata: {
                              ...draft.metadata,
                              voice: {
                                ...draft.metadata.voice,
                                url: result.url,
                              },
                            },
                          };
                          setDraft(next);
                          await persist(next);
                        })
                      }
                    />
                  </div>
                  <h3>角色音频</h3>
                  {draft.metadata.voice.url ? (
                    <>
                      <audio
                        controls
                        src={draft.metadata.voice.url}
                        preload="metadata"
                      />
                      <a
                        className="sw-download"
                        href={draft.metadata.voice.url}
                        download
                      >
                        <Download size={13} />
                        下载音频
                      </a>
                    </>
                  ) : (
                    <p className="sw-hint">
                      暂无音频，可生成试听或上传本地音频文件
                    </p>
                  )}
                </>
              )}
            </fieldset>
            <fieldset className="sw-image-settings" disabled={busy}>
              <h3>生图设定</h3>
              <label>
                绘图比例
                <select
                  value={draft.metadata.aspect_ratio || project.aspect_ratio}
                  onChange={(e) => metadata({ aspect_ratio: e.target.value })}
                >
                  {["16:9", "9:16", "1:1", "4:3", "3:4"].map((ratio) => (
                    <option key={ratio}>{ratio}</option>
                  ))}
                </select>
              </label>
              <label>
                绘图模型
                {inputModel(
                  "image",
                  draft.metadata.image_model,
                  (image_model) => metadata({ image_model }),
                )}
              </label>
              <label>
                画质
                <select
                  value={String(draft.metadata.quality || "medium")}
                  onChange={(e) => metadata({ quality: e.target.value })}
                >
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </label>
              <label>
                清晰度
                <select
                  value={String(draft.metadata.resolution || "1K")}
                  onChange={(e) => metadata({ resolution: e.target.value })}
                >
                  <option>1K</option>
                  <option>2K</option>
                  <option>4K</option>
                </select>
              </label>
              <label className="sw-prompt-label">
                绘图提示词
                <textarea
                  rows={10}
                  maxLength={10000}
                  placeholder="如：外貌特征、服饰风格等"
                  value={draft.metadata.prompt}
                  onChange={(e) => metadata({ prompt: e.target.value })}
                />
                <small>{draft.metadata.prompt.length} / 10000</small>
              </label>
              <button
                className="sw-primary sw-full"
                disabled={
                  busy ||
                  tasks.some(
                    (task) => activeTask(task) && task.kind === "image",
                  )
                }
                onClick={() => generate("image")}
              >
                <Sparkles size={15} />
                生成{selectedName}图片
              </button>
              <small className="sw-provider">
                {session?.provider_status.image
                  ? "使用已配置的图片服务"
                  : "服务未配置 · 提交不扣费"}
              </small>
            </fieldset>
          </div>
        </section>
        <section className="sw-visual">
          <header>
            <h2>{selectedName}</h2>
            <div>
              {selectedImage && (
                <>
                  <a href={selectedImage} download className="sw-download">
                    <Download size={15} />
                    下载
                  </a>
                  <button
                    disabled={busy}
                    onClick={clearImage}
                    aria-label={`移除${selectedName}图片`}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </div>
          </header>
          <div
            className="sw-preview"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file && !busy) uploadImage(file);
            }}
          >
            {selectedImage ? (
              <img src={selectedImage} alt={`${draft.name} ${selectedName}`} />
            ) : (
              <div className="sw-preview-empty">
                <img src="/reference/embedded-016f974b60b1.png" alt="" />
                <p>暂无预览图，可拖拽至此上传图片</p>
              </div>
            )}
            <div className="sw-preview-actions">
              <FileButton
                label={`上传${selectedName}`}
                accept="image/*"
                disabled={busy}
                onFile={uploadImage}
              />
              {slot !== "main" && selectedImage && (
                <button disabled={busy} onClick={() => setMain(selectedImage)}>
                  设为主视觉
                </button>
              )}
            </div>
          </div>
          <div className="sw-gallery">
            <header>
              <span>主视觉与多视图</span>
              <button onClick={addSlot} disabled={busy}>
                <Plus size={14} />
                新增
              </button>
            </header>
            <div className="sw-gallery-strip">
              <button
                className={slot === "main" ? "active" : ""}
                aria-label="主视觉"
                onClick={() => setSlot("main")}
              >
                <div>
                  {draft.url ? (
                    <img src={draft.url} alt="主视觉" />
                  ) : (
                    <ImageIcon size={24} />
                  )}
                </div>
                <span>主视觉</span>
              </button>
              {gallery.map((item) => {
                const image = draft.metadata.gallery.find(
                  (entry) => entry.id === item.id,
                );
                return (
                  <button
                    key={item.id}
                    aria-label={item.name}
                    className={slot === item.id ? "active" : ""}
                    onClick={() => setSlot(item.id)}
                  >
                    <div>
                      {image?.url ? (
                        <img src={image.url} alt={item.name} />
                      ) : (
                        <ImageIcon size={22} />
                      )}
                    </div>
                    <span>{item.name}</span>
                  </button>
                );
              })}
            </div>
            <small>以上内容由人工智能生成合成</small>
          </div>
        </section>
        <aside className="sw-versions">
          <header>
            <h3>版本记录</h3>
            <span>{draft.metadata.versions.length + tasks.length || ""}</span>
          </header>
          {!tasks.length && !draft.metadata.versions.length ? (
            <div className="sw-versions-empty">
              <img src="/reference/embedded-016f974b60b1.png" alt="" />
              <p>暂无版本记录</p>
            </div>
          ) : (
            <div className="sw-version-list">
              {tasks.map((task) => (
                <article key={task.id} className="sw-task">
                  <header>
                    <strong>
                      {task.kind === "audio" ? "音频生成" : "图片生成"}
                    </strong>
                    <span>{taskLabels[task.status] || task.status}</span>
                  </header>
                  <small>{new Date(task.created_at).toLocaleString()}</small>
                  {activeTask(task) && (
                    <progress
                      max={100}
                      value={task.progress || 0}
                      aria-label="生成进度"
                    />
                  )}
                  {task.error && <p className="sw-error">{task.error}</p>}
                  {(task.result.asset_applied === false ||
                    (!!task.result.application &&
                      typeof task.result.application === "object" &&
                      "status" in task.result.application &&
                      task.result.application.status !== "applied")) && (
                    <p className="sw-hint">
                      素材已更新，生成结果未覆盖当前设定。
                    </p>
                  )}
                  {typeof task.result.url === "string" &&
                    (task.kind === "audio" ? (
                      <audio
                        src={task.result.url}
                        controls
                        preload="metadata"
                      />
                    ) : (
                      <img src={task.result.url} alt="生成结果" />
                    ))}
                  {typeof task.result.url === "string" && (
                    <a className="sw-download" href={task.result.url} download>
                      <Download size={13} />
                      下载结果
                    </a>
                  )}
                </article>
              ))}
              {draft.metadata.versions.map((version) => (
                <article key={version.id}>
                  {version.kind === "audio" ? (
                    <audio src={version.url} controls preload="metadata" />
                  ) : (
                    <img src={version.url} alt={version.name} />
                  )}
                  <strong>{version.name}</strong>
                  {version.created_at && (
                    <small>
                      {new Date(version.created_at).toLocaleString()}
                    </small>
                  )}
                  <div>
                    <button
                      disabled={busy}
                      onClick={() =>
                        version.kind === "audio"
                          ? voice({ url: version.url })
                          : setMain(version.url)
                      }
                    >
                      {version.kind === "audio" ? "使用此音频" : "设为主视觉"}
                    </button>
                    <a
                      className="sw-download"
                      href={version.url}
                      download
                      aria-label={`下载${version.name}`}
                    >
                      <Download size={14} />
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}
          {pollingFailed && (
            <button
              onClick={() => {
                setPollingFailed(false);
                setPollTick((tick) => tick + 1);
              }}
            >
              <RefreshCw size={14} />
              重试更新进度
            </button>
          )}
        </aside>
      </div>
      {voicePicker && (
        <Modal title="从音色库导入" onClose={() => setVoicePicker(false)}>
          <div className="sw-form">
            {voices.length ? (
              voices.map((item) => (
                <article className="sw-voice-option" key={item.id}>
                  <strong>{item.name}</strong>
                  {item.url && <audio src={item.url} controls preload="none" />}
                  <button
                    disabled={!item.url}
                    onClick={() => {
                      voice({ url: item.url, description: item.description });
                      setVoicePicker(false);
                    }}
                  >
                    使用音色
                  </button>
                </article>
              ))
            ) : (
              <p className="sw-hint">暂无音色素材，请先上传音频文件。</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
