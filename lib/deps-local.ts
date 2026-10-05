/**
 * First-launch dependency downloads (desktop only).
 *
 * ffmpeg (merging, audio tools, on-device transcription) and yt-dlp (the video
 * downloader) are NOT bundled — they download once from their upstream release
 * pages into the app-data `bin/` dir. Thin JS bridge to the Rust `ffmpeg_*` /
 * `ytdlp_*` commands in `deps_command.rs` (source URLs: `src-tauri/src/sources.rs`).
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toastInfo, toastSuccess } from "./toast";

export interface BinStatus {
  installed: boolean;
  path: string;
  sizeBytes: number;
}

export interface DepDownloadProgress {
  received: number;
  total: number;
  pct: number;
}

export function isDesktop(): boolean {
  return isTauri();
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────

export function ffmpegStatus(): Promise<BinStatus> {
  return invoke<BinStatus>("ffmpeg_status");
}

/** Ensure ffmpeg is present (downloading once if needed), reporting progress. */
export async function ensureFfmpeg(
  onProgress?: (p: DepDownloadProgress) => void,
): Promise<void> {
  const status = await ffmpegStatus();
  if (status.installed) return;
  await downloadOnce("ffmpeg", onProgress);
}

// ── yt-dlp ──────────────────────────────────────────────────────────────────

export function ytdlpStatus(): Promise<BinStatus> {
  return invoke<BinStatus>("ytdlp_status");
}

/** Ensure yt-dlp is present (downloading once if needed), reporting progress. */
export async function ensureYtdlp(
  onProgress?: (p: DepDownloadProgress) => void,
): Promise<void> {
  const status = await ytdlpStatus();
  if (status.installed) return;
  await downloadOnce("ytdlp", onProgress);
}

// ── shared download (one at a time per tool) ────────────────────────────────

type Dep = "ffmpeg" | "ytdlp";

/** In-flight downloads, so parallel jobs (e.g. 4 merges at once) share ONE download. */
const inFlight: Partial<Record<Dep, Promise<void>>> = {};

async function downloadOnce(dep: Dep, onProgress?: (p: DepDownloadProgress) => void): Promise<void> {
  const unlisten = onProgress
    ? await listen<DepDownloadProgress>(`${dep}_download_progress`, (e) => onProgress(e.payload))
    : undefined;
  try {
    inFlight[dep] ??= invoke<string>(`${dep}_download`).then(() => undefined).finally(() => { delete inFlight[dep]; });
    await inFlight[dep];
  } finally {
    unlisten?.();
  }
}

const DEP_LABEL: Record<Dep, string> = { ffmpeg: "FFmpeg", ytdlp: "yt-dlp" };

/**
 * Call before running a tool that needs FFmpeg / yt-dlp. If one is missing (never
 * installed, deleted, removed by antivirus…) it downloads it right there, with a
 * toast so the user knows why the first run takes longer, instead of failing with
 * "ffmpeg not found". No-op when everything is installed or outside the desktop app.
 */
export async function ensureToolDeps(deps: Dep[] = ["ffmpeg"]): Promise<void> {
  if (!isTauri()) return;
  const statuses = await Promise.all(deps.map((d) => (d === "ffmpeg" ? ffmpegStatus() : ytdlpStatus())));
  const missing = deps.filter((_, i) => !statuses[i].installed);
  if (missing.length === 0) return;
  const names = missing.map((d) => DEP_LABEL[d]).join(" and ");
  toastInfo(`${names} ${missing.length > 1 ? "are" : "is"} missing — downloading now (one time only)…`, "Getting things ready");
  for (const d of missing) await downloadOnce(d);
  toastSuccess(`${names} installed.`);
}
