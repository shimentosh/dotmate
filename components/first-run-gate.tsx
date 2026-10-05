"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isTauri } from "@tauri-apps/api/core";
import { storageKey } from "@/brand.config";
import { ffmpegStatus, ytdlpStatus } from "@/lib/deps-local";
import { logWarn } from "@/lib/log";

/** localStorage flag set when the first-run setup finishes. */
export const SETUP_DONE_KEY = storageKey("setup-done");

/** `/setup?repair=1` reinstalls only the missing essentials, then returns home. */
export const SETUP_REPAIR_HREF = "/setup?repair=1";

/** The essentials check runs once per app launch, not on every navigation. */
let essentialsChecked = false;

/**
 * Sends a fresh desktop install to the first-run setup (/setup) once, before any
 * tool is shown, so FFmpeg / yt-dlp and the chosen local models are downloaded up
 * front. On every later launch it re-checks that FFmpeg and yt-dlp are still
 * there (deleted, quarantined by antivirus, an interrupted download…) and, if
 * not, sends the user to setup in repair mode to fetch them again. Renders
 * nothing. No-op outside the Tauri shell.
 */
export function FirstRunGate() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isTauri() || pathname === "/setup") return;
    let done = false;
    try { done = window.localStorage.getItem(SETUP_DONE_KEY) === "1"; } catch { done = true; }
    if (!done) { router.replace("/setup"); return; }

    if (essentialsChecked) return;
    essentialsChecked = true;
    Promise.all([ffmpegStatus(), ytdlpStatus()])
      .then(([ffmpeg, ytdlp]) => {
        if (!ffmpeg.installed || !ytdlp.installed) router.replace(SETUP_REPAIR_HREF);
      })
      .catch((e) => logWarn("setup", "essentials check failed", e));
  }, [pathname, router]);

  return null;
}
