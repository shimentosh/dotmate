/**
 * Leveled logger — the one place the app writes diagnostics.
 *
 * WHY THIS EXISTS: Next.js 16's dev overlay promotes EVERY `console.error` to a
 * red full-screen error. So a benign, expected failure (a revoked blob, an
 * offline best-effort fetch) that we `console.error`'d would read as a crash.
 * Routing through leveled helpers fixes that class of bug:
 *
 *   • logError — genuine failures the user/dev must know about → console.error
 *   • logWarn  — best-effort/degraded paths (font sync, optional pings)  → console.warn
 *   • logDebug — expected/innocuous cases (user cancelled, cache miss)   → console.debug
 *
 * Only `logError` triggers the dev overlay; warn/debug stay quiet. Registered
 * sinks (lib/error-log-forwarder.ts tees errors into the native log file) also
 * receive every entry. Nothing ever leaves the machine.
 */

export type LogLevel = "debug" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  scope: string;
  message: string;
  error?: unknown;
}

type LogSink = (entry: LogEntry) => void;

const sinks = new Set<LogSink>();

/** Register a log sink (e.g. the native log-file forwarder). Returns an unsubscribe. */
export function registerLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function emit(entry: LogEntry) {
  for (const sink of sinks) {
    try { sink(entry); } catch { /* a broken sink must never break logging */ }
  }
}

function fmt(scope: string, message: string): string {
  return `[${scope}] ${message}`;
}

export function logDebug(scope: string, message: string, error?: unknown): void {
  emit({ level: "debug", scope, message, error });
  if (error !== undefined) console.debug(fmt(scope, message), error);
  else console.debug(fmt(scope, message));
}

export function logWarn(scope: string, message: string, error?: unknown): void {
  emit({ level: "warn", scope, message, error });
  if (error !== undefined) console.warn(fmt(scope, message), error);
  else console.warn(fmt(scope, message));
}

export function logError(scope: string, message: string, error?: unknown): void {
  emit({ level: "error", scope, message, error });
  if (error !== undefined) console.error(fmt(scope, message), error);
  else console.error(fmt(scope, message));
}
