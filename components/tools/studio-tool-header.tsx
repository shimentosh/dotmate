"use client";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * StudioToolHeader — formerly the slim title/description strip atop every Video
 * Studio / Tools page. The icon · title · description duplicated the global
 * topbar breadcrumb, so that strip has been removed.
 *
 * The component now renders nothing unless a page supplies action controls via
 * `right` — in which case it shows a minimal right-aligned actions bar. All other
 * props (`icon`, `title`, `description`, `accent`, `backHref`, `backLabel`) are
 * accepted for backward-compat with existing call sites but no longer rendered.
 */
export function StudioToolHeader({
  right,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  accent?: string;
  backHref?: string;
  backLabel?: string;
  right?: ReactNode;
}) {
  if (!right) return null;
  return (
    <div className="flex items-center justify-end gap-2 px-5 h-11 border-b border-zinc-200 dark:border-white/8 bg-white dark:bg-[#0e0e11] shrink-0">
      {right}
    </div>
  );
}
