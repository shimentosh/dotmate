"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clapperboard, Loader2, CheckCircle2, AlertTriangle, X,
  FolderOpen, Play, Maximize2, Minus,
} from "lucide-react";
import { useRenderJobs, type RenderJob } from "@/store/render-jobs";
import { logWarn } from "@/lib/log";

/**
 * Floating dock that shows every active / recent render (see store/render-jobs.ts).
 * Mounted once in the root layout so a render started in a tool keeps showing
 * progress — and its finished result + Open/Show-in-folder actions — even after
 * the user navigates to another page. File actions no-op outside the Tauri shell.
 */

async function openFile(path: string) {
  try {
    const { isTauri, invoke } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    await invoke("open_file", { path });
  } catch (e) { logWarn("render-dock", "open_file failed", e); }
}
async function revealFile(path: string) {
  try {
    const { isTauri, invoke } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    await invoke("reveal_in_folder", { path });
  } catch (e) { logWarn("render-dock", "reveal_in_folder failed", e); }
}

function JobRow({ job, onGo }: { job: RenderJob; onGo: (href?: string) => void }) {
  const { removeJob } = useRenderJobs();
  const running = job.status === "running";
  const done = job.status === "done";
  const cancelled = job.status === "cancelled";
  const errored = job.status === "error" || cancelled;

  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        {/* Status icon */}
        <div className={[
          "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border",
          done ? "bg-green-500/10 border-green-500/25"
            : errored ? "bg-red-500/10 border-red-500/25"
            : "border-violet-500/25",
        ].join(" ")}
          style={running ? { background: "linear-gradient(135deg,rgba(0,87,252,0.16),rgba(0,71,209,0.14))" } : undefined}>
          {running ? <Loader2 size={13} className="text-violet-500 animate-spin" />
            : done ? <CheckCircle2 size={13} className="text-green-500" />
            : errored ? <AlertTriangle size={13} className="text-red-500" />
            : <Clapperboard size={13} className="text-violet-500" />}
        </div>

        {/* Label + sub */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <button
              onClick={() => running && job.href && onGo(job.href)}
              title={running && job.href ? "Return to this render" : job.label}
              className={`text-[12px] font-semibold truncate bg-transparent border-none p-0 text-left font-[inherit] ${running && job.href ? "text-violet-600 dark:text-violet-300 cursor-pointer hover:underline" : "text-zinc-800 dark:text-zinc-100 cursor-default"}`}
            >
              {job.label}
            </button>
            {running && (
              <span className="text-[11px] font-bold tabular-nums shrink-0 text-violet-500">{job.progress}%</span>
            )}
          </div>
          <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate mt-0.5">
            {cancelled ? "Cancelled"
              : errored ? (job.error ?? "Render failed")
              : done ? "Saved to Downloads"
              : job.total && job.total > 1 ? `Rendering ${job.current ?? 1} of ${job.total}…`
              : "Rendering…"}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          {done && job.outputPath && (
            <>
              <button onClick={() => openFile(job.outputPath!)} title="Open"
                className="w-7 h-7 rounded-lg flex items-center justify-center bg-transparent border-none cursor-pointer text-zinc-400 hover:text-violet-500 hover:bg-violet-500/10 transition">
                <Play size={12} />
              </button>
              <button onClick={() => revealFile(job.outputPath!)} title="Show in folder"
                className="w-7 h-7 rounded-lg flex items-center justify-center bg-transparent border-none cursor-pointer text-zinc-400 hover:text-violet-500 hover:bg-violet-500/10 transition">
                <FolderOpen size={12} />
              </button>
            </>
          )}
          {!running && (
            <button onClick={() => removeJob(job.id)} title="Dismiss"
              className="w-7 h-7 rounded-lg flex items-center justify-center bg-transparent border-none cursor-pointer text-zinc-400 hover:text-red-500 hover:bg-red-500/10 transition">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Progress rail (running only) */}
      {running && (
        <div className="mt-2 h-1 rounded-full overflow-hidden bg-zinc-200/70 dark:bg-white/8">
          <div className="h-full rounded-full transition-all duration-200"
            style={{ width: `${job.progress}%`, background: "var(--brand-gradient)" }} />
        </div>
      )}
    </div>
  );
}

export function RenderDock() {
  const router = useRouter();
  const { jobs, clearDone } = useRenderJobs();
  const [minimized, setMinimized] = useState(false);

  if (jobs.length === 0) return null;

  const running = jobs.filter((j) => j.status === "running");
  const activeCount = running.length;
  const avg = activeCount ? Math.round(running.reduce((s, j) => s + j.progress, 0) / activeCount) : 100;

  const go = (href?: string) => { if (href) router.push(href); };

  const bottomPx = 20;

  /* ── Minimized pill ── */
  if (minimized) {
    return (
      <div className="dark fixed right-5 z-[99997] w-[300px] rounded-2xl overflow-hidden bg-zinc-900/95 border border-white/10 shadow-[0_14px_50px_-8px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        style={{ bottom: bottomPx }}>
        <div className="flex items-center gap-3 px-3.5 py-3">
          <div className="relative shrink-0">
            {activeCount > 0 && (
              <div className="absolute -inset-1 rounded-2xl opacity-40 blur-md"
                style={{ background: "var(--brand-gradient)" }} />
            )}
            <div className="relative w-9 h-9 rounded-xl flex items-center justify-center border border-violet-500/25"
              style={{ background: "linear-gradient(135deg,rgba(0,87,252,0.16),rgba(0,71,209,0.14))" }}>
              {activeCount > 0
                ? <Loader2 size={15} className="text-violet-500 animate-spin" />
                : <Clapperboard size={15} className="text-violet-500" />}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100 truncate">
              {activeCount > 0 ? `Rendering ${activeCount} video${activeCount > 1 ? "s" : ""}` : `${jobs.length} render${jobs.length > 1 ? "s" : ""} done`}
            </p>
            <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 truncate mt-0.5">
              {activeCount > 0 ? `${avg}% · keeps going in the background` : "Tap to view"}
            </p>
          </div>
          <button onClick={() => setMinimized(false)} title="Expand"
            className="w-7 h-7 rounded-lg flex items-center justify-center bg-transparent border-none cursor-pointer text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/[0.08] transition shrink-0">
            <Maximize2 size={12} />
          </button>
        </div>
        {activeCount > 0 && (
          <div className="h-1 bg-zinc-100 dark:bg-white/[0.06] overflow-hidden">
            <div className="h-full transition-all duration-300"
              style={{ width: `${avg}%`, background: "var(--brand-gradient)" }} />
          </div>
        )}
      </div>
    );
  }

  /* ── Expanded list ── */
  return (
    <div className="dark fixed right-5 z-[99997] w-[340px] rounded-2xl overflow-hidden bg-zinc-900/95 border border-white/10 shadow-[0_14px_50px_-8px_rgba(0,0,0,0.45)] backdrop-blur-xl"
      style={{ bottom: bottomPx }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-zinc-100 dark:border-white/8">
        <Clapperboard size={14} className="text-violet-500 shrink-0" />
        <p className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100 flex-1">
          {activeCount > 0 ? `Rendering ${activeCount} · ${avg}%` : "Renders"}
        </p>
        {jobs.some((j) => j.status !== "running") && (
          <button onClick={clearDone} title="Clear finished"
            className="text-[10.5px] text-zinc-400 hover:text-red-500 transition bg-transparent border-none cursor-pointer font-[inherit]">
            Clear
          </button>
        )}
        <button onClick={() => setMinimized(true)} title="Minimize"
          className="w-7 h-7 rounded-lg flex items-center justify-center bg-transparent border-none cursor-pointer text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/[0.08] transition shrink-0">
          <Minus size={13} />
        </button>
      </div>
      {/* Jobs */}
      <div className="max-h-[60vh] overflow-y-auto divide-y divide-zinc-50 dark:divide-white/[0.04]">
        {jobs.map((j) => <JobRow key={j.id} job={j} onGo={go} />)}
      </div>
    </div>
  );
}
