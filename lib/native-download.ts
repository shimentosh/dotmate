"use client";

/**
 * Native desktop folder helpers: pick a destination folder via the OS dialog and
 * open a folder/file in the OS file manager. (Files are written by Rust — the
 * Tauri webview ignores a hidden `<a download>` click.)
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Open a native folder picker; returns the chosen directory, or null if cancelled. */
export async function chooseDownloadDir(): Promise<string | null> {
  const res = await open({ directory: true, multiple: false, title: "Choose folder" });
  return typeof res === "string" ? res : null;
}

/** Open a folder (or file) in the OS file manager / default app. */
export function openInFileManager(path: string): Promise<void> {
  return invoke("open_file", { path });
}
