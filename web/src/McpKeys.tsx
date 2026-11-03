import { useState } from "react";
import {
  Plus,
  Copy,
  Trash2,
  KeyRound,
  Eye,
  EyeOff,
  LoaderCircle,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { api, json } from "./api";
import { useApp, useResource, ErrorPanel, Loading, Modal, Empty } from "./App";
interface McpKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  secret?: string;
  revoked?: boolean;
}
export default function McpKeys() {
  const { data, loading, error, refresh } = useResource<{
      items: McpKey[];
      total: number;
    }>("/mcp/keys", { items: [], total: 0 }),
    { notify } = useApp(),
    [name, setName] = useState("我的创作助手"),
    [create, setCreate] = useState(false),
    [created, setCreated] = useState<McpKey | null>(null),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false);
  const endpoint = `${window.location.origin}/api/mcp`;
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("已复制");
    } catch {
      notify("复制失败，请手动选择复制", "error");
    }
  }
  async function generate() {
    if (!name.trim()) return notify("请输入密钥名称", "error");
    setBusy(true);
    try {
      const result = await api<McpKey>("/mcp/keys", {
        method: "POST",
        body: json({ name: name.trim() }),
      });
      setCreated(result);
      setCreate(false);
      setVisible(false);
      refresh();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(key: McpKey) {
    if (
      !window.confirm(
        `撤销密钥“${key.name}”？使用它的客户端将失去本地访问权限。`,
      )
    )
      return;
    try {
      await api(`/mcp/keys/${key.id}`, { method: "DELETE" });
      refresh();
      notify("密钥已撤销");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  return (
    <section className="mcp-key-panel">
      <div className="mcp-endpoint">
        <span>本地 MCP 地址</span>
        <code>{endpoint}</code>
        <button
          className="icon-button"
          title="复制地址"
          onClick={() => copy(endpoint)}
        >
          <Copy size={15} />
        </button>
      </div>
      <div className="mcp-key-heading">
        <div>
          <h3>访问密钥</h3>
          <p>密钥仅授予当前本地账号的作品与素材访问权限</p>
        </div>
        <div>
          <button className="icon-button" title="刷新" onClick={refresh}>
            <RefreshCw size={15} />
          </button>
          <button className="primary" onClick={() => setCreate(true)}>
            <Plus size={15} />
            创建密钥
          </button>
        </div>
      </div>
      {error ? (
        <ErrorPanel error={error} onRetry={refresh} />
      ) : loading ? (
        <Loading />
      ) : !data.items.length ? (
        <div className="mcp-no-keys">
          <KeyRound size={25} />
          <span>暂无访问密钥</span>
          <small>创建密钥后，可配置到支持 HTTP MCP 的客户端</small>
        </div>
      ) : (
        <div className="mcp-key-list">
          <header>
            <span>名称</span>
            <span>密钥前缀</span>
            <span>创建时间</span>
            <span>操作</span>
          </header>
          {data.items.map((k) => (
            <div key={k.id}>
              <span>
                <KeyRound size={14} />
                {k.name}
                {k.revoked && <small>已撤销</small>}
              </span>
              <code>{k.prefix}…</code>
              <small>{new Date(k.created_at).toLocaleString("zh-CN")}</small>
              <button
                className="icon-button danger-text"
                disabled={k.revoked}
                title={`撤销 ${k.name}`}
                onClick={() => revoke(k)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="notice">
        <ShieldCheck size={17} />
        本地访问密钥不关联原站
        OAuth。只向你信任的客户端提供；撤销后立即停止访问。
      </div>
      {create && (
        <Modal title="创建 MCP 访问密钥" onClose={() => setCreate(false)}>
          <div className="form-body">
            <label>
              密钥名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="例如：我的 AI 助手"
                autoFocus
              />
            </label>
            <p className="muted small">
              完整密钥只显示一次。请保存到你的客户端配置中。
            </p>
          </div>
          <footer>
            <button onClick={() => setCreate(false)}>取消</button>
            <button className="primary" disabled={busy} onClick={generate}>
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Plus size={15} />
              )}
              创建
            </button>
          </footer>
        </Modal>
      )}
      {created && (
        <Modal title="保存你的访问密钥" onClose={() => setCreated(null)} wide>
          <div className="form-body">
            <div className="notice">
              这是唯一一次显示完整密钥的机会。关闭后将无法再次查看。
            </div>
            <label>
              访问密钥
              <div className="mcp-secret">
                <input
                  readOnly
                  type={visible ? "text" : "password"}
                  value={created.secret || ""}
                />
                <button
                  className="icon-button"
                  title={visible ? "隐藏" : "显示"}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                <button
                  className="icon-button"
                  title="复制密钥"
                  onClick={() => copy(created.secret || "")}
                >
                  <Copy size={16} />
                </button>
              </div>
            </label>
            <h3>HTTP MCP 客户端配置</h3>
            <p className="muted small">服务器 URL：{endpoint}</p>
            <p className="muted small">
              请求头：Authorization: Bearer &lt;你的密钥&gt;
            </p>
            <button
              onClick={() =>
                copy(
                  JSON.stringify(
                    {
                      mcpServers: {
                        dramabuddy: {
                          url: endpoint,
                          headers: {
                            Authorization: `Bearer ${created.secret}`,
                          },
                        },
                      },
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              <Copy size={15} />
              复制客户端配置
            </button>
          </div>
          <footer>
            <button className="primary" onClick={() => setCreated(null)}>
              我已妥善保存
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}
