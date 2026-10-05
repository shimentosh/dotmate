/**
 * Generic key→value store for small, non-secret, per-machine UI state (e.g. the
 * last-known list of installed Ollama models). Backed by localStorage under the
 * product's key prefix; values are JSON. Async signatures so callers don't care
 * where it lives.
 */
import { storageKey } from "@/brand.config";

const k = (key: string) => storageKey(`kv:${key}`);

export async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const raw = localStorage.getItem(k(key));
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try { localStorage.setItem(k(key), JSON.stringify(value)); } catch { /* storage full / unavailable — non-fatal */ }
}

export async function kvDelete(key: string): Promise<void> {
  try { localStorage.removeItem(k(key)); } catch { /* storage unavailable — non-fatal */ }
}
