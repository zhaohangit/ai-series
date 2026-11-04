import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Search, Download, Plus, LoaderCircle } from "lucide-react";
import { useApp, useResource, Loading, ErrorPanel, Modal } from "./App";
import { api, json, upload } from "./api";
import "./preset-library.css";

type Preset = {
  id: string;
  name: string;
  kind: string;
  description: string;
  url: string;
  metadata: Record<string, unknown>;
};
type Collection = {
  id: string;
  name: string;
  kind: string;
  url: string;
  material_count: number;
  items: Preset[];
};
const kinds = [
  ["character", "角色库"],
  ["scene", "场景库"],
  ["prop", "道具库"],
  ["effect", "特效库"],
];

export default function PresetLibrary({
  kind = "character",
  onKind,
  onOwn,
}: {
  kind?: string;
  onKind?: (kind: string) => void;
  onOwn?: () => void;
}) {
  const nav = useNavigate(),
    [search] = useSearchParams(),
    { notify } = useApp();
  const { data, loading, error, refresh } = useResource<{
    collections: Collection[];
  }>("/material-presets", { collections: [] });
  const [q, setQ] = useState(""),
    [selected, setSelected] = useState<Preset | null>(null),
    [busy, setBusy] = useState(false);
  const collection = search.get("id")
    ? data.collections.find((c) => c.id === search.get("id"))
    : undefined;
  const collections = data.collections.filter(
    (c) => c.kind === kind && c.name.includes(q),
  );
  const items =
    collection?.items.filter((i) => `${i.name} ${i.description}`.includes(q)) ||
    [];
  async function importItem(item: Preset) {
    setBusy(true);
    try {
      if (!item.url?.startsWith("/reference/preset-"))
        throw new Error("该角色图片尚未缓存，无法导入");
      const response = await fetch(item.url);
      if (!response.ok) throw new Error("预设图片读取失败");
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("预设不是有效图片");
      const image = await upload(
        new File(
          [blob],
          `${item.name}.${blob.type === "image/png" ? "png" : "jpg"}`,
          { type: blob.type },
        ),
      );
      await api("/assets", {
        method: "POST",
        body: json({
          name: item.name,
          kind: "character",
          description: item.description,
          url: image.url,
          style: collection?.name || "",
          metadata: {
            role: item.metadata.identity || "",
            age: item.metadata.age_group || "",
            appearance: item.description,
            in_library: true,
            reference_collection_id: collection?.id,
            reference_preset_id: item.id,
          },
        }),
      });
      notify("角色已导入我的素材");
      setSelected(null);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page preset-library">
      {collection ? (
        <header className="preset-detail-head">
          <button onClick={() => nav("/material?category=1&active=2")}>
            <ArrowLeft size={17} />
            返回
          </button>
          <h1>{collection.name}</h1>
        </header>
      ) : (
        <>
          <div className="page-title">
            <div>
              <h1>素材库</h1>
              <p>查看和管理你的漫剧素材</p>
            </div>
          </div>
          <div className="material-source">
            <button
              onClick={() =>
                onOwn ? onOwn() : nav("/material?category=1&active=1")
              }
            >
              我的
            </button>
            <button className="active">预设</button>
          </div>
          <div className="preset-kinds">
            {kinds.map(([id, label]) => (
              <button
                className={id === kind ? "active" : ""}
                key={id}
                onClick={() => {
                  setQ("");
                  onKind?.(id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="preset-tools">
        <span>共{collection ? items.length : collections.length}项</span>
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索预设"
            placeholder="输入名称进行搜索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </div>
      {error ? (
        <ErrorPanel error={error} onRetry={refresh} />
      ) : loading ? (
        <Loading />
      ) : search.get("id") && !collection ? (
        <ErrorPanel error="该预设库不存在" />
      ) : collection ? (
        <div className="preset-characters">
          {items.map((item) => (
            <button
              className="preset-character"
              key={item.id}
              aria-label={`查看角色 ${item.name}`}
              onClick={() => setSelected(item)}
            >
              <div>
                {item.url && (
                  <img src={item.url} alt={item.name} loading="lazy" />
                )}
              </div>
              <strong>{item.name}</strong>
              <p>{item.description}</p>
            </button>
          ))}
        </div>
      ) : collections.length ? (
        <div className="preset-collections">
          {collections.map((c) => (
            <button
              className="preset-collection"
              key={c.id}
              aria-label={`${c.name} ${c.material_count}个角色`}
              onClick={() => nav(`/material/roleDetail?id=${c.id}&type=system`)}
            >
              <div>
                {c.url && <img src={c.url} alt={c.name} loading="lazy" />}
              </div>
              <strong>{c.name}</strong>
              <span>{c.material_count}个角色</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="preset-missing">
          {kind === "character"
            ? "没有找到相关预设"
            : "此类预设尚未采集，本地暂不提供。"}
        </p>
      )}
      <footer className="preset-footer">以上内容由人工智能生成合成</footer>
      {selected && (
        <Modal
          title={selected.name}
          onClose={() => {
            if (!busy) setSelected(null);
          }}
          wide
        >
          <div className="preset-character-detail">
            <img src={selected.url} alt={selected.name} />
            <div>
              <p>{selected.description}</p>
              <p className="muted">角色库：{collection?.name}</p>
              <p className="muted">导入后可在本地修改角色信息和设定图。</p>
            </div>
          </div>
          <footer>
            <a className="button" href={selected.url} download>
              <Download size={16} />
              下载主视觉
            </a>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void importItem(selected)}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Plus size={16} />
              )}
              导入我的素材
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
