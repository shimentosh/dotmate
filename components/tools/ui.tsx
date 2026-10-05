"use client";
import React from "react";
import { ChevronRight } from "lucide-react";

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-1">
      {children}
    </label>
  );
}

export function inputCls(extra = "") {
  // Translucent fill (dark:bg-white/5) rather than a solid grey, so inputs blend
  // with the ambient AppBackground gradient on the now-transparent tool panels —
  // matching the rest of the app's surface treatment. Violet focus ring = brand.
  return `w-full h-9 px-3 rounded-lg text-[13px] outline-none bg-white dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/10 transition-all [color-scheme:light] dark:[color-scheme:dark] ${extra}`;
}

/**
 * Section header — the global side-panel section style: a gradient accent pill +
 * uppercase label, separated by a hairline bottom border. When `onToggle` is
 * passed it becomes a collapsible header with a chevron.
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
    <span className="flex items-center gap-2 min-w-0">
      {/* Gradient accent pill — matches the editor's right-panel section headers */}
      <span
        className="w-0.5 h-3 rounded-full shrink-0"
        style={{ background: "linear-gradient(to bottom, #3D7EFD, #0047D1)" }}
      />
      <span
        className="text-[11px] font-bold uppercase tracking-widest truncate"
        style={{ color: "rgb(139,139,154)" }}
      >
        {children}
      </span>
    </span>
  );

  if (!onToggle)
    return (
      <div className="flex items-center mb-3">
        {label}
      </div>
    );

  return (
    <button
      onClick={onToggle}
      className="flex items-center justify-between w-full mb-3 px-0 py-0 cursor-pointer bg-transparent border-none text-left group"
    >
      {label}
      <ChevronRight
        size={12}
        className="shrink-0 transition-transform duration-200"
        style={{
          color: "rgb(139,139,154)",
          transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
        }}
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
      onClick={() => onChange(!checked)}
      className="relative w-9 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0"
      style={{ background: checked ? "#0057FC" : "rgba(0,0,0,0.12)" }}
    >
      <span
        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all"
        style={{ left: checked ? "calc(100% - 18px)" : "2px" }}
      />
    </button>
  );
}
