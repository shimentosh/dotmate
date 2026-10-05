import { logDebug } from "@/lib/log";

/**
 * Whisper transcription types + on-device status.
 *
 * Transcription itself goes through `transcript-store` (on-device Whisper).
 * These types are shared by the Voice-to-Text UI.
 */

export interface TranscribeResult {
  text: string;
  language: string;
  duration: number;
  model: string;
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
}

/** Exact per-word timestamp from Whisper chunk output */
export interface TranscribeWord {
  word:  string;
  start: number;  // seconds from audio start
  end:   number;  // seconds from audio start
}

export interface TranscribeWithSegmentsResult {
  text:     string;
  duration: number;
  segments: TranscribeSegment[];
  /** Precise per-word timestamps — use these instead of distributing evenly inside segments */
  words:    TranscribeWord[];
}

export interface WhisperStatus {
  running: boolean;
  model?: string;
  device?: string;
}

/**
 * On-device Whisper availability: whether the desktop runtime (Tauri) is present.
 * The on-device engine downloads its model on first use.
 */
export async function apiWhisperStatus(): Promise<WhisperStatus> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    const onDevice = isTauri();
    return { running: onDevice, device: onDevice ? "on-device" : undefined };
  } catch (e) {
    logDebug("whisper-api", "apiWhisperStatus Tauri check failed", e);
    return { running: false };
  }
}
