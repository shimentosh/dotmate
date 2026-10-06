"use client";
import { Fragment, useState, useEffect, useRef, useMemo } from "react";
import { useGuardedRouter } from "@/hooks/use-guarded-router";
import { useRegisterTask } from "@/hooks/use-register-task";
import {
  Mic, Sparkles, Play, Pause, Loader2, Download, RotateCcw,
  Headphones, Zap, Crown, Check, ChevronDown, Wifi, WifiOff,
  AlertCircle, FileText, Gauge, Settings2, Upload,
  Layers, Plus, X, CheckCircle2, Search,
} from "lucide-react";
import { openSettings } from "@/lib/open-settings";
import { MiniPlayer } from "@/components/tools/audio-mini-player";
import { localTtsGenerate, isLocalTtsModel, type LocalTtsModel } from "@/lib/tts/local-tts";
import { useVoiceDemos, voiceDemoUrl } from "@/lib/tts/voice-demos";
import { useInstalledLocalTts } from "@/lib/tts/use-installed-local-tts";
import { usePreference } from "@/lib/use-preference";
import { loadLocalAIConfig } from "@/lib/brain/local-ai-config";
import { TTS_PREFILL_KEY } from "@/lib/handoff";
import { storageKey } from "@/brand.config";
import { createPortal } from "react-dom";
import AppLayout from "@/components/layout/app-layout";
import { logDebug, logWarn, logError } from "@/lib/log";
import { humanizeError } from "@/lib/error/app-error";
import { surfaceError, toastSuccess } from "@/lib/toast";
import { saveBlobToDisk, saveBlobsToFolder } from "@/lib/save-file";

/* ── Types ───────────────────────────────────────────────────────────── */
/** Only on-device engines — every voice synthesizes locally, offline and free. */
type Provider   = LocalTtsModel;
type Status     = "ready" | "checking" | "offline";
type ItemStatus = "idle" | "generating" | "done" | "error";

interface ScriptItem {
  id:        string;
  name:      string;
  text:      string;
  status:    ItemStatus;
  audioUrl:  string | null;
  audioBlob: Blob | null;
  error:     string | null;
}

function uid() { return Math.random().toString(36).slice(2, 10); }
function blankScript(n: number): ScriptItem {
  return { id: uid(), name: `Script ${n}`, text: "", status: "idle", audioUrl: null, audioBlob: null, error: null };
}

interface ModelDef {
  id:        Provider;
  label:     string;
  sub:       string;
  icon:      typeof Zap;
  desc:      string;
}

const MODELS: ModelDef[] = [
  { id: "supertonic", label: "Supertonic", sub: "On-device", icon: Crown, desc: "Studio-grade 44.1 kHz neural voices — runs on your machine, free. Downloads once (offered when this build includes a download source)." },
  { id: "kokoro",     label: "Kokoro",     sub: "On-device", icon: Zap,   desc: "Multi-language neural voices — runs on your machine, free. Downloads once, on first use or from Settings → Local AI." },
];

type Gender = "Female" | "Male";
interface Voice { id: string; name: string; gender: Gender; accent: string; avatar?: string }

const VOICES: Record<Provider, Voice[]> = {
  // Kokoro-82M speaker ids (multi-lang v1.0): the `id` is the speaker index the
  // native engine selects. Display names + avatars are reused from the prior set.
  kokoro: [
    { id: "11", name: "Daniel",  gender: "Male",   accent: "American", avatar: "/voice-avatars/daniel.png" },
    { id: "16", name: "Marcus",  gender: "Male",   accent: "American", avatar: "/voice-avatars/marcus.png" },
    { id: "18", name: "Oliver",  gender: "Male",   accent: "American", avatar: "/voice-avatars/oliver.png" },
    { id: "13", name: "Leo",     gender: "Male",   accent: "American", avatar: "/voice-avatars/leo.png" },
    { id: "12", name: "Ethan",   gender: "Male",   accent: "American", avatar: "/voice-avatars/ethan.png" },
    { id: "3",  name: "Emma",    gender: "Female", accent: "American", avatar: "/voice-avatars/emma.png" },
    { id: "2",  name: "Sophia",  gender: "Female", accent: "American", avatar: "/voice-avatars/sophia.png" },
    { id: "6",  name: "Ava",     gender: "Female", accent: "American", avatar: "/voice-avatars/ava.png" },
    { id: "9",  name: "Mia",     gender: "Female", accent: "American", avatar: "/voice-avatars/mia.png" },
    { id: "10", name: "Isla",    gender: "Female", accent: "American", avatar: "/voice-avatars/isla.png" },
  ],
  // Supertonic 3 preset voice styles (`voice_styles/<id>.json`). The id is the
  // style file name; M1–M5 / F1–F5 are the presets shipped by the model.
  supertonic: [
    { id: "M1", name: "Theo",   gender: "Male",   accent: "American" },
    { id: "M2", name: "Caleb",  gender: "Male",   accent: "American" },
    { id: "M3", name: "Felix",  gender: "Male",   accent: "American" },
    { id: "M4", name: "Hugo",   gender: "Male",   accent: "American" },
    { id: "M5", name: "Ryan",   gender: "Male",   accent: "American" },
    { id: "F1", name: "Aria",   gender: "Female", accent: "American" },
    { id: "F2", name: "Nora",   gender: "Female", accent: "American" },
    { id: "F3", name: "Lily",   gender: "Female", accent: "American" },
    { id: "F4", name: "Chloe",  gender: "Female", accent: "American" },
    { id: "F5", name: "Zoe",    gender: "Female", accent: "American" },
  ],
};

const PREVIEW_TEXT = "Hello! This is a quick voice preview — I sound just like this when I read your script.";

/** Remembers that the user dismissed the tip card (per machine). */
const TIP_DISMISSED_KEY = storageKey("tts-tip-dismissed");

/* ── Helpers ─────────────────────────────────────────────────────────── */
function estimateDuration(text: string, speed: number): number {
  // average reading speed: ~150 words per minute → ~2.5 wps
  const words = text.trim().split(/\s+/).length;
  return Math.round((words / 2.5) / speed);
}

function fmtDur(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Short, readable label from a script (used for the download file name). */
function deriveName(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "Voiceover";
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}

// On-device TTS generators (Kokoro / Supertonic) live in @/lib/tts/local-tts,
// shared with Bulk Voice (imported above as localTtsGenerate).

/* ── Bulk: script card ───────────────────────────────────────────────── */
function ScriptCard({ item, index, onUpdate, onRemove, disabled, onGenerateScript }: {
  item: ScriptItem; index: number;
  onUpdate: (id: string, p: Partial<ScriptItem>) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
  onGenerateScript: () => void;   // opens the Script Writer tool
}) {
  const STATUS_CFG: Record<ItemStatus, { label: string; color: string; bg: string }> = {
    idle:       { label: "Ready",       color: "#71717a", bg: "rgba(113,113,122,0.1)" },
    generating: { label: "Generating…", color: "#0057FC", bg: "rgba(0,87,252,0.1)"  },
    done:       { label: "Done",        color: "#10b981", bg: "rgba(16,185,129,0.1)"   },
    error:      { label: "Error",       color: "#ef4444", bg: "rgba(239,68,68,0.1)"    },
  };
  const cfg = STATUS_CFG[item.status];

  return (
    <div className={`rounded-2xl border bg-white dark:bg-zinc-900/60 overflow-hidden transition-all ${
      item.status === "done"      ? "border-emerald-200 dark:border-emerald-500/25"
      : item.status === "error"   ? "border-red-200 dark:border-red-500/25"
      : item.status === "generating" ? "border-violet-300 dark:border-violet-500/40"
      : "border-zinc-200 dark:border-white/8"
    }`}>
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-zinc-100 dark:border-white/6">
        <div className="w-6 h-6 rounded-lg shrink-0 flex items-center justify-center text-[10px] font-bold"
          style={{ background: cfg.bg, color: cfg.color }}>{index + 1}</div>
        <input value={item.name} onChange={e => onUpdate(item.id, { name: e.target.value })}
          disabled={disabled} placeholder={`Script ${index + 1}`}
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] font-semibold text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 font-[inherit]" />
        <button onClick={onGenerateScript} disabled={disabled} title="Generate a script with AI"
          className="shrink-0 flex items-center gap-1 h-6 px-2 rounded-md text-[10px] font-semibold text-violet-600 dark:text-violet-400 bg-violet-500/10 border border-violet-200 dark:border-violet-500/25 hover:bg-violet-500/15 cursor-pointer font-[inherit] transition-all disabled:opacity-40">
          <Sparkles size={11} /> Generate
        </button>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full"
          style={{ background: cfg.bg, color: cfg.color }}>
          {item.status === "generating"
            ? <span className="flex items-center gap-1"><Loader2 size={8} className="animate-spin inline" /> {cfg.label}</span>
            : cfg.label}
        </span>
        <button onClick={() => onRemove(item.id)} disabled={disabled}
          className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 cursor-pointer border-none bg-transparent text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition disabled:opacity-40">
          <X size={12} />
        </button>
      </div>
      <div className="px-4 pt-3 pb-3">
        <textarea value={item.text} onChange={e => onUpdate(item.id, { text: e.target.value })}
          disabled={disabled} placeholder="Paste your script here…" rows={3}
          className="w-full bg-transparent border-none outline-none resize-none text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 font-[inherit] disabled:opacity-60" />
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[10px] text-zinc-400 tabular-nums">
            {item.text.trim() ? item.text.trim().split(/\s+/).length : 0} words
          </span>
          {item.text.trim() && !disabled && (
            <button onClick={() => onUpdate(item.id, { text: "" })}
              className="text-[10px] text-zinc-400 hover:text-red-400 transition bg-transparent border-none cursor-pointer font-[inherit]">Clear</button>
          )}
        </div>
      </div>
      {item.status === "error" && item.error && (
        <div className="mx-4 mb-3 flex items-start gap-2 px-3 py-2 rounded-lg border border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/8">
          <AlertCircle size={11} className="text-red-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-red-600 dark:text-red-400 leading-snug">{item.error}</p>
        </div>
      )}
      {item.status === "done" && item.audioUrl && item.audioBlob && (
        <div className="px-4 pb-3">
          <MiniPlayer url={item.audioUrl} blob={item.audioBlob} name={item.name || `script-${index + 1}`} />
        </div>
      )}
    </div>
  );
}

/* ── Dropdown ────────────────────────────────────────────────────────── */
function ModelDropdown({
  value, onChange, statuses, models,
}: {
  value: Provider;
  onChange: (id: Provider) => void;
  statuses: Record<Provider, Status>;
  models: ModelDef[];
}) {
  const [open, setOpen]   = useState(false);
  const [rect, setRect]   = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropRef    = useRef<HTMLDivElement>(null);

  // A stale/invalid persisted `value` matches nothing; fall back so `selected`
  // (and selected.icon below) is never undefined.
  const selected  = models.find(m => m.id === value) ?? MODELS.find(m => m.id === value) ?? models[0] ?? MODELS[0];
  const Icon      = selected.icon;

  function openDrop() {
    if (!triggerRef.current) return;
    setRect(triggerRef.current.getBoundingClientRect());
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onMouse(e: MouseEvent) {
      if (!triggerRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onMouse);
    return () => document.removeEventListener("mousedown", onMouse);
  }, [open]);

  function statusLabel(s: Status) {
    if (s === "ready")     return { label: "Ready",       color: "#10b981" };
    if (s === "checking")  return { label: "Checking…",   color: "#0057FC" };
    return                        { label: "Offline",     color: "#71717a" };
  }

  const dropdown = open && rect ? createPortal(
    <div
      ref={dropRef}
      style={{ position: "fixed", top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 340), zIndex: 99999 }}
      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-xl shadow-2xl overflow-hidden"
    >
      {models.length === 0 && (
        <div className="px-3.5 py-3 flex items-center gap-2">
          <p className="flex-1 min-w-0 text-[11.5px] text-zinc-500 dark:text-zinc-400">No on-device voices installed yet.</p>
          <button onClick={() => { setOpen(false); openSettings("local-ai"); }}
            className="shrink-0 text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:underline cursor-pointer border-none bg-transparent font-[inherit]">
            Local AI →
          </button>
        </div>
      )}
      {models.map((m, i) => {
        const active   = value === m.id;
        const MIcon    = m.icon;
        const status   = statuses[m.id];
        const sStyle   = statusLabel(status);
        const showHeader = i === 0;
        return (
          <Fragment key={m.id}>
            {showHeader && (
              <div className="px-3.5 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-600">
                Local AI
              </div>
            )}
            <button
              onClick={() => { onChange(m.id); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 border-none cursor-pointer font-[inherit] text-left transition-colors ${
                active ? "bg-violet-500/6" : "bg-transparent hover:bg-zinc-50 dark:hover:bg-white/5"
              }`}
            >
              <div className={`flex items-center justify-center w-7 h-7 rounded-lg shrink-0 ${active ? "bg-violet-500" : "bg-zinc-100 dark:bg-white/8"}`}>
                <MIcon size={13} className={active ? "text-white" : "text-zinc-400"} />
              </div>
              <div className="flex-1 min-w-0">
                <span className={`text-[13px] font-semibold ${active ? "text-violet-500" : "text-zinc-800 dark:text-zinc-100"}`}>{m.label}</span>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{m.desc}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: sStyle.color }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: sStyle.color }} /> {sStyle.label}
                </span>
                {active && <Check size={12} className="text-violet-500 ml-0.5" />}
              </div>
            </button>
          </Fragment>
        );
      })}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={openDrop}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-white dark:bg-white/6 border border-zinc-200 dark:border-white/10 cursor-pointer font-[inherit] text-[13px] font-medium text-zinc-700 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-colors"
      >
        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-violet-500 shrink-0">
          <Icon size={12} className="text-white" />
        </div>
        <div className="flex-1 text-left min-w-0">
          <span className="block text-[13px] font-semibold text-zinc-800 dark:text-zinc-100 truncate">{selected.label}</span>
          <span className="block text-[10px] font-medium text-zinc-400 truncate">{selected.sub}</span>
        </div>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{
          background: statuses[selected.id] === "ready" ? "#10b981"
                    : statuses[selected.id] === "checking" ? "#0057FC"
                    : "#71717a",
        }} />
        <ChevronDown size={13} className="text-zinc-400 shrink-0" />
      </button>
      {dropdown}
    </>
  );
}

/* ── Range Slider (mini) ─────────────────────────────────────────────── */
function Slider({ value, onChange, min, max, step = 1 }: {
  value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="relative w-full h-5 flex items-center">
      <div className="absolute left-0 right-0 h-1 rounded-full bg-zinc-200 dark:bg-white/10" />
      <div className="absolute left-0 h-1 rounded-full bg-brand-gradient" style={{ width: `${pct}%` }} />
      <div className="absolute w-3.5 h-3.5 rounded-full bg-white border-2 border-violet-500 shadow-sm" style={{ left: `calc(${pct}% - 7px)` }} />
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="absolute inset-0 opacity-0 cursor-pointer"
      />
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */
export default function TextToSpeechPage() {
  const [model,    setModel]    = usePreference<Provider>("tts.provider", "kokoro");
  const [voiceId,  setVoiceId]  = useState<string>(VOICES.kokoro[0].id);
  const [script,   setScript]   = useState("");
  const [speed,    setSpeed]    = useState(100);

  const [generating, setGenerating] = useState(false);
  const [audioUrl,   setAudioUrl]   = useState<string | null>(null);
  const [audioBlob,  setAudioBlob]  = useState<Blob | null>(null);
  const [error,      setError]      = useState("");
  const [playing,    setPlaying]    = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [curTime,    setCurTime]    = useState(0);   // seconds into the generated clip
  const [audioDur,   setAudioDur]   = useState(0);   // generated clip length (0 = unknown yet)
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Voice filter + preview state
  const [genderFilter,      setGenderFilter]      = useState<"All" | Gender>("All");
  const [accentFilter,      setAccentFilter]      = useState<string>("All");
  const [voiceQuery,        setVoiceQuery]        = useState("");
  const [sampleCache,       setSampleCache]       = useState<Map<string, string>>(new Map());
  const [previewingVoice,   setPreviewingVoice]   = useState<string | null>(null);
  const [loadingSample,     setLoadingSample]     = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceDemos = useVoiceDemos();   // bundled preview clips (instant, offline, free)

  /* ── Mode toggle ──────────────────────────────────────────────────── */
  const [mode, setMode] = useState<"single" | "bulk">("single");

  /* ── Dismissible tip (persisted) ──────────────────────────────────── */
  const [tipDismissed, setTipDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem(TIP_DISMISSED_KEY) === "1"; } catch (e) { logDebug("text-to-voice", "localStorage read failed (private mode?)", e); return false; }
  });
  function dismissTip() {
    setTipDismissed(true);
    try { localStorage.setItem(TIP_DISMISSED_KEY, "1"); } catch (e) { logDebug("text-to-voice", "localStorage write failed (private mode?)", e); }
  }

  /* ── "Generate Script" → the Script Writer tool ───────────────────── */
  const router = useGuardedRouter();
  const openScriptWriter = () => { void router.push("/video-studio/script-writer"); };

  // Prefill from the Script Writer "Generate Audio" hand-off (sessionStorage, one-shot).
  // Read after mount (not in a lazy initializer) so the prerendered HTML and the
  // first client render agree — this is a one-time sync from browser storage.
  useEffect(() => {
    let prefill: string | null = null;
    try { prefill = sessionStorage.getItem(TTS_PREFILL_KEY); } catch (e) { logDebug("text-to-voice", "sessionStorage read failed (private mode?)", e); }
    if (prefill && prefill.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hand-off read from sessionStorage after hydration
      setMode("single");
      setScript(prefill);
      try { sessionStorage.removeItem(TTS_PREFILL_KEY); } catch (e) { logDebug("text-to-voice", "sessionStorage remove failed (private mode?)", e); }
    }
  }, []);

  /* ── Bulk state ───────────────────────────────────────────────────── */
  const [bulkScripts,  setBulkScripts]  = useState<ScriptItem[]>([blankScript(1)]);
  const [bulkRunning,  setBulkRunning]  = useState(false);
  const [bulkDone,     setBulkDone]     = useState(0);
  const [isDragging,   setIsDragging]   = useState(false);
  const bulkAbort    = useRef(false);
  const bulkFileRef  = useRef<HTMLInputElement>(null);

  // Warn before navigating away while generating a voiceover (single or bulk);
  // "Leave & stop" flips the bulk abort ref so the batch loop bails cleanly.
  useRegisterTask(generating || bulkRunning, {
    label: "AI Voiceover",
    kind: "studio",
    onAbort: () => { bulkAbort.current = true; },
  });

  /* ── Detect local engines (installed on disk?) ────────────────────── */
  // A local voice is offered ONLY once it's installed in Settings → Local AI → Voice.
  // `useInstalledLocalTts` re-checks on install + focus, so installing a model makes
  // it appear here live. Outside the desktop app → all offline.
  const installedLocal = useInstalledLocalTts();
  const statuses = useMemo<Record<Provider, Status>>(() => ({
    supertonic: installedLocal.supertonic ? "ready" : "offline",
    kokoro:     installedLocal.kokoro     ? "ready" : "offline",
  }), [installedLocal]);

  // Auto-select model based on task routing configured in Local AI Settings
  useEffect(() => {
    const routedId = loadLocalAIConfig().taskRouting["Voiceover"];
    if (routedId && isLocalTtsModel(routedId)) setModel(routedId);
  }, [setModel]);

  /* ── Reset state when model changes (and pick its first voice) ────── */
  // Adjusted during render (React's "reset state when a value changes" pattern)
  // rather than in an effect, so there's no extra render with stale state.
  const [prevModel, setPrevModel] = useState(model);
  if (model !== prevModel) {
    setPrevModel(model);
    setAudioUrl(null); setAudioBlob(null); setError("");
    setProgress(0); setCurTime(0); setAudioDur(0);
    setGenderFilter("All");
    setAccentFilter("All");
    setVoiceQuery("");
    setPreviewingVoice(null);
    const firstVoice = VOICES[model]?.[0];
    if (firstVoice) setVoiceId(firstVoice.id);
  }
  // Side effect of an engine change: stop any voice sample that's playing.
  useEffect(() => { sampleAudioRef.current?.pause(); }, [model]);

  // Free each generated clip's blob URL once it's replaced (regenerate / engine
  // change) or the page unmounts.
  useEffect(() => {
    if (!audioUrl) return;
    return () => URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  // Self-heal a stale/invalid persisted provider so VOICES[model] is never undefined.
  useEffect(() => {
    if (!isLocalTtsModel(model) || !VOICES[model]) setModel("kokoro");
  }, [model, setModel]);

  /* ── Audio player progress ────────────────────────────────────────── */
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    function onMeta() { if (Number.isFinite(a!.duration) && a!.duration > 0) setAudioDur(a!.duration); }
    function onTime() { setCurTime(a!.currentTime || 0); setProgress(a!.currentTime / Math.max(a!.duration, 1)); onMeta(); }
    function onEnd()  { setPlaying(false); setProgress(0); }
    a.addEventListener("timeupdate",     onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("ended",          onEnd);
    return () => {
      a.removeEventListener("timeupdate",     onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("ended",          onEnd);
    };
  }, [audioUrl]);

  /* ── Generation logic ─────────────────────────────────────────────── */
  async function handleGenerate() {
    if (!script.trim() || generating) return;
    setError(""); setGenerating(true);
    setAudioUrl(null); setAudioBlob(null);   // the old URL is revoked by the audioUrl effect
    setProgress(0); setCurTime(0); setAudioDur(0);
    stopPlayback();

    try {
      const blob = await localTtsGenerate(model, script, voiceId, speed);
      const url  = URL.createObjectURL(blob);
      setAudioBlob(blob); setAudioUrl(url);
    } catch (e) {
      logError("text-to-voice", "TTS generation failed", e);
      setError(humanizeError(e, { operation: "generate" }));
    } finally {
      setGenerating(false);
    }
  }

  /* ── Bulk actions ─────────────────────────────────────────────────── */
  function bulkUpdateItem(id: string, patch: Partial<ScriptItem>) {
    setBulkScripts(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }
  function bulkRemoveItem(id: string) {
    setBulkScripts(prev => {
      const next = prev.filter(s => s.id !== id);
      return next.length === 0 ? [blankScript(1)] : next;
    });
  }
  function bulkAddBlank() {
    setBulkScripts(prev => [...prev, blankScript(prev.length + 1)]);
  }
  async function loadTxtFiles(files: File[]) {
    const txts = files.filter(f => f.name.endsWith(".txt") || f.type === "text/plain");
    if (!txts.length) return;
    const items = await Promise.all(txts.map(async f => ({
      id:        uid(),
      name:      f.name.replace(/\.txt$/i, ""),
      text:      (await f.text()).trim(),
      status:    "idle" as ItemStatus,
      audioUrl:  null, audioBlob: null, error: null,
    })));
    setBulkScripts(prev => {
      const nonEmpty = prev.filter(s => s.text.trim());
      return [...nonEmpty, ...items];
    });
  }
  async function bulkGenerateAll() {
    const toProcess = bulkScripts.filter(s => s.text.trim() && s.status !== "done");
    if (!toProcess.length || bulkRunning || modelStatus !== "ready") return;
    bulkAbort.current = false;
    setBulkRunning(true);
    setBulkDone(0);
    let done = 0;
    for (const item of toProcess) {
      if (bulkAbort.current) break;
      bulkUpdateItem(item.id, { status: "generating", error: null });
      try {
        const blob = await localTtsGenerate(model, item.text, voiceId, speed);
        bulkUpdateItem(item.id, { status: "done", audioUrl: URL.createObjectURL(blob), audioBlob: blob });
        setBulkDone(++done);
      } catch (e) {
        logError("text-to-voice", `bulk TTS generation failed for item ${item.id}`, e);
        bulkUpdateItem(item.id, { status: "error", error: humanizeError(e, { operation: "generate" }) });
      }
    }
    setBulkRunning(false);
  }
  async function bulkDownloadAll() {
    // In-memory blobs → a native Save-to-folder on desktop (a hidden <a download>
    // is silently ignored by the Tauri webview), or <a download> each on web.
    const files = bulkScripts
      .filter(s => s.status === "done" && s.audioBlob)
      .map((s, i) => {
        const ext = s.audioBlob!.type.includes("wav") ? "wav" : "mp3";
        const name = `${s.name.replace(/[^a-z0-9]/gi, "_") || `script_${i + 1}`}.${ext}`;
        return { blob: s.audioBlob!, name };
      });
    if (!files.length) return;
    try {
      const res = await saveBlobsToFolder(files);
      if (res.saved > 0) {
        toastSuccess(
          res.dir ? `Saved ${res.saved} file${res.saved > 1 ? "s" : ""} to ${res.dir}` : `Downloaded ${res.saved} file${res.saved > 1 ? "s" : ""}`,
          "Download complete",
        );
      }
    } catch (e) { surfaceError(e, { operation: "tts-bulk-download" }); }
  }
  function bulkReset() {
    bulkScripts.forEach(s => { if (s.audioUrl) URL.revokeObjectURL(s.audioUrl); });
    setBulkScripts(prev => prev.map(s => ({ ...s, status: "idle", audioUrl: null, audioBlob: null, error: null })));
    setBulkDone(0);
  }

  /* ── Playback ─────────────────────────────────────────────────────── */
  function stopPlayback() {
    audioRef.current?.pause();
    setPlaying(false);
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else         { a.play();  setPlaying(true); }
  }

  /* ── Voice preview ────────────────────────────────────────────────── */
  async function previewVoice(voice: Voice) {
    // Toggle off if already playing this voice
    if (previewingVoice === voice.id) {
      sampleAudioRef.current?.pause();
      setPreviewingVoice(null);
      return;
    }

    // Stop any current playback
    sampleAudioRef.current?.pause();
    setPreviewingVoice(null);

    // A bundled pre-rendered demo (public/voice-demos) → play it directly:
    // instant, offline, free, no model download.
    const demoUrl = voiceDemoUrl(voiceDemos, model, voice.id);
    if (demoUrl) {
      const audio = new Audio(demoUrl);
      audio.onended = () => setPreviewingVoice(null);
      audio.play().catch((e) => { logDebug("text-to-voice", "voice demo playback failed", e); setPreviewingVoice(null); });
      sampleAudioRef.current = audio;
      setPreviewingVoice(voice.id);
      return;
    }

    if (modelStatus !== "ready") {
      setError(`Cannot preview — ${selectedModel.label} isn't installed yet.`);
      return;
    }

    // Use cached sample if available
    const cacheKey = `${model}::${voice.id}`;
    let url = sampleCache.get(cacheKey);

    if (!url) {
      setLoadingSample(voice.id);
      try {
        const blob = await localTtsGenerate(model, PREVIEW_TEXT, voice.id, 100);
        url = URL.createObjectURL(blob);
        setSampleCache(prev => new Map(prev).set(cacheKey, url!));
      } catch (e) {
        logWarn("text-to-voice", "voice preview generation failed", e);
        setError(humanizeError(e, { operation: "preview voice" }));
        setLoadingSample(null);
        return;
      }
      setLoadingSample(null);
    }

    const audio = new Audio(url);
    audio.onended = () => setPreviewingVoice(null);
    audio.play().catch((e) => { logDebug("text-to-voice", "voice sample playback failed", e); setPreviewingVoice(null); });
    sampleAudioRef.current = audio;
    setPreviewingVoice(voice.id);
  }

  async function downloadAudio() {
    if (!audioBlob) return;
    const ext = audioBlob.type.includes("wav") ? "wav" : "mp3";
    // Native Save dialog on desktop (the Tauri webview ignores <a download>);
    // <a download> on web. saveBlobToDisk picks the right path per platform.
    const base = deriveName(script).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "voiceover";
    try {
      const res = await saveBlobToDisk(audioBlob, `${base}.${ext}`);
      if (res.saved && res.path) toastSuccess(`Saved to ${res.path}`, "Download complete");
    } catch (e) { surfaceError(e, { operation: "tts-download" }); }
  }

  /* ── Derived ──────────────────────────────────────────────────────── */
  // A local engine appears in the picker only once installed (Settings → Local AI → Voice).
  const visibleModels: ModelDef[] = MODELS.filter(m => statuses[m.id] === "ready");
  // A stale/invalid persisted `model` matches nothing in visibleModels or MODELS;
  // fall back so selectedModel is never undefined (the self-heal effect above
  // resets `model` itself, but that only runs after this first render).
  const selectedModel =
    visibleModels.find(m => m.id === model) ??
    MODELS.find(m => m.id === model) ??
    visibleModels[0] ??
    MODELS[0];
  const modelStatus   = statuses[model];

  // If the active engine isn't usable (e.g. an uninstalled local voice that's now
  // hidden), fall back to the first engine that IS ready so the picker never sits on
  // a hidden/offline selection. No-ops while nothing is ready yet (all offline).
  useEffect(() => {
    if (statuses[model] !== "offline") return;
    const firstReady = visibleModels.find(m => statuses[m.id] === "ready");
    if (firstReady && firstReady.id !== model) setModel(firstReady.id);
  }, [statuses, model, visibleModels]); // eslint-disable-line react-hooks/exhaustive-deps

  const allVoices: Voice[] = VOICES[model] ?? [];

  const voiceQ = voiceQuery.trim().toLowerCase();
  const voiceList: Voice[] = allVoices
    .filter(v =>
      (genderFilter === "All" || v.gender === genderFilter) &&
      (accentFilter === "All" || v.accent === accentFilter) &&
      (!voiceQ || v.name.toLowerCase().includes(voiceQ) || v.accent.toLowerCase().includes(voiceQ))
    );

  const wordCount    = script.trim() ? script.trim().split(/\s+/).length : 0;
  const charCount    = script.length;
  const estSeconds   = estimateDuration(script, speed / 100);

  const canGenerate  = !!script.trim() && modelStatus === "ready" && !generating;

  // Bulk derived
  const bulkTotal  = bulkScripts.filter(s => s.text.trim()).length;
  const bulkDoneN  = bulkScripts.filter(s => s.status === "done").length;
  const bulkErrors = bulkScripts.filter(s => s.status === "error").length;
  const canBulk    = bulkTotal > 0 && modelStatus === "ready" && !bulkRunning;

  /* ── Render ───────────────────────────────────────────────────────── */
  return (
    <AppLayout>
      {/* ── Fixed split layout (matches image-to-video): top bar
          + fixed left settings panel + scrollable main content. ── */}
      <div className="flex flex-col h-full min-h-0 overflow-hidden">

          {/* ── Top bar: mode tabs (left) + compact model status (right) ── */}
          <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-zinc-200 dark:border-white/8 shrink-0">
            {/* Mode tabs */}
            <div className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 rounded-xl w-fit shrink-0">
              {([["single", Mic, "Single"], ["bulk", Layers, "Bulk"]] as const).map(([m, Icon, label]) => (
                <button key={m} onClick={() => setMode(m)}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12.5px] font-semibold cursor-pointer border-none font-[inherit] transition-all ${
                    mode === m
                      ? "bg-white dark:bg-white/10 text-zinc-900 dark:text-zinc-100 shadow-sm"
                      : "bg-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  }`}>
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>

            {/* Right group: compact model status */}
            <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0 px-3 py-1.5 rounded-full border border-zinc-200 dark:border-white/8 bg-white dark:bg-white/3">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
                modelStatus === "ready"    ? "bg-emerald-500" :
                modelStatus === "checking" ? "bg-violet-500 animate-pulse" : "bg-zinc-400"
              }`} />
              <span className="text-[11.5px] font-bold text-zinc-800 dark:text-zinc-100 truncate" title={selectedModel.desc}>{selectedModel.label}</span>
              <span className="text-[11px] font-semibold shrink-0" style={{
                color: modelStatus === "ready"    ? "#10b981" :
                       modelStatus === "checking" ? "#0057FC" : "#71717a",
              }}>
                {modelStatus === "ready"    ? "Online" :
                 modelStatus === "checking" ? "Checking…" : "Offline"}
              </span>
              {modelStatus === "offline" && (
                <button onClick={() => openSettings("local-ai")} className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-white/6 text-zinc-500 dark:text-zinc-400 hover:text-violet-500 dark:hover:text-violet-400 transition-colors cursor-pointer border-none shrink-0">
                  Setup →
                </button>
              )}
            </div>
            </div>
          </div>

          <div className="relative flex flex-1 min-h-0">

            {/* ── RIGHT (main, scrollable): Script ── */}
            <div className="flex-1 min-w-0 overflow-y-auto px-8 py-6 flex flex-col gap-5 order-2">

              {/* ── BULK: file drop + script cards ── */}
              {mode === "bulk" && (
                <>
                  {/* Drop zone */}
                  <div
                    onDragEnter={e => { e.preventDefault(); setIsDragging(true); }}
                    onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={e => { e.preventDefault(); setIsDragging(false); loadTxtFiles(Array.from(e.dataTransfer.files)); }}
                    onClick={() => bulkFileRef.current?.click()}
                    className={`flex flex-col items-center justify-center gap-2 h-[90px] rounded-2xl border-2 border-dashed cursor-pointer transition-all ${
                      isDragging
                        ? "border-violet-500 bg-violet-50 dark:bg-violet-500/8"
                        : "border-zinc-300 dark:border-white/20 bg-zinc-50/80 dark:bg-white/[0.04] hover:border-violet-400 hover:bg-violet-50/50 dark:hover:bg-violet-500/5"
                    }`}
                  >
                    <input ref={bulkFileRef} type="file" accept=".txt,text/plain" multiple className="hidden"
                      onChange={e => { if (e.target.files) loadTxtFiles(Array.from(e.target.files)); e.target.value = ""; }} />
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${isDragging ? "bg-violet-500" : "bg-zinc-100 dark:bg-white/6"}`}>
                      <Upload size={15} className={isDragging ? "text-white" : "text-zinc-400"} />
                    </div>
                    <p className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300 text-center">
                      Drop TXT files here <span className="text-zinc-400 font-normal">or click to browse</span>
                    </p>
                  </div>

                  {/* Script cards */}
                  {bulkScripts.map((item, idx) => (
                    <ScriptCard key={item.id} item={item} index={idx}
                      onUpdate={bulkUpdateItem} onRemove={bulkRemoveItem} disabled={bulkRunning}
                      onGenerateScript={openScriptWriter} />
                  ))}

                  {/* Add script button */}
                  <button onClick={bulkAddBlank} disabled={bulkRunning}
                    className="flex items-center justify-center gap-2 h-10 rounded-2xl border-2 border-dashed border-zinc-200 dark:border-white/10 bg-transparent text-[12.5px] font-semibold text-zinc-500 dark:text-zinc-400 hover:border-violet-400 hover:text-violet-500 hover:bg-violet-50/50 dark:hover:bg-violet-500/5 cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                    <Plus size={14} /> Add Script
                  </button>
                </>
              )}

              {/* ── SINGLE: Script Input ── */}
              {mode === "single" && <div className="bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 rounded-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-white/6">
                  <FileText size={13} className="text-violet-500" />
                  <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Script</span>
                  <div className="flex-1" />
                  <button onClick={openScriptWriter} title="Generate a script with AI"
                    className="flex items-center gap-1 h-6 px-2 rounded-md text-[10px] font-semibold text-violet-600 dark:text-violet-400 bg-violet-500/10 border border-violet-200 dark:border-violet-500/25 hover:bg-violet-500/15 cursor-pointer font-[inherit] transition-all">
                    <Sparkles size={11} /> Generate Script
                  </button>
                </div>
                <div className="relative">
                  <textarea
                    value={script}
                    onChange={e => setScript(e.target.value)}
                    placeholder="Paste or type your script here. This is what the AI voice will read out loud — write naturally, with punctuation, and don't forget pauses…"
                    rows={10}
                    maxLength={5000}
                    className="w-full px-5 py-4 bg-transparent border-none outline-none resize-none text-[14px] leading-relaxed text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 font-[inherit]"
                  />
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-zinc-100 dark:border-white/6 bg-zinc-50/60 dark:bg-white/2">
                  <div className="flex items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <span className="tabular-nums">{wordCount} words</span>
                    <span className="w-0.5 h-0.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                    <span className="tabular-nums">{charCount} / 5000 chars</span>
                    <span className="w-0.5 h-0.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                    <span className="tabular-nums flex items-center gap-1"><Headphones size={10} /> ~{fmtDur(estSeconds)} estimated</span>
                  </div>
                  {script && (
                    <button onClick={() => setScript("")}
                      className="text-[11px] text-zinc-400 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer font-[inherit]">
                      Clear
                    </button>
                  )}
                </div>
              </div>}

            </div>

            {/* ── LEFT (fixed panel, scrolls independently): model + voice + settings + generate ──
                Sits on the shared panel surface (bg-panel), like every tool's side panel. */}
            <div className="w-96 shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-panel overflow-hidden order-1">
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">

              {/* Model & Voice */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles size={13} className="text-violet-500" />
                  <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Model &amp; Voice</span>
                </div>

                <div className="flex flex-col gap-3">
                  <ModelDropdown value={model} onChange={setModel} statuses={statuses} models={visibleModels} />

                  {/* Status banner per-model */}
                  {modelStatus === "offline" && (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/8">
                      <WifiOff size={12} className="text-amber-500 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11.5px] font-semibold text-amber-700 dark:text-amber-300">{selectedModel.label} isn&apos;t installed yet</p>
                        <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5 leading-relaxed">
                          Install an on-device voice in <button onClick={() => openSettings("local-ai")} className="underline font-semibold cursor-pointer border-none bg-transparent p-0 text-inherit font-[inherit]">Local AI</button> — it downloads once, then runs offline.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Voices loading — while the engine is being checked, so the
                      section doesn't just vanish and users know voices are coming. */}
                  {modelStatus === "checking" && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">Voices</span>
                        <Loader2 size={12} className="text-violet-500 animate-spin" />
                      </div>
                      <div className="grid grid-cols-1 gap-1.5">
                        {Array.from({ length: 6 }).map((_, i) => (
                          <div key={i} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-zinc-200 dark:border-white/8 animate-pulse">
                            <div className="w-7 h-7 rounded-full bg-zinc-200 dark:bg-white/8 shrink-0" />
                            <div className="h-2.5 rounded bg-zinc-200 dark:bg-white/8" style={{ width: `${55 - i * 4}%` }} />
                          </div>
                        ))}
                      </div>
                      <p className="text-[11px] text-zinc-400 mt-2 text-center flex items-center justify-center gap-1.5">
                        <Loader2 size={11} className="animate-spin" /> Loading voices…
                      </p>
                    </div>
                  )}

                  {/* Voice picker */}
                  {allVoices.length > 0 && modelStatus === "ready" && (
                    <div>
                      {/* Header: counts */}
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">Voices</span>
                        <span className="text-[10px] text-zinc-400 tabular-nums flex items-center gap-1">
                          {voiceList.length} of {allVoices.length}
                        </span>
                      </div>

                      {/* Search */}
                      <div className="relative mb-2">
                        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                        <input
                          value={voiceQuery}
                          onChange={e => setVoiceQuery(e.target.value)}
                          placeholder="Search voices…"
                          className="w-full h-7 pl-8 pr-7 rounded-lg text-[12px] bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 outline-none focus:border-violet-400/60 font-[inherit]"
                        />
                        {voiceQuery && (
                          <button
                            onClick={() => setVoiceQuery("")}
                            title="Clear"
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center cursor-pointer border-none bg-transparent text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>

                      {/* Filters: gender (no count labels) */}
                      <div className="flex items-center gap-1.5 mb-2">
                        {(["All", "Female", "Male"] as const).map(g => {
                          const active = genderFilter === g;
                          return (
                            <button
                              key={g}
                              onClick={() => setGenderFilter(g)}
                              className={`h-6 px-3 rounded-full text-[11px] font-semibold cursor-pointer border transition-all font-[inherit] ${
                                active
                                  ? "bg-violet-500/12 border-violet-500/40 text-violet-600 dark:text-violet-400"
                                  : "bg-zinc-50 dark:bg-white/4 border-zinc-200 dark:border-white/8 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-white/15"
                              }`}
                            >
                              {g}
                            </button>
                          );
                        })}
                      </div>

                      {/* Voice cards — single column so the name, gender and accent
                          are fully legible (two columns in this panel left ~20px
                          for the name, truncating it to "N…"). */}
                      <div className="grid grid-cols-1 gap-1.5">
                        {voiceList.length === 0 ? (
                          <div className="col-span-full py-6 text-center text-[12px] text-zinc-400">
                            No voices match your search.
                          </div>
                        ) : voiceList.map(v => {
                          const active     = voiceId === v.id;
                          const isPlaying  = previewingVoice === v.id;
                          const isLoading  = loadingSample === v.id;
                          const isFemale   = v.gender === "Female";
                          return (
                            <div
                              key={v.id}
                              onClick={() => setVoiceId(v.id)}
                              className={`relative flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border text-left cursor-pointer transition-all ${
                                active
                                  ? "bg-violet-500/8 border-violet-500/40"
                                  : "bg-zinc-50 dark:bg-white/4 border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/15"
                              }`}
                            >
                              {/* Avatar */}
                              <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border overflow-hidden ${
                                active
                                  ? "bg-violet-500/15 border-violet-400/40"
                                  : isFemale
                                    ? "bg-purple-50 dark:bg-purple-500/10 border-purple-200 dark:border-purple-500/25"
                                    : "bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/25"
                              }`}>
                                {v.avatar ? (
                                  <img
                                    src={v.avatar}
                                    alt=""
                                    aria-hidden="true"
                                    className="h-full w-full object-cover"
                                    draggable={false}
                                  />
                                ) : (
                                  <span className={`text-[11px] font-bold ${
                                    active
                                      ? "text-violet-500"
                                      : isFemale
                                        ? "text-purple-600 dark:text-purple-400"
                                        : "text-blue-600 dark:text-blue-400"
                                  }`}>
                                    {v.name[0]?.toUpperCase()}
                                  </span>
                                )}
                              </div>

                              {/* Info — name, gender dot + accent all on one line */}
                              <div className="min-w-0 flex-1 flex items-center gap-1.5">
                                <p className={`text-[12.5px] font-semibold truncate leading-tight ${active ? "text-violet-500" : "text-zinc-800 dark:text-zinc-100"}`}>{v.name}</p>
                                <span
                                  className={`text-[8.5px] font-bold uppercase px-1 py-0.5 rounded leading-none shrink-0 ${
                                    isFemale
                                      ? "bg-purple-100 dark:bg-purple-500/15 text-purple-600 dark:text-purple-400"
                                      : "bg-blue-100 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                  }`}
                                >
                                  {isFemale ? "F" : "M"}
                                </span>
                                <span className="text-[10.5px] text-zinc-400 truncate">{v.accent}</span>
                              </div>

                              {/* Preview play/pause — a bundled demo clip (instant +
                                  free), else on-device synthesis as a fallback. */}
                              <button
                                onClick={e => { e.stopPropagation(); previewVoice(v); }}
                                title={isPlaying ? "Stop preview" : "Play voice sample"}
                                disabled={!!loadingSample && loadingSample !== v.id}
                                className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 cursor-pointer border-none transition-all ${
                                  isPlaying
                                    ? "bg-violet-500 shadow-md"
                                    : isLoading
                                      ? "bg-zinc-100 dark:bg-white/8"
                                      : "bg-white dark:bg-white/10 hover:bg-violet-500/10 hover:scale-110"
                                } ${loadingSample && loadingSample !== v.id ? "opacity-40 cursor-wait" : ""}`}
                              >
                                {isLoading
                                  ? <Loader2 size={11} className="text-violet-500 animate-spin" />
                                  : isPlaying
                                    ? <Pause size={11} className="text-white fill-white" />
                                    : <Play  size={11} className="text-zinc-500 dark:text-zinc-300 fill-zinc-500 dark:fill-zinc-300" style={{ marginLeft: 1 }} />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Settings */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Settings2 size={13} className="text-violet-500" />
                  <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Voice Settings</span>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-1.5">
                      <Gauge size={11} className="text-zinc-400" />
                      <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300">Speed</span>
                    </div>
                    <span className="text-[11px] font-bold text-violet-500 bg-violet-500/8 border border-violet-500/15 rounded-full px-2.5 py-0.5 font-mono tabular-nums">
                      {(speed / 100).toFixed(1)}×
                    </span>
                  </div>
                  <Slider value={speed} onChange={setSpeed} min={50} max={200} />
                </div>
              </div>

              {/* ── Results (mode-aware). The primary Generate ACTION is pinned to
                  the panel footer below; this area only shows outputs, so it
                  scrolls with the rest of the config. ── */}

              {/* SINGLE: audio preview */}
              {mode === "single" && audioUrl && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Headphones size={13} className="text-violet-500" />
                    <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Preview</span>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    <audio ref={audioRef} src={audioUrl} className="hidden" />
                    <div className="flex items-center gap-2.5 bg-zinc-50 dark:bg-white/4 border border-zinc-200 dark:border-white/8 rounded-xl px-3 py-2.5">
                      <button onClick={togglePlay}
                        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 cursor-pointer border-none bg-brand-gradient hover:brightness-110 transition-all duration-150 shadow-md">
                        {playing ? <Pause size={13} className="text-white fill-white" /> : <Play size={13} className="text-white fill-white" style={{ marginLeft: 1 }} />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="h-1 rounded-full bg-zinc-200 dark:bg-white/10 overflow-hidden">
                          <div className="h-full rounded-full bg-brand-gradient transition-all" style={{ width: `${progress * 100}%` }} />
                        </div>
                        <p className="text-[10px] text-zinc-400 mt-1 tabular-nums">
                          {fmtDur(curTime)} / {audioDur ? fmtDur(audioDur) : fmtDur(estSeconds)}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={handleGenerate}
                        className="flex items-center justify-center gap-1.5 h-8 rounded-lg text-[11.5px] font-semibold text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 hover:border-zinc-300 cursor-pointer font-[inherit] transition-colors">
                        <RotateCcw size={11} /> Regenerate
                      </button>
                      <button onClick={downloadAudio}
                        className="flex items-center justify-center gap-1.5 h-8 rounded-lg text-[11.5px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 border-none cursor-pointer font-[inherit] transition-colors">
                        <Download size={11} /> Download
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* BULK: batch stats + completed list */}
              {mode === "bulk" && (
                <div className="bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 rounded-2xl overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-white/6">
                    <Layers size={13} className="text-violet-500" />
                    <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Batch</span>
                  </div>
                  <div className="px-4 py-4 flex flex-col gap-3">
                    {/* Stats */}
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: "Scripts", value: bulkTotal,  color: "#0057FC" },
                        { label: "Done",    value: bulkDoneN,  color: "#10b981" },
                        { label: "Errors",  value: bulkErrors, color: "#ef4444" },
                      ].map(s => (
                        <div key={s.label} className="flex flex-col items-center gap-0.5 py-2 rounded-xl bg-zinc-50 dark:bg-white/3 border border-zinc-100 dark:border-white/6">
                          <span className="text-[18px] font-extrabold tabular-nums" style={{ color: s.value > 0 ? s.color : "#71717a" }}>{s.value}</span>
                          <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.08em]">{s.label}</span>
                        </div>
                      ))}
                    </div>
                    {/* Download all + reset */}
                    {bulkDoneN > 0 && !bulkRunning && (
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={bulkDownloadAll}
                          className="flex items-center justify-center gap-1.5 h-8 rounded-lg text-[11.5px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 border-none cursor-pointer font-[inherit] transition-colors">
                          <Download size={11} /> Download All
                        </button>
                        <button onClick={bulkReset}
                          className="flex items-center justify-center gap-1.5 h-8 rounded-lg text-[11.5px] font-semibold text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 hover:border-zinc-300 cursor-pointer font-[inherit] transition-colors">
                          <RotateCcw size={11} /> Reset
                        </button>
                      </div>
                    )}
                    {/* Done list */}
                    {bulkDoneN > 0 && (
                      <div className="border-t border-zinc-100 dark:border-white/6 pt-3 flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 mb-1">
                          <CheckCircle2 size={11} className="text-emerald-500" />
                          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">Completed</span>
                        </div>
                        {bulkScripts.filter(s => s.status === "done").map((s, i) => (
                          <div key={s.id} className="flex items-center gap-2 py-1 border-b border-zinc-100 dark:border-white/6 last:border-0">
                            <CheckCircle2 size={10} className="text-emerald-500 shrink-0" />
                            <span className="flex-1 text-[11.5px] text-zinc-700 dark:text-zinc-300 truncate">{s.name || `Script ${i + 1}`}</span>
                            {s.audioBlob && (
                              <button onClick={async () => {
                                const ext = s.audioBlob!.type.includes("wav") ? "wav" : "mp3";
                                await saveBlobToDisk(s.audioBlob!, `${s.name.replace(/[^a-z0-9]/gi, "_") || "audio"}.${ext}`)
                                  .catch(e => surfaceError(e, { operation: "save audio" }));
                              }} className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 cursor-pointer border-none bg-emerald-500/10 hover:bg-emerald-500/20 transition">
                                <Download size={9} className="text-emerald-600 dark:text-emerald-400" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Tip card — dismissible, remembered in localStorage */}
              {!tipDismissed && (
              <div className="rounded-xl border border-violet-200/60 dark:border-violet-500/15 bg-violet-50/40 dark:bg-violet-500/5 px-4 py-3">
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-violet-500">Tip</p>
                  <button onClick={dismissTip} title="Dismiss" aria-label="Dismiss tip"
                    className="-mt-0.5 -mr-1 w-5 h-5 rounded-md flex items-center justify-center shrink-0 cursor-pointer border-none bg-transparent text-violet-400/70 hover:text-violet-500 hover:bg-violet-500/10 transition">
                    <X size={12} />
                  </button>
                </div>
                <p className="text-[11.5px] text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {mode === "single"
                    ? <>Voices run on your machine — <span className="font-semibold text-zinc-700 dark:text-zinc-300">Kokoro</span> &amp; <span className="font-semibold text-zinc-700 dark:text-zinc-300">Supertonic</span>. They download once (manage them in <span className="font-semibold text-zinc-700 dark:text-zinc-300">Local AI</span>), then work offline, free. Outputs download as WAV.</>
                    : <>Scripts run <span className="font-semibold text-zinc-700 dark:text-zinc-300">one at a time</span>. Upload .txt files or type manually — one click generates all.</>}
                </p>
              </div>
              )}
            </div>

            {/* ── Pinned footer: the primary Generate action, always visible ──
                A hairline divider anchors the action at the foot of the panel. */}
            <div className="shrink-0 border-t border-zinc-200 dark:border-white/8 px-4 py-3 bg-panel flex flex-col gap-2.5">
              {/* Active model pill */}
              <div className="flex items-center gap-2 bg-zinc-50 dark:bg-white/4 border border-zinc-200 dark:border-white/8 rounded-lg px-3 py-2">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: modelStatus === "ready" ? "#10b981" : "#71717a" }} />
                <span className="text-[11.5px] font-semibold text-zinc-700 dark:text-zinc-200 truncate">{selectedModel.label}</span>
                <span className="text-zinc-300 dark:text-white/20">·</span>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate min-w-0 flex-1">
                  {voiceList.find(v => v.id === voiceId)?.name ?? "—"}
                </span>
                {modelStatus === "ready" ? <Wifi size={10} className="text-emerald-500 shrink-0" /> : <WifiOff size={10} className="text-zinc-400 shrink-0" />}
              </div>

              {/* SINGLE: error + generate */}
              {mode === "single" && (<>
                {error && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/8">
                    <AlertCircle size={12} className="text-red-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-red-700 dark:text-red-400 leading-relaxed">{error}</p>
                  </div>
                )}
                <button onClick={handleGenerate} disabled={!canGenerate}
                  className={`w-full flex items-center justify-center gap-2 h-10 rounded-xl text-[13px] font-semibold transition-all duration-200 cursor-pointer border-none font-[inherit] ${
                    generating ? "bg-violet-500/80 text-white cursor-wait"
                    : !canGenerate ? "bg-zinc-100 dark:bg-white/6 text-zinc-400 cursor-not-allowed"
                    : "bg-brand-gradient text-white hover:brightness-110"
                  }`}>
                  {generating ? <><Loader2 size={14} className="animate-spin" />Generating…</> : <><Headphones size={14} />Generate Speech</>}
                </button>
              </>)}

              {/* BULK: progress + generate/stop */}
              {mode === "bulk" && (<>
                {bulkRunning && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] text-zinc-500">Generating…</span>
                      <span className="text-[11px] font-semibold text-violet-500 tabular-nums">{bulkDone} / {bulkTotal}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                      <div className="h-full rounded-full bg-brand-gradient transition-all duration-500"
                        style={{ width: `${bulkTotal > 0 ? (bulkDone / bulkTotal) * 100 : 0}%` }} />
                    </div>
                  </div>
                )}
                {bulkRunning ? (
                  <button onClick={() => { bulkAbort.current = true; }}
                    className="w-full flex items-center justify-center gap-2 h-10 rounded-xl text-[13px] font-semibold text-white bg-red-500 hover:bg-red-600 cursor-pointer border-none font-[inherit] transition-colors">
                    <X size={14} /> Stop
                  </button>
                ) : (
                  <button onClick={bulkGenerateAll} disabled={!canBulk}
                    className={`w-full flex items-center justify-center gap-2 h-10 rounded-xl text-[13px] font-semibold cursor-pointer border-none font-[inherit] transition-all ${
                      canBulk ? "bg-brand-gradient text-white hover:brightness-110"
                              : "bg-zinc-100 dark:bg-white/6 text-zinc-400 cursor-not-allowed"
                    }`}>
                    <Headphones size={14} />
                    Generate {bulkTotal > 0 ? `${bulkTotal} Script${bulkTotal > 1 ? "s" : ""}` : "All"}
                  </button>
                )}
              </>)}
            </div>
            </div>
          </div>
      </div>
    </AppLayout>
  );
}
