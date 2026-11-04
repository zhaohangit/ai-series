import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Search } from "lucide-react";
import { useResource, Loading, ErrorPanel } from "./App";
import PresetDetail from "./PresetDetail";
import "./preset-library.css";
import {
  cachedPresetURL,
  findPresetCollection,
  presetCategories,
  presetDetailPath,
  presetKindAtDetail,
  presetListPath,
  type Preset,
  type PresetCollection,
} from "./preset-domain";
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
    [search] = useSearchParams();
  const { data, loading, error, refresh } = useResource<{
    collections: PresetCollection[];
  }>("/material-presets", { collections: [] });
  const [q, setQ] = useState(""),
    [selected, setSelected] = useState<Preset | null>(null);
  const activeKind = presetKindAtDetail(kind, search.get("category"));
  const noun = presetCategories[activeKind]?.noun || "素材";
  const collectionId = search.get("id");
  useEffect(() => {
    setQ("");
    setSelected(null);
  }, [activeKind, collectionId]);
  const collection = collectionId
    ? findPresetCollection(data.collections, collectionId, activeKind)
    : undefined;
  const collections = data.collections.filter(
    (c) => c.kind === activeKind && c.name.includes(q),
  );
  const items =
    collection?.items.filter((i) => `${i.name} ${i.description}`.includes(q)) ||
    [];
  return (
    <div className="page preset-library">
      {collection ? (
        <header className="preset-detail-head">
          <button onClick={() => nav(presetListPath(activeKind))}>
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
                onOwn ? onOwn() : nav(presetListPath(activeKind, "own"))
              }
            >
              我的
            </button>
            <button className="active">预设</button>
          </div>
          <div className="preset-kinds">
            {kinds.map(([id, label]) => (
              <button
                className={id === activeKind ? "active" : ""}
                key={id}
                onClick={() => {
                  setQ("");
                  if (onKind) onKind(id);
                  else nav(presetListPath(id));
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
              key={`${item.kind}:${item.id}`}
              aria-label={`查看${noun} ${item.name}`}
              onClick={() => setSelected(item)}
            >
              <div>
                {cachedPresetURL(item.url) ? (
                  <img
                    src={cachedPresetURL(item.url)}
                    alt={item.name}
                    loading="lazy"
                  />
                ) : (
                  <span className="muted">图片尚未缓存</span>
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
              key={`${c.kind}:${c.id}`}
              aria-label={`${c.name} ${c.material_count}个${noun}`}
              onClick={() => nav(presetDetailPath(c))}
            >
              <div>
                {cachedPresetURL(c.url) ? (
                  <img
                    src={cachedPresetURL(c.url)}
                    alt={c.name}
                    loading="lazy"
                  />
                ) : (
                  <span className="muted">封面尚未缓存</span>
                )}
              </div>
              <strong>{c.name}</strong>
              <span>
                {c.material_count}个{noun}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="preset-missing">
          {data.collections.some((item) => item.kind === activeKind)
            ? "没有找到相关预设"
            : "此类预设尚未采集，本地暂不提供。"}
        </p>
      )}
      <footer className="preset-footer">以上内容由人工智能生成合成</footer>
      {selected && collection && (
        <PresetDetail
          key={`${selected.kind}:${selected.id}`}
          item={selected}
          collection={collection}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
