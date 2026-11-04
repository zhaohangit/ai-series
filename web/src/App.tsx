import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import {
  NavLink,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import {
  Home as HomeIcon,
  LayoutGrid,
  Layers,
  ClipboardList,
  BookOpen,
  MessageCircle,
  Megaphone,
  Headphones,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  Plus,
  ArrowUp,
  Upload,
  Search,
  X,
  Check,
  LoaderCircle,
  Trash2,
  Copy,
  MoreHorizontal,
  ArrowLeft,
  Folder,
  FileText,
  Sparkles,
  Film,
  Image,
  Play,
  User,
  Coins,
  ExternalLink,
  Download,
  Settings,
  RefreshCw,
  LogOut,
  ArrowRight,
  Palette,
  SquarePen,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Mail,
  Users,
  Cable,
} from "lucide-react";
import { api, json, upload, freshSession } from "./api";
import { validateName, filterTasks, uploadProblem } from "./domain";
import type {
  Session,
  Project,
  ProjectKind,
  Asset,
  Task,
  Catalog,
} from "./types";
import HomePage from "./HomePage";
import PresetLibrary from "./PresetLibrary";
import Marketplace from "./Marketplace";
import TeamPage from "./TeamPage";
import McpKeys from "./McpKeys";
import ShotEditor from "./ShotEditor";
import VideoPreview from "./VideoPreview";
import ProjectEditor from "./ProjectEditor";
import CanvasEditor from "./CanvasEditor";
export const AppContext = createContext<{
  session: Session | null;
  catalog: Catalog;
  notify: (message: string, type?: string) => void;
  refreshSession: () => void;
}>({
  session: null,
  catalog: {
    styles: [],
    models: [],
    presets: [],
    announcements: [],
    examples: [],
  },
  notify: () => {},
  refreshSession: () => {},
});
export const useApp = () => useContext(AppContext);
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Empty({
  title = "暂无内容",
  description = "你的创意，即将从这里开始",
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-art">
        <img src="/reference/embedded-016f974b60b1.png" alt="" />
      </div>
      <p>{title}</p>
      <small>{description}</small>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={23} /> 正在加载
    </div>
  );
}
export function ErrorPanel({
  error,
  onRetry,
}: {
  error: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-panel">
      <AlertCircle size={19} />
      <span>{error}</span>
      {onRetry && <button onClick={onRetry}>重新加载</button>}
    </div>
  );
}
export function useResource<T>(path: string, initial: T) {
  const [data, setData] = useState<T>(initial),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const requestSequence = useRef(0);
  const refresh = useCallback(() => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    api<T>(path)
      .then((value) => {
        if (sequence === requestSequence.current) setData(value);
      })
      .catch((error) => {
        if (sequence === requestSequence.current) setError(error.message);
      })
      .finally(() => {
        if (sequence === requestSequence.current) setLoading(false);
      });
  }, [path]);
  useEffect(() => {
    refresh();
    return () => {
      requestSequence.current++;
    };
  }, [refresh]);
  return { data, setData, loading, error, refresh };
}
const nav = [
  { to: "/home", label: "首页", icon: HomeIcon },
  { to: "/work", label: "我的作品", icon: LayoutGrid },
  { to: "/material?category=1&active=2", label: "素材库", icon: Layers },
  { to: "/task-center", label: "任务中心", icon: ClipboardList },
];
function App() {
  const [session, setSession] = useState<Session | null>(null),
    [catalog, setCatalog] = useState<Catalog>({
      styles: [],
      models: [],
      presets: [],
      announcements: [],
      examples: [],
    }),
    [collapsed, setCollapsed] = useState(false),
    [toast, setToast] = useState<{ message: string; type: string } | null>(
      null,
    ),
    [account, setAccount] = useState(false),
    [dialog, setDialog] = useState("");
  const location = useLocation();
  const notify = useCallback((message: string, type = "info") => {
    setToast({ message, type });
  }, []);
  const refreshSession = useCallback(() => {
    freshSession<Session>()
      .then(setSession)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshSession();
    Promise.all([
      api<Catalog>("/catalog").catch(() => ({
        styles: [],
        models: [],
        presets: [],
        announcements: [],
        examples: [],
      })),
      fetch("/reference/catalog.json")
        .then((r) => r.json())
        .catch(() => ({})),
    ]).then(([local, reference]) =>
      setCatalog({
        ...local,
        styles: local.styles.length
          ? local.styles
          : (reference.styles || []).map((s: any) => ({
              ...s,
              id: String(s.id),
              url: s.imageUrl,
            })),
        presets: local.presets,
        announcements: local.announcements.length
          ? local.announcements
          : (reference.releases || []).map((r: any) => ({
              id: r.id,
              title: r.versionTitle,
              content: r.updateContent,
              date: r.updateTime,
              reference: true,
            })),
      }),
    );
  }, [refreshSession]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(id);
    }
  }, [toast]);
  useEffect(() => {
    setAccount(false);
  }, [location.pathname]);
  const editor = location.pathname.startsWith("/canvas/");
  return (
    <AppContext.Provider value={{ session, catalog, notify, refreshSession }}>
      <div
        className={`app-shell ${collapsed ? "collapsed" : ""} ${editor ? "editor-shell" : ""}`}
      >
        {!editor && (
          <aside className="sidebar">
            <NavLink to="/home" className="brand" aria-label="DramaBuddy 首页">
              <img
                className={collapsed ? "brand-logo compact" : "brand-logo"}
                src="/reference/a8d5e10d6550-062401ad.nnfqb6.svg"
                alt="DramaBuddy"
              />
              {!collapsed && (
                <strong className="brand-wordmark">DramaBuddy</strong>
              )}
            </NavLink>
            <nav>
              {nav.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  className={({ isActive }) =>
                    `nav-item ${isActive ? "active" : ""}`
                  }
                  title={n.label}
                >
                  <n.icon size={20} />
                  {!collapsed && <span>{n.label}</span>}
                </NavLink>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="secondary-nav">
                <NavLink to="/mcp-guide" className="nav-item" title="MCP">
                  <Cable size={18} aria-hidden="true" />
                  {!collapsed && (
                    <span>
                      MCP <span className="badge-new">NEW</span>
                    </span>
                  )}
                </NavLink>
                <NavLink
                  to="/operation-manual"
                  className="nav-item"
                  title="操作手册"
                >
                  <BookOpen size={18} />
                  {!collapsed && <span>操作手册</span>}
                </NavLink>
                <button
                  className="nav-item"
                  title="问题反馈"
                  onClick={() => setDialog("feedback")}
                >
                  <MessageCircle size={18} />
                  {!collapsed && <span>问题反馈</span>}
                </button>
                <NavLink to="/notify" className="nav-item" title="更新公告">
                  <Megaphone size={18} />
                  {!collapsed && (
                    <span>
                      更新公告 <i className="unread-dot" />
                    </span>
                  )}
                </NavLink>
                <button
                  className="nav-item"
                  title="联系我们"
                  onClick={() => setDialog("contact")}
                >
                  <Headphones size={18} />
                  {!collapsed && <span>联系我们</span>}
                </button>
              </div>
              {!collapsed && (
                <button
                  className="credits-card"
                  onClick={() => setDialog("credits")}
                >
                  <span>
                    <Coins size={16} /> {session?.credits ?? 0}
                  </span>
                  <strong>
                    积分充值 <ArrowRight size={12} />
                  </strong>
                  <small>本地独立环境 · 不提供真实购买</small>
                </button>
              )}
              <button
                className="account-trigger"
                onClick={() => setAccount(!account)}
              >
                <span className="avatar">
                  {session?.user.name?.slice(0, 1) || "L"}
                </span>
                {!collapsed && (
                  <>
                    <span>
                      {session?.user.name || "本地创作者"}
                      <small>{session?.space.name || "个人空间"}</small>
                    </span>
                    <ChevronDown size={14} />
                  </>
                )}
              </button>
              {account && (
                <div className="account-menu">
                  <button onClick={() => setDialog("profile")}>
                    <User size={15} /> 个人资料
                  </button>
                  <button onClick={() => setDialog("spaces")}>
                    <Users size={15} /> 空间管理
                  </button>
                  <NavLink to="/team">
                    <Users size={15} />
                    团队管理
                  </NavLink>
                  <NavLink to="/team-stats">
                    <ClipboardList size={15} />
                    团队数据
                  </NavLink>
                  <button onClick={() => setDialog("credits")}>
                    <Coins size={15} /> 积分明细
                  </button>
                  <div>本地开发账号 · 独立数据</div>
                </div>
              )}
              <div className="sidebar-foot">
                <button
                  className="icon-button"
                  aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
                  onClick={() => setCollapsed(!collapsed)}
                >
                  {collapsed ? (
                    <PanelLeftOpen size={17} />
                  ) : (
                    <PanelLeftClose size={17} />
                  )}
                </button>
                {!collapsed && <small>让每一个好故事都被看见</small>}
              </div>
            </div>
          </aside>
        )}
        <main className="main-content">
          <Routes>
            <Route path="/home" element={<HomePage />} />
            <Route path="/marketplace/*" element={<Marketplace />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="/team-stats" element={<TeamPage stats />} />
            <Route path="/work" element={<WorkPage />} />
            <Route path="/material" element={<MaterialPage />} />
            <Route
              path="/material/roleDetail"
              element={<PresetLibrary kind="character" />}
            />
            <Route path="/task-center" element={<TaskPage />} />
            <Route path="/mcp-guide" element={<GuidePage />} />
            <Route path="/operation-manual" element={<GuidePage manual />} />
            <Route path="/notify" element={<Announcements />} />
            <Route path="/project/:id" element={<ProjectEditor />} />
            <Route path="/series/:id" element={<ProjectEditor />} />
            <Route path="/script/:id" element={<ProjectEditor />} />
            <Route path="/episode/:id" element={<ProjectEditor />} />
            <Route path="/canvas/:id" element={<CanvasEditor />} />
            <Route
              path="/canvas/:projectId/:canvasId"
              element={<CanvasEditor />}
            />
            <Route
              path="/series/:stage/:seriesId"
              element={<ProjectEditor />}
            />
            <Route path="/style/:shotProjectId" element={<ProjectEditor />} />
            <Route path="/acts/:shotProjectId" element={<ProjectEditor />} />
            <Route
              path="/roleAndScene/:shotProjectId"
              element={<ProjectEditor />}
            />
            <Route
              path="/storyboard/:shotProjectId"
              element={<ProjectEditor />}
            />
            <Route
              path="/storyboard-grid/:shotProjectId"
              element={<ProjectEditor />}
            />
            <Route
              path="/video/preview/:shotProjectId"
              element={<VideoPreview />}
            />
            <Route
              path="/edit/:shotProjectId/:sceneId/:shotId"
              element={<ShotEditor />}
            />
            <Route
              path="/canvas"
              element={<Navigate to="/work?tab=canvas" replace />}
            />
            <Route path="/series" element={<Navigate to="/work" replace />} />
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </main>
        {toast && (
          <div className={`toast ${toast.type}`} role="status">
            {toast.type === "error" ? (
              <AlertCircle size={18} />
            ) : (
              <CheckCircle2 size={18} />
            )}
            <span>{toast.message}</span>
            <button className="icon-button" onClick={() => setToast(null)}>
              <X size={15} />
            </button>
          </div>
        )}
        {dialog && <AccountDialog kind={dialog} close={() => setDialog("")} />}
      </div>
    </AppContext.Provider>
  );
}
const kindNames: Record<ProjectKind, string> = {
  series: "剧集",
  episode: "单集",
  script: "剧本",
  canvas: "画布",
};
function WorkPage() {
  const [kind, setKind] = useState<ProjectKind>(
      (new URLSearchParams(location.search).get("tab") as ProjectKind) ||
        "series",
    ),
    [q, setQ] = useState(""),
    [create, setCreate] = useState(false),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Project | null>(null),
    [menu, setMenu] = useState("");
  const { data, loading, error, refresh } = useResource<{
    items: Project[];
    total: number;
  }>(`/projects?kind=${kind}&q=${encodeURIComponent(q)}`, {
    items: [],
    total: 0,
  });
  const { notify } = useApp(),
    navigate = useNavigate();
  async function save() {
    const valid = validateName(name);
    if (valid.error) return notify(valid.error, "error");
    setBusy(true);
    try {
      const p = await api<Project>(
        editing ? `/projects/${editing.id}` : "/projects",
        {
          method: editing ? "PATCH" : "POST",
          body: json({ name: valid.name, kind }),
        },
      );
      setCreate(false);
      setEditing(null);
      refresh();
      if (!editing)
        navigate(p.kind === "canvas" ? `/canvas/${p.id}` : `/project/${p.id}`);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function mutate(p: Project, action: string) {
    setMenu("");
    try {
      if (action === "duplicate") {
        await api(`/projects/${p.id}/duplicate`, { method: "POST" });
        notify("已复制作品");
      } else {
        if (!window.confirm(`确定删除“${p.name}”？删除后无法恢复。`)) return;
        await api(`/projects/${p.id}`, { method: "DELETE" });
        notify("作品已删除");
      }
      refresh();
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  return (
    <div className="page work-page">
      <div className="page-title">
        <div>
          <h1>我的作品</h1>
          <p>每一个灵感，都值得被记录</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setName("");
            setEditing(null);
            setCreate(true);
          }}
        >
          <Plus size={17} />
          新建{kindNames[kind]}
        </button>
      </div>
      <div className="page-toolbar">
        <div className="tabs">
          {Object.entries(kindNames).map(([key, value]) => (
            <button
              key={key}
              className={kind === key ? "active" : ""}
              onClick={() => setKind(key as ProjectKind)}
            >
              {value}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索作品名称"
          />
          {q && (
            <button className="icon-button" onClick={() => setQ("")}>
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      {error ? (
        <ErrorPanel error={error} onRetry={refresh} />
      ) : loading ? (
        <Loading />
      ) : !data.items.length ? (
        <Empty
          title={q ? "没有找到相关作品" : `还没有${kindNames[kind]}作品`}
          description={
            q ? "试试其他关键词" : "从一个灵感开始，创作你的第一个作品"
          }
          action={
            <button
              className="primary"
              onClick={() => {
                setName("");
                setCreate(true);
              }}
            >
              <Plus size={16} />
              新建{kindNames[kind]}
            </button>
          }
        />
      ) : (
        <div className="project-grid">
          {data.items.map((p) => (
            <article className="project-card" key={p.id}>
              <button
                className={`project-cover ${p.kind}`}
                onClick={() =>
                  navigate(
                    p.kind === "canvas"
                      ? `/canvas/${p.id}`
                      : `/project/${p.id}`,
                  )
                }
              >
                {p.kind === "canvas" ? (
                  <LayoutGrid size={42} />
                ) : p.kind === "script" ? (
                  <FileText size={42} />
                ) : (
                  <Film size={42} />
                )}
                <span>{kindNames[p.kind]}</span>
                <span className="open-overlay">
                  继续创作 <ArrowUp size={18} />
                </span>
              </button>
              <div className="project-card-info">
                <button
                  onClick={() =>
                    navigate(
                      p.kind === "canvas"
                        ? `/canvas/${p.id}`
                        : `/project/${p.id}`,
                    )
                  }
                >
                  <strong>{p.name}</strong>
                  <small>
                    {new Date(p.updated_at || p.created_at).toLocaleString(
                      "zh-CN",
                    )}{" "}
                    更新
                  </small>
                </button>
                <div className="menu-wrapper">
                  <button
                    className="icon-button"
                    aria-label={`管理 ${p.name}`}
                    onClick={() => setMenu(menu === p.id ? "" : p.id)}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  {menu === p.id && (
                    <div className="dropdown">
                      <button
                        onClick={() => {
                          setEditing(p);
                          setName(p.name);
                          setCreate(true);
                          setMenu("");
                        }}
                      >
                        <SquarePen size={14} />
                        重命名
                      </button>
                      <button onClick={() => mutate(p, "duplicate")}>
                        <Copy size={14} />
                        复制作品
                      </button>
                      <button
                        className="danger-text"
                        onClick={() => mutate(p, "delete")}
                      >
                        <Trash2 size={14} />
                        删除作品
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {create && (
        <Modal
          title={editing ? "重命名作品" : `新建${kindNames[kind]}`}
          onClose={() => setCreate(false)}
        >
          <div className="form-body">
            <label>
              作品名称
              <input
                autoFocus
                placeholder={`请输入${kindNames[kind]}名称`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
                maxLength={100}
              />
            </label>
          </div>
          <footer>
            <button onClick={() => setCreate(false)}>取消</button>
            <button className="primary" disabled={busy} onClick={save}>
              {busy ? <LoaderCircle className="spin" size={15} /> : null}
              {editing ? "保存" : "立即创建"}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
const materialKinds = [
  ["character", "角色库"],
  ["scene", "场景库"],
  ["prop", "道具库"],
  ["effect", "特效库"],
  ["voice", "音色库"],
];
function MaterialPage() {
  const location = useLocation(),
    navigate = useNavigate();
  const [source, setSource] = useState(
      new URLSearchParams(location.search).get("active") === "1"
        ? "own"
        : "preset",
    ),
    [kind, setKindState] = useState("character"),
    [q, setQ] = useState(""),
    [editing, setEditing] = useState<Asset | null>(null),
    [dialog, setDialog] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [url, setUrl] = useState(""),
    [style, setStyle] = useState(""),
    [busy, setBusy] = useState(false);
  const { notify } = useApp();
  const materialCodes: Record<string, string> = {
    character: "1",
    scene: "2",
    prop: "3",
    effect: "4",
    voice: "6",
  };
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setSource(params.get("active") === "1" ? "own" : "preset");
    setKindState(
      (
        {
          "1": "character",
          "2": "scene",
          "3": "prop",
          "4": "effect",
          "6": "voice",
        } as Record<string, string>
      )[params.get("category") || "1"] || "character",
    );
  }, [location.search]);
  function setKind(next: string) {
    setKindState(next);
    navigate(
      `/material?category=${materialCodes[next] || "1"}&active=${source === "own" ? "1" : "2"}`,
      { replace: true },
    );
  }
  const { data, loading, error, refresh } = useResource<{
    items: Asset[];
    total: number;
  }>(`/assets?kind=${kind}&q=${encodeURIComponent(q)}`, {
    items: [],
    total: 0,
  });
  async function save() {
    const valid = validateName(name);
    if (valid.error) return notify(valid.error, "error");
    setBusy(true);
    try {
      await api(editing ? `/assets/${editing.id}` : "/assets", {
        method: editing ? "PATCH" : "POST",
        body: json({
          name: valid.name,
          kind,
          description,
          url,
          style,
          metadata: editing?.metadata || {},
          ...(editing?.updated_at
            ? { expected_updated_at: editing.updated_at }
            : {}),
        }),
      });
      notify("素材已保存");
      setDialog(false);
      refresh();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function fileChange(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const result = await upload(file);
      setUrl(result.url);
      if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  function open(asset?: Asset) {
    setEditing(asset || null);
    setName(asset?.name || "");
    setDescription(asset?.description || "");
    setUrl(asset?.url || "");
    setStyle(asset?.style || "");
    setDialog(true);
  }
  async function remove(asset: Asset) {
    if (!window.confirm(`确定删除素材“${asset.name}”？`)) return;
    try {
      await api(`/assets/${asset.id}`, { method: "DELETE" });
      refresh();
      notify("素材已删除");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  if (source === "preset")
    return (
      <PresetLibrary
        kind={kind}
        onKind={setKind}
        onOwn={() => navigate("/material?category=1&active=1")}
      />
    );
  return (
    <div className="page material-page">
      <div className="page-title">
        <div>
          <h1>素材库</h1>
          <p>查看和管理你的漫剧素材</p>
        </div>
        {source === "own" && (
          <button className="primary" onClick={() => open()}>
            <Plus size={17} />
            上传素材
          </button>
        )}
      </div>
      <div className="material-source">
        <button
          className={source === "own" ? "active" : ""}
          onClick={() => setSource("own")}
        >
          我的
        </button>
        <button
          className={source === "preset" ? "active" : ""}
          onClick={() => {
            setKind("character");
            navigate("/material?category=1&active=2");
          }}
        >
          预设
        </button>
      </div>
      <div className="page-toolbar">
        <div className="tabs">
          {materialKinds.map(([key, label]) => (
            <button
              key={key}
              className={kind === key ? "active" : ""}
              onClick={() => setKind(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="输入名称进行搜索"
          />
        </label>
      </div>
      {error ? (
        <ErrorPanel error={error} onRetry={refresh} />
      ) : loading ? (
        <Loading />
      ) : !data.items.length ? (
        <Empty
          title="暂无素材"
          description="上传角色、场景或道具，让创作更高效"
          action={
            <button onClick={() => open()} className="primary">
              <Upload size={15} />
              上传素材
            </button>
          }
        />
      ) : (
        <div className="asset-grid">
          {data.items.map((a) => (
            <article className="asset-card" key={a.id}>
              <button className="asset-preview" onClick={() => open(a)}>
                {a.url ? (
                  a.kind === "voice" ? (
                    <audio
                      controls
                      src={a.url}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <img src={a.url} alt={a.name} />
                  )
                ) : (
                  <Image size={40} />
                )}
              </button>
              <div>
                <button className="asset-name" onClick={() => open(a)}>
                  {a.name}
                </button>
                <button
                  className="icon-button"
                  aria-label="删除素材"
                  onClick={() => remove(a)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <small>
                {a.style || materialKinds.find((k) => k[0] === a.kind)?.[1]}
              </small>
            </article>
          ))}
        </div>
      )}
      {dialog && (
        <Modal
          title={editing ? "编辑素材" : "上传素材"}
          onClose={() => setDialog(false)}
        >
          <div className="form-body">
            <label>
              素材名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="请输入名称"
              />
            </label>
            <label>
              素材文件
              <label className="upload-small">
                <Upload size={22} />
                <span>{url ? "重新选择文件" : "选择图片、视频或音频文件"}</span>
                <input
                  type="file"
                  accept="image/*,video/*,audio/*"
                  onChange={(e) => fileChange(e.target.files?.[0])}
                />
              </label>
            </label>
            {url && (
              <div className="uploaded-preview">
                {kind === "voice" ? (
                  <audio controls src={url} />
                ) : (
                  <img src={url} alt="素材预览" />
                )}
              </div>
            )}
            <label>
              风格
              <input
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                placeholder="例如：国风、写实、3D 动画"
              />
            </label>
            <label>
              描述
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述素材的外观、特征与用途"
                rows={3}
              />
            </label>
          </div>
          <footer>
            <button onClick={() => setDialog(false)}>取消</button>
            <button className="primary" disabled={busy} onClick={save}>
              {busy && <LoaderCircle className="spin" size={15} />}保存素材
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
const statusNames: Record<string, string> = {
  all: "全部",
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
};
function TaskPage() {
  const [tab, setTab] = useState("generation"),
    [status, setStatus] = useState("all"),
    [selected, setSelected] = useState<string[]>([]);
  const { data, loading, error, refresh } = useResource<{
      items: Task[];
      total: number;
    }>("/tasks", { items: [], total: 0 }),
    { notify } = useApp();
  useEffect(() => {
    if (data.items.some((t) => ["queued", "running"].includes(t.status))) {
      const id = setInterval(refresh, 3000);
      return () => clearInterval(id);
    }
  }, [data.items, refresh]);
  const tasks = filterTasks(data.items, tab, status);
  async function remove(ids: string[]) {
    try {
      for (const id of ids) await api(`/tasks/${id}`, { method: "DELETE" });
      setSelected([]);
      refresh();
      notify("任务记录已删除");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  return (
    <div className="page task-page">
      <div className="page-title">
        <div>
          <h1>任务中心</h1>
          <p>管理你的创作任务与下载记录</p>
        </div>
        <button onClick={refresh}>
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      <div className="page-toolbar">
        <div className="tabs">
          <button
            className={tab === "generation" ? "active" : ""}
            onClick={() => setTab("generation")}
          >
            合成
          </button>
          <button
            className={tab === "download" ? "active" : ""}
            onClick={() => setTab("download")}
          >
            下载
          </button>
        </div>
        <button disabled={!selected.length} onClick={() => remove(selected)}>
          <Trash2 size={15} />
          批量删除{selected.length ? ` (${selected.length})` : ""}
        </button>
      </div>
      <div className="filter-line">
        {Object.entries(statusNames).map(([key, label]) => (
          <button
            className={status === key ? "active" : ""}
            key={key}
            onClick={() => setStatus(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorPanel error={error} onRetry={refresh} />
      ) : loading ? (
        <Loading />
      ) : !tasks.length ? (
        <Empty
          title="暂无任务"
          description="在作品中生成媒体或导出视频，任务将在这里展示"
        />
      ) : (
        <div className="task-table">
          <div className="task-table-head">
            <span>任务信息</span>
            <span>状态</span>
            <span>创建时间</span>
            <span>操作</span>
          </div>
          {tasks.map((t) => (
            <div className="task-row" key={t.id}>
              <div className="task-main">
                <input
                  type="checkbox"
                  disabled={!["succeeded", "failed"].includes(t.status)}
                  checked={selected.includes(t.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, t.id]
                        : selected.filter((id) => id !== t.id),
                    )
                  }
                />
                <div className="task-icon">
                  <Film size={20} />
                </div>
                <div>
                  <strong>
                    {{
                      text: "文本生成",
                      image: "图片生成",
                      video: "视频生成",
                      audio: "音频生成",
                      export: "视频合成",
                    }[t.kind] || t.kind}
                  </strong>
                  <small>{t.id.slice(0, 8)}</small>
                  {t.error && <p className="danger-text">{t.error}</p>}
                </div>
              </div>
              <div>
                <span className={`status ${t.status}`}>
                  {statusNames[t.status] || t.status}
                </span>
                {["running", "queued"].includes(t.status) && (
                  <div className="progress">
                    <i style={{ width: `${t.progress}%` }} />
                  </div>
                )}
              </div>
              <small>{new Date(t.created_at).toLocaleString("zh-CN")}</small>
              <div>
                {typeof t.result?.url === "string" && (
                  <a className="text-button" href={t.result.url} download>
                    <Download size={15} />
                    下载
                  </a>
                )}
                {["succeeded", "failed"].includes(t.status) && (
                  <button
                    className="icon-button"
                    aria-label="删除任务"
                    onClick={() => remove([t.id])}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function GuidePage({ manual = false }: { manual?: boolean }) {
  const { notify } = useApp();
  return (
    <div className="page guide-page">
      <div className="page-title">
        <div>
          <h1>{manual ? "操作手册" : "MCP"}</h1>
          <p>
            {manual
              ? "从故事到成片，开启你的漫剧创作之旅"
              : "将 DramaBuddy 创作能力连接到你的 AI 工作流"}
          </p>
        </div>
        <span className="tag">本地环境</span>
      </div>
      {manual ? (
        <>
          <div className="guide-banner">
            <Sparkles size={32} />
            <h2>让每一个好故事，都能成为一部好剧</h2>
            <p>按照以下步骤，在独立工作空间中完成创作</p>
          </div>
          <div className="guide-steps">
            {[
              [
                "1",
                "创建作品",
                "在首页上传小说、剧本，或从空白作品开始。作品与所有内容将保存在本地数据库。",
              ],
              [
                "2",
                "编写剧本与分集",
                "设置画面比例与风格，编辑剧本，使用本地规则解析划分段落。",
              ],
              [
                "3",
                "设计分镜与素材",
                "添加角色、场景、道具。为每个分镜填写画面描述、台词和时长。",
              ],
              [
                "4",
                "生成与导出",
                "配置可用模型服务后，提交图片、视频或音频任务。在任务中心查看进度和结果。",
              ],
              [
                "5",
                "自由画布",
                "创建文字、图片、视频和音频节点，自由连接内容。画布会自动保存。",
              ],
            ].map(([n, title, text]) => (
              <div key={n}>
                <span>{n}</span>
                <section>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </section>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="guide-banner">
            <span className="mcp-big">✦</span>
            <h2>DramaBuddy MCP</h2>
            <p>让 AI 助手成为你的创作伙伴</p>
          </div>
          <div className="guide-document">
            <h2>什么是 MCP？</h2>
            <p>
              Model Context Protocol 用于连接 AI 助手与外部工具。参考站点提供
              MCP 创作入口；本地服务提供独立 MCP 接口，可通过访问密钥连接你的 AI
              客户端。
            </p>
            <div className="notice">
              <AlertCircle size={18} />
              本地 MCP 服务仅访问当前账号的内容。原站 OAuth
              与远程账号授权不在本地提供。
            </div>
            <McpKeys />
            <h2>本地可用能力</h2>
            <div className="capability-grid">
              <div>
                <FileText />
                <strong>作品与剧本</strong>
                <p>通过本地 API 管理作品和分集</p>
              </div>
              <div>
                <Image />
                <strong>素材管理</strong>
                <p>上传和管理自己的视觉素材</p>
              </div>
              <div>
                <LayoutGrid />
                <strong>无限画布</strong>
                <p>连接文字、图像、视频与声音</p>
              </div>
            </div>
            <h2>接入状态</h2>
            <p>
              使用上方本地地址与密钥配置支持 HTTP MCP
              的客户端。可读取作品、素材、分镜与任务，并创建本地作品；具体工具以接口返回的
              tools/list 为准。
            </p>
            <button
              onClick={() => {
                navigator.clipboard
                  .writeText(`${location.origin}/api/mcp`)
                  .then(() => notify("已复制本地 MCP 地址"))
                  .catch(() => notify("浏览器未允许复制", "error"));
              }}
            >
              <Copy size={16} />
              复制本地 MCP 地址
            </button>
          </div>
        </>
      )}
    </div>
  );
}
function Announcements() {
  const { catalog } = useApp();
  return (
    <div className="page announcements-page">
      <div className="page-title">
        <div>
          <h1>更新公告</h1>
          <p>每一次更新，让创作更进一步</p>
        </div>
      </div>
      <div className="timeline">
        {catalog.announcements.length ? (
          catalog.announcements.map((a, i) => (
            <article key={String(a.id || i)}>
              <div className="timeline-dot" />
              <span>{a.date || a.created_at || "产品更新"}</span>
              <h2>{a.title}</h2>
              <p className="release-content">{a.content || a.description}</p>
              {(a.reference || a.reference_only) && (
                <small className="muted">
                  参考站版本公告，仅作产品信息展示
                </small>
              )}
            </article>
          ))
        ) : (
          <article>
            <div className="timeline-dot" />
            <span>本地独立版本</span>
            <h2>欢迎来到 DramaBuddy 创作空间</h2>
            <p>
              作品、素材、分镜和画布均保存到本地。生成服务需单独配置；未配置时，提交会显示明确错误且不会扣费。
            </p>
            <ul>
              <li>作品与素材管理</li>
              <li>剧本、分集与分镜编辑</li>
              <li>无限画布与文件上传</li>
              <li>任务状态与积分明细</li>
            </ul>
            <span className="tag">独立实现说明，非原站更新公告</span>
          </article>
        )}
      </div>
    </div>
  );
}
function AccountDialog({ kind, close }: { kind: string; close: () => void }) {
  const { session, notify, refreshSession } = useApp(),
    [name, setName] = useState(session?.user.name || ""),
    [ledger, setLedger] = useState<{ balance: number; items: any[] }>({
      balance: session?.credits || 0,
      items: [],
    }),
    [spaces, setSpaces] = useState<any[]>([]),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind === "credits")
      api("/credits")
        .then(setLedger)
        .catch((e) => notify(e.message, "error"));
    if (kind === "spaces")
      api<{ items: any[] }>("/spaces")
        .then((d) => setSpaces(d.items))
        .catch((e) => notify(e.message, "error"));
  }, [kind, notify]);
  async function save() {
    if (!name.trim()) return notify("请输入昵称", "error");
    setBusy(true);
    try {
      await api("/profile", {
        method: "PATCH",
        body: json({ name: name.trim() }),
      });
      refreshSession();
      notify("个人资料已更新");
      close();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        {
          profile: "个人资料",
          credits: "积分与会员",
          spaces: "空间管理",
          feedback: "问题反馈",
          contact: "联系我们",
        }[kind] || "提示"
      }
      onClose={close}
      wide={kind === "credits"}
    >
      {kind === "profile" ? (
        <>
          <div className="form-body">
            <div className="profile-avatar">{name.slice(0, 1) || "L"}</div>
            <label>
              昵称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
              />
            </label>
            <label>
              账号类型
              <input disabled value="本地独立账号" />
            </label>
            <p className="muted small">本地账号不关联原站身份。</p>
          </div>
          <footer>
            <button onClick={close}>取消</button>
            <button className="primary" onClick={save} disabled={busy}>
              保存
            </button>
          </footer>
        </>
      ) : kind === "credits" ? (
        <div className="form-body">
          <div className="credit-balance">
            <Coins size={27} />
            <strong>{ledger.balance}</strong>
            <span>可用积分</span>
            <span className="tag">本地余额</span>
          </div>
          <div className="notice">
            <AlertCircle size={18} />
            会员购买与积分充值未接入。未配置生成服务时不会扣费。
          </div>
          <h3>积分明细</h3>
          {ledger.items.length ? (
            <div className="ledger">
              {ledger.items.map((i, n) => (
                <div key={i.id || n}>
                  <span>
                    {i.description || i.kind || "积分变更"}
                    <small>
                      {i.created_at &&
                        new Date(i.created_at).toLocaleString("zh-CN")}
                    </small>
                  </span>
                  <strong>
                    {i.amount > 0 ? "+" : ""}
                    {i.amount}
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="暂无积分记录"
              description="实际产生的积分变更会显示在这里"
            />
          )}
        </div>
      ) : kind === "spaces" ? (
        <div className="form-body">
          {spaces.map((s) => (
            <div className="space-card" key={s.id}>
              <Users size={22} />
              <div>
                <strong>{s.name}</strong>
                <small>本地空间</small>
              </div>
              <span className="tag">当前空间</span>
            </div>
          ))}
          <div className="notice">
            团队邀请与空间切换尚未接入；所有本地作品属于当前账号空间。
          </div>
        </div>
      ) : (
        <div className="form-body">
          <div className="contact-art">
            {kind === "feedback" ? (
              <MessageCircle size={36} />
            ) : (
              <Headphones size={36} />
            )}
          </div>
          <h3>
            {kind === "feedback"
              ? "感谢你的反馈"
              : "与创作团队一起，让好故事发生"}
          </h3>
          <p className="muted">
            这是独立本地实现。原站客服、社区二维码与反馈服务不在本地环境中提供。
          </p>
          <p className="small">
            可在项目文档中记录问题与复现步骤，便于进一步完善。
          </p>
          <button className="primary" onClick={close}>
            我知道了
          </button>
        </div>
      )}
    </Modal>
  );
}
export default App;
