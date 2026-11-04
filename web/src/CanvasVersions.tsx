import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { History, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { api, json } from "./api";
import type { CanvasGraph } from "./canvas-commands";
import "./canvas-versions.css";

type Version = {
  id: string;
  project_id: string;
  revision: number;
  kind: string;
  name: string;
  created_at: string;
  node_count: number;
  edge_count: number;
};
type VersionPage = {
  items: Version[];
  total: number;
  limit: number;
  offset: number;
};
export type VersionGraph = CanvasGraph & { revision: number };
type Preview = Version & VersionGraph;
type Props = {
  projectId: string;
  prepare: () => Promise<number | null>;
  onRestored: (graph: VersionGraph) => void;
  onClose: () => void;
};
const kindLabel: Record<string, string> = {
  manual: "手动保存",
  auto: "自动保存",
  before_restore: "恢复前备份",
  restored: "恢复结果",
};
const title = (version: Version) =>
  version.name || kindLabel[version.kind] || "画布版本";
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请重试";
const pageSize = 20;

export default function CanvasVersions({
  projectId,
  prepare,
  onRestored,
  onClose,
}: Props) {
  const [page, setPage] = useState<VersionPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const scope = useRef(projectId);
  scope.current = projectId;
  const lifetime = useRef({ mounted: false, epoch: 0 });
  const requests = useRef(new Set<AbortController>());
  const base = `/projects/${projectId}/canvas/versions`;

  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    lifetime.current.epoch += 1;
    return () => {
      lifetime.current.mounted = false;
      lifetime.current.epoch += 1;
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
  }, [projectId]);

  useEffect(() => {
    setOffset(0);
    setPage(null);
    setSelectedId(null);
    setPreview(null);
    setBusy(false);
    setName("");
    setActionError("");
    setNotice("");
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError("");
    api<VersionPage>(`${base}?limit=${pageSize}&offset=${offset}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setListError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, offset, refresh]);

  useEffect(() => {
    setPreview(null);
    setPreviewError("");
    if (!selectedId) {
      setPreviewLoading(false);
      return;
    }
    const controller = new AbortController();
    setPreviewLoading(true);
    api<Preview>(`${base}/${selectedId}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPreviewError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [base, selectedId, previewRefresh]);

  function refreshList() {
    setOffset(0);
    setRefresh((value) => value + 1);
  }
  async function save() {
    const epoch = lifetime.current.epoch;
    const active = () =>
      lifetime.current.mounted &&
      lifetime.current.epoch === epoch &&
      scope.current === projectId;
    const controller = new AbortController();
    requests.current.add(controller);
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const revision = await prepare();
      if (revision === null)
        throw new Error(
          "当前画布尚未保存，版本保存已取消。请处理画布保存错误后重试。",
        );
      if (!active()) return;
      const result = await api<Version>(base, {
        method: "POST",
        body: json({ name: name.trim(), revision }),
        signal: controller.signal,
      });
      if (!active()) return;
      setName("");
      setSelectedId(result.id);
      setNotice("版本已保存");
      refreshList();
    } catch (error) {
      if (active()) setActionError(errorMessage(error));
    } finally {
      requests.current.delete(controller);
      if (active()) setBusy(false);
    }
  }
  async function restore() {
    if (
      !preview ||
      !window.confirm(
        `恢复“${title(preview)}”（修订 ${preview.revision}）？当前画布会先保留为“恢复前备份”，之后仍可恢复。`,
      )
    )
      return;
    const epoch = lifetime.current.epoch;
    const active = () =>
      lifetime.current.mounted &&
      lifetime.current.epoch === epoch &&
      scope.current === projectId;
    const controller = new AbortController();
    requests.current.add(controller);
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const revision = await prepare();
      if (revision === null)
        throw new Error(
          "当前画布尚未保存，恢复已取消。请处理画布保存错误后重试。",
        );
      if (!active()) return;
      const result = await api<VersionGraph>(`${base}/${preview.id}/restore`, {
        method: "POST",
        body: json({ revision }),
        signal: controller.signal,
      });
      if (!active()) return;
      onRestored(result);
      setNotice(`已恢复为修订 ${result.revision}，恢复前的画布已备份`);
      refreshList();
    } catch (error) {
      if (active()) setActionError(errorMessage(error));
    } finally {
      requests.current.delete(controller);
      if (active()) setBusy(false);
    }
  }

  return (
    <aside
      className="canvas-versions"
      role="dialog"
      aria-label="画布版本历史"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="canvas-versions-heading">
        <h2>
          <History size={18} />
          版本历史
        </h2>
        <button
          className="icon-button"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭版本历史"
        >
          <X size={18} />
        </button>
      </header>
      <p className="canvas-versions-hint">
        版本保存在服务器。恢复时会保留当前画布的备份。
      </p>
      <form
        className="canvas-versions-save"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input
          aria-label="版本名称"
          placeholder="版本名称（可选）"
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Save size={15} />
          )}
          保存版本
        </button>
      </form>
      {actionError && (
        <div className="canvas-versions-error" role="alert">
          {actionError}
        </div>
      )}
      {notice && (
        <p className="canvas-versions-notice" role="status">
          {notice}
        </p>
      )}
      <div className="canvas-versions-list-heading">
        <span>已保存版本{page ? ` · ${page.total}` : ""}</span>
        <button
          className="icon-button"
          onClick={refreshList}
          disabled={busy || loading}
          aria-label="刷新版本列表"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {listError && (
        <div className="canvas-versions-error" role="alert">
          加载版本失败：{listError}
          <button onClick={refreshList} disabled={busy}>
            重试
          </button>
        </div>
      )}
      <div className="canvas-versions-list" aria-busy={loading}>
        {loading && (
          <p className="canvas-versions-hint" role="status">
            正在加载版本…
          </p>
        )}
        {!loading && !listError && !page?.items.length && (
          <p className="canvas-versions-hint">还没有保存的版本</p>
        )}
        {page?.items.map((version) => (
          <button
            className={`canvas-version-row${selectedId === version.id ? " selected" : ""}`}
            key={version.id}
            onClick={() => setSelectedId(version.id)}
            disabled={busy}
            aria-pressed={selectedId === version.id}
          >
            <strong>{title(version)}</strong>
            <time dateTime={version.created_at}>
              {new Date(version.created_at).toLocaleString()}
            </time>
            <span>
              修订 {version.revision} · {version.node_count} 个节点 ·{" "}
              {version.edge_count} 条连线
            </span>
          </button>
        ))}
      </div>
      {!!page?.total && (
        <nav className="canvas-versions-pagination" aria-label="版本分页">
          <button
            disabled={busy || loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            上一页
          </button>
          <span>
            {offset + 1}–{Math.min(offset + pageSize, page.total)} /{" "}
            {page.total}
          </span>
          <button
            disabled={busy || loading || offset + pageSize >= page.total}
            onClick={() => setOffset(offset + pageSize)}
          >
            下一页
          </button>
        </nav>
      )}
      {selectedId && (
        <section className="canvas-version-preview" aria-label="版本预览">
          {previewLoading && <p role="status">正在读取版本…</p>}
          {previewError && (
            <div className="canvas-versions-error" role="alert">
              {previewError}
              <button onClick={() => setPreviewRefresh((value) => value + 1)}>
                重试
              </button>
            </div>
          )}
          {preview && (
            <>
              <h3>{title(preview)}</h3>
              <p>
                修订 {preview.revision} · {preview.node_count} 个节点 ·{" "}
                {preview.edge_count} 条连线
              </p>
              <ul>
                {preview.nodes.slice(0, 30).map((node, index) => (
                  <li key={`${node.id}-${index}`}>
                    {typeof node.data?.label === "string" && node.data.label
                      ? node.data.label
                      : node.id}
                  </li>
                ))}
              </ul>
              {preview.nodes.length > 30 && (
                <p>另有 {preview.nodes.length - 30} 个节点</p>
              )}
              <button
                className="primary"
                disabled={busy}
                onClick={() => void restore()}
              >
                恢复此版本
              </button>
            </>
          )}
        </section>
      )}
    </aside>
  );
}
