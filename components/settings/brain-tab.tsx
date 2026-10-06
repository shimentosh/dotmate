"use client";
/**
 * Settings → Local AI → **Brain**.
 *
 * The brain is the text (+ vision) model behind Script Writer and Script → Image
 * Prompts. Two local sources can serve it:
 *
 *   1. **CLI brains** — Claude Code / Codex / Gemini already installed on this
 *      machine, driven as a local process (runs on the user's own CLI sign-in).
 *   2. **Ollama models** — rendered by the parent section, below this panel.
 *   3. **API brains** — providers the user saved a key for in Settings → API Keys
 *      (opt-in, cloud). Only offered here as a default choice.
 *
 * This panel only chooses a *default*; every engine picker still offers every
 * detected brain, so a user can switch per task. With no default set, pickers
 * use the first brain detected.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Brain, CheckCircle2, Loader2, RefreshCw, Terminal,
  ExternalLink, AlertCircle, Play, ChevronDown,
} from "lucide-react";
import { openExternal } from "@/lib/open-external";
import {
  CLI_BRAINS, cliBrainGenerate, detectCliBrains,
  type CliBrainId, type CliBrainStatus,
} from "@/lib/brain/cli-brain";
import {
  LOCAL_AI_CHANGED, cliPathOverrides, type LocalAIConfig,
} from "@/lib/brain/local-ai-config";
import { apiBrainDef, listApiBrains, type ApiBrainStatus } from "@/lib/brain/api-brain";
import { humanizeError } from "@/lib/error/app-error";
import { logDebug } from "@/lib/log";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const inputCls =
  "w-full h-8 px-2.5 rounded-lg text-[12px] bg-white dark:bg-white/[0.04] border border-zinc-200 " +
  "dark:border-white/10 text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400 outline-none " +
  "focus:border-violet-400/60 transition-colors font-[inherit]";

type TestState = { status: "idle" | "running" | "ok" | "fail"; ms?: number; msg?: string };

export function BrainTab({
  cfg,
  setCfg,
  /** Ollama brains available right now, so the default picker can offer them. */
  ollamaModels,
}: {
  cfg: LocalAIConfig;
  setCfg: (fn: (c: LocalAIConfig) => LocalAIConfig) => void;
  ollamaModels: string[];
}) {
  const [statuses, setStatuses] = useState<Record<string, CliBrainStatus>>({});
  const [detecting, setDetecting] = useState(true);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const detect = useCallback(async () => {
    setDetecting(true);
    try {
      const rows = await detectCliBrains(cliPathOverrides(cfg));
      setStatuses(Object.fromEntries(rows.map((r) => [r.id, r])));
    } catch (e) {
      logDebug("brain-tab", "detect failed", e);
    } finally {
      setDetecting(false);
    }
    // Re-detect when a path override changes, not on every cfg keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(cliPathOverrides(cfg))]);

  useEffect(() => { detect(); }, [detect]);

  // Providers with a saved API key — re-read whenever keys change.
  const [apiBrains, setApiBrains] = useState<ApiBrainStatus[]>([]);
  useEffect(() => {
    const load = () => { listApiBrains().then((rows) => setApiBrains(rows.filter((r) => r.configured))); };
    load();
    window.addEventListener(LOCAL_AI_CHANGED, load);
    return () => window.removeEventListener(LOCAL_AI_CHANGED, load);
  }, []);

  /** A real round-trip, so "detected" can't be confused with "signed in and working". */
  async function runTest(id: CliBrainId) {
    setTests((t) => ({ ...t, [id]: { status: "running" } }));
    const t0 = performance.now();
    try {
      const prefs = cfg.cliBrains?.[id] ?? {};
      const out = await cliBrainGenerate({
        id,
        system: "You are a terse assistant. Answer with a single word.",
        prompt: 'Reply with exactly: OK',
        model: prefs.model,
        path: prefs.path,
        timeoutSecs: 120,
      });
      const ms = Math.round(performance.now() - t0);
      const ok = /\bok\b/i.test(out);
      setTests((t) => ({
        ...t,
        [id]: ok
          ? { status: "ok", ms }
          : { status: "ok", ms, msg: `Responded: ${out.slice(0, 60)}` },
      }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { status: "fail", msg: humanizeError(e) } }));
    }
  }

  function setPrefs(id: CliBrainId, patch: { path?: string; model?: string }) {
    setCfg((c) => ({
      ...c,
      cliBrains: { ...(c.cliBrains ?? {}), [id]: { ...(c.cliBrains?.[id] ?? {}), ...patch } },
    }));
  }

  const available = [
    ...CLI_BRAINS.filter((b) => statuses[b.id]?.found).map((b) => ({
      id: `cli:${b.id}`,
      label: b.label,
      sub: statuses[b.id]?.version ?? "CLI",
    })),
    ...ollamaModels.map((m) => ({
      id: `local:${m}`,
      label: m.replace(/:latest$/, ""),
      sub: "Ollama",
    })),
    ...apiBrains.map((a) => ({
      id: `api:${a.id}`,
      label: apiBrainDef(a.id)?.label ?? a.id,
      sub: `${a.model} · API key`,
    })),
  ];

  const defaultId = cfg.brainDefault ?? "";
  const defaultStillAvailable = !defaultId || available.some((a) => a.id === defaultId);

  return (
    <div className="flex flex-col gap-5">
      {/* ── Default brain ───────────────────────────────────────────────── */}
      <div className="rounded-xl border border-zinc-200 dark:border-white/8 bg-white dark:bg-white/[0.02] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-zinc-100 dark:border-white/6 flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">Default brain</p>
          <button onClick={detect} title="Re-detect"
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-zinc-100 dark:hover:bg-white/6 text-zinc-400 border-none bg-transparent cursor-pointer transition">
            {detecting ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} strokeWidth={1.8} />}
          </button>
        </div>
        <div className="px-4 py-3.5 flex flex-col gap-2">
          <div className="relative">
            <select
              value={defaultStillAvailable ? defaultId : ""}
              onChange={(e) => setCfg((c) => ({ ...c, brainDefault: e.target.value || undefined }))}
              className={`${inputCls} appearance-none pr-8 cursor-pointer`}
            >
              <option value="">Automatic — first brain detected</option>
              {available.map((a) => (
                <option key={a.id} value={a.id}>{a.label} · {a.sub}</option>
              ))}
            </select>
            <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
            Pre-selects this brain in Script Writer and Script → Image Prompts. You can
            still switch per task. {available.length === 0 && !detecting
              ? "No brain is detected yet — install Ollama (and pull a model) or one of the CLIs below."
              : null}
          </p>
          {!defaultStillAvailable && (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertCircle size={11} className="shrink-0" />
              Your saved default isn&apos;t available right now — the first detected brain is used instead.
            </p>
          )}
        </div>
      </div>

      {/* ── CLI brains ──────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2.5 mb-3">
          <Terminal size={13} className="text-violet-500" />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] shrink-0 text-violet-500">
            AI CLI on your machine
          </h2>
          <span className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-600 tabular-nums shrink-0">
            {CLI_BRAINS.filter((b) => statuses[b.id]?.found).length}/{CLI_BRAINS.length}
          </span>
          <div className="flex-1 h-px bg-zinc-100 dark:bg-white/6" />
        </div>

        {!isTauri && (
          <div className="flex items-start gap-3 px-4 py-3.5 mb-2.5 rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/[0.02]">
            <AlertCircle size={13} className="text-zinc-400 shrink-0 mt-0.5" />
            <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
              CLI brains run as a local process, so they&apos;re available in the desktop app only.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {CLI_BRAINS.map((b) => {
            const st = statuses[b.id];
            const found = !!st?.found;
            const prefs = cfg.cliBrains?.[b.id] ?? {};
            const test = tests[b.id] ?? { status: "idle" as const };
            const open = !!expanded[b.id];
            return (
              <div key={b.id}
                className={`rounded-xl border overflow-hidden transition-colors ${
                  found
                    ? "border-zinc-200 dark:border-white/10 bg-white dark:bg-white/[0.02]"
                    : "border-zinc-150 dark:border-white/6 bg-zinc-50/60 dark:bg-white/[0.01]"
                }`}>
                <div className="flex items-start gap-3 px-4 py-3.5">
                  <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0"
                    style={{ background: found ? "#0057FC15" : "#71717a12", color: found ? "#0057FC" : "#71717a" }}>
                    <Brain size={15} strokeWidth={1.8} />
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-[13.5px] font-semibold text-zinc-800 dark:text-zinc-100">{b.label}</h3>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-white/6 text-zinc-500">
                        {b.bin}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-full bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 leading-none">
                        vision + text
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 leading-none">
                        local
                      </span>
                    </div>
                    <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">{b.blurb}</p>

                    {found ? (
                      <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400 mt-1.5">
                        <CheckCircle2 size={11} className="shrink-0" />
                        Detected{st?.version ? ` · ${st.version}` : ""}
                      </p>
                    ) : (
                      <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1.5">
                        {isTauri ? (st?.error ?? "Not found on PATH.") : "Desktop app only."}
                        {" "}
                        <button type="button" onClick={() => void openExternal(b.installUrl)}
                          className="inline-flex items-center gap-0.5 text-violet-500 hover:underline bg-transparent border-none p-0 cursor-pointer font-[inherit] text-[11px]">
                          Install <ExternalLink size={9} />
                        </button>
                      </p>
                    )}

                    {test.status !== "idle" && (
                      <p className={`text-[11px] mt-1.5 ${
                        test.status === "ok" ? "text-emerald-600 dark:text-emerald-400"
                        : test.status === "fail" ? "text-red-500"
                        : "text-zinc-400"}`}>
                        {test.status === "running" ? "Testing…"
                          : test.status === "ok" ? `Working${test.ms ? ` · ${(test.ms / 1000).toFixed(1)}s` : ""}${test.msg ? ` · ${test.msg}` : ""}`
                          : test.msg}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {found && (
                      <button onClick={() => runTest(b.id)} disabled={test.status === "running"}
                        className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold cursor-pointer border border-zinc-200 dark:border-white/10 bg-transparent text-zinc-700 dark:text-zinc-300 hover:border-violet-300 dark:hover:border-violet-500/40 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {test.status === "running" ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                        Test
                      </button>
                    )}
                    <button onClick={() => setExpanded((s) => ({ ...s, [b.id]: !open }))}
                      title="Options"
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/6 border-none bg-transparent cursor-pointer transition">
                      <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="px-4 pb-4 pt-1 border-t border-zinc-100 dark:border-white/6 grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[10.5px] font-semibold text-zinc-500 dark:text-zinc-400">Model (optional)</span>
                      <input className={inputCls} placeholder={b.modelHint}
                        value={prefs.model ?? ""}
                        onChange={(e) => setPrefs(b.id, { model: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[10.5px] font-semibold text-zinc-500 dark:text-zinc-400">Binary path (optional)</span>
                      <input className={inputCls} placeholder={`Auto — found via PATH`}
                        value={prefs.path ?? ""}
                        onChange={(e) => setPrefs(b.id, { path: e.target.value })} />
                    </label>
                    <p className="sm:col-span-2 text-[10.5px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
                      Leave both blank to use the CLI&apos;s own defaults. Set a path only when the
                      CLI isn&apos;t on your PATH. Every call runs in the CLI&apos;s read-only mode,
                      so a brain can never edit your files.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
