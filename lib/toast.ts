/**
 * App-wide toasts + the `surfaceError` bridge.
 *
 * The ONE way to show a user-facing error: `surfaceError(err, { operation })`.
 * It normalizes the error (humane message, never a raw "Failed to fetch"), logs
 * it, and shows a destructive toast — all in one call.
 *
 * A tiny module-level store (no React context) so `toast(...)` works from any
 * module; `<Toaster/>` (components/toaster.tsx) subscribes and renders it.
 */
import { AppError, ErrorCode, normalizeError, type ErrorContext } from "./error/app-error";
import { logError } from "./log";

export type ToastVariant = "default" | "destructive";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  /** The main (bold) line. */
  title: string;
  /** Optional muted second line. */
  description?: string;
  variant: ToastVariant;
  action?: ToastAction;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. */
  duration: number;
}

const DEFAULT_DURATION_MS = 5000;
const MAX_VISIBLE = 4;

let items: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function publish(): void {
  for (const l of listeners) l();
}

/** Subscribe to toast changes (for `useSyncExternalStore`). */
export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Current toast list snapshot (stable identity between changes). */
export function getToasts(): Toast[] {
  return items;
}

/** Remove one toast, or every toast when `id` is omitted. */
export function dismissToast(id?: string): void {
  if (id === undefined) {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    items = [];
  } else {
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
    items = items.filter((x) => x.id !== id);
  }
  publish();
}

/** Low-level toast. Prefer the helpers below. Returns a handle to dismiss it. */
export function toast(input: {
  title: string;
  description?: string;
  variant?: ToastVariant;
  action?: ToastAction;
  duration?: number;
}): { id: string; dismiss: () => void } {
  const id = `t${++seq}`;
  const next: Toast = {
    id,
    title: input.title,
    description: input.description,
    variant: input.variant ?? "default",
    action: input.action,
    duration: input.duration ?? DEFAULT_DURATION_MS,
  };
  items = [...items, next];
  // Keep the stack short: drop the oldest when over the limit.
  while (items.length > MAX_VISIBLE) {
    const oldest = items[0];
    const t = timers.get(oldest.id);
    if (t) { clearTimeout(t); timers.delete(oldest.id); }
    items = items.slice(1);
  }
  if (next.duration > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), next.duration));
  }
  publish();
  return { id, dismiss: () => dismissToast(id) };
}

/* One short line + a status icon. An optional `title` adds a bold lead line above
   a muted detail line — use it only when both genuinely help. */
export function toastSuccess(message: string, title?: string) {
  return toast(title ? { title, description: message } : { title: message });
}

export function toastInfo(message: string, title?: string) {
  return toast(title ? { title, description: message } : { title: message });
}

export function toastError(message: string, title?: string) {
  return toast(title
    ? { title, description: message, variant: "destructive" }
    : { title: message, variant: "destructive" });
}

export interface SurfaceOptions {
  /** When the error is retryable, show a "Try again" action that runs this. */
  retry?: () => void;
  /** Label for the retry action. Default "Try again". */
  retryLabel?: string;
}

/**
 * Normalize → log → show a destructive toast. Returns the AppError so callers can
 * branch (e.g. skip UI for `Canceled`). A user cancel is never toasted.
 */
export function surfaceError(err: unknown, context?: ErrorContext, opts?: SurfaceOptions): AppError {
  const appError = normalizeError(err, context);
  if (appError.code === ErrorCode.Canceled) return appError;

  logError(context?.operation ?? "app", appError.message, appError);

  const retry = opts?.retry;
  const showRetry = appError.retryable && typeof retry === "function";
  const handle = toast({
    title: appError.userMessage,
    variant: "destructive",
    action: showRetry
      ? {
          label: opts?.retryLabel ?? "Try again",
          onClick: () => { handle.dismiss(); retry!(); },
        }
      : undefined,
  });
  return appError;
}
