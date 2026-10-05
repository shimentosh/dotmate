"use client";

/**
 * PreviewErrorCard — the failure surface for the canvas previews (Carousel /
 * Image-to-Video). A preview that fails to load or render shows THIS instead of a
 * blank canvas: humane copy (never a raw err.message) + a Retry button that lets
 * the host remount the preview surface.
 *
 * Hosts own the retry semantics (typically: clear the failed flag and bump a
 * remount key). The card fills the host's preview box; keep the host's aspect
 * wrapper around it.
 */

import { useEffect, useRef } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { humanizeError, normalizeError } from "@/lib/error/app-error";
import { surfaceError } from "@/lib/toast";

export function PreviewErrorCard({
  error,
  operation,
  onRetry,
}: {
  /** The failure that broke the preview (anything thrown). */
  error: unknown;
  /** Telemetry/log context, e.g. "editor-preview-engine". */
  operation: string;
  /** Remount the engine surface. Omit to hide the Retry button. */
  onRetry?: () => void;
}) {
  const message = humanizeError(normalizeError(error, { operation }));

  // One loud toast per failure instance (not per re-render).
  const toasted = useRef(false);
  useEffect(() => {
    if (toasted.current) return;
    toasted.current = true;
    surfaceError(error, { operation }, onRetry ? { retry: onRetry } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/95 p-6 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-400" aria-hidden />
      <div className="max-w-md">
        <p className="text-sm font-medium text-zinc-100">Preview couldn&apos;t start</p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">{message}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}
