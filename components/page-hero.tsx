"use client";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * PageHero — the single, app-wide page header used across every hub page
 * (Projects, Studio, Tools, Brands, Settings, …). Edit it here and every page's
 * header updates at once.
 *
 * Style: clean, macOS-modern — an optional gradient "app icon" chip, a big
 * two-tone title (plain lead + gradient accent word), a muted one-line
 * description, optional stat chips, and an optional right-aligned actions slot.
 */
const GRADIENT = "linear-gradient(135deg,#3D7EFD,#0047D1)";

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
  /** Plain leading word(s) before the gradient accent (e.g. "Video"). */
  title?: string;
  /** The gradient-highlighted word (e.g. "Studio"). */
  accent: string;
  description?: string;
  /** Tiny uppercase label above the title. */
  eyebrow?: string;
  /** Optional gradient app-icon chip beside the title. */
  icon?: LucideIcon;
  chips?: PageHeroChip[];
  /** Right-aligned actions (buttons, etc.). */
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 mb-7">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-500 mb-2">
            {eyebrow}
          </p>
        )}

        <div className="flex items-center gap-2.5 mb-2">
          {Icon && (
            <span
              className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm shadow-violet-500/25"
              style={{ background: GRADIENT }}
            >
              <Icon size={16} className="text-white" strokeWidth={2} />
            </span>
          )}
          <h1 className="text-[22px] sm:text-[24px] font-bold tracking-tight leading-none text-zinc-900 dark:text-zinc-100">
            {title ? <>{title} </> : null}
            <span style={{ background: GRADIENT, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              {accent}
            </span>
          </h1>
        </div>

        {description && (
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400 leading-relaxed max-w-xl">
            {description}
          </p>
        )}

        {chips && chips.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-3">
            {chips.map((c, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 h-6 px-3 rounded-full text-[11.5px] font-semibold bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 text-zinc-500 dark:text-zinc-400"
              >
                {c.value != null && <span className="text-zinc-700 dark:text-zinc-200 tabular-nums">{c.value}</span>}
                {c.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {actions && <div className="flex items-center gap-2 shrink-0 mt-1">{actions}</div>}
    </div>
  );
}
