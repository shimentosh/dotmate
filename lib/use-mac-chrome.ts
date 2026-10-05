"use client";

import { useEffect, useState } from "react";
import { isMacOS } from "@/lib/platform";

/**
 * True when macOS traffic lights are visible — i.e. left-aligned chrome content
 * must be padded so it clears them. That's macOS AND not fullscreen (macOS hides
 * the traffic lights in fullscreen, so the padding is dropped to avoid a gap).
 *
 * Returns false on Windows/web and during SSR (until mounted), so those builds
 * render exactly as before. Used by the global TopBar and the editor's titlebar
 * so the two never drift.
 */
export function useTrafficLightPad(): boolean {
  const [pad, setPad] = useState(false);
  useEffect(() => {
    if (!isMacOS()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      const sync = async () => {
        try {
          const fs = await w.isFullscreen();
          if (alive) setPad(!fs);
        } catch { /* not in a Tauri window */ }
      };
      await sync();
      // Entering/leaving fullscreen resizes the window → re-check on resize.
      unlisten = await w.onResized(sync);
    })();
    return () => { alive = false; unlisten?.(); };
  }, []);
  return pad;
}
