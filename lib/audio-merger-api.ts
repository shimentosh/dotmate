/**
 * Audio merging runs LOCALLY in the desktop app via the downloaded ffmpeg
 * (`ffmpeg_merge_audio`). Nothing is uploaded. The create→poll→download flow is
 * kept for callers that use it; it completes synchronously on-device and stashes
 * the result behind a local job id.
 */
import { brand } from "@/brand.config";

const DESKTOP_ONLY = `Audio merging runs in the ${brand.name} desktop app.`;

/** Desktop: write a browser File to temp (no upload), return its path for ffmpeg. */
async function fileToTempPath(file: File): Promise<string> {
  const { invokeWithBytes } = await import("./tauri-bytes");
  const name = file.name && file.name.trim() ? file.name : "input.bin";
  // Raw request body (not a JSON number array) so a large media File doesn't freeze/OOM.
  return invokeWithBytes("export_save_clip", file, { "file-name": name });
}

/** Local (desktop) merge: run the bundled ffmpeg, return the result Blob.
 *  `loops` repeats the whole ordered sequence N times (loop a track into a long mix);
 *  each unique file is still written to temp only once. */
async function localMergeAudio(files: File[], format: "mp3" | "wav", loops = 1): Promise<Blob> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { ensureToolDeps } = await import("./deps-local");
  await ensureToolDeps(["ffmpeg"]);
  const clipPaths: string[] = [];
  for (const f of files) clipPaths.push(await fileToTempPath(f));
  const buf = await invoke<ArrayBuffer>("ffmpeg_merge_audio", { clipPaths, format, loops });
  return new Blob([buf], { type: format === "wav" ? "audio/wav" : "audio/mpeg" });
}

async function requireDesktop(): Promise<typeof import("@tauri-apps/api/core")> {
  const core = await import("@tauri-apps/api/core");
  if (!core.isTauri()) throw new Error(DESKTOP_ONLY);
  return core;
}

// Local async-job results stashed here so the page's existing create→poll→download
// flow works unchanged on desktop (no server round-trip).
const localJobs = new Map<string, Blob>();

export async function apiMergeAudio(
  files: File[],
  format: "mp3" | "wav",
  onProgress?: (pct: number) => void,
  loops = 1,
): Promise<Blob> {
  if (files.length === 0) throw new Error("Add at least one audio file");
  await requireDesktop();
  onProgress?.(20);
  const blob = await localMergeAudio(files, format, loops);
  onProgress?.(100);
  return blob;
}

/** "Start" an async merge — runs locally + synchronously, returns a local job id. */
export async function apiCreateAudioMergeJob(
  files: File[],
  onUpload?: (pct: number) => void,
): Promise<string> {
  await requireDesktop();
  onUpload?.(10);
  const blob = await localMergeAudio(files, "wav");
  onUpload?.(100);
  const jobId = `local:${performance.now()}-${files.length}`;
  localJobs.set(jobId, blob);
  return jobId;
}

/** Poll the job — local jobs already finished synchronously when created. */
export function pollAudioMergeJob(
  jobId: string,
  onProgress: (pct: number, phase: string) => void,
  _intervalMs = 400,
): Promise<void> {
  if (jobId.startsWith("local:")) {
    onProgress(100, "done");
    return Promise.resolve();
  }
  return Promise.reject(new Error(DESKTOP_ONLY));
}

/** Download the finished result blob (the stashed local result). */
export async function apiDownloadAudioMergeJob(jobId: string): Promise<Blob> {
  if (jobId.startsWith("local:")) {
    const blob = localJobs.get(jobId);
    localJobs.delete(jobId);
    if (!blob) throw new Error("Local merge result expired — please try again.");
    return blob;
  }
  throw new Error(DESKTOP_ONLY);
}
