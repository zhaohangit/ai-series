import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  Briefcase,
  FileCheck,
  Heart,
  User,
  Search,
  Plus,
  ArrowRight,
  SlidersHorizontal,
  ChevronDown,
  Upload,
  ShieldCheck,
  FileText,
  Building2,
  CheckCircle2,
  AlertCircle,
  ShoppingBag,
  MessageSquare,
} from "lucide-react";
import { Empty, Modal, useApp } from "./App";
const marketNav = [
  ["script-market", "爆款剧本", BookOpen],
  ["biz-square", "接单广场", Briefcase],
  ["sample-cooperation", "合作试稿", FileCheck],
  ["mine/favorites", "我的", User],
] as const;
export default function Marketplace() {
  const location = useLocation(),
    navigate = useNavigate(),
    { notify } = useApp(),
    [q, setQ] = useState(""),
    [category, setCategory] = useState("全部"),
    [form, setForm] = useState(""),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [contact, setContact] = useState(""),
    [status, setStatus] = useState("全部"),
    [filter, setFilter] = useState("综合排序");
  const path = location.pathname.replace("/marketplace/", ""),
    mine = path.startsWith("mine"),
    biz = path.startsWith("biz-square"),
    trial = path.startsWith("sample-cooperation"),
    identity = path === "identity",
    detail = path.includes("/detail"),
    join = path.endsWith("/join"),
    submit = path.endsWith("/submit");
  const title = identity
    ? "账户设置"
    : join
      ? "制作方入驻"
      : submit
        ? "提交试稿"
        : detail
          ? biz
            ? "商单详情"
            : "剧本详情"
          : mine
            ? "我的"
            : biz
              ? "接单广场"
              : trial
                ? "合作试稿"
                : "爆款剧本";
  const categories = biz
    ? ["全部", "精品漫", "真人剧", "漫剧解说", "视频转绘", "其他"]
    : [
        "全部",
        "现代言情",
        "古代言情",
        "玄幻仙侠",
        "都市",
        "悬疑灵异",
        "科幻奇幻",
        "年代历史",
        "国风武侠",
      ];
  function unavailable() {
    notify("本地环境尚未接入市场发布、交易与试稿服务，信息未提交。", "error");
  }
  return (
    <div className="marketplace-page">
      <header className="market-topbar">
        <button className="text-button" onClick={() => navigate("/home")}>
          <ArrowLeft size={17} />
          返回创作台
        </button>
        <div>
          <span>DramaBuddy</span>
          <strong>生态市场</strong>
        </div>
        <button onClick={() => navigate("/marketplace/identity")}>
          <ShieldCheck size={15} />
          账户设置
        </button>
      </header>
      <nav className="market-navigation">
        {marketNav.map(([key, name, Icon]) => (
          <NavLink
            to={`/marketplace/${key}`}
            key={key}
            className={({ isActive }) =>
              isActive || (key === "mine/favorites" && mine) ? "active" : ""
            }
          >
            <Icon size={17} />
            {name}
          </NavLink>
        ))}
      </nav>
      <div className="market-body">
        {identity ? (
          <>
            <div className="page-title">
              <div>
                <h1>账户设置</h1>
                <p>管理你的创作身份与合作信息</p>
              </div>
            </div>
            <div className="market-account-card">
              <div>
                <ShieldCheck size={28} />
                <section>
                  <h3>身份认证</h3>
                  <p>原站实名认证与签约资料不属于本地账号</p>
                </section>
                <span className="tag">未接入</span>
              </div>
              <div>
                <Building2 size={28} />
                <section>
                  <h3>制作方身份</h3>
                  <p>入驻资料和合作服务需单独接入</p>
                </section>
                <button
                  onClick={() => navigate("/marketplace/biz-square/join")}
                >
                  查看入驻 <ArrowRight size={14} />
                </button>
              </div>
              <div>
                <ShoppingBag size={28} />
                <section>
                  <h3>订单与结算</h3>
                  <p>当前独立环境不提供支付、交易或合同签署</p>
                </section>
                <span className="tag">未接入</span>
              </div>
            </div>
          </>
        ) : join || submit ? (
          <>
            <div className="market-breadcrumb">
              <button
                className="text-button"
                onClick={() => navigate("/marketplace/biz-square")}
              >
                接单广场
              </button>
              <span>›</span>
              {title}
            </div>
            <div className="page-title">
              <div>
                <h1>{title}</h1>
                <p>
                  {join
                    ? "展示制作能力，遇见更多好故事"
                    : "提交创作内容，与好故事同行"}
                </p>
              </div>
            </div>
            <div className="market-form">
              <div className="notice">
                <AlertCircle size={17} />
                本地市场服务尚未接入。以下为表单预览，提交不会发送资料或创建真实申请。
              </div>
              <label>
                {join ? "团队 / 工作室名称" : "试稿名称"}
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="请输入名称"
                  maxLength={100}
                />
              </label>
              <label>
                {join ? "制作能力介绍" : "创作说明"}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={6}
                  placeholder="介绍你的制作风格、经验或创作思路"
                />
              </label>
              <label>
                联系方式
                <input
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="请输入联系方式（仅保留在当前页面）"
                />
              </label>
              <div className="market-form-files">
                <Upload size={23} />
                <span>作品附件</span>
                <button
                  onClick={() =>
                    notify("市场附件提交服务尚未接入。请在素材库管理本地文件。")
                  }
                >
                  选择附件
                </button>
              </div>
              <button className="primary" onClick={unavailable}>
                {join ? "提交入驻申请" : "提交试稿"}
              </button>
            </div>
          </>
        ) : detail ? (
          <>
            <div className="market-breadcrumb">
              <button
                className="text-button"
                onClick={() =>
                  navigate(
                    biz
                      ? "/marketplace/biz-square"
                      : "/marketplace/script-market",
                  )
                }
              >
                {biz ? "接单广场" : "爆款剧本"}
              </button>
              <span>›</span>
              {title}
            </div>
            <Empty
              title={biz ? "商单不存在或尚未同步" : "剧本不存在或尚未同步"}
              description="本地目录尚未接入原站市场数据，不会展示虚构商品或交易信息"
              action={
                <button
                  onClick={() =>
                    navigate(
                      biz
                        ? "/marketplace/biz-square"
                        : "/marketplace/script-market",
                    )
                  }
                >
                  返回列表
                </button>
              }
            />
          </>
        ) : mine ? (
          <>
            <div className="page-title">
              <div>
                <h1>我的市场</h1>
                <p>管理你的收藏、试稿和订单</p>
              </div>
            </div>
            <div className="market-mine-tabs">
              {[
                ["favorites", "我的收藏"],
                ["trials", "我的试稿"],
                ["orders", "我的订单"],
              ].map(([key, label]) => (
                <NavLink
                  key={key}
                  className={({ isActive }) => (isActive ? "active" : "")}
                  to={`/marketplace/mine/${key}`}
                >
                  {label}
                </NavLink>
              ))}
            </div>
            <div className="market-filters">
              <div>
                {(path.includes("trials")
                  ? ["全部", "待提交", "审核中", "已通过", "未通过"]
                  : path.includes("orders")
                    ? ["全部", "待付款", "进行中", "已完成", "已关闭"]
                    : ["全部", "剧本", "小说", "商单"]
                ).map((s) => (
                  <button
                    key={s}
                    className={status === s ? "active" : ""}
                    onClick={() => setStatus(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <label className="search-field">
                <Search size={15} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索名称"
                />
              </label>
            </div>
            <Empty
              title={
                path.includes("trials")
                  ? "暂无试稿记录"
                  : path.includes("orders")
                    ? "暂无订单"
                    : "暂无收藏"
              }
              description="独立环境不关联原站账号与市场记录"
              action={
                <button onClick={() => navigate("/marketplace/script-market")}>
                  逛逛市场 <ArrowRight size={15} />
                </button>
              }
            />
          </>
        ) : (
          <>
            <section
              className={`market-hero ${biz ? "market-hero-biz" : trial ? "market-hero-trial" : ""}`}
            >
              <div>
                <span>DRAMABUDDY MARKETPLACE</span>
                <h1>
                  {biz
                    ? "好创意，遇见好伙伴"
                    : trial
                      ? "让好故事，看见你的才华"
                      : "好故事，从这里开始"}
                </h1>
                <p>
                  {biz
                    ? "汇聚优质创作需求，连接优秀制作团队"
                    : trial
                      ? "每周开放书单，自由提交试稿"
                      : "发现优质剧本，开启你的下一个爆款作品"}
                </p>
              </div>
              <div className="market-hero-mark">
                {biz ? (
                  <Briefcase size={105} />
                ) : trial ? (
                  <FileCheck size={105} />
                ) : (
                  <BookOpen size={105} />
                )}
              </div>
            </section>
            <div className="market-list-header">
              <h2>{title}</h2>
              <div>
                {biz && (
                  <button
                    onClick={() => navigate("/marketplace/biz-square/join")}
                  >
                    <Building2 size={15} />
                    制作方入驻
                  </button>
                )}
                {!trial && (
                  <button
                    className="primary"
                    onClick={() => setForm(biz ? "发布需求" : "剧本定制需求")}
                  >
                    <Plus size={15} />
                    {biz ? "发布需求" : "剧本定制"}
                  </button>
                )}
              </div>
            </div>
            <div className="market-categories">
              <span>分类</span>
              {categories.map((c) => (
                <button
                  key={c}
                  className={category === c ? "active" : ""}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="market-filters">
              <div>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option>综合排序</option>
                  <option>最新发布</option>
                  <option>热度优先</option>
                </select>
                <span className="small muted">本地目录 · 共 0 项</span>
              </div>
              <label className="search-field">
                <Search size={15} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={
                    biz
                      ? "搜索商单"
                      : trial
                        ? "搜索书名 / 作者"
                        : "搜索剧本名称"
                  }
                />
              </label>
            </div>
            <Empty
              title={
                q
                  ? "没有找到相关内容"
                  : biz
                    ? "暂无本地商单"
                    : trial
                      ? "暂无可用试稿书单"
                      : "暂无本地剧本商品"
              }
              description="市场目录尚未接入；原站作品、价格、授权与合作状态不会被模拟"
              action={
                <button onClick={() => navigate("/work")}>
                  <FileText size={15} />
                  前往我的作品
                </button>
              }
            />
            <div className="market-footnote">
              <ShieldCheck size={15} />
              本地独立环境 · 暂不提供市场交易、支付、签约、发布与试稿提交
            </div>
          </>
        )}
      </div>
      {form && (
        <Modal title={form} onClose={() => setForm("")}>
          <div className="form-body">
            <label>
              需求名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="请输入需求名称"
              />
            </label>
            <label>
              需求描述
              <textarea
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述故事类型、集数、风格与预算需求"
              />
            </label>
            <div className="notice">
              发布服务尚未接入；信息不会提交给任何第三方。
            </div>
          </div>
          <footer>
            <button onClick={() => setForm("")}>关闭</button>
            <button className="primary" onClick={unavailable}>
              提交需求
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
