"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  GripVertical, Play, X, Loader2, CheckCircle2, AlertCircle, Clock, FolderOpen,
  StopCircle, Download, RotateCcw, ListVideo,
} from "lucide-react";
import { fmtLength, fmtTime, clipFileName, cleanPrefix } from "@/lib/dotmate/format";
import type { DmClip, ExportState } from "@/store/batch-clips";

/* ─── Status pill ─────────────────────────────────────────────────────────── */

function StatusPill({ clip, progress }: { clip: DmClip; progress: number | null }) {
  switch (clip.status) {
    case "preparing":
      return <span className="flex items-center gap-1 text-[10.5px] font-semibold text-amber-600 dark:text-amber-400"><Loader2 size={11} className="animate-spin" /> Preparing</span>;
    case "rendering":
      return <span className="flex items-center gap-1 text-[10.5px] font-semibold text-violet-600 dark:text-violet-300 tabular-nums"><Loader2 size={11} className="animate-spin" /> {Math.round((progress ?? 0) * 100)}%</span>;
    case "completed":
      return <span className="flex items-center gap-1 text-[10.5px] font-semibold text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={11} /> Done</span>;
    case "failed":
      return <span className="flex items-center gap-1 text-[10.5px] font-semibold text-red-500"><AlertCircle size={11} /> Failed</span>;
    default:
      return <span className="flex items-center gap-1 text-[10.5px] text-zinc-400"><Clock size={11} /> Waiting</span>;
  }
}

/* ─── Row ─────────────────────────────────────────────────────────────────── */

interface RowProps {
  clip: DmClip;
  index: number;
  sourceName: string;
  progress: number | null;
  locked: boolean;
  dropMark: "before" | "after" | null;
  onPreview: (clip: DmClip) => void;
  onEdit: (clip: DmClip) => void;
  onRemove: (id: string) => void;
  onDragStartRow: (id: string) => void;
  onDragOverRow: (index: number, after: boolean) => void;
  onDropRow: () => void;
}

const QueueRow = memo(function QueueRow({
  clip, index, sourceName, progress, locked, dropMark,
  onPreview, onEdit, onRemove, onDragStartRow, onDragOverRow, onDropRow,
}: RowProps) {
  const active = clip.status === "rendering" || clip.status === "preparing";
  return (
    <div
      data-clip-id={clip.id}
      draggable={!locked}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStartRow(clip.id); }}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDragOverRow(index, e.clientY > r.top + r.height / 2);
      }}
      onDrop={(e) => { e.preventDefault(); onDropRow(); }}
      onClick={() => onEdit(clip)}
      title="Click to edit this clip on the timeline"
      className={`group relative px-2 py-1.5 rounded-lg border cursor-pointer transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_44px] ${active
        ? "border-violet-400/50 bg-violet-500/[0.06]"
        : clip.status === "failed"
        ? "border-red-500/25 bg-red-500/[0.03]"
        : "border-transparent hover:bg-zinc-100/80 dark:hover:bg-white/[0.04]"}`}
    >
      {dropMark && (
        <div className={`absolute left-1 right-1 h-0.5 rounded-full bg-violet-500 ${dropMark === "before" ? "-top-[2px]" : "-bottom-[2px]"}`} />
      )}
      <div className="flex items-center gap-1.5">
        <GripVertical size={12} className={`shrink-0 text-zinc-300 dark:text-zinc-600 ${locked ? "opacity-0" : "cursor-grab"}`} />
        <span className="w-8 shrink-0 text-[11px] font-bold tabular-nums text-zinc-400">{String(index + 1).padStart(2, "0")}</span>
        <div className="flex-1 min-w-0">
          <p className="text-[11.5px] font-semibold text-zinc-800 dark:text-zinc-200 truncate" title={sourceName}>{sourceName}</p>
          <p className="text-[10.5px] tabular-nums text-zinc-500 dark:text-zinc-400">
            {fmtTime(clip.start)} → {fmtTime(clip.end)}
            <span className="ml-1.5 text-violet-600 dark:text-violet-300 font-semibold">{fmtLength(clip.end - clip.start)}</span>
          </p>
        </div>
        <div className="shrink-0 w-[78px] flex justify-end group-hover:hidden">
          <StatusPill clip={clip} progress={progress} />
        </div>
        <div className="shrink-0 w-[78px] hidden group-hover:flex justify-end gap-0.5">
          <button onClick={(e) => { e.stopPropagation(); onPreview(clip); }} title="Play this clip"
            className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-violet-500 hover:bg-violet-500/10 cursor-pointer border-none bg-transparent">
            <Play size={11} />
          </button>
          {!active && (
            <button onClick={(e) => { e.stopPropagation(); onRemove(clip.id); }} title="Remove from queue"
              className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-500/10 cursor-pointer border-none bg-transparent">
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      {clip.status === "rendering" && (
        <div className="mt-1 ml-[52px] h-1 rounded-full bg-zinc-200/70 dark:bg-white/8 overflow-hidden">
          <div className="h-full rounded-full transition-[width] duration-150"
            style={{ width: `${Math.round((progress ?? 0) * 100)}%`, background: "linear-gradient(90deg,#3D7EFD,#0047D1)" }} />
        </div>
      )}
      {clip.status === "failed" && clip.error && (
        <p className="mt-0.5 ml-[52px] text-[10px] text-red-500/90 line-clamp-2">{clip.error}</p>
      )}
      {clip.status === "completed" && clip.outputName && (
        <p className="ml-[52px] text-[10px] text-zinc-400 truncate">{clip.outputName}</p>
      )}
    </div>
  );
});

/* ─── Queue list ──────────────────────────────────────────────────────────── */

export function ClipQueue({
  clips, sourceNames, exp, onPreview, onEdit, onRemove, onMove, onClear,
}: {
  clips: DmClip[];
  sourceNames: Map<string, string>;
  exp: ExportState;
  onPreview: (clip: DmClip) => void;
  onEdit: (clip: DmClip) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onClear: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const locked = exp.running;

  // Follow the clip being rendered.
  useEffect(() => {
    if (!exp.currentClipId) return;
    const el = listRef.current?.querySelector(`[data-clip-id="${exp.currentClipId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [exp.currentClipId]);

  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  const total = clips.reduce((s, c) => s + (c.end - c.start), 0);

  // Stable handlers (refs, not closures over state) so memoised rows don't all
  // re-render on every progress tick of a long export.
  const dropRef = useRef(drop);
  const clipsRef = useRef(clips);
  const onMoveRef = useRef(onMove);
  useEffect(() => { dropRef.current = drop; clipsRef.current = clips; onMoveRef.current = onMove; });

  const onDragStartRow = useCallback((id: string) => { dragId.current = id; }, []);
  const onDragOverRow = useCallback((index: number, after: boolean) => {
    if (!dragId.current) return;
    setDrop((d) => (d && d.index === index && d.after === after ? d : { index, after }));
  }, []);
  const onDropRow = useCallback(() => {
    const id = dragId.current;
    const d = dropRef.current;
    if (id && d) {
      const from = clipsRef.current.findIndex((c) => c.id === id);
      let to = d.index + (d.after ? 1 : 0);
      if (from < to) to -= 1;
      if (from !== to) onMoveRef.current(id, to);
    }
    dragId.current = null;
    setDrop(null);
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">Clip queue · {clips.length}</p>
          {clips.length > 0 && <p className="text-[10.5px] text-zinc-400 mt-0.5 tabular-nums">{fmtLength(Math.round(total * 10) / 10)} total</p>}
        </div>
        {clips.length > 0 && !locked && (
          <button
            onClick={() => (confirmClear ? (onClear(), setConfirmClear(false)) : setConfirmClear(true))}
            className={`text-[10.5px] font-semibold cursor-pointer border-none bg-transparent transition-colors ${confirmClear ? "text-red-500" : "text-zinc-400 hover:text-red-500"}`}
          >
            {confirmClear ? `Remove all ${clips.length}?` : "Clear all"}
          </button>
        )}
      </div>

      {clips.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <ListVideo size={26} strokeWidth={1.4} className="text-zinc-300 dark:text-zinc-600" />
          <p className="text-[12px] font-semibold text-zinc-500 dark:text-zinc-400">No clips yet</p>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">Mark a moment on the timeline and press <span className="font-bold text-violet-500">Add Clip</span> (or A).</p>
        </div>
      ) : (
        <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5" onDragEnd={() => { dragId.current = null; setDrop(null); }}>
          {clips.map((c, i) => (
            <QueueRow
              key={c.id}
              clip={c}
              index={i}
              sourceName={sourceNames.get(c.sourceId) ?? "Removed video"}
              progress={c.id === exp.currentClipId ? exp.progress : null}
              locked={locked}
              dropMark={drop && drop.index === i ? (drop.after ? "after" : "before") : null}
              onPreview={onPreview}
              onEdit={onEdit}
              onRemove={onRemove}
              onDragStartRow={onDragStartRow}
              onDragOverRow={onDragOverRow}
              onDropRow={onDropRow}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Export panel ────────────────────────────────────────────────────────── */

export function ExportPanel({
  clips, exp, prefix, outputLabel, onPrefix, onChooseFolder, onExport, onStop, onExportAgain,
}: {
  clips: DmClip[];
  exp: ExportState;
  prefix: string;
  outputLabel: string | null;
  onPrefix: (p: string) => void;
  onChooseFolder: () => void;
  onExport: () => void;
  onStop: () => void;
  onExportAgain: () => void;
}) {
  const completed = clips.filter((c) => c.status === "completed").length;
  const failed = clips.filter((c) => c.status === "failed").length;
  const pending = clips.length - completed;
  const pct = clips.length ? (completed / clips.length) * 100 : 0;
  const allDone = clips.length > 0 && pending === 0;
  const current = exp.currentClipId ? clips.findIndex((c) => c.id === exp.currentClipId) : -1;

  return (
    <div className="shrink-0 border-t border-zinc-200 dark:border-white/8 px-4 py-3.5 space-y-3">
      {/* Output */}
      <div className="flex items-center gap-2">
        <button
          onClick={onChooseFolder}
          disabled={exp.running}
          title="Choose the folder clips are saved to"
          className="flex-1 min-w-0 flex items-center gap-2 h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 hover:border-violet-400/50 text-left cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          <FolderOpen size={13} className="shrink-0 text-violet-500" />
          <span className={`text-[11.5px] truncate ${outputLabel ? "font-semibold text-zinc-700 dark:text-zinc-200" : "text-zinc-400"}`}>
            {outputLabel ?? "Choose output folder…"}
          </span>
        </button>
        <div className="flex items-center h-8 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 focus-within:border-violet-500/60 overflow-hidden" title="File name prefix">
          <input
            value={prefix}
            onChange={(e) => onPrefix(e.target.value)}
            onBlur={() => onPrefix(cleanPrefix(prefix))}
            disabled={exp.running}
            aria-label="File name prefix"
            className="w-[64px] h-full pl-2 text-[11.5px] font-semibold outline-none bg-transparent text-zinc-800 dark:text-zinc-100"
          />
          <span className="pr-2 text-[11px] text-zinc-400 tabular-nums">_001.mp4</span>
        </div>
      </div>

      {/* Progress */}
      {clips.length > 0 && (completed > 0 || exp.running || failed > 0) && (
        <div>
          <div className="flex items-center justify-between mb-1 text-[10.5px] tabular-nums">
            <span className="font-semibold text-zinc-600 dark:text-zinc-300">{completed} / {clips.length} completed</span>
            <span className="text-zinc-400">
              {failed > 0 && <span className="text-red-500 font-semibold mr-2">{failed} failed</span>}
              {exp.running && current >= 0 && `Clip ${current + 1} · ${exp.stopping ? "stopping…" : `${Math.round(exp.progress * 100)}%`}`}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-200/70 dark:bg-white/8 overflow-hidden">
            <div className="h-full rounded-full transition-all duration-300"
              style={{ width: `${pct}%`, background: allDone ? "linear-gradient(90deg,#10b981,#059669)" : "linear-gradient(90deg,#3D7EFD,#0047D1)" }} />
          </div>
        </div>
      )}

      {/* Actions */}
      {exp.running ? (
        <button
          onClick={onStop}
          disabled={exp.stopping}
          className="w-full h-11 rounded-xl text-[13px] font-bold cursor-pointer border border-red-500/30 text-red-500 bg-transparent hover:bg-red-500/[0.06] flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
        >
          <StopCircle size={15} /> {exp.stopping ? "Stopping…" : "Stop export"}
        </button>
      ) : allDone ? (
        <button
          onClick={onExportAgain}
          className="w-full h-11 rounded-xl text-[13px] font-bold cursor-pointer border border-zinc-200 dark:border-white/10 bg-transparent text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 flex items-center justify-center gap-2 transition-colors"
        >
          <RotateCcw size={14} /> Export all again
        </button>
      ) : (
        <button
          onClick={onExport}
          disabled={pending === 0}
          className="w-full h-11 rounded-xl text-[13.5px] font-bold text-white border-none cursor-pointer flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity shadow-[0_8px_24px_-8px_rgba(0,87,252,0.7)]"
          style={{ background: "linear-gradient(135deg,#3D7EFD,#0047D1)" }}
        >
          <Download size={15} />
          {pending === 0 ? "EXPORT ALL" : `EXPORT ALL · ${pending} clip${pending === 1 ? "" : "s"}`}
        </button>
      )}
      {!exp.running && pending > 0 && (
        <p className="text-[10px] text-center text-zinc-400 -mt-1.5">
          Saves {clipFileName(prefix, 1, clips.length)} … at source resolution &amp; frame rate
        </p>
      )}
    </div>
  );
}
