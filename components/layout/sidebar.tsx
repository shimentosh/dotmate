"use client";
import { usePathname } from "next/navigation";
import { Settings, Cpu } from "lucide-react";
import { GuardedLink } from "@/components/guarded-link";
import { NAV, type NavItem } from "@/lib/routes";
import { openSettings } from "@/lib/open-settings";
import { DevelopedBy } from "@/components/developed-by";

/* ── NavLink ─────────────────────────────────────────────────────────────── */
function NavLink({ href, icon: Icon, label, active }: NavItem & { active: boolean }) {
  return (
    <GuardedLink
      href={href}
      className={[
        "group relative flex items-center gap-3 h-9 px-3 rounded-lg",
        "text-[13px] no-underline transition-colors duration-150",
        active
          ? "bg-zinc-100 dark:bg-white/[0.07] text-zinc-900 dark:text-white font-semibold"
          : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100/70 dark:hover:bg-white/[0.04] hover:text-zinc-800 dark:hover:text-zinc-200",
      ].join(" ")}
    >
      {active && (
        <span className="absolute -left-3 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-violet-500" />
      )}
      <Icon
        size={17}
        strokeWidth={1.8}
        className={`shrink-0 ${active ? "text-violet-500 dark:text-violet-300" : ""}`}
      />
      <span className="truncate flex-1">{label}</span>
    </GuardedLink>
  );
}

function isActive(pathname: string, href: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return href === "/" ? p === "/" : p === href || p.startsWith(href + "/");
}

/* ── Sidebar ─────────────────────────────────────────────────────────────── */
export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 relative shrink-0 flex flex-col h-full bg-white/40 dark:bg-white/[0.02] backdrop-blur-xl">
      {/* Glassy edge: a faint highlight on the seam + a soft shadow onto the content. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-linear-to-b from-white/60 via-zinc-200/60 to-white/30 dark:from-white/[0.10] dark:via-white/[0.06] dark:to-white/[0.02]" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-4 translate-x-full bg-linear-to-r from-black/[0.06] to-transparent dark:from-black/25 dark:to-transparent" />

      <nav className="flex-1 px-3 pt-4 pb-3 overflow-y-auto overflow-x-hidden min-h-0 space-y-0.5">
        {NAV.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "pt-3" : ""}>
            {group.section && (
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-400/80 dark:text-zinc-600 px-3 pb-1.5 select-none">
                {group.section}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink key={item.href} {...item} active={isActive(pathname, item.href)} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Bottom: settings shortcuts ─────────────────────────────── */}
      <div className="px-3 pt-2 pb-3 shrink-0 space-y-0.5 border-t border-zinc-200/60 dark:border-white/[0.05]">
        <button
          onClick={() => openSettings("local-ai")}
          className="w-full flex items-center gap-3 h-9 px-3 rounded-lg text-[13px] text-left text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100/70 dark:hover:bg-white/[0.04] hover:text-zinc-800 dark:hover:text-zinc-200 bg-transparent border-none cursor-pointer transition-colors"
        >
          <Cpu size={17} strokeWidth={1.8} className="shrink-0" />
          <span className="truncate flex-1">Local AI models</span>
        </button>
        <button
          onClick={() => openSettings("general")}
          className="w-full flex items-center gap-3 h-9 px-3 rounded-lg text-[13px] text-left text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100/70 dark:hover:bg-white/[0.04] hover:text-zinc-800 dark:hover:text-zinc-200 bg-transparent border-none cursor-pointer transition-colors"
        >
          <Settings size={17} strokeWidth={1.8} className="shrink-0" />
          <span className="truncate flex-1">Settings</span>
        </button>
        <DevelopedBy />
      </div>
    </aside>
  );
}
