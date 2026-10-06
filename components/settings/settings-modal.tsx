"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, SlidersHorizontal, Cpu, KeyRound, Info, type LucideIcon } from "lucide-react";
import GeneralPage from "@/components/settings/sections/general-section";
import LocalAIPage from "@/components/settings/sections/local-ai-section";
import ApiKeysPage from "@/components/settings/sections/api-keys-section";
import AboutPage from "@/components/settings/sections/about-section";

/**
 * Settings modal — every setting in one dialog. Sections: General (appearance),
 * Local AI (brains / voices / speech models), API Keys (optional bring-your-own
 * cloud brains) and About (version, logs, third-party notices).
 */
export type SettingsSection = "general" | "local-ai" | "api-keys" | "about";

const SECTIONS: { key: SettingsSection; label: string; icon: LucideIcon; Comp: React.ComponentType }[] = [
  { key: "general",  label: "General",  icon: SlidersHorizontal, Comp: GeneralPage },
  { key: "local-ai", label: "Local AI", icon: Cpu,               Comp: LocalAIPage },
  { key: "api-keys", label: "API Keys", icon: KeyRound,          Comp: ApiKeysPage },
  { key: "about",    label: "About",    icon: Info,              Comp: AboutPage },
];

const navItemCls = (active: boolean) =>
  `relative flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13px] text-left cursor-pointer border-none transition-colors ${
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
      : "bg-transparent text-zinc-600 dark:text-zinc-400 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.05] hover:text-zinc-900 dark:hover:text-zinc-100"
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
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-150" onClick={onClose} />

      <div role="dialog" aria-modal="true" aria-label="Settings"
        className="relative z-10 flex w-full max-w-4xl h-[82vh] max-h-[780px] overflow-hidden rounded-2xl border border-zinc-200 dark:border-white/10 bg-surface-elevated dark:bg-background shadow-2xl animate-in fade-in zoom-in-[0.98] duration-150">
        {/* Left nav */}
        <aside className="relative z-10 w-52 shrink-0 flex flex-col border-r border-sidebar-border bg-sidebar p-2.5">
          <p className="px-2.5 pt-1.5 pb-2.5 text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">Settings</p>
          <div className="flex flex-col gap-0.5">
            {SECTIONS.map(({ key, label, icon: Icon }) => {
              const isActive = active === key;
              return (
                <button key={key} onClick={() => setActive(key)} className={navItemCls(isActive)}>
                  <Icon size={15} strokeWidth={1.6} className={`shrink-0 relative z-10 ${isActive ? "text-brand" : "text-zinc-400 dark:text-zinc-500"}`} />
                  <span className="relative z-10">{label}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Content */}
        <div className="relative z-10 flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-end h-11 px-3 shrink-0">
            <button
              onClick={onClose}
              aria-label="Close settings"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 hover:bg-zinc-900/[0.05] dark:hover:bg-white/8 transition-colors cursor-pointer border-none bg-transparent"
            >
              <X size={16} strokeWidth={1.8} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-8 pt-1 pb-8 [scrollbar-gutter:stable]">
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
