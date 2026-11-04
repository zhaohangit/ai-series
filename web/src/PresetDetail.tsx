import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Plus, Image as ImageIcon } from "lucide-react";
import { api, json, upload } from "./api";
import { Modal, Loading, ErrorPanel, useApp } from "./App";
import {
  cachedPresetURL,
  presetCategories,
  type Preset,
  type PresetCollection,
} from "./preset-domain";
import {
  buildImportedPreset,
  galleryGroups,
  importableGallery,
  type PresetGallery,
  type PresetGalleryImage,
} from "./preset-gallery";

export default function PresetDetail({
  item,
  collection,
  onClose,
}: {
  item: Preset;
  collection: PresetCollection;
  onClose: () => void;
}) {
  const { notify } = useApp();
  const [gallery, setGallery] = useState<PresetGallery | null>(null),
    [loadError, setLoadError] = useState(""),
    [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<PresetGalleryImage | null>(null),
    [group, setGroup] = useState("all"),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState("");
  const uploads = useRef<Record<string, string>>({}),
    main = useRef(""),
    submitted = useRef(false),
    alive = useRef(true);
  const importKey = useRef(crypto.randomUUID());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    setGallery(null);
    api<PresetGallery>(
      `/material-presets/${item.kind}/${collection.id}/${item.id}/gallery`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setGallery(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(e.message);
      });
    return () => controller.abort();
  }, [item.id, item.kind, collection.id, retry]);
  const label = presetCategories[item.kind]?.noun || "素材";
  const previewURL = cachedPresetURL(selected ? selected.url : item.url);
  const entries = (gallery?.items || []).filter(
    (row) => group === "all" || String(row.category ?? "other") === group,
  );
  async function copy(
    url: string,
    name: string,
    metadata?: PresetGalleryImage["image"],
  ) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("预设图片读取失败");
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || blob.size > 15 * 1024 * 1024)
      throw new Error("预设图片类型或大小不符合要求");
    if (metadata?.bytes !== undefined && blob.size !== metadata.bytes)
      throw new Error("设定图缓存大小不一致");
    if (metadata?.sha256) {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        await blob.arrayBuffer(),
      );
      if (
        [...new Uint8Array(hash)]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("") !== metadata.sha256
      )
        throw new Error("设定图校验失败");
    }
    const ext =
      (
        {
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif",
          "image/avif": "avif",
        } as Record<string, string>
      )[blob.type] || "jpg";
    return (
      await upload(new File([blob], `${name}.${ext}`, { type: blob.type }))
    ).url;
  }
  async function importItem() {
    if (!gallery || submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setError("");
    try {
      const cachedURL = cachedPresetURL(item.url);
      if (!cachedURL) throw new Error("主视觉尚未缓存");
      const copied = importableGallery(gallery.items);
      setProgress(`正在导入主视觉及 ${copied.length} 张设定图`);
      if (!main.current)
        main.current = await copy(
          cachedURL,
          item.name,
          item.metadata.image as PresetGalleryImage["image"],
        );
      for (let i = 0; i < copied.length; i++) {
        if (!alive.current) return;
        const row = copied[i];
        setProgress(`正在导入设定图 ${i + 1}/${copied.length}`);
        if (!uploads.current[row.id])
          uploads.current[row.id] = await copy(
            cachedPresetURL(row.url),
            `${item.name}-${row.name}`,
            row.image,
          );
      }
      if (!alive.current) return;
      await api("/assets", {
        method: "POST",
        headers: { "Idempotency-Key": importKey.current },
        body: json(
          buildImportedPreset(
            item,
            collection,
            main.current,
            gallery.items,
            uploads.current,
          ),
        ),
      });
      if (alive.current) {
        notify(`${label}已导入我的素材`);
        onClose();
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      submitted.current = false;
      if (alive.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }
  return (
    <Modal
      title={item.name}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="preset-detail-scroll">
        <div className="preset-character-detail">
          <div className="preset-selected-image">
            {previewURL ? (
              <img src={previewURL} alt={selected?.name || item.name} />
            ) : (
              <div className="preset-uncached">
                <ImageIcon size={28} />
                <span>该设定图尚未缓存</span>
              </div>
            )}
            <span>{selected?.name || "主视觉"}</span>
          </div>
          <div>
            <p>{selected?.description || item.description}</p>
            {typeof item.metadata.performance_info === "string" &&
              item.metadata.performance_info && (
                <p>{item.metadata.performance_info}</p>
              )}
            <p className="muted">
              {label}库：{collection.name}
            </p>
            <p className="muted">导入后可在本地修改{label}信息和图片。</p>
          </div>
        </div>
        {loadError ? (
          <ErrorPanel
            error={loadError}
            onRetry={() => setRetry((x) => x + 1)}
          />
        ) : !gallery ? (
          <Loading />
        ) : (
          <section className="preset-gallery" aria-label="预设设定图集">
            <header>
              <h3>
                设定图集 <span>{gallery.total} 张</span>
              </h3>
              <span>
                已缓存 {gallery.cached_count}/{gallery.total}
              </span>
            </header>
            {gallery.total > 0 ? (
              <>
                <nav aria-label="设定图分类">
                  <button
                    className={group === "all" ? "active" : ""}
                    onClick={() => setGroup("all")}
                  >
                    全部
                  </button>
                  {galleryGroups(
                    gallery.items.filter((row) => !!row.category_name),
                  ).map((g) => (
                    <button
                      key={g.key}
                      className={group === g.key ? "active" : ""}
                      onClick={() => setGroup(g.key)}
                    >
                      {g.name}
                    </button>
                  ))}
                </nav>
                <div className="preset-gallery-grid">
                  <button
                    className={!selected ? "active" : ""}
                    aria-label="查看主视觉"
                    onClick={() => setSelected(null)}
                  >
                    <img src={cachedPresetURL(item.url)} alt="主视觉" />
                    <strong>主视觉</strong>
                  </button>
                  {entries.map((row) => (
                    <button
                      key={row.id}
                      className={row.id === selected?.id ? "active" : ""}
                      aria-label={`查看设定图 ${row.name}`}
                      onClick={() => setSelected(row)}
                    >
                      {cachedPresetURL(row.url) ? (
                        <img
                          src={cachedPresetURL(row.url)}
                          alt={row.name}
                          loading="lazy"
                        />
                      ) : (
                        <div>
                          <ImageIcon size={22} />
                          <span>尚未缓存</span>
                        </div>
                      )}
                      <strong>{row.name}</strong>
                    </button>
                  ))}
                </div>
                {gallery.cached_count < gallery.total && (
                  <p className="preset-gallery-note">
                    导入包含主视觉和已缓存的 {gallery.cached_count}{" "}
                    张设定图。未缓存图片仅保留目录信息，暂不可预览或编辑。
                  </p>
                )}
              </>
            ) : (
              <p className="muted">该预设暂无设定图。</p>
            )}
          </section>
        )}
        {error && <ErrorPanel error={error} />}{" "}
        {busy && (
          <p role="status" className="preset-gallery-progress">
            <LoaderCircle size={16} className="spin" />
            {progress}
          </p>
        )}
      </div>
      <footer>
        {previewURL && (
          <a className="button" href={previewURL} download>
            <Download size={16} />
            {selected ? "下载设定图" : "下载主视觉"}
          </a>
        )}
        <button
          className="primary"
          disabled={busy || !gallery || !cachedPresetURL(item.url)}
          onClick={() => void importItem()}
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
  );
}
