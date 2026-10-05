/**
 * transcript-store — the single entry point for transcribing audio on-device.
 *
 * Transcription (whisper.cpp) is expensive, so this module guarantees the same
 * audio is transcribed ONCE per session:
 *
 *   • cache keyed by src + language
 *   • in-flight dedupe — two callers asking at the same moment share one run
 *   • registers the run in the global task registry so navigating away mid-run
 *     pops the "leave?" warning
 *
 * Everything runs locally through `whisper-local.ts`; there is no cloud path.
 */
import type { VoiceAnalysis } from "./voice-analyze-api";
import { localWhisperAvailable, transcribeLocal } from "./whisper-local";
import { useActiveTasks } from "@/store/active-tasks";
import { brand } from "@/brand.config";

/**
 * Unified transcription progress. `model` = first-run model download (bytes);
 * once the model is present, `transcribe` reports the whisper.cpp percentage.
 */
export type TranscriptProgress =
  | { stage: "model"; received: number; total: number; pct: number }
  | { stage: "transcribe"; pct: number };

const cache = new Map<string, VoiceAnalysis>();
const inFlight = new Map<string, Promise<VoiceAnalysis>>();
const keyOf = (src: string, language: string) => `${src}|${language}`;

// Bound the in-memory cache so a long session can't grow it unbounded
// (insertion-order eviction; a transcript is cheap to regenerate).
const CACHE_CAP = 40;
function capCache(): void {
  while (cache.size > CACHE_CAP) {
    const k = cache.keys().next().value;
    if (k === undefined) break;
    cache.delete(k);
  }
}

/** Read a src into a Blob; reject non-2xx so an error body is never transcribed. */
async function readSrcBlob(src: string): Promise<Blob> {
  try {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`fetch ${src} → HTTP ${r.status}`);
    return await r.blob();
  } catch {
    throw new Error("Couldn't read the audio — its source is no longer available. Add the file again and retry.");
  }
}

/**
 * Get the transcript for an audio src (a `blob:` URL of a local file) —
 * transcribing only if needed. `force` skips the cache.
 */
export async function getVoiceTranscript(
  src: string,
  opts: {
    language?: string;
    force?: boolean;
    onProgress?: (p: TranscriptProgress) => void;
  } = {},
): Promise<VoiceAnalysis> {
  if (!localWhisperAvailable()) {
    throw new Error(`On-device transcription runs in the ${brand.name} desktop app.`);
  }
  const language = opts.language ?? "auto";
  const key = keyOf(src, language);

  if (!opts.force) {
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const run = (async () => {
    const blob = await readSrcBlob(src);
    const analysis = await transcribeLocal(blob, language, {
      onModelProgress: (p) =>
        opts.onProgress?.({ stage: "model", received: p.received, total: p.total, pct: p.pct }),
      onProgress: (p) => opts.onProgress?.({ stage: "transcribe", pct: p.pct }),
    });
    cache.set(key, analysis);
    capCache();
    return analysis;
  })();

  inFlight.set(key, run);
  // No real cancel for whisper.cpp yet, so no onAbort — the entry clears when the run settles.
  const taskId = `transcribe:${key}`;
  useActiveTasks.getState().begin({ id: taskId, label: "Transcribing audio", kind: "studio" });
  try {
    return await run;
  } finally {
    inFlight.delete(key);
    useActiveTasks.getState().end(taskId);
  }
}
