import {
  cachedPresetURL,
  presetAssetInput,
  type Preset,
  type PresetCollection,
} from "./preset-domain";
export type PresetGalleryImage = {
  id: string;
  name: string;
  category?: string | number;
  type?: string | number;
  category_name?: string;
  type_name?: string;
  description?: string;
  source_path?: string;
  url?: string;
  uncached?: boolean;
  reason?: string;
  image?: {
    content_type?: string;
    bytes?: number;
    sha256?: string;
    [key: string]: unknown;
  };
};
export type PresetGallery = {
  kind: string;
  collection_id: string;
  item_id: string;
  items: PresetGalleryImage[];
  total: number;
  cached_count: number;
};
export function importableGallery(items: PresetGalleryImage[]) {
  return items.filter((row) => !row.uncached && !!cachedPresetURL(row.url));
}
export function galleryGroups(items: PresetGalleryImage[]) {
  const groups = new Map<string, { key: string; name: string }>();
  for (const row of items) {
    const key = String(row.category ?? "other");
    groups.set(key, {
      key,
      name: row.category_name || (key === "other" ? "其他设定" : `分类 ${key}`),
    });
  }
  return [...groups.values()];
}
export function buildImportedPreset(
  item: Preset,
  collection: PresetCollection | Pick<PresetCollection, "id" | "kind" | "name">,
  mainURL: string,
  gallery: PresetGalleryImage[],
  uploads: Record<string, string>,
): {
  name: string;
  kind: string;
  description: string;
  url: string;
  style: string;
  metadata: Record<string, unknown>;
} {
  const base = presetAssetInput(item, collection, mainURL);
  const copied = importableGallery(gallery).map((row) => {
    const url = uploads[row.id];
    if (!url || !/^\/media\/[^?#]+$/.test(url))
      throw new Error("设定图尚未完整上传，请重试");
    return { ...row, url, uncached: false, reference_image_id: row.id };
  });
  return {
    ...base,
    metadata: {
      ...(base.metadata as Record<string, unknown>),
      gallery: copied,
      reference_gallery: gallery,
      reference_gallery_import: {
        total: gallery.length,
        cached: copied.length,
        imported: copied.length,
      },
    },
  };
}
