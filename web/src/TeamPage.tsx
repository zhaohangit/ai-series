import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Users,
  Coins,
  ChartNoAxesCombined,
  ArrowUpRight,
  Plus,
  Search,
  ShieldCheck,
  Download,
  RefreshCw,
  ArrowLeft,
  UserPlus,
  FileText,
} from "lucide-react";
import { useApp, useResource, Loading, ErrorPanel, Empty, Modal } from "./App";
import type { Task } from "./types";
export default function TeamPage({ stats = false }: { stats?: boolean }) {
  const { session, notify } = useApp(),
    navigate = useNavigate(),
    {
      data: spaces,
      loading,
      error,
      refresh,
    } = useResource<{
      items: Array<{ id: string; name: string; role: string }>;
    }>("/spaces", { items: [] }),
    { data: ledger } = useResource<{
      balance: number;
      items: Array<{
        id: string;
        amount: number;
        action: string;
        description: string;
        created_at: string;
      }>;
    }>("/credits", { balance: 0, items: [] }),
    { data: tasks } = useResource<{ items: Task[] }>("/tasks", { items: [] }),
    [q, setQ] = useState(""),
    [period, setPeriod] = useState("all"),
    [dialog, setDialog] = useState(""),
    [email, setEmail] = useState("");
  const days = period === "week" ? 7 : period === "month" ? 30 : Infinity,
    rows = ledger.items.filter(
      (i) => (Date.now() - new Date(i.created_at).getTime()) / 86400000 <= days,
    ),
    spent = rows
      .filter((i) => i.amount < 0)
      .reduce((sum, i) => sum - i.amount, 0),
    refunded = rows
      .filter((i) => i.action === "refund")
      .reduce((sum, i) => sum + i.amount, 0);
  function exportLedger() {
    const text = [
        "时间,动作,金额,说明",
        ...rows.map((i) =>
          [i.created_at, i.action, i.amount, i.description]
            .map((v) => `"${String(v).replaceAll('"', '""')}"`)
            .join(","),
        ),
      ].join("\n"),
      blob = new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "local-credit-ledger.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="page team-page">
      <div className="page-title">
        <div>
          <h1>{stats ? "团队数据" : "团队管理"}</h1>
          <p>管理你的本地创作空间与用量</p>
        </div>
        <div className="team-header-actions">
          <button onClick={() => navigate(stats ? "/team" : "/team-stats")}>
            {stats ? <Users size={15} /> : <ChartNoAxesCombined size={15} />}{" "}
            {stats ? "团队管理" : "查看数据"}
          </button>
          <button onClick={refresh}>
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
      </div>
      <div className="team-space-banner">
        <div className="team-space-icon">
          <Users size={25} />
        </div>
        <div>
          <h2>{session?.space.name || "个人空间"}</h2>
          <p>本地独立空间 · {session?.user.name || "本地创作者"}</p>
        </div>
        <span className="tag">空间所有者</span>
      </div>
      {stats ? (
        <>
          <div className="team-stats-toolbar">
            <h3>用量概览</h3>
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="all">全部时间</option>
              <option value="week">最近 7 天</option>
              <option value="month">最近 30 天</option>
            </select>
          </div>
          <div className="stats-cards">
            <div>
              <Coins size={22} />
              <span>可用积分</span>
              <strong>{ledger.balance}</strong>
              <small>本地额度</small>
            </div>
            <div>
              <ArrowUpRight size={22} />
              <span>预留支出</span>
              <strong>{spent}</strong>
              <small>账本中的负向金额总和</small>
            </div>
            <div>
              <RefreshCw size={22} />
              <span>退还积分</span>
              <strong>{refunded}</strong>
              <small>失败任务的实际退款</small>
            </div>
            <div>
              <FileText size={22} />
              <span>任务数量</span>
              <strong>
                {
                  tasks.items.filter(
                    (t) =>
                      (Date.now() - new Date(t.created_at).getTime()) /
                        86400000 <=
                      days,
                  ).length
                }
              </strong>
              <small>实际本地任务</small>
            </div>
          </div>
          <div className="team-stats-toolbar">
            <h3>积分明细</h3>
            <button onClick={exportLedger}>
              <Download size={15} />
              导出明细
            </button>
          </div>
          {rows.length ? (
            <div className="team-ledger">
              <div>
                <span>变更时间</span>
                <span>类型</span>
                <span>说明</span>
                <span>金额</span>
              </div>
              {rows.map((i) => (
                <div key={i.id}>
                  <span>{new Date(i.created_at).toLocaleString("zh-CN")}</span>
                  <span>
                    {{
                      reserve: "预留",
                      refund: "退款",
                      settle: "结算",
                      grant: "发放",
                    }[i.action] || i.action}
                  </span>
                  <span>{i.description}</span>
                  <strong className={i.amount < 0 ? "danger-text" : ""}>
                    {i.amount > 0 ? "+" : ""}
                    {i.amount}
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="暂无用量明细"
              description="真实任务产生的积分记录会显示在这里"
            />
          )}
        </>
      ) : (
        <>
          <div className="team-stats-toolbar">
            <h3>空间列表</h3>
            <button onClick={() => setDialog("space")}>
              <Plus size={15} />
              创建空间
            </button>
          </div>
          {error ? (
            <ErrorPanel error={error} onRetry={refresh} />
          ) : loading ? (
            <Loading />
          ) : (
            <div className="team-space-list">
              {spaces.items.map((s) => (
                <div key={s.id}>
                  <Users size={21} />
                  <div>
                    <strong>{s.name}</strong>
                    <small>
                      {s.id === session?.space.id ? "当前空间" : "本地空间"}
                    </small>
                  </div>
                  <span className="tag">
                    {s.role === "owner" ? "所有者" : s.role}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="team-stats-toolbar">
            <h3>成员管理</h3>
            <div>
              <label className="search-field">
                <Search size={15} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索成员"
                />
              </label>
              <button className="primary" onClick={() => setDialog("invite")}>
                <UserPlus size={15} />
                邀请成员
              </button>
            </div>
          </div>
          <div className="team-members">
            <header>
              <span>成员</span>
              <span>角色</span>
              <span>积分额度</span>
              <span>操作</span>
            </header>
            {(!q || (session?.user.name || "").includes(q)) && (
              <div>
                <span>
                  <i className="avatar">
                    {session?.user.name.slice(0, 1) || "L"}
                  </i>
                  {session?.user.name || "本地创作者"}
                  <small>当前账号</small>
                </span>
                <span>
                  <ShieldCheck size={13} />
                  所有者
                </span>
                <span>{ledger.balance}</span>
                <button
                  className="text-button"
                  onClick={() => setDialog("budget")}
                >
                  额度设置
                </button>
              </div>
            )}
          </div>
          <div className="notice">
            当前空间仅包含已验证的本地所有者。团队邀请、成员权限与预算分配服务尚未接入，不会模拟成员加入。
          </div>
        </>
      )}
      {dialog && (
        <Modal
          title={
            dialog === "invite"
              ? "邀请成员"
              : dialog === "space"
                ? "创建空间"
                : "积分额度设置"
          }
          onClose={() => setDialog("")}
        >
          <div className="form-body">
            <label>
              {dialog === "invite"
                ? "成员邮箱"
                : dialog === "space"
                  ? "空间名称"
                  : "额度"}
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={
                  dialog === "invite"
                    ? "请输入成员邮箱"
                    : dialog === "space"
                      ? "请输入空间名称"
                      : "请输入分配额度"
                }
              />
            </label>
            <div className="notice">
              此团队管理服务尚未接入本地后端。提交不会发送邀请、创建空间或更改额度。
            </div>
          </div>
          <footer>
            <button onClick={() => setDialog("")}>取消</button>
            <button
              className="primary"
              onClick={() =>
                notify("团队管理服务尚未接入，操作未执行。", "error")
              }
            >
              确认
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
