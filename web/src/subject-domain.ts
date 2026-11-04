import type { Asset, Project } from "./types";

export type SubjectKind = "character" | "scene" | "prop";
export type SubjectAsset = Asset & { updated_at?: string };
export interface SubjectImage {
  id: string;
  name: string;
  url: string;
  created_at?: string;
  kind?: string;
  slot?: string;
}
export interface SubjectVoice extends Record<string, unknown> {
  description: string;
  text: string;
  model: string;
  url: string;
}
export interface SubjectMetadata extends Record<string, unknown> {
  role: string;
  age: string;
  appearance: string;
  performance_info: string;
  prompt: string;
  aspect_ratio: string;
  image_model: string;
  voice: SubjectVoice;
  gallery: SubjectImage[];
  versions: SubjectImage[];
}
export interface SubjectDraft {
  name: string;
  description: string;
  url: string;
  style: string;
  metadata: SubjectMetadata;
}

export const subjectKinds: { kind: SubjectKind; label: string }[] = [
  { kind: "character", label: "角色" },
  { kind: "scene", label: "场景" },
  { kind: "prop", label: "道具" },
];
export const subjectSlots = [
  { id: "front", name: "正面" },
  { id: "side", name: "侧面" },
  { id: "back", name: "背面" },
  { id: "close-up", name: "面部特写" },
];
const str = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function images(value: unknown, version = false): SubjectImage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const row = record(item),
      id = str(row.id),
      name =
        str(row.name) ||
        (version
          ? row.kind === "audio"
            ? "历史音频"
            : `生成图片${row.slot && row.slot !== "main" ? ` · ${str(row.slot)}` : ""}`
          : ""),
      url = str(row.url);
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        ...row,
        id,
        name,
        url,
        ...(typeof row.created_at === "string"
          ? { created_at: row.created_at }
          : {}),
      },
    ];
  });
}
export function subjectDraft(asset: SubjectAsset): SubjectDraft {
  const metadata = record(asset.metadata),
    voice = record(metadata.voice);
  return {
    name: str(asset.name),
    description: str(asset.description),
    url: str(asset.url),
    style: str(asset.style),
    metadata: {
      ...metadata,
      role: str(metadata.role),
      age: str(metadata.age),
      appearance: str(metadata.appearance),
      performance_info: str(metadata.performance_info),
      prompt: str(metadata.prompt),
      aspect_ratio: str(metadata.aspect_ratio),
      image_model: str(metadata.image_model),
      voice: {
        ...voice,
        description: str(voice.description),
        text: str(voice.text),
        model: str(voice.model),
        url: str(voice.url),
      },
      gallery: images(metadata.gallery),
      versions: images(metadata.versions, true),
    },
  };
}
export function subjectPatch(asset: SubjectAsset, draft: SubjectDraft) {
  if (!draft.name.trim()) throw new Error("请输入名称");
  if (!asset.updated_at) throw new Error("缺少素材版本信息，请重新加载后保存");
  return {
    ...draft,
    name: draft.name.trim(),
    expected_updated_at: asset.updated_at,
  };
}
export function updateGallery(
  gallery: SubjectImage[],
  image: SubjectImage,
): SubjectImage[] {
  return gallery.some((item) => item.id === image.id)
    ? gallery.map((item) =>
        item.id === image.id ? { ...item, ...image } : item,
      )
    : [...gallery, image];
}
export function subjectWithImage(
  draft: SubjectDraft,
  url: string,
  created_at: string,
  id: string,
): SubjectDraft {
  const versions =
    draft.url &&
    draft.url !== url &&
    !draft.metadata.versions.some((version) => version.url === draft.url)
      ? [
          { id, name: "历史主视觉", url: draft.url, created_at },
          ...draft.metadata.versions,
        ]
      : draft.metadata.versions;
  return { ...draft, url, metadata: { ...draft.metadata, versions } };
}
export function subjectTaskParameters(
  asset: SubjectAsset,
  draft: SubjectDraft,
  project: Project,
  gallerySlot = "main",
  kind: "image" | "audio" = "image",
) {
  if (!asset.updated_at) throw new Error("缺少素材版本信息，请重新加载");
  return {
    asset_id: asset.id,
    asset_updated_at: asset.updated_at,
    gallery_slot: kind === "audio" ? "main" : gallerySlot,
    aspect_ratio: draft.metadata.aspect_ratio || project.aspect_ratio,
    style: draft.style || project.style,
    model:
      kind === "audio"
        ? draft.metadata.voice.model
        : draft.metadata.image_model,
    ...(kind === "audio"
      ? { voice_description: draft.metadata.voice.description }
      : {}),
    reference_image_url: draft.url || undefined,
  };
}
