/**
 * Quick Edit — thin bridge to the Rust `quick_edit_*` commands
 * (src-tauri/src/quick_edit_command.rs). Videos are picked in a native dialog and
 * read in place by the local ffmpeg; outputs are written straight into the chosen
 * folder. Only the (small) music file is staged to temp.
 */
import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { brand } from "@/brand.config";

export interface PickedVideo { path: string; name: string; size: number }

export interface VideoInfo {
  /** Seconds; 0 when unknown. */
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string;
}

export interface RenderRequest {
  id: string;
  input: string;
  outputDir: string;
  musicPath: string | null;
  /** Linear gains: music 0–3, original 0–2. */
  musicVolume: number;
  originalVolume: number;
  musicOffset: number;
  fadeIn: number;
  fadeOut: number;
  suffix: string;
}

/** The error message Rust returns when a render was stopped. */
export const CANCELLED = "cancelled";

function requireDesktop() {
  if (!isTauri()) throw new Error(`Quick Edit runs in the ${brand.name} desktop app.`);
}

export async function pickVideos(): Promise<PickedVideo[]> {
  requireDesktop();
  return invoke<PickedVideo[]>("quick_edit_pick_videos");
}

export function probeVideo(path: string): Promise<VideoInfo> {
  return invoke<VideoInfo>("quick_edit_probe", { path });
}

/** Render one video; resolves to the output path. Rejects with `CANCELLED` when stopped. */
export function renderVideo(job: RenderRequest): Promise<string> {
  return invoke<string>("quick_edit_render", { job });
}

export function cancelRender(id: string): Promise<void> {
  return invoke("quick_edit_cancel", { id });
}

/** Progress (0..1) for every running render. */
export function onRenderProgress(cb: (id: string, progress: number) => void): Promise<UnlistenFn> {
  return listen<{ id: string; progress: number }>("quick-edit://progress", (e) => cb(e.payload.id, e.payload.progress));
}

/** Copy the music file to app temp so ffmpeg may read it. Returns its path. */
export async function stageMusic(file: File): Promise<string> {
  const { invokeWithBytes } = await import("./tauri-bytes");
  return invokeWithBytes("export_save_clip", file, { "file-name": file.name || "music.mp3" });
}

/** A URL the <video> element can stream the picked file from (asset protocol). */
export function previewUrl(path: string): string {
  return convertFileSrc(path);
}
