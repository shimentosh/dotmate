"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import {
  Sparkles, Play, Pause, Loader2, Download,
  Plus, Upload, X, Check, AlertCircle,
  ChevronDown, Zap, Crown, Headphones, Gauge,
  Wifi, WifiOff, Layers, RotateCcw, CheckCircle2,
} from "lucide-react";
import { openSettings } from "@/lib/open-settings";
import { createPortal } from "react-dom";
import AppLayout from "@/components/layout/app-layout";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import { MiniPlayer } from "@/components/tools/audio-mini-player";
import { localTtsGenerate, isLocalTtsModel, type LocalTtsModel } from "@/lib/tts/local-tts";
import { useVoiceDemos, voiceDemoUrl } from "@/lib/tts/voice-demos";
import { useInstalledLocalTts } from "@/lib/tts/use-installed-local-tts";
import { usePreference } from "@/lib/use-preference";
import { logDebug, logWarn } from "@/lib/log";
import { humanizeError } from "@/lib/error/app-error";
import { saveBlobToDisk, saveBlobsToFolder } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";
import { useRegisterTask } from "@/hooks/use-register-task";
import { useRenderJobs } from "@/store/render-jobs";

/* ── Types ───────────────────────────────────────────────────────────── */
/** Only on-device engines — every voice synthesizes locally, offline and free. */
type Provider = LocalTtsModel;
type ServerStatus = "ready" | "checking" | "offline";
type ItemStatus   = "idle" | "generating" | "done" | "error";

interface ModelDef {
  id:      Provider;
  label:   string;
  sub:     string;
  icon:    typeof Zap;
}
const MODELS: ModelDef[] = [
  { id: "supertonic", label: "Supertonic", sub: "On-device", icon: Crown },
  { id: "kokoro",     label: "Kokoro",     sub: "On-device", icon: Zap   },
];

type Gender = "Female" | "Male";
interface Voice { id: string; name: string; gender: Gender; accent: string; avatar?: string }

const VOICES: Record<Provider, Voice[]> = {
  // Supertonic 3 preset voice styles (`voice_styles/<id>.json`).
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
  // Kokoro-82M speaker ids (multi-lang v1.0): `id` is the speaker index the
  // native engine selects. Display names + avatars reused from the prior set.
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
};

interface ScriptItem {
  id:        string;
  name:      string;
  text:      string;
  status:    ItemStatus;
  audioUrl:  string | null;
  audioBlob: Blob | null;
  error:     string | null;
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// On-device TTS generators (Kokoro / Supertonic) live in @/lib/tts/local-tts,
// shared with Text-to-Voice (imported above as localTtsGenerate).

/* ── Mini Model Dropdown ─────────────────────────────────────────────── */
function ModelDropdown({
  value, onChange, statuses, models = MODELS,
}: {
  value: Provider; onChange: (v: Provider) => void; statuses: Record<Provider, ServerStatus>;
  models?: ModelDef[];
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef  = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  // A stale/invalid persisted `value` matches nothing; fall back so `sel` is never undefined.
  const sel     = models.find(m => m.id === value) ?? MODELS.find(m => m.id === value) ?? models[0] ?? MODELS[0];
  const SIcon   = sel.icon;

  function openIt() {
    if (!btnRef.current) return;
    setRect(btnRef.current.getBoundingClientRect());
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function h(e: MouseEvent) {
      if (!btnRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const statusDot = (s: ServerStatus) =>
    s === "ready" ? "#10b981" : s === "checking" ? "#0057FC" : "#71717a";

  const portal = open && rect ? createPortal(
    <div
      ref={dropRef}
      style={{ position: "fixed", top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 320), zIndex: 99999 }}
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
        const MIcon    = m.icon;
        const active   = value === m.id;
        const st       = statuses[m.id];
        const disabled = st === "offline";
        return (
          <button
            key={m.id}
            onClick={() => { onChange(m.id); setOpen(false); }}
            disabled={disabled}
            className={`w-full flex items-center gap-3 px-3.5 py-2.5 border-none font-[inherit] text-left cursor-pointer transition-colors ${
              i > 0 ? "border-t border-zinc-100 dark:border-white/6" : ""
            } ${active ? "bg-violet-500/6" : "bg-transparent hover:bg-zinc-50 dark:hover:bg-white/5"} ${disabled ? "opacity-45 cursor-not-allowed" : ""}`}
          >
            <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${active ? "bg-violet-500" : "bg-zinc-100 dark:bg-white/8"}`}>
              <MIcon size={12} className={active ? "text-white" : "text-zinc-400"} />
            </div>
            <div className="flex-1 min-w-0">
              <span className={`block text-[12.5px] font-semibold truncate ${active ? "text-violet-500" : "text-zinc-800 dark:text-zinc-100"}`}>{m.label}</span>
              <span className="block text-[10px] text-zinc-400 truncate">{m.sub}</span>
            </div>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusDot(st) }} />
            {active && <Check size={11} className="text-violet-500" />}
          </button>
        );
      })}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={btnRef} onClick={openIt}
        className="flex items-center gap-2 h-9 px-3 rounded-xl bg-white dark:bg-white/6 border border-zinc-200 dark:border-white/10 cursor-pointer font-[inherit] hover:border-zinc-300 dark:hover:border-white/20 transition-colors"
      >
        <div className="w-5 h-5 rounded-md bg-violet-500 flex items-center justify-center shrink-0">
          <SIcon size={11} className="text-white" />
        </div>
        <span className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100">{sel.label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusDot(statuses[value]) }} />
        <ChevronDown size={11} className="text-zinc-400" />
      </button>
      {portal}
    </>
  );
}

const PREVIEW_TEXT = "Hey! This is a quick voice preview so you can hear exactly how I'll sound reading your script.";

/* ── Mini Voice Dropdown (with per-voice preview) ────────────────────── */
function VoiceDropdown({
  voices, value, onChange, model, modelStatus,
}: {
  voices: Voice[];
  value: string;
  onChange: (v: string) => void;
  model: Provider;
  modelStatus: ServerStatus;
}) {
  const [open, setOpen]               = useState(false);
  const [rect, setRect]               = useState<DOMRect | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [loadingId, setLoadingId]     = useState<string | null>(null);
  const [cache, setCache]             = useState<Map<string, string>>(new Map());
  const sampleAudio                   = useRef<HTMLAudioElement | null>(null);
  const voiceDemos                    = useVoiceDemos();   // bundled preview clips
  const btnRef  = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const sel     = voices.find(v => v.id === value) ?? voices[0];

  function openIt() {
    if (!btnRef.current) return;
    setRect(btnRef.current.getBoundingClientRect());
    setOpen(true);
  }

  // Stop preview when dropdown closes
  function closeIt() {
    sampleAudio.current?.pause();
    setPreviewingId(null);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function h(e: MouseEvent) {
      if (!btnRef.current?.contains(e.target as Node) && !dropRef.current?.contains(e.target as Node))
        closeIt();
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  // Reset preview state when the model changes (cache is keyed by model::voiceId).
  // Adjusted during render — React's "reset state when a value changes" pattern.
  const [prevModel, setPrevModel] = useState(model);
  if (model !== prevModel) {
    setPrevModel(model);
    setPreviewingId(null);
    setCache(new Map());
  }
  // Side effect of a model change: stop any preview that's playing.
  useEffect(() => { sampleAudio.current?.pause(); }, [model]);

  async function previewVoice(e: React.MouseEvent, voice: Voice) {
    e.stopPropagation(); // don't select the voice

    // Toggle off
    if (previewingId === voice.id) {
      sampleAudio.current?.pause();
      setPreviewingId(null);
      return;
    }

    sampleAudio.current?.pause();
    setPreviewingId(null);

    // A bundled pre-rendered demo clip → play it instantly, offline, free (no
    // synthesis, no model download).
    const demo = voiceDemoUrl(voiceDemos, model, voice.id);
    if (demo) {
      const audio = new Audio(demo);
      audio.onended = () => setPreviewingId(null);
      audio.play().catch((err: unknown) => { logDebug("bulk-voice", "Voice demo playback failed", err); setPreviewingId(null); });
      sampleAudio.current = audio;
      setPreviewingId(voice.id);
      return;
    }

    if (modelStatus !== "ready") return;

    const cacheKey = `${model}::${voice.id}`;
    let url = cache.get(cacheKey);

    if (!url) {
      setLoadingId(voice.id);
      try {
        const blob = await localTtsGenerate(model, PREVIEW_TEXT, voice.id, 100);
        url = URL.createObjectURL(blob);
        setCache(prev => new Map(prev).set(cacheKey, url!));
      } catch (e) {
        logDebug("bulk-voice", "Voice preview generation failed", e);
        setLoadingId(null);
        return;
      }
      setLoadingId(null);
    }

    const audio = new Audio(url);
    audio.onended = () => setPreviewingId(null);
    audio.play().catch((e: unknown) => { logDebug("bulk-voice", "Audio preview playback failed", e); setPreviewingId(null); });
    sampleAudio.current = audio;
    setPreviewingId(voice.id);
  }

  const portal = open && rect ? createPortal(
    <div
      ref={dropRef}
      style={{ position: "fixed", top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 290), maxHeight: 340, zIndex: 99999 }}
      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-xl shadow-2xl overflow-y-auto"
    >
      {voices.map((v, i) => {
        const active      = value === v.id;
        const isFemale    = v.gender === "Female";
        const isPreviewing = previewingId === v.id;
        const isLoading   = loadingId === v.id;
        const canPreview  = !!voiceDemoUrl(voiceDemos, model, v.id) || modelStatus === "ready";
        return (
          <div
            key={v.id}
            onClick={() => { onChange(v.id); closeIt(); }}
            className={`flex items-center gap-2.5 px-3.5 py-2 cursor-pointer transition-colors ${
              i > 0 ? "border-t border-zinc-100 dark:border-white/6" : ""
            } ${active ? "bg-violet-500/6" : "hover:bg-zinc-50 dark:hover:bg-white/5"}`}
          >
            {/* Avatar */}
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border overflow-hidden ${
              active ? "bg-violet-500/15 border-violet-400/40" :
              isFemale ? "bg-purple-50 dark:bg-purple-500/10 border-purple-200 dark:border-purple-500/25" :
                         "bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/25"
            }`}>
              {v.avatar ? (
                <img src={v.avatar} alt="" aria-hidden="true" className="h-full w-full object-cover" draggable={false} />
              ) : (
                <span className={`text-[11px] font-bold ${
                  active ? "text-violet-500" : isFemale ? "text-purple-500" : "text-blue-500"
                }`}>{v.name[0]}</span>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <span className={`block text-[12px] font-semibold truncate ${active ? "text-violet-500" : "text-zinc-800 dark:text-zinc-100"}`}>{v.name}</span>
              <span className="block text-[10px] text-zinc-400 truncate">{v.accent} · {v.gender}</span>
            </div>

            {/* Preview play/pause button */}
            {canPreview && (
              <button
                onClick={e => previewVoice(e, v)}
                disabled={!!loadingId && loadingId !== v.id}
                title={isPreviewing ? "Stop preview" : "Play voice demo"}
                className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-none cursor-pointer transition-all ${
                  isPreviewing
                    ? "bg-violet-500 shadow-md shadow-violet-500/30"
                    : isLoading
                      ? "bg-zinc-100 dark:bg-white/8"
                      : "bg-zinc-100 dark:bg-white/8 hover:bg-violet-500/15 hover:scale-110"
                } ${loadingId && loadingId !== v.id ? "opacity-30 cursor-wait" : ""}`}
              >
                {isLoading
                  ? <Loader2 size={10} className="text-violet-500 animate-spin" />
                  : isPreviewing
                    ? <Pause size={10} className="text-white fill-white" />
                    : <Play  size={10} className="text-zinc-500 dark:text-zinc-300" style={{ marginLeft: 1 }} />}
              </button>
            )}

            {/* Selected check */}
            {active && !canPreview && <Check size={11} className="text-violet-500 shrink-0" />}
          </div>
        );
      })}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={btnRef} onClick={openIt}
        className="flex items-center gap-2 h-9 px-3 rounded-xl bg-white dark:bg-white/6 border border-zinc-200 dark:border-white/10 cursor-pointer font-[inherit] hover:border-zinc-300 dark:hover:border-white/20 transition-colors min-w-0"
      >
        <span className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100 truncate">{sel?.name ?? "Select voice"}</span>
        <ChevronDown size={11} className="text-zinc-400 shrink-0" />
      </button>
      {portal}
    </>
  );
}

/* ── Mini Slider ─────────────────────────────────────────────────────── */
function Slider({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min: number; max: number }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="relative flex items-center h-5 w-28">
      <div className="absolute inset-x-0 h-1 rounded-full bg-zinc-200 dark:bg-white/10" />
      <div className="absolute left-0 h-1 rounded-full bg-linear-to-r from-[#3D7EFD] to-[#0047D1]" style={{ width: `${pct}%` }} />
      <div className="absolute w-3 h-3 rounded-full bg-white border-2 border-violet-500 shadow-sm" style={{ left: `calc(${pct}% - 6px)` }} />
      <input type="range" min={min} max={max} step={5} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="absolute inset-0 opacity-0 cursor-pointer" />
    </div>
  );
}

/* ── Script Card ─────────────────────────────────────────────────────── */
function ScriptCard({
  item, index, onUpdate, onRemove, generating,
}: {
  item: ScriptItem;
  index: number;
  onUpdate: (id: string, patch: Partial<ScriptItem>) => void;
  onRemove: (id: string) => void;
  generating: boolean;
}) {
  const STATUS_CFG: Record<ItemStatus, { label: string; color: string; bg: string }> = {
    idle:       { label: "Ready",      color: "#71717a", bg: "rgba(113,113,122,0.1)" },
    generating: { label: "Generating…",color: "#0057FC", bg: "rgba(0,87,252,0.1)"  },
    done:       { label: "Done",       color: "#10b981", bg: "rgba(16,185,129,0.1)"   },
    error:      { label: "Error",      color: "#ef4444", bg: "rgba(239,68,68,0.1)"    },
  };
  const cfg = STATUS_CFG[item.status];

  return (
    <div className={`rounded-2xl border bg-white dark:bg-zinc-900/60 transition-all duration-200 overflow-hidden ${
      item.status === "done"
        ? "border-emerald-200 dark:border-emerald-500/25"
        : item.status === "error"
          ? "border-red-200 dark:border-red-500/25"
          : item.status === "generating"
            ? "border-violet-300 dark:border-violet-500/40"
            : "border-zinc-200 dark:border-white/8"
    }`}>
      {/* Card header */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-zinc-100 dark:border-white/6">
        {/* Index chip */}
        <div className="w-6 h-6 rounded-lg shrink-0 flex items-center justify-center text-[10px] font-bold"
          style={{ background: cfg.bg, color: cfg.color }}>
          {index + 1}
        </div>

        {/* Editable name */}
        <input
          value={item.name}
          onChange={e => onUpdate(item.id, { name: e.target.value })}
          disabled={generating}
          placeholder={`Script ${index + 1}`}
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] font-semibold text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 font-[inherit]"
        />

        {/* Status badge */}
        <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full"
          style={{ background: cfg.bg, color: cfg.color }}>
          {item.status === "generating"
            ? <span className="flex items-center gap-1"><Loader2 size={8} className="animate-spin inline" /> {cfg.label}</span>
            : cfg.label}
        </span>

        {/* Delete */}
        <button
          onClick={() => onRemove(item.id)}
          disabled={generating}
          className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 cursor-pointer border-none bg-transparent text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition disabled:opacity-40"
          title="Remove"
        >
          <X size={12} />
        </button>
      </div>

      {/* Textarea */}
      <div className="px-4 pt-3 pb-3">
        <textarea
          value={item.text}
          onChange={e => onUpdate(item.id, { text: e.target.value })}
          disabled={generating}
          placeholder="Paste your script here…"
          rows={4}
          className="w-full bg-transparent border-none outline-none resize-none text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 font-[inherit] disabled:opacity-60"
        />

        {/* Word count */}
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-zinc-400 tabular-nums">
            {item.text.trim() ? item.text.trim().split(/\s+/).length : 0} words
          </span>
          {item.text.trim() && !generating && (
            <button
              onClick={() => onUpdate(item.id, { text: "" })}
              className="text-[10px] text-zinc-400 hover:text-red-400 transition bg-transparent border-none cursor-pointer font-[inherit]"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Error message */}
      {item.status === "error" && item.error && (
        <div className="mx-4 mb-3 flex items-start gap-2 px-3 py-2 rounded-lg border border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/8">
          <AlertCircle size={11} className="text-red-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-red-600 dark:text-red-400 leading-snug">{item.error}</p>
        </div>
      )}

      {/* Audio player when done */}
      {item.status === "done" && item.audioUrl && item.audioBlob && (
        <div className="px-4 pb-3">
          <MiniPlayer url={item.audioUrl} blob={item.audioBlob} name={item.name || `script-${index + 1}`} />
        </div>
      )}
    </div>
  );
}

/* ── Main Page ───────────────────────────────────────────────────────── */
export default function BulkVoicePage() {
  const [model,   setModel]   = usePreference<Provider>("tts.provider", "kokoro");
  const [voiceId, setVoiceId] = useState<string>(VOICES.kokoro[0].id);
  const [speed,   setSpeed]   = useState(100);

  const [scripts,    setScripts]    = useState<ScriptItem[]>([
    { id: uid(), name: "Script 1", text: "", status: "idle", audioUrl: null, audioBlob: null, error: null },
  ]);
  const [running,    setRunning]    = useState(false);
  const [doneCount,  setDoneCount]  = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef     = useRef(false);

  // Warn before navigating away mid-batch; "Leave & stop" aborts the loop.
  useRegisterTask(running, {
    label: "Bulk Voice",
    kind: "tools",
    onAbort: () => { abortRef.current = true; },
  });

  /* ── Local engine availability (installed on disk?) ─────────────────── */
  // A local voice is offered ONLY once it's installed in Settings → Local AI → Voice.
  // Re-checks on install + focus so it appears live.
  const installedLocal = useInstalledLocalTts();
  const statuses = useMemo<Record<Provider, ServerStatus>>(() => ({
    supertonic: installedLocal.supertonic ? "ready" : "offline",
    kokoro:     installedLocal.kokoro     ? "ready" : "offline",
  }), [installedLocal]);

  /* ── Model changes → reset voice ─────────────────────────────────── */
  // Pick the new engine's first voice (adjusted during render — React's "reset
  // state when a value changes" pattern).
  const [prevModel, setPrevModel] = useState(model);
  if (model !== prevModel) {
    setPrevModel(model);
    setVoiceId(VOICES[model]?.[0]?.id ?? "");
  }
  // Self-heal a stale persisted provider (e.g. a retired engine) so VOICES[model]
  // is never undefined.
  useEffect(() => {
    if (!isLocalTtsModel(model) || !VOICES[model]) setModel("kokoro");
  }, [model, setModel]);

  /* ── Item helpers ─────────────────────────────────────────────────── */
  function updateItem(id: string, patch: Partial<ScriptItem>) {
    setScripts(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }

  function removeItem(id: string) {
    setScripts(prev => {
      const next = prev.filter(s => s.id !== id);
      if (next.length === 0) return [{ id: uid(), name: "Script 1", text: "", status: "idle", audioUrl: null, audioBlob: null, error: null }];
      return next;
    });
  }

  function addBlank() {
    setScripts(prev => [
      ...prev,
      { id: uid(), name: `Script ${prev.length + 1}`, text: "", status: "idle", audioUrl: null, audioBlob: null, error: null },
    ]);
  }

  /* ── TXT file loading ─────────────────────────────────────────────── */
  async function loadTxtFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter(f => f.name.endsWith(".txt") || f.type === "text/plain");
    if (files.length === 0) return;

    const newItems: ScriptItem[] = await Promise.all(
      files.map(async (f) => {
        const text = await f.text();
        const name = f.name.replace(/\.txt$/i, "");
        return { id: uid(), name, text: text.trim(), status: "idle" as ItemStatus, audioUrl: null, audioBlob: null, error: null };
      })
    );

    // Replace blank-only scripts with loaded ones, then append
    setScripts(prev => {
      const nonEmpty = prev.filter(s => s.text.trim());
      return [...nonEmpty, ...newItems];
    });
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) loadTxtFiles(e.target.files);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    loadTxtFiles(Array.from(e.dataTransfer.files));
  }

  /* ── Generate all ─────────────────────────────────────────────────── */
  async function generateAll() {
    const toProcess = scripts.filter(s => s.text.trim() && s.status !== "done");
    if (toProcess.length === 0 || running) return;

    const modelStatus = statuses[model];
    if (modelStatus !== "ready") return;

    abortRef.current = false;
    setRunning(true);
    setDoneCount(0);
    let done = 0;

    // Reset errors / idle all pending
    setScripts(prev => prev.map(s =>
      s.status === "error" || s.status === "idle" ? { ...s, status: "idle", error: null } : s
    ));

    // Global render-dock job so batch progress stays visible across navigation.
    const dockId = useRenderJobs.getState().startJob({
      label: `${toProcess.length} voiceover${toProcess.length > 1 ? "s" : ""}`, kind: "bulk-voice",
      href: typeof window !== "undefined" ? window.location.pathname + window.location.search : "/tools/bulk-voice",
      total: toProcess.length,
    });
    // Auto-save each generated clip to Downloads (the webview ignores `<a download>`,
    // so this is the only way the dock's "Saved to Downloads" is truthful). The first
    // path is attached to the dock so Show-in-folder opens the batch.
    const savedPaths: string[] = [];
    const saveToDownloads = async (blob: Blob, name: string): Promise<void> => {
      try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (!isTauri()) return;
        const { downloadDir, join } = await import("@tauri-apps/api/path");
        const { invokeWithBytes } = await import("@/lib/tauri-bytes");
        const path = await invokeWithBytes<string>("save_bytes", blob, { "dest-path": await join(await downloadDir(), name) });
        savedPaths.push(path);
      } catch (e) { logWarn("bulk-voice", "auto-save to Downloads failed", e); }
    };

    for (const item of toProcess) {
      if (abortRef.current) break;

      updateItem(item.id, { status: "generating", error: null });

      try {
        const blob = await localTtsGenerate(model, item.text, voiceId, speed);

        const url = URL.createObjectURL(blob);
        updateItem(item.id, { status: "done", audioUrl: url, audioBlob: blob });
        const ext = blob.type.includes("wav") ? "wav" : "mp3";
        await saveToDownloads(blob, `${item.name.replace(/[^a-z0-9]/gi, "_") || `script_${done + 1}`}.${ext}`);
        done++;
        setDoneCount(done);
      } catch (e) {
        updateItem(item.id, { status: "error", error: humanizeError(e) });
      }
      useRenderJobs.getState().setProgress(dockId, (done / toProcess.length) * 100, { current: Math.min(done + 1, toProcess.length), total: toProcess.length });
    }

    if (abortRef.current) useRenderJobs.getState().failJob(dockId, "Cancelled");
    else useRenderJobs.getState().finishJob(dockId, savedPaths[0] ? { outputPath: savedPaths[0] } : undefined);
    setRunning(false);
  }

  function stopGeneration() {
    abortRef.current = true;
  }

  async function downloadAll() {
    const done = scripts.filter(s => s.status === "done" && s.audioBlob);
    if (!done.length) return;
    // Native folder picker → write each file (the webview ignores `<a download>`).
    try {
      await saveBlobsToFolder(done.map((s, i) => {
        const ext = s.audioBlob!.type.includes("wav") ? "wav" : "mp3";
        return { blob: s.audioBlob!, name: `${s.name.replace(/[^a-z0-9]/gi, "_") || `script_${i + 1}`}.${ext}` };
      }));
    } catch (e) { surfaceError(e, { operation: "save voiceovers" }); }
  }

  function resetAll() {
    scripts.forEach(s => { if (s.audioUrl) URL.revokeObjectURL(s.audioUrl); });
    setScripts(prev => prev.map(s => ({ ...s, status: "idle", audioUrl: null, audioBlob: null, error: null })));
    setDoneCount(0);
  }

  /* ── Derived ──────────────────────────────────────────────────────── */
  // A local engine appears in the picker only once installed (Settings → Local AI → Voice).
  const visibleModels: ModelDef[] = MODELS.filter(m => statuses[m.id] === "ready");
  const modelStatus   = statuses[model];

  // If the active engine isn't usable (e.g. an uninstalled local voice that's now
  // hidden), fall back to the first ready engine so the picker never sits on a
  // hidden/offline selection. No-ops while nothing is ready yet (all offline).
  useEffect(() => {
    if (statuses[model] !== "offline") return;
    const firstReady = visibleModels.find(m => statuses[m.id] === "ready");
    if (firstReady && firstReady.id !== model) setModel(firstReady.id);
  }, [statuses, model, visibleModels]); // eslint-disable-line react-hooks/exhaustive-deps

  const voices        = VOICES[model] ?? VOICES.kokoro;
  const totalScripts  = scripts.filter(s => s.text.trim()).length;
  const doneScripts   = scripts.filter(s => s.status === "done").length;
  const errorScripts  = scripts.filter(s => s.status === "error").length;
  const canGenerate   = totalScripts > 0 && modelStatus === "ready" && !running;
  const hasDone       = doneScripts > 0;

  /* ── Render ───────────────────────────────────────────────────────── */
  return (
    <AppLayout>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <StudioToolHeader
          icon={Layers}
          title="Bulk Voice Generation"
          accent="#0047D1"
          backHref="/tools"
          backLabel="Tools"
          description="Generate audio for multiple scripts at once — upload TXT files or type manually."
        />
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-8 pt-8 pb-24">

          {/* Settings bar */}
          <div className="flex flex-wrap items-center gap-3 mb-6 p-3.5 rounded-2xl bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 shadow-sm">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-400 shrink-0">
              <Sparkles size={10} className="text-violet-500" /> Settings
            </div>
            <div className="w-px h-4 bg-zinc-200 dark:bg-white/10 shrink-0" />

            {/* Model */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 shrink-0">Model</span>
              <ModelDropdown value={model} onChange={setModel} statuses={statuses} models={visibleModels} />
            </div>

            <div className="w-px h-4 bg-zinc-200 dark:bg-white/10 shrink-0" />

            {/* Voice */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 shrink-0">Voice</span>
              <VoiceDropdown voices={voices} value={voiceId} onChange={setVoiceId} model={model} modelStatus={modelStatus} />
            </div>

            <div className="w-px h-4 bg-zinc-200 dark:bg-white/10 shrink-0" />

            {/* Speed */}
            <div className="flex items-center gap-2.5">
              <Gauge size={11} className="text-zinc-400 shrink-0" />
              <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 shrink-0">Speed</span>
              <Slider value={speed} onChange={setSpeed} min={50} max={200} />
              <span className="text-[11px] font-bold text-violet-500 tabular-nums font-mono">{(speed / 100).toFixed(1)}×</span>
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              {/* Engine status dot */}
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                {modelStatus === "ready"
                  ? <><Wifi size={11} className="text-emerald-500" /> Online</>
                  : modelStatus === "checking"
                    ? <><Loader2 size={11} className="text-violet-500 animate-spin" /> Checking</>
                    : <><WifiOff size={11} className="text-zinc-400" /> Offline</>}
              </span>
            </div>
          </div>

          {/* Not-installed banner */}
          {modelStatus === "offline" && (
            <div className="flex items-start gap-2.5 px-4 py-3 mb-4 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/8">
              <WifiOff size={13} className="text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-[12.5px] font-semibold text-amber-700 dark:text-amber-300">
                  {MODELS.find(m => m.id === model)?.label ?? "This voice"} isn&apos;t installed yet
                </p>
                <p className="text-[11.5px] text-amber-700 dark:text-amber-400 mt-0.5">
                  Install an on-device voice in{" "}
                  <button onClick={() => openSettings("local-ai")} className="underline font-semibold cursor-pointer border-none bg-transparent p-0 text-inherit font-[inherit]">Local AI</button> — it downloads once, then runs offline.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5">

            {/* ── LEFT: TXT upload + script list ── */}
            <div className="flex flex-col gap-4">

              {/* TXT file drop zone */}
              <div
                onDragEnter={e => { e.preventDefault(); setIsDragging(true); }}
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`relative flex flex-col items-center justify-center gap-2 h-[100px] rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-150 ${
                  isDragging
                    ? "border-violet-500 bg-violet-50 dark:bg-violet-500/8"
                    : "border-zinc-300 dark:border-white/20 bg-zinc-50/80 dark:bg-white/[0.04] hover:border-violet-400 hover:bg-violet-50/50 dark:hover:bg-violet-500/5"
                }`}
              >
                <input ref={fileInputRef} type="file" accept=".txt,text/plain" multiple className="hidden" onChange={handleFileInput} />
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${isDragging ? "bg-violet-500" : "bg-zinc-100 dark:bg-white/6"}`}>
                  <Upload size={16} className={isDragging ? "text-white" : "text-zinc-400"} />
                </div>
                <div className="text-center">
                  <p className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">
                    Drop TXT files here
                    <span className="text-zinc-400 font-normal"> or click to browse</span>
                  </p>
                  <p className="text-[11px] text-zinc-400 mt-0.5">Each .txt file = one script · multiple files supported</p>
                </div>
              </div>

              {/* Script cards */}
              <div className="flex flex-col gap-3">
                {scripts.map((item, idx) => (
                  <ScriptCard
                    key={item.id}
                    item={item}
                    index={idx}
                    onUpdate={updateItem}
                    onRemove={removeItem}
                    generating={running}
                  />
                ))}
              </div>

              {/* Add script button */}
              <button
                onClick={addBlank}
                disabled={running}
                className="flex items-center justify-center gap-2 h-10 rounded-2xl border-2 border-dashed border-zinc-200 dark:border-white/10 bg-transparent text-[12.5px] font-semibold text-zinc-500 dark:text-zinc-400 hover:border-violet-400 hover:text-violet-500 hover:bg-violet-50/50 dark:hover:bg-violet-500/5 cursor-pointer transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus size={14} /> Add Script
              </button>
            </div>

            {/* ── RIGHT: Generate + progress ── */}
            <div className="flex flex-col gap-4 lg:sticky lg:top-4 self-start">

              {/* Summary card */}
              <div className="bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 rounded-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-white/6">
                  <Headphones size={13} className="text-violet-500" />
                  <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Generate</span>
                </div>

                <div className="px-4 py-4 flex flex-col gap-3">
                  {/* Stats row */}
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "Scripts",  value: totalScripts, color: "#0057FC" },
                      { label: "Done",     value: doneScripts,  color: "#10b981" },
                      { label: "Errors",   value: errorScripts, color: "#ef4444" },
                    ].map(s => (
                      <div key={s.label} className="flex flex-col items-center gap-0.5 py-2 rounded-xl bg-zinc-50 dark:bg-white/3 border border-zinc-100 dark:border-white/6">
                        <span className="text-[18px] font-extrabold tabular-nums" style={{ color: s.value > 0 ? s.color : "#71717a" }}>{s.value}</span>
                        <span className="text-[9.5px] font-semibold text-zinc-400 uppercase tracking-widest">{s.label}</span>
                      </div>
                    ))}
                  </div>

                  {/* Progress bar (shown while running) */}
                  {running && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] text-zinc-500">Generating…</span>
                        <span className="text-[11px] font-semibold text-violet-500 tabular-nums">{doneCount} / {totalScripts}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-linear-to-r from-[#3D7EFD] to-[#0047D1] transition-all duration-500"
                          style={{ width: `${totalScripts > 0 ? (doneCount / totalScripts) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Generate / Stop button */}
                  {running ? (
                    <button
                      onClick={stopGeneration}
                      className="w-full flex items-center justify-center gap-2 h-10 rounded-xl text-[13px] font-semibold text-white bg-red-500 hover:bg-red-600 cursor-pointer border-none font-[inherit] transition-colors"
                    >
                      <X size={14} /> Stop
                    </button>
                  ) : (
                    <button
                      onClick={generateAll}
                      disabled={!canGenerate}
                      className={`w-full flex items-center justify-center gap-2 h-10 rounded-xl text-[13px] font-semibold cursor-pointer border-none font-[inherit] transition-all ${
                        canGenerate
                          ? "bg-linear-to-br from-[#3D7EFD] to-[#0047D1] text-white hover:brightness-110"
                          : "bg-zinc-100 dark:bg-white/6 text-zinc-400 cursor-not-allowed"
                      }`}
                    >
                      <Headphones size={14} />
                      Generate {totalScripts > 0 ? `${totalScripts} Script${totalScripts > 1 ? "s" : ""}` : "All"}
                    </button>
                  )}

                  {/* Download all + Reset */}
                  {hasDone && !running && (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={downloadAll}
                        className="flex items-center justify-center gap-1.5 h-8 rounded-lg text-[11.5px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 border-none cursor-pointer font-[inherit] transition-colors"
                      >
                        <Download size={11} /> Download All
                      </button>
                      <button
                        onClick={resetAll}
                        className="flex items-center justify-center gap-1.5 h-8 rounded-lg text-[11.5px] font-semibold text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 hover:border-zinc-300 cursor-pointer font-[inherit] transition-colors"
                      >
                        <RotateCcw size={11} /> Reset
                      </button>
                    </div>
                  )}

                  {/* Tip */}
                  <div className="rounded-xl border border-violet-200/60 dark:border-violet-500/15 bg-violet-50/40 dark:bg-violet-500/5 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-violet-500 mb-1">Tip</p>
                    <p className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-relaxed">
                      Scripts run <span className="font-semibold text-zinc-700 dark:text-zinc-300">one at a time</span>. Voices (Kokoro / Supertonic) run on your machine — free, and they download once, then work offline.
                    </p>
                  </div>
                </div>
              </div>

              {/* Done list (quick overview) */}
              {hasDone && (
                <div className="bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 rounded-2xl overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-white/6">
                    <CheckCircle2 size={13} className="text-emerald-500" />
                    <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Completed</span>
                    <span className="ml-auto text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">{doneScripts}</span>
                  </div>
                  <div className="px-4 py-3 flex flex-col gap-1">
                    {scripts.filter(s => s.status === "done").map((s, i) => (
                      <div key={s.id} className="flex items-center gap-2 py-1.5 border-b border-zinc-100 dark:border-white/6 last:border-0">
                        <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                        <span className="flex-1 text-[12px] text-zinc-700 dark:text-zinc-300 truncate">{s.name || `Script ${i + 1}`}</span>
                        {s.audioBlob && (
                          <button
                            onClick={async () => {
                              const ext = s.audioBlob!.type.includes("wav") ? "wav" : "mp3";
                              await saveBlobToDisk(s.audioBlob!, `${s.name.replace(/[^a-z0-9]/gi, "_") || `script`}.${ext}`)
                                .catch(e => surfaceError(e, { operation: "save voiceover" }));
                            }}
                            className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 cursor-pointer border-none bg-emerald-500/10 hover:bg-emerald-500/20 transition"
                          >
                            <Download size={9} className="text-emerald-600 dark:text-emerald-400" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
        </div>
      </div>
    </AppLayout>
  );
}
