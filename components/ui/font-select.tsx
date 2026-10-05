"use client";
import { useState, useRef, useEffect } from "react";
import { ChevronDown, Search, X, Check } from "lucide-react";

/**
 * Font families offered by the picker. Everything renders through the browser
 * canvas, so any font INSTALLED on the user's computer works; this list is the
 * common families that ship with Windows and/or macOS (a family that isn't
 * installed falls back to the generic family). No fonts are downloaded.
 */
export const SYSTEM_FONTS: string[] = [
  "Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Candara",
  "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New",
  "Franklin Gothic Medium", "Gabriola", "Georgia", "Helvetica", "Impact",
  "Lucida Console", "Palatino Linotype", "Segoe Print", "Segoe Script",
  "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
  "system-ui", "serif", "sans-serif", "monospace", "cursive",
];

/* Individual list item — renders the family name in its own typeface. */
function FontItem({ fontFamily, selected, onClick }: {
  fontFamily: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full px-3 py-2 text-left text-[13px] flex items-center justify-between gap-2 transition-colors ${
        selected
          ? "bg-violet-500/10 text-violet-500"
          : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5"
      }`}
      style={{ fontFamily: `"${fontFamily}", sans-serif` }}
    >
      <span className="truncate">{fontFamily}</span>
      {selected && <Check size={11} className="shrink-0 text-violet-500" />}
    </button>
  );
}

/* ── Public component ── */
export interface FontSelectProps {
  value: string;
  onChange: (font: string) => void;
  className?: string;
  placeholder?: string;
  dropUp?: boolean;
}

export function FontSelect({
  value, onChange, className = "", placeholder = "Select font", dropUp = false,
}: FontSelectProps) {
  const families = SYSTEM_FONTS;
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState("");
  const containerRef        = useRef<HTMLDivElement>(null);
  const searchRef           = useRef<HTMLInputElement>(null);

  /* close on outside click */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false); setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  /* focus search when opening */
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 30);
  }, [open]);

  const filtered = families.filter(f =>
    f.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div ref={containerRef} className={`relative ${className}`}>

      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full h-9 px-3 rounded-lg text-[13px] text-left flex items-center justify-between gap-2 outline-none bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 hover:border-zinc-300 dark:hover:border-white/20 focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/10 transition-all cursor-pointer"
        style={value ? { fontFamily: `"${value}", sans-serif` } : {}}
      >
        <span className="truncate">{value || placeholder}</span>
        <ChevronDown
          size={13}
          className={`text-zinc-400 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className={`absolute z-50 left-0 right-0 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden ${dropUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
          {/* Search */}
          <div className="p-2 border-b border-zinc-100 dark:border-white/8">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
              <input
                ref={searchRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search fonts…"
                className="w-full h-8 pl-8 pr-7 rounded-lg text-[12px] outline-none bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:border-violet-500/60 transition-all"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 border-none bg-transparent cursor-pointer transition-colors"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          {/* Font list */}
          <div className="max-h-[220px] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-5 text-[12px] text-center text-zinc-400">No fonts found</p>
            ) : (
              filtered.map(font => (
                <FontItem
                  key={font}
                  fontFamily={font}
                  selected={font === value}
                  onClick={() => { onChange(font); setOpen(false); setSearch(""); }}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
