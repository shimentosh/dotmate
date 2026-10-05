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
  const unlisten = onProgress
    ? await listen<DepDownloadProgress>("ffmpeg_download_progress", (e) => onProgress(e.payload))
    : undefined;
  try {
    await invoke<string>("ffmpeg_download");
  } finally {
    unlisten?.();
  }
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
  const unlisten = onProgress
    ? await listen<DepDownloadProgress>("ytdlp_download_progress", (e) => onProgress(e.payload))
    : undefined;
  try {
    await invoke<string>("ytdlp_download");
  } finally {
    unlisten?.();
  }
}
