import {
  useCallback,
  useContext,
  createContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  Plus,
  Type,
  Image,
  Video,
  Music,
  Upload,
  Download,
  Trash2,
  Save,
  Undo2,
  Redo2,
  MousePointer2,
  Hand,
  ChevronDown,
  Sparkles,
  History,
  LoaderCircle,
  MoreHorizontal,
  PanelRightClose,
  Check,
  Maximize,
  Copy,
  Settings,
  X,
  Scissors,
} from "lucide-react";
import { api, json, upload } from "./api";
import { canvasSnapshot } from "./domain";
import {
  cloneSubgraph,
  CanvasGraphHistory,
  deleteSelection,
  parseCanvasGraph,
  selectedSubgraph,
  serializeCanvasGraph,
  type CanvasNodeData,
  type CanvasGraph,
} from "./canvas-commands";
import "./canvas-detail.css";
import CanvasVersions, { type VersionGraph } from "./CanvasVersions";
import MediaTools from "./MediaTools";
import type { MediaKind } from "./media-tools-domain";
import {
  canvasMediaBaseline,
  canvasMediaTarget,
  canApplyCanvasMediaResult,
  type CanvasMediaBaseline,
} from "./canvas-media";
import { useApp, Modal, Loading, ErrorPanel, Empty } from "./App";
import type { Project, Task } from "./types";
type MediaData = CanvasNodeData;
type FlowNode = Node<MediaData>;
export function canvasTaskMediaURL(task: Task): string {
  const url = task.result.url || task.result[`${task.kind}_url`];
  return task.status === "succeeded" &&
    typeof url === "string" &&
    /^\/media\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(url)
    ? url
    : "";
}
type MediaWatchCallbacks = {
  current: () => boolean;
  read: () => Promise<Task>;
  complete: (
    task: Task,
    baseline: CanvasMediaBaseline | null,
  ) => Promise<void> | void;
  failed: (task: Task) => void;
  unavailable: (error: unknown) => void;
  stopped: (interval: ReturnType<typeof setInterval>) => void;
};

export function watchCanvasMediaTask(
  initial: Task,
  baseline: CanvasMediaBaseline | null,
  callbacks: MediaWatchCallbacks,
) {
  const submittedBaseline = baseline ? Object.freeze({ ...baseline }) : null;
  let stopped = false,
    reading = false,
    warned = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    callbacks.stopped(interval);
  }
  async function accept(task: Task) {
    if (stopped) return;
    if (!callbacks.current()) {
      stop();
      return;
    }
    if (task.status === "succeeded") {
      stop();
      await callbacks.complete(task, submittedBaseline);
    } else if (["failed", "canceled"].includes(task.status)) {
      stop();
      callbacks.failed(task);
    }
  }
  async function poll() {
    if (stopped || reading) return;
    if (!callbacks.current()) {
      stop();
      return;
    }
    reading = true;
    try {
      const result = await callbacks.read();
      await accept(result);
      warned = false;
    } catch (error) {
      if (!stopped && callbacks.current() && !warned) {
        warned = true;
        callbacks.unavailable(error);
      }
    } finally {
      reading = false;
    }
  }
  const interval = setInterval(() => void poll(), 1200);
  // Registration happens before this microtask, including already-complete
  // idempotent replays. The watcher belongs to the canvas, not its modal.
  void Promise.resolve().then(async () => {
    await accept(initial);
    if (!stopped) await poll();
  });
  return { interval, stop };
}
const CanvasContext = createContext<{
  update: (id: string, patch: Partial<MediaData>) => void;
  remove: (id: string) => void;
  generate: (id: string, kind: string, prompt: string) => void;
  file: (id: string, file: File) => void;
  editMedia: (id: string) => void;
}>({
  update: () => {},
  remove: () => {},
  generate: () => {},
  file: () => {},
  editMedia: () => {},
});
function MediaNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { update, remove, generate, file, editMedia } =
    useContext(CanvasContext);
  const Icon =
    data.kind === "text"
      ? Type
      : data.kind === "video"
        ? Video
        : data.kind === "audio"
          ? Music
          : Image;
  return (
    <div className={`canvas-node ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <header>
        <Icon size={15} />
        <input
          className="nodrag"
          value={data.label}
          onChange={(e) => update(id, { label: e.target.value })}
          aria-label="节点名称"
        />
        <button
          className="icon-button nodrag"
          aria-label="删除节点"
          onClick={() => remove(id)}
        >
          <Trash2 size={14} />
        </button>
      </header>
      {data.kind === "text" ? (
        <textarea
          className="nodrag nowheel node-text"
          placeholder="输入文字、剧本或创意…"
          value={data.text}
          onChange={(e) => update(id, { text: e.target.value })}
        />
      ) : (
        <>
          <div className="node-media">
            {data.url ? (
              data.kind === "image" ? (
                <img src={data.url} alt={data.label} />
              ) : data.kind === "video" ? (
                <video className="nodrag" controls src={data.url} />
              ) : (
                <audio className="nodrag" controls src={data.url} />
              )
            ) : (
              <label className="nodrag node-upload">
                <Icon size={30} />
                <span>
                  点击上传
                  {data.kind === "image"
                    ? "图片"
                    : data.kind === "video"
                      ? "视频"
                      : "音频"}
                </span>
                <input
                  type="file"
                  accept={`${data.kind}/*`}
                  onChange={(e) => {
                    if (e.target.files?.[0]) file(id, e.target.files[0]);
                  }}
                />
              </label>
            )}
          </div>
          <textarea
            className="nodrag nowheel node-prompt"
            placeholder="描述想要生成的内容…"
            value={data.text}
            onChange={(e) => update(id, { text: e.target.value })}
          />
          <footer>
            <button
              className="nodrag"
              onClick={() => generate(id, data.kind, data.text)}
            >
              <Sparkles size={13} />
              生成
            </button>
            {data.url && (
              <button
                className="nodrag"
                aria-label={`编辑媒体 ${data.label}`}
                onClick={() => editMedia(id)}
              >
                <Scissors size={13} />
                {data.kind === "image"
                  ? "剪裁"
                  : data.kind === "audio"
                    ? "音频截取"
                    : "媒体编辑"}
              </button>
            )}
            {data.url && (
              <a className="nodrag icon-button" href={data.url} download>
                <Download size={14} />
              </a>
            )}
          </footer>
        </>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { media: MediaNode };
export default function CanvasEditor() {
  const params = useParams();
  const projectId = params.id || params.projectId || "";
  return (
    <ReactFlowProvider key={projectId}>
      <CanvasInner key={projectId} />
    </ReactFlowProvider>
  );
}
function CanvasInner() {
  const params = useParams(),
    id = params.id || params.projectId || "",
    nav = useNavigate(),
    { notify, session } = useApp(),
    flow = useReactFlow<FlowNode>();
  const [project, setProject] = useState<Project | null>(null),
    [nodes, setNodes] = useState<FlowNode[]>([]),
    [edges, setEdges] = useState<Edge[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [saveState, setSaveState] = useState("已保存"),
    [revision, setRevision] = useState(0),
    [pan, setPan] = useState(false),
    [menu, setMenu] = useState(false),
    [modal, setModal] = useState(""),
    [taskKind, setTaskKind] = useState("image"),
    [prompt, setPrompt] = useState(""),
    [target, setTarget] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<Task[]>([]),
    [spaceHeld, setSpaceHeld] = useState(false),
    [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
      null,
    ),
    [clipboardText, setClipboardText] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [mediaSource, setMediaSource] = useState<{
    nodeId: string;
    url: string;
    kind: MediaKind;
  } | null>(null);
  const mediaBaseline = useRef<CanvasMediaBaseline | null>(null);
  const versionsOpenRef = useRef(false);
  const restoreViewport = useRef<Promise<void> | null>(null);
  const lifecycle = useRef({ mounted: false, epoch: 0 });
  const loadRequest = useRef<AbortController | null>(null);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskPolls = useRef(new Set<ReturnType<typeof setInterval>>());
  const mediaTasksWatched = useRef(new Set<string>());
  const editorRef = useRef<HTMLDivElement>(null);
  const pasteCount = useRef(0);
  const revisionRef = useRef(0),
    loaded = useRef(false),
    lastSaved = useRef(""),
    saving = useRef(false),
    flushPromise = useRef<Promise<void> | null>(null),
    graphRef = useRef({ nodes, edges }),
    [viewVersion, setViewVersion] = useState(0),
    saveRef = useRef<() => Promise<void>>(async () => {}),
    graphHistory = useRef(new CanvasGraphHistory()),
    [historyVersion, setHistoryVersion] = useState(0);
  useLayoutEffect(() => {
    lifecycle.current.mounted = true;
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.epoch += 1;
      loaded.current = false;
      loadRequest.current?.abort();
      if (viewportTimer.current) clearTimeout(viewportTimer.current);
      for (const interval of taskPolls.current) clearInterval(interval);
      taskPolls.current.clear();
    };
  }, []);
  // Update the ref with the same graph as React state so consecutive commands,
  // event callbacks and an in-flight save always observe the latest edit.
  const replaceGraph = useCallback(
    (graph: { nodes: FlowNode[]; edges: Edge[] }) => {
      graphRef.current = graph;
      setNodes(graph.nodes);
      setEdges(graph.edges);
    },
    [],
  );
  const remember = useCallback(() => {
    graphHistory.current.record(graphRef.current);
    setHistoryVersion((v) => v + 1);
  }, []);
  const load = useCallback(async () => {
    if (!lifecycle.current.mounted) return;
    loadRequest.current?.abort();
    if (viewportTimer.current) clearTimeout(viewportTimer.current);
    const controller = new AbortController();
    loadRequest.current = controller;
    const epoch = ++lifecycle.current.epoch;
    const current = () =>
      lifecycle.current.mounted &&
      lifecycle.current.epoch === epoch &&
      !controller.signal.aborted;
    setLoading(true);
    setError("");
    try {
      const [p, graph] = await Promise.all([
        api<Project>(`/projects/${id}`, { signal: controller.signal }),
        api<any>(`/projects/${id}/canvas`, { signal: controller.signal }),
      ]);
      if (!current()) return;
      setProject(p);
      replaceGraph({ nodes: graph.nodes || [], edges: graph.edges || [] });
      graphHistory.current.clear();
      setHistoryVersion((v) => v + 1);
      revisionRef.current = graph.revision || 0;
      setRevision(revisionRef.current);
      lastSaved.current = JSON.stringify({
        nodes: graph.nodes || [],
        edges: graph.edges || [],
        viewport: graph.viewport || { x: 0, y: 0, zoom: 1 },
      });
      loaded.current = true;
      viewportTimer.current = setTimeout(() => {
        if (current())
          void flow.setViewport(graph.viewport || { x: 0, y: 0, zoom: 1 });
      }, 50);
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  async function save() {
    if (restoreViewport.current) await restoreViewport.current;
    if (!loaded.current) return;
    if (flushPromise.current) return flushPromise.current;
    const flush = async () => {
      saving.current = true;
      setSaveState("保存中…");
      try {
        while (loaded.current) {
          const latest = graphRef.current;
          const graph = canvasSnapshot(
            latest.nodes,
            latest.edges,
            flow.getViewport(),
            revisionRef.current,
          );
          const value = JSON.stringify({
            nodes: graph.nodes,
            edges: graph.edges,
            viewport: graph.viewport,
          });
          if (value === lastSaved.current) break;
          const result = await api<any>(`/projects/${id}/canvas`, {
            method: "PUT",
            body: json(graph),
          });
          if (!lifecycle.current.mounted) return;
          revisionRef.current = result.revision ?? revisionRef.current + 1;
          setRevision(revisionRef.current);
          lastSaved.current = value;
        }
        setSaveState("已保存");
      } catch (e) {
        if (!lifecycle.current.mounted) return;
        setSaveState("保存失败");
        notify((e as Error).message, "error");
        throw e;
      } finally {
        saving.current = false;
      }
    };
    flushPromise.current = flush();
    try {
      await flushPromise.current;
    } finally {
      flushPromise.current = null;
    }
  }
  saveRef.current = save;
  function openVersions() {
    if (busy || modal) return;
    versionsOpenRef.current = true;
    setVersionsOpen(true);
    setMenu(false);
    setContextMenu(null);
    setSpaceHeld(false);
  }
  async function prepareVersionAction() {
    try {
      await saveRef.current();
      return loaded.current ? revisionRef.current : null;
    } catch {
      return null;
    }
  }
  function applyRestoredVersion(graph: VersionGraph) {
    if (!lifecycle.current.mounted) return;
    const restored = { nodes: graph.nodes, edges: graph.edges };
    const viewport = graph.viewport || { x: 0, y: 0, zoom: 1 };
    replaceGraph(restored);
    graphHistory.current.clear();
    setHistoryVersion((version) => version + 1);
    revisionRef.current = graph.revision;
    setRevision(graph.revision);
    const snapshot = canvasSnapshot(
      restored.nodes,
      restored.edges,
      viewport,
      graph.revision,
    );
    lastSaved.current = JSON.stringify({
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      viewport,
    });
    setSaveState("已保存");
    // Any pending autosave waits until the restored viewport matches the
    // fingerprint, so restoring a version does not create another edit.
    restoreViewport.current = flow
      .setViewport(viewport, { duration: 0 })
      .then(() => {
        if (lifecycle.current.mounted) setViewVersion((version) => version + 1);
      })
      .finally(() => {
        restoreViewport.current = null;
      });
  }
  useEffect(() => {
    if (!loaded.current) return;
    setSaveState("等待保存");
    const timer = setTimeout(() => saveRef.current().catch(() => {}), 900);
    return () => clearTimeout(timer);
  }, [nodes, edges, viewVersion]);
  useEffect(() => {
    const handler = () => {
      saveRef.current().catch(() => {});
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  function commandBlocked(target: EventTarget | null) {
    const element = target instanceof Element ? target : null;
    return (
      versionsOpenRef.current ||
      !!modal ||
      !!element?.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog']",
      )
    );
  }
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(
          ".canvas-context-menu, .canvas-add-menu, [data-canvas-menu-trigger]",
        )
      ) {
        setMenu(false);
        setContextMenu(null);
      }
    };
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
        setContextMenu(null);
        setSpaceHeld(false);
        return;
      }
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        commandBlocked(event.target)
      )
        return;
      const element = event.target instanceof Element ? event.target : null;
      if (
        element &&
        element !== document.body &&
        !editorRef.current?.contains(element)
      )
        return;
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === "v") return; // The paste event supplies plain text without clipboard-read permission.
        if (["a", "c", "d", "z", "y"].includes(key)) {
          event.preventDefault();
          if (event.repeat) return;
          if (key === "a") selectAll();
          if (key === "c") void copySelected();
          if (key === "d") duplicateSelected();
          if (key === "z") event.shiftKey ? redo() : undo();
          if (key === "y") redo();
        }
        return;
      }
      if (["Backspace", "Delete"].includes(event.key)) {
        event.preventDefault();
        if (!event.repeat) removeSelected();
      }
      if (event.key === " ") {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || commandBlocked(event.target)) return;
      const element = event.target instanceof Element ? event.target : null;
      if (
        element &&
        element !== document.body &&
        !editorRef.current?.contains(element)
      )
        return;
      event.preventDefault();
      pasteGraph(event.clipboardData?.getData("text/plain") || "");
    };
    const release = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", handler);
    window.addEventListener("paste", paste);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", handler);
      window.removeEventListener("paste", paste);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
    };
  });
  function applyCommand(graph: { nodes: FlowNode[]; edges: Edge[] }) {
    if (versionsOpenRef.current) return;
    remember();
    replaceGraph(graph);
    setContextMenu(null);
  }
  function selectAll() {
    if (versionsOpenRef.current) return;
    const graph = graphRef.current;
    replaceGraph({
      nodes: graph.nodes.map((node) => ({ ...node, selected: true })),
      edges: graph.edges.map((edge) => ({ ...edge, selected: true })),
    });
    setContextMenu(null);
  }
  function appendGraph(graph: CanvasGraph, offset = { x: 48, y: 48 }) {
    const current = graphRef.current;
    if (
      current.nodes.length + graph.nodes.length > 2000 ||
      current.edges.length + graph.edges.length > 6000
    )
      throw new Error("画布最多支持 2000 个节点和 6000 条连线");
    const existing = new Set([
      ...current.nodes.map((node) => node.id),
      ...current.edges.map((edge) => edge.id),
    ]);
    const cloned = cloneSubgraph(
      graph,
      () => {
        let newId = crypto.randomUUID();
        while (existing.has(newId)) newId = crypto.randomUUID();
        existing.add(newId);
        return newId;
      },
      offset,
    );
    applyCommand({
      nodes: [
        ...current.nodes.map((node) => ({ ...node, selected: false })),
        ...cloned.nodes,
      ],
      edges: [
        ...current.edges.map((edge) => ({ ...edge, selected: false })),
        ...cloned.edges,
      ],
    });
  }
  function duplicateSelected() {
    const selected = selectedSubgraph(graphRef.current);
    if (!selected.nodes.length) return;
    try {
      appendGraph(selected);
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  async function copySelected() {
    const selected = selectedSubgraph(graphRef.current);
    if (!selected.nodes.length) return;
    const text = serializeCanvasGraph(selected);
    setContextMenu(null);
    pasteCount.current = 0;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      notify(`已复制 ${selected.nodes.length} 个节点及内部连线`);
    } catch {
      setClipboardText(text);
      setModal("copy");
    }
  }
  function pasteGraph(text: string) {
    try {
      const graph = parseCanvasGraph(text);
      if (!graph.nodes.length) throw new Error("粘贴数据中没有节点");
      const offset = 48 * (pasteCount.current + 1);
      appendGraph(graph, { x: offset, y: offset });
      pasteCount.current += 1;
      setModal("");
      notify(`已粘贴 ${graph.nodes.length} 个节点及内部连线`);
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  async function pasteFromClipboard() {
    setContextMenu(null);
    try {
      if (!navigator.clipboard?.readText)
        throw new Error("Clipboard unavailable");
      pasteGraph(await navigator.clipboard.readText());
    } catch {
      setClipboardText("");
      setModal("paste");
    }
  }
  function removeSelected() {
    const graph = graphRef.current;
    if (
      !graph.nodes.some((node) => node.selected) &&
      !graph.edges.some((edge) => edge.selected)
    )
      return;
    applyCommand(deleteSelection(graph));
  }
  function update(nodeId: string, patch: Partial<MediaData>) {
    const graph = graphRef.current;
    if (!graph.nodes.some((node) => node.id === nodeId)) return;
    applyCommand({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...patch } }
          : node,
      ),
    });
  }
  function remove(nodeId: string) {
    const graph = graphRef.current;
    if (!graph.nodes.some((node) => node.id === nodeId)) return;
    applyCommand(deleteSelection(graph, [nodeId]));
  }
  function add(kind: string, url?: string, text = "") {
    const position = flow.screenToFlowPosition({
      x: window.innerWidth / 2 - 100 + Math.random() * 80,
      y: window.innerHeight / 2 - 80 + Math.random() * 80,
    });
    const graph = graphRef.current;
    applyCommand({
      ...graph,
      nodes: [
        ...graph.nodes.map((node) => ({ ...node, selected: false })),
        {
          id: crypto.randomUUID(),
          type: "media",
          position,
          data: {
            kind,
            label:
              { text: "文本", image: "图片", video: "视频", audio: "音频" }[
                kind
              ] || "素材",
            text,
            ...(url ? { url } : {}),
          },
          selected: true,
        },
      ],
    });
    setMenu(false);
  }
  async function importFile(file: File, nodeId?: string) {
    setBusy(true);
    try {
      if (/\.json$/i.test(file.name) && !nodeId) {
        const graph = parseCanvasGraph(await file.text());
        applyCommand(graph);
        if (graph.viewport) {
          await flow.setViewport(graph.viewport);
          setViewVersion((version) => version + 1);
        }
        await saveRef.current();
        notify("画布已导入并保存");
      } else if (file.type.startsWith("text/") || file.name.endsWith(".txt")) {
        const text = await file.text();
        if (nodeId) update(nodeId, { text });
        else add("text", undefined, text);
      } else {
        const result = await upload(file);
        if (nodeId) update(nodeId, { url: result.url });
        else
          add(
            file.type.startsWith("video/")
              ? "video"
              : file.type.startsWith("audio/")
                ? "audio"
                : "image",
            result.url,
          );
        notify("文件已上传");
      }
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  function generate(nodeId: string, kind: string, text: string) {
    if (versionsOpenRef.current) return;
    setTarget(nodeId);
    setTaskKind(kind);
    setPrompt(text);
    setModal("generate");
  }
  function editMedia(nodeId: string) {
    if (versionsOpenRef.current || busy || modal) return;
    const source = graphRef.current.nodes.find((node) => node.id === nodeId);
    if (
      !source?.data.url ||
      !["image", "video", "audio"].includes(source.data.kind)
    )
      return;
    mediaBaseline.current = null;
    setMediaSource({
      nodeId,
      url: source.data.url,
      kind: source.data.kind as MediaKind,
    });
    setModal("media-tools");
  }
  async function prepareMedia() {
    if (!mediaSource) throw new Error("请选择源媒体节点");
    await saveRef.current();
    if (!lifecycle.current.mounted || !loaded.current)
      throw new Error("当前画布不可用");
    const parameters = canvasMediaTarget(
      graphRef.current,
      mediaSource.nodeId,
      mediaSource.url,
      revisionRef.current,
    );
    mediaBaseline.current = canvasMediaBaseline(
      graphRef.current,
      flow.getViewport(),
      revisionRef.current,
    );
    return parameters;
  }
  async function completedMedia(
    task: Task,
    baseline: CanvasMediaBaseline | null,
    epoch: number,
  ) {
    const current = () =>
      lifecycle.current.mounted && lifecycle.current.epoch === epoch;
    if (!current()) return;
    const application = task.result.application as
      { status?: string; canvas_revision?: number } | undefined;
    const unchanged = () =>
      canApplyCanvasMediaResult(
        baseline,
        graphRef.current,
        flow.getViewport(),
        revisionRef.current,
      );
    if (application?.status !== "applied" || !unchanged()) {
      notify("处理已完成，画布有更新；结果已保留在生成记录");
      return;
    }
    try {
      const graph = await api<VersionGraph>(`/projects/${id}/canvas`);
      if (!current()) return;
      if (!unchanged()) {
        notify("画布出现新编辑，未覆盖当前画布；处理结果已保留在生成记录");
        return;
      }
      applyRestoredVersion(graph);
      notify("处理完成，已创建关联媒体节点");
    } catch (e) {
      if (current())
        notify(
          `处理已完成，刷新画布失败：${(e as Error).message}；结果保留在生成记录`,
          "error",
        );
    }
  }
  function watchMedia(task: Task) {
    if (!lifecycle.current.mounted || mediaTasksWatched.current.has(task.id))
      return;
    mediaTasksWatched.current.add(task.id);
    const epoch = lifecycle.current.epoch;
    const watch = watchCanvasMediaTask(task, mediaBaseline.current, {
      current: () =>
        lifecycle.current.mounted && lifecycle.current.epoch === epoch,
      read: () => api<Task>(`/tasks/${task.id}`),
      complete: (result, baseline) => completedMedia(result, baseline, epoch),
      failed: (result) =>
        notify(result.error || "媒体处理失败，原始素材已保留", "error"),
      unavailable: () =>
        notify(
          "媒体任务状态暂时无法读取，正在后台重试；任务可在生成记录查看",
          "error",
        ),
      stopped: (interval) => taskPolls.current.delete(interval),
    });
    taskPolls.current.add(watch.interval);
  }
  async function submit() {
    setBusy(true);
    try {
      await save();
      const task = await api<Task>("/tasks", {
        method: "POST",
        body: json({
          kind: taskKind,
          project_id: id,
          prompt,
          parameters: { node_id: target },
          idempotency_key: crypto.randomUUID(),
        }),
      });
      setModal("");
      notify("生成任务已提交");
      const interval = setInterval(async () => {
        try {
          const t = await api<Task>(`/tasks/${task.id}`);
          if (!lifecycle.current.mounted) {
            clearInterval(interval);
            taskPolls.current.delete(interval);
            return;
          }
          if (["succeeded", "failed"].includes(t.status)) {
            clearInterval(interval);
            taskPolls.current.delete(interval);
            if (t.status === "succeeded") {
              await save();
              await load();
              notify(
                (t.result.application as any)?.status === "conflict"
                  ? "生成已完成，画布有更新；结果已保留在历史记录"
                  : "任务已完成",
              );
            } else notify(t.error || "任务失败", "error");
          }
        } catch {
          clearInterval(interval);
          taskPolls.current.delete(interval);
        }
      }, 2500);
      taskPolls.current.add(interval);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  function undo() {
    if (versionsOpenRef.current) return;
    const previous = graphHistory.current.undo(graphRef.current);
    if (!previous) return;
    replaceGraph(previous);
    setContextMenu(null);
    setHistoryVersion((v) => v + 1);
  }
  function redo() {
    if (versionsOpenRef.current) return;
    const next = graphHistory.current.redo(graphRef.current);
    if (!next) return;
    replaceGraph(next);
    setContextMenu(null);
    setHistoryVersion((v) => v + 1);
  }
  async function openHistory() {
    try {
      const result = await api<{ items: Task[] }>(`/tasks?project_id=${id}`);
      setHistory(result.items);
      setModal("history");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  function exportGraph() {
    const blob = new Blob(
      [
        serializeCanvasGraph({
          ...graphRef.current,
          viewport: flow.getViewport(),
        }),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `${project?.name || "画布"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  if (loading) return <Loading />;
  if (error)
    return (
      <div className="page">
        <button onClick={() => nav("/work")}>
          <ArrowLeft size={15} />
          返回
        </button>
        <ErrorPanel error={error} onRetry={load} />
      </div>
    );
  return (
    <CanvasContext.Provider
      value={{ update, remove, generate, file: importFileNode, editMedia }}
    >
      <div
        className="canvas-editor"
        ref={editorRef}
        tabIndex={-1}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (versionsOpenRef.current) return;
          if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
        }}
      >
        <header className="canvas-header">
          <div>
            <button
              className="icon-button"
              onClick={async () => {
                try {
                  await save();
                  nav("/work");
                } catch {}
              }}
              aria-label="返回我的作品"
              disabled={versionsOpen}
            >
              <ArrowLeft size={20} />
            </button>
            <span className="divider" />
            <input
              value={project?.name || ""}
              onChange={(e) =>
                setProject((p) => (p ? { ...p, name: e.target.value } : p))
              }
              onBlur={async () => {
                if (project)
                  try {
                    await api(`/projects/${id}`, {
                      method: "PATCH",
                      body: json({ name: project.name }),
                    });
                  } catch (e) {
                    notify((e as Error).message, "error");
                  }
              }}
              aria-label="画布名称"
              disabled={versionsOpen}
            />
            <span className="tag">画布</span>
            <span className="save-status">
              <i className={saveState === "已保存" ? "saved" : ""} />
              {saveState}
            </span>
          </div>
          <div>
            <button
              onClick={openVersions}
              disabled={busy || !!modal || versionsOpen}
            >
              <History size={16} />
              版本历史
            </button>
            <button onClick={openHistory} disabled={versionsOpen}>
              <History size={16} />
              生成记录
            </button>
            <button onClick={exportGraph}>
              <Download size={16} />
              导出画布
            </button>
            <button
              className="primary"
              onClick={() => save().catch(() => {})}
              disabled={versionsOpen}
            >
              <Save size={15} />
              保存
            </button>
          </div>
        </header>
        <div className="canvas-top-left" inert={versionsOpen}>
          <div className="canvas-floating">
            <button
              onClick={undo}
              disabled={!graphHistory.current.canUndo}
              className="icon-button"
              title="撤销"
            >
              <Undo2 size={17} />
            </button>
            <button
              onClick={redo}
              disabled={!graphHistory.current.canRedo}
              className="icon-button"
              title="重做"
            >
              <Redo2 size={17} />
            </button>
            <span className="divider" />
            <button
              className={`icon-button ${!pan ? "active" : ""}`}
              onClick={() => setPan(false)}
              title="选择"
            >
              <MousePointer2 size={17} />
            </button>
            <button
              className={`icon-button ${pan ? "active" : ""}`}
              onClick={() => setPan(true)}
              title="拖动画布"
            >
              <Hand size={17} />
            </button>
          </div>
        </div>
        <div className="canvas-left-tools" inert={versionsOpen}>
          <button
            className="primary icon-button"
            onClick={() => setMenu(!menu)}
            title="添加节点"
            aria-label="添加节点"
            aria-expanded={menu}
            data-canvas-menu-trigger
          >
            <Plus size={23} />
          </button>
          {[
            ["text", Type, "文本"],
            ["image", Image, "图片"],
            ["video", Video, "视频"],
            ["audio", Music, "音频"],
          ].map(([key, Icon, label]) => {
            const I = Icon as typeof Type;
            return (
              <button
                className="icon-button"
                key={String(key)}
                onClick={() => add(String(key))}
                title={String(label)}
              >
                <I size={19} />
              </button>
            );
          })}
          <span className="horizontal-divider" />
          <label className="icon-button upload-button" title="上传素材">
            <Upload size={19} />
            <input
              type="file"
              accept="image/*,video/*,audio/*,.txt,.json"
              onChange={(e) => {
                if (e.target.files?.[0]) importFile(e.target.files[0]);
              }}
            />
          </label>
        </div>
        {menu && (
          <div className="canvas-add-menu">
            <strong>添加节点</strong>
            {[
              ["text", "文本", "记录灵感、剧本和描述"],
              ["image", "图片", "上传图片或 AI 生成"],
              ["video", "视频", "生成动态视频片段"],
              ["audio", "音频", "配音、音乐与音效"],
            ].map(([key, name, desc]) => (
              <button key={key} onClick={() => add(key)}>
                <Plus size={17} />
                <span>
                  {name}
                  <small>{desc}</small>
                </span>
              </button>
            ))}
          </div>
        )}
        <div
          className="canvas-command-toolbar canvas-floating"
          aria-label="画布编辑命令"
          inert={versionsOpen}
        >
          <span>{nodes.filter((node) => node.selected).length} 个选中</span>
          <button onClick={selectAll} title="全选节点 (⌘/Ctrl+A)">
            全选
          </button>
          <button
            onClick={duplicateSelected}
            disabled={!nodes.some((node) => node.selected)}
            title="创建副本 (⌘/Ctrl+D)"
            aria-label="创建节点副本"
          >
            <Copy size={15} />
            副本
          </button>
          <button
            onClick={() => void copySelected()}
            disabled={!nodes.some((node) => node.selected)}
            title="复制到剪贴板 (⌘/Ctrl+C)"
          >
            复制
          </button>
          <button
            onClick={() => void pasteFromClipboard()}
            title="粘贴节点 (⌘/Ctrl+V)"
          >
            粘贴
          </button>
          <button
            onClick={removeSelected}
            disabled={
              !nodes.some((node) => node.selected) &&
              !edges.some((edge) => edge.selected)
            }
            aria-label="删除选中节点或连线"
          >
            <Trash2 size={15} />
          </button>
        </div>
        {contextMenu && (
          <div
            className="canvas-context-menu"
            role="menu"
            aria-label="画布菜单"
            style={{
              left: Math.max(8, contextMenu.x),
              top: Math.max(72, contextMenu.y),
            }}
          >
            <button role="menuitem" onClick={selectAll}>
              全选节点<kbd>⌘/Ctrl A</kbd>
            </button>
            <button
              role="menuitem"
              onClick={duplicateSelected}
              disabled={!nodes.some((node) => node.selected)}
            >
              创建副本<kbd>⌘/Ctrl D</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => void copySelected()}
              disabled={!nodes.some((node) => node.selected)}
            >
              复制节点<kbd>⌘/Ctrl C</kbd>
            </button>
            <button role="menuitem" onClick={() => void pasteFromClipboard()}>
              粘贴节点<kbd>⌘/Ctrl V</kbd>
            </button>
            <button
              role="menuitem"
              onClick={removeSelected}
              disabled={
                !nodes.some((node) => node.selected) &&
                !edges.some((edge) => edge.selected)
              }
            >
              删除选中项<kbd>Delete</kbd>
            </button>
          </div>
        )}
        <ReactFlow
          inert={versionsOpen}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes: NodeChange<FlowNode>[]) => {
            if (versionsOpenRef.current) return;
            const graph = graphRef.current;
            replaceGraph({
              ...graph,
              nodes: applyNodeChanges(changes, graph.nodes),
            });
          }}
          onEdgesChange={(changes: EdgeChange[]) => {
            if (versionsOpenRef.current) return;
            const graph = graphRef.current;
            replaceGraph({
              ...graph,
              edges: applyEdgeChanges(changes, graph.edges),
            });
          }}
          onConnect={(connection: Connection) => {
            const graph = graphRef.current;
            applyCommand({
              ...graph,
              edges: addEdge(
                { ...connection, animated: true, style: { stroke: "#6a7ef4" } },
                graph.edges,
              ),
            });
          }}
          onNodeDragStart={() => {
            if (!versionsOpenRef.current) remember();
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            if (versionsOpenRef.current) return;
            const graph = graphRef.current;
            if (!node.selected)
              replaceGraph({
                nodes: graph.nodes.map((item) => ({
                  ...item,
                  selected: item.id === node.id,
                })),
                edges: graph.edges.map((edge) => ({
                  ...edge,
                  selected: false,
                })),
              });
            setMenu(false);
            setContextMenu({
              x: Math.min(event.clientX, window.innerWidth - 222),
              y: Math.min(event.clientY, window.innerHeight - 260),
            });
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            if (versionsOpenRef.current) return;
            setMenu(false);
            setContextMenu({
              x: Math.min(event.clientX, window.innerWidth - 222),
              y: Math.min(event.clientY, window.innerHeight - 260),
            });
          }}
          onPaneClick={() => {
            setMenu(false);
            setContextMenu(null);
            editorRef.current?.focus();
          }}
          onMoveEnd={() => setViewVersion((v) => v + 1)}
          panOnDrag={pan || spaceHeld ? [0, 1, 2] : [1, 2]}
          selectionOnDrag={!pan && !spaceHeld}
          minZoom={0.15}
          maxZoom={2}
          colorMode="dark"
          deleteKeyCode={null}
          fitView={false}
        >
          <Background gap={24} size={1} color="#34343a" />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            nodeColor="#596ca5"
            maskColor="#0b0b0fd0"
            pannable
            zoomable
          />
        </ReactFlow>
        {!nodes.length && (
          <div className="canvas-welcome" inert={versionsOpen}>
            <div>✦</div>
            <h2>创意，从这里无限延伸</h2>
            <p>添加节点，或将素材拖入画布</p>
            <button onClick={() => add("text")}>
              <Plus size={17} />
              添加第一个节点
            </button>
          </div>
        )}
        <div className="canvas-bottom-hint">
          滚轮缩放 · 空格平移 · 拖拽接口连接 · ⌘/Ctrl+A 全选 · C 复制 · V 粘贴 ·
          D 副本 · Delete 删除
        </div>
        <button
          className="canvas-agent"
          disabled={versionsOpen}
          onClick={() => {
            setModal("agent");
          }}
        >
          <Sparkles size={19} />
          小漫 Agent
        </button>
        {versionsOpen && (
          <CanvasVersions
            key={id}
            projectId={id}
            prepare={prepareVersionAction}
            onRestored={applyRestoredVersion}
            onClose={() => {
              versionsOpenRef.current = false;
              setVersionsOpen(false);
            }}
          />
        )}
        {modal === "media-tools" && mediaSource && (
          <MediaTools
            key={`${id}:${mediaSource.nodeId}:${mediaSource.url}`}
            sourceUrl={mediaSource.url}
            kind={mediaSource.kind}
            projectId={id}
            targetLabel="画布的新节点"
            prepare={prepareMedia}
            onSubmitted={watchMedia}
            onComplete={() => {}}
            onClose={() => {
              setModal("");
              setMediaSource(null);
            }}
          />
        )}
        {busy && (
          <div className="canvas-busy">
            <LoaderCircle className="spin" size={16} />
            正在处理
          </div>
        )}
        {(modal === "copy" || modal === "paste") && (
          <Modal
            title={modal === "copy" ? "复制画布节点" : "粘贴画布节点"}
            onClose={() => setModal("")}
          >
            <div className="form-body">
              <p className="muted">
                {modal === "copy"
                  ? "浏览器未允许直接写入剪贴板。请选择下方 JSON 并按 ⌘/Ctrl+C 复制。"
                  : "浏览器未允许读取剪贴板。请在下方粘贴已复制的画布 JSON；节点和内部连线会作为副本添加。"}
              </p>
              <textarea
                aria-label="画布剪贴板 JSON"
                className="canvas-clipboard-text"
                value={clipboardText}
                readOnly={modal === "copy"}
                onChange={(event) => setClipboardText(event.target.value)}
                rows={9}
                onFocus={(event) => {
                  if (modal === "copy") event.currentTarget.select();
                }}
              />
            </div>
            <footer>
              <button onClick={() => setModal("")}>关闭</button>
              {modal === "paste" && (
                <button
                  className="primary"
                  onClick={() => pasteGraph(clipboardText)}
                  disabled={!clipboardText.trim()}
                >
                  粘贴节点
                </button>
              )}
            </footer>
          </Modal>
        )}
        {modal === "generate" && (
          <Modal title="生成媒体" onClose={() => setModal("")}>
            <div className="form-body">
              <label>
                生成描述
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={5}
                />
              </label>
              {!session?.provider_status?.[taskKind] && (
                <div className="notice">
                  当前生成服务未配置，提交会返回明确不可用状态，不扣费。
                </div>
              )}
            </div>
            <footer>
              <button onClick={() => setModal("")}>取消</button>
              <button
                className="primary"
                onClick={submit}
                disabled={busy || !prompt.trim()}
              >
                <Sparkles size={15} />
                提交生成
              </button>
            </footer>
          </Modal>
        )}
        {modal === "history" && (
          <Modal title="画布生成记录" onClose={() => setModal("")} wide>
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
                    <span className={`status ${t.status}`}>{t.status}</span>
                    <small>{t.error}</small>
                    {canvasTaskMediaURL(t) && (
                      <span className="actions">
                        <a
                          className="button"
                          href={canvasTaskMediaURL(t)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          预览结果
                        </a>
                        <a
                          className="button"
                          href={canvasTaskMediaURL(t)}
                          download
                        >
                          下载结果
                        </a>
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <Empty title="暂无生成记录" />
              )}
            </div>
          </Modal>
        )}
        {modal === "agent" && (
          <Modal title="小漫 Agent" onClose={() => setModal("")}>
            <div className="form-body">
              <div className="contact-art">
                <Sparkles size={36} />
              </div>
              <h3>让灵感，自动生长</h3>
              <p className="muted">
                智能画布助手尚未接入本地环境。你可以使用节点自由编排创意，或配置生成服务后提交媒体任务。
              </p>
              <button
                className="primary"
                onClick={() => {
                  add("text");
                  setModal("");
                }}
              >
                <Plus size={15} />
                添加灵感文本
              </button>
            </div>
          </Modal>
        )}
      </div>
    </CanvasContext.Provider>
  );
  function importFileNode(nodeId: string, file: File) {
    importFile(file, nodeId);
  }
}
