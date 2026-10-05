/**
 * Video clip merging runs LOCALLY in the desktop app via the downloaded ffmpeg
 * (the `ffmpeg_merge_videos` Tauri command) — nothing is uploaded. Outside the
 * desktop shell (a plain browser dev session) this throws.
 */
import { brand } from "@/brand.config";

/**
 * Desktop: write a browser File to a temp file on this machine (no upload) and
 * return its absolute path, so the local ffmpeg command can read it from disk.
 * Reuses the renderer's `export_save_clip` command.
 */
async function fileToTempPath(file: File): Promise<string> {
  const { invokeWithBytes } = await import("./tauri-bytes");
  const name = file.name && file.name.trim() ? file.name : "input.bin";
  // Raw request body (not a JSON number array) so a large media File doesn't freeze/OOM.
  return invokeWithBytes("export_save_clip", file, { "file-name": name });
}

export type MergeQuality = "high" | "balanced" | "fast";

/** Output shape. "auto" keeps the main clip's. Resolution is never lowered either
 *  way — the short side is the sharpest input's (capped at 4K). */
export type MergeAspect = "auto" | "9:16" | "16:9" | "1:1" | "4:5";

export interface MergeOptions {
  aspect?:    MergeAspect;
  /** Which of `clips` is the main clip — the "auto" aspect follows it. */
  mainIndex?: 0 | 1;
}

/**
 * Merge exactly 2 video clips with optional background music, locally via the
 * bundled ffmpeg. Nothing is uploaded.
 *
 * @param clips     Tuple of [firstClip, secondClip] — concatenated in this order
 * @param music     Optional background audio file
 * @param musicVol  Music volume 0-100 (converted to 0-1 before sending)
 * @param quality   Render quality tier — "high" (default) | "balanced" | "fast"
 * @param onProgress  Progress callback 0-100
 */
export async function apiMergePair(
  clips: [File, File],
  music:     File | null,
  musicVol:  number,
  quality:   MergeQuality = "high",
  onProgress?: (pct: number) => void,
  opts: MergeOptions = {},
): Promise<Blob> {
  const core = await import("@tauri-apps/api/core");
  if (!core.isTauri()) {
    throw new Error(`Video merging runs in the ${brand.name} desktop app.`);
  }
  // Download FFmpeg here if it went missing, instead of failing with "not found".
  const { ensureToolDeps } = await import("./deps-local");
  await ensureToolDeps(["ffmpeg"]);
  const aspect    = opts.aspect ?? "auto";
  const mainIndex = opts.mainIndex ?? 0;
  onProgress?.(5);
  const clipPaths = [await fileToTempPath(clips[0]), await fileToTempPath(clips[1])];
  const musicPath = music ? await fileToTempPath(music) : null;
  onProgress?.(35);
  const buf = await core.invoke<ArrayBuffer>("ffmpeg_merge_videos", {
    clipPaths,
    musicPath,
    musicVolume: musicVol / 100,
    quality,
    aspect,
    mainIndex,
  });
  onProgress?.(100);
  return new Blob([buf], { type: "video/mp4" });
}
