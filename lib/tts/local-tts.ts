/**
 * On-device (local) TTS — Kokoro-82M (multi-voice / multi-language, via
 * sherpa-onnx) and, when the build ships a download source for it, Supertonic 3
 * (ONNX Runtime). Both run **in-process** in the Tauri desktop app — no Docker,
 * no Python, no localhost server. A model downloads once into the app-data dir,
 * then every call is offline and free.
 *
 * Shared by Text-to-Voice and Bulk Voice. Outside the desktop shell
 * `localTtsAvailable()` is false and `localTtsGenerate` throws a clear message.
 */
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { safeInvoke } from "@/lib/tauri-invoke";
import { brand, storageKey } from "@/brand.config";

/** The on-device engines (provider ids used across the TTS UIs). */
export const LOCAL_TTS_MODELS = ["kokoro", "supertonic"] as const;
export type LocalTtsModel = (typeof LOCAL_TTS_MODELS)[number];

export function isLocalTtsModel(model: string): model is LocalTtsModel {
  return (LOCAL_TTS_MODELS as readonly string[]).includes(model);
}

/** True only inside the desktop app, where native TTS is available. */
export function localTtsAvailable(): boolean {
  return isTauri();
}

export interface TtsModelStatus {
  /** The model's files are on disk. */
  installed: boolean;
  /**
   * The model can be used on this build: installed, or a download source is
   * configured. Supertonic has no public source — it is unavailable unless the
   * vendor set `SUPERTONIC_ARCHIVE_URL` at build time (see README).
   */
  available: boolean;
  path: string;
  sizeBytes: number;
}

const NOT_INSTALLED: TtsModelStatus = { installed: false, available: false, path: "", sizeBytes: 0 };

/** Is the model on disk / downloadable? (Outside Tauri: never.) */
export async function ttsModelStatus(model: LocalTtsModel): Promise<TtsModelStatus> {
  if (!isTauri()) return NOT_INSTALLED;
  return safeInvoke<TtsModelStatus>("tts_model_status", { model });
}

/**
 * Window event fired whenever the set of installed local voices changes (a model
 * finished downloading). Open voice pickers listen so a model installed in
 * Settings → Local AI → Voice appears without a reload.
 */
export const LOCAL_TTS_CHANGED_EVENT = storageKey("local-tts-changed");

/** Broadcast that the installed-voice set changed. */
export function notifyLocalTtsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCAL_TTS_CHANGED_EVENT));
}

/** Status of every on-device voice engine. Outside Tauri → all unavailable. */
export async function localTtsStatuses(): Promise<Record<LocalTtsModel, TtsModelStatus>> {
  const entries = await Promise.all(
    LOCAL_TTS_MODELS.map(async (m) => {
      try { return [m, await ttsModelStatus(m)] as const; }
      catch { return [m, NOT_INSTALLED] as const; }
    }),
  );
  return Object.fromEntries(entries) as Record<LocalTtsModel, TtsModelStatus>;
}

/** Map of which on-device voices are actually installed on disk. */
export async function installedLocalTtsModels(): Promise<Record<LocalTtsModel, boolean>> {
  const s = await localTtsStatuses();
  return { kokoro: s.kokoro.installed, supertonic: s.supertonic.installed };
}

export interface ModelDownloadProgress {
  received: number;
  total: number;
  pct: number;
}

/** Download a model once, reporting progress. Resolves to the model dir path. */
export async function downloadTtsModel(
  model: LocalTtsModel,
  onProgress?: (p: ModelDownloadProgress) => void,
): Promise<string> {
  const unlisten = onProgress
    ? await listen<ModelDownloadProgress>("tts_model_progress", (e) => onProgress(e.payload))
    : undefined;
  try {
    // No timeout — the model is hundreds of MB and can take minutes to fetch.
    const dir = await safeInvoke<string>("tts_download_model", { model }, { timeoutMs: 0 });
    // Now installed — let any open voice picker re-check and offer it.
    notifyLocalTtsChanged();
    return dir;
  } finally {
    unlisten?.();
  }
}

/** Ensure the model is present (downloading once if needed). */
export async function ensureTtsModel(
  model: LocalTtsModel,
  onProgress?: (p: ModelDownloadProgress) => void,
): Promise<void> {
  const status = await ttsModelStatus(model);
  if (status.installed) return;
  if (!status.available) {
    throw new Error(`${model} voices are not available in this build.`);
  }
  await downloadTtsModel(model, onProgress);
}

/**
 * Synthesize speech on-device and return playable WAV audio.
 *   `localTtsGenerate(model, text, voiceId, speedPct)`
 * `voiceId` is the Kokoro speaker id as a string (e.g. "3") or a Supertonic style
 * id ("M1".."F5"). `speedPct` is the 50..200 UI value (mapped to 0.5..2.0).
 */
export async function localTtsGenerate(
  model: string,
  text: string,
  voiceId: string,
  speedPct: number,
  onModelProgress?: (p: ModelDownloadProgress) => void,
): Promise<Blob> {
  if (!isTauri()) {
    throw new Error(`On-device voices run in the ${brand.name} desktop app.`);
  }
  if (!isLocalTtsModel(model)) {
    throw new Error(`${model} is not a local voice provider.`);
  }
  await ensureTtsModel(model, onModelProgress); // one-click download-on-first-use
  const speed = Math.max(0.5, Math.min(2.0, speedPct / 100));
  const bytes = await safeInvoke<number[]>(
    "tts_synthesize",
    { model, text, voice: voiceId ?? "", speed },
    { timeoutMs: 0 },
  );
  return new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
}
