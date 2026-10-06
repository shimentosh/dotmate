/**
 * API brains — the user's OWN cloud AI provider, reached with an API key they
 * paste into Settings → API Keys. Opt-in: no key saved → no `api:*` brain exists.
 *
 * The third kind of "brain" next to Ollama (`local:<model>`) and CLI brains
 * (`cli:<id>`). Calls go through Tauri (`api_brain_*` in
 * src-tauri/src/api_brain_command.rs) because the webview CSP only allows
 * localhost. Keys are write-only from here: the native side never returns one,
 * only `configured` + the last 4 characters.
 *
 * Desktop-only by construction: outside the Tauri shell `listApiBrains()` returns
 * `[]`, so no API option is ever offered on the web build.
 */
import { isTauri } from "@tauri-apps/api/core";
import { brand } from "@/brand.config";
import { safeInvoke } from "@/lib/tauri-invoke";
import { logDebug } from "@/lib/log";
import { LOCAL_AI_CHANGED } from "./local-ai-config";

/** Stable ids — persisted natively and used as the `api:<id>` engine id. */
export type ApiBrainId = "anthropic" | "openai" | "gemini" | "openrouter" | "custom";

export interface ApiBrainDef {
  id: ApiBrainId;
  label: string;
  /** Shown in Settings so a user knows what they're adding. */
  blurb: string;
  /** Where to create a key. Empty for the custom endpoint. */
  keyUrl: string;
  keyPlaceholder: string;
  /** A few model ids the provider accepts, for the model field's hint. */
  modelHint: string;
  /** True when the user must enter a base URL (OpenAI-compatible endpoint). */
  needsBaseUrl?: boolean;
}

/** The registry. Mirrors `PROVIDERS` in api_brain_command.rs. */
export const API_BRAINS: ApiBrainDef[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    blurb: "Claude models — excellent at long-form scripts and following structure.",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
    modelHint: "claude-opus-5-5 · claude-sonnet-5-5 · claude-haiku-4-5",
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT models from OpenAI.",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    modelHint: "Any chat model id from your OpenAI account",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    blurb: "Gemini models from Google AI Studio — has a free tier.",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    modelHint: "gemini-2.5-flash · gemini-2.5-pro",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key for hundreds of models from many providers.",
    keyUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
    modelHint: "openrouter/auto · provider/model-name",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    blurb: "Any OpenAI-compatible endpoint — Groq, Together, DeepSeek, LM Studio…",
    keyUrl: "",
    keyPlaceholder: "Your endpoint's API key",
    modelHint: "The model name your endpoint serves",
    needsBaseUrl: true,
  },
];

export function apiBrainDef(id: string): ApiBrainDef | undefined {
  return API_BRAINS.find((b) => b.id === id);
}

/** `api:openai` → `openai`. Returns null for any other engine id. */
export function parseApiEngine(engineId: string): ApiBrainId | null {
  if (!engineId.startsWith("api:")) return null;
  const id = engineId.slice(4);
  return API_BRAINS.some((b) => b.id === id) ? (id as ApiBrainId) : null;
}

export interface ApiBrainStatus {
  id: ApiBrainId;
  configured: boolean;
  /** "…a1b2" — never the key. */
  keyHint?: string | null;
  model: string;
  defaultModel: string;
  baseUrl?: string | null;
}

/** Every provider and whether a key is saved. `[]` outside the desktop app. */
export async function listApiBrains(): Promise<ApiBrainStatus[]> {
  if (!isTauri()) return [];
  try {
    return await safeInvoke<ApiBrainStatus[]>("api_brain_list");
  } catch (e) {
    logDebug("api-brain", "list failed", e);
    return [];
  }
}

/** Tell open pickers + Settings to re-read (same event Local AI settings use). */
function announceChange() {
  window.dispatchEvent(new CustomEvent(LOCAL_AI_CHANGED));
}

/** Save a key and/or model. An empty `key` keeps the saved one. */
export async function saveApiBrain(args: {
  id: ApiBrainId; key?: string; model?: string; baseUrl?: string;
}): Promise<ApiBrainStatus> {
  const res = await safeInvoke<ApiBrainStatus>("api_brain_save", {
    args: { id: args.id, key: args.key || null, model: args.model ?? null, baseUrl: args.baseUrl || null },
  });
  announceChange();
  return res;
}

export async function removeApiBrain(id: ApiBrainId): Promise<void> {
  await safeInvoke("api_brain_remove", { id });
  announceChange();
}

/** Round-trip a tiny prompt with the saved key; resolves with the reply. */
export async function testApiBrain(id: ApiBrainId): Promise<string> {
  return safeInvoke<string>("api_brain_test", { id }, { timeoutMs: 75000 });
}

export interface ApiBrainRunOpts {
  id: ApiBrainId;
  prompt: string;
  system?: string;
  timeoutSecs?: number;
}

/**
 * Run one brain turn on the user's API provider. Like a CLI brain the answer
 * arrives in one piece (no token streaming).
 */
export async function apiBrainGenerate(opts: ApiBrainRunOpts): Promise<string> {
  if (!isTauri()) {
    throw new Error(`API-key brains only run in the ${brand.name} desktop app.`);
  }
  return safeInvoke<string>(
    "api_brain_run",
    { args: { id: opts.id, system: opts.system || null, prompt: opts.prompt, timeoutSecs: opts.timeoutSecs ?? null } },
    // The native side owns the timeout (default 300 s).
    { timeoutMs: 0 },
  );
}
