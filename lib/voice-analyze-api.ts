/**
 * Transcript types shared by the on-device Whisper bridge (`whisper-local.ts`),
 * the transcript store and the Voice-to-Text page. The Rust `Transcript` struct
 * (crates/whisper) serialises to exactly this shape (camelCase).
 */

export interface VoiceAnalysis {
  text:           string;
  duration:       number;  // seconds
  wordCount:      number;
  wordsPerSecond: number;  // speech rate
  segmentCount:   number;  // raw Whisper segment count (informational only)
  segments:       { start: number; end: number; text: string }[];
  /** Per-word timestamps. */
  words:          { word: string; start: number; end: number }[];
  /** Which Whisper model was used, e.g. "ggml-base". */
  model?:         string;
}
