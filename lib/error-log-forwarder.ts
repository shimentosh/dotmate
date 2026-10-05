/**
 * Error-log bridge (desktop only).
 *
 * The app already funnels every failure through `logError` (see `lib/log.ts`):
 * `surfaceError`, the API/Tauri wrappers, the error boundary, and the global
 * unhandled-rejection / uncaught-error handlers all end up there. This registers
 * ONE log sink that forwards those ERROR-level entries to the native side
 * (`log_client_error`), where they are appended to the app's `errors.log` in the
 * OS log folder (Settings → About → "Open log folder"). Nothing is uploaded.
 *
 * Two invariants:
 *   • Desktop only — a plain web/demo build has no native log, so this no-ops.
 *   • Loop-safe   — it calls Tauri's raw `invoke` (NOT `safeInvoke`, which would
 *     call `logError` on failure and re-enter this sink forever). Any failure to
 *     forward is swallowed: logging must never throw into the app.
 */
import { registerLogSink } from "./log";

let installed = false;

export function initErrorLogForwarding(): void {
  if (installed || typeof window === "undefined") return;
  // Native log only exists inside Tauri; a plain browser dev session has nothing to write to.
  if (!("__TAURI_INTERNALS__" in window)) return;
  installed = true;

  registerLogSink((entry) => {
    // Only genuine failures go to the error file; warn/debug stay in the console.
    if (entry.level !== "error") return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("log_client_error", {
          scope: entry.scope,
          message: entry.message,
          detail: describeError(entry.error),
        }),
      )
      .catch(() => {
        /* a logging failure must never re-enter logError → no loop, no crash */
      });
  });
}

/** Best-effort one-string description of the attached error, stack + code + context. */
function describeError(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const extra: string[] = [];
    const anyErr = error as { code?: unknown; context?: unknown };
    if (anyErr.code) extra.push(`code=${String(anyErr.code)}`);
    if (anyErr.context) {
      try {
        extra.push(`ctx=${JSON.stringify(anyErr.context)}`);
      } catch {
        /* non-serializable context — skip it */
      }
    }
    const head = error.stack || `${error.name}: ${error.message}`;
    return extra.length ? `${head} | ${extra.join(" ")}` : head;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
