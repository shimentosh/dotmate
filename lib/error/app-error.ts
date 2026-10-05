/**
 * AppError — the single normalized error type for the desktop app.
 *
 * Every IO / network / Tauri / render boundary funnels failures through
 * `normalizeError()`, which turns an arbitrary `unknown` into an `AppError`
 * carrying:
 *   • `code`        — a stable machine code (for branching / telemetry)
 *   • `message`     — the technical message (for logs, never shown to users)
 *   • `userMessage` — a humane, actionable sentence safe to show in a toast
 *   • `severity` / `retryable` / `context` / `cause`
 *
 * This is the contract the whole error system is built on. Surfacing helpers
 * (`lib/toast.ts`), the Tauri wrapper (`lib/tauri-invoke.ts`), the error
 * boundary, and the global handlers all read these fields — so a raw
 * "Failed to fetch" never reaches a user.
 */

export type ErrorSeverity = "fatal" | "high" | "medium" | "low";

export enum ErrorCode {
  // Network / transport
  NetworkOffline = "NETWORK_OFFLINE",
  NetworkTimeout = "NETWORK_TIMEOUT",
  RequestFailed = "REQUEST_FAILED",
  RateLimited = "RATE_LIMITED",
  ServerError = "SERVER_ERROR",
  // HTTP 401 / 403 / 402 (kept for completeness; the app makes no authenticated requests)
  AuthExpired = "AUTH_EXPIRED",
  AuthDenied = "AUTH_DENIED",
  PaymentRequired = "PAYMENT_REQUIRED",
  // Request shape
  NotFound = "NOT_FOUND",
  InvalidInput = "INVALID_INPUT",
  // Storage / media
  QuotaExceeded = "QUOTA_EXCEEDED",
  StorageFull = "STORAGE_FULL",
  MediaUnavailable = "MEDIA_UNAVAILABLE",
  // System
  TauriError = "TAURI_ERROR",
  Canceled = "CANCELED",
  Unknown = "UNKNOWN",
}

export interface ErrorContext {
  /** What we were doing, e.g. "transcribe", "tauri:export_video", "loadProjects". */
  operation?: string;
  /** Request URL, when relevant. */
  url?: string;
  /** HTTP status, when this came from a fetch Response. */
  statusCode?: number;
  /** Anything else useful for logs/telemetry (ids, sizes, engine, …). */
  [key: string]: unknown;
}

interface AppErrorInit {
  code: ErrorCode;
  message: string;
  userMessage: string;
  severity?: ErrorSeverity;
  retryable?: boolean;
  context?: ErrorContext;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  /** A humane, non-technical sentence safe to show users. */
  readonly userMessage: string;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly context?: ErrorContext;
  /** The original thrown value (Error / string / Response-ish), for logs. */
  readonly cause?: unknown;

  constructor(init: AppErrorInit) {
    super(init.message);
    this.name = "AppError";
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.severity = init.severity ?? "medium";
    this.retryable = init.retryable ?? false;
    this.context = init.context;
    this.cause = init.cause;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Pull a best-effort raw message string out of any thrown value. */
function rawMessage(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/** Cross-engine "the network request itself failed" detector. WebView2 (Win) says
 *  "Failed to fetch"; WKWebView (mac) says "Load failed"; others "NetworkError". */
function isNetworkFailure(msg: string): boolean {
  return /failed to fetch|load failed|networkerror|network error|err_internet_disconnected/i.test(msg);
}

/**
 * Normalize ANY thrown value into an AppError with a humane `userMessage`.
 * Idempotent: an existing AppError is returned (with `context` merged).
 */
export function normalizeError(err: unknown, context?: ErrorContext): AppError {
  if (isAppError(err)) {
    return context ? new AppError({
      code: err.code,
      message: err.message,
      userMessage: err.userMessage,
      severity: err.severity,
      retryable: err.retryable,
      context: { ...err.context, ...context },
      cause: err.cause,
    }) : err;
  }

  const msg = rawMessage(err);
  const name = err instanceof Error ? err.name : (typeof err === "object" && err ? (err as { name?: string }).name : undefined);
  const status = context?.statusCode;
  const make = (code: ErrorCode, userMessage: string, severity: ErrorSeverity, retryable: boolean) =>
    new AppError({ code, message: msg || userMessage, userMessage, severity, retryable, context, cause: err });

  // ── Aborts / timeouts by NAME (unambiguous DOMException names) ─────────────
  // `TimeoutError` = our own AbortSignal.timeout() → a real timeout (retryable).
  // `AbortError` = an EXTERNAL/user cancel (component unmount, a Stop button) — NOT a
  // timeout: classify it Canceled (non-retryable, and surfaceError suppresses it) so a
  // cancelled request rejects promptly instead of retrying through backoff and showing
  // the wrong "This took too long" message.
  if (name === "TimeoutError") {
    return make(ErrorCode.NetworkTimeout, "This took too long. Check your connection and try again.", "high", true);
  }
  if (name === "AbortError") {
    return make(ErrorCode.Canceled, "Canceled.", "low", false);
  }

  // ── Storage quota (client-side; never carries an HTTP status) ─────────────
  if (name === "QuotaExceededError") {
    return make(ErrorCode.StorageFull, "This device is out of storage space. Free up space and try again.", "high", false);
  }

  // ── HTTP status mapping (authoritative when we know it) ────────────────────
  // MUST run before the content-text heuristics below: a 4xx/5xx whose BODY happens to
  // contain "timeout" / "no longer available" / "revoked" has to be classified by its
  // known status (retryable ServerError, InvalidInput, …) — not hijacked by an
  // incidental substring in the server's message.
  if (typeof status === "number") {
    if (status === 401) return make(ErrorCode.AuthExpired, "The service refused the request (not authorised).", "high", false);
    if (status === 403) return make(ErrorCode.AuthDenied, "You don't have access to this.", "medium", false);
    if (status === 402) return make(ErrorCode.PaymentRequired, "The service refused the request (payment required).", "medium", false);
    if (status === 404) return make(ErrorCode.NotFound, `${context?.operation ? context.operation : "That"} couldn't be found.`, "medium", false);
    if (status === 408 || status === 429) return make(ErrorCode.RateLimited, "Too many requests — wait a moment and try again.", "medium", true);
    if (status === 400 || status === 422) return make(ErrorCode.InvalidInput, msg || "That request wasn't valid.", "medium", false);
    if (status >= 500) return make(ErrorCode.ServerError, "The service had a problem. Try again in a moment.", "high", true);
  }

  // ── Content-text heuristics (only when there is no authoritative HTTP status) ──
  if (/quota.?exceeded/i.test(msg)) {
    return make(ErrorCode.StorageFull, "This device is out of storage space. Free up space and try again.", "high", false);
  }
  if (/timed? ?out|timeout/i.test(msg)) {
    if (/cancel/i.test(msg)) return make(ErrorCode.Canceled, "Canceled.", "low", false);
    return make(ErrorCode.NetworkTimeout, "This took too long. Check your connection and try again.", "high", true);
  }
  // Unreadable local media (revoked blob: / local-media:// ref).
  if (/blob:|local-media:\/\//i.test(msg) || /no longer available|revoked/i.test(msg)) {
    return make(ErrorCode.MediaUnavailable, "Some media is no longer available on this device. Re-add it and try again.", "medium", false);
  }

  // ── Network transport failure ─────────────────────────────────────────────
  if (err instanceof TypeError && isNetworkFailure(msg)) {
    return make(ErrorCode.NetworkOffline, "Couldn't reach the service. Check that it (e.g. Ollama) is running and try again.", "high", true);
  }
  if (isNetworkFailure(msg)) {
    return make(ErrorCode.NetworkOffline, "Couldn't reach the service. Check that it (e.g. Ollama) is running and try again.", "high", true);
  }

  // ── Tauri command failures (Rust returns a bare string) ───────────────────
  if (context?.operation?.startsWith("tauri:") || typeof err === "string") {
    return make(ErrorCode.TauriError, msg || "The desktop app hit an error. Please try again.", "medium", false);
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  return make(ErrorCode.Unknown, msg || "Something went wrong. Please try again.", "medium", false);
}

/** Convenience: the humane message for any thrown value (for inline `setError`). */
export function humanizeError(err: unknown, context?: ErrorContext): string {
  return normalizeError(err, context).userMessage;
}
