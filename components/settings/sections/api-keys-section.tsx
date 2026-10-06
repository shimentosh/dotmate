"use client";
/**
 * Settings → **API Keys** — optional "bring your own key" cloud brains.
 *
 * DotMate stays local-first: nothing here is needed, and no `api:*` brain exists
 * until the user saves a key. Once saved, the provider shows up in every brain
 * picker (Script Writer, Script → Image Prompts) under "Your API keys (cloud)".
 *
 * Keys are write-only from this UI: the native side stores them and only ever
 * reports "configured" + the last 4 characters (see api_brain_command.rs).
 */
import { useCallback, useEffect, useState } from "react";
import {
  KeyRound, ChevronDown, CheckCircle2, Loader2, Play, Trash2, ExternalLink,
  ShieldCheck, Eye, EyeOff, Cloud, AlertCircle,
} from "lucide-react";
import { SettingsHeader } from "../settings-header";
import {
  API_BRAINS, listApiBrains, removeApiBrain, saveApiBrain, testApiBrain,
  type ApiBrainDef, type ApiBrainStatus,
} from "@/lib/brain/api-brain";
import { LOCAL_AI_CHANGED } from "@/lib/brain/local-ai-config";
import { humanizeError } from "@/lib/error/app-error";
import { openExternal } from "@/lib/open-external";
import { toastSuccess } from "@/lib/toast";
import { useClientValue } from "@/lib/use-client-value";
import { brand } from "@/brand.config";

const inputCls =
  "w-full h-9 px-3 rounded-lg text-[13px] outline-none bg-surface border border-zinc-200 dark:border-white/10 " +
  "text-zinc-900 dark:text-zinc-100 hover:border-zinc-300 dark:hover:border-white/15 focus:border-brand/60 " +
  "focus:ring-[3px] focus:ring-brand/12 transition-[border-color,box-shadow] font-[inherit]";

type Feedback = { kind: "ok" | "error" | "busy"; msg: string } | null;

function ProviderCard({ def, status, open, onToggle }: {
  def: ApiBrainDef;
  status?: ApiBrainStatus;
  open: boolean;
  onToggle: () => void;
}) {
  const configured = !!status?.configured;
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState(status?.model && status.model !== status.defaultModel ? status.model : "");
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? "");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function save() {
    setBusy("save"); setFeedback(null);
    try {
      await saveApiBrain({ id: def.id, key: key.trim(), model: model.trim(), baseUrl: baseUrl.trim() });
      setKey(""); setShowKey(false);
      // Saving is cheap to verify — test straight away so a bad key shows up now.
      setBusy("test");
      const reply = await testApiBrain(def.id);
      setFeedback({ kind: "ok", msg: `Saved and working · replied “${reply}”` });
      toastSuccess(`${def.label} is ready to use.`, "API key saved");
    } catch (e) {
      setFeedback({ kind: "error", msg: humanizeError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test"); setFeedback(null);
    try {
      const reply = await testApiBrain(def.id);
      setFeedback({ kind: "ok", msg: `Working · replied “${reply}”` });
    } catch (e) {
      setFeedback({ kind: "error", msg: humanizeError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove"); setFeedback(null);
    try {
      await removeApiBrain(def.id);
      setKey(""); setModel(""); setBaseUrl("");
      setFeedback({ kind: "ok", msg: "Key removed from this computer." });
    } catch (e) {
      setFeedback({ kind: "error", msg: humanizeError(e) });
    } finally {
      setBusy(null);
    }
  }

  const canSave = !busy && (configured || key.trim().length > 0) && (!def.needsBaseUrl || baseUrl.trim().length > 0);

  return (
    <div className={`rounded-xl border overflow-hidden bg-surface transition-colors ${
      configured ? "border-brand/30" : "border-zinc-200 dark:border-white/8"}`}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${
          configured ? "bg-brand-soft text-brand" : "bg-surface-muted text-zinc-400"}`}>
          <KeyRound size={15} strokeWidth={1.8} />
        </span>
        <button type="button" onClick={onToggle} aria-expanded={open}
          className="flex-1 min-w-0 text-left bg-transparent border-none p-0 cursor-pointer font-[inherit]">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">{def.label}</span>
            {configured ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
                <CheckCircle2 size={12} /> Connected
              </span>
            ) : (
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Not set</span>
            )}
          </span>
          <span className="block text-[12px] text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
            {configured
              ? <>{status?.model} <span className="text-zinc-300 dark:text-zinc-600">·</span> key <span className="font-mono">{status?.keyHint}</span></>
              : def.blurb}
          </span>
        </button>
        {configured && (
          <button type="button" onClick={test} disabled={!!busy}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium cursor-pointer border border-zinc-200 dark:border-white/10 bg-transparent text-zinc-700 dark:text-zinc-300 hover:border-brand/40 hover:text-brand transition-colors disabled:opacity-50">
            {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Test
          </button>
        )}
        <button type="button" onClick={onToggle} title={open ? "Close" : "Set up"} aria-label={open ? "Close" : "Set up"}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:bg-zinc-900/[0.05] dark:hover:bg-white/8 border-none bg-transparent cursor-pointer transition-colors">
          <ChevronDown size={14} className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {feedback && !open && (
        <p className={`px-4 pb-3 -mt-1 text-[12px] ${feedback.kind === "ok" ? "text-success" : "text-destructive"}`}>{feedback.msg}</p>
      )}

      {open && (
        <div className="px-4 pt-3.5 pb-4 border-t border-zinc-200/70 dark:border-white/[0.06] flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-zinc-600 dark:text-zinc-400">API key</span>
              {def.keyUrl && (
                <button type="button" onClick={() => void openExternal(def.keyUrl)}
                  className="inline-flex items-center gap-1 text-[12px] text-brand hover:underline bg-transparent border-none p-0 cursor-pointer font-[inherit]">
                  Get a key <ExternalLink size={11} />
                </button>
              )}
            </span>
            <span className="relative">
              <input
                type={showKey ? "text" : "password"}
                autoComplete="off" spellCheck={false}
                className={`${inputCls} pr-10 font-mono`}
                placeholder={configured ? `Saved (${status?.keyHint}) — paste a new key to replace it` : def.keyPlaceholder}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              {key && (
                <button type="button" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? "Hide key" : "Show key"}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 bg-transparent border-none cursor-pointer">
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              )}
            </span>
          </label>

          {def.needsBaseUrl && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-zinc-600 dark:text-zinc-400">Base URL</span>
              <input className={inputCls} placeholder="https://api.example.com/v1" spellCheck={false}
                value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              <span className="text-[11.5px] text-zinc-400 dark:text-zinc-500">The part before <span className="font-mono">/chat/completions</span>. Plain http is allowed only for localhost.</span>
            </label>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-zinc-600 dark:text-zinc-400">
              Model {!def.needsBaseUrl && <span className="text-zinc-400 font-normal">(optional)</span>}
            </span>
            <input className={`${inputCls} font-mono`} spellCheck={false}
              placeholder={status?.defaultModel ? `Default: ${status.defaultModel}` : def.needsBaseUrl ? "model-name" : "Leave blank for the default model"}
              value={model} onChange={(e) => setModel(e.target.value)} />
            <span className="text-[11.5px] text-zinc-400 dark:text-zinc-500">{def.modelHint}</span>
          </label>

          {feedback && (
            <p className={`flex items-start gap-1.5 text-[12px] leading-relaxed ${feedback.kind === "ok" ? "text-success" : "text-destructive"}`}>
              {feedback.kind === "ok" ? <CheckCircle2 size={13} className="shrink-0 mt-0.5" /> : <AlertCircle size={13} className="shrink-0 mt-0.5" />}
              {feedback.msg}
            </p>
          )}

          <div className="flex items-center gap-2 pt-0.5">
            <button type="button" onClick={save} disabled={!canSave}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-semibold text-white bg-brand-gradient border-none cursor-pointer hover:brightness-105 transition">
              {busy === "save" || busy === "test" ? <Loader2 size={13} className="animate-spin" /> : null}
              {busy === "test" ? "Testing…" : configured ? "Save changes" : "Save & test"}
            </button>
            {configured && (
              <button type="button" onClick={remove} disabled={!!busy}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium border border-zinc-200 dark:border-white/10 bg-transparent text-zinc-600 dark:text-zinc-300 hover:text-destructive hover:border-destructive/40 cursor-pointer transition-colors disabled:opacity-50">
                {busy === "remove" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                Remove key
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ApiKeysPage() {
  const isDesktop = useClientValue(() => "__TAURI_INTERNALS__" in window, false);
  const [statuses, setStatuses] = useState<Record<string, ApiBrainStatus>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  // Cards seed their fields from the saved status, so render them once it has loaded.
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    listApiBrains().then((rows) => {
      setStatuses(Object.fromEntries(rows.map((r) => [r.id, r])));
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(LOCAL_AI_CHANGED, load);
    return () => window.removeEventListener(LOCAL_AI_CHANGED, load);
  }, [load]);

  const connected = Object.values(statuses).filter((s) => s.configured).length;

  return (
    <div className="flex flex-col gap-6">
      <SettingsHeader
        title="API Keys"
        subtitle="Optional — use your own AI provider for scripts and prompts."
        action={connected > 0 ? (
          <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-md text-[12px] font-medium bg-brand-soft text-brand">
            <Cloud size={12} /> {connected} connected
          </span>
        ) : undefined}
      />

      <div className="flex items-start gap-3 rounded-xl border border-zinc-200 dark:border-white/8 bg-surface-muted/60 px-4 py-3.5">
        <ShieldCheck size={16} className="text-success shrink-0 mt-0.5" />
        <div className="text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
          <p className="font-medium text-zinc-800 dark:text-zinc-200">You don&apos;t need this — {brand.name} works fully offline.</p>
          <p className="mt-1">
            Add a key only if you want a cloud model in Script Writer and Script → Image Prompts.
            When you pick it, your topic and script go <span className="font-medium text-zinc-700 dark:text-zinc-300">straight from this computer to that provider</span>, billed to your account.
            Keys are stored only on this computer and are never shown again in the app.
          </p>
        </div>
      </div>

      {!isDesktop && (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl border border-zinc-200 dark:border-white/8 bg-surface">
          <AlertCircle size={14} className="text-zinc-400 shrink-0 mt-0.5" />
          <p className="text-[12.5px] text-zinc-500 dark:text-zinc-400">API keys work in the {brand.name} desktop app only.</p>
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {loaded && API_BRAINS.map((def) => (
          <ProviderCard
            key={def.id}
            def={def}
            status={statuses[def.id]}
            open={openId === def.id}
            onToggle={() => setOpenId((cur) => (cur === def.id ? null : def.id))}
          />
        ))}
      </div>
    </div>
  );
}
