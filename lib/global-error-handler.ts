/**
 * Global last-resort handlers for errors that escape every try/catch:
 * unhandled promise rejections and uncaught runtime errors.
 *
 * Without this, a swallowed async failure is invisible (or, in dev, a raw red
 * overlay). Here we normalize and log (locally only). In production we also
 * show a single generic toast and `preventDefault()` the rejection so it doesn't
 * spam the console. In dev we DON'T suppress it — the overlay/console stays so
 * real bugs are still obvious.
 *
 * Wired once from `components/app-init.tsx`.
 */
import { normalizeError, ErrorCode } from "./error/app-error";
import { logError } from "./log";
import { toastError } from "./toast";

let installed = false;

export function initGlobalErrorHandling(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const isDev = process.env.NODE_ENV !== "production";

  window.addEventListener("unhandledrejection", (event) => {
    const appError = normalizeError(event.reason, { operation: "unhandledRejection" });
    logError("unhandledRejection", appError.message, appError);

    // A user cancel shouldn't nag.
    const quiet = appError.code === ErrorCode.Canceled;

    if (!isDev) {
      event.preventDefault(); // keep the prod console clean; we've logged it
      if (!quiet) toastError(appError.userMessage);
    }
  });

  window.addEventListener("error", (event) => {
    // Ignore ResourceLoad errors on elements (img/script) — those carry no useful Error.
    if (!event.error && !event.message) return;
    const appError = normalizeError(event.error ?? event.message, { operation: "uncaughtError" });
    logError("uncaughtError", appError.message, appError);
  });
}
