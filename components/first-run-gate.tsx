"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isTauri } from "@tauri-apps/api/core";
import { storageKey } from "@/brand.config";

/** localStorage flag set when the first-run setup finishes. */
export const SETUP_DONE_KEY = storageKey("setup-done");

/**
 * Sends a fresh desktop install to the first-run setup (/setup) once, before any
 * tool is shown, so FFmpeg / yt-dlp and the chosen local models are downloaded up
 * front. Renders nothing. No-op outside the Tauri shell.
 */
export function FirstRunGate() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isTauri() || pathname === "/setup") return;
    let done = false;
    try { done = window.localStorage.getItem(SETUP_DONE_KEY) === "1"; } catch { done = true; }
    if (!done) router.replace("/setup");
  }, [pathname, router]);

  return null;
}
