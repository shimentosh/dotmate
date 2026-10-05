import { describe, expect, it } from "vitest";
import {
  cleanPrefix, clipFileName, fmtLength, fmtTime, moveSelection, resizeSelection,
  selectionAt, targetVideoBitrate, tickStep, uniqueFileName,
} from "./format";

describe("fmtTime", () => {
  it("formats minutes, seconds and centiseconds", () => {
    expect(fmtTime(14.2)).toBe("00:14.20");
    expect(fmtTime(91)).toBe("01:31.00");
    expect(fmtTime(3725.5)).toBe("1:02:05.50");
    expect(fmtTime(5, true)).toBe("0:00:05.00");
    expect(fmtTime(null)).toBe("--:--");
  });
});

describe("fmtLength", () => {
  it("keeps short lengths compact", () => {
    expect(fmtLength(2.5)).toBe("2.5s");
    expect(fmtLength(3)).toBe("3s");
    expect(fmtLength(65)).toBe("1m 05s");
  });
});

describe("selection maths", () => {
  it("creates a selection of the default length at the chosen point", () => {
    expect(selectionAt(14.2, 2.5, 600)).toEqual({ start: 14.2, end: 16.7 });
  });

  it("slides back near the end so the full length fits", () => {
    expect(selectionAt(599, 2.5, 600)).toEqual({ start: 597.5, end: 600 });
  });

  it("uses the whole video when it is shorter than the length", () => {
    expect(selectionAt(0.5, 2.5, 1.2)).toEqual({ start: 0, end: 1.2 });
  });

  it("moves without changing length and stays inside the video", () => {
    expect(moveSelection({ start: 10, end: 12.5 }, 5, 600)).toEqual({ start: 15, end: 17.5 });
    expect(moveSelection({ start: 1, end: 3.5 }, -5, 600)).toEqual({ start: 0, end: 2.5 });
    expect(moveSelection({ start: 590, end: 592.5 }, 50, 600)).toEqual({ start: 597.5, end: 600 });
  });

  it("resizes edges with a minimum length", () => {
    expect(resizeSelection({ start: 10, end: 12.5 }, "end", 14, 600)).toEqual({ start: 10, end: 14 });
    expect(resizeSelection({ start: 10, end: 12.5 }, "start", 12.49, 600)).toEqual({ start: 12.4, end: 12.5 });
    expect(resizeSelection({ start: 10, end: 12.5 }, "end", 900, 600)).toEqual({ start: 10, end: 600 });
  });
});

describe("output naming", () => {
  it("pads to three digits, wider for big queues", () => {
    expect(clipFileName("intro", 1, 200)).toBe("intro_001.mp4");
    expect(clipFileName("intro", 200, 200)).toBe("intro_200.mp4");
    expect(clipFileName("intro", 7, 1500)).toBe("intro_0007.mp4");
  });

  it("sanitises prefixes", () => {
    expect(cleanPrefix("  my hook: v2 ")).toBe("my_hook_v2");
    expect(cleanPrefix("../..")).toBe("clip");
    expect(cleanPrefix("")).toBe("clip");
  });

  it("never reuses a taken name", async () => {
    const taken = new Set(["intro_001.mp4", "intro_001 (2).mp4"]);
    const exists = async (n: string) => taken.has(n);
    expect(await uniqueFileName("intro_001.mp4", exists)).toBe("intro_001 (3).mp4");
    expect(await uniqueFileName("intro_002.mp4", exists)).toBe("intro_002.mp4");
  });
});

describe("targetVideoBitrate", () => {
  it("scales with resolution and frame rate", () => {
    const p1080_30 = targetVideoBitrate(1920, 1080, 30);
    const p1080_60 = targetVideoBitrate(1920, 1080, 60);
    const p2160_30 = targetVideoBitrate(3840, 2160, 30);
    expect(p1080_30).toBeGreaterThanOrEqual(12_000_000);
    expect(p1080_60).toBeCloseTo(p1080_30 * 2, -4);
    expect(p2160_30).toBeCloseTo(p1080_30 * 4, -4);
    expect(targetVideoBitrate(1920, 1080, 30, "hevc")).toBeLessThan(p1080_30);
  });
});

describe("tickStep", () => {
  it("keeps tick counts readable", () => {
    expect(tickStep(10)).toBe(1);
    expect(tickStep(30)).toBe(5);
    expect(3000 / tickStep(3000)).toBeLessThanOrEqual(12);
  });
});
