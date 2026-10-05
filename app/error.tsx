"use client";
/**
 * Route-segment error UI (Next App Router). Catches errors thrown while
 * rendering a page under app/. Logs it, then offers recovery.
 * Root-layout errors are handled separately by app/global-error.tsx.
 */
import { useEffect } from "react";
import { BrandMark } from "@/components/brand-mark";
import { normalizeError } from "@/lib/error/app-error";
import { logError } from "@/lib/log";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    const appError = normalizeError(error, { operation: "route", digest: error.digest });
    logError("route-error", appError.message, appError);
  }, [error]);

  const userMessage = normalizeError(error).userMessage;

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-5 p-8 text-center">
      <div style={{ filter: "drop-shadow(0 0 32px rgba(0,87,252,0.35))" }}>
        <BrandMark size={56} />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">This page hit a snag</h2>
        <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">{userMessage}</p>
      </div>
      <div className="flex items-center gap-2.5">
        <button
          onClick={reset}
          className="h-9 rounded-xl px-4 text-[13px] font-bold text-white"
          style={{ background: "linear-gradient(135deg,#3D7EFD,#0047D1)" }}
        >
          Try again
        </button>
        <button
          onClick={() => { window.location.href = "/"; }}
          className="h-9 rounded-xl border border-zinc-200 px-4 text-[13px] font-semibold text-zinc-600 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/5"
        >
          Go to home
        </button>
      </div>
    </div>
  );
}
