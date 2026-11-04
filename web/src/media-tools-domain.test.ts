import { describe, expect, it } from "vitest";
import { mediaParameters, ratioCrop } from "./media-tools-domain";

const info = {
  kind: "video" as const,
  source_url: "/media/test.mp4",
  width: 1344,
  height: 768,
  duration: 5.167,
};
describe("owned media editing parameters", () => {
  it("rejects invalid bounds, NaN and non-playable odd video dimensions", () => {
    expect(() =>
      mediaParameters(info, "crop_video", {
        x: 0,
        y: 0,
        width: 101,
        height: 100,
      }),
    ).toThrow();
    expect(() =>
      mediaParameters(info, "crop_video", {
        x: 1300,
        y: 0,
        width: 100,
        height: 100,
      }),
    ).toThrow();
    expect(() =>
      mediaParameters(info, "trim_video", { start: NaN, end: 2 }),
    ).toThrow();
    expect(() =>
      mediaParameters(info, "trim_video", { start: 2, end: 2 }),
    ).toThrow();
    expect(() =>
      mediaParameters(info, "extract_frame", { at: 5.167 }),
    ).toThrow();
  });
  it("preserves actual fractional timing and independent output medium", () => {
    expect(
      mediaParameters(info, "trim_video", { start: 0.125, end: 3.25 }),
    ).toEqual({
      operation: "trim_video",
      source_url: info.source_url,
      start: 0.125,
      end: 3.25,
    });
    expect(mediaParameters(info, "extract_frame", { at: 1.25 }).at).toBe(1.25);
    expect(() =>
      mediaParameters(info, "trim_audio", { start: 0, end: 1 }),
    ).toThrow();
  });
  it("fits portrait ratios inside the source and preserves arbitrary image pixels", () => {
    const crop = ratioCrop(info, 9 / 16);
    expect(crop).toEqual({ x: 456, y: 0, width: 432, height: 768 });
    expect(
      mediaParameters(
        { ...info, kind: "image", duration: null },
        "crop_image",
        { x: 1, y: 3, width: 99, height: 101 },
      ).width,
    ).toBe(99);
  });
  it("combines video crop with a selected time range and rejects half-ranges", () => {
    const values = {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      start: 0.5,
      end: 2.5,
    };
    expect(mediaParameters(info, "crop_video", values)).toMatchObject({
      start: 0.5,
      end: 2.5,
    });
    expect(() =>
      mediaParameters(info, "crop_video", { ...values, end: NaN }),
    ).toThrow();
    expect(() =>
      mediaParameters(info, "crop_video", {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        start: 0,
      }),
    ).toThrow();
  });
});
