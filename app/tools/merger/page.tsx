"use client";
import { useState, useRef, useCallback, useEffect, type DragEvent } from "react";
import AppLayout from "@/components/layout/app-layout";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import { SectionTitle } from "@/components/tools/ui";
import {
  Upload, X, Film, Loader2, AlertCircle, Check,
  Download, Music, Shuffle, Layers, Play, RotateCcw,
  ChevronRight, ChevronDown, Gauge, Zap, Info, Sparkles, Scale,
  Folder,
} from "lucide-react";
import { apiMergePair, type MergeAspect, type MergeQuality } from "@/lib/merger-api";
import { logDebug, logWarn } from "@/lib/log";
import { humanizeError } from "@/lib/error/app-error";
import { saveBlobToDisk, saveBlobsToFolder } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";
import { useRegisterTask } from "@/hooks/use-register-task";
import { useClientValue } from "@/lib/use-client-value";
import { MusicLibraryBrowser } from "@/components/tools/music-library-browser";

/* ─── Types ─────────────────────────────────────────────────────────────── */
type JobStatus = "pending" | "running" | "done" | "error";
type MergeOrder = "a_b" | "b_a" | "random";

/** Minimal File System Access API directory handle (avoids lib.dom version coupling) */
type DirHandle = {
  name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
  queryPermission?(d: { mode: string }): Promise<PermissionState>;
  requestPermission?(d: { mode: string }): Promise<PermissionState>;
};

interface CliFile {
  id:    string;
  file:  File;
}

interface MergeJob {
  id:        string;
  index:     number;    // 1-based display number
  total:     number;    // jobs in the batch — sets the serial's zero-padding
  aClip:     CliFile;
  bClip:     CliFile;
  brollClip: CliFile;  // always the Zone-B clip, regardless of merge order
  status:    JobStatus;
  progress:  number;    // upload progress 0-100
  resultUrl:  string | null;
  resultBlob: Blob | null;
  savedToFolder: boolean; // written to the chosen output folder
  error:     string | null;
}

/* ─── Render quality presets (must match backend QUALITY_MAP) ─────────────── */
const QUALITY_OPTIONS: { value: MergeQuality; title: string; desc: string }[] = [
  { value: "high",     title: "High",     desc: "Best quality · larger files · slower" },
  { value: "balanced", title: "Balanced", desc: "Good quality · moderate size & speed" },
  { value: "fast",     title: "Fast",     desc: "Smaller files · fastest render" },
];

/* ─── Output ratio options ─────────────────────────────────────────────────── */
const ASPECT_OPTIONS: { value: MergeAspect; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "9:16", label: "9:16" },
  { value: "16:9", label: "16:9" },
  { value: "1:1",  label: "1:1" },
  { value: "4:5",  label: "4:5" },
];

/* ─── Output structure (merge order) options ──────────────────────────────── */
const MERGE_ORDER_OPTIONS: { value: MergeOrder; title: string; desc: string; emoji: string }[] = [
  { value: "a_b",    title: "Main clip plays first", desc: "Main clip → then B-Roll",           emoji: "🎬 ➜ 🎞️" },
  { value: "b_a",    title: "B-Roll plays first",    desc: "B-Roll clip → then Main",           emoji: "🎞️ ➜ 🎬" },
  { value: "random", title: "Mix it up",             desc: "Order is randomly picked per pair", emoji: "🔀" },
];

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function uid() { return Math.random().toString(36).slice(2, 11); }

function fmtSize(b: number) {
  if (b < 1_048_576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`;
  return `${(b / 1_073_741_824).toFixed(2)} GB`;
}

function fmtName(name: string, max = 22) {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf(".");
  if (ext > 0) return name.slice(0, max - 4) + "…" + name.slice(ext);
  return name.slice(0, max) + "…";
}

/** Extract a JPEG thumbnail from the first frame of a video file */
async function extractThumb(file: File): Promise<string | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const cleanup = () => { video.src = ""; URL.revokeObjectURL(url); };
    const done = (result: string | null) => { cleanup(); resolve(result); };
    const timer = setTimeout(() => done(null), 6000);

    video.addEventListener("loadeddata", () => {
      video.currentTime = Math.min(0.5, video.duration * 0.05 || 0.1);
    }, { once: true });

    video.addEventListener("seeked", () => {
      clearTimeout(timer);
      try {
        const c = document.createElement("canvas");
        c.width = 160; c.height = 90;
        c.getContext("2d")?.drawImage(video, 0, 0, 160, 90);
        done(c.toDataURL("image/jpeg", 0.72));
      } catch (e) { logDebug("merger", "Thumbnail extraction failed", e); done(null); }
    }, { once: true });

    video.addEventListener("error", () => { clearTimeout(timer); done(null); }, { once: true });
    video.load();
  });
}

/* Thumbnails are extracted lazily — only for the cards actually on screen (the
 * grid shows 11) — and at most THUMB_SLOTS at a time. Each extraction opens its
 * own <video> decoder, so doing all of a 600-file drop at once froze the WebView. */
const THUMB_SLOTS = 2;
let thumbActive = 0;
const thumbWaiting: (() => void)[] = [];
const thumbCache = new WeakMap<File, Promise<string | null>>();

function thumbFor(file: File): Promise<string | null> {
  let p = thumbCache.get(file);
  if (!p) {
    p = (async () => {
      if (thumbActive >= THUMB_SLOTS) await new Promise<void>(r => thumbWaiting.push(r));
      thumbActive++;
      try { return await extractThumb(file); }
      finally { thumbActive--; thumbWaiting.shift()?.(); }
    })();
    thumbCache.set(file, p);
  }
  return p;
}

/** Output filename for a job — its B-roll clip name + a zero-padded serial.
 *  Every job in a batch can share one B-roll, so the serial is what keeps
 *  names unique (same-name saves into a folder would overwrite each other). */
function outName(job: MergeJob) {
  const base   = job.brollClip.file.name.replace(/\.[^/.]+$/, "");
  const serial = String(job.index).padStart(Math.max(2, String(job.total).length), "0");
  return `${base} ${serial}.mp4`;
}

/** Write a blob into a chosen directory, requesting permission if needed. */
async function saveBlobToDir(dir: DirHandle, name: string, blob: Blob) {
  if (dir.queryPermission && dir.requestPermission) {
    let perm = await dir.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await dir.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") throw new Error("Folder write permission denied");
  }
  const fh = await dir.getFileHandle(name, { create: true });
  const w  = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

/** Shuffle array in place (Fisher-Yates) and return it */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

/** Video thumbnail card in the clip grid */
function ClipCard({ clip, onRemove, disabled }: {
  clip: CliFile; onRemove?: () => void; disabled?: boolean;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void thumbFor(clip.file).then(t => { if (alive) setThumb(t); });
    return () => { alive = false; };
  }, [clip.file]);

  return (
    <div className="relative group aspect-video rounded-lg overflow-hidden ring-1 ring-inset ring-black/5 dark:ring-white/10 bg-zinc-200 dark:bg-zinc-800 shadow-sm">
      {thumb
        ? <img src={thumb} alt="" className="w-full h-full object-cover" />
        : (
          <div className="w-full h-full flex items-center justify-center bg-linear-to-br from-zinc-100 to-zinc-200 dark:from-white/5 dark:to-white/2">
            <Film size={16} className="text-zinc-400 dark:text-zinc-600 animate-pulse" />
          </div>
        )
      }
      {/* Play affordance + gradient scrim on hover */}
      <div className="absolute inset-0 bg-linear-to-t from-black/75 via-black/10 to-black/5 opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
      <div className="absolute inset-x-0 bottom-0 px-1.5 pb-1.5 pt-3 translate-y-0.5 group-hover:translate-y-0 opacity-0 group-hover:opacity-100 transition-all duration-200">
        <p className="text-[8.5px] font-semibold text-white truncate leading-tight drop-shadow">{fmtName(clip.file.name, 20)}</p>
      </div>
      {onRemove && !disabled && (
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          title="Remove"
          className="absolute top-1 right-1 w-4.5 h-4.5 rounded-md flex items-center justify-center bg-black/55 backdrop-blur-sm text-white/90 opacity-0 group-hover:opacity-100 transition cursor-pointer border-none hover:bg-red-500 hover:text-white"
        >
          <X size={9} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

/** Drop zone panel for each clip group */
function UploadZone({
  label, accent, clips, onAdd, onRemove, accept, disabled, footnote,
}: {
  label: string; accent: string;
  clips: CliFile[];
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  accept: string; disabled: boolean;
  footnote?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Show up to 11 thumbs (last grid cell is the "add more" tile) + overflow badge */
  const CAP      = 11;
  const shown    = clips.slice(0, CAP);
  const overflow = clips.length > CAP ? clips.length - CAP : 0;
  const hasClips = clips.length > 0;

  const openPicker = () => !disabled && inputRef.current?.click();
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (!disabled && e.dataTransfer.files.length) onAdd(Array.from(e.dataTransfer.files));
  };
  const dragHandlers = {
    onDragEnter: (e: DragEvent) => { e.preventDefault(); if (!disabled) setDragging(true); },
    onDragOver:  (e: DragEvent) => { e.preventDefault(); if (!disabled) setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop,
  };

  return (
    <div>
      {/* Header — plain uppercase label (no accent bar / divider) */}
      <div className="flex items-center justify-between mb-2.5">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-bold uppercase tracking-widest truncate" style={{ color: "rgb(139,139,154)" }}>{label}</span>
          {hasClips && (
            <span className="text-[10px] font-bold tabular-nums px-1.5 py-px rounded-full"
              style={{ color: accent, background: `${accent}1a` }}>
              {clips.length}
            </span>
          )}
        </span>
        {hasClips && !disabled && (
          <button
            onClick={() => onRemove("__all__")}
            className="text-[10px] font-medium text-zinc-400 hover:text-red-400 transition cursor-pointer bg-transparent border-none font-[inherit]"
          >
            Clear
          </button>
        )}
      </div>

      <input
        ref={inputRef} type="file" multiple accept={accept} className="hidden"
        onChange={e => { if (e.target.files) onAdd(Array.from(e.target.files)); e.target.value = ""; }}
      />

      {!hasClips ? (
        /* Empty state — inviting dashed drop row */
        <div
          {...dragHandlers}
          onClick={openPicker}
          className={`flex flex-row items-center gap-3 px-3.5 py-3.5 rounded-xl border-2 border-dashed transition-colors
            ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}
            ${dragging
              ? "border-violet-400 bg-violet-50 dark:bg-violet-500/8"
              : "border-zinc-300 dark:border-white/15 bg-zinc-50/80 dark:bg-white/[0.03] hover:border-violet-400/60 hover:bg-violet-50/40 dark:hover:bg-violet-500/5"
            }`}
        >
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors ${dragging ? "bg-violet-500/15" : "bg-zinc-100 dark:bg-white/6"}`}>
            <Upload size={15} className={dragging ? "text-violet-500" : "text-zinc-400"} />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300 truncate">
              Drop videos <span className="text-zinc-400 font-normal">or click to browse</span>
            </p>
            <p className="text-[10.5px] text-zinc-400">MP4, MOV, AVI, MKV, WebM</p>
          </div>
        </div>
      ) : (
        /* Populated — clean thumbnail grid; whole area still accepts drops */
        <div
          {...dragHandlers}
          className={`rounded-xl p-2 transition-colors border ${
            dragging
              ? "border-violet-400 bg-violet-50/60 dark:bg-violet-500/10"
              : "border-zinc-200/70 dark:border-white/8 bg-zinc-50/50 dark:bg-white/[0.02]"
          }`}
        >
          <div className="grid grid-cols-3 gap-1.5">
            {shown.map(c => (
              <ClipCard key={c.id} clip={c} onRemove={() => onRemove(c.id)} disabled={disabled} />
            ))}
            {overflow > 0 && (
              <div className="aspect-video rounded-lg ring-1 ring-inset ring-black/5 dark:ring-white/10 bg-zinc-100 dark:bg-white/5 flex items-center justify-center">
                <span className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">+{overflow}</span>
              </div>
            )}
            {/* Inline add-more tile */}
            {!disabled && (
              <button
                onClick={openPicker}
                title="Add more videos"
                className="aspect-video rounded-lg border-2 border-dashed border-zinc-300 dark:border-white/15 bg-transparent flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors hover:border-violet-400 hover:bg-violet-50/50 dark:hover:bg-violet-500/8 group"
              >
                <Upload size={13} className="text-zinc-400 group-hover:text-violet-500 transition-colors" />
                <span className="text-[8.5px] font-semibold text-zinc-400 group-hover:text-violet-500 transition-colors">Add</span>
              </button>
            )}
          </div>
        </div>
      )}

      {footnote && <p className="text-[10.5px] text-zinc-400 mt-2 pl-0.5">{footnote}</p>}
    </div>
  );
}

/** Compact job status row in the queue */
function JobRow({ job, onRetry, onPreview }: { job: MergeJob; onRetry?: () => void; onPreview?: () => void }) {
  const STATUS = {
    pending:    { label: "Queued",     color: "#71717a", bg: "rgba(113,113,122,0.1)" },
    running:    { label: "Merging…",   color: "#0057FC", bg: "rgba(0,87,252,0.1)"  },
    done:       { label: "Done",       color: "#10b981", bg: "rgba(16,185,129,0.1)"  },
    error:      { label: "Error",      color: "#ef4444", bg: "rgba(239,68,68,0.1)"   },
  } as const;
  const s = STATUS[job.status];

  function dl() {
    if (!job.resultBlob) return;
    void saveBlobToDisk(job.resultBlob, outName(job)).catch(e => surfaceError(e, { operation: "save video" }));
  }

  return (
    <div className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl border transition-all ${
      job.status === "done"    ? "border-emerald-200 dark:border-emerald-500/20 bg-emerald-50/40 dark:bg-emerald-500/5"
      : job.status === "error" ? "border-red-200 dark:border-red-500/20 bg-red-50/40 dark:bg-red-500/5"
      : job.status === "running" ? "border-violet-200 dark:border-violet-500/20 bg-violet-50/40 dark:bg-violet-500/5"
      : "border-zinc-200 dark:border-white/6 bg-white dark:bg-white/2"
    }`}>
      {/* Index */}
      <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold tabular-nums"
        style={{ background: s.bg, color: s.color }}>
        {job.status === "running" ? <Loader2 size={10} className="animate-spin" /> : job.index}
      </div>

      {/* Clip names */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11.5px]">
          <span className="font-semibold text-zinc-700 dark:text-zinc-200 truncate">{fmtName(job.aClip.file.name, 18)}</span>
          <ChevronRight size={9} className="text-zinc-400 shrink-0" />
          <span className="text-zinc-500 dark:text-zinc-400 truncate">{fmtName(job.bClip.file.name, 18)}</span>
        </div>
        {job.status === "running" && (
          <div className="mt-1 h-0.5 rounded-full bg-zinc-200 dark:bg-white/8 overflow-hidden">
            {/* While uploading: fill by progress%. After upload (100%) animate indeterminate while server processes */}
            {job.progress < 100
              ? <div className="h-full rounded-full bg-linear-to-r from-[#3D7EFD] to-[#0047D1] transition-all" style={{ width: `${job.progress}%` }} />
              : <div className="h-full w-1/2 rounded-full bg-linear-to-r from-[#3D7EFD] to-[#0047D1] origin-left" style={{ animation: "indeterminate 1.4s ease-in-out infinite" }} />
            }
          </div>
        )}
        {job.status === "error" && job.error && (
          <p className="text-[10px] text-red-500 mt-0.5 leading-tight">{job.error}</p>
        )}
      </div>

      {/* Status badge */}
      <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full"
        style={{ background: s.bg, color: s.color }}>
        {s.label}
      </span>

      {/* Retry button (error only) */}
      {job.status === "error" && onRetry && (
        <button onClick={onRetry}
          title="Retry"
          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer border-none bg-red-100 dark:bg-red-500/15 hover:bg-red-200 dark:hover:bg-red-500/25 transition">
          <RotateCcw size={10} className="text-red-500 dark:text-red-400" />
        </button>
      )}

      {/* Saved-to-folder badge */}
      {job.status === "done" && job.savedToFolder && (
        <span title="Saved to output folder" className="shrink-0 flex items-center gap-1 text-[9.5px] font-bold text-emerald-600 dark:text-emerald-400">
          <Folder size={10} /> Saved
        </span>
      )}

      {/* Preview (lightbox) + download */}
      {job.status === "done" && job.resultUrl && (
        <>
          <button onClick={onPreview} title="Preview"
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer border-none bg-emerald-500/10 hover:bg-emerald-500/20 transition">
            <Play size={10} className="text-emerald-600 dark:text-emerald-400 fill-emerald-600 ml-0.5" />
          </button>
          <button onClick={dl} title="Download"
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer border-none bg-zinc-100 dark:bg-white/8 hover:bg-zinc-200 dark:hover:bg-white/15 transition">
            <Download size={10} className="text-zinc-500 dark:text-zinc-400" />
          </button>
        </>
      )}
    </div>
  );
}

/** Fullscreen video preview lightbox */
function Lightbox({ job, onClose, onDownload }: {
  job: MergeJob; onClose: () => void; onDownload: () => void;
}) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-below-titlebar z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
    >
      <div onClick={e => e.stopPropagation()} className="relative w-full max-w-3xl flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: "linear-gradient(135deg,#3D7EFD,#0047D1)" }}>
              <Film size={13} className="text-white" />
            </div>
            <p className="text-[13px] font-semibold text-white truncate">{outName(job)}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onDownload}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 border-none cursor-pointer transition font-[inherit]">
              <Download size={12} /> Download
            </button>
            <button onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer border-none bg-white/10 hover:bg-white/20 text-white transition">
              <X size={14} />
            </button>
          </div>
        </div>
        {/* Player */}
        {job.resultUrl && (
          <video
            src={job.resultUrl}
            controls autoPlay
            className="w-full max-h-[75vh] rounded-2xl bg-black shadow-2xl"
          />
        )}
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */
export default function MergerPage() {
  /* ── Upload state ── */
  const [zoneA,       setZoneA]       = useState<CliFile[]>([]);
  const [zoneB,       setZoneB]       = useState<CliFile[]>([]);
  const [musicFile,   setMusicFile]   = useState<File | null>(null);
  const [musicVol,    setMusicVol]    = useState(30);

  /* ── Settings ── */
  const [mergeOrder,  setMergeOrder]  = useState<MergeOrder>("a_b");
  const [orderOpen,   setOrderOpen]   = useState(false);   // Output-structure dropdown
  const orderRef = useRef<HTMLDivElement>(null);
  const [workers,     setWorkers]     = useState<number>(2);
  const [quality,     setQuality]     = useState<MergeQuality>("high");
  const [aspect,      setAspect]      = useState<MergeAspect>("auto");
  const [qualityOpen, setQualityOpen] = useState(false);   // Render-quality dropdown
  const qualityRef = useRef<HTMLDivElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false); // Advanced options collapsed by default

  /* Close the settings dropdowns on outside click */
  useEffect(() => {
    if (!orderOpen && !qualityOpen) return;
    const handler = (e: MouseEvent) => {
      if (orderOpen   && orderRef.current   && !orderRef.current.contains(e.target as Node))   setOrderOpen(false);
      if (qualityOpen && qualityRef.current && !qualityRef.current.contains(e.target as Node)) setQualityOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [orderOpen, qualityOpen]);

  const selectedOrder   = MERGE_ORDER_OPTIONS.find(o => o.value === mergeOrder) ?? MERGE_ORDER_OPTIONS[0];
  const selectedQuality = QUALITY_OPTIONS.find(o => o.value === quality) ?? QUALITY_OPTIONS[0];

  /* ── Output folder (File System Access API) ── */
  const outputDirRef  = useRef<DirHandle | null>(null);
  const fsSupported = useClientValue(() => "showDirectoryPicker" in window, false);

  /* ── Lightbox preview ── */
  const [previewId,   setPreviewId]   = useState<string | null>(null);

  /* ── Queue ── */
  const [jobs,        setJobs]        = useState<MergeJob[]>([]);
  const [running,     setRunning]     = useState(false);
  const [phase,       setPhase]       = useState<"setup" | "running" | "done">("setup");
  const abortRef = useRef(false);

  // Warn before navigating away mid-merge; "Leave & stop" aborts the queue loop.
  useRegisterTask(running, {
    label: "Bulk Clip Merger",
    kind: "tools",
    onAbort: () => { abortRef.current = true; },
  });

  const WORKER_OPTIONS = [1, 2, 3, 4, 6, 8];

  /** Opens the OS folder picker; returns the chosen handle, or null if cancelled. */
  async function pickOutputDir(): Promise<DirHandle | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle: DirHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      outputDirRef.current = handle;
      return handle;
    } catch (e) { logDebug("merger", "Output folder picker cancelled or unavailable", e); return null; }
  }

  const ACCEPT = ".mp4,.mov,.avi,.mkv,.webm,.m4v,.wmv,.flv,.ts";

  /* ── Add files to a zone (thumbnails load lazily in ClipCard) ── */
  const addToZone = useCallback((incoming: File[], zone: "a" | "b") => {
    const setZone = zone === "a" ? setZoneA : setZoneB;

    setZone(prev => {
      const existingNames = new Set(prev.map(c => c.file.name));
      const newFiles = incoming.filter(f => !existingNames.has(f.name));
      if (newFiles.length === 0) return prev;
      return [...prev, ...newFiles.map(f => ({ id: uid(), file: f }))];
    });
  }, []);

  function removeFromZone(id: string, zone: "a" | "b") {
    const setZone = zone === "a" ? setZoneA : setZoneB;
    if (id === "__all__") { setZone([]); return; }
    setZone(prev => prev.filter(c => c.id !== id));
  }

  /* ── Build job list ── */
  function buildJobs(aClips: CliFile[], bClips: CliFile[]): MergeJob[] {
    return aClips.map((a, i) => {
      const bRaw = bClips[Math.floor(Math.random() * bClips.length)];
      // Merge order
      const [first, second] =
        mergeOrder === "a_b"    ? [a, bRaw]
        : mergeOrder === "b_a"  ? [bRaw, a]
        : Math.random() < 0.5  ? [a, bRaw]
                                : [bRaw, a];
      return {
        id: uid(), index: i + 1, total: aClips.length,
        aClip: first, bClip: second,
        brollClip: bRaw,
        status: "pending", progress: 0,
        resultUrl: null, resultBlob: null, savedToFolder: false, error: null,
      };
    });
  }

  /* ── Process a single job ── */
  function updateJob(id: string, patch: Partial<MergeJob>) {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
  }

  async function processJob(job: MergeJob): Promise<void> {
    if (abortRef.current) {
      updateJob(job.id, { status: "error", error: "Cancelled" });
      return;
    }
    updateJob(job.id, { status: "running", progress: 0 });
    try {
      const blob = await apiMergePair(
        [job.aClip.file, job.bClip.file],
        musicFile,
        musicVol,
        quality,
        pct => updateJob(job.id, { progress: pct }),
        {
          aspect,
          mainIndex: job.aClip === job.brollClip ? 1 : 0,
        },
      );
      const url = URL.createObjectURL(blob);

      // Auto-save to the chosen output folder, if one is set.
      let savedToFolder = false;
      const dir = outputDirRef.current;
      if (dir) {
        try {
          await saveBlobToDir(dir, outName(job), blob);
          savedToFolder = true;
        } catch (err) {
          logWarn("merger", "Folder save failed", err);
        }
      }

      updateJob(job.id, { status: "done", progress: 100, resultUrl: url, resultBlob: blob, savedToFolder });
    } catch (e) {
      updateJob(job.id, { status: "error", error: humanizeError(e) });
    }
  }

  /* ── Retry a single failed job ── */
  function retryJob(jobId: string) {
    setJobs(prev => {
      const job = prev.find(j => j.id === jobId);
      if (!job || job.status === "running") return prev;
      // Reset then kick off immediately outside the setter
      const reset = { ...job, status: "pending" as JobStatus, progress: 0, error: null, resultUrl: null, resultBlob: null, savedToFolder: false };
      // processJob reads state via closure; run after state settles
      setTimeout(() => processJob(reset), 0);
      return prev.map(j => j.id === jobId ? reset : j);
    });
  }

  /* ── Concurrency queue ── */
  async function runQueue(allJobs: MergeJob[], concurrency: number) {
    const pending = [...allJobs];
    let i = 0;

    async function worker() {
      while (!abortRef.current) {
        const job = pending[i++];
        if (!job) break;
        await processJob(job);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  async function startGenerate() {
    if (zoneA.length === 0 || zoneB.length === 0 || running) return;

    // Ask where to save the merged videos first — picking a folder is the
    // gesture that kicks off the batch, and cancelling it cancels the run.
    // (Skipped when the File System Access API is unavailable — outputs are
    // then downloaded manually from the queue.)
    if (fsSupported) {
      const dir = await pickOutputDir();
      if (!dir) return;
    }

    abortRef.current = false;
    const newJobs = buildJobs(zoneA, zoneB);
    setJobs(newJobs);
    setPhase("running");
    setRunning(true);
    await runQueue(newJobs, workers);
    setRunning(false);
    setPhase("done");
  }

  function stopGenerate() {
    abortRef.current = true;
  }

  function resetAll() {
    abortRef.current = true;
    jobs.forEach(j => { if (j.resultUrl) URL.revokeObjectURL(j.resultUrl); });
    setJobs([]);
    setPhase("setup");
    setRunning(false);
  }

  async function downloadAll() {
    const done = jobs.filter(j => j.status === "done" && j.resultBlob);
    if (!done.length) return;
    try {
      await saveBlobsToFolder(done.map(j => ({ blob: j.resultBlob!, name: outName(j) })));
    } catch (e) { surfaceError(e, { operation: "save videos" }); }
  }

  function downloadJob(j: MergeJob) {
    if (!j.resultBlob) return;
    void saveBlobToDisk(j.resultBlob, outName(j)).catch(e => surfaceError(e, { operation: "save video" }));
  }

  /* ── Derived ── */
  const previewJob   = jobs.find(j => j.id === previewId) ?? null;
  const canGenerate  = zoneA.length > 0 && zoneB.length > 0 && !running;
  const totalJobs    = jobs.length;
  const doneJobs     = jobs.filter(j => j.status === "done").length;
  const errorJobs    = jobs.filter(j => j.status === "error").length;
  const pendingJobs  = jobs.filter(j => j.status === "pending").length;
  const runningJob   = jobs.find(j => j.status === "running");
  const pctComplete  = totalJobs > 0 ? ((doneJobs + errorJobs) / totalJobs) * 100 : 0;

  const totalSizeA = zoneA.reduce((s, c) => s + c.file.size, 0);
  const totalSizeB = zoneB.reduce((s, c) => s + c.file.size, 0);

  /* ─ Render ─────────────────────────────────────────────────────────────── */
  return (
    <AppLayout>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        <StudioToolHeader
          icon={Film}
          title="Bulk Clip Merger"
          accent="#3D7EFD"
          backHref="/tools"
          backLabel="Tools"
          description={zoneA.length > 0
            ? `Pair main clips with random B-roll · ${zoneA.length} main · ${zoneB.length} B-roll`
            : "Pair main clips with random B-roll — optional background music on every output."}
        />

        <div className="flex flex-1 min-h-0">
          {/* ── LEFT — controls ── */}
          {/* Glassy/translucent so the app's ambient background shows through —
              seamless with the (transparent) queue panel on the right. */}
          <div className="w-[324px] shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-white/55 dark:bg-zinc-900/40 backdrop-blur-xl overflow-hidden">
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

              {/* Main clips */}
              <UploadZone
                label="Main Clips" accent="#3D7EFD" clips={zoneA}
                onAdd={files => addToZone(files, "a")} onRemove={id => removeFromZone(id, "a")}
                accept={ACCEPT} disabled={running}
                footnote={zoneA.length > 0 ? `${fmtSize(totalSizeA)} total` : undefined}
              />

              {/* B-roll clips */}
              <UploadZone
                label="B-Roll Clips" accent="#0057FC" clips={zoneB}
                onAdd={files => addToZone(files, "b")} onRemove={id => removeFromZone(id, "b")}
                accept={ACCEPT} disabled={running}
                footnote={zoneB.length > 0 ? `${fmtSize(totalSizeB)} · randomly paired` : undefined}
              />

              {/* Pairing info */}
              {zoneA.length > 0 && zoneB.length > 0 && (
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl border border-violet-200 dark:border-violet-500/20 bg-violet-50 dark:bg-violet-500/8">
                  <Info size={12} className="text-violet-500 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-violet-700 dark:text-violet-300 leading-relaxed">
                    <span className="font-semibold">{zoneA.length} main clip{zoneA.length > 1 ? "s" : ""}</span> → each merged with a <span className="font-semibold">random</span> B-roll = <span className="font-semibold">{zoneA.length} output{zoneA.length > 1 ? "s" : ""}</span>.
                  </p>
                </div>
              )}

              {/* Background music */}
              <div>
                <SectionTitle>Background Music</SectionTitle>

                {musicFile ? (
                  /* Selected track chip (from either upload or library) */
                  <div className="flex items-center gap-3 px-3.5 py-3.5 rounded-xl border-2 border-violet-300 dark:border-violet-500/40 bg-violet-50 dark:bg-violet-500/8">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-violet-500">
                      <Music size={15} className="text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-100 truncate">{musicFile.name}</p>
                      <p className="text-[10.5px] text-zinc-400">{fmtSize(musicFile.size)}</p>
                    </div>
                    <button onClick={() => setMusicFile(null)}
                      className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 cursor-pointer border-none bg-violet-200 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 hover:bg-red-100 dark:hover:bg-red-500/20 hover:text-red-500 transition">
                      <X size={10} />
                    </button>
                  </div>
                ) : (
                  <MusicLibraryBrowser onPick={setMusicFile} />
                )}

                {musicFile && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <Gauge size={11} className="text-zinc-400" />
                        <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">Music Volume</span>
                      </div>
                      <span className="text-[11px] font-bold text-violet-500 font-mono">{musicVol}%</span>
                    </div>
                    <div className="relative flex items-center h-5">
                      <div className="absolute inset-x-0 h-1 rounded-full bg-zinc-200 dark:bg-white/10" />
                      <div className="absolute left-0 h-1 rounded-full bg-linear-to-r from-[#3D7EFD] to-[#0047D1]" style={{ width: `${musicVol}%` }} />
                      <div className="absolute w-3.5 h-3.5 rounded-full bg-white border-2 border-violet-500 shadow-sm" style={{ left: `calc(${musicVol}% - 7px)` }} />
                      <input type="range" min={0} max={100} step={5} value={musicVol}
                        onChange={e => setMusicVol(Number(e.target.value))}
                        className="absolute inset-0 opacity-0 cursor-pointer" />
                    </div>
                    <p className="text-[9.5px] text-zinc-400 leading-snug mt-1">Mixed under original clip audio — looped to match video length.</p>
                  </div>
                )}
              </div>

              {/* Advanced options — collapsed by default */}
              <div className="pt-1">
                <button type="button"
                  onClick={() => { const n = !advancedOpen; setAdvancedOpen(n); if (!n) { setOrderOpen(false); setQualityOpen(false); } }}
                  className="w-full flex items-center gap-2 py-1.5 cursor-pointer bg-transparent border-none font-[inherit] group">
                  <ChevronRight size={13} className={`text-zinc-400 shrink-0 transition-transform duration-150 ${advancedOpen ? "rotate-90" : ""}`} />
                  <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "rgb(139,139,154)" }}>Advanced options</span>
                  <span className="flex-1 h-px bg-zinc-200 dark:bg-white/8" />
                  {!advancedOpen && (
                    <span className="text-[9.5px] font-medium text-zinc-400 shrink-0">
                      {selectedQuality.title} · {workers} job{workers > 1 ? "s" : ""}
                    </span>
                  )}
                </button>
              </div>

              {advancedOpen && (
              <div className="space-y-5 pt-1">
              {/* Output structure */}
              <div>
                <SectionTitle>Output Structure</SectionTitle>
                <div ref={orderRef} className="relative">
                  {/* Trigger */}
                  <button type="button" onClick={() => setOrderOpen(v => !v)}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-left cursor-pointer border transition-all font-[inherit] ${
                      orderOpen
                        ? "bg-violet-500/10 border-violet-500/40"
                        : "bg-zinc-50 dark:bg-white/3 border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/15"
                    }`}>
                    <span className="text-base leading-none shrink-0">{selectedOrder.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-semibold leading-tight text-zinc-800 dark:text-zinc-100">{selectedOrder.title}</p>
                      <p className="text-[10.5px] text-zinc-400 mt-0.5 leading-snug truncate">{selectedOrder.desc}</p>
                    </div>
                    <ChevronDown size={14} className={`text-zinc-400 shrink-0 transition-transform duration-150 ${orderOpen ? "rotate-180" : ""}`} />
                  </button>

                  {/* Menu */}
                  {orderOpen && (
                    <div className="absolute z-30 left-0 right-0 top-full mt-1.5 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden">
                      {MERGE_ORDER_OPTIONS.map(opt => (
                        <button key={opt.value} type="button"
                          onClick={() => { setMergeOrder(opt.value); setOrderOpen(false); }}
                          className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-left cursor-pointer border-none transition-colors font-[inherit] ${
                            mergeOrder === opt.value
                              ? "bg-violet-500/10"
                              : "bg-transparent hover:bg-zinc-100 dark:hover:bg-white/5"
                          }`}>
                          <span className="text-base leading-none shrink-0">{opt.emoji}</span>
                          <div className="flex-1 min-w-0">
                            <p className={`text-[12px] font-semibold leading-tight ${mergeOrder === opt.value ? "text-violet-600 dark:text-violet-400" : "text-zinc-800 dark:text-zinc-100"}`}>{opt.title}</p>
                            <p className="text-[10.5px] text-zinc-400 mt-0.5 leading-snug">{opt.desc}</p>
                          </div>
                          {mergeOrder === opt.value && (
                            <div className="w-4 h-4 rounded-full bg-violet-500 flex items-center justify-center shrink-0">
                              <Check size={9} className="text-white" strokeWidth={3} />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Output ratio */}
              <div>
                <SectionTitle>Output Ratio</SectionTitle>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {ASPECT_OPTIONS.map(opt => (
                    <button key={opt.value} type="button" onClick={() => setAspect(opt.value)}
                      className={`h-8 px-3 rounded-lg text-[12px] font-bold cursor-pointer border transition-all font-[inherit] ${
                        aspect === opt.value
                          ? "bg-violet-500/10 border-violet-500/40 text-violet-600 dark:text-violet-400"
                          : "bg-zinc-50 dark:bg-white/4 border-zinc-200 dark:border-white/8 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300"
                      }`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-400 mt-1.5 pl-0.5">
                  {aspect === "auto" ? "Keeps the main clip's shape. " : ""}Resolution is never lowered — output matches your sharpest clip (up to 4K).
                </p>
              </div>

              {/* Render quality */}
              <div>
                <SectionTitle>Render Quality</SectionTitle>
                <div ref={qualityRef} className="relative">
                  {/* Trigger */}
                  <button type="button" onClick={() => setQualityOpen(v => !v)}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-left cursor-pointer border transition-all font-[inherit] ${
                      qualityOpen
                        ? "bg-violet-500/10 border-violet-500/40"
                        : "bg-zinc-50 dark:bg-white/3 border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/15"
                    }`}>
                    <Scale size={13} className="text-violet-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-semibold leading-tight text-zinc-800 dark:text-zinc-100">{selectedQuality.title}</p>
                      <p className="text-[10.5px] text-zinc-400 mt-0.5 leading-snug truncate">{selectedQuality.desc}</p>
                    </div>
                    <ChevronDown size={14} className={`text-zinc-400 shrink-0 transition-transform duration-150 ${qualityOpen ? "rotate-180" : ""}`} />
                  </button>

                  {/* Menu */}
                  {qualityOpen && (
                    <div className="absolute z-30 left-0 right-0 top-full mt-1.5 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden">
                      {QUALITY_OPTIONS.map(opt => (
                        <button key={opt.value} type="button"
                          onClick={() => { setQuality(opt.value); setQualityOpen(false); }}
                          className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-left cursor-pointer border-none transition-colors font-[inherit] ${
                            quality === opt.value
                              ? "bg-violet-500/10"
                              : "bg-transparent hover:bg-zinc-100 dark:hover:bg-white/5"
                          }`}>
                          <Scale size={13} className={quality === opt.value ? "text-violet-500 shrink-0" : "text-zinc-400 shrink-0"} />
                          <div className="flex-1 min-w-0">
                            <p className={`text-[12px] font-semibold leading-tight ${quality === opt.value ? "text-violet-600 dark:text-violet-400" : "text-zinc-800 dark:text-zinc-100"}`}>{opt.title}</p>
                            <p className="text-[10.5px] text-zinc-400 mt-0.5 leading-snug">{opt.desc}</p>
                          </div>
                          {quality === opt.value && (
                            <div className="w-4 h-4 rounded-full bg-violet-500 flex items-center justify-center shrink-0">
                              <Check size={9} className="text-white" strokeWidth={3} />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Parallel jobs */}
              <div>
                <SectionTitle>Parallel Jobs</SectionTitle>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {WORKER_OPTIONS.map(n => (
                    <button key={n} onClick={() => setWorkers(n)}
                      className={`w-9 h-8 rounded-lg text-[12px] font-bold cursor-pointer border transition-all font-[inherit] ${
                        workers === n
                          ? "bg-violet-500/10 border-violet-500/40 text-violet-600 dark:text-violet-400"
                          : "bg-zinc-50 dark:bg-white/4 border-zinc-200 dark:border-white/8 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300"
                      }`}>
                      {n}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-400 mt-1.5 pl-0.5">Concurrent renders — higher = faster but heavier on your machine.</p>
              </div>
              </div>
              )}

            </div>

            {/* Bottom bar */}
            <div className="px-5 py-4 border-t border-zinc-100 dark:border-white/8 shrink-0 space-y-2.5">
              {!running ? (
                <button onClick={startGenerate} disabled={!canGenerate}
                  className="w-full h-10 rounded-xl text-[13px] font-bold text-white cursor-pointer border-none flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                  style={{ background: "linear-gradient(135deg,#3D7EFD,#0047D1)" }}>
                  <Zap size={14} />
                  {zoneA.length === 0 || zoneB.length === 0
                    ? "Add clips to both zones"
                    : `Generate ${zoneA.length} Merged Video${zoneA.length > 1 ? "s" : ""}`}
                </button>
              ) : (
                <button onClick={stopGenerate}
                  className="w-full h-10 rounded-xl text-[13px] font-bold cursor-pointer flex items-center justify-center gap-2 border border-red-500/30 text-red-500 hover:bg-red-500/8 transition-colors">
                  <X size={14} /> Stop · {doneJobs + errorJobs}/{totalJobs}
                </button>
              )}
              {zoneA.length > 0 && zoneB.length > 0 && !running && (
                <p className="text-[10px] text-zinc-400 text-center leading-snug">
                  Each main clip merges with a random B-roll{musicFile ? " + background music" : ""}.{fsSupported ? " You'll choose a save folder before merging." : ""}
                </p>
              )}
            </div>
          </div>

          {/* ── RIGHT — queue / results ── */}
          {/* Transparent so the app's ambient background shows through —
              seamless with the (glassy) controls panel on the left. */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] shrink-0 gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <Film size={13} className="text-violet-500" />
                <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300 truncate">
                  {totalJobs > 0
                    ? (running ? `Merging… ${doneJobs + errorJobs} / ${totalJobs}` : `${pendingJobs ? "Stopped" : "Finished"} — ${doneJobs} done${errorJobs ? `, ${errorJobs} errors` : ""}`)
                    : "Merge queue"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end shrink-0">
                {!running && errorJobs > 0 && (
                  <button onClick={() => jobs.filter(j => j.status === "error").forEach(j => retryJob(j.id))}
                    className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/25 cursor-pointer hover:bg-red-100 dark:hover:bg-red-500/15 transition font-[inherit]">
                    <RotateCcw size={11} /> Retry ({errorJobs})
                  </button>
                )}
                {!running && doneJobs > 0 && (
                  <button onClick={downloadAll}
                    className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 border-none cursor-pointer transition font-[inherit]">
                    <Download size={11} /> Download All ({doneJobs})
                  </button>
                )}
                {totalJobs > 0 && !running && (
                  <button onClick={resetAll}
                    className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 cursor-pointer hover:border-zinc-300 transition font-[inherit]">
                    <RotateCcw size={11} /> New batch
                  </button>
                )}
              </div>
            </div>

            {/* Body */}
            {totalJobs === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 flex items-center justify-center">
                  <Layers size={24} strokeWidth={1.4} className="text-zinc-400" />
                </div>
                <p className="text-[14px] font-semibold text-zinc-500 dark:text-zinc-400">Merged videos appear here</p>
                <p className="text-[12px] text-zinc-400 dark:text-zinc-600 max-w-xs">
                  Add main clips and B-roll, choose your settings, then generate — each output streams in as it finishes.
                </p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {/* Progress */}
                <div className="bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      {running
                        ? <Loader2 size={14} className="animate-spin text-violet-500" />
                        : <Check size={14} className="text-emerald-500" />}
                      <span className="text-[13px] font-bold text-zinc-800 dark:text-zinc-100">
                        {running ? `Merging… ${doneJobs + errorJobs} / ${totalJobs}` : `${pendingJobs ? "Stopped" : "Finished"} — ${doneJobs} done, ${errorJobs} errors`}
                      </span>
                    </div>
                    <span className="text-[10.5px] font-bold text-zinc-500 tabular-nums">{Math.round(pctComplete)}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${pctComplete}%`, background: "linear-gradient(90deg,#3D7EFD,#0047D1)" }} />
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-[10.5px] text-zinc-400">
                    <span className="text-emerald-500 font-semibold">{doneJobs} done</span>
                    {errorJobs > 0 && <span className="text-red-500 font-semibold">{errorJobs} errors</span>}
                    {pendingJobs > 0 && <span>{pendingJobs} queued</span>}
                    {runningJob && <span className="text-violet-500 font-semibold animate-pulse">{workers} running</span>}
                  </div>
                </div>

                {/* Jobs */}
                <div className="flex flex-col gap-1.5">
                  {jobs.map(job => (
                    <JobRow key={job.id} job={job}
                      onRetry={job.status === "error" ? () => retryJob(job.id) : undefined}
                      onPreview={() => setPreviewId(job.id)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Preview lightbox */}
      {previewJob && (
        <Lightbox
          job={previewJob}
          onClose={() => setPreviewId(null)}
          onDownload={() => downloadJob(previewJob)}
        />
      )}

    </AppLayout>
  );
}
