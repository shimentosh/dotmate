import type { ReactNode } from "react";

/**
 * The one header used by every Settings page — keep them visually identical.
 * Title + subtitle, with an optional right-side action.
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
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold tracking-[-0.015em] text-zinc-900 dark:text-zinc-50 leading-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400 mt-1">{subtitle}</p>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}
