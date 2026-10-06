"use client";
import React from "react";
import { ChevronRight } from "lucide-react";

/* Shared form + panel primitives for every tool page. Colours come from the
   semantic tokens in app/globals.css (surface / border / brand), so restyling
   them here restyles every tool at once. */

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[12px] font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
      {children}
    </label>
  );
}

export function inputCls(extra = "") {
  return `w-full h-9 px-3 rounded-lg text-[13px] outline-none bg-surface border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 hover:border-zinc-300 dark:hover:border-white/15 focus:border-brand/60 focus:ring-[3px] focus:ring-brand/12 disabled:opacity-50 disabled:cursor-not-allowed transition-[border-color,box-shadow] duration-150 [color-scheme:light] dark:[color-scheme:dark] ${extra}`;
}

/**
 * Section header — the global side-panel section style: an uppercase label in
 * the muted text colour. When `onToggle` is passed it becomes a collapsible
 * header with a chevron.
 */
export function SectionTitle({
  children,
  collapsed,
  onToggle,
}: {
  children: React.ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const label = (
    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] truncate text-zinc-500 dark:text-zinc-400">
      {children}
    </span>
  );

  if (!onToggle)
    return (
      <div className="flex items-center mb-3 min-w-0">
        {label}
      </div>
    );

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex items-center justify-between w-full mb-3 px-0 py-0 cursor-pointer bg-transparent border-none text-left rounded-sm group"
    >
      {label}
      <ChevronRight
        size={13}
        className="shrink-0 text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-transform duration-200"
        style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }}
      />
    </button>
  );
}

export function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors duration-150 cursor-pointer border-none shrink-0 ${
        checked ? "bg-brand" : "bg-zinc-300 dark:bg-white/15"
      }`}
    >
      <span
        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-[left] duration-150"
        style={{ left: checked ? "calc(100% - 18px)" : "2px" }}
      />
    </button>
  );
}
