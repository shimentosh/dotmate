"use client";
/**
 * Global error UI (Next App Router). The last resort: it replaces the ROOT
 * layout when the layout itself (or anything above the route segment) throws, so
 * it must render its own <html>/<body> and can't rely on app providers or
 * globals.css being available. Kept self-contained with inline styles.
 */
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Best-effort local log (the native error-log tee picks up logError); never
    // throw from the global error screen.
    void (async () => {
      try {
        const { normalizeError } = await import("@/lib/error/app-error");
        const { logError } = await import("@/lib/log");
        const appError = normalizeError(error, { operation: "global", digest: error.digest });
        logError("global-error", appError.message, appError);
      } catch { /* nothing more we can do here */ }
    })();
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0d0d0f", color: "#fff", fontFamily: "system-ui,-apple-system,sans-serif" }}>
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, textAlign: "center", padding: 24 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "linear-gradient(180deg,#1A66FD,#0052F0)" }} />
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: "-0.02em" }}>The app ran into a problem</h1>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.55)", marginTop: 8, maxWidth: 420 }}>
              The app hit an unexpected error. Restarting usually fixes it.
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={reset}
              style={{ height: 38, padding: "0 18px", borderRadius: 12, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#fff", background: "#0057FC" }}
            >
              Try again
            </button>
            <button
              onClick={() => { window.location.href = "/"; }}
              style={{ height: 38, padding: "0 18px", borderRadius: 12, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.8)", background: "transparent", border: "1px solid rgba(255,255,255,0.15)" }}
            >
              Go to home
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
