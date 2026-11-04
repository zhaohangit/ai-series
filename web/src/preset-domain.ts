export type Preset = {
  id: string;
  name: string;
  kind: string;
  description: string;
  url?: string;
  metadata: Record<string, unknown>;
};
export type PresetCollection = {
  id: string;
  name: string;
  kind: string;
  url?: string;
  material_count: number;
  items: Preset[];
};
export const presetCategories: Record<
  string,
  { code: string; noun: string; detail: string }
> = {
  character: { code: "1", noun: "角色", detail: "roleDetail" },
  scene: { code: "2", noun: "场景", detail: "sceneDetail" },
  prop: { code: "3", noun: "道具", detail: "effectsDetail" },
  effect: { code: "4", noun: "特效", detail: "effectsDetail" },
};
export function presetKindAtDetail(kind: string, category: string | null) {
  return kind === "effect" && category === "3" ? "prop" : kind;
}
export function presetListPath(kind: string, source = "preset") {
  return `/material?category=${presetCategories[kind]?.code || "1"}&active=${source === "own" ? "1" : "2"}`;
}
export function presetDetailPath(collection: { id: string; kind: string }) {
  const category = presetCategories[collection.kind];
  if (!category) throw new Error("不支持的素材类别");
  return `/material/${category.detail}?id=${encodeURIComponent(collection.id)}&type=system&category=${category.code}`;
}
export function findPresetCollection<T extends { id: string; kind: string }>(
  collections: T[],
  id: string,
  kind: string,
): T | undefined {
  return collections.find(
    (collection) => collection.kind === kind && collection.id === id,
  );
}
export function cachedPresetURL(url?: string): string {
  return url &&
    /^\/reference\/preset-(?:extra-)?[a-z0-9-]+\.(?:png|jpe?g|webp|gif|avif)$/i.test(
      url,
    )
    ? url
    : "";
}
export function presetAssetInput(
  item: Preset,
  collection: Pick<PresetCollection, "id" | "name" | "kind">,
  ownedURL: string,
) {
  if (!presetCategories[item.kind] || item.kind !== collection.kind)
    throw new Error("素材类别与预设库不一致");
  if (!/^\/media\/[^?#]+$/.test(ownedURL))
    throw new Error("请先上传素材到本地空间");
  return {
    name: item.name,
    kind: item.kind,
    description: item.description,
    url: ownedURL,
    style: collection.name,
    metadata: {
      ...item.metadata,
      ...(item.kind === "character"
        ? {
            role: item.metadata.identity || item.metadata.role || "",
            age: item.metadata.age_group || item.metadata.age || "",
            appearance: item.description || item.metadata.appearance || "",
          }
        : {}),
      in_library: true,
      reference_collection_id: collection.id,
      reference_collection_kind: collection.kind,
      reference_preset_id: item.id,
    },
  };
}
