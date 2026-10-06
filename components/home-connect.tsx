"use client";
/**
 * Home page header: tool search + "follow the developer" + "request a tool".
 * Rendered as one card (HomeHero) so the pieces share a grid.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Search, X, Lightbulb, ArrowUpRight, type LucideIcon } from "lucide-react";
import { FaYoutube, FaInstagram, FaFacebook } from "react-icons/fa";
import { FaTiktok } from "react-icons/fa6";
import type { IconType } from "react-icons";
import { brand } from "@/brand.config";
import { openExternal } from "@/lib/open-external";

const SOCIAL_ICONS: Record<string, IconType> = {
  youtube: FaYoutube,
  instagram: FaInstagram,
  facebook: FaFacebook,
  tiktok: FaTiktok,
};

/** Search box for the tool gallery. Ctrl/⌘+K or "/" focuses it; Esc clears. */
export function ToolSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]");
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative group">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none group-focus-within:text-brand transition-colors" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { onChange(""); e.currentTarget.blur(); } }}
        placeholder="Search tools…"
        aria-label="Search tools"
        className="w-full h-10 pl-9 pr-16 rounded-lg text-[13.5px] outline-none bg-surface border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 hover:border-zinc-300 dark:hover:border-white/15 focus:border-brand/60 focus:ring-[3px] focus:ring-brand/12 transition-[border-color,box-shadow] [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button type="button" onClick={() => { onChange(""); ref.current?.focus(); }} aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-900/[0.05] dark:hover:bg-white/10 bg-transparent border-none cursor-pointer transition-colors">
          <X size={13} />
        </button>
      ) : (
        <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 h-5 px-1.5 rounded border border-zinc-200 dark:border-white/10 bg-surface-muted text-[10.5px] font-sans font-medium text-zinc-400 dark:text-zinc-500 flex items-center pointer-events-none">
          Ctrl K
        </kbd>
      )}
    </div>
  );
}

/** Round icon links to the developer's profiles. */
export function FollowLinks() {
  return (
    <div className="flex items-center gap-1.5">
      {brand.developer.socials.map(({ platform, label, url }) => {
        const Icon = SOCIAL_ICONS[platform];
        if (!Icon) return null;
        return (
          <button key={platform} type="button" onClick={() => void openExternal(url)}
            title={`Follow on ${label}`} aria-label={`Follow on ${label}`}
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-surface border border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400 hover:text-brand hover:border-brand/40 hover:bg-brand-soft cursor-pointer transition-colors">
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}

/** Outline button that opens the feature-request form. */
export function RequestToolButton({ query }: { query?: string }) {
  const url = query?.trim()
    ? `${brand.requestToolUrl}&title=${encodeURIComponent(`Tool request: ${query.trim()}`)}`
    : brand.requestToolUrl;
  return (
    <button type="button" onClick={() => void openExternal(url)}
      className="group shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium bg-surface border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-200 hover:border-brand/40 hover:text-brand cursor-pointer transition-colors">
      <Lightbulb size={14} className="text-amber-500" />
      Request a tool
      <ArrowUpRight size={13} className="text-zinc-400 group-hover:text-brand transition-colors" />
    </button>
  );
}

/**
 * The home page header, as one card: brand + tagline + chips with the search on
 * the right; a footer strip below a hairline holds Follow (left) and Request a
 * tool (right), so every element sits on a shared grid instead of floating.
 */
export function HomeHero({
  icon: Icon, title, description, chips, query, onQuery,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  chips: { label: string; value?: ReactNode }[];
  query: string;
  onQuery: (v: string) => void;
}) {
  return (
    <header className="mb-8 rounded-xl border border-zinc-200 dark:border-white/[0.07] bg-surface shadow-xs overflow-hidden">
      <div className="flex flex-col md:flex-row md:items-center gap-5 md:gap-8 px-6 py-6">
        <div className="flex-1 min-w-0 flex items-start gap-4">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 bg-brand-gradient shadow-sm ring-1 ring-inset ring-white/10">
            <Icon size={20} className="text-white" strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.015em] leading-tight text-brand">{title}</h1>
            <p className="mt-1 text-[13.5px] text-zinc-500 dark:text-zinc-400 leading-relaxed">{description}</p>
            <div className="flex items-center gap-1.5 flex-wrap mt-3">
              {chips.map((c, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-md text-[12px] font-medium bg-surface-muted border border-zinc-200/80 dark:border-white/[0.06] text-zinc-500 dark:text-zinc-400">
                  {c.value != null && <span className="font-semibold text-zinc-800 dark:text-zinc-100 tabular-nums">{c.value}</span>}
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="w-full md:w-[380px] shrink-0">
          <ToolSearch value={query} onChange={onQuery} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 border-t border-zinc-200/80 dark:border-white/[0.06] bg-surface-muted/60">
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] text-zinc-500 dark:text-zinc-400">
            Follow <span className="font-medium text-zinc-700 dark:text-zinc-200">{brand.developer.followName}</span> for updates
          </span>
          <FollowLinks />
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden lg:inline text-[12.5px] text-zinc-500 dark:text-zinc-400">Missing something?</span>
          <RequestToolButton />
        </div>
      </div>
    </header>
  );
}
