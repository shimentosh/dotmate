/**
 * One-shot sessionStorage hand-offs between tools (e.g. Script Writer →
 * "Generate audio" pre-fills the Text-to-Voice script field).
 */
import { storageKey } from "@/brand.config";

/** Script text handed from Script Writer to Text-to-Voice. Read once, then removed. */
export const TTS_PREFILL_KEY = storageKey("tts-prefill");
