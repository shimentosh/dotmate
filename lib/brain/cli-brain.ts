/**
 * CLI brains — the user's own Claude Code / Codex / Gemini CLI used as a LOCAL
 * LLM (text + vision).
 *
 * One of the two kinds of "brain" in the app:
 *   - **Ollama** (`local:<model>`) — an HTTP server on localhost, called from the webview.
 *   - **CLI brain** (`cli:<id>`) — a local *process*, called through Tauri. ← this file
 *
 * Both run on the user's machine (a CLI uses the user's own CLI sign-in).
 *
 * Desktop-only by construction: a CLI is a process, so outside the Tauri shell
 * `detectCliBrains()` returns an empty list and no CLI option is ever offered.
 */
import { brand } from "@/brand.config";

import { isTauri } from "@tauri-apps/api/core";
import { safeInvoke } from "@/lib/tauri-invoke";
import { logDebug } from "@/lib/log";

/** Stable ids — persisted in settings and used as the `cli:<id>` engine id. */
export type CliBrainId = "claude-code" | "codex" | "gemini";

export interface CliBrainDef {
  id: CliBrainId;
  label: string;
  /** The binary users look for when the auto-probe misses. */
  bin: string;
  /** Shown in Settings so a user knows what they're enabling. */
  blurb: string;
  installUrl: string;
  /** Model ids the CLI accepts for `--model`, for the optional override field. */
  modelHint: string;
}

/** The registry. Adding a provider = one entry here + a `build_args` arm in Rust. */
export const CLI_BRAINS: CliBrainDef[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    blurb: "Anthropic's coding CLI. Strong at long-form writing and structured JSON. Reads images from disk.",
    installUrl: "https://claude.com/claude-code",
    modelHint: "opus · sonnet · haiku",
  },
  {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    blurb: "OpenAI's coding CLI. The only one with native image attachment, so vision is most reliable here.",
    installUrl: "https://developers.openai.com/codex/cli",
    modelHint: "gpt-5 · o3",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    blurb: "Google's CLI. Large context window — good for planning against a long transcript.",
    installUrl: "https://github.com/google-gemini/gemini-cli",
    modelHint: "gemini-2.5-pro · gemini-2.5-flash",
  },
];

export function cliBrainDef(id: string): CliBrainDef | undefined {
  return CLI_BRAINS.find((b) => b.id === id);
}

/** `cli:claude-code` → `claude-code`. Returns null for any other engine id. */
export function parseCliEngine(engineId: string): CliBrainId | null {
  if (!engineId.startsWith("cli:")) return null;
  const id = engineId.slice(4);
  return CLI_BRAINS.some((b) => b.id === id) ? (id as CliBrainId) : null;
}

export function isCliEngine(engineId: string): boolean {
  return parseCliEngine(engineId) !== null;
}

export interface CliBrainStatus {
  id: CliBrainId;
  found: boolean;
  path?: string | null;
  version?: string | null;
  error?: string | null;
}

/**
 * Probe every known CLI. Desktop-only; the web build gets `[]` so no CLI option
 * is ever rendered. Spawns up to three short-lived `--version` processes, so
 * call it on mount / refresh, not per keystroke.
 */
export async function detectCliBrains(
  paths?: Record<string, string>,
): Promise<CliBrainStatus[]> {
  if (!isTauri()) return [];
  try {
    return await safeInvoke<CliBrainStatus[]>(
      "cli_brain_detect",
      { paths: paths && Object.keys(paths).length ? paths : null },
      // Three child processes at up to 20s each — the generic UI guard is too tight.
      { timeoutMs: 0 },
    );
  } catch (e) {
    logDebug("cli-brain", "detect failed", e);
    return [];
  }
}

export interface CliBrainRunOpts {
  id: CliBrainId;
  prompt: string;
  system?: string;
  /** Absolute paths of local images to use as visual context. */
  images?: string[];
  /** Provider-native model id; omit to use the CLI's own default. */
  model?: string;
  /** Binary path override from Settings. */
  path?: string;
  timeoutSecs?: number;
}

/**
 * Run one brain turn. Resolves with the CLI's text output.
 *
 * There is no token streaming: these CLIs buffer their answer, so the UI should
 * show an indeterminate "thinking" state rather than a typewriter. Long calls are
 * expected — the Rust side hard-kills at `timeoutSecs` (default 300).
 */
export async function cliBrainGenerate(opts: CliBrainRunOpts): Promise<string> {
  if (!isTauri()) {
    throw new Error(`Local CLI brains only run in the ${brand.name} desktop app.`);
  }
  const res = await safeInvoke<{ text: string; stderr: string }>(
    "cli_brain_run",
    {
      args: {
        id: opts.id,
        path: opts.path || null,
        model: opts.model || null,
        system: opts.system || null,
        prompt: opts.prompt,
        images: opts.images?.length ? opts.images : null,
        timeoutSecs: opts.timeoutSecs ?? null,
      },
    },
    { timeoutMs: 0 }, // the Rust side owns the timeout
  );
  const text = (res?.text ?? "").trim();
  if (!text) {
    throw new Error(
      `${cliBrainDef(opts.id)?.label ?? opts.id} returned an empty response. ` +
        `Check that the CLI is signed in (run \`${cliBrainDef(opts.id)?.bin ?? opts.id}\` once in a terminal).`,
    );
  }
  return text;
}

/**
 * Extract the first JSON value from a CLI answer.
 *
 * Agentic CLIs like to wrap output in prose or a ```json fence even when told not
 * to, so every structured caller must go through this rather than `JSON.parse`
 * on the raw text. Scans for the first balanced {...} / [...] while ignoring
 * braces inside strings.
 */
export function extractJson<T = unknown>(raw: string): T {
  const text = raw.trim();
  // Strip a fenced block first — the common case.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : text;

  const start = body.search(/[{[]/);
  if (start === -1) throw new Error("The AI did not return JSON.");

  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        const slice = body.slice(start, i + 1);
        try {
          return JSON.parse(slice) as T;
        } catch {
          throw new Error("The AI returned malformed JSON.");
        }
      }
    }
  }
  throw new Error("The AI returned an incomplete JSON response.");
}
