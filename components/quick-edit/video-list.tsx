"use client";

import { memo } from "react";
import { AlertCircle, Check, CheckCircle2, FileVideo, FolderOpen, Loader2, Plus, X } from "lucide-react";
import { fmtClock } from "@/lib/dotmate/format";
import type { QeVideo } from "@/store/quick-edit";

async function reveal(path: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_in_folder", { path });
}

const VideoRow = memo(function VideoRow({
  video, active, locked, onSelect, onToggle, onRemove,
}: {
  video: QeVideo;
  active: boolean;
  locked: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { info } = video;
  const rendering = video.render === "rendering";
  return (
    <div
      onClick={() => onSelect(video.id)}
      className={`group relative flex items-center gap-2.5 px-2.5 py-2 rounded-xl border cursor-pointer transition-all ${active
        ? "border-violet-400/50 bg-violet-500/[0.07]"
        : "border-transparent hover:bg-zinc-100/80 dark:hover:bg-white/[0.04]"}`}
    >
      <button
        role="checkbox"
        aria-checked={video.checked}
        aria-label={`Include ${video.name}`}
        disabled={video.status !== "ready" || locked}
        onClick={(e) => { e.stopPropagation(); onToggle(video.id); }}
        className={`w-4 h-4 shrink-0 rounded-[5px] flex items-center justify-center border cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 transition-colors ${video.checked
          ? "bg-violet-500 border-violet-500" : "bg-white dark:bg-white/[0.03] border-zinc-300 dark:border-white/20"}`}
      >
        {video.checked && <Check size={11} strokeWidth={3} className="text-white" />}
      </button>

      <div className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center border border-zinc-200 dark:border-white/8 bg-white dark:bg-white/[0.03]">
        {video.status === "probing" || rendering ? <Loader2 size={14} className="text-violet-500 animate-spin" />
          : video.status === "error" || video.render === "failed" ? <AlertCircle size={14} className="text-red-500" />
          : video.render === "done" ? <CheckCircle2 size={14} className="text-green-500" />
          : <FileVideo size={14} className={active ? "text-violet-500" : "text-zinc-400"} />}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200 truncate" title={video.name}>{video.name}</p>
        <p className="text-[10.5px] tabular-nums text-zinc-400 truncate">
          {video.status === "error" ? <span className="text-red-500">{video.error ?? "Can't read this video"}</span>
            : video.render === "failed" ? <span className="text-red-500" title={video.renderError}>{video.renderError ?? "Render failed"}</span>
            : rendering ? <span className="text-violet-500">Rendering {Math.round(video.progress * 100)}%</span>
            : video.render === "queued" ? "Waiting…"
            : video.render === "done" ? <span className="text-green-600 dark:text-green-400">Saved</span>
            : info ? <>{fmtClock(info.duration)} · {info.width}×{info.height}{!info.hasAudio && " · no audio"}</>
            : "Reading…"}
        </p>
        {rendering && (
          <div className="mt-1 h-1 rounded-full overflow-hidden bg-zinc-200/70 dark:bg-white/8">
            <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${video.progress * 100}%`, background: "var(--brand-gradient)" }} />
          </div>
        )}
      </div>

      {video.render === "done" && video.outputPath ? (
        <button
          onClick={(e) => { e.stopPropagation(); void reveal(video.outputPath!); }}
          title="Show in folder"
          className="w-6 h-6 shrink-0 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer text-zinc-400 hover:text-violet-500 hover:bg-violet-500/10 transition"
        >
          <FolderOpen size={12} />
        </button>
      ) : !rendering && video.render !== "queued" && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(video.id); }}
          title="Remove from list"
          className="w-6 h-6 shrink-0 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-500/10 transition"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
});

export function VideoList({
  videos, activeId, running, onSelect, onToggle, onToggleAll, onRemove, onAdd, onClear,
}: {
  videos: QeVideo[];
  activeId: string | null;
  running: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onClear: () => void;
}) {
  const ready = videos.filter((v) => v.status === "ready");
  const checked = ready.filter((v) => v.checked).length;
  const allChecked = ready.length > 0 && checked === ready.length;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-3.5 h-11 border-b border-zinc-200 dark:border-white/8">
        <button
          role="checkbox"
          aria-checked={allChecked}
          aria-label="Select all videos"
          disabled={!ready.length || running}
          onClick={() => onToggleAll(!allChecked)}
          className={`w-4 h-4 shrink-0 rounded-[5px] flex items-center justify-center border cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${allChecked
            ? "bg-violet-500 border-violet-500" : "bg-white dark:bg-white/[0.03] border-zinc-300 dark:border-white/20"}`}
        >
          {allChecked && <Check size={11} strokeWidth={3} className="text-white" />}
        </button>
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400 truncate">
          Videos · {checked}/{videos.length} selected
        </span>
        {!running && videos.length > 0 && (
          <button onClick={onClear} className="text-[10.5px] text-zinc-400 hover:text-red-500 bg-transparent border-none cursor-pointer font-[inherit]">Clear</button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-0.5">
        {videos.map((v) => (
          <VideoRow key={v.id} video={v} active={v.id === activeId} locked={running}
            onSelect={onSelect} onToggle={onToggle} onRemove={onRemove} />
        ))}
      </div>
      <div className="shrink-0 p-2.5 border-t border-zinc-200 dark:border-white/8">
        <button onClick={onAdd}
          className="w-full h-9 rounded-lg text-[12px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer border border-dashed border-zinc-300 dark:border-white/15 bg-transparent text-zinc-600 dark:text-zinc-300 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-300 transition-colors">
          <Plus size={13} /> Add videos
        </button>
      </div>
    </div>
  );
}
