/**
 * The local-AI settings blob — ONE reader/writer for every surface (Settings →
 * Local AI, Script Writer, Script→Image Prompts, the TTS pages).
 *
 * Storage is `localStorage` (a per-machine preference, not a security decision).
 */

import { logDebug } from "@/lib/log";
import { preferenceStorageKey } from "@/lib/use-preference";
import { storageKey } from "@/brand.config";
import { CLI_BRAINS, type CliBrainId } from "./cli-brain";

export const LOCAL_AI_LS_KEY = storageKey("local-ai");
export const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/** Per-CLI overrides set in Settings → Local AI → Brain. */
export interface CliBrainPrefs {
  /** Absolute binary path when the PATH probe misses it. */
  path?: string;
  /** Provider-native model id (`--model`); blank = the CLI's own default. */
  model?: string;
}

export interface LocalAIConfig {
  ollamaUrl: string;
  /**
   * Task → engine id. Values are engine ids in the same vocabulary the pickers
   * use: `cli:<id>` · `local:<ollamaModel>` · a native engine id (`kokoro`, …).
   */
  taskRouting: Record<string, string>;
  /**
   * The user's preferred brain, as an engine id (`cli:claude-code` or
   * `local:llama3.2`). A *default selection*, not a lock — every picker still
   * offers every brain detected on this machine.
   */
  brainDefault?: string;
  cliBrains?: Partial<Record<CliBrainId, CliBrainPrefs>>;
}

/** Tasks that can be routed. `Brain` covers scripts / prompts (text + vision). */
export const VALID_TASKS = new Set(["Brain", "Scripts", "Voiceover"]);

export function defaultLocalAIConfig(): LocalAIConfig {
  return { ollamaUrl: OLLAMA_DEFAULT_URL, taskRouting: {}, cliBrains: {} };
}

export function loadLocalAIConfig(): LocalAIConfig {
  if (typeof localStorage === "undefined") return defaultLocalAIConfig();
  try {
    const raw = localStorage.getItem(LOCAL_AI_LS_KEY);
    if (!raw) return defaultLocalAIConfig();
    const parsed = { ...defaultLocalAIConfig(), ...JSON.parse(raw) } as LocalAIConfig;
    // Drop routing entries for tasks that no longer exist, so a stale key can't
    // pin a surface to an engine the app no longer knows how to run.
    parsed.taskRouting = Object.fromEntries(
      Object.entries(parsed.taskRouting ?? {}).filter(([k]) => VALID_TASKS.has(k)),
    );
    // Same for CLI prefs — an unknown id would be sent to a Rust match arm that
    // rejects it, so drop it here where we can do it quietly.
    if (parsed.cliBrains) {
      parsed.cliBrains = Object.fromEntries(
        Object.entries(parsed.cliBrains).filter(([k]) =>
          CLI_BRAINS.some((b) => b.id === k),
        ),
      );
    }
    return parsed;
  } catch (e) {
    logDebug("local-ai-config", "Failed to load local AI config", e);
    return defaultLocalAIConfig();
  }
}

export function saveLocalAIConfig(cfg: LocalAIConfig): void {
  try {
    localStorage.setItem(LOCAL_AI_LS_KEY, JSON.stringify(cfg));
    // Let other mounted surfaces (pickers already on screen) pick the change up
    // without a reload. `storage` only fires cross-tab, so we need our own event.
    window.dispatchEvent(new CustomEvent(LOCAL_AI_CHANGED));
  } catch (e) {
    logDebug("local-ai-config", "Failed to save local AI config", e);
  }
}

/** Fired on every save so open pickers can re-read without a reload. */
export const LOCAL_AI_CHANGED = storageKey("local-ai-changed");

export function ollamaUrl(cfg?: LocalAIConfig): string {
  return (cfg ?? loadLocalAIConfig()).ollamaUrl || OLLAMA_DEFAULT_URL;
}

/** The Settings-configured overrides for one CLI brain. */
export function cliPrefs(id: CliBrainId, cfg?: LocalAIConfig): CliBrainPrefs {
  return (cfg ?? loadLocalAIConfig()).cliBrains?.[id] ?? {};
}

/** `{ "claude-code": "C:/…/claude.exe" }` — only entries with a real path. */
export function cliPathOverrides(cfg?: LocalAIConfig): Record<string, string> {
  const c = cfg ?? loadLocalAIConfig();
  const out: Record<string, string> = {};
  for (const [id, p] of Object.entries(c.cliBrains ?? {})) {
    if (p?.path?.trim()) out[id] = p.path.trim();
  }
  return out;
}

/**
 * Should the Settings default brain be applied to a picker whose choice is stored
 * under the `usePreference` key `prefKey`?
 *
 * `usePreference` renders its fallback first and adopts the stored value in a
 * post-mount effect, so a naive "is it still the fallback?" check can win the
 * race against a saved choice and silently overwrite it. Reading the raw key is
 * authoritative and synchronous, so an explicit pick is never stomped. A stored
 * value that is still the untouched fallback ("" — nothing picked yet) is
 * overridden.
 *
 * Returns the engine id to apply, or `null` to leave the picker alone.
 */
export function defaultBrainToApply(
  prefKey: string,
  available: readonly { id: string }[],
): string | null {
  const preferred = loadLocalAIConfig().brainDefault;
  if (!preferred) return null;
  // Not (yet) available on this machine — don't select something that would error.
  if (!available.some((b) => b.id === preferred)) return null;
  try {
    const raw = localStorage.getItem(preferenceStorageKey(prefKey));
    if (raw != null) {
      // A stored value exists. Only override the untouched default ("").
      let v: unknown = raw;
      try { v = JSON.parse(raw); } catch { /* legacy raw string */ }
      if (v !== "") return null;
    }
  } catch {
    return null; // no storage access → never guess
  }
  return preferred;
}
