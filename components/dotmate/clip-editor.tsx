"use client";

/**
 * DotMate clip editor — preview player + two-level timeline for one source video.
 *
 *  - Overview bar: the whole recording (50+ min). Click/drag to jump; ticks show
 *    clips already added from this video.
 *  - Detail timeline: a zoomable window (10 s … whole video) around the playhead.
 *    Click a point → a selection of the default length starts there. Drag the
 *    selection to slide it, drag its edges to change its length.
 *  - Add Clip (A) pushes the selection into the queue and leaves everything in place
 *    so the next moment can be marked immediately.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play, Pause, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Volume2, VolumeX, Maximize, Plus, Crosshair, Repeat, Check, AlertCircle, Film, Trash2,
} from "lucide-react";
import {
  DURATION_PRESETS, fmtClock, fmtLength, fmtTime, moveSelection, resizeSelection,
  roundMs, selectionAt, tickStep, type Range,
} from "@/lib/dotmate/format";

export interface EditorClip { id: string; number: number; start: number; end: number; /** exporting right now */ locked: boolean }

/** From the queue: open this clip for editing, optionally playing it once. */
export interface PreviewRequest { clipId: string; start: number; end: number; nonce: number; play: boolean }

type UpdateResult = { ok: true } | { ok: false; reason: "locked" | "duplicate" | "invalid" };

interface Props {
  sourceId: string;
  file: File;
  name: string;
  duration: number;
  /** Clips already queued from THIS source, with their queue numbers. */
  clips: EditorClip[];
  defaultDuration: number;
  onDefaultDurationChange: (sec: number) => void;
  onAddClip: (range: Range) => { ok: true; number: number } | { ok: false; reason: "duplicate" | "invalid" };
  /** Edit mode: move/resize an already-added clip. */
  onUpdateClip: (id: string, range: Range) => UpdateResult;
  onRemoveClip: (id: string) => void;
  /** Set by the queue's Preview action: load this range and play it once. */
  previewRequest: PreviewRequest | null;
}

const ZOOMS = [
  { label: "10s", span: 10 },
  { label: "30s", span: 30 },
  { label: "2m", span: 120 },
  { label: "10m", span: 600 },
  { label: "All", span: Infinity },
] as const;

/** Per-source position memory, so switching videos returns where you left off. */
const lastPosition = new Map<string, { time: number; sel: Range; zoom: number }>();

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const FRAME = 1 / 30;

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

export function ClipEditor(props: Props) {
  // Remount per source: every piece of player/timeline state starts clean.
  return <ClipEditorInner key={props.sourceId} {...props} />;
}

function ClipEditorInner({
  sourceId, file, name, duration: dur, clips, defaultDuration,
  onDefaultDurationChange, onAddClip, onUpdateClip, onRemoveClip, previewRequest,
}: Props) {
  const remembered = lastPosition.get(sourceId);
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [url, setUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);
  const [time, setTime] = useState(remembered?.time ?? 0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [sel, setSel] = useState<Range>(remembered?.sel ?? selectionAt(0, defaultDuration, dur));
  const [zoom, setZoom] = useState<number>(remembered?.zoom ?? 30);
  const [winStart, setWinStart] = useState(0);
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  // Edit mode: the selection IS this added clip; dragging it updates the queue.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId ? clips.find((c) => c.id === editingId) ?? null : null;

  const span = Math.min(zoom, dur);
  const ws = clamp(winStart, 0, dur - span);

  // Refs mirror state for event handlers that outlive a render.
  const selRef = useRef(sel);
  const timeRef = useRef(time);
  const editingRef = useRef<EditorClip | null>(null);
  const playUntil = useRef<number | null>(null);
  const seekState = useRef({ busy: false, pending: null as number | null, since: 0 });

  useEffect(() => {
    selRef.current = sel;
    timeRef.current = time;
    editingRef.current = editing;
    lastPosition.set(sourceId, { time, sel, zoom });
  }, [sourceId, time, sel, zoom, editing]);

  /* ── Source URL: a blob: reference to the file on disk (streamed, not loaded) ── */
  useEffect(() => {
    const u = URL.createObjectURL(file);
    // Owns the object URL lifecycle (create on mount, revoke on unmount).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  /* ── Keep a time visible in the detail window ── */
  const reveal = useCallback((t: number, follow = false) => {
    setWinStart((prev) => {
      const s = clamp(prev, 0, dur - span);
      if (t < s || t > s + span) return clamp(t - span * 0.25, 0, dur - span);
      if (follow && t > s + span * 0.92) return clamp(t - span * 0.08, 0, dur - span);
      return prev;
    });
  }, [dur, span]);

  /* ── Coalesced seeking: one in-flight seek, latest target wins ── */
  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    const c = clamp(t, 0, dur);
    setTime(c);
    reveal(c);
    if (!v) return;
    // Before metadata the browser only records a start position and never fires
    // `seeked` — don't take the lock (onLoadedMetadata applies the latest time).
    if (v.readyState < 1) { v.currentTime = c; return; }
    const st = seekState.current;
    // A seek that never reported back (e.g. interrupted by a source change) must not
    // block scrubbing forever.
    if (st.busy && performance.now() - st.since < 1000) { st.pending = c; return; }
    st.busy = true;
    st.pending = null;
    st.since = performance.now();
    v.currentTime = c;
  }, [dur, reveal]);

  const onSeeked = () => {
    const st = seekState.current;
    const v = videoRef.current;
    if (st.pending != null && v) {
      const p = st.pending;
      st.pending = null;
      st.since = performance.now();
      v.currentTime = p;
    } else {
      st.busy = false;
    }
  };

  /* ── Smooth playhead while playing; stop at the end of a selection preview ── */
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const t = v.currentTime;
        if (playUntil.current != null && t >= playUntil.current) {
          v.pause();
          v.currentTime = playUntil.current;
          playUntil.current = null;
        }
        setTime(t);
        reveal(t, true);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, reveal]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    playUntil.current = null;
    if (v.paused) void v.play().catch(() => {}); else v.pause();
  }, []);

  const playRange = useCallback((r: Range) => {
    const v = videoRef.current;
    if (!v) return;
    seekState.current = { busy: false, pending: null, since: 0 };
    v.currentTime = r.start;
    setTime(r.start);
    reveal(r.start);
    playUntil.current = r.end;
    void v.play().catch(() => {});
  }, [reveal]);

  /** Set the selection; in edit mode the edited clip follows it. */
  const applySel = useCallback((r: Range) => {
    setSel(r);
    const ed = editingRef.current;
    if (!ed) return;
    const res = onUpdateClip(ed.id, r);
    if (!res.ok && res.reason !== "invalid") {
      setFlash({ text: res.reason === "locked" ? "This clip is exporting right now" : "Another clip has exactly this range", ok: false });
    }
  }, [onUpdateClip]);

  /** A fresh selection at `t` — leaves edit mode. */
  const placeAt = useCallback((t: number) => {
    setEditingId(null);
    editingRef.current = null;
    const r = selectionAt(t, defaultDuration, dur);
    setSel(r);
    return r;
  }, [defaultDuration, dur]);

  /** Start editing an added clip; returns its range (null when it can't be edited). */
  const editClip = useCallback((id: string): Range | null => {
    const c = clips.find((x) => x.id === id);
    if (!c) return null;
    if (c.locked) { setFlash({ text: "This clip is exporting right now", ok: false }); return null; }
    const r = { start: c.start, end: c.end };
    setEditingId(id);
    editingRef.current = c;
    setSel(r);
    return r;
  }, [clips]);

  const stopEditing = useCallback(() => {
    setEditingId(null);
    editingRef.current = null;
  }, []);

  const removeEditing = useCallback(() => {
    const ed = editingRef.current;
    if (!ed) return;
    onRemoveClip(ed.id);
    stopEditing();
    setFlash({ text: `Clip ${ed.number} removed`, ok: true });
  }, [onRemoveClip, stopEditing]);

  // S: new selection at the playhead, or, while editing, move the clip there.
  const markAtPlayhead = useCallback(() => {
    const ed = editingRef.current;
    if (ed) applySel(selectionAt(timeRef.current, selRef.current.end - selRef.current.start, dur));
    else placeAt(timeRef.current);
  }, [applySel, placeAt, dur]);

  const addClip = useCallback(() => {
    const res = onAddClip(selRef.current);
    setFlash(res.ok
      ? { text: `Clip ${res.number} added`, ok: true }
      : { text: res.reason === "duplicate" ? "Already in the queue" : "Can't add this selection", ok: false });
  }, [onAddClip]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  /* ── Queue requests: open a clip in edit mode (▶ also plays it) ── */
  // A one-shot external event (keyed by nonce) syncing into local editor state.
  /* eslint-disable react-hooks/set-state-in-effect */
  const lastNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!previewRequest || previewRequest.nonce === lastNonce.current || !url) return;
    lastNonce.current = previewRequest.nonce;
    const r = { start: previewRequest.start, end: previewRequest.end };
    setEditingId(previewRequest.clipId);
    setSel(r);
    if (previewRequest.play) playRange(r);
    else { videoRef.current?.pause(); seek(r.start); }
  }, [previewRequest, url, playRange, seek]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* ── Length: the default for NEW selections; in edit mode it only resizes that clip ── */
  const changeLength = (sec: number) => {
    if (editingRef.current) { applySel(selectionAt(sel.start, sec, dur)); return; }
    onDefaultDurationChange(sec);
    setSel((r) => selectionAt(r.start, sec, dur));
  };

  /* ── Keyboard: Space play/pause · A add · S mark · P play selection · ←/→ step ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const tgt = e.target as Node | null;
      if (tgt && tgt !== document.body && !rootRef.current?.contains(tgt) && !(tgt as HTMLElement).closest?.("main")) return;
      switch (e.key) {
        case " ": e.preventDefault(); togglePlay(); break;
        case "a": case "A": e.preventDefault(); addClip(); break;
        case "s": case "S": e.preventDefault(); markAtPlayhead(); break;
        case "p": case "P": e.preventDefault(); playRange(selRef.current); break;
        case "Escape": if (editingRef.current) { e.preventDefault(); stopEditing(); } break;
        case "Delete": case "Backspace": if (editingRef.current) { e.preventDefault(); removeEditing(); } break;
        case "ArrowLeft": e.preventDefault(); seek(timeRef.current - (e.shiftKey ? 1 : FRAME)); break;
        case "ArrowRight": e.preventDefault(); seek(timeRef.current + (e.shiftKey ? 1 : FRAME)); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, addClip, markAtPlayhead, playRange, seek, stopEditing, removeEditing]);

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  const selLen = sel.end - sel.start;

  return (
    <div ref={rootRef} className="flex-1 flex flex-col min-h-0 gap-3 p-5">
      {/* ── Preview ── */}
      <div ref={stageRef} className="relative flex-1 min-h-[180px] rounded-xl overflow-hidden bg-black flex items-center justify-center">
        {url && !videoError && (
          <video
            ref={videoRef}
            src={url}
            preload="auto"
            className="max-w-full max-h-full object-contain"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              v.volume = volume; v.muted = muted;
              seekState.current = { busy: false, pending: null, since: 0 };
              if (timeRef.current > 0) v.currentTime = timeRef.current;
            }}
            onSeeked={onSeeked}
            onPlay={() => setPlaying(true)}
            onPause={(e) => { setPlaying(false); setTime(e.currentTarget.currentTime); }}
            onEnded={() => setPlaying(false)}
            onError={() => setVideoError(true)}
            onClick={togglePlay}
          />
        )}
        {videoError && (
          <div className="flex flex-col items-center gap-2 text-zinc-400 px-6 text-center">
            <AlertCircle size={28} strokeWidth={1.4} className="text-amber-400" />
            <p className="text-[13px] font-semibold text-zinc-200">Preview isn&apos;t available for this format</p>
            <p className="text-[11.5px] text-zinc-400 max-w-sm">You can still mark clips on the timeline below — the export reads the file directly.</p>
          </div>
        )}
        {!url && <Film size={32} strokeWidth={1.3} className="text-zinc-600" />}
        <div className="absolute top-2.5 left-3 right-3 flex items-center justify-between pointer-events-none">
          <span className="text-[11px] font-semibold text-white/80 bg-black/45 backdrop-blur px-2 py-0.5 rounded-md truncate max-w-[70%]">{name}</span>
        </div>
      </div>

      {/* ── Transport ── */}
      <div className="shrink-0 flex items-center gap-1.5">
        <IconBtn title="Back 5 s (Shift+← = 1 s)" onClick={() => seek(time - 5)}><ChevronsLeft size={14} /></IconBtn>
        <IconBtn title="Previous frame (←)" onClick={() => seek(time - FRAME)}><ChevronLeft size={14} /></IconBtn>
        <button
          onClick={togglePlay}
          title="Play / pause (Space)"
          className="w-9 h-8 flex items-center justify-center rounded-lg text-white border-none cursor-pointer hover:opacity-90 transition-opacity"
          style={{ background: "var(--brand-gradient)" }}
        >
          {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>
        <IconBtn title="Next frame (→)" onClick={() => seek(time + FRAME)}><ChevronRight size={14} /></IconBtn>
        <IconBtn title="Forward 5 s (Shift+→ = 1 s)" onClick={() => seek(time + 5)}><ChevronsRight size={14} /></IconBtn>
        <span className="ml-2 text-[12px] tabular-nums font-semibold text-zinc-700 dark:text-zinc-200">{fmtTime(time, dur >= 3600)}</span>
        <span className="text-[12px] tabular-nums text-zinc-400"> / {fmtTime(dur)}</span>

        <div className="ml-auto flex items-center gap-1.5">
          <IconBtn title={muted ? "Unmute" : "Mute"} onClick={() => {
            const m = !muted; setMuted(m);
            if (videoRef.current) videoRef.current.muted = m;
          }}>
            {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </IconBtn>
          <input
            type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setVolume(v); setMuted(v === 0);
              if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0; }
            }}
            className="w-20 accent-violet-500 cursor-pointer"
          />
          <IconBtn title="Fullscreen" onClick={fullscreen}><Maximize size={13} /></IconBtn>
        </div>
      </div>

      {/* ── Timelines ── */}
      <div className="shrink-0 space-y-2">
        <OverviewBar
          duration={dur} time={time} sel={sel} clips={clips} windowStart={ws} span={span}
          onScrub={(t) => { seek(t); placeAt(t); }}
          onPointerStart={() => videoRef.current?.pause()}
        />
        <DetailTimeline
          duration={dur} time={time} sel={sel} clips={clips} windowStart={ws} span={span}
          defaultDuration={defaultDuration}
          editingId={editing?.id ?? null}
          editingNumber={editing?.number ?? null}
          onPan={(d) => setWinStart(clamp(ws + d, 0, dur - span))}
          onPointerStart={() => { playUntil.current = null; videoRef.current?.pause(); }}
          onPlace={(t) => { placeAt(t); seek(t); }}
          onPickClip={editClip}
          onMove={(r) => { applySel(r); seek(r.start); }}
          onResize={(r, edge) => { applySel(r); seek(edge === "start" ? r.start : Math.max(r.start, r.end - FRAME)); }}
        />
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400 mr-1">Zoom</span>
          {ZOOMS.filter((z) => z.span === Infinity || z.span < dur).map((z) => {
            const active = z.span === Infinity ? zoom >= dur : zoom === z.span;
            return (
              <button key={z.label}
                onClick={() => { setZoom(z.span); setWinStart(clamp(time - Math.min(z.span, dur) * 0.25, 0, dur - Math.min(z.span, dur))); }}
                className={`h-6 px-2 rounded-md text-[10.5px] font-semibold cursor-pointer border transition-colors ${active
                  ? "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300"
                  : "border-zinc-200 dark:border-white/10 bg-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}>
                {z.label}
              </button>
            );
          })}
          <span className="ml-auto text-[10.5px] text-zinc-400">
            Click the timeline to mark · drag the block to slide · drag its edges to resize
          </span>
        </div>
      </div>

      {/* ── Selection + Add Clip ── */}
      <div className="shrink-0 rounded-xl border border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] px-4 py-3 flex items-center gap-4 flex-wrap">
        <div className="min-w-[200px]">
          {editing ? (
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-emerald-600 dark:text-emerald-400">Editing clip #{editing.number}</p>
          ) : (
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">Selection</p>
          )}
          <p className="text-[13px] font-semibold tabular-nums text-zinc-800 dark:text-zinc-100 mt-0.5">
            {fmtTime(sel.start)} <span className="text-zinc-400 font-normal">→</span> {fmtTime(sel.end)}
            <span className="ml-2 text-violet-600 dark:text-violet-300">{fmtLength(roundMs(selLen))}</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <SmallBtn title="Play the selection (P)" onClick={() => playRange(sel)}><Repeat size={12} /> Play</SmallBtn>
          <SmallBtn title={editing ? "Move this clip to the playhead (S)" : "Start the selection at the playhead (S)"} onClick={markAtPlayhead}>
            <Crosshair size={12} /> {editing ? "Move here" : "Mark here"}
          </SmallBtn>
        </div>

        <DurationPicker
          label={editing ? "Clip length" : "Length"}
          value={editing ? roundMs(selLen) : defaultDuration}
          onChange={changeLength}
        />

        <div className="ml-auto flex items-center gap-3">
          {flash && (
            <span className={`flex items-center gap-1 text-[11.5px] font-semibold ${flash.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
              {flash.ok ? <Check size={13} /> : <AlertCircle size={13} />} {flash.text}
            </span>
          )}
          {editing ? (
            <>
              <button
                onClick={removeEditing}
                title="Remove this clip from the queue (Delete)"
                className="h-10 px-3.5 rounded-xl text-[12.5px] font-semibold cursor-pointer border border-red-500/30 text-red-500 bg-transparent hover:bg-red-500/[0.06] flex items-center gap-1.5 transition-colors"
              >
                <Trash2 size={14} /> Remove
              </button>
              <button
                onClick={stopEditing}
                title="Finish editing (Esc) — changes are already saved"
                className="h-10 px-5 rounded-xl text-[13px] font-bold text-white border-none cursor-pointer flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] transition-all"
              >
                <Check size={15} strokeWidth={2.6} /> DONE
                <kbd className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/20">Esc</kbd>
              </button>
            </>
          ) : (
          <button
            onClick={addClip}
            title="Add the selection to the queue (A)"
            className="h-10 px-5 rounded-xl text-[13px] font-bold text-white border-none cursor-pointer flex items-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all shadow-sm"
            style={{ background: "var(--brand-gradient)" }}
          >
            <Plus size={15} strokeWidth={2.6} /> ADD CLIP
            <kbd className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/20">A</kbd>
          </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Overview bar (whole video) ──────────────────────────────────────────── */

function OverviewBar({ duration, time, sel, clips, windowStart, span, onScrub, onPointerStart }: {
  duration: number; time: number; sel: Range; clips: EditorClip[]; windowStart: number; span: number;
  onScrub: (t: number) => void; onPointerStart: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tAt = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clamp((x - r.left) / r.width, 0, 1) * duration;
  };
  const pct = (t: number) => `${(t / duration) * 100}%`;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] tabular-nums text-zinc-400 w-12">0:00</span>
      <div
        ref={ref}
        className="relative flex-1 h-5 rounded-md bg-zinc-200/70 dark:bg-white/[0.06] cursor-pointer select-none touch-none"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onPointerStart(); onScrub(tAt(e.clientX)); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) onScrub(tAt(e.clientX)); }}
        title="Jump anywhere in the video"
      >
        {/* Detail window */}
        {span < duration && (
          <div className="absolute top-0 bottom-0 rounded-md bg-violet-500/10 border border-violet-500/25 pointer-events-none"
            style={{ left: pct(windowStart), width: pct(span) }} />
        )}
        {/* Clips already added from this video */}
        {clips.map((c) => (
          <div key={c.id} className="absolute top-1 bottom-1 w-[2px] rounded-full bg-emerald-500/80 pointer-events-none"
            style={{ left: pct(c.start) }} />
        ))}
        {/* Selection */}
        <div className="absolute top-0 bottom-0 rounded-sm bg-violet-500 pointer-events-none"
          style={{ left: pct(sel.start), width: `max(3px, ${((sel.end - sel.start) / duration) * 100}%)` }} />
        {/* Playhead */}
        <div className="absolute -top-0.5 -bottom-0.5 w-[2px] bg-zinc-900 dark:bg-white rounded-full pointer-events-none"
          style={{ left: pct(time) }} />
      </div>
      <span className="text-[10px] tabular-nums text-zinc-400 w-12 text-right">{fmtClock(duration)}</span>
    </div>
  );
}

/* ─── Detail timeline (zoomed window) ─────────────────────────────────────── */

type Drag = { kind: "place" } | { kind: "move"; offset: number } | { kind: "start" } | { kind: "end" };

function DetailTimeline({
  duration, time, sel, clips, windowStart: ws, span, defaultDuration, editingId, editingNumber,
  onPan, onPointerStart, onPlace, onPickClip, onMove, onResize,
}: {
  duration: number; time: number; sel: Range; clips: EditorClip[]; windowStart: number; span: number;
  defaultDuration: number;
  editingId: string | null;
  editingNumber: number | null;
  onPan: (deltaSec: number) => void;
  onPointerStart: () => void;
  onPlace: (t: number) => void;
  /** Pointer down on an added clip: enter edit mode; returns its range, or null if locked. */
  onPickClip: (id: string) => Range | null;
  onMove: (r: Range) => void;
  onResize: (r: Range, edge: "start" | "end") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const selAtDown = useRef<Range>(sel);

  const tAt = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return ws + clamp((x - r.left) / r.width, 0, 1) * span;
  };
  const pos = (t: number) => ((t - ws) / span) * 100;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    ref.current!.setPointerCapture(e.pointerId);
    onPointerStart();
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-role]");
    const role = hit?.dataset.role;
    const t = tAt(e.clientX);
    selAtDown.current = sel;
    if (role === "clip" && hit?.dataset.clipId) {
      // Grab an added clip: it becomes the edited selection and moves with the pointer.
      const r = onPickClip(hit.dataset.clipId);
      if (r) { selAtDown.current = r; drag.current = { kind: "move", offset: t - r.start }; }
      else drag.current = null;
    }
    else if (role === "start" || role === "end") drag.current = { kind: role };
    else if (role === "body") drag.current = { kind: "move", offset: t - sel.start };
    else { drag.current = { kind: "place" }; onPlace(t); }
  };

  const onMoveEvt = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !ref.current?.hasPointerCapture(e.pointerId)) return;
    const t = tAt(e.clientX);
    if (d.kind === "place") onPlace(t);
    else if (d.kind === "move") onMove(moveSelection(selAtDown.current, t - d.offset - selAtDown.current.start, duration));
    else onResize(resizeSelection(selAtDown.current, d.kind, t, duration), d.kind);
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId);
  };

  const step = tickStep(span);
  const ticks: number[] = [];
  for (let t = Math.ceil(ws / step) * step; t <= ws + span + 1e-6; t += step) ticks.push(t);
  const tickLabel = (t: number) => (step < 1 ? `${fmtClock(t)}.${Math.round((t % 1) * 10)}` : fmtClock(t));

  const selLeft = pos(sel.start);
  const selWidth = ((sel.end - sel.start) / span) * 100;
  const inView = (a: number, b: number) => b >= ws && a <= ws + span;

  return (
    <div
      ref={ref}
      className="relative h-[68px] rounded-xl bg-zinc-900 dark:bg-black/50 border border-zinc-800 dark:border-white/8 cursor-crosshair select-none touch-none overflow-hidden"
      onPointerDown={onDown}
      onPointerMove={onMoveEvt}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onWheel={(e) => onPan(((e.deltaY || e.deltaX) / 600) * span)}
      title={`Click to mark a ${fmtLength(defaultDuration)} clip`}
    >
      {/* Ticks */}
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${pos(t)}%` }}>
          <div className="w-px h-2 bg-white/25" />
          <span className="absolute top-2 left-1 text-[9px] tabular-nums text-white/40 whitespace-nowrap">{tickLabel(t)}</span>
        </div>
      ))}

      {/* Already-added clips from this video */}
      {clips.filter((c) => c.id !== editingId && inView(c.start, c.end)).map((c) => (
        <div key={c.id} data-role="clip" data-clip-id={c.id}
          title={c.locked ? `Clip #${c.number} is exporting` : `Clip #${c.number} — click or drag to edit`}
          className={`absolute bottom-2 h-5 rounded-md border overflow-hidden transition-colors ${c.locked
            ? "bg-emerald-500/15 border-emerald-400/30 cursor-not-allowed"
            : "bg-emerald-500/25 border-emerald-400/50 hover:bg-emerald-500/40 hover:border-emerald-300 cursor-pointer"}`}
          style={{ left: `${pos(c.start)}%`, width: `max(4px, ${((c.end - c.start) / span) * 100}%)` }}>
          <span className="block text-[9px] font-bold text-emerald-300 px-1 leading-5 whitespace-nowrap pointer-events-none">#{c.number}</span>
        </div>
      ))}

      {/* Selection */}
      {inView(sel.start, sel.end) && (
        <div
          data-role="body"
          className={`absolute top-5 bottom-1.5 rounded-lg cursor-grab active:cursor-grabbing border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.3)] ${editingId
            ? "border-emerald-400 bg-emerald-500/40" : "border-violet-400 bg-violet-500/35"}`}
          style={{ left: `${selLeft}%`, width: `max(8px, ${selWidth}%)` }}
        >
          <div data-role="start" className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-ew-resize flex items-center justify-center group">
            <div className="w-1.5 h-6 rounded-full bg-white shadow group-hover:h-8 transition-all" />
          </div>
          <div data-role="end" className="absolute -right-1.5 top-0 bottom-0 w-3 cursor-ew-resize flex items-center justify-center group">
            <div className="w-1.5 h-6 rounded-full bg-white shadow group-hover:h-8 transition-all" />
          </div>
          {selWidth > 6 && (
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white pointer-events-none whitespace-nowrap">
              {editingNumber != null && `#${editingNumber} · `}{fmtLength(roundMs(sel.end - sel.start))}
            </span>
          )}
        </div>
      )}

      {/* Playhead */}
      {inView(time, time) && (
        <div className="absolute top-0 bottom-0 w-[2px] bg-white pointer-events-none" style={{ left: `${pos(time)}%`, transform: "translateX(-1px)" }}>
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-white" />
        </div>
      )}
    </div>
  );
}

/* ─── Small controls ──────────────────────────────────────────────────────── */

function DurationPicker({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const isPreset = (DURATION_PRESETS as readonly number[]).includes(value);
  const commit = () => {
    if (draft == null) return;
    const v = parseFloat(draft.replace(",", "."));
    if (Number.isFinite(v) && v > 0) onChange(v);
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="flex items-center rounded-lg border border-zinc-200 dark:border-white/10 overflow-hidden">
        {DURATION_PRESETS.map((d) => (
          <button key={d} onClick={() => onChange(d)}
            className={`h-7 px-2 text-[11px] font-semibold tabular-nums cursor-pointer border-none transition-colors ${value === d
              ? "bg-violet-500 text-white"
              : "bg-transparent text-zinc-500 hover:bg-zinc-100 dark:hover:bg-white/5 hover:text-zinc-800 dark:hover:text-zinc-200"}`}>
            {d}
          </button>
        ))}
      </div>
      <div className="relative">
        <input
          type="text" inputMode="decimal" aria-label="Custom clip length in seconds"
          value={draft ?? (isPreset ? "" : String(value))}
          placeholder="custom"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") setDraft(null); }}
          className={`w-[68px] h-7 pl-2 pr-5 rounded-lg text-[11.5px] tabular-nums outline-none border transition-colors bg-white dark:bg-white/5 text-zinc-900 dark:text-zinc-100 ${!isPreset
            ? "border-violet-500/60" : "border-zinc-200 dark:border-white/10"} focus:border-violet-500/60`}
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10.5px] text-zinc-400 pointer-events-none">s</span>
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className="w-8 h-8 flex items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 hover:bg-zinc-50 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300 cursor-pointer transition-colors">
      {children}
    </button>
  );
}

function SmallBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title}
      className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-violet-500/30 bg-violet-500/5 hover:bg-violet-500/10 text-[11px] font-semibold text-violet-600 dark:text-violet-300 cursor-pointer transition-colors">
      {children}
    </button>
  );
}
