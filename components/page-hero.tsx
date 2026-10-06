"use client";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * PageHero — the single, app-wide page header used across every hub page
 * (Home, Studio, Tools, …). Edit it here and every page's header updates at once.
 *
 * Style: quiet and product-like — an optional brand "app icon" tile, a strong
 * title (the accent word in brand blue), a muted one-line description, optional
 * stat chips, and an optional right-aligned actions slot.
 */
export interface PageHeroChip {
  label: string;
  /** Optional emphasised value shown before the label (e.g. a count). */
  value?: ReactNode;
}

export function PageHero({
  title,
  accent,
  description,
  eyebrow,
  icon: Icon,
  chips,
  actions,
}: {
  /** Plain leading word(s) before the accent (e.g. "Video"). */
  title?: string;
  /** The highlighted word (e.g. "Studio"). */
  accent: string;
  description?: string;
  /** Tiny uppercase label above the title. */
  eyebrow?: string;
  /** Optional app-icon tile beside the title. */
  icon?: LucideIcon;
  chips?: PageHeroChip[];
  /** Right-aligned actions (buttons, etc.). */
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 sm:gap-6 mb-8">
      <div className="min-w-0 flex items-start gap-4">
        {Icon && (
          <span className="mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-brand-gradient shadow-sm ring-1 ring-inset ring-white/10">
            <Icon size={19} className="text-white" strokeWidth={1.9} />
          </span>
        )}

        <div className="min-w-0">
          {eyebrow && (
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400 mb-1.5">
              {eyebrow}
            </p>
          )}

          <h1 className="text-[22px] sm:text-[24px] font-semibold tracking-[-0.015em] leading-tight text-zinc-900 dark:text-zinc-50">
            {title ? <>{title} </> : null}
            <span className="text-brand">{accent}</span>
          </h1>

          {description && (
            <p className="mt-1 text-[13.5px] text-zinc-500 dark:text-zinc-400 leading-relaxed max-w-xl">
              {description}
            </p>
          )}

          {chips && chips.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-3.5">
              {chips.map((c, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-md text-[12px] font-medium bg-surface border border-zinc-200 dark:border-white/8 text-zinc-500 dark:text-zinc-400"
                >
                  {c.value != null && <span className="font-semibold text-zinc-800 dark:text-zinc-100 tabular-nums">{c.value}</span>}
                  {c.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {actions && <div className="flex items-center gap-2 shrink-0 sm:mt-1">{actions}</div>}
    </header>
  );
}
