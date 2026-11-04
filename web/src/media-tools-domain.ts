export type MediaKind = "image" | "video" | "audio";
export type MediaOperation =
  "crop_image" | "crop_video" | "trim_video" | "trim_audio" | "extract_frame";
export type MediaInfo = {
  source_url: string;
  kind: MediaKind;
  width: number | null;
  height: number | null;
  duration: number | null;
};
export type Crop = { x: number; y: number; width: number; height: number };
export const operationLabels: Record<MediaOperation, string> = {
  crop_image: "剪裁图片",
  crop_video: "裁剪画面",
  trim_video: "裁剪时长",
  trim_audio: "裁剪音频",
  extract_frame: "视频截帧",
};
export function mediaParameters(
  info: MediaInfo,
  operation: MediaOperation,
  values: Record<string, number>,
): Record<string, string | number> {
  const sourceKind =
    operation === "crop_image"
      ? "image"
      : operation === "trim_audio"
        ? "audio"
        : "video";
  if (sourceKind !== info.kind) throw new Error("素材类型与编辑工具不匹配");
  const result: Record<string, string | number> = {
    operation,
    source_url: info.source_url,
  };
  if (operation.startsWith("crop_")) {
    const { x, y, width, height } = values;
    if (
      ![x, y, width, height].every(Number.isInteger) ||
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1 ||
      x + width > (info.width || 0) ||
      y + height > (info.height || 0)
    )
      throw new Error("裁剪区域须位于原始画面内，尺寸为正整数");
    if (info.kind === "video" && (width % 2 || height % 2))
      throw new Error("视频裁剪的宽和高须为偶数");
    Object.assign(result, { x, y, width, height });
    if (operation === "crop_video" && ("start" in values || "end" in values)) {
      const { start, end } = values;
      if (
        ![start, end].every(Number.isFinite) ||
        start < 0 ||
        start >= end ||
        end > (info.duration || 0)
      )
        throw new Error("结束时间须大于开始时间，且不能超出素材时长");
      Object.assign(result, { start, end });
    }
  } else if (operation.startsWith("trim_")) {
    const { start, end } = values;
    if (
      ![start, end].every(Number.isFinite) ||
      start < 0 ||
      start >= end ||
      end > (info.duration || 0)
    )
      throw new Error("结束时间须大于开始时间，且不能超出素材时长");
    if (
      info.kind === "video" &&
      ((info.width || 0) % 2 || (info.height || 0) % 2)
    )
      throw new Error("当前视频尺寸不支持直接剪辑，请先裁剪为偶数宽高");
    Object.assign(result, { start, end });
  } else if (operation === "extract_frame") {
    if (
      !Number.isFinite(values.at) ||
      values.at < 0 ||
      values.at >= (info.duration || 0)
    )
      throw new Error("截帧位置须在视频时长之内");
    result.at = values.at;
  } else throw new Error("不支持的编辑操作");
  return result;
}
export function ratioCrop(info: MediaInfo, ratio: number): Crop {
  let width = info.width || 1,
    height = info.height || 1;
  if (ratio > 0) {
    if (width / height > ratio) width = Math.floor(height * ratio);
    else height = Math.floor(width / ratio);
  }
  if (info.kind === "video") {
    width -= width % 2;
    height -= height % 2;
  }
  return {
    x: Math.floor(((info.width || 1) - width) / 2),
    y: Math.floor(((info.height || 1) - height) / 2),
    width,
    height,
  };
}
