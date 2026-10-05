import type { ReactNode } from "react";

/**
 * The one header used by every Settings page — keep them visually identical.
 * A slim gradient accent bar + title + subtitle, with an optional right-side action.
 */
export function SettingsHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-1">
      <div className="flex items-stretch gap-3 min-w-0">
        <div className="w-[3px] rounded-full bg-linear-to-b from-[#3D7EFD] to-[#0047D1] shrink-0" />
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 leading-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="text-[13px] text-zinc-500 mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}
