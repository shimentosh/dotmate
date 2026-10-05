"use client";
import { useState, useRef, useLayoutEffect } from "react";
import {
  Music, Upload, X, ArrowUp, ArrowDown, GripVertical,
  ArrowDownUp, ArrowDownAZ, ArrowUpAZ, ArrowDown01, ArrowUp01,
  Play, Pause, Download, CheckCircle, Film,
  Loader2, AlertCircle, Repeat, Clock, Hash, Minus, Plus,
} from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import { SectionTitle } from "@/components/tools/ui";
import { apiMergeAudio } from "@/lib/audio-merger-api";
import { logDebug, logWarn } from "@/lib/log";
import { humanizeError } from "@/lib/error/app-error";
import { saveBlobToDisk, saveBlobsToFolder } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";
import { useRegisterTask } from "@/hooks/use-register-task";
import { useClientValue } from "@/lib/use-client-value";

/** `<base>-<epoch ms>.<ext>` — a unique default file name for a Save dialog. */
function timestampedName(base: string, ext: string): string {
  return `${base}-${Date.now()}.${ext}`;
}

interface AudioItem {
  id: string;
  file: File;
  dur: number | null;
  objUrl: string;
}

function fmtSize(b: number) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDur(s: number | null) {
  if (s === null) return "";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtName(name: string, max = 38) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const ext = name.slice(dot);
    return name.slice(0, max - ext.length - 1) + "…" + ext;
  }
  return name.slice(0, max - 1) + "…";
}

function encodeWav(buf: AudioBuffer): Blob {
  const numCh = buf.numberOfChannels;
  const len   = buf.length;
  const sr    = buf.sampleRate;
  const bps   = 2; // 16-bit PCM
  const data  = new ArrayBuffer(44 + len * numCh * bps);
  const v     = new DataView(data);
  const str   = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  str(0,  "RIFF"); v.setUint32(4,  36 + len * numCh * bps, true);
  str(8,  "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);          // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * bps, true);
  v.setUint16(32, numCh * bps, true);
  v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, len * numCh * bps, true);

  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([data], { type: "audio/wav" });
}

type Mode = "audio" | "video" | "loop";

const AUDIO_ACCEPT = ".mp3,.wav,.m4a,.ogg,.flac,.aac,audio/*";
const AUDIO_FILTER = (f: File) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name);

const MODE_CONFIG = {
  audio: {
    accept:  AUDIO_ACCEPT,
    filter:  AUDIO_FILTER,
    formats: "MP3 · WAV · M4A · OGG · FLAC · AAC",
    drop:    "Drop audio files or",
  },
  video: {
    accept:  ".mp4,.mov,.avi,.mkv,.webm,.m4v,video/*",
    filter:  (f: File) => f.type.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(f.name),
    formats: "MP4 · MOV · AVI · MKV · WEBM",
    drop:    "Drop video files or",
  },
  loop: {
    accept:  AUDIO_ACCEPT,
    filter:  AUDIO_FILTER,
    formats: "MP3 · WAV · M4A · OGG · FLAC · AAC",
    drop:    "Drop a track to loop or",
  },
} satisfies Record<Mode, { accept: string; filter: (f: File) => boolean; formats: string; drop: string }>;

type LoopMode = "count" | "length";
const LOOP_COUNT_PRESETS = [5, 10, 25, 50, 100];
const LOOP_LENGTH_PRESETS = [10, 30, 60, 120]; // minutes

function fmtLongDur(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "0m";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(sec)}s`;
}

type OutFormat = "wav" | "mp3";

const OUTPUT_FORMATS = {
  wav: {
    label: "WAV · Lossless",
    sub:   "Uncompressed — largest, best quality",
    ext:   "wav",
    mime:  "audio/wav",
    accept: { "audio/wav": [".wav"] },
  },
  mp3: {
    label: "MP3 · Compressed",
    sub:   "Small file — great for sharing",
    ext:   "mp3",
    mime:  "audio/mpeg",
    accept: { "audio/mpeg": [".mp3"] },
  },
} satisfies Record<OutFormat, { label: string; sub: string; ext: string; mime: string; accept: Record<string, string[]> }>;

/** Minimal File System Access API directory handle (avoids lib.dom version coupling) */
type DirHandle = {
  name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
  queryPermission?(d: { mode: string }): Promise<PermissionState>;
  requestPermission?(d: { mode: string }): Promise<PermissionState>;
};

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

/** Per-file loop output in the bulk-loop queue. */
type LoopJobStatus = "pending" | "running" | "done" | "error";
interface LoopJob {
  id:        string;
  name:      string;   // input file name
  outName:   string;   // output file name
  loops:     number;   // repeats applied to this file
  status:    LoopJobStatus;
  progress:  number;
  url:       string | null;
  blob:      Blob | null;
  saved:     boolean;
  error:     string | null;
}

export default function AudioMergerPage() {
  const [mode,      setMode]      = useState<Mode>("audio");
  const [format,    setFormat]    = useState<OutFormat>("wav");
  const [loopMode,  setLoopMode]  = useState<LoopMode>("count");
  const [loopCount, setLoopCount] = useState(10);   // "By count" — number of repeats
  const [lengthMin, setLengthMin] = useState(60);   // "By length" — target minutes
  const [items,     setItems]     = useState<AudioItem[]>([]);
  const [dragging,  setDragging]  = useState(false);   // file drop-zone hover
  const [dragId,    setDragId]    = useState<string | null>(null); // row being reordered
  const [sortOpen,  setSortOpen]  = useState(false);   // sort menu open
  const [merging,   setMerging]   = useState(false);
  const [progress,  setProgress]  = useState(0);          // 0-100
  const [phase,     setPhase]     = useState("");          // label shown under bar
  const loopAbort = useRef(false);
  // Warn before navigating away mid-run (it runs on this page, dies on unmount).
  useRegisterTask(merging, { label: "Audio Toolkit", kind: "tools", onAbort: () => { loopAbort.current = true; } });
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [err,       setErr]       = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);  // written to chosen folder
  const fsSupported  = useClientValue(() => "showSaveFilePicker" in window, false);
  const dirSupported = useClientValue(() => "showDirectoryPicker" in window, false);

  // Bulk loop: one output file per input, each looped independently.
  const [loopJobs, setLoopJobs] = useState<LoopJob[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Drag-to-reorder plumbing: a ref per row + its last-measured position, so a
  // FLIP animation can slide rows to their new slots whenever `items` reorders.
  const rowRefs   = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevRects = useRef<Map<string, DOMRect>>(new Map());

  // FLIP — after the list reorders (drag, up/down buttons, or a removal), animate
  // each row from where it WAS to where it now IS, so the movement reads as smooth.
  useLayoutEffect(() => {
    const els  = rowRefs.current;
    const next = new Map<string, DOMRect>();
    els.forEach((el, id) => next.set(id, el.getBoundingClientRect()));
    const reduce = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) {
      els.forEach((el, id) => {
        const before = prevRects.current.get(id);
        const after  = next.get(id);
        if (!before || !after) return;               // freshly-added rows don't slide
        const dy = before.top - after.top;
        if (Math.abs(dy) < 1) return;                // didn't move
        el.getAnimations().forEach(a => a.cancel()); // don't stack rapid swaps
        el.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0px)" }],
          { duration: 190, easing: "cubic-bezier(0.2,0.7,0.2,1)" },
        );
      });
    }
    prevRects.current = next;
  }, [items]);

  /** Move the dragged row to just before/after `targetId` (live, while dragging). */
  function moveRelative(targetId: string, after: boolean) {
    if (!dragId || dragId === targetId) return;
    setItems(prev => {
      if (prev.findIndex(i => i.id === dragId) === -1) return prev;
      const dragged = prev.find(i => i.id === dragId)!;
      const rest    = prev.filter(i => i.id !== dragId);
      const at      = rest.findIndex(i => i.id === targetId) + (after ? 1 : 0);
      rest.splice(at, 0, dragged);
      // No-op if the order didn't actually change — keeps the same array reference
      // so React bails out (dragover fires continuously) and avoids re-animating.
      const same = rest.length === prev.length && rest.every((it, i) => it.id === prev[i].id);
      return same ? prev : rest;
    });
  }

  /** Quick-sort the queue by name or duration. Numeric-aware name compare so
   *  `tts-…818643` orders correctly against `tts-…869813`. FLIP animates it. */
  function sortItems(key: "name" | "dur", dir: "asc" | "desc") {
    setSortOpen(false);
    setItems(prev => {
      const arr = [...prev].sort((a, b) => {
        const c = key === "name"
          ? a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: "base" })
          : (a.dur ?? 0) - (b.dur ?? 0);
        return dir === "asc" ? c : -c;
      });
      const same = arr.every((it, i) => it.id === prev[i].id);
      return same ? prev : arr;
    });
  }

  function getDur(objUrl: string): Promise<number | null> {
    return new Promise(resolve => {
      const a = new Audio(objUrl);
      a.onloadedmetadata = () => resolve(isFinite(a.duration) ? a.duration : null);
      a.onerror = () => resolve(null);
    });
  }

  async function addFiles(newFiles: File[]) {
    const next: AudioItem[] = [];
    for (const f of newFiles) {
      const objUrl = URL.createObjectURL(f);
      const dur    = await getDur(objUrl);
      next.push({ id: crypto.randomUUID(), file: f, dur, objUrl });
    }
    setItems(prev => [...prev, ...next]);
    clearResult();
  }

  function clearResult() {
    setResultUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setErr(null);
    setSavedName(null);
    setLoopJobs(prev => { prev.forEach(j => { if (j.url) URL.revokeObjectURL(j.url); }); return []; });
  }

  function switchMode(m: Mode) {
    if (m === mode) return;
    stopPlay();
    setItems(prev => { prev.forEach(i => URL.revokeObjectURL(i.objUrl)); return []; });
    clearResult();
    setMode(m);
  }

  function remove(id: string) {
    stopPlay();
    setItems(prev => {
      const item = prev.find(i => i.id === id);
      if (item) URL.revokeObjectURL(item.objUrl);
      return prev.filter(i => i.id !== id);
    });
  }

  function move(idx: number, dir: -1 | 1) {
    const t = idx + dir;
    setItems(prev => {
      if (t < 0 || t >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[t]] = [next[t], next[idx]];
      return next;
    });
  }

  function clearAll() {
    stopPlay();
    setItems(prev => { prev.forEach(i => URL.revokeObjectURL(i.objUrl)); return []; });
    clearResult();
  }


  function stopPlay() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
  }

  function togglePlay(item: AudioItem) {
    if (playingId === item.id) { stopPlay(); return; }
    stopPlay();
    const a = new Audio(item.objUrl);
    a.onended = () => setPlayingId(null);
    a.play().catch((e: unknown) => { logDebug("audio-merger", "Audio preview playback failed", e); });
    audioRef.current = a;
    setPlayingId(item.id);
  }


  async function merge() {
    if (!canMerge || merging) return;

    const fmt = OUTPUT_FORMATS[format];

    // Ask where to save the merged file first via the native Save dialog —
    // choosing the file is the gesture that starts the merge, and cancelling it
    // cancels the run. A Save-file handle grants write to just that one file, so
    // (unlike a directory handle) it doesn't trigger a separate permission prompt.
    // Skipped when the File System Access API is unavailable — the result is then
    // offered as a manual download instead.
    let fileHandle: FileSystemFileHandle | null = null;
    if (fsSupported) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: timestampedName("merged", fmt.ext),
          types: [{ description: `${fmt.ext.toUpperCase()} audio`, accept: fmt.accept }],
        });
      } catch (e) {
        logDebug("audio-merger", "Save file picker cancelled or unavailable", e);
        return; // user cancelled the save dialog
      }
    }

    stopPlay();
    setMerging(true);
    setProgress(0);
    setPhase("");
    clearResult();

    try {
      let blob: Blob;

      if (mode === "audio" && format === "wav") {
        // ── Client-side WAV: Web Audio API (no ffmpeg, no round-trip) ───────
        const tmpCtx = new AudioContext();
        const buffers: AudioBuffer[] = [];

        for (let i = 0; i < items.length; i++) {
          setPhase(`Decoding file ${i + 1} of ${items.length}`);
          setProgress(Math.round((i / items.length) * 65));
          const ab  = await items[i].file.arrayBuffer();
          const buf = await tmpCtx.decodeAudioData(ab);
          buffers.push(buf);
        }
        await tmpCtx.close();

        setPhase("Rendering");
        setProgress(70);

        const TARGET_SR    = 44100;
        const numCh        = Math.max(...buffers.map(b => b.numberOfChannels));
        const totalDur     = buffers.reduce((s, b) => s + b.duration, 0);
        const offline      = new OfflineAudioContext(numCh, Math.ceil(totalDur * TARGET_SR), TARGET_SR);

        let t = 0;
        for (const buf of buffers) {
          const src = offline.createBufferSource();
          src.buffer = buf;
          src.connect(offline.destination);
          src.start(t);
          t += buf.duration;
        }

        const rendered = await offline.startRendering();

        setPhase("Encoding WAV");
        setProgress(90);
        blob = encodeWav(rendered);

      } else {
        // ── Local ffmpeg merge (on-device) ──────────────────────────────────
        // Used for MP3 output (needs an encoder) and Video-to-Audio, where
        // decodeAudioData can't demux MP4/MOV containers.
        setPhase(`Merging → ${fmt.ext.toUpperCase()}`);
        blob = await apiMergeAudio(
          items.map(i => i.file),
          format,
          pct => setProgress(Math.min(96, Math.round(pct * 0.96))),
        );
      }

      // Save the result. With a chosen file handle → write it straight to disk;
      // otherwise keep it in-browser for a manual download.
      if (fileHandle) {
        setPhase("Saving");
        setProgress(98);
        const w = await fileHandle.createWritable();
        await w.write(blob);
        await w.close();
        setSavedName(fileHandle.name);
      }

      setProgress(100);
      setPhase("Done");
      setResultUrl(URL.createObjectURL(blob));

    } catch (e: unknown) {
      setErr(humanizeError(e));
    } finally {
      setMerging(false);
    }
  }

  async function download() {
    if (!resultUrl) return;
    try {
      const blob = await fetch(resultUrl).then(r => r.blob());
      await saveBlobToDisk(blob, `merged-${Date.now()}.${OUTPUT_FORMATS[format].ext}`);
    } catch (e) { surfaceError(e, { operation: "save audio" }); }
  }

  /* ── Bulk loop: one looped output per input file ── */
  function loopOutName(name: string, ext: string): string {
    const base = name.replace(/\.[^/.]+$/, "");
    return `${base}-looped.${ext}`;
  }

  function updateLoopJob(id: string, patch: Partial<LoopJob>) {
    setLoopJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
  }

  async function runLoopBatch() {
    if (!canLoop || merging) return;
    const fmt = OUTPUT_FORMATS[format];

    // Bulk output → pick a FOLDER (many files land there). Cancelling cancels the
    // run. Skipped when unsupported — results are offered as manual downloads.
    let dir: DirHandle | null = null;
    if (dirSupported) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dir = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      } catch (e) {
        logDebug("audio-merger", "Directory picker cancelled or unavailable", e);
        return;
      }
    }

    stopPlay();
    loopAbort.current = false;
    clearResult();
    setMerging(true);
    setProgress(0);
    setPhase("");

    const snapshot: LoopJob[] = items.map(it => ({
      id: it.id, name: it.file.name, outName: loopOutName(it.file.name, fmt.ext),
      loops: loopsForItem(it), status: "pending", progress: 0,
      url: null, blob: null, saved: false, error: null,
    }));
    setLoopJobs(snapshot);

    const total = items.length;
    for (let i = 0; i < items.length; i++) {
      if (loopAbort.current) { updateLoopJob(items[i].id, { status: "error", error: "Cancelled" }); continue; }
      const it = items[i];
      const loops = loopsForItem(it);
      setPhase(`Looping ${i + 1} of ${total} · ${fmtName(it.file.name, 22)}`);
      updateLoopJob(it.id, { status: "running", progress: 0 });
      try {
        const blob = await apiMergeAudio(
          [it.file], format,
          pct => { updateLoopJob(it.id, { progress: pct }); setProgress(Math.round(((i + pct / 100) / total) * 100)); },
          loops,
        );
        let saved = false;
        if (dir) {
          try { await saveBlobToDir(dir, snapshot[i].outName, blob); saved = true; }
          catch (err) { logWarn("audio-merger", "Folder save failed", err); }
        }
        updateLoopJob(it.id, { status: "done", progress: 100, blob, url: URL.createObjectURL(blob), saved });
      } catch (e) {
        updateLoopJob(it.id, { status: "error", error: humanizeError(e) });
      }
    }

    setProgress(100);
    setPhase("Done");
    setMerging(false);
  }

  function downloadLoopJob(j: LoopJob) {
    if (!j.blob) return;
    void saveBlobToDisk(j.blob, j.outName).catch(e => surfaceError(e, { operation: "save audio" }));
  }

  async function downloadAllLoops() {
    const done = loopJobs.filter(j => j.status === "done" && j.blob);
    if (!done.length) return;
    try {
      await saveBlobsToFolder(done.map(j => ({ blob: j.blob!, name: j.outName })));
    } catch (e) { surfaceError(e, { operation: "save audio" }); }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(MODE_CONFIG[mode].filter);
    if (files.length) addFiles(files);
  }

  /* ── Loop math ── EACH file loops independently → one output per input file. */
  const knownDurs = items.length > 0 && items.every(i => i.dur !== null);
  const clampedCount = Math.max(1, Math.min(1000, Math.round(loopCount) || 1));
  // Repeats applied to ONE file: fixed in "count" mode; derived from its own
  // duration in "length" mode (falls back to the count if duration unknown).
  const loopsForItem = (it: AudioItem): number =>
    loopMode === "count"
      ? clampedCount
      : (it.dur && it.dur > 0 ? Math.max(1, Math.ceil((lengthMin * 60) / it.dur)) : clampedCount);
  // Example output duration (first track) for the count-mode estimate label.
  const exampleDur   = items.length > 0 && items[0].dur ? items[0].dur * loopsForItem(items[0]) : 0;

  const canLoop  = mode === "loop"  && items.length >= 1;
  const canMerge = mode !== "loop"  && items.length >= 2;
  const canRun   = mode === "loop" ? canLoop : canMerge;

  return (
    <AppLayout>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        <StudioToolHeader
          icon={mode === "loop" ? Repeat : mode === "video" ? Film : Music}
          title="Audio Toolkit"
          accent="#0047D1"
          backHref="/tools"
          backLabel="Tools"
          description={
            mode === "loop"  ? "Loop a track into a long mix — relaxation, study, ambience."
            : mode === "video" ? "Extract and merge the audio from your video files."
            : "Merge multiple audio files into one clean track."}
        />

        <div className="flex flex-1 min-h-0">
          {/* ── LEFT — controls ── */}
          {/* Glassy/translucent so the app's ambient background shows through —
              seamless with the (transparent) queue panel on the right. */}
          <div className="w-[324px] shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-white/55 dark:bg-zinc-900/40 backdrop-blur-xl overflow-hidden">
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

              {/* Function picker — each entry is a first-class audio tool */}
              <div>
                <SectionTitle>Function</SectionTitle>
                <div className="flex flex-col gap-1.5">
                  {([
                    { id: "audio", icon: Music,  label: "Merge Files",    sub: "Combine tracks into one"      },
                    { id: "loop",  icon: Repeat, label: "Loop a Track",   sub: "Repeat into a long mix"       },
                    { id: "video", icon: Film,   label: "Video → Audio",  sub: "Extract audio from video"     },
                  ] as const).map(({ id, icon: Icon, label, sub }) => {
                    const active = mode === id;
                    return (
                      <button key={id} onClick={() => switchMode(id)}
                        className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-left cursor-pointer border transition-all font-[inherit] ${
                          active
                            ? "bg-purple-500/10 border-purple-500/40"
                            : "bg-zinc-50 dark:bg-white/3 border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/15"
                        }`}>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={active ? { background: "#0047D114", border: "1px solid #0047D130" } : { background: "rgba(113,113,122,0.08)" }}>
                          <Icon size={13} strokeWidth={1.8} className={active ? "" : "text-zinc-400 dark:text-zinc-500"} style={active ? { color: "#0047D1" } : {}} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-[12px] font-semibold leading-tight ${active ? "text-purple-600 dark:text-purple-400" : "text-zinc-800 dark:text-zinc-100"}`}>{label}</p>
                          <p className="text-[10.5px] text-zinc-400 mt-0.5 leading-snug">{sub}</p>
                        </div>
                        {active && (
                          <div className="w-4 h-4 rounded-full flex items-center justify-center shrink-0" style={{ background: "#0047D1" }}>
                            <CheckCircle size={9} className="text-white" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Upload */}
              <div>
                <SectionTitle>Upload</SectionTitle>
                <div
                  onDrop={onDrop}
                  onDragOver={e => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onClick={() => inputRef.current?.click()}
                  className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed cursor-pointer transition-all py-7 ${
                    dragging
                      ? "border-purple-400 bg-purple-500/5"
                      : "border-zinc-300 dark:border-white/20 bg-zinc-50/80 dark:bg-white/[0.04] hover:border-purple-400/50 dark:hover:border-white/14"
                  }`}
                >
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ background: "#0047D112", border: "1px solid #0047D122" }}>
                    {mode === "video"
                      ? <Film   size={17} strokeWidth={1.6} style={{ color: "#0047D1" }} />
                      : <Upload size={17} strokeWidth={1.6} style={{ color: "#0047D1" }} />}
                  </div>
                  <p className="text-[12.5px] font-semibold text-zinc-600 dark:text-zinc-400">
                    {MODE_CONFIG[mode].drop} <span style={{ color: "#0047D1" }}>browse</span>
                  </p>
                  <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 text-center px-3">
                    {MODE_CONFIG[mode].formats}
                  </p>
                  <input
                    ref={inputRef} type="file" multiple accept={MODE_CONFIG[mode].accept} className="hidden"
                    onChange={e => { const f = Array.from(e.target.files ?? []); if (f.length) addFiles(f); e.target.value = ""; }}
                  />
                </div>
              </div>

              {/* Loop settings (loop mode only) */}
              {mode === "loop" && (
                <div>
                  <SectionTitle>Loop Settings</SectionTitle>

                  {/* By count / By length toggle */}
                  <div className="flex p-0.5 rounded-lg bg-zinc-100 dark:bg-white/5 mb-2.5">
                    {([
                      { id: "count",  icon: Hash,  label: "By count"  },
                      { id: "length", icon: Clock, label: "By length" },
                    ] as const).map(({ id, icon: Icon, label }) => {
                      const active = loopMode === id;
                      return (
                        <button key={id} onClick={() => { setLoopMode(id); clearResult(); }}
                          className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md text-[11.5px] font-semibold cursor-pointer border-none transition-all font-[inherit] ${
                            active
                              ? "bg-white dark:bg-white/10 text-purple-600 dark:text-purple-400 shadow-sm"
                              : "bg-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                          }`}>
                          <Icon size={12} /> {label}
                        </button>
                      );
                    })}
                  </div>

                  {loopMode === "count" ? (
                    <>
                      {/* Stepper */}
                      <div className="flex items-center gap-2">
                        <button onClick={() => { setLoopCount(c => Math.max(1, c - 1)); clearResult(); }}
                          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 cursor-pointer border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/3 text-zinc-500 dark:text-zinc-400 hover:border-purple-400 hover:text-purple-500 transition">
                          <Minus size={13} />
                        </button>
                        <div className="flex-1 relative">
                          <input type="number" min={1} max={1000} value={loopCount}
                            onChange={e => { const v = parseInt(e.target.value, 10); setLoopCount(isNaN(v) ? 1 : Math.max(1, Math.min(1000, v))); clearResult(); }}
                            className="w-full h-9 text-center text-[15px] font-bold tabular-nums rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/3 text-zinc-800 dark:text-zinc-100 outline-none focus:border-purple-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-zinc-400 pointer-events-none">×</span>
                        </div>
                        <button onClick={() => { setLoopCount(c => Math.min(1000, c + 1)); clearResult(); }}
                          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 cursor-pointer border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/3 text-zinc-500 dark:text-zinc-400 hover:border-purple-400 hover:text-purple-500 transition">
                          <Plus size={13} />
                        </button>
                      </div>
                      {/* Presets */}
                      <div className="flex items-center gap-1.5 mt-2">
                        {LOOP_COUNT_PRESETS.map(n => (
                          <button key={n} onClick={() => { setLoopCount(n); clearResult(); }}
                            className={`flex-1 h-7 rounded-lg text-[11px] font-bold cursor-pointer border transition-all font-[inherit] ${
                              loopCount === n
                                ? "bg-purple-500/10 border-purple-500/40 text-purple-600 dark:text-purple-400"
                                : "bg-zinc-50 dark:bg-white/4 border-zinc-200 dark:border-white/8 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300"
                            }`}>
                            {n}×
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Target length */}
                      <div className="flex items-center gap-2">
                        <input type="number" min={1} max={600} value={lengthMin}
                          onChange={e => { const v = parseInt(e.target.value, 10); setLengthMin(isNaN(v) ? 1 : Math.max(1, Math.min(600, v))); clearResult(); }}
                          className="flex-1 h-9 text-center text-[15px] font-bold tabular-nums rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/3 text-zinc-800 dark:text-zinc-100 outline-none focus:border-purple-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                        <span className="text-[12px] font-semibold text-zinc-500 dark:text-zinc-400 shrink-0">minutes</span>
                      </div>
                      {/* Presets */}
                      <div className="flex items-center gap-1.5 mt-2">
                        {LOOP_LENGTH_PRESETS.map(n => (
                          <button key={n} onClick={() => { setLengthMin(n); clearResult(); }}
                            className={`flex-1 h-7 rounded-lg text-[10.5px] font-bold cursor-pointer border transition-all font-[inherit] ${
                              lengthMin === n
                                ? "bg-purple-500/10 border-purple-500/40 text-purple-600 dark:text-purple-400"
                                : "bg-zinc-50 dark:bg-white/4 border-zinc-200 dark:border-white/8 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300"
                            }`}>
                            {n >= 60 ? `${n / 60}h` : `${n}m`}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {/* Live estimate — EACH file becomes its own looped output */}
                  <div className="flex items-start gap-2 mt-2.5 px-3 py-2 rounded-lg border border-purple-200 dark:border-purple-500/25 bg-purple-50/50 dark:bg-purple-500/8">
                    <Repeat size={12} className="shrink-0 mt-0.5" style={{ color: "#0047D1" }} />
                    <p className="text-[11px] text-zinc-600 dark:text-zinc-300 leading-snug">
                      {items.length === 0 ? (
                        "Add one or more tracks — each is looped into its own file."
                      ) : loopMode === "count" ? (
                        <>
                          <span className="font-bold text-purple-600 dark:text-purple-400">{items.length}</span> track{items.length > 1 ? "s" : ""} → <span className="font-bold text-purple-600 dark:text-purple-400">{items.length}</span> file{items.length > 1 ? "s" : ""}, each looped <span className="font-bold text-purple-600 dark:text-purple-400">{clampedCount}×</span>
                          {knownDurs && exampleDur > 0 ? <> · ~<span className="font-bold text-purple-600 dark:text-purple-400">{fmtLongDur(exampleDur)}</span>{items.length > 1 ? " each" : ""}</> : null}.
                        </>
                      ) : (
                        <>
                          <span className="font-bold text-purple-600 dark:text-purple-400">{items.length}</span> track{items.length > 1 ? "s" : ""} → <span className="font-bold text-purple-600 dark:text-purple-400">{items.length}</span> file{items.length > 1 ? "s" : ""}, each extended to <span className="font-bold text-purple-600 dark:text-purple-400">≈ {lengthMin}m</span>
                          {knownDurs ? "" : " (duration known after decoding)"}.
                        </>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {/* Output */}
              <div>
                <SectionTitle>Output Format</SectionTitle>
                <div className="flex flex-col gap-1.5">
                  {(["wav", "mp3"] as const).map(id => {
                    const f = OUTPUT_FORMATS[id];
                    const active = format === id;
                    return (
                      <button key={id} onClick={() => { setFormat(id); clearResult(); }}
                        className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-left cursor-pointer border transition-all font-[inherit] ${
                          active
                            ? "bg-purple-500/10 border-purple-500/40"
                            : "bg-zinc-50 dark:bg-white/3 border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/15"
                        }`}>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={active ? { background: "#0047D114", border: "1px solid #0047D130" } : { background: "rgba(113,113,122,0.08)" }}>
                          <Music size={13} className={active ? "" : "text-zinc-400 dark:text-zinc-500"} style={active ? { color: "#0047D1" } : {}} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-[12px] font-semibold leading-tight ${active ? "text-purple-600 dark:text-purple-400" : "text-zinc-800 dark:text-zinc-100"}`}>{f.label}</p>
                          <p className="text-[10.5px] text-zinc-400 mt-0.5 leading-snug">{f.sub}</p>
                        </div>
                        {active && (
                          <div className="w-4 h-4 rounded-full flex items-center justify-center shrink-0" style={{ background: "#0047D1" }}>
                            <CheckCircle size={9} className="text-white" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-2 pl-0.5">
                  {mode === "audio" && format === "wav"
                    ? "Merged in your browser — no upload."
                    : "Merged on-device with ffmpeg — no upload."}
                </p>
              </div>
            </div>

            {/* Bottom bar */}
            <div className="px-5 py-4 border-t border-zinc-100 dark:border-white/8 shrink-0 space-y-2.5">
              {merging ? (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin" style={{ color: "#0047D1" }} /> {phase || "Working…"}
                    </span>
                    <span className="text-[11px] font-bold tabular-nums" style={{ color: "#0047D1" }}>{progress}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${progress}%`, background: "linear-gradient(90deg,#0047D1,#0057FC)" }} />
                  </div>
                </div>
              ) : (
                <>
                  {mode === "loop" && items.length === 0 && (
                    <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 text-center">Add one or more tracks to loop</p>
                  )}
                  {mode !== "loop" && items.length === 1 && (
                    <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 text-center">Add at least one more file to merge</p>
                  )}
                  <button
                    onClick={mode === "loop" ? runLoopBatch : merge}
                    disabled={!canRun}
                    className="w-full h-10 rounded-xl text-[13px] font-bold text-white cursor-pointer border-none flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                    style={{ background: "linear-gradient(135deg,#0047D1,#0057FC)" }}
                  >
                    {mode === "loop" ? <Repeat size={14} /> : <Music size={14} />}
                    {mode === "loop"
                      ? (canLoop
                          ? `Loop ${items.length} File${items.length > 1 ? "s" : ""}${loopMode === "count" ? ` · ${clampedCount}× each` : ""}`
                          : "Loop Tracks")
                      : (items.length >= 2 ? `Merge ${items.length} Files` : "Merge Files")}
                  </button>
                  {canRun && (mode === "loop" ? dirSupported : fsSupported) && (
                    <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 text-center leading-snug">
                      {mode === "loop"
                        ? "You'll choose a folder to save the looped files."
                        : "You'll choose where to save the merged file."}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ── RIGHT — files / result ── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] shrink-0 gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <Music size={13} style={{ color: "#0047D1" }} />
                <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300 truncate">
                  {items.length === 0
                    ? "No files yet"
                    : mode === "loop"
                      ? `${items.length} track${items.length !== 1 ? "s" : ""} · each looped${loopMode === "count" ? ` ${clampedCount}×` : ` to ~${lengthMin}m`} → ${items.length} file${items.length !== 1 ? "s" : ""}`
                      : `${items.length} file${items.length !== 1 ? "s" : ""} · plays top → bottom${items.length > 1 ? " · drag to reorder" : ""}`}
                </span>
              </div>
              {items.length > 0 && !merging && (
                <div className="flex items-center gap-2 shrink-0">
                  {/* Quick sort — ascending / descending by name or length */}
                  {items.length > 1 && (
                    <div className="relative">
                      <button onClick={() => setSortOpen(o => !o)}
                        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold cursor-pointer border-none font-[inherit] transition-colors ${
                          sortOpen
                            ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                            : "bg-zinc-100/70 dark:bg-white/5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/70 dark:hover:bg-white/10"
                        }`}>
                        <ArrowDownUp size={12} /> Sort
                      </button>
                      {sortOpen && (
                        <>
                          {/* click-away layer */}
                          <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
                          <div className="absolute right-0 top-full mt-1.5 z-50 w-48 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-lg shadow-black/10 dark:shadow-black/40 py-1.5">
                            {([
                              { key: "name", dir: "asc",  label: "Name",     hint: "A → Z",        icon: ArrowDownAZ },
                              { key: "name", dir: "desc", label: "Name",     hint: "Z → A",        icon: ArrowUpAZ   },
                              { key: "dur",  dir: "asc",  label: "Duration", hint: "short → long", icon: ArrowDown01 },
                              { key: "dur",  dir: "desc", label: "Duration", hint: "long → short", icon: ArrowUp01   },
                            ] as const).map((o, i) => (
                              <button key={i} onClick={() => sortItems(o.key, o.dir)}
                                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left cursor-pointer bg-transparent border-none hover:bg-zinc-100 dark:hover:bg-white/8 transition-colors font-[inherit]">
                                <o.icon size={13} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
                                <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">{o.label}</span>
                                <span className="ml-auto text-[10.5px] text-zinc-400 dark:text-zinc-500">{o.hint}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  <button onClick={clearAll}
                    className="text-[11px] font-semibold text-zinc-400 hover:text-red-500 cursor-pointer bg-transparent border-none font-[inherit] transition-colors">
                    Clear all
                  </button>
                </div>
              )}
            </div>

            {/* Body */}
            {items.length === 0 && !resultUrl ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 flex items-center justify-center">
                  <Music size={24} strokeWidth={1.4} className="text-zinc-400" />
                </div>
                <p className="text-[14px] font-semibold text-zinc-500 dark:text-zinc-400">
                  {mode === "loop" ? "No tracks loaded" : "Your merge queue is empty"}
                </p>
                <p className="text-[12px] text-zinc-400 dark:text-zinc-600 max-w-xs">
                  {mode === "loop"
                    ? `Add one or more tracks — each is looped into its own long ${OUTPUT_FORMATS[format].ext.toUpperCase()} file. Great for hours of relaxation or study music.`
                    : `Add two or more files on the left, drag them into order, then merge into a single ${OUTPUT_FORMATS[format].ext.toUpperCase()} track.`}
                </p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-5 space-y-4">

                {/* Error */}
                {err && (
                  <div className="flex items-start gap-2 rounded-xl border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/8 px-4 py-3">
                    <AlertCircle size={13} className="text-red-500 shrink-0 mt-0.5" />
                    <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{err}</p>
                  </div>
                )}

                {/* Result */}
                {resultUrl && (
                  <div className="rounded-2xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/50 dark:bg-emerald-500/5 p-4">
                    <div className="flex items-center justify-between mb-3 gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <CheckCircle size={14} className="text-emerald-500 shrink-0" />
                        <div className="min-w-0">
                          <span className="block text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                            {savedName ? "Merged & saved to your folder" : "Merged — ready to download"}
                          </span>
                          {savedName && (
                            <span className="block text-[11px] text-emerald-600 dark:text-emerald-400 truncate">{savedName}</span>
                          )}
                        </div>
                      </div>
                      <button onClick={download}
                        className="flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold text-white cursor-pointer border-none hover:opacity-90 transition-opacity shadow-sm shrink-0"
                        style={{ background: "linear-gradient(135deg,#0047D1,#0057FC)" }}>
                        <Download size={12} /> Download {OUTPUT_FORMATS[format].ext.toUpperCase()}
                      </button>
                    </div>
                    {/* color-scheme makes Chrome render its dark-themed native
                        audio controls in dark mode (default chrome is white). */}
                    <audio src={resultUrl} controls className="w-full rounded-lg [color-scheme:light] dark:[color-scheme:dark]" />
                  </div>
                )}

                {/* Loop results — one output per input file */}
                {mode === "loop" && loopJobs.length > 0 && (
                  <div className="rounded-2xl border border-purple-200 dark:border-purple-500/25 bg-purple-50/40 dark:bg-purple-500/5 p-4">
                    <div className="flex items-center justify-between mb-3 gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        {merging
                          ? <Loader2 size={14} className="animate-spin shrink-0" style={{ color: "#0047D1" }} />
                          : <CheckCircle size={14} className="text-emerald-500 shrink-0" />}
                        <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">
                          {merging
                            ? `Looping… ${loopJobs.filter(j => j.status === "done" || j.status === "error").length} / ${loopJobs.length}`
                            : `${loopJobs.filter(j => j.status === "done").length} looped file${loopJobs.filter(j => j.status === "done").length !== 1 ? "s" : ""} ready`}
                        </span>
                      </div>
                      {!merging && loopJobs.some(j => j.status === "done" && !j.saved && j.blob) && (
                        <button onClick={downloadAllLoops}
                          className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold text-white cursor-pointer border-none hover:opacity-90 transition-opacity shadow-sm shrink-0"
                          style={{ background: "linear-gradient(135deg,#0047D1,#0057FC)" }}>
                          <Download size={12} /> Download all
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {loopJobs.map(j => (
                        <div key={j.id}
                          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border ${
                            j.status === "done"    ? "border-emerald-200 dark:border-emerald-500/20 bg-emerald-50/60 dark:bg-emerald-500/5"
                            : j.status === "error" ? "border-red-200 dark:border-red-500/20 bg-red-50/60 dark:bg-red-500/5"
                            : j.status === "running" ? "border-purple-200 dark:border-purple-500/25 bg-white dark:bg-white/3"
                            : "border-zinc-200 dark:border-white/8 bg-white dark:bg-white/2"
                          }`}>
                          <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0">
                            {j.status === "running" ? <Loader2 size={11} className="animate-spin" style={{ color: "#0047D1" }} />
                              : j.status === "done"  ? <CheckCircle size={12} className="text-emerald-500" />
                              : j.status === "error" ? <AlertCircle size={12} className="text-red-500" />
                              : <Repeat size={11} className="text-zinc-400" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] font-medium text-zinc-800 dark:text-zinc-200 truncate">{fmtName(j.outName, 34)}</p>
                            {j.status === "running" && (
                              <div className="mt-1 h-0.5 rounded-full bg-zinc-200 dark:bg-white/8 overflow-hidden">
                                <div className="h-full rounded-full transition-all" style={{ width: `${j.progress}%`, background: "linear-gradient(90deg,#0047D1,#0057FC)" }} />
                              </div>
                            )}
                            {j.status === "error" && j.error && (
                              <p className="text-[10px] text-red-500 leading-tight mt-0.5">{j.error}</p>
                            )}
                            {j.status === "done" && (
                              <p className="text-[10px] text-zinc-400 dark:text-zinc-500">looped {j.loops}× {j.saved ? "· saved to folder" : ""}</p>
                            )}
                          </div>
                          {j.status === "done" && j.blob && (
                            <button onClick={() => downloadLoopJob(j)} title="Download"
                              className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 cursor-pointer border-none bg-zinc-100 dark:bg-white/8 hover:bg-zinc-200 dark:hover:bg-white/15 transition">
                              <Download size={11} className="text-zinc-500 dark:text-zinc-400" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* File list */}
                {items.length > 0 && (
                  <div className="rounded-xl border border-zinc-200 dark:border-white/8 bg-white dark:bg-zinc-900 overflow-hidden divide-y divide-zinc-100 dark:divide-white/[0.05]">
                    {items.map((item, idx) => {
                      const isDragging = dragId === item.id;
                      return (
                      <div key={item.id}
                        ref={el => { if (el) rowRefs.current.set(item.id, el); else rowRefs.current.delete(item.id); }}
                        draggable={!merging}
                        onDragStart={e => {
                          setDragId(item.id);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", item.id);
                        }}
                        onDragOver={e => {
                          if (!dragId || dragId === item.id) return;
                          e.preventDefault(); // allow drop + keep the drag alive
                          const r = e.currentTarget.getBoundingClientRect();
                          moveRelative(item.id, e.clientY > r.top + r.height / 2);
                        }}
                        onDragEnd={() => setDragId(null)}
                        onDrop={e => { e.preventDefault(); setDragId(null); }}
                        className={`flex items-center gap-2.5 px-4 py-3 group transition-colors ${
                          isDragging
                            ? "opacity-40 bg-purple-500/[0.06]"
                            : "hover:bg-zinc-50 dark:hover:bg-white/[0.03]"
                        } ${merging ? "" : "cursor-grab active:cursor-grabbing"}`}>

                        <GripVertical size={14}
                          className="shrink-0 text-zinc-300 dark:text-zinc-600 group-hover:text-zinc-400 dark:group-hover:text-zinc-500 transition-colors" />

                        <span className="text-[11px] font-bold text-zinc-400 dark:text-zinc-600 w-4 tabular-nums text-right shrink-0">{idx + 1}</span>

                        <button onClick={() => togglePlay(item)}
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border transition-all cursor-pointer"
                          style={playingId === item.id
                            ? { background: "#0047D114", borderColor: "#0047D140" }
                            : { background: "transparent", borderColor: "rgb(228 228 231 / 0.5)" }}
                          title={playingId === item.id ? "Pause" : "Preview"}>
                          {playingId === item.id
                            ? <Pause size={11} strokeWidth={2.2} style={{ color: "#0047D1" }} />
                            : <Play  size={11} strokeWidth={2.2} className="text-zinc-400 dark:text-zinc-500 translate-x-px" />}
                        </button>

                        <div className="flex-1 min-w-0">
                          <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200 truncate">{fmtName(item.file.name)}</p>
                          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                            {fmtSize(item.file.size)}{item.dur ? <span className="ml-1.5">{fmtDur(item.dur)}</span> : null}
                          </p>
                        </div>

                        <div className="flex flex-col gap-0.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => move(idx, -1)} disabled={idx === 0} title="Move up"
                            className="w-5 h-5 flex items-center justify-center rounded text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-white/8 hover:text-purple-500 disabled:opacity-25 cursor-pointer disabled:cursor-not-allowed bg-transparent border-none transition-colors">
                            <ArrowUp size={10} />
                          </button>
                          <button onClick={() => move(idx, 1)} disabled={idx === items.length - 1} title="Move down"
                            className="w-5 h-5 flex items-center justify-center rounded text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-white/8 hover:text-purple-500 disabled:opacity-25 cursor-pointer disabled:cursor-not-allowed bg-transparent border-none transition-colors">
                            <ArrowDown size={10} />
                          </button>
                        </div>

                        <button onClick={() => remove(item.id)} title="Remove"
                          className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/8 bg-transparent border-none cursor-pointer transition-colors">
                          <X size={12} />
                        </button>
                      </div>
                      );
                    })}
                  </div>
                )}

                {items.length > 0 && (
                  <button onClick={() => inputRef.current?.click()}
                    className="text-[11.5px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 bg-transparent border-none cursor-pointer transition-colors">
                    + Add more files
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
