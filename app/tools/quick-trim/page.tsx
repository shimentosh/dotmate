"use client";
import { CircleDot, Scissors, type LucideIcon } from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { BatchClipsTool } from "@/components/dotmate/batch-clips-tool";
import { TrimFilesTool } from "@/components/tools/trim-files-tool";
import { usePreference } from "@/lib/use-preference";
import { toastInfo } from "@/lib/toast";
import { useActiveTasks } from "@/store/active-tasks";
import { useBatchClips } from "@/store/batch-clips";

type Tab = "batch-clips" | "trim-files";

const TABS: { id: Tab; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "batch-clips", label: "Batch Clips", hint: "Mark many moments in long recordings, export them all", icon: CircleDot },
  { id: "trim-files", label: "Trim Files", hint: "Trim whole files with one range", icon: Scissors },
];

/**
 * Quick Trim — two tools on one page:
 *  - Batch Clips (default): mark many moments across long recordings, export them all.
 *  - Trim Files: the original batch trimmer (one range / mode applied to every file).
 */
export default function QuickTrimPage() {
  const [tab, setTab] = usePreference<Tab>("quickTrim.tab", "batch-clips");
  // A Trim Files batch lives inside its component — switching tabs would strand it.
  const trimBusy = useActiveTasks((s) => s.tasks.some((t) => t.label === "Quick Trim"));
  const exporting = useBatchClips((s) => s.exp.running);
  const active: Tab = tab === "trim-files" ? "trim-files" : "batch-clips";

  const choose = (next: Tab) => {
    if (next === active) return;
    if (trimBusy) { toastInfo("Pause or stop the running trim first."); return; }
    setTab(next);
  };

  return (
    <AppLayout>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="shrink-0 flex items-center gap-3 px-4 h-11 border-b border-zinc-200 dark:border-white/8 bg-panel">
          <div role="tablist" aria-label="Quick Trim tools" className="flex items-center gap-1 p-0.5 rounded-lg bg-zinc-100 dark:bg-white/[0.05]">
            {TABS.map(({ id, label, icon: Icon }) => {
              const on = id === active;
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={on}
                  onClick={() => choose(id)}
                  className={`relative flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-semibold border-none cursor-pointer transition-colors ${on
                    ? "bg-white dark:bg-white/10 text-violet-600 dark:text-violet-300 shadow-sm"
                    : "bg-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}
                >
                  <Icon size={13} />
                  {label}
                  {id === "batch-clips" && exporting && (
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" title="Exporting" />
                  )}
                </button>
              );
            })}
          </div>
          <span className="text-[11px] text-zinc-400 truncate">{TABS.find((t) => t.id === active)?.hint}</span>
        </div>
        {active === "batch-clips" ? <BatchClipsTool /> : <TrimFilesTool />}
      </div>
    </AppLayout>
  );
}
