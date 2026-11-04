export function validateName(value: string): { name?: string; error?: string } {
  const name = value.trim();
  return name ? { name } : { error: "请输入名称" };
}
export function uploadProblem(
  file: { name: string; size: number },
  kind: string,
) {
  if (file.size > 50 * 1024 * 1024) return "单个文件不能超过 50 MB";
  if (kind === "script" && !/\.(txt|doc|docx|pdf)$/i.test(file.name))
    return "请选择 txt、doc、docx 或 pdf 文件";
  return "";
}
export function filterTasks<T extends { kind: string; status: string }>(
  tasks: T[],
  tab: string,
  status: string,
): T[] {
  return tasks.filter(
    (t) =>
      (tab === "download" ? t.kind === "export" : t.kind !== "export") &&
      (status === "all" || t.status === status),
  );
}
export function canvasSnapshot<T extends { selected?: boolean }>(
  nodes: T[],
  edges: unknown[],
  viewport: { x: number; y: number; zoom: number },
  revision: number,
) {
  return {
    nodes: nodes.map(({ selected, ...node }) => node),
    edges,
    viewport,
    revision,
  };
}

export function materialPresetItems(catalog: {
  presets?: Array<Record<string, any>>;
  styles?: Array<Record<string, any>>;
}) {
  return catalog.presets?.length ? catalog.presets : catalog.styles || [];
}

export const referencePresetStyleNames = [
  "民俗克系",
  "诡秘克系",
  "赛博朋克",
  "中式仙侠",
  "3D国漫",
  "年代海报",
  "古典历史",
  "动漫电影",
  "韩系漫画",
  "青春校园",
  "昏暗色调",
  "古风插画",
  "都市异能",
  "东方玄幻",
];

export function referencePresetItems(items: Array<Record<string, any>>) {
  return items
    .map((item) =>
      item.name === "年代都市" ? { ...item, name: "年代海报" } : item,
    )
    .filter((item) => referencePresetStyleNames.includes(String(item.name)));
}
