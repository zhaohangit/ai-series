import {
  useCallback,
  useContext,
  createContext,
  useEffect,
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
} from "lucide-react";
import { api, json, upload } from "./api";
import { canvasSnapshot } from "./domain";
import { useApp, Modal, Loading, ErrorPanel, Empty } from "./App";
import type { Project, Task } from "./types";
type MediaData = {
  label: string;
  text: string;
  url?: string;
  kind: string;
  [key: string]: unknown;
};
type FlowNode = Node<MediaData>;
const CanvasContext = createContext<{
  update: (id: string, patch: Partial<MediaData>) => void;
  remove: (id: string) => void;
  generate: (id: string, kind: string, prompt: string) => void;
  file: (id: string, file: File) => void;
}>({ update: () => {}, remove: () => {}, generate: () => {}, file: () => {} });
function MediaNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { update, remove, generate, file } = useContext(CanvasContext);
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
  return (
    <ReactFlowProvider>
      <CanvasInner />
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
    [history, setHistory] = useState<Task[]>([]);
  const revisionRef = useRef(0),
    loaded = useRef(false),
    lastSaved = useRef(""),
    saving = useRef(false),
    flushPromise = useRef<Promise<void> | null>(null),
    graphRef = useRef({ nodes, edges }),
    [viewVersion, setViewVersion] = useState(0),
    saveRef = useRef<() => Promise<void>>(async () => {}),
    undoRef = useRef<Array<{ nodes: FlowNode[]; edges: Edge[] }>>([]),
    redoRef = useRef<Array<{ nodes: FlowNode[]; edges: Edge[] }>>([]),
    [historyVersion, setHistoryVersion] = useState(0);
  const remember = useCallback(() => {
    undoRef.current.push(structuredClone({ nodes, edges }));
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
    setHistoryVersion((v) => v + 1);
  }, [nodes, edges]);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [p, graph] = await Promise.all([
        api<Project>(`/projects/${id}`),
        api<any>(`/projects/${id}/canvas`),
      ]);
      setProject(p);
      setNodes(graph.nodes || []);
      setEdges(graph.edges || []);
      revisionRef.current = graph.revision || 0;
      setRevision(revisionRef.current);
      lastSaved.current = JSON.stringify({
        nodes: graph.nodes || [],
        edges: graph.edges || [],
        viewport: graph.viewport || { x: 0, y: 0, zoom: 1 },
      });
      loaded.current = true;
      setTimeout(
        () => flow.setViewport(graph.viewport || { x: 0, y: 0, zoom: 1 }),
        50,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  graphRef.current = { nodes, edges };
  async function save() {
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
          revisionRef.current = result.revision ?? revisionRef.current + 1;
          setRevision(revisionRef.current);
          lastSaved.current = value;
        }
        setSaveState("已保存");
      } catch (e) {
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
  function update(nodeId: string, patch: Partial<MediaData>) {
    remember();
    setNodes((n) =>
      n.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...patch } }
          : node,
      ),
    );
  }
  function remove(nodeId: string) {
    remember();
    setNodes((n) => n.filter((node) => node.id !== nodeId));
    setEdges((e) =>
      e.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    );
  }
  function add(kind: string, url?: string, text = "") {
    remember();
    const position = flow.screenToFlowPosition({
      x: window.innerWidth / 2 - 100 + Math.random() * 80,
      y: window.innerHeight / 2 - 80 + Math.random() * 80,
    });
    setNodes((n) => [
      ...n,
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
          url,
        },
        selected: true,
      },
    ]);
    setMenu(false);
  }
  async function importFile(file: File, nodeId?: string) {
    setBusy(true);
    try {
      if (file.name.endsWith(".json") && !nodeId) {
        const graph = JSON.parse(await file.text());
        if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
          throw new Error("画布文件缺少 nodes 或 edges");
        remember();
        setNodes(graph.nodes);
        setEdges(graph.edges);
        if (graph.viewport) flow.setViewport(graph.viewport);
        notify("画布已导入");
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
    setTarget(nodeId);
    setTaskKind(kind);
    setPrompt(text);
    setModal("generate");
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
          if (["succeeded", "failed"].includes(t.status)) {
            clearInterval(interval);
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
        }
      }, 2500);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  function undo() {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(structuredClone({ nodes, edges }));
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setHistoryVersion((v) => v + 1);
  }
  function redo() {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(structuredClone({ nodes, edges }));
    setNodes(next.nodes);
    setEdges(next.edges);
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
        JSON.stringify(
          canvasSnapshot(nodes, edges, flow.getViewport(), revisionRef.current),
          null,
          2,
        ),
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
      value={{ update, remove, generate, file: importFileNode }}
    >
      <div
        className="canvas-editor"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
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
            />
            <span className="tag">画布</span>
            <span className="save-status">
              <i className={saveState === "已保存" ? "saved" : ""} />
              {saveState}
            </span>
          </div>
          <div>
            <button onClick={openHistory}>
              <History size={16} />
              历史记录
            </button>
            <button onClick={exportGraph}>
              <Download size={16} />
              导出画布
            </button>
            <button className="primary" onClick={() => save().catch(() => {})}>
              <Save size={15} />
              保存
            </button>
          </div>
        </header>
        <div className="canvas-top-left">
          <div className="canvas-floating">
            <button
              onClick={undo}
              disabled={!undoRef.current.length}
              className="icon-button"
              title="撤销"
            >
              <Undo2 size={17} />
            </button>
            <button
              onClick={redo}
              disabled={!redoRef.current.length}
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
        <div className="canvas-left-tools">
          <button
            className="primary icon-button"
            onClick={() => setMenu(!menu)}
            title="添加节点"
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
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes: NodeChange<FlowNode>[]) =>
            setNodes((n) => applyNodeChanges(changes, n))
          }
          onEdgesChange={(changes: EdgeChange[]) =>
            setEdges((e) => applyEdgeChanges(changes, e))
          }
          onConnect={(connection: Connection) => {
            remember();
            setEdges((e) =>
              addEdge(
                { ...connection, animated: true, style: { stroke: "#6a7ef4" } },
                e,
              ),
            );
          }}
          onNodeDragStart={() => remember()}
          onMoveEnd={() => setViewVersion((v) => v + 1)}
          panOnDrag={pan ? [0, 1, 2] : [1, 2]}
          selectionOnDrag={!pan}
          minZoom={0.15}
          maxZoom={2}
          colorMode="dark"
          deleteKeyCode={["Backspace", "Delete"]}
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
          <div className="canvas-welcome">
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
          滚轮缩放 · 空格 + 拖动平移 · 拖拽节点接口连接 · Delete 删除选中节点
        </div>
        <button
          className="canvas-agent"
          onClick={() => {
            setModal("agent");
          }}
        >
          <Sparkles size={19} />
          小漫 Agent
        </button>
        {busy && (
          <div className="canvas-busy">
            <LoaderCircle className="spin" size={16} />
            正在处理
          </div>
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
