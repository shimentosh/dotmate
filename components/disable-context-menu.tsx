"use client";

import { useEffect } from "react";
import { logDebug } from "@/lib/log";

/**
 * DisableContextMenu — suppresses the WebView's default browser context menu
 * (Back / Refresh / Save as / Print / Send tab to your devices / Inspect) so the
 * distributed desktop app feels like a native window, not a web page.
 *
 * That menu is the WebView2 (Windows) / WKWebView default — it has nothing to do
 * with the app and looks broken in a shipped product, which is why it was showing
 * up on right-click in the built version.
 *
 * Scope (deliberately narrow so we don't hurt DX or web/demo builds):
 *   • Desktop (Tauri) PRODUCTION builds only. In `tauri:dev`
 *     (NODE_ENV=development) the native menu is left intact so developers keep
 *     right-click → Inspect. The plain web / demo build is untouched.
 *   • Editable text controls (input / textarea / contenteditable) keep their
 *     native menu, so right-click Cut / Copy / Paste still works in script and
 *     form fields.
 *
 * The app's OWN right-click menus (the editor timeline's Radix context menus)
 * are unaffected: we only call `preventDefault` — never `stopPropagation` — so
 * their component handlers still fire and open their custom menus. This mirrors
 * the DisableZoom approach for the same "native feel" reason.
 */
function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName;
  // `isContentEditable` already accounts for inherited (nested) contenteditable.
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable === true;
}

export function DisableContextMenu() {
  useEffect(() => {
    // Keep the native menu (with Inspect) available while developing.
    if (process.env.NODE_ENV !== "production") return;
    // Only the actual desktop app — the browser/demo build keeps normal behaviour.
    const inTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!inTauri) return;

    const onContextMenu = (e: MouseEvent) => {
      // Preserve right-click editing (cut/copy/paste) inside text fields.
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
    };

    // Capture phase so we catch it even if an inner handler stops propagation;
    // we never stopPropagation ourselves, so custom menus still open.
    window.addEventListener("contextmenu", onContextMenu, { capture: true });
    logDebug("disable-context-menu", "native context menu suppressed");

    return () => {
      window.removeEventListener(
        "contextmenu",
        onContextMenu,
        { capture: true } as EventListenerOptions,
      );
    };
  }, []);

  return null;
}
