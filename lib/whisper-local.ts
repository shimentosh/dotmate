/**
 * Local (on-device) Whisper for the desktop app.
 *
 * Transcription runs entirely on the user's machine via the native
 * `local-whisper` crate (whisper.cpp) — free, offline, private. This module is
 * the thin JS bridge to the Rust `transcribe_local` / `whisper_model_*` commands.
 *
 * The model file (75–466 MB) downloads from Hugging Face on first use into the
 * app data dir, then it's cached. Outside the desktop shell nothing here works
 * (isTauri() === false).
 */
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { safeInvoke } from "./tauri-invoke";
import { invokeWithBytes } from "./tauri-bytes";
import type { VoiceAnalysis } from "./voice-analyze-api";
import { storageKey } from "@/brand.config";

export type WhisperModelSize = "tiny" | "base" | "small";

export interface WhisperModelInfo {
  size: WhisperModelSize;
  label: string;
  mb: number; // approx download size
}

/** Selectable on-device models (multilingual GGML builds from whisper.cpp). */
export const WHISPER_MODELS: WhisperModelInfo[] = [
  { size: "tiny", label: "Tiny — fastest, basic accuracy", mb: 75 },
  { size: "base", label: "Base — balanced (recommended)", mb: 142 },
  { size: "small", label: "Small — best accuracy, slower", mb: 466 },
];

const LS_KEY = storageKey("whisper-model");
export const DEFAULT_WHISPER_MODEL: WhisperModelSize = "base";

/** True only inside the desktop app, where native Whisper is available. */
export function localWhisperAvailable(): boolean {
  return isTauri();
}

export function getWhisperModel(): WhisperModelSize {
  if (typeof window === "undefined") return DEFAULT_WHISPER_MODEL;
  const v = window.localStorage.getItem(LS_KEY);
  return v === "tiny" || v === "base" || v === "small" ? v : DEFAULT_WHISPER_MODEL;
}

export function setWhisperModel(size: WhisperModelSize): void {
  if (typeof window !== "undefined") window.localStorage.setItem(LS_KEY, size);
}

export interface WhisperModelStatus {
  installed: boolean;
  path: string;
  sizeBytes: number;
}

export function whisperModelStatus(size: WhisperModelSize): Promise<WhisperModelStatus> {
  return safeInvoke<WhisperModelStatus>("whisper_model_status", { size });
}

export interface ModelDownloadProgress {
  received: number;
  total: number;
  pct: number;
}

/** Download a model, reporting progress. Resolves to the on-disk model path. */
export async function downloadWhisperModel(
  size: WhisperModelSize,
  onProgress?: (p: ModelDownloadProgress) => void,
): Promise<string> {
  const unlisten = onProgress
    ? await listen<ModelDownloadProgress>("whisper_model_progress", (e) => onProgress(e.payload))
    : undefined;
  try {
    // No timeout — downloading a model is hundreds of MB and can take minutes.
    return await safeInvoke<string>("whisper_download_model", { size }, { timeoutMs: 0 });
  } finally {
    unlisten?.();
  }
}

/** Ensure the chosen model is present (downloading once if needed). */
export async function ensureWhisperModel(
  size: WhisperModelSize = getWhisperModel(),
  onProgress?: (p: ModelDownloadProgress) => void,
): Promise<void> {
  const status = await whisperModelStatus(size);
  if (!status.installed) await downloadWhisperModel(size, onProgress);
}

export interface TranscribeProgress {
  pct: number;
}

/**
 * Transcribe an audio blob entirely on-device. Returns a VoiceAnalysis (text +
 * sentence segments + per-word timestamps).
 */
export async function transcribeLocal(
  blob: Blob,
  language: string = "auto",
  opts: {
    model?: WhisperModelSize;
    onModelProgress?: (p: ModelDownloadProgress) => void;
    onProgress?: (p: TranscribeProgress) => void;
  } = {},
): Promise<VoiceAnalysis> {
  const size = opts.model ?? getWhisperModel();
  await ensureWhisperModel(size, opts.onModelProgress);

  const unlisten = opts.onProgress
    ? await listen<TranscribeProgress>("transcribe_progress", (e) => opts.onProgress!(e.payload))
    : undefined;
  try {
    // Audio rides the RAW request body (not a JSON number array, which bloated the
    // clip ~3.5× as a string + could freeze the webview on a long voiceover);
    // language/model ride base64 headers. The command still returns VoiceAnalysis JSON.
    return await invokeWithBytes<VoiceAnalysis>("transcribe_local", blob, {
      language: language || "auto",
      "model-size": size,
    });
  } finally {
    unlisten?.();
  }
}
