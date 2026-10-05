"use client";

/**
 * Save an in-memory Blob to disk — the ONE cross-platform "download this" helper.
 *
 * Why this exists: a hidden `<a download>` click is silently ignored by the Tauri
 * webview (WebView2), so every "Download" button that had bytes in memory looked
 * broken in the desktop app. On desktop we open a native Save dialog and write the
 * bytes through Rust (`save_bytes`); on the web build the `<a download>` trick works
 * fine, so we keep it there.
 */

import { isTauri } from "@tauri-apps/api/core";
import { invokeWithBytes } from "./tauri-bytes";
import { chooseDownloadDir } from "./native-download";

export interface SaveResult {
  /** false when the user cancelled the dialog (nothing was written). */
  saved: boolean;
  /** Absolute path written (desktop only). */
  path?: string;
}

/** Trigger the browser `<a download>` save for one blob (web build / fallback). */
function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Save `blob` to disk as `filename`. Desktop: native Save dialog → write bytes.
 * Web: `<a download>`. Resolves `{ saved:false }` if the user cancels the dialog.
 * Throws on a real write failure (callers should `surfaceError`).
 */
export async function saveBlobToDisk(blob: Blob, filename: string): Promise<SaveResult> {
  if (!isTauri()) {
    browserDownload(blob, filename);
    return { saved: true };
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: filename });
  if (!path) return { saved: false }; // dialog cancelled
  const written = await invokeWithBytes<string>("save_bytes", blob, { "dest-path": path });
  return { saved: true, path: written };
}

/** Join a native directory with a file name (Rust normalises the separator). */
function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

/**
 * Save several blobs at once. Desktop: pick ONE folder, write each file into it.
 * Web: `<a download>` each (staggered so the browser doesn't drop clicks).
 * Resolves `{ saved:0 }` if the folder picker is cancelled.
 */
export async function saveBlobsToFolder(
  files: { blob: Blob; name: string }[],
): Promise<{ saved: number; dir?: string }> {
  if (!files.length) return { saved: 0 };

  if (!isTauri()) {
    files.forEach((f, i) => setTimeout(() => browserDownload(f.blob, f.name), i * 120));
    return { saved: files.length };
  }

  const dir = await chooseDownloadDir();
  if (!dir) return { saved: 0 }; // cancelled
  let saved = 0;
  for (const f of files) {
    await invokeWithBytes<string>("save_bytes", f.blob, { "dest-path": joinPath(dir, f.name) });
    saved++;
  }
  return { saved, dir };
}
