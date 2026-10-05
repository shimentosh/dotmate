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
      <div className="rounded-2xl border border-zinc-200 dark:border-white/8 glass-card px-5 py-4 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-2">Developed by</p>
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
    <div className="px-3 pt-2.5 pb-1">
      <button onClick={() => void openExternal(dev.url)} title={`Developed by ${dev.name} — ${dev.url}`}
        className="group w-full flex flex-col items-start gap-1 bg-transparent border-none p-0 cursor-pointer text-left">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500 group-hover:text-violet-500 transition-colors">
          Developed by
        </span>
        <span className="opacity-80 group-hover:opacity-100 transition-opacity"><DeveloperLogo height={15} /></span>
      </button>
      <button onClick={() => void openExternal(dev.personalUrl)} title={dev.personalUrl}
        className="mt-1 bg-transparent border-none p-0 cursor-pointer text-[10.5px] text-zinc-400 dark:text-zinc-500 hover:text-violet-500 dark:hover:text-violet-300 transition-colors">
        {dev.personalLabel}
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
