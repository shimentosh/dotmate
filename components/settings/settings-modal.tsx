"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, SlidersHorizontal, Cpu, Info, type LucideIcon } from "lucide-react";
import GeneralPage from "@/components/settings/sections/general-section";
import LocalAIPage from "@/components/settings/sections/local-ai-section";
import AboutPage from "@/components/settings/sections/about-section";

/**
 * Settings modal — every setting in one dialog. Sections: General (appearance),
 * Local AI (brains / voices / speech models) and About (version, logs,
 * third-party notices).
 */
export type SettingsSection = "general" | "local-ai" | "about";

const SECTIONS: { key: SettingsSection; label: string; icon: LucideIcon; Comp: React.ComponentType }[] = [
  { key: "general",  label: "General",  icon: SlidersHorizontal, Comp: GeneralPage },
  { key: "local-ai", label: "Local AI", icon: Cpu,               Comp: LocalAIPage },
  { key: "about",    label: "About",    icon: Info,              Comp: AboutPage },
];

const navItemCls = (active: boolean) =>
  `relative flex items-center gap-2.5 h-9 px-3 rounded-lg text-[13px] text-left cursor-pointer border-none transition-all ${
    active
      ? "bg-white dark:bg-white/10 text-zinc-900 dark:text-zinc-100 font-medium shadow-[0_1px_3px_rgba(0,0,0,0.05)] ring-1 ring-black/5 dark:ring-0"
      : "bg-transparent text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/5 hover:text-zinc-800 dark:hover:text-zinc-200"
  }`;

export function SettingsModal({ open, onClose, initial = "general" }: {
  open: boolean;
  onClose: () => void;
  initial?: SettingsSection;
}) {
  // The parent mounts this per opening (keyed by section), so `initial` seeds it.
  const [active, setActive] = useState<SettingsSection>(initial);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const ActiveComp = SECTIONS.find(s => s.key === active)?.Comp ?? GeneralPage;

  return createPortal(
    <div className="fixed inset-below-titlebar z-[99990] flex items-center justify-center p-4 sm:p-8">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 flex w-full max-w-4xl h-[82vh] max-h-[780px] overflow-hidden rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-950 shadow-2xl shadow-black/30 dark:shadow-black/60">
        {/* Ambient wash — same glow vars as the app background. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(85% 55% at 100% -8%, var(--app-bg-glow-1), transparent 60%)," +
              "radial-gradient(80% 70% at 0% 115%, var(--app-bg-glow-2), transparent 62%)",
          }}
        />

        {/* Left nav */}
        <aside className="relative z-10 w-52 shrink-0 flex flex-col border-r border-zinc-200/80 dark:border-white/8 bg-white/40 dark:bg-white/[0.02] p-3">
          <p className="px-2.5 pt-1 pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Settings</p>
          <div className="flex flex-col gap-0.5">
            {SECTIONS.map(({ key, label, icon: Icon }) => {
              const isActive = active === key;
              return (
                <button key={key} onClick={() => setActive(key)} className={navItemCls(isActive)}>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full" style={{ background: "linear-gradient(to bottom,#3D7EFD,#0047D1)" }} />
                  )}
                  <Icon size={15} strokeWidth={1.6} className={`shrink-0 relative z-10 ${isActive ? "text-violet-500" : "text-zinc-400 dark:text-zinc-500"}`} />
                  <span className="relative z-10">{label}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Content */}
        <div className="relative z-10 flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-end h-11 px-3 shrink-0 border-b border-zinc-200/70 dark:border-white/6">
            <button
              onClick={onClose}
              aria-label="Close settings"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/8 transition cursor-pointer border-none bg-transparent"
            >
              <X size={16} strokeWidth={1.8} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-6 [scrollbar-gutter:stable]">
            <div className="max-w-2xl mx-auto">
              <ActiveComp />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
