"use client";
import { logDebug, logWarn } from "@/lib/log";
import { humanizeError } from "@/lib/error/app-error";
import { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload, X, Film, Trash2, CheckCircle2, AlertCircle,
  Loader2, Download, Play, Pause, Zap, Clock,
  Scissors, FileVideo, StopCircle, RotateCcw, SkipForward,
  ChevronLeft, ChevronRight, SlidersHorizontal,
} from "lucide-react";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import { FieldLabel, SectionTitle } from "@/components/tools/ui";
import { FloatingPanel, PANEL_INPUT } from "@/components/tools/floating-panel";
import { useRegisterTask } from "@/hooks/use-register-task";
import { saveBlobToDisk } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";

/* ─── Types ──────────────────────────────────────────────────────────────── */

type TrimMode = "keep-start" | "remove-start" | "keep-end" | "remove-end" | "custom-range";
type VideoStatus = "idle" | "loading-meta" | "ready" | "processing" | "done" | "error";

interface VideoEntry {
  id: string;
  file: File;
  name: string;
  sizeBytes: number;
  duration: number | null;
  videoWidth: number;
  videoHeight: number;
  status: VideoStatus;
  progress: number;
  error?: string;
  outputBlob?: Blob;
}

const TRIM_MODES: { id: TrimMode; label: string; desc: string }[] = [
  { id: "keep-start",   label: "Keep Start",    desc: "Save first N seconds, remove rest" },
  { id: "remove-start", label: "Remove Start",  desc: "Cut first N seconds, keep rest" },
  { id: "keep-end",     label: "Keep End",      desc: "Save last N seconds, remove rest" },
  { id: "remove-end",   label: "Remove End",    desc: "Cut last N seconds, keep rest" },
  { id: "custom-range", label: "Custom Range",  desc: "Drag handles to set keep zone" },
];

function MiniTrimBar({ mode, active }: { mode: TrimMode; active: boolean }) {
  const keep   = active ? "#0057FC" : "rgba(113,113,122,0.35)";
  const remove = active ? "rgba(0,87,252,0.12)" : "rgba(113,113,122,0.08)";
  const segs: [number, string][] = {
    "keep-start":   [[0.5, keep],  [0.5, remove]],
    "remove-start": [[0.5, remove],[0.5, keep]],
    "keep-end":     [[0.55, remove],[0.45, keep]],
    "remove-end":   [[0.55, keep], [0.45, remove]],
    "custom-range": [[0.22, remove],[0.56, keep],[0.22, remove]],
  }[mode] as [number, string][];
  return (
    <div className="flex w-full h-[5px] rounded-full overflow-hidden gap-px">
      {segs.map(([flex, bg], i) => (
        <div key={i} style={{ flex, background: bg, borderRadius: 99 }} />
      ))}
    </div>
  );
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function fmtDur(s: number | null): string {
  if (s === null || !isFinite(s)) return "…";
  const totalCs = Math.max(0, Math.round(s * 100));
  const m = Math.floor(totalCs / 6000);
  const sec = Math.floor((totalCs % 6000) / 100);
  const cs = String(totalCs % 100).padStart(2, "0");
  return `${m}:${String(sec).padStart(2, "0")}.${cs}`;
}

/** Snap a time value to centisecond (0.01s) precision for fine selection. */
const snap2 = (t: number) => Math.round(t * 100) / 100;

function fmtSize(b: number): string {
  return b < 1_048_576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1_048_576).toFixed(1)} MB`;
}

function getVideoMeta(file: File): Promise<{ duration: number; videoWidth: number; videoHeight: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const r = { duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight };
      URL.revokeObjectURL(url); v.src = "";
      resolve(r);
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read metadata")); };
    v.src = url;
  });
}

function computeKeepZone(
  mode: TrimMode,
  duration: number,
  trimDur: number,
  rangeStart: number,
  rangeEnd: number,
): [number, number] {
  const d = duration;
  switch (mode) {
    case "keep-start":   return [0, Math.min(trimDur, d)];
    case "remove-start": return [Math.min(trimDur, d), d];
    case "keep-end":     return [Math.max(0, d - trimDur), d];
    case "remove-end":   return [0, Math.max(0, d - trimDur)];
    case "custom-range": return [Math.min(rangeStart, d), Math.min(Math.max(rangeStart + 0.1, rangeEnd), d)];
  }
}

function getOutputDur(mode: TrimMode, dur: number | null, trimDur: number, rs: number, re: number): number | null {
  if (dur === null) return null;
  const [from, to] = computeKeepZone(mode, dur, trimDur, rs, re);
  return Math.max(0, to - from);
}

function downloadBlob(blob: Blob, name: string) {
  // Native Save dialog on desktop (the webview ignores `<a download>`); `<a download>`
  // on web. Fire-and-forget — callers don't await.
  void saveBlobToDisk(blob, name).catch(e => surfaceError(e, { operation: "save video" }));
}

/* ─── Core trim engine ───────────────────────────────────────────────────── */

async function trimVideo(
  file: File,
  keepFrom: number,
  keepTo: number,
  outputFps: number,
  onProgress: (p: number) => void,
  signal: AbortSignal,
  pauseRef: React.MutableRefObject<boolean>,
): Promise<Blob> {
  const keepDur = keepTo - keepFrom;
  if (keepDur < 0.05) throw new Error(`Keep duration too short (${keepDur.toFixed(2)}s)`);

  const srcUrl = URL.createObjectURL(file);
  try {
    const { videoWidth: w, videoHeight: h } = await getVideoMeta(file);

    const {
      Output, CanvasSource, Mp4OutputFormat,
      QUALITY_HIGH, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
      Input, BlobSource, AudioBufferSink, AudioBufferSource, ALL_FORMATS,
    } = await import("mediabunny");
    const { createMp4Writer } = await import("@/lib/mp4-disk-writer");

    const codec = await getFirstEncodableVideoCodec(
      ["avc", "hevc", "vp9", "av1", "vp8"],
      { width: w, height: h, bitrate: QUALITY_HIGH },
    );
    if (!codec) throw new Error("Browser lacks video encoding. Use Chrome or Edge.");

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    const videoSource = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
    // Stream the encode to disk (desktop) so the whole MP4 never sits in the heap.
    const writer = await createMp4Writer();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: writer.fastStart }), target: writer.target });
    output.addVideoTrack(videoSource);

    // Wire up audio if the source has an audio track
    let audioSource: InstanceType<typeof AudioBufferSource> | null = null;
    let audioSink:   InstanceType<typeof AudioBufferSink>   | null = null;
    let inputHandle: InstanceType<typeof Input>             | null = null;
    try {
      const audioCodec = await getFirstEncodableAudioCodec(["aac", "opus"]);
      if (audioCodec) {
        inputHandle = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
        const audioTrack = await inputHandle.getPrimaryAudioTrack();
        if (audioTrack) {
          audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 128_000 });
          audioSink   = new AudioBufferSink(audioTrack);
          output.addAudioTrack(audioSource);
        }
      }
    } catch (e) { logDebug("quick-trim", "No audio track — continuing video-only", e); }

    await output.start();

    const video = document.createElement("video");
    video.muted = true;
    video.src = srcUrl;
    await new Promise<void>(res => {
      video.onloadeddata = () => res();
      video.onerror = () => res();
      setTimeout(res, 6000);
    });

    const frameCount = Math.ceil(keepDur * outputFps);
    for (let i = 0; i < frameCount; i++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      while (pauseRef.current) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        await new Promise(r => setTimeout(r, 80));
      }
      video.currentTime = keepFrom + i / outputFps;
      await new Promise<void>(res => {
        const t = setTimeout(res, 2500);
        video.onseeked = () => { clearTimeout(t); res(); };
      });
      ctx.drawImage(video, 0, 0, w, h);
      await videoSource.add(i / outputFps, 1 / outputFps);
      onProgress((i + 1) / frameCount);
    }

    video.src = "";
    videoSource.close();

    // Feed audio buffers from the keep zone
    if (audioSource && audioSink) {
      for await (const wrapped of audioSink.buffers(keepFrom, keepTo)) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        await audioSource.add(wrapped.buffer);
      }
      audioSource.close();
    }

    await output.finalize();
    inputHandle?.dispose?.();
    return await writer.getBlob();
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}

/* ─── VideoRow ───────────────────────────────────────────────────────────── */

function VideoRow({
  entry, outputDur, selected, onSelect, onRemove, onDownload, onRetry,
}: {
  entry: VideoEntry;
  outputDur: number | null;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onDownload: () => void;
  onRetry: () => void;
}) {
  const pct = entry.progress * 100;

  return (
    <div
      onClick={onSelect}
      className={`group relative flex flex-col gap-1.5 p-2.5 rounded-xl border cursor-pointer transition-all ${
        selected
          ? "border-violet-400/50 bg-violet-500/5 dark:bg-violet-500/8"
          : entry.status === "done"
          ? "border-emerald-500/25 bg-emerald-500/3"
          : entry.status === "error"
          ? "border-red-500/25 bg-zinc-50 dark:bg-white/3"
          : "border-zinc-100 dark:border-white/8 bg-zinc-50 dark:bg-white/3 hover:border-zinc-200 dark:hover:border-white/12"
      }`}
    >
      <div className="flex items-center gap-2">
        {/* status icon */}
        <div className="shrink-0 mt-0.5">
          {entry.status === "processing"    && <Loader2    size={13} className="text-violet-500 animate-spin" />}
          {entry.status === "done"          && <CheckCircle2 size={13} className="text-emerald-500" />}
          {entry.status === "error"         && <AlertCircle  size={13} className="text-red-500" />}
          {entry.status === "loading-meta"  && <Loader2    size={13} className="text-zinc-400 animate-spin" />}
          {(entry.status === "ready" || entry.status === "idle") && <FileVideo size={13} className="text-zinc-400" />}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[11.5px] font-semibold text-zinc-800 dark:text-zinc-200 truncate">{entry.name}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-zinc-400 tabular-nums">{fmtDur(entry.duration)}</span>
            {outputDur !== null && (
              <>
                <span className="text-zinc-300 dark:text-zinc-600 text-[9px]">→</span>
                <span className="text-[10px] font-semibold text-violet-500 tabular-nums">{fmtDur(outputDur)}</span>
              </>
            )}
            <span className="text-[10px] text-zinc-300 dark:text-zinc-600">{fmtSize(entry.sizeBytes)}</span>
            {entry.videoWidth > 0 && (
              <span className="text-[10px] text-zinc-300 dark:text-zinc-600 hidden group-hover:inline">
                {entry.videoWidth}×{entry.videoHeight}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {entry.status === "done" && (
            <button onClick={e => { e.stopPropagation(); onDownload(); }}
              className="w-6 h-6 flex items-center justify-center rounded-md text-emerald-500 hover:bg-emerald-500/10 cursor-pointer border-none bg-transparent transition-colors" title="Download">
              <Download size={11} />
            </button>
          )}
          {entry.status === "error" && (
            <button onClick={e => { e.stopPropagation(); onRetry(); }}
              className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-violet-500 hover:bg-violet-500/10 cursor-pointer border-none bg-transparent transition-colors" title="Retry">
              <RotateCcw size={11} />
            </button>
          )}
          {(entry.status === "ready" || entry.status === "idle" || entry.status === "error") && (
            <button onClick={e => { e.stopPropagation(); onRemove(); }}
              className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-500/8 cursor-pointer border-none bg-transparent transition-colors" title="Remove">
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {(entry.status === "processing" || entry.status === "done") && (
        <div className="h-1 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-200"
            style={{
              width: `${entry.status === "done" ? 100 : pct}%`,
              background: entry.status === "done"
                ? "linear-gradient(90deg,#10b981,#059669)"
                : "var(--brand-gradient)",
            }} />
        </div>
      )}

      {entry.status === "error" && entry.error && (
        <p className="text-[10px] text-red-500/80 pl-5 line-clamp-1">{entry.error}</p>
      )}
    </div>
  );
}

/* ─── VideoPreview ───────────────────────────────────────────────────────── */

function VideoPreview({
  entry, trimMode, trimDur, rangeStart, rangeEnd, outputFps,
  onRangeChange, onTrimDurChange,
}: {
  entry: VideoEntry | null;
  trimMode: TrimMode;
  trimDur: number;
  rangeStart: number;
  rangeEnd: number;
  outputFps: number;
  onRangeChange: (start: number, end: number) => void;
  onTrimDurChange: (dur: number) => void;
}) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const barRef    = useRef<HTMLDivElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const dragging = useRef<"start" | "end" | "playhead" | "boundary" | null>(null);

  useEffect(() => {
    // Owns an object URL's lifecycle (create on select, revoke on change), so the
    // state has to be set from here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!entry) { setBlobUrl(null); return; }
    const url = URL.createObjectURL(entry.file);
    setBlobUrl(url);
    setCurrentTime(0); setPlaying(false);
    return () => URL.revokeObjectURL(url);
  }, [entry?.id]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !blobUrl) return;
    v.src = blobUrl; v.load();
  }, [blobUrl]);

  const dur = entry?.duration ?? 1;

  // Compute the keep zone for the current mode
  const [keepFrom, keepTo] = entry?.duration
    ? computeKeepZone(trimMode, entry.duration, trimDur, rangeStart, rangeEnd)
    : [0, dur];

  const keepFromPct = (keepFrom / dur) * 100;
  const keepToPct   = (keepTo   / dur) * 100;

  /* drag helpers */
  const timeFromX = useCallback((clientX: number) => {
    if (!barRef.current) return 0;
    const { left, width } = barRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - left) / width)) * dur;
  }, [dur]);

  const seekTo = useCallback((t: number) => {
    const c = Math.max(0, Math.min(dur, t));
    if (videoRef.current) videoRef.current.currentTime = c;
    setCurrentTime(c);
  }, [dur]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  }, []);

  /* drag handling — start/end handles (custom range), single boundary (simple modes), playhead */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const t = timeFromX(e.clientX);
      if (dragging.current === "playhead") {
        seekTo(t);
      } else if (dragging.current === "start") {
        onRangeChange(snap2(Math.min(t, rangeEnd - 0.05)), rangeEnd);
      } else if (dragging.current === "end") {
        onRangeChange(rangeStart, snap2(Math.max(t, rangeStart + 0.05)));
      } else if (dragging.current === "boundary") {
        const raw = (trimMode === "keep-start" || trimMode === "remove-start") ? t : dur - t;
        onTrimDurChange(Math.min(Math.max(snap2(raw), 0.05), dur));
      }
    };
    const onUp = () => { dragging.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [timeFromX, seekTo, rangeStart, rangeEnd, onRangeChange, trimMode, dur, onTrimDurChange]);

  /* keyboard — frame-step playhead (←/→, Shift = 1s), space to play, I/O set in/out */
  useEffect(() => {
    if (!entry?.duration) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const frame = 1 / outputFps;
      switch (e.key) {
        case "ArrowLeft":  e.preventDefault(); seekTo(currentTime - (e.shiftKey ? 1 : frame)); break;
        case "ArrowRight": e.preventDefault(); seekTo(currentTime + (e.shiftKey ? 1 : frame)); break;
        case " ":          e.preventDefault(); togglePlay(); break;
        case "i": case "I": case "[":
          e.preventDefault();
          if (trimMode === "custom-range") onRangeChange(snap2(Math.min(currentTime, rangeEnd - 0.05)), rangeEnd);
          else onTrimDurChange(Math.min(Math.max(snap2((trimMode === "keep-start" || trimMode === "remove-start") ? currentTime : dur - currentTime), 0.05), dur));
          break;
        case "o": case "O": case "]":
          if (trimMode === "custom-range") { e.preventDefault(); onRangeChange(rangeStart, snap2(Math.max(currentTime, rangeStart + 0.05))); }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, currentTime, outputFps, trimMode, rangeStart, rangeEnd, dur, seekTo, togglePlay, onRangeChange, onTrimDurChange]);

  if (!entry || !blobUrl) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400 dark:text-zinc-600">
        <Film size={36} strokeWidth={1.3} />
        <p className="text-[13px]">Select a video to preview</p>
      </div>
    );
  }

  const playheadPct = Math.min(100, (currentTime / dur) * 100);
  const inDiscard = currentTime < keepFrom || currentTime > keepTo;

  const frameStep = (dir: number) => seekTo(currentTime + dir / outputFps);
  const setIn  = () => onRangeChange(snap2(Math.min(currentTime, rangeEnd - 0.05)), rangeEnd);
  const setOut = () => onRangeChange(rangeStart, snap2(Math.max(currentTime, rangeStart + 0.05)));
  const setBoundary = () => onTrimDurChange(
    Math.min(Math.max(snap2((trimMode === "keep-start" || trimMode === "remove-start") ? currentTime : dur - currentTime), 0.05), dur),
  );
  const boundaryTime = (trimMode === "keep-start" || trimMode === "remove-end") ? keepTo : keepFrom;
  const boundaryPct = (boundaryTime / dur) * 100;

  return (
    <div className="flex-1 flex flex-col gap-3 overflow-hidden">
      {/* Video */}
      <div className="flex-1 relative rounded-xl overflow-hidden bg-black flex items-center justify-center min-h-0">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} className="max-w-full max-h-full object-contain"
          onTimeUpdate={e => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          onEnded={() => setPlaying(false)} />

        {/* Discard overlay */}
        {inDiscard && (
          <div className="absolute inset-0 bg-red-500/12 pointer-events-none flex items-end justify-center pb-6">
            <span className="text-[11px] font-bold text-red-400 bg-red-500/20 border border-red-500/30 px-3 py-1 rounded-full">
              ✂ This part will be removed
            </span>
          </div>
        )}

        {/* Play/pause */}
        <button onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-transparent border-none cursor-pointer group">
          <div className="w-12 h-12 rounded-full bg-black/40 backdrop-blur flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            {playing
              ? <Pause size={20} className="text-white" />
              : <Play  size={20} className="text-white ml-0.5" />}
          </div>
        </button>
      </div>

      {/* Trim bar */}
      <div className="shrink-0 space-y-1.5">
        <div
          ref={barRef}
          className="relative h-8 rounded-xl overflow-visible bg-zinc-900 cursor-pointer select-none"
          onMouseDown={e => {
            // Click on bar = move playhead (unless clicking a handle)
            if ((e.target as HTMLElement).dataset.handle) return;
            dragging.current = "playhead";
            const t = timeFromX(e.clientX);
            if (videoRef.current) videoRef.current.currentTime = t;
            setCurrentTime(t);
          }}
        >
          {/* Discard zones */}
          {keepFromPct > 0 && (
            <div className="absolute top-0 bottom-0 left-0 bg-red-500/20 rounded-l-xl"
              style={{ width: `${keepFromPct}%` }} />
          )}
          {keepToPct < 100 && (
            <div className="absolute top-0 bottom-0 bg-red-500/20 rounded-r-xl"
              style={{ left: `${keepToPct}%`, right: 0 }} />
          )}
          {/* Keep zone */}
          <div className="absolute top-0 bottom-0 bg-emerald-500/20"
            style={{ left: `${keepFromPct}%`, width: `${keepToPct - keepFromPct}%` }} />
          {/* Keep zone border */}
          <div className="absolute top-0 bottom-0 border-l-2 border-r-2 border-emerald-500 pointer-events-none"
            style={{ left: `${keepFromPct}%`, width: `${keepToPct - keepFromPct}%` }} />

          {/* Labels */}
          <div className="absolute inset-0 flex items-center pointer-events-none">
            {keepFromPct > 5 && (
              <span className="absolute text-[8px] font-bold text-red-400/70 uppercase tracking-wide pl-1.5">Remove</span>
            )}
            <span className="absolute text-[8px] font-bold text-emerald-400/90 uppercase tracking-wide"
              style={{ left: `${keepFromPct + 1}%` }}>Keep</span>
            {keepToPct < 95 && (
              <span className="absolute text-[8px] font-bold text-red-400/70 uppercase tracking-wide right-1.5">Remove</span>
            )}
          </div>

          {/* Playhead */}
          <div className="absolute top-0 bottom-0 w-0.5 bg-white/80 pointer-events-none"
            style={{ left: `${playheadPct}%`, transform: "translateX(-1px)" }}>
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white shadow" />
          </div>

          {/* Draggable handles (custom-range only) */}
          {trimMode === "custom-range" && (
            <>
              {/* Start handle */}
              <div
                data-handle="start"
                style={{ left: `${(rangeStart / dur) * 100}%`, transform: "translateX(-50%)" }}
                className="absolute top-0 bottom-0 w-4 flex items-center justify-center cursor-ew-resize z-10 group/h"
                onMouseDown={e => { e.stopPropagation(); dragging.current = "start"; }}
              >
                <div className="w-2.5 h-full rounded-full bg-violet-500 shadow group-hover/h:w-3 transition-all pointer-events-none" />
                <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-zinc-900 text-violet-400 text-[9px] font-bold px-1.5 py-0.5 rounded opacity-0 group-hover/h:opacity-100 whitespace-nowrap pointer-events-none transition-opacity">
                  {rangeStart.toFixed(2)}s
                </div>
              </div>
              {/* End handle */}
              <div
                data-handle="end"
                style={{ left: `${(rangeEnd / dur) * 100}%`, transform: "translateX(-50%)" }}
                className="absolute top-0 bottom-0 w-4 flex items-center justify-center cursor-ew-resize z-10 group/h"
                onMouseDown={e => { e.stopPropagation(); dragging.current = "end"; }}
              >
                <div className="w-2.5 h-full rounded-full bg-violet-500 shadow group-hover/h:w-3 transition-all pointer-events-none" />
                <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-zinc-900 text-violet-400 text-[9px] font-bold px-1.5 py-0.5 rounded opacity-0 group-hover/h:opacity-100 whitespace-nowrap pointer-events-none transition-opacity">
                  {rangeEnd.toFixed(2)}s
                </div>
              </div>
            </>
          )}

          {/* Single draggable boundary (simple modes) — drag to set the keep duration */}
          {trimMode !== "custom-range" && (
            <div
              data-handle="boundary"
              style={{ left: `${boundaryPct}%`, transform: "translateX(-50%)" }}
              className="absolute top-0 bottom-0 w-4 flex items-center justify-center cursor-ew-resize z-10 group/h"
              onMouseDown={e => { e.stopPropagation(); dragging.current = "boundary"; }}
            >
              <div className="w-2.5 h-full rounded-full bg-violet-500 shadow group-hover/h:w-3 transition-all pointer-events-none" />
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-zinc-900 text-violet-400 text-[9px] font-bold px-1.5 py-0.5 rounded opacity-0 group-hover/h:opacity-100 whitespace-nowrap pointer-events-none transition-opacity">
                {trimDur.toFixed(2)}s
              </div>
            </div>
          )}
        </div>

        {/* Precision controls */}
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          <button onClick={() => frameStep(-1)} title="Previous frame (←)"
            className="w-7 h-7 flex items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 hover:bg-zinc-50 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300 cursor-pointer transition-colors">
            <ChevronLeft size={14} />
          </button>
          <button onClick={togglePlay} title="Play / pause (space)"
            className="w-7 h-7 flex items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 hover:bg-zinc-50 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300 cursor-pointer transition-colors">
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <button onClick={() => frameStep(1)} title="Next frame (→)"
            className="w-7 h-7 flex items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 hover:bg-zinc-50 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300 cursor-pointer transition-colors">
            <ChevronRight size={14} />
          </button>
          <div className="w-px h-5 bg-zinc-200 dark:bg-white/10 mx-0.5" />
          {trimMode === "custom-range" ? (
            <>
              <button onClick={setIn} title="Set start to current frame (I)"
                className="flex items-center gap-1 h-7 px-2.5 rounded-lg border border-violet-500/30 bg-violet-500/5 hover:bg-violet-500/10 text-[10.5px] font-semibold text-violet-600 dark:text-violet-400 cursor-pointer transition-colors">
                ⟦ Set In
              </button>
              <button onClick={setOut} title="Set end to current frame (O)"
                className="flex items-center gap-1 h-7 px-2.5 rounded-lg border border-violet-500/30 bg-violet-500/5 hover:bg-violet-500/10 text-[10.5px] font-semibold text-violet-600 dark:text-violet-400 cursor-pointer transition-colors">
                Set Out ⟧
              </button>
            </>
          ) : (
            <button onClick={setBoundary} title="Set the cut point to the current frame (I)"
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-violet-500/30 bg-violet-500/5 hover:bg-violet-500/10 text-[10.5px] font-semibold text-violet-600 dark:text-violet-400 cursor-pointer transition-colors">
              <Scissors size={11} /> Cut at playhead
            </button>
          )}
        </div>

        <div className="flex items-center justify-between text-[10px] text-zinc-400 tabular-nums">
          <span>{fmtDur(currentTime)}</span>
          <span className="text-emerald-500 font-semibold">
            Keep: {fmtDur(keepFrom)} → {fmtDur(keepTo)} ({fmtDur(keepTo - keepFrom)})
          </span>
          <span>{fmtDur(dur)}</span>
        </div>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

const FPS_OPTIONS = [10, 15, 24, 30] as const;
type FpsOption = typeof FPS_OPTIONS[number];

/** The original Quick Trim tool — trim many whole files with one range/mode. Hosted as
 *  the "Trim Files" tab of the Quick Trim page (app/tools/quick-trim/page.tsx). */
export function TrimFilesTool() {
  const [videos, setVideos]           = useState<VideoEntry[]>([]);
  const [trimMode, setTrimMode]       = useState<TrimMode>("custom-range");
  const [trimDur, setTrimDur]         = useState(2.6);
  const [rangeStart, setRangeStart]   = useState(0);
  const [rangeEnd, setRangeEnd]       = useState(5);
  const [outputFps, setOutputFps]     = useState<FpsOption>(30);
  const [isDragging, setIsDragging]   = useState(false);
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchPaused, setBatchPaused]   = useState(false);
  const [fsDirHandle, setFsDirHandle]   = useState<FileSystemDirectoryHandle | null>(null);
  const [errors, setErrors]             = useState<string[]>([]);
  const [fps, setFps]                   = useState(0);

  const pauseRef   = useRef(false);
  const abortRef   = useRef<AbortController | null>(null);
  const fpsCounter = useRef({ count: 0, time: Date.now() });

  // Warn before navigating away while trimming (batch or a single clip);
  // "Leave & stop" aborts the in-flight trim.
  useRegisterTask(batchRunning || videos.some(v => v.status === "processing"), {
    label: "Quick Trim",
    kind: "tools",
    onAbort: () => abortRef.current?.abort(),
  });
  const canvasRef  = useRef<HTMLDivElement>(null);   // bounds for the floating settings panel

  /* derived */
  const readyCount = videos.filter(v => v.status === "ready").length;
  const doneCount  = videos.filter(v => v.status === "done").length;
  const errorCount = videos.filter(v => v.status === "error").length;
  const totalCount = videos.length;
  const selectedEntry = (selectedId ? videos.find(v => v.id === selectedId) : null) ?? videos[0] ?? null;

  /* metadata loader */
  const loadMeta = useCallback(async (entries: VideoEntry[]) => {
    for (const e of entries) {
      setVideos(prev => prev.map(v => v.id === e.id ? { ...v, status: "loading-meta" } : v));
      try {
        const { duration, videoWidth, videoHeight } = await getVideoMeta(e.file);
        setVideos(prev => prev.map(v => v.id === e.id
          ? { ...v, status: "ready", duration, videoWidth, videoHeight } : v));
        // initialise custom range to full video on first upload
        setRangeEnd(prev => prev === 5 ? Math.min(duration, 5) : prev);
      } catch (metaErr) {
        logWarn("quick-trim", "Could not read video metadata", metaErr);
        setVideos(prev => prev.map(v => v.id === e.id
          ? { ...v, status: "error", error: "Could not read video metadata" } : v));
      }
    }
  }, []);

  /* file input */
  const addFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const valid: VideoEntry[] = [];
    const errs: string[] = [];
    Array.from(files).forEach(f => {
      if (!f.type.startsWith("video/")) { errs.push(`${f.name}: not a video`); return; }
      valid.push({ id: crypto.randomUUID(), file: f, name: f.name, sizeBytes: f.size,
        duration: null, videoWidth: 0, videoHeight: 0, status: "idle", progress: 0 });
    });
    if (errs.length) setErrors(errs);
    if (!valid.length) return;
    setVideos(prev => [...prev, ...valid]);
    if (!selectedId && valid.length) setSelectedId(valid[0].id);
    loadMeta(valid);
  }, [selectedId, loadMeta]);

  /* folder picker — returns the chosen handle (also stashed in state). */
  async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      setFsDirHandle(h);
      return h;
    } catch (e) { logDebug("quick-trim", "Folder picker cancelled or unavailable", e); return null; }
  }

  /* batch */
  async function startBatch() {
    const queue = videos.filter(v => v.status === "ready" || v.status === "error");
    if (!queue.length) return;

    // Ask where to save first — trimming only begins once a folder is chosen.
    // (Web fallback with no File System Access API just auto-downloads instead.)
    let dir = fsDirHandle;
    if (hasFsAccess) {
      dir = await pickFolder();
      if (!dir) return; // user cancelled the folder picker — don't start
    }

    setBatchRunning(true); setBatchPaused(false);
    pauseRef.current = false;
    abortRef.current = new AbortController();

    for (const entry of queue) {
      if (abortRef.current.signal.aborted) break;
      if (!entry.duration) continue;

      const [keepFrom, keepTo] = computeKeepZone(trimMode, entry.duration, trimDur, rangeStart, rangeEnd);
      if (keepTo - keepFrom < 0.05) {
        setVideos(prev => prev.map(v => v.id === entry.id
          ? { ...v, status: "error", error: "Keep zone is empty for this video" } : v));
        continue;
      }

      setSelectedId(entry.id);
      setVideos(prev => prev.map(v => v.id === entry.id ? { ...v, status: "processing", progress: 0 } : v));
      fpsCounter.current = { count: 0, time: Date.now() };

      try {
        const blob = await trimVideo(
          entry.file, keepFrom, keepTo, outputFps,
          p => {
            setVideos(prev => prev.map(v => v.id === entry.id ? { ...v, progress: p } : v));
            fpsCounter.current.count++;
            const elapsed = (Date.now() - fpsCounter.current.time) / 1000;
            if (elapsed >= 0.5) {
              setFps(Math.round(fpsCounter.current.count / elapsed));
              fpsCounter.current = { count: 0, time: Date.now() };
            }
          },
          abortRef.current.signal,
          pauseRef,
        );

        const outName = entry.name.replace(/\.[^.]+$/, "") + "_trimmed.mp4";
        if (dir) {
          try {
            const fh = await dir.getFileHandle(outName, { create: true });
            const w = await fh.createWritable();
            await w.write(blob); await w.close();
          } catch (e) { logWarn("quick-trim", "Failed to write to output folder, falling back to download", e); downloadBlob(blob, outName); }
        } else {
          downloadBlob(blob, outName);
        }

        setVideos(prev => prev.map(v => v.id === entry.id
          ? { ...v, status: "done", progress: 1, outputBlob: blob } : v));
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setVideos(prev => prev.map(v => v.id === entry.id ? { ...v, status: "ready", progress: 0 } : v));
          break;
        }
        setVideos(prev => prev.map(v => v.id === entry.id
          ? { ...v, status: "error", progress: 0, error: humanizeError(err, { operation: "trim" }) } : v));
      }
    }

    setBatchRunning(false); setBatchPaused(false); pauseRef.current = false; setFps(0);
  }

  function togglePause() {
    if (!batchRunning) return;
    pauseRef.current = !pauseRef.current;
    setBatchPaused(pauseRef.current);
  }

  function stopBatch() {
    abortRef.current?.abort();
    setBatchRunning(false); setBatchPaused(false); pauseRef.current = false; setFps(0);
  }

  const [hasFsAccess, setHasFsAccess] = useState(false);
  useEffect(() => { setHasFsAccess("showDirectoryPicker" in window); }, []);

  /* mode-aware input label */
  const durLabel = trimMode === "keep-start" ? "Keep duration (s)"
    : trimMode === "remove-start" ? "Cut from start (s)"
    : trimMode === "keep-end"     ? "Keep duration (s)"
    : trimMode === "remove-end"   ? "Cut from end (s)"
    : "";

  const durHint = trimMode === "keep-start"   ? `Keep first ${trimDur}s of every video`
    : trimMode === "remove-start" ? `Remove first ${trimDur}s of every video`
    : trimMode === "keep-end"     ? `Keep last ${trimDur}s of every video`
    : trimMode === "remove-end"   ? `Remove last ${trimDur}s of every video`
    : "";

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <StudioToolHeader
          icon={Scissors}
          title="Quick Trim"
          accent="#0057FC"
          backHref="/tools"
          backLabel="Tools"
          description={totalCount > 0
            ? `Batch trim any number of videos · ${totalCount} loaded`
            : "Batch trim any number of videos"}
          right={batchRunning && fps > 0 ? (
            <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20">
              <Zap size={9} className="text-violet-500" />
              <span className="text-[10px] font-bold text-violet-500 tabular-nums">{fps} fps</span>
            </div>
          ) : undefined}
        />

        <div className="flex flex-1 min-h-0">
          {/* ── LEFT ── */}
          {/* Glassy/translucent so the app's ambient background shows through —
              seamless with the (transparent) preview panel on the right. */}
          <div className="w-[324px] shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-panel overflow-hidden">

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

            {/* Errors */}
            {errors.length > 0 && (
              <div className="rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/5 p-3 flex gap-2">
                <AlertCircle size={13} className="text-red-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  {errors.map((e, i) => <p key={i} className="text-[11px] text-red-600 dark:text-red-400">{e}</p>)}
                </div>
                <button onClick={() => setErrors([])} className="text-red-400 hover:text-red-600 cursor-pointer border-none bg-transparent shrink-0"><X size={11} /></button>
              </div>
            )}

            {/* Upload */}
            <div>
              <SectionTitle>Upload Videos</SectionTitle>
              <label
                className={`flex flex-col items-center justify-center w-full h-24 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
                  isDragging ? "border-violet-400 bg-violet-50 dark:bg-violet-500/5"
                    : "border-zinc-300 dark:border-white/20 bg-zinc-50/80 dark:bg-white/[0.04] hover:border-violet-400/50 hover:bg-zinc-50 dark:hover:bg-white/3"
                }`}
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
              >
                <input type="file" accept="video/*" multiple className="hidden"
                  onChange={e => { addFiles(e.target.files); e.target.value = ""; }} />
                <Upload size={18} className="text-zinc-400 mb-1.5" />
                <p className="text-[12px] font-medium text-zinc-500">Drop videos or click to upload</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">MP4, MOV, WebM · no file limit</p>
              </label>
            </div>

            {/* Trim Mode + Output Quality live in the floating panel over the canvas (see <FloatingPanel> below) */}

            {/* Video list */}
            {videos.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
                    Queue · {totalCount}
                  </p>
                  <div className="flex items-center gap-2">
                    {doneCount > 0 && (
                      <button onClick={() => setVideos(p => p.filter(v => v.status !== "done"))}
                        className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer border-none bg-transparent transition-colors">
                        Clear done ({doneCount})
                      </button>
                    )}
                    <button onClick={() => { setVideos([]); setSelectedId(null); }}
                      className="text-[10px] text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent transition-colors">
                      Clear all
                    </button>
                  </div>
                </div>

                {/* Status pills */}
                <div className="flex items-center gap-1.5 mb-2.5 flex-wrap">
                  {[
                    { label: "Ready", val: readyCount,  color: "#0057FC" },
                    { label: "Done",  val: doneCount,   color: "#10b981" },
                    { label: "Error", val: errorCount,  color: "#ef4444" },
                  ].filter(s => s.val > 0).map(s => (
                    <span key={s.label} className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ color: s.color, background: `${s.color}12`, border: `1px solid ${s.color}25` }}>
                      {s.val} {s.label}
                    </span>
                  ))}
                </div>

                <div className="flex flex-col gap-1.5">
                  {videos.map(v => (
                    <VideoRow
                      key={v.id}
                      entry={v}
                      outputDur={getOutputDur(trimMode, v.duration, trimDur, rangeStart, rangeEnd)}
                      selected={selectedEntry?.id === v.id}
                      onSelect={() => setSelectedId(v.id)}
                      onRemove={() => setVideos(p => {
                        const next = p.filter(x => x.id !== v.id);
                        if (selectedId === v.id) setSelectedId(next[0]?.id ?? null);
                        return next;
                      })}
                      onDownload={() => { if (v.outputBlob) downloadBlob(v.outputBlob, v.name.replace(/\.[^.]+$/, "") + "_trimmed.mp4"); }}
                      onRetry={() => setVideos(p => p.map(x => x.id === v.id ? { ...x, status: "ready", progress: 0, error: undefined } : x))}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Bottom bar */}
          <div className="px-5 py-4 border-t border-zinc-100 dark:border-white/8 shrink-0 space-y-2.5">

            {batchRunning && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-zinc-400 flex items-center gap-1">
                    {batchPaused
                      ? <><Pause size={9} /> Paused</>
                      : <><Loader2 size={9} className="animate-spin" /> Processing…</>}
                  </span>
                  <span className="text-[10px] font-semibold text-zinc-500 tabular-nums">{doneCount} / {totalCount}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%`, background: "var(--brand-gradient)" }} />
                </div>
                {fps > 0 && (
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-400">
                    <Zap size={9} className="text-violet-400" />
                    <span>{fps} frames/sec</span>
                    <span className="ml-auto flex items-center gap-1"><Clock size={9} /> {outputFps} fps output</span>
                  </div>
                )}
              </div>
            )}

            {doneCount === totalCount && totalCount > 0 && !batchRunning && (
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 size={12} /> All {doneCount} video{doneCount !== 1 ? "s" : ""} trimmed
              </div>
            )}

            <div className="flex gap-2">
              {!batchRunning ? (
                <button
                  onClick={startBatch}
                  disabled={readyCount === 0 && errorCount === 0}
                  className="flex-1 h-10 rounded-xl text-[13px] font-bold text-white cursor-pointer border-none flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                  style={{ background: "var(--brand-gradient)" }}
                >
                  <Scissors size={14} />
                  {readyCount > 0 ? `Trim ${readyCount} Video${readyCount !== 1 ? "s" : ""}` : "Trim Videos"}
                </button>
              ) : (
                <>
                  <button onClick={togglePause}
                    className="flex-1 h-10 rounded-xl text-[13px] font-bold cursor-pointer border border-zinc-200 dark:border-white/10 flex items-center justify-center gap-2 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors"
                    style={{ color: batchPaused ? "#0057FC" : undefined }}>
                    {batchPaused ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}
                  </button>
                  <button onClick={stopBatch}
                    className="w-10 h-10 rounded-xl border border-red-500/30 text-red-500 hover:bg-red-500/8 flex items-center justify-center cursor-pointer transition-colors">
                    <StopCircle size={15} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── RIGHT ── */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Toolbar */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] shrink-0 gap-4">
            <div className="flex items-center gap-2">
              <Scissors size={13} className="text-violet-500" />
              <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300 truncate max-w-[240px]">
                {selectedEntry?.name ?? "No video selected"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end shrink-0">
              <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                {TRIM_MODES.find(m => m.id === trimMode)?.label}
              </span>
              {selectedEntry?.duration && (
                <>
                  <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 text-[11px] text-zinc-400">
                    {fmtDur(selectedEntry.duration)}
                  </span>
                  <span className="px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[11px] font-semibold text-violet-500">
                    → {fmtDur(getOutputDur(trimMode, selectedEntry.duration, trimDur, rangeStart, rangeEnd))}
                  </span>
                </>
              )}
              <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 text-[11px] text-zinc-400">
                {outputFps} fps
              </span>
              {batchRunning && !batchPaused && (
                <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[11px] font-bold text-violet-500">
                  <Zap size={9} /> Processing
                </span>
              )}
            </div>
          </div>

          {/* Preview (canvas) — hosts the floating settings panel */}
          <div ref={canvasRef} className="relative flex-1 flex flex-col p-5 overflow-hidden">
            {videos.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 flex items-center justify-center">
                  <Upload size={24} strokeWidth={1.4} className="text-zinc-400" />
                </div>
                <p className="text-[14px] font-semibold text-zinc-500 dark:text-zinc-400">Upload videos to start</p>
                <p className="text-[12px] text-zinc-400 dark:text-zinc-600 max-w-xs text-center">
                  Drop any number of videos, pick a trim mode, and batch export all at once.
                </p>
              </div>
            ) : (
              <VideoPreview
                entry={selectedEntry}
                trimMode={trimMode}
                trimDur={trimDur}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                outputFps={outputFps}
                onRangeChange={(s, e) => { setRangeStart(s); setRangeEnd(e); }}
                onTrimDurChange={d => setTrimDur(d)}
              />
            )}

            {/* Floating settings — drag by the header, minimize, Figma-style */}
            <FloatingPanel title="Trim Settings" icon={SlidersHorizontal} boundsRef={canvasRef} width={236}>
              <div className="space-y-3">
                {/* Trim Mode */}
                <div>
                  <div className="flex flex-col gap-1.5 mb-2">
                    {/* Featured default — compact single row */}
                    <button
                      onClick={() => setTrimMode("custom-range")}
                      className="flex items-center gap-2 px-2 h-8 rounded-lg border cursor-pointer transition-all text-left"
                      style={{
                        background: trimMode === "custom-range" ? "rgba(0,87,252,0.07)" : "rgba(113,113,122,0.04)",
                        borderColor: trimMode === "custom-range" ? "rgba(0,87,252,0.45)" : "rgba(113,113,122,0.18)",
                      }}
                    >
                      <Scissors size={12} className="shrink-0" style={{ color: trimMode === "custom-range" ? "#0057FC" : "#71717a" }} />
                      <span className="flex-1 text-[11px] font-bold truncate" style={{ color: trimMode === "custom-range" ? "#0057FC" : undefined }}>
                        Custom Range
                      </span>
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                        style={{ background: "rgba(0,87,252,0.1)", color: "#0057FC" }}>DEFAULT</span>
                    </button>

                    {/* Quick modes — tiny bar + label, two columns */}
                    <div className="grid grid-cols-2 gap-1.5">
                      {TRIM_MODES.filter(m => m.id !== "custom-range").map(m => {
                        const active = trimMode === m.id;
                        return (
                          <button
                            key={m.id}
                            onClick={() => setTrimMode(m.id)}
                            className="flex items-center gap-2 px-2 h-8 rounded-lg border text-left cursor-pointer transition-all"
                            style={{
                              background: active ? "rgba(0,87,252,0.07)" : "rgba(113,113,122,0.03)",
                              borderColor: active ? "rgba(0,87,252,0.4)" : "rgba(113,113,122,0.15)",
                            }}
                          >
                            <span className="w-4 shrink-0"><MiniTrimBar mode={m.id} active={active} /></span>
                            <span className="flex-1 text-[10px] font-semibold leading-none truncate"
                              style={{ color: active ? "#0057FC" : undefined }}>
                              {m.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {trimMode !== "custom-range" && (
                    <div>
                      <FieldLabel>{durLabel}</FieldLabel>
                      <div className="flex items-center gap-2">
                        <input
                          type="number" min={0.05} max={3600} step={0.01}
                          value={trimDur}
                          onChange={e => setTrimDur(Math.max(0.05, snap2(parseFloat(e.target.value) || 0.05)))}
                          className={`${PANEL_INPUT} flex-1`}
                        />
                        <span className="text-[12px] text-zinc-400 shrink-0">s</span>
                      </div>
                      <p className="text-[10px] text-zinc-400 mt-1 pl-0.5">{durHint}</p>
                    </div>
                  )}

                  {trimMode === "custom-range" && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <FieldLabel>From (s)</FieldLabel>
                        <input
                          type="number" min={0} step={0.01}
                          value={rangeStart}
                          onChange={e => setRangeStart(snap2(Math.max(0, parseFloat(e.target.value) || 0)))}
                          className={PANEL_INPUT}
                        />
                      </div>
                      <div>
                        <FieldLabel>To (s)</FieldLabel>
                        <input
                          type="number" min={0.05} step={0.01}
                          value={rangeEnd}
                          onChange={e => setRangeEnd(snap2(Math.max(rangeStart + 0.05, parseFloat(e.target.value) || 0.05)))}
                          className={PANEL_INPUT}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Output Quality */}
                <div>
                  <FieldLabel>Frame rate</FieldLabel>
                  <div className="flex gap-1.5">
                    {FPS_OPTIONS.map(f => (
                      <button key={f} onClick={() => setOutputFps(f)}
                        className="flex-1 h-7 rounded-lg text-[10.5px] font-semibold cursor-pointer border transition-all"
                        style={{
                          background: outputFps === f ? "rgba(0,87,252,0.1)" : "transparent",
                          borderColor: outputFps === f ? "rgba(0,87,252,0.4)" : "rgba(113,113,122,0.25)",
                          color: outputFps === f ? "#0057FC" : undefined,
                        }}>
                        {f} fps
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-400 mt-1.5 pl-0.5">Lower = faster processing</p>
                </div>
              </div>
            </FloatingPanel>
          </div>
        </div>
        </div>
      </div>
    </>
  );
}
