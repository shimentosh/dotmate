"use client";
/**
 * ErrorBoundary — catches render/lifecycle errors so a thrown component never
 * blanks the whole app. Normalizes + logs the error, then shows a recoverable
 * fallback (Try again / Reload). Mounted around the routed UI in the root layout.
 * Pass `label` for log context and an optional `fallback` to customize the UI.
 */
import React from "react";
import { BrandMark } from "@/components/brand-mark";
import { normalizeError, type AppError } from "@/lib/error/app-error";
import { logError } from "@/lib/log";

interface Props {
  children: React.ReactNode;
  /** Context label for logs/telemetry, e.g. "editor", "app". */
  label?: string;
  /** Custom fallback. Receives the normalized error + a reset fn. */
  fallback?: (error: AppError, reset: () => void) => React.ReactNode;
}

interface State {
  error: AppError | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: normalizeError(error, { operation: "render" }) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    const appError = normalizeError(error, {
      operation: `render:${this.props.label ?? "app"}`,
      componentStack: info.componentStack,
    });
    logError(`ErrorBoundary:${this.props.label ?? "app"}`, appError.message, appError);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-5 p-8 text-center">
        <div style={{ filter: "drop-shadow(0 0 32px rgba(0,87,252,0.35))" }}>
          <BrandMark size={48} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">Something went wrong</h2>
          <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">{error.userMessage}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={this.reset}
            className="h-9 rounded-xl px-4 text-[13px] font-bold text-white"
            style={{ background: "linear-gradient(135deg,#3D7EFD,#0047D1)" }}
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="h-9 rounded-xl border border-zinc-200 px-4 text-[13px] font-semibold text-zinc-600 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/5"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
