import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUp,
  Plus,
  Upload,
  FileText,
  Film,
  LayoutGrid,
  Sparkles,
  ArrowRight,
  BookOpen,
  Image,
  Video,
  Music,
  Check,
  LoaderCircle,
  ChevronRight,
  ChevronLeft,
  Maximize2,
  Play,
} from "lucide-react";
import { Modal, useApp } from "./App";
import { api, json, upload } from "./api";
import { uploadProblem, validateName } from "./domain";
import type { Project } from "./types";
const genres = [
  {
    id: "anime",
    name: "精品漫",
    cover: "/reference/01b70d1cc0ac-585c69eb.409i5j.webp",
    iconUrl: "/reference/c3086dce0391-c2548724.lg71z5.svg",
    icon: Image,
  },
  {
    id: "live",
    name: "真人剧",
    cover: "/reference/9b5b74b5ca07-dacd2e09.qvxu22.webp",
    iconUrl: "/reference/285fee673179-403a5b6f.re0vg7.svg",
    icon: Video,
  },
  {
    id: "narration",
    name: "漫剧解说",
    cover: "/reference/c18fa7aa967a-6e33234b.ga61rr.webp",
    iconUrl: "/reference/00691342b852-6f9e1e78.y6cv4t.svg",
    icon: Music,
  },
  {
    id: "redraw",
    name: "转绘出海",
    cover: "/reference/1e3a9cad3eec-8e468970.l40z6s.webp",
    iconUrl: "/reference/89c0495a99a5-6865106a.rg9elv.svg",
    icon: Film,
  },
];
export default function HomePage() {
  const [mode, setMode] = useState("series"),
    [genre, setGenre] = useState("anime"),
    [dialog, setDialog] = useState(""),
    [creation, setCreation] = useState("novel"),
    [prompt, setPrompt] = useState(""),
    [name, setName] = useState(""),
    [script, setScript] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [examples, setExamples] = useState("素材案例"),
    [runtime, setRuntime] = useState<{
      banners: Array<{ tag: string; local_url: string }>;
      examples: Array<{ title: string; duration: string; local_url: string }>;
    }>({ banners: [], examples: [] }),
    [bannerIndex, setBannerIndex] = useState(0),
    [carouselPaused, setCarouselPaused] = useState(false),
    [selectedExample, setSelectedExample] = useState<{
      title: string;
      duration: string;
      local_url: string;
    } | null>(null),
    [selectedBanner, setSelectedBanner] = useState<{
      tag: string;
      local_url: string;
    } | null>(null);
  useEffect(() => {
    fetch("/reference/home-runtime.json")
      .then((r) => (r.ok ? r.json() : { banners: [], examples: [] }))
      .then(setRuntime)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (carouselPaused || runtime.banners.length < 2) return;
    const timer = setInterval(
      () => setBannerIndex((i) => (i + 1) % runtime.banners.length),
      6000,
    );
    return () => clearInterval(timer);
  }, [runtime.banners.length, carouselPaused]);
  const { notify, catalog } = useApp(),
    navigate = useNavigate();
  const banner = runtime.banners[bannerIndex];
  const displayedExamples =
    examples === "素材案例"
      ? runtime.examples
      : catalog.examples.map((e) => ({
          title: e.name || e.title,
          duration: e.duration || "",
          local_url: e.cover || e.url,
        }));

  function choose(file?: File) {
    if (!file) return;
    const error = uploadProblem(file, "script");
    if (error) return notify(error, "error");
    setFile(file);
    if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
  }
  async function createCanvas() {
    setBusy(true);
    try {
      const p = await api<Project>("/projects", {
        method: "POST",
        body: json({
          name: prompt.slice(0, 30) || "未命名画布",
          kind: "canvas",
          description: prompt,
        }),
      });
      navigate(`/canvas/${p.id}`);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    const valid = validateName(name);
    if (valid.error) return notify(valid.error, "error");
    setBusy(true);
    try {
      let text = script;
      let uploaded;
      if (file) {
        uploaded = await upload(file);
        if (file.name.endsWith(".txt")) text = await file.text();
      }
      const p = await api<Project>("/projects", {
        method: "POST",
        body: json({
          name: valid.name,
          kind: mode === "script" ? "script" : "series",
          genre,
          script: text,
          aspect_ratio: "16:9",
          settings: { creation_mode: creation, source_file: uploaded },
        }),
      });
      navigate(
        creation === "storyboard" ? `/style/${p.id}` : `/project/${p.id}`,
      );
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`home-page mode-${mode}`}>
      <section className="hero">
        <h1>
          一键生成，
          <span>
            <i>剧</i>现精彩
          </span>
        </h1>
        <div className="creation-switch">
          {[
            ["script", "剧本"],
            ["series", "剧集"],
            ["canvas", "画布"],
          ].map(([key, title]) => (
            <button
              className={mode === key ? "selected" : ""}
              key={key}
              onClick={() => setMode(key)}
            >
              {title}
            </button>
          ))}
        </div>
        {mode === "series" ? (
          <div className="home-genre-grid">
            {genres.map((g) => (
              <button
                key={g.id}
                className="home-genre"
                style={
                  { "--genre-cover": `url(${g.cover})` } as React.CSSProperties
                }
                onClick={() => {
                  setGenre(g.id);
                  setDialog("method");
                }}
              >
                <strong>{g.name}</strong>
                <img className="genre-card-icon" src={g.iconUrl} alt="" />
                <span>
                  创建剧集 <ArrowRight size={14} />
                </span>
              </button>
            ))}
          </div>
        ) : mode === "script" ? (
          <div className="home-script-upload">
            <label
              className="upload-area"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                choose(e.dataTransfer.files[0]);
              }}
            >
              <input
                type="file"
                accept=".txt,.doc,.docx,.pdf"
                onChange={(e) => choose(e.target.files?.[0])}
              />
              <div className="upload-symbol">
                <Upload size={24} />
              </div>
              <strong>{file ? file.name : "上传小说，一键改编剧本"}</strong>
              <span>
                支持拖拽文件到此处，或 <b>点击上传</b>
              </span>
              <small>
                支持 .txt、.doc、.docx、.pdf 格式，文件大小不超过 50 MB
              </small>
            </label>
            <button
              className="primary"
              onClick={() => {
                setCreation("novel");
                setDialog("create");
              }}
            >
              <Sparkles size={15} />
              开始创作
            </button>
          </div>
        ) : (
          <div className="home-canvas-row">
            <button className="new-canvas" onClick={createCanvas}>
              <span>
                <Plus size={24} />
              </span>
              新建画布
            </button>
            <div className="creation-box canvas-creation">
              <textarea
                placeholder="描述你的想法或上传参考，小漫 Agent 帮你一起创作"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="creation-box-footer">
                <div>
                  <button
                    className="text-button"
                    onClick={() => setDialog("skills")}
                  >
                    <Sparkles size={13} />
                    技能
                  </button>
                  <label className="icon-button" title="添加参考素材">
                    <Plus size={16} />
                    <input
                      type="file"
                      accept="image/*,video/*,audio/*"
                      onChange={(e) => {
                        if (e.target.files?.[0])
                          notify("请先新建画布，再上传素材到节点");
                      }}
                    />
                  </label>
                </div>
                <button
                  className="round-primary"
                  onClick={createCanvas}
                  disabled={busy}
                  aria-label="开始创作画布"
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ArrowUp size={18} />
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="feature-chips">
          {[
            [
              "Seedance 2.5 超长视频",
              "/reference/a123e3e02bcf-f0440578.jfziz8.webp",
            ],
            ["Seed Audio 1.0", "/reference/5321bf516ea2-c231d282.tck9b0.webp"],
            ["宫格图节点", "/reference/9ce34ee95c4c-2fc3cd41.bbgqdh.webp"],
            ["智能导演", "/reference/5dab6f9f7a35-aa7df2bc.n7r6aa.webp"],
          ].map(([label, src], i) => (
            <button key={label} onClick={() => setDialog(`feature:${label}`)}>
              {src ? (
                <img src={src} alt="" />
              ) : (
                <span className={`chip-placeholder chip-${i}`}>
                  {i === 1 ? <Music size={16} /> : <LayoutGrid size={17} />}
                </span>
              )}
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="home-promo">
        <div
          className="promo-carousel"
          onMouseEnter={() => setCarouselPaused(true)}
          onMouseLeave={() => setCarouselPaused(false)}
        >
          <button
            className="promo-banner"
            aria-label={`查看活动 ${bannerIndex + 1}`}
            onClick={() => banner && setSelectedBanner(banner)}
            style={{
              backgroundImage: `url('${banner?.local_url || "/reference/a123e3e02bcf-f0440578.jfziz8.webp"}')`,
            }}
          >
            <span className="new-model">{banner?.tag || "新模型"}</span>
          </button>
          {runtime.banners.length > 1 && (
            <>
              <button
                className="carousel-arrow previous"
                aria-label="上一张活动"
                onClick={() =>
                  setBannerIndex(
                    (i) =>
                      (i - 1 + runtime.banners.length) % runtime.banners.length,
                  )
                }
              >
                <ChevronLeft size={18} />
              </button>
              <button
                className="carousel-arrow next"
                aria-label="下一张活动"
                onClick={() =>
                  setBannerIndex((i) => (i + 1) % runtime.banners.length)
                }
              >
                <ChevronRight size={18} />
              </button>
              <div className="carousel-dots">
                {runtime.banners.map((_, i) => (
                  <button
                    aria-label={`切换到第 ${i + 1} 张活动`}
                    aria-current={bannerIndex === i}
                    className={bannerIndex === i ? "active" : ""}
                    key={i}
                    onClick={() => setBannerIndex(i)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        {[
          [
            "爆款剧本",
            "购买热门剧本，发起定制需求",
            "挑剧本",
            "/marketplace/script-market",
          ],
          ["接单广场", "汇聚优质、真实承制商单", "", "/marketplace/biz-square"],
          [
            "合作试稿",
            "每周开放书单，自由提交试稿",
            "",
            "/marketplace/sample-cooperation",
          ],
        ].map(([title, sub, action, path], i) => (
          <button
            className={`promo-market market-${i}`}
            style={{
              backgroundImage: `url(${["/reference/27d5913cbae2-08b16bac.69o0or.webp", "/reference/ef4db3f8fde6-ed3af324.9pod8z.webp", "/reference/42d59e8fd485-ff2e3ec3.ehsro9.webp"][i]})`,
            }}
            key={title}
            onClick={() => {
              navigate(path);
            }}
          >
            <small>▣ 生态市场</small>
            <span className="market-illustration">
              {i === 0 ? (
                <FileText size={70} />
              ) : i === 1 ? (
                <BookOpen size={70} />
              ) : (
                <Image size={70} />
              )}
            </span>
            <strong>{title}</strong>
            <p>{sub}</p>
            {action && <span className="market-action">{action}</span>}
          </button>
        ))}
      </section>
      <section className="home-examples">
        <div className="example-switch">
          {["素材案例", "爆款作品"].map((t) => (
            <button
              className={examples === t ? "active" : ""}
              onClick={() => setExamples(t)}
              key={t}
            >
              {t}
            </button>
          ))}
        </div>
        {displayedExamples.length ? (
          <div className="example-grid reference-gallery">
            {displayedExamples.map((e, i) => (
              <button
                className="example-card reference-example"
                key={`${e.title}-${i}`}
                onClick={() => setSelectedExample(e)}
                aria-label={`查看示例：${e.title}`}
              >
                <img src={e.local_url} alt={e.title} loading="lazy" />
                <span className="poster-view">
                  <Maximize2 size={21} />
                </span>
                <div className="example-caption">
                  <strong>{e.title}</strong>
                  <small>{e.duration}</small>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="local-examples">
            <Sparkles size={22} />
            <div>
              <strong>
                {examples === "爆款作品"
                  ? "爆款作品列表尚未同步"
                  : "参考案例正在加载"}
              </strong>
              <p>
                {examples === "爆款作品"
                  ? "当前仅保存已采集的素材案例图片，未获取此分类的视频与排行数据。"
                  : "案例仅展示参考海报，视频源未在本地提供。"}
              </p>
            </div>
            <button onClick={() => navigate("/work")}>
              去创作 <ArrowRight size={14} />
            </button>
          </div>
        )}
        {displayedExamples.length > 0 && (
          <p className="example-provenance">
            参考站作品海报 · 视频源未在本地提供
          </p>
        )}
      </section>
      {selectedExample && (
        <Modal
          title={selectedExample.title}
          onClose={() => setSelectedExample(null)}
          wide
        >
          <div className="reference-example-modal">
            <img src={selectedExample.local_url} alt={selectedExample.title} />
            <div>
              <span>参考作品 · {selectedExample.duration}</span>
              <p>当前展示已采集的作品海报；视频文件未在本地提供，无法播放。</p>
            </div>
          </div>
        </Modal>
      )}
      {selectedBanner && (
        <Modal
          title={selectedBanner.tag}
          onClose={() => setSelectedBanner(null)}
          wide
        >
          <div className="reference-banner-modal">
            <img src={selectedBanner.local_url} alt={selectedBanner.tag} />
            <p>参考站活动图片。活动报名、购买与专用生成服务未在本地接入。</p>
          </div>
        </Modal>
      )}
      {dialog === "method" && (
        <Modal
          title={genres.find((g) => g.id === genre)?.name || "创建剧集"}
          onClose={() => setDialog("")}
          wide
        >
          <div className="creation-methods">
            <h3>请选择创作方式</h3>
            <div>
              {[
                [
                  "novel",
                  "从小说开始",
                  "从书单选择或上传小说改编漫剧",
                  BookOpen,
                ],
                ["script", "从剧本开始", "上传已有剧本创作漫剧", FileText],
                ["storyboard", "从分镜开始", "直接从分镜开始创作漫剧", Film],
              ].map(([key, title, desc, Icon]) => {
                const I = Icon as typeof BookOpen;
                return (
                  <button
                    key={String(key)}
                    onClick={() => {
                      setCreation(String(key));
                      setDialog("create");
                    }}
                  >
                    <I size={29} />
                    <strong>{String(title)}</strong>
                    <p>{String(desc)}</p>
                    <ArrowRight size={17} />
                  </button>
                );
              })}
            </div>
          </div>
        </Modal>
      )}
      {dialog === "create" && (
        <Modal
          title={
            creation === "storyboard"
              ? "从分镜开始"
              : mode === "script"
                ? "创建剧本"
                : "创建剧集"
          }
          onClose={() => setDialog("")}
        >
          <div className="form-body">
            <label>
              项目类型
              <input
                value={
                  mode === "script"
                    ? "剧本"
                    : genres.find((g) => g.id === genre)?.name || "漫剧"
                }
                disabled
              />
            </label>
            <label>
              项目名称
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="请输入项目名称"
                maxLength={100}
              />
            </label>
            {creation !== "storyboard" && (
              <>
                <label>
                  上传{creation === "novel" ? "小说" : "剧本"}
                  <label className="upload-small">
                    <Upload size={23} />
                    <span>{file ? file.name : "点击选择文件"}</span>
                    <input
                      type="file"
                      accept=".txt,.doc,.docx,.pdf"
                      onChange={(e) => choose(e.target.files?.[0])}
                    />
                  </label>
                </label>
                <label>
                  或直接输入内容
                  <textarea
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    rows={4}
                    placeholder="输入故事灵感或剧本内容"
                  />
                </label>
                <p className="muted small">
                  文本内容会保存至作品；AI 改编需要单独配置生成服务。
                </p>
              </>
            )}
          </div>
          <footer>
            <button
              onClick={() =>
                setDialog(creation === "storyboard" ? "method" : "")
              }
            >
              取消
            </button>
            <button className="primary" disabled={busy} onClick={create}>
              {busy && <LoaderCircle className="spin" size={15} />}创建
            </button>
          </footer>
        </Modal>
      )}
      {dialog && !["method", "create"].includes(dialog) && (
        <Modal
          title={
            dialog.startsWith("feature:")
              ? dialog.slice(8)
              : dialog.startsWith("example:")
                ? dialog.slice(8)
                : "画布技能"
          }
          onClose={() => setDialog("")}
        >
          <div className="form-body">
            <div className="contact-art">
              <Sparkles size={36} />
            </div>
            <h3>{dialog === "skills" ? "探索更多创作可能" : "创作能力"}</h3>
            <p className="muted">
              此原站入口的专用服务尚未在本地实现。你可以创建画布或项目，编辑内容，并在配置生成服务后提交任务。
            </p>
            <button
              className="primary"
              onClick={() => {
                setDialog("");
                createCanvas();
              }}
            >
              <Plus size={15} />
              创建画布
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
