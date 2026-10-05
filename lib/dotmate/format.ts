/**
 * DotMate — pure helpers shared by the batch tools (time formatting, selection
 * maths, output naming). No DOM, no React: unit-tested in format.test.ts.
 */

/** The selection length a fresh mark gets until the user picks another default. */
export const DEFAULT_CLIP_SECONDS = 2.5;

/** Quick-pick lengths offered next to the custom input. */
export const DURATION_PRESETS = [1, 1.5, 2, 2.5, 3, 4, 5] as const;

/** Shortest selection a drag can produce. */
export const MIN_CLIP_SECONDS = 0.1;

/** Round to milliseconds so stored times don't accumulate float noise. */
export const roundMs = (t: number) => Math.round(t * 1000) / 1000;

/**
 * Timeline timestamp: `MM:SS.cc`, or `H:MM:SS.cc` once the video passes an hour.
 * `withHours` forces the hour field so a column of times lines up.
 */
export function fmtTime(sec: number | null | undefined, withHours = false): string {
  if (sec == null || !Number.isFinite(sec)) return "--:--";
  const totalCs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = String(totalCs % 100).padStart(2, "0");
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${cs}`;
  return h > 0 || withHours ? `${h}:${mmss}` : mmss;
}

/** Short clip length label: `2.5s`, `1m 05s` for long ones. */
export function fmtLength(sec: number): string {
  if (!Number.isFinite(sec)) return "–";
  if (sec < 60) return `${parseFloat(sec.toFixed(2))}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Coarse label for timeline ticks and source durations: `0:14`, `12:03`, `1:02:09`. */
export function fmtClock(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export interface Range { start: number; end: number }

/**
 * A fresh selection of `length` seconds starting at `t`, kept inside the video.
 * Near the end it slides back so the full length still fits; a video shorter than
 * `length` gets the whole video.
 */
export function selectionAt(t: number, length: number, duration: number): Range {
  const len = Math.min(Math.max(length, MIN_CLIP_SECONDS), duration);
  const start = Math.min(Math.max(0, t), Math.max(0, duration - len));
  return { start: roundMs(start), end: roundMs(start + len) };
}

/** Slide a selection by `delta` seconds without changing its length. */
export function moveSelection(r: Range, delta: number, duration: number): Range {
  const len = r.end - r.start;
  const start = Math.min(Math.max(0, r.start + delta), Math.max(0, duration - len));
  return { start: roundMs(start), end: roundMs(start + len) };
}

/** Drag one edge of a selection to `t`, keeping at least MIN_CLIP_SECONDS. */
export function resizeSelection(r: Range, edge: "start" | "end", t: number, duration: number): Range {
  if (edge === "start") {
    const start = Math.min(Math.max(0, t), r.end - MIN_CLIP_SECONDS);
    return { start: roundMs(start), end: r.end };
  }
  const end = Math.max(Math.min(duration, t), r.start + MIN_CLIP_SECONDS);
  return { start: r.start, end: roundMs(end) };
}

/** Sanitise a user-typed filename prefix; falls back to `clip`. */
export function cleanPrefix(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 60);
  return cleaned || "clip";
}

/** `clip_001.mp4` — zero-padded to at least 3 digits, wider when the queue needs it. */
export function clipFileName(prefix: string, n: number, total: number): string {
  const width = Math.max(3, String(Math.max(total, n)).length);
  return `${cleanPrefix(prefix)}_${String(n).padStart(width, "0")}.mp4`;
}

/**
 * First name not taken in the folder: `clip_001.mp4`, then `clip_001 (2).mp4`, …
 * `exists` is async so it can ask the file system directly.
 */
export async function uniqueFileName(
  name: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No free file name for ${name}`);
}

/**
 * Target video bitrate for a high-quality H.264 re-encode, scaled by resolution AND
 * frame rate (~0.2 bits per pixel per frame): 1080p30 ≈ 12 Mbps, 1080p60 ≈ 25 Mbps,
 * 4K30 ≈ 50 Mbps, 4K60 ≈ 100 Mbps. HEVC needs roughly 60% of that for the same look.
 */
export function targetVideoBitrate(width: number, height: number, fps: number, codec: "avc" | "hevc" = "avc"): number {
  const f = Number.isFinite(fps) && fps > 0 ? Math.min(fps, 120) : 30;
  const raw = width * height * f * 0.2 * (codec === "hevc" ? 0.6 : 1);
  return Math.round(Math.min(Math.max(raw, 4_000_000), 160_000_000) / 1000) * 1000;
}

/** Nice tick spacing for a timeline window `span` seconds wide (~6–12 ticks). */
export function tickStep(span: number): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => span / s <= 12) ?? 3600;
}
