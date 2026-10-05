"use client";

/**
 * Disk-streamed MP4 writer — the memory fix for on-device video export.
 *
 * The tool/VtV encoders used `BufferTarget` + `fastStart: "in-memory"`, which keeps the
 * ENTIRE output MP4 in the WebView JS heap: memory climbs to the full file size over the
 * whole (minutes-long) encode and spikes ~2× at finalize when fast-start reorders the
 * moov box. For a long 1080p render that's hundreds of MB held for minutes → sluggish, and
 * OOM territory on top of everything else.
 *
 * This writer streams the encode straight to a disk file instead. MediaBunny's
 * `AppendOnlyStreamTarget` (sequential `Uint8Array` writes) + `Mp4OutputFormat({ fastStart:
 * false })` (metadata at end → written monotonically, least memory) lets us append each
 * encoded chunk to a staging temp file via the `stage_append` bridge — so the webview holds
 * only one chunk at a time during the encode. The finished file is promoted to a stable
 * temp path and read back as a Blob so callers keep their existing `Blob` contract.
 *
 * Web build (no Tauri): falls back to the original in-memory `BufferTarget` — WebCodecs
 * still works in the browser, there's just no disk to stream to.
 */

import { isTauri } from "@tauri-apps/api/core";
import { invokeForBytes } from "@/lib/tauri-bytes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MediabunnyTarget = any;

export interface Mp4Writer {
  /** Pass as `new Output({ target }).` */
  target: MediabunnyTarget;
  /** Pass as `new Mp4OutputFormat({ fastStart })`. */
  fastStart: false | "in-memory";
  /** After `output.finalize()`, resolve the finished MP4 as a Blob (reads it back off disk
   *  on desktop; returns the in-memory buffer on web). Cleans up the temp file. */
  getBlob: () => Promise<Blob>;
  /** Discard the staged temp file WITHOUT reading it back — call in a render's `finally`
   *  when `getBlob()` was never reached (cancelled / errored), so the on-disk `.part`
   *  doesn't linger until the 24h temp sweep. Best-effort + idempotent; no-op on web. */
  discard: () => Promise<void>;
}

/** UTF-8-safe base64 for the raw-IPC header convention (see lib/tauri-bytes.ts). */
function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * Create a disk-streamed MP4 writer (desktop) or an in-memory one (web). Create it BEFORE
 * building the `Output`, wire `target`/`fastStart` into the Output+format, encode as usual,
 * then `await output.finalize()` and `return writer.getBlob()`.
 */
export async function createMp4Writer(): Promise<Mp4Writer> {
  const mb = await import("mediabunny");

  // Web / no-Tauri: keep the proven in-memory path (no disk to stream to).
  if (!isTauri()) {
    const target = new mb.BufferTarget();
    return {
      target,
      fastStart: "in-memory",
      async getBlob() {
        if (!target.buffer) throw new Error("Render produced no output.");
        return new Blob([target.buffer], { type: "video/mp4" });
      },
      // Web: the output is an in-memory buffer with no on-disk staging — nothing to clean.
      async discard() {},
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const token = `mp4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let seq = 0;

  // MediaBunny can call write() many times with small chunks (per-packet). One IPC round-trip
  // + file open/close per chunk would be thousands of calls → slow. So BATCH: accumulate up to
  // ~8MB in the heap, then append that batch to the native staging temp file in one call.
  // Peak heap stays ~one batch; the flush await applies backpressure to the encoder.
  const FLUSH_BYTES = 8 * 1024 * 1024;
  let pending: Uint8Array[] = [];
  let pendingSize = 0;

  const flush = async () => {
    if (pendingSize === 0) return;
    const merged = new Uint8Array(pendingSize);
    let off = 0;
    for (const c of pending) { merged.set(c, off); off += c.byteLength; }
    pending = [];
    pendingSize = 0;
    await invoke("stage_append", merged.buffer, { headers: { token: b64(token), seq: b64(String(seq++)) } });
  };

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      // COPY: the chunk may be a view over a buffer MediaBunny reuses after write() returns,
      // and we hold it in `pending` across the next await, so we must own the bytes.
      pending.push(new Uint8Array(chunk));
      pendingSize += chunk.byteLength;
      if (pendingSize >= FLUSH_BYTES) await flush();
    },
    async close() {
      await flush();
    },
    abort() {
      pending = [];
      pendingSize = 0;
    },
  });

  const target = new mb.AppendOnlyStreamTarget(writable);

  return {
    target,
    fastStart: false,
    async getBlob() {
      // The staged file is now the complete MP4. Promote it to a stable temp path, read it
      // back as a Blob (raw ArrayBuffer over IPC — never a JSON number array), then clean up.
      const path = await invoke<string>("stage_promote", { token, fileName: `${token}.mp4` });
      try {
        const bytes = await invokeForBytes("read_file_bytes", { path });
        return new Blob([bytes as BlobPart], { type: "video/mp4" });
      } finally {
        try {
          await invoke("delete_file", { path });
        } catch {
          /* best-effort — the 24h temp sweep collects it otherwise */
        }
      }
    },
    async discard() {
      // Abort the writable (drops the in-heap batch) and delete the staged .part so a
      // cancelled/errored render leaves nothing behind. Both are best-effort.
      try { await writable.abort(); } catch { /* already closed */ }
      try { await invoke("stage_discard", { token }); } catch { /* 24h sweep collects it */ }
    },
  };
}
