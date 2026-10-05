"use client";

import { useEffect } from "react";
import { logDebug } from "@/lib/log";

/**
 * DisableZoom — locks the app UI at 100% so it behaves like a native window,
 * not a web page.
 *
 * A desktop webview (WebView2 / WKWebView) otherwise zooms the WHOLE interface on:
 *   • trackpad pinch                    (wheel + ctrl, or WebKit gesture events)
 *   • Ctrl/⌘ + mouse-wheel
 *   • Ctrl/⌘ + "=" / "+" / "-" / "0"
 *
 * We cancel those default page-zoom actions. In-app zoom handlers keep working:
 * we only call `preventDefault` to stop the BROWSER's page-zoom — never
 * `stopPropagation` — so component handlers still receive the event.
 */
export function DisableZoom() {
  useEffect(() => {
    try {
      document.documentElement.style.removeProperty("zoom");
    } catch (e) {
      logDebug("disable-zoom", "Failed to reset zoom", e);
    }

    // Pinch-zoom (Chromium) and Ctrl/⌘ + wheel arrive as a wheel event with a
    // modifier — cancel the page-zoom default. Plain scroll (no modifier) is
    // untouched. Must be non-passive so preventDefault is honoured.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    // Ctrl/⌘ + ( = + - _ 0 ) page-zoom shortcuts.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_" || e.key === "0") {
        e.preventDefault();
      }
    };
    // WebKit (macOS WKWebView) pinch fires magnification gesture events instead.
    const onGesture = (e: Event) => e.preventDefault();

    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("gesturestart", onGesture as EventListener, { passive: false });
    window.addEventListener("gesturechange", onGesture as EventListener, { passive: false });
    window.addEventListener("gestureend", onGesture as EventListener, { passive: false });

    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", onKeyDown, { capture: true } as EventListenerOptions);
      window.removeEventListener("gesturestart", onGesture as EventListener);
      window.removeEventListener("gesturechange", onGesture as EventListener);
      window.removeEventListener("gestureend", onGesture as EventListener);
    };
  }, []);

  return null;
}
