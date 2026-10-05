"use client";

/**
 * Where DotMate writes finished clips.
 *
 * - Folder sink (WebView2 / Chromium): a user-picked folder via the File System
 *   Access API. Each clip is streamed straight into its file (no whole-file buffer)
 *   and existing files are detected so nothing is overwritten.
 * - Fallback sink (no File System Access — e.g. macOS WKWebView or a non-Chromium
 *   browser): each clip is encoded in memory (clips are short) and written through
 *   the app's existing native save path, or downloaded on the web.
 */
import type { Target } from "mediabunny";
import { isTauri } from "@tauri-apps/api/core";
import { logDebug } from "@/lib/log";

export interface OpenedClipFile {
  target: Target;
  /** Write-in-memory sinks can only stream in-memory fast-start MP4s. */
  fastStartInMemory: boolean;
  /** Call after the encode finished successfully. */
  commit(): Promise<void>;
  /** Call when the encode failed or was stopped — removes the partial file. */
  discard(): Promise<void>;
}

export interface ClipSink {
  /** Folder name shown in the UI. */
  label: string;
  /** Whether `name` already exists in the destination (false when unknowable). */
  exists(name: string): Promise<boolean>;
  open(name: string, estimatedBytes: number): Promise<OpenedClipFile>;
}

/** Above this, write the MP4 index at the end instead of buffering the clip in memory. */
const IN_MEMORY_LIMIT = 300 * 1024 * 1024;

export function folderSink(dir: FileSystemDirectoryHandle): ClipSink {
  return {
    label: dir.name,
    async exists(name) {
      try {
        await dir.getFileHandle(name);
        return true;
      } catch (e) {
        // NotFoundError → free. TypeMismatchError (a folder with that name) → taken.
        return (e as { name?: string })?.name !== "NotFoundError";
      }
    },
    async open(name, estimatedBytes) {
      const { StreamTarget } = await import("mediabunny");
      const fh = await dir.getFileHandle(name, { create: true });
      const writable = await fh.createWritable();
      return {
        target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
        fastStartInMemory: estimatedBytes < IN_MEMORY_LIMIT,
        async commit() { /* the Output closes (commits) the stream when it finalizes */ },
        async discard() {
          try { await writable.abort(); } catch (e) { logDebug("dotmate", "stream already closed by the output", e); }
          try { await dir.removeEntry(name); } catch (e) { logDebug("dotmate", `could not remove partial ${name}`, e); }
        },
      };
    },
  };
}

/** Desktop without File System Access: one native folder, files written by Rust. */
export function nativeFolderSink(dirPath: string): ClipSink {
  const join = (name: string) => `${dirPath.replace(/[\\/]+$/, "")}/${name}`;
  return {
    label: dirPath.split(/[\\/]/).filter(Boolean).pop() ?? dirPath,
    async exists() { return false; },
    open: bufferedOpen(async (blob, name) => {
      const { invokeWithBytes } = await import("@/lib/tauri-bytes");
      await invokeWithBytes("save_bytes", blob, { "dest-path": join(name) });
    }),
  };
}

/** Plain browser without File System Access: each clip downloads. */
export function downloadSink(): ClipSink {
  return {
    label: "Downloads",
    async exists() { return false; },
    open: bufferedOpen(async (blob, name) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }),
  };
}

function bufferedOpen(write: (blob: Blob, name: string) => Promise<void>) {
  return async (name: string): Promise<OpenedClipFile> => {
    const { BufferTarget } = await import("mediabunny");
    const target = new BufferTarget();
    return {
      target,
      fastStartInMemory: true,
      async commit() {
        if (!target.buffer) throw new Error("The clip produced no output.");
        await write(new Blob([target.buffer], { type: "video/mp4" }), name);
      },
      async discard() { /* nothing was written */ },
    };
  };
}

/** Ask the user for an output folder. Null when cancelled. */
export async function pickOutputFolder(): Promise<{ sink: ClipSink; handle?: FileSystemDirectoryHandle } | null> {
  if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ mode: "readwrite", id: "dotmate-output" });
      return { sink: folderSink(handle), handle };
    } catch (e) {
      logDebug("dotmate", "folder picker cancelled", e);
      return null;
    }
  }
  if (isTauri()) {
    const { chooseDownloadDir } = await import("@/lib/native-download");
    const dir = await chooseDownloadDir();
    return dir ? { sink: nativeFolderSink(dir) } : null;
  }
  return { sink: downloadSink() };
}
