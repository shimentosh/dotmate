"use client";

import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { AlertTriangle, X, Minimize2, XCircle } from "lucide-react";
import { useActiveTasks, isBusyForClose, activeTaskLabels } from "@/store/active-tasks";

/**
 * Intercepts the window Close (and a hard reload) while a long-running task is
 * in progress — renders, transcription, downloads, merges, TTS, etc.
 *
 * Minimizing keeps the window (and its JS-driven work) alive, so it's offered
 * for every task type. Closing/reloading kills the work:
 *   - Minimize to tray  → hide the window; the task keeps running.
 *   - Close anyway      → safe-terminate cancellable tasks (abortAll) then
 *                         destroy the window.
 *   - X / backdrop      → dismiss = keep working (the close is already cancelled).
 *
 * The in-app navigation case is handled separately by the NavGuard
 * (GuardedLink / useGuardedRouter) — this guard owns app exit only.
 *
 * Desktop window-close is Tauri-only; the `beforeunload` fallback covers a
 * browser reload. Mounted once in the root layout. The system-tray icon (Rust,
 * lib.rs) is how a minimized-to-tray window comes back.
 */
export function RenderGuard() {
  const [open, setOpen] = useState(false);

  // Tauri window-close interception (desktop only).
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      // Synchronous callback so preventDefault() lands before Tauri proceeds.
      unlisten = await win.onCloseRequested((event) => {
        if (isBusyForClose()) {
          event.preventDefault();
          setOpen(true);
        }
      });
      if (!alive) unlisten?.();
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Web/reload fallback — the native "Leave site?" prompt when busy. Coexists
  // with the editor's save-only beforeunload (that one doesn't preventDefault).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isBusyForClose()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  if (!open) return null;

  async function minimizeToTray() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
    setOpen(false);
  }

  async function closeAnyway() {
    // Safe-terminate any cancellable task first.
    useActiveTasks.getState().abortAll();
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // destroy() bypasses onCloseRequested and force-closes.
    await getCurrentWindow().destroy();
  }

  const labels = activeTaskLabels();

  return (
    <div
      className="fixed inset-below-titlebar z-[99998] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(12px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/85 backdrop-blur-2xl shadow-[0_24px_70px_rgba(0,0,0,0.6)] overflow-hidden">
        {/* Dismiss = keep working */}
        <button
          onClick={() => setOpen(false)}
          aria-label="Keep working"
          className="absolute top-3.5 right-3.5 z-10 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors border-none cursor-pointer"
        >
          <X size={14} className="text-zinc-400" />
        </button>

        <div className="p-7">
          {/* Icon — subtle amber glass tile (no loud gradient) */}
          <div className="flex justify-center mb-5">
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-400/10 border border-amber-400/20 shadow-[0_0_36px_rgba(245,158,11,0.15)]">
              <AlertTriangle size={26} className="text-amber-400" strokeWidth={1.75} />
            </div>
          </div>

          {/* Badge — subtle glass pill */}
          <div className="flex justify-center mb-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider text-amber-300 bg-amber-400/10 border border-amber-400/20">
              <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
              Task in progress
            </span>
          </div>

          {/* Text */}
          <h2 className="text-[19px] font-bold text-white text-center leading-tight mb-2">
            Work is still in progress
          </h2>
          <p className="text-[13px] text-zinc-400 text-center leading-relaxed mb-5">
            Closing now stops the work below and loses its progress. Minimize to the
            tray to let it finish in the background instead.
          </p>

          {/* Running tasks list (skip the generic render-only case) */}
          {labels.length > 0 && (
            <ul className="mb-5 space-y-1.5">
              {labels.map((l) => (
                <li
                  key={l}
                  className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.07]"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 animate-pulse" />
                  <span className="text-[13px] font-medium text-zinc-200 truncate">
                    {l}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Actions — glassy, dark */}
          <div className="flex flex-col gap-2">
            <button
              onClick={minimizeToTray}
              className="w-full h-11 rounded-xl text-[13.5px] font-semibold text-white flex items-center justify-center gap-2 cursor-pointer border border-violet-400/30 bg-violet-500/25 backdrop-blur-md transition-colors hover:bg-violet-500/35 active:bg-violet-500/30"
            >
              <Minimize2 size={16} />
              Minimize to system tray
            </button>
            <button
              onClick={closeAnyway}
              className="w-full h-10 rounded-xl text-[13px] font-medium text-red-300 flex items-center justify-center gap-2 cursor-pointer border border-red-500/20 bg-red-500/10 backdrop-blur-md transition-colors hover:bg-red-500/20"
            >
              <XCircle size={15} />
              Close anyway &amp; stop tasks
            </button>
            <button
              onClick={() => setOpen(false)}
              className="w-full h-9 text-[12.5px] text-zinc-500 hover:text-zinc-300 cursor-pointer bg-transparent border-none transition-colors"
            >
              Keep working
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
