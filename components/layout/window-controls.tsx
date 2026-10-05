"use client";

import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Minus, Square, Copy, X } from "lucide-react";
import type { Window } from "@tauri-apps/api/window";
import { isMacOS } from "@/lib/platform";
import { useClientValue } from "@/lib/use-client-value";

/**
 * Custom min / maximize / close controls for the frameless desktop window.
 * Renders nothing on the web build (isTauri() === false). Placed at the far
 * right of the top bar so the bar doubles as the titlebar (CapCut-style).
 *
 * On macOS the OS draws its own native "traffic light" buttons (top-left, via
 * titleBarStyle:"Overlay" in tauri.macos.conf.json), so this custom trio is
 * hidden there — Windows keeps the trio unchanged.
 */
export function WindowControls() {
  const [win, setWin] = useState<Window | null>(null);
  const [maximized, setMaximized] = useState(false);
  const mac = useClientValue(isMacOS, false);

  useEffect(() => {
    if (!isTauri() || isMacOS()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      if (!alive) return;
      setWin(w);
      setMaximized(await w.isMaximized());
      unlisten = await w.onResized(async () => {
        if (alive) setMaximized(await w.isMaximized());
      });
    })();
    return () => { alive = false; unlisten?.(); };
  }, []);

  if (mac || !win) return null;

  const btn =
    "inline-flex h-full w-[46px] items-center justify-center text-zinc-500 dark:text-zinc-400 " +
    "hover:bg-zinc-200/70 dark:hover:bg-white/10 hover:text-zinc-900 dark:hover:text-white transition-colors";

  return (
    <div className="flex h-full items-stretch shrink-0">
      <button type="button" className={btn} onClick={() => void win.minimize()} aria-label="Minimize">
        <Minus size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button" className={btn}
        onClick={() => void win.toggleMaximize()}
        aria-label={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <Copy size={12} strokeWidth={1.8} /> : <Square size={11} strokeWidth={1.8} />}
      </button>
      <button
        type="button"
        className={`${btn} hover:bg-red-600 hover:text-white dark:hover:bg-red-600 dark:hover:text-white`}
        onClick={() => void win.close()} aria-label="Close"
      >
        <X size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}
