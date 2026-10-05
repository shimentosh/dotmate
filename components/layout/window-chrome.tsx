"use client";

import { isTauri } from "@tauri-apps/api/core";
import { WindowControls } from "@/components/layout/window-controls";
import { useClientValue } from "@/lib/use-client-value";

/**
 * Frameless-window chrome for full-page screens that have no top bar
 * (login, setup, onboarding): a thin top strip you can drag the window by, plus
 * the min/maximize/close controls in the corner. No-op on the web build.
 * Screens that already render the app TopBar don't need this.
 *
 * `isTauri()` is false in the prerendered HTML but true inside the Tauri webview;
 * `useClientValue` reads it without a hydration mismatch.
 */
export function WindowChrome() {
  const inTauri = useClientValue(isTauri, false);

  if (!inTauri) return null;
  return (
    <>
      {/* drag strip across the (empty) top of the screen */}
      <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-40 h-9" />
      {/* controls sit above the drag strip so they stay clickable */}
      <div className="fixed right-0 top-0 z-50 h-9">
        <WindowControls />
      </div>
    </>
  );
}
