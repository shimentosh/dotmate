"use client";

import { useSyncExternalStore } from "react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { dismissToast, getToasts, subscribeToasts, type Toast } from "@/lib/toast";

const EMPTY: Toast[] = [];

/**
 * The single toast surface, mounted once in the root layout. Renders whatever
 * `lib/toast.ts` holds; toasts can be raised from any module.
 */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, () => EMPTY);
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100000] flex flex-col items-center gap-2 pointer-events-none w-[min(440px,calc(100vw-32px))]"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => {
        const destructive = t.variant === "destructive";
        return (
          <div
            key={t.id}
            role={destructive ? "alert" : "status"}
            className="pointer-events-auto w-full flex items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-lg backdrop-blur-xl bg-white/95 dark:bg-zinc-900/95 border-zinc-200 dark:border-white/10"
          >
            {destructive
              ? <AlertTriangle size={15} className="shrink-0 mt-0.5 text-red-500" />
              : <CheckCircle2 size={15} className="shrink-0 mt-0.5 text-emerald-500" />}
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100 break-words">{t.title}</p>
              {t.description && (
                <p className="text-[12px] leading-snug text-zinc-500 dark:text-zinc-400 mt-0.5 break-words">{t.description}</p>
              )}
            </div>
            {t.action && (
              <button
                type="button"
                onClick={t.action.onClick}
                className="shrink-0 h-7 px-2.5 rounded-lg text-[12px] font-semibold text-violet-600 dark:text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 border-none cursor-pointer transition-colors"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
              className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/10 border-none bg-transparent cursor-pointer transition-colors"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
