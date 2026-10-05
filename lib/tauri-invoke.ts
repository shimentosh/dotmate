/**
 * safeInvoke — wrapper around Tauri's `invoke()` with a timeout guard + error
 * normalization.
 *
 * Rust commands reject with a bare string (the `Result<_, String>` error), which
 * otherwise reaches the UI as a context-free message. This wraps every call so
 * failures become an `AppError` tagged with `operation: "tauri:<cmd>"`.
 *
 * NOTE ON THE TIMEOUT: Tauri's `invoke()` can't be aborted, so the timeout is a
 * UI-level guard — it stops the caller from awaiting forever, but the underlying
 * Rust work keeps running. For truly cancellable work (downloads, renders) use
 * the dedicated Rust cancel commands (e.g. `ytdlp_cancel`) in addition.
 */
import type { InvokeArgs } from "@tauri-apps/api/core";
import { normalizeError } from "./error/app-error";

export interface SafeInvokeOptions {
  /** Reject the promise after this many ms (the Rust work continues). Default 60000. 0 disables. */
  timeoutMs?: number;
}

export async function safeInvoke<T>(cmd: string, args?: InvokeArgs, opts: SafeInvokeOptions = {}): Promise<T> {
  const { timeoutMs = 60000 } = opts;
  const { invoke } = await import("@tauri-apps/api/core");

  try {
    if (timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`"${cmd}" timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        return await Promise.race([invoke<T>(cmd, args), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw normalizeError(err, { operation: `tauri:${cmd}` });
  }
}
