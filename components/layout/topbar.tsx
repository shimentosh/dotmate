"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronRight, ChevronLeft, Settings } from "lucide-react";
import { GuardedLink } from "@/components/guarded-link";
import { useGuardedRouter } from "@/hooks/use-guarded-router";
import { BrandMark } from "@/components/brand-mark";
import { WindowControls } from "./window-controls";
import { useTrafficLightPad } from "@/lib/use-mac-chrome";
import { SettingsModal, type SettingsSection } from "@/components/settings/settings-modal";
import { OPEN_SETTINGS_EVENT } from "@/lib/open-settings";
import { ROUTES, routeFor } from "@/lib/routes";
import { brand } from "@/brand.config";

/* The current page in the frameless title strip (decorations:false means there is
   no native title bar). Non-interactive so the strip stays draggable. */
function PageTitle() {
  const pathname = usePathname();
  const route = routeFor(pathname);
  const parent = route.parent ? ROUTES[route.parent] : undefined;
  return (
    <span className="pointer-events-none flex items-center gap-1.5 min-w-0 text-[12px]">
      {parent && (
        <>
          <span className="text-zinc-400 dark:text-zinc-500 truncate">{parent.label}</span>
          <ChevronRight size={11} strokeWidth={2} className="text-zinc-300 dark:text-zinc-600 shrink-0" />
        </>
      )}
      <span className="font-semibold text-zinc-700 dark:text-zinc-200 truncate">{route.label}</span>
    </span>
  );
}

/**
 * The top bar doubles as the frameless window's title bar: brand · back · page
 * title (draggable) · Settings · window controls. It also owns the single
 * <SettingsModal>, opened by the gear or by `openSettings()` from anywhere.
 */
export default function TopBar() {
  const nav = useGuardedRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  // macOS draws native traffic lights top-left; pad the brand so it clears them.
  const padForLights = useTrafficLightPad();

  useEffect(() => {
    const onOpen = (e: Event) => {
      setSettingsSection((e as CustomEvent<SettingsSection>).detail ?? "general");
      setSettingsOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, []);

  return (
    <header data-tauri-drag-region className="relative h-9 flex items-stretch shrink-0 z-10 bg-white/40 dark:bg-white/[0.02] backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-white/60 via-zinc-200/60 to-white/30 dark:from-white/[0.10] dark:via-white/[0.06] dark:to-white/[0.02]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 translate-y-full bg-linear-to-b from-black/[0.06] to-transparent dark:from-black/25 dark:to-transparent" />

      {/* Brand */}
      <div data-tauri-drag-region className={`shrink-0 flex items-center pr-4 ${padForLights ? "pl-[84px]" : "pl-4"}`}>
        <GuardedLink href="/" className="flex items-center gap-2 no-underline shrink-0" aria-label="Home">
          <BrandMark size={18} className="shrink-0" />
          <span className="font-bold text-[13px] tracking-tight text-zinc-900 dark:text-zinc-100 whitespace-nowrap">{brand.name}</span>
        </GuardedLink>
      </div>

      {/* Drag strip + back button + current page name */}
      <div data-tauri-drag-region className="flex-1 flex items-center px-4 min-w-0 gap-1">
        <button
          type="button"
          onClick={() => nav.back()}
          title="Go back"
          aria-label="Go back"
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg bg-transparent border-none cursor-pointer text-zinc-400 hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-white hover:bg-zinc-200/60 dark:hover:bg-white/10 transition-colors"
        >
          <ChevronLeft size={17} strokeWidth={2.2} />
        </button>
        <PageTitle />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 px-4 shrink-0">
        <button
          onClick={() => { setSettingsSection("general"); setSettingsOpen(true); }}
          title="Settings"
          aria-label="Settings"
          className={[
            "relative w-8 h-8 flex items-center justify-center rounded-xl transition cursor-pointer border-none",
            settingsOpen
              ? "bg-zinc-100 dark:bg-white/10 text-zinc-900 dark:text-zinc-100"
              : "bg-transparent text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/8 hover:text-zinc-700 dark:hover:text-zinc-200",
          ].join(" ")}
        >
          <Settings size={16} strokeWidth={1.6} />
        </button>
      </div>

      {/* Window controls — the top bar is the frameless title bar. */}
      <WindowControls />

      {settingsOpen && (
        <SettingsModal key={settingsSection} open onClose={() => setSettingsOpen(false)} initial={settingsSection} />
      )}
    </header>
  );
}
