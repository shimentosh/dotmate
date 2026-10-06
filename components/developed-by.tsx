"use client";
/* eslint-disable @next/next/no-img-element -- static export: images are served as-is */
import { ExternalLink } from "lucide-react";
import { brand } from "@/brand.config";
import { openExternal } from "@/lib/open-external";

const dev = brand.developer;

/** The developer's wordmark, swapped for the light/dark theme. */
function DeveloperLogo({ height }: { height: number }) {
  return (
    <>
      <img src={dev.logoOnLight} alt={dev.name} height={height} style={{ height }} className="w-auto block dark:hidden" />
      <img src={dev.logoOnDark} alt={dev.name} height={height} style={{ height }} className="w-auto hidden dark:block" />
    </>
  );
}

/**
 * "Developed by DotMirror" credit. `compact` sits in the sidebar footer; `card` is the
 * Settings → About block. Links open in the system browser.
 */
export function DevelopedBy({ variant = "compact" }: { variant?: "compact" | "card" }) {
  if (variant === "card") {
    return (
      <div className="rounded-xl border border-zinc-200 dark:border-white/8 bg-surface shadow-xs px-5 py-4 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400 mb-2">Developed by</p>
          <button onClick={() => void openExternal(dev.url)} title={dev.url}
            className="bg-transparent border-none p-0 cursor-pointer opacity-90 hover:opacity-100 transition-opacity">
            <DeveloperLogo height={22} />
          </button>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <LinkButton href={dev.url} label="dotmirror.com" />
          <LinkButton href={dev.personalUrl} label={dev.personalLabel} />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-sidebar-border bg-surface overflow-hidden">
      <button onClick={() => void openExternal(dev.url)} title={`Developed by ${dev.name} — ${dev.url}`}
        className="group w-full flex items-center gap-2 px-3 py-2.5 bg-transparent border-none cursor-pointer text-left hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.04] transition-colors">
        <span className="flex-1 min-w-0 flex flex-col items-start gap-1.5">
          <span className="text-[10.5px] font-medium text-zinc-400 dark:text-zinc-500 leading-none">Developed by</span>
          <span className="opacity-85 group-hover:opacity-100 transition-opacity"><DeveloperLogo height={14} /></span>
        </span>
        <ExternalLink size={12} className="shrink-0 text-zinc-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 group-hover:text-brand transition-all" />
      </button>
      <button onClick={() => void openExternal(dev.personalUrl)} title={dev.personalUrl}
        className="group w-full flex items-center justify-between gap-2 px-3 h-7 bg-transparent border-0 border-t border-solid border-sidebar-border cursor-pointer text-left hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.04] transition-colors">
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400 group-hover:text-brand transition-colors truncate">{dev.personalLabel}</span>
        <ExternalLink size={11} className="shrink-0 text-zinc-300 dark:text-zinc-600 group-hover:text-brand transition-colors" />
      </button>
    </div>
  );
}

function LinkButton({ href, label }: { href: string; label: string }) {
  return (
    <button onClick={() => void openExternal(href)}
      className="h-7 px-3 rounded-lg text-[11.5px] font-medium cursor-pointer transition-all flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-white/10 bg-transparent hover:bg-zinc-50 dark:hover:bg-white/5">
      {label} <ExternalLink size={11} />
    </button>
  );
}
