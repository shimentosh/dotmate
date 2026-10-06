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
        "group relative flex items-center gap-2.5 h-8 px-2.5 rounded-lg",
        "text-[13px] no-underline transition-colors duration-150",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.05] hover:text-zinc-900 dark:hover:text-zinc-100",
      ].join(" ")}
      aria-current={active ? "page" : undefined}
    >
      <Icon
        size={16}
        strokeWidth={1.8}
        className={`shrink-0 transition-colors ${active ? "text-brand" : "text-zinc-400 dark:text-zinc-500 group-hover:text-zinc-600 dark:group-hover:text-zinc-300"}`}
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
    <aside className="w-56 relative shrink-0 flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      <nav aria-label="Tools" className="flex-1 px-2.5 pt-3 pb-3 overflow-y-auto overflow-x-hidden min-h-0">
        {NAV.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "pt-4" : ""}>
            {group.section && (
              <p className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 px-2.5 pb-1 select-none">
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
      <div className="px-2.5 pt-2 pb-2.5 shrink-0 space-y-0.5 border-t border-sidebar-border">
        <button
          onClick={() => openSettings("local-ai")}
          className="group w-full flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13px] text-left text-zinc-600 dark:text-zinc-400 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.05] hover:text-zinc-900 dark:hover:text-zinc-100 bg-transparent border-none cursor-pointer transition-colors"
        >
          <Cpu size={16} strokeWidth={1.8} className="shrink-0 text-zinc-400 dark:text-zinc-500 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors" />
          <span className="truncate flex-1">Local AI models</span>
        </button>
        <button
          onClick={() => openSettings("general")}
          className="group w-full flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13px] text-left text-zinc-600 dark:text-zinc-400 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.05] hover:text-zinc-900 dark:hover:text-zinc-100 bg-transparent border-none cursor-pointer transition-colors"
        >
          <Settings size={16} strokeWidth={1.8} className="shrink-0 text-zinc-400 dark:text-zinc-500 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors" />
          <span className="truncate flex-1">Settings</span>
        </button>
        <DevelopedBy />
      </div>
    </aside>
  );
}
