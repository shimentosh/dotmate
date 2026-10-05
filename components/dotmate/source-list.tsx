"use client";

import { memo, useEffect, useState } from "react";
import { FileVideo, Loader2, AlertCircle, Link2, Trash2, Plus, Upload } from "lucide-react";
import { fmtClock } from "@/lib/dotmate/format";
import type { DmSource } from "@/store/batch-clips";

const SourceRow = memo(function SourceRow({
  source, index, clipCount, selected, onSelect, onRemove,
}: {
  source: DmSource;
  index: number;
  clipCount: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);

  const usable = source.status === "ready";
  return (
    <div
      onClick={() => onSelect(source.id)}
      className={`group relative flex items-center gap-2.5 px-2.5 py-2 rounded-xl border cursor-pointer transition-all ${selected
        ? "border-violet-400/50 bg-violet-500/[0.07]"
        : "border-transparent hover:bg-zinc-100/80 dark:hover:bg-white/[0.04]"}`}
    >
      <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center border ${selected
        ? "border-violet-500/30 bg-violet-500/10" : "border-zinc-200 dark:border-white/8 bg-white dark:bg-white/[0.03]"}`}>
        {source.status === "loading" && <Loader2 size={14} className="text-zinc-400 animate-spin" />}
        {source.status === "ready" && <FileVideo size={14} className={selected ? "text-violet-500" : "text-zinc-400"} />}
        {source.status === "missing" && <Link2 size={14} className="text-amber-500" />}
        {source.status === "error" && <AlertCircle size={14} className="text-red-500" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Video {String(index + 1).padStart(2, "0")}</p>
        <p className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200 truncate" title={source.name}>{source.name}</p>
        <p className="text-[10.5px] tabular-nums text-zinc-400 truncate">
          {source.status === "missing" ? <span className="text-amber-600 dark:text-amber-400">Not connected — re-import to use</span>
            : source.status === "error" ? <span className="text-red-500">{source.error ?? "Can't read this video"}</span>
            : source.duration != null ? <>{fmtClock(source.duration)}{source.width > 0 && <> · {source.width}×{source.height}</>}</>
            : "Reading…"}
        </p>
      </div>
      {clipCount > 0 && (
        <span className={`shrink-0 text-[10.5px] font-bold tabular-nums px-1.5 py-0.5 rounded-md group-hover:hidden ${usable
          ? "bg-violet-500/10 text-violet-600 dark:text-violet-300" : "bg-zinc-100 dark:bg-white/5 text-zinc-500"}`}
          title={`${clipCount} clip${clipCount === 1 ? "" : "s"} in the queue`}>
          {clipCount}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (clipCount > 0 && !confirm) { setConfirm(true); return; }
          onRemove(source.id);
        }}
        title={clipCount > 0 ? `Remove video and its ${clipCount} clip${clipCount === 1 ? "" : "s"}` : "Remove video"}
        className={`shrink-0 h-6 rounded-md items-center justify-center cursor-pointer border-none transition-colors ${confirm
          ? "flex px-1.5 text-[10px] font-bold text-white bg-red-500"
          : "hidden group-hover:flex w-6 text-zinc-400 hover:text-red-500 hover:bg-red-500/10 bg-transparent"}`}
      >
        {confirm ? `Remove +${clipCount}` : <Trash2 size={12} />}
      </button>
    </div>
  );
});

export function SourceList({
  sources, clipCounts, selectedId, onSelect, onRemove, onImport, onReconnect, onDropFiles,
}: {
  sources: DmSource[];
  clipCounts: Map<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onImport: () => void;
  onReconnect: () => void;
  onDropFiles: (dt: DataTransfer) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const missing = sources.filter((s) => s.status === "missing").length;

  return (
    <div
      className={`flex-1 flex flex-col min-h-0 transition-colors ${dragOver ? "bg-violet-500/[0.06]" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); onDropFiles(e.dataTransfer); }}
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">Source videos · {sources.length}</p>
        <button onClick={onImport}
          className="flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-semibold text-violet-600 dark:text-violet-300 bg-violet-500/10 hover:bg-violet-500/15 border-none cursor-pointer transition-colors">
          <Plus size={11} strokeWidth={2.6} /> Add
        </button>
      </div>

      {missing > 0 && (
        <div className="mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
          <p className="text-[11px] text-amber-700 dark:text-amber-300">
            {missing} video{missing === 1 ? "" : "s"} from your last session {missing === 1 ? "needs" : "need"} reconnecting. Your clips are safe.
          </p>
          <button onClick={onReconnect}
            className="mt-1.5 h-6 px-2.5 rounded-md text-[10.5px] font-bold text-white bg-amber-500 hover:bg-amber-600 border-none cursor-pointer transition-colors">
            Reconnect videos
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {sources.map((s, i) => (
          <SourceRow
            key={s.id}
            source={s}
            index={i}
            clipCount={clipCounts.get(s.id) ?? 0}
            selected={s.id === selectedId}
            onSelect={onSelect}
            onRemove={onRemove}
          />
        ))}
        <button onClick={onImport}
          className={`w-full mt-1.5 flex flex-col items-center justify-center gap-1 py-4 rounded-xl border-2 border-dashed cursor-pointer transition-colors bg-transparent ${dragOver
            ? "border-violet-400 text-violet-500" : "border-zinc-200 dark:border-white/10 text-zinc-400 hover:border-violet-400/50 hover:text-violet-500"}`}>
          <Upload size={15} />
          <span className="text-[11px] font-medium">Drop more videos or click to add</span>
        </button>
      </div>
    </div>
  );
}
