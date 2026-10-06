/**
 * The ONE list of local brains, shared by every engine picker.
 *
 * A "brain" is a text/vision LLM the user brings. Three kinds:
 *   - `cli:<id>`            — the user's Claude Code / Codex / Gemini CLI (a process)
 *   - `local:<ollamaModel>` — a model served by Ollama on localhost (HTTP)
 *   - `api:<provider>`      — the user's own cloud provider via an API key they
 *                             saved in Settings → API Keys (opt-in; see api-brain.ts)
 *
 * Every surface uses `useLocalBrains()` + `runLocalBrain()`, so adding a brain
 * kind is one edit.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { logDebug } from "@/lib/log";
import {
  CLI_BRAINS, cliBrainDef, cliBrainGenerate, detectCliBrains, parseCliEngine,
  type CliBrainId,
} from "./cli-brain";
import { apiBrainDef, apiBrainGenerate, listApiBrains, parseApiEngine } from "./api-brain";
import {
  LOCAL_AI_CHANGED, cliPathOverrides, cliPrefs, loadLocalAIConfig, ollamaUrl,
  type LocalAIConfig,
} from "./local-ai-config";

/** One selectable local engine, in the shape the pickers already render. */
export interface LocalBrainOption {
  /** `cli:claude-code` or `local:llama3.2` */
  id: string;
  label: string;
  kind: "cli" | "ollama" | "api";
  /** True when this brain can take images. */
  vision: boolean;
  /** Version string / model tag, for a secondary line in the picker. */
  sub?: string;
}

/** Ollama tags that are embedding-only and can't chat. */
const NON_CHAT = /embed/i;

async function probeOllama(url: string): Promise<LocalBrainOption[]> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? [])
      .filter((m) => !NON_CHAT.test(m.name))
      .map((m) => ({
        id: `local:${m.name}`,
        label: m.name.replace(/:latest$/, ""),
        kind: "ollama" as const,
        // Ollama vision depends on the model; `vl`/`vision`/`llava` are the tells.
        vision: /vl|vision|llava|moondream/i.test(m.name),
        sub: "Ollama",
      }));
  } catch (e) {
    logDebug("local-brains", "Ollama not reachable", e);
    return [];
  }
}

async function probeCli(cfg: LocalAIConfig): Promise<LocalBrainOption[]> {
  const statuses = await detectCliBrains(cliPathOverrides(cfg));
  return statuses
    .filter((s) => s.found)
    .map((s) => {
      const def = cliBrainDef(s.id);
      const model = cliPrefs(s.id as CliBrainId, cfg).model?.trim();
      return {
        id: `cli:${s.id}`,
        label: def?.label ?? s.id,
        kind: "cli" as const,
        vision: true, // all three read images (codex natively, the others from disk)
        sub: model || s.version || undefined,
      };
    });
}

/** Providers with a saved API key (none on the web build). */
async function probeApi(): Promise<LocalBrainOption[]> {
  const statuses = await listApiBrains();
  return statuses
    .filter((s) => s.configured)
    .map((s) => ({
      id: `api:${s.id}`,
      label: apiBrainDef(s.id)?.label ?? s.id,
      kind: "api" as const,
      vision: false, // text-only for now: no caller sends images to an API brain
      sub: s.model,
    }));
}

/**
 * Discover every local brain available on this machine.
 *
 * Re-runs on mount and whenever Local AI settings change, so installing a CLI or
 * pulling an Ollama model shows up without a restart. Returns `[]` on the web
 * build (no Tauri → no CLI; Ollama probe simply fails).
 */
export function useLocalBrains(): {
  brains: LocalBrainOption[];
  loading: boolean;
  refresh: () => void;
  /** The user's configured default local brain, if it is currently available. */
  preferred: LocalBrainOption | null;
} {
  const [brains, setBrains] = useState<LocalBrainOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState<LocalAIConfig>(() => loadLocalAIConfig());
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const onChange = () => { setLoading(true); setCfg(loadLocalAIConfig()); setNonce((n) => n + 1); };
    window.addEventListener(LOCAL_AI_CHANGED, onChange);
    return () => window.removeEventListener(LOCAL_AI_CHANGED, onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Probe both kinds in parallel — the CLI probe spawns processes and is the
      // slow one, so serialising would make every picker wait on it.
      const [cli, ollama, api] = await Promise.all([
        probeCli(cfg).catch(() => [] as LocalBrainOption[]),
        probeOllama(ollamaUrl(cfg)).catch(() => [] as LocalBrainOption[]),
        probeApi().catch(() => [] as LocalBrainOption[]),
      ]);
      if (cancelled || !alive.current) return;
      // Local first (CLI, then Ollama); the user's API keys after them.
      setBrains([...cli, ...ollama, ...api]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [cfg, nonce]);

  const refresh = useCallback(() => { setLoading(true); setNonce((n) => n + 1); }, []);
  const preferred = brains.find((b) => b.id === cfg.brainDefault) ?? null;

  return { brains, loading, refresh, preferred };
}

/** True for any engine id this module can execute locally. */
export function isLocalBrainEngine(engineId: string): boolean {
  return engineId.startsWith("cli:") || engineId.startsWith("api:") || engineId === "local" || engineId.startsWith("local:");
}

export interface RunLocalBrainOpts {
  /** `cli:<id>` · `api:<provider>` · `local:<model>` · bare `local` (first Ollama model). */
  engineId: string;
  system?: string;
  prompt: string;
  /** Absolute paths of local images (vision). Ignored by non-vision Ollama models. */
  images?: string[];
  signal?: AbortSignal;
  /** Streaming is Ollama-only; CLI brains buffer and call this once at the end. */
  onChunk?: (text: string) => void;
}

/**
 * Run one turn on a brain — the single execution path for `cli:*`, `api:*` and
 * `local:*`, so every surface behaves identically.
 *
 * Note the asymmetry callers must handle: Ollama streams token-by-token, while a
 * CLI or API brain returns its whole answer at once. `onChunk`
 * therefore fires many times for Ollama and exactly once for a CLI.
 */
export async function runLocalBrain(opts: RunLocalBrainOpts): Promise<string> {
  const cfg = loadLocalAIConfig();

  const apiId = parseApiEngine(opts.engineId);
  if (apiId) {
    const text = await apiBrainGenerate({ id: apiId, system: opts.system, prompt: opts.prompt });
    opts.onChunk?.(text);
    return text;
  }

  const cliId = parseCliEngine(opts.engineId);

  if (cliId) {
    const prefs = cliPrefs(cliId, cfg);
    const text = await cliBrainGenerate({
      id: cliId,
      system: opts.system,
      prompt: opts.prompt,
      images: opts.images,
      model: prefs.model,
      path: prefs.path,
    });
    opts.onChunk?.(text);
    return text;
  }

  // ── Ollama (OpenAI-compatible streaming endpoint) ──
  const model = opts.engineId.startsWith("local:")
    ? opts.engineId.slice("local:".length)
    : undefined;
  const url = ollamaUrl(cfg);
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || undefined,
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        { role: "user", content: opts.prompt },
      ],
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`Ollama returned HTTP ${res.status}. Make sure Ollama is running.`);
  }

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const text = chunk.choices?.[0]?.delta?.content ?? "";
        if (text) { result += text; opts.onChunk?.(text); }
      } catch (e) {
        logDebug("local-brains", "Bad JSON chunk in Ollama stream", e);
      }
    }
  }
  return result;
}

/** Human label for an engine id, for buttons/toasts. */
export function localBrainLabel(engineId: string): string {
  const cli = parseCliEngine(engineId);
  if (cli) return cliBrainDef(cli)?.label ?? cli;
  const api = parseApiEngine(engineId);
  if (api) return apiBrainDef(api)?.label ?? api;
  if (engineId.startsWith("local:")) return engineId.slice("local:".length);
  if (engineId === "local") return "Local (Ollama)";
  return engineId;
}

export { CLI_BRAINS };
