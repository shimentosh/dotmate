"use client";
import { useEffect } from "react";
import { initGlobalErrorHandling } from "@/lib/global-error-handler";
import { initErrorLogForwarding } from "@/lib/error-log-forwarder";
import { applyStoredTheme } from "@/lib/theme";

/**
 * One-time app bootstrap: global error handlers, the native error-log tee, theme,
 * and the startup splash handoff. Renders nothing.
 */
export function AppInit() {
  useEffect(() => {
    // Global unhandled-rejection / uncaught-error handlers, once, as early as possible.
    initGlobalErrorHandling();
    // Tee frontend errors into the native error log file (desktop only).
    initErrorLogForwarding();
  }, []);

  useEffect(() => {
    // Apply the stored theme before revealing the page so there's no flash.
    applyStoredTheme();

    const splash = document.getElementById("app-splash");

    const reveal = () => {
      if (!splash) return;
      // Hold the in-window loader a short, fixed beat AFTER the app mounts, then
      // fade it out. The heavy boot is covered by the separate splash WINDOW.
      setTimeout(() => {
        splash.style.opacity = "0";
        splash.style.pointerEvents = "none";
        setTimeout(() => { splash.style.display = "none"; }, 550);
      }, 700);
    };

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      // Mark the document as running inside Tauri so CSS (--titlebar-h, the
      // frameless title-bar safe area used by modal overlays) can react to it.
      document.documentElement.setAttribute("data-tauri", "true");
      // Tell the native side the app has mounted → reveal the main window and
      // close the startup splash window. Backup to the Rust on_page_load trigger.
      import("@/lib/tauri-invoke")
        .then(({ safeInvoke }) => safeInvoke("app_ready", undefined, { timeoutMs: 0 }))
        .catch(() => { /* on_page_load / setup() fallback timer still handle it */ });
    }
    reveal();
  }, []);

  return null;
}
