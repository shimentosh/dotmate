"use client";
import { useState } from "react";
import { Sun, Moon, Monitor, Palette, FileText, FolderOpen, Loader2 } from "lucide-react";
import { SettingsHeader } from "../settings-header";
import { readTheme, saveTheme, type Theme } from "@/lib/theme";
import { safeInvoke } from "@/lib/tauri-invoke";
import { surfaceError, toastSuccess } from "@/lib/toast";
import { brand } from "@/brand.config";
import { useClientValue } from "@/lib/use-client-value";

const THEME_OPTIONS: { key: Theme; Icon: React.ElementType; label: string }[] = [
  { key: "light",  Icon: Sun,     label: "Light"  },
  { key: "dark",   Icon: Moon,    label: "Dark"   },
  { key: "system", Icon: Monitor, label: "System" },
];

const ICON_TILE = { background: "rgba(0,87,252,0.08)", border: "1px solid rgba(0,87,252,0.18)" };

/* ── Appearance (theme) ─────────────────────────────────────────── */
function AppearanceCard() {
  // The stored choice, until the user picks a new one in this session.
  const stored = useClientValue(readTheme, "system");
  const [picked, setPicked] = useState<Theme | null>(null);
  const theme = picked ?? stored;

  function choose(t: Theme) {
    setPicked(t);
    saveTheme(t);
  }

  return (
    <div className="rounded-2xl overflow-hidden border border-zinc-200 dark:border-white/8 glass-card">
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={ICON_TILE}>
          <Palette size={14} className="text-violet-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 leading-tight">Appearance</p>
          <p className="text-[11px] text-zinc-400 mt-0.5">Choose how {brand.name} looks. System follows your device.</p>
        </div>
        <div className="flex items-center gap-px shrink-0 rounded-full p-0.5 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10">
          {THEME_OPTIONS.map(({ key, Icon, label }) => (
            <button key={key} onClick={() => choose(key)} title={label}
              className={[
                "flex items-center gap-1.5 h-7 px-3 rounded-full text-[12px] font-medium transition-all cursor-pointer border-none",
                theme === key
                  ? "bg-white dark:bg-white/15 text-zinc-800 dark:text-zinc-100 shadow-sm"
                  : "bg-transparent text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300",
              ].join(" ")}>
              <Icon size={13} strokeWidth={1.8} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Diagnostics & logs (desktop only) ──────────────────────────── */
function DiagnosticsCard() {
  const isDesktop = useClientValue(() => "__TAURI_INTERNALS__" in window, false);
  const [busy, setBusy] = useState(false);

  if (!isDesktop) return null;

  async function openLogs() {
    if (busy) return;
    setBusy(true);
    try {
      // timeoutMs:0 — opening the file manager can be slow to return.
      await safeInvoke("open_logs_dir", undefined, { timeoutMs: 0 });
      toastSuccess("Opened the log folder.", "Logs");
    } catch (e) {
      surfaceError(e, { operation: "open logs folder" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl overflow-hidden border border-zinc-200 dark:border-white/8 glass-card">
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={ICON_TILE}>
          <FileText size={14} className="text-violet-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 leading-tight">Diagnostics &amp; logs</p>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            Open the folder holding the app log and the focused{" "}
            <span className="font-mono text-zinc-500 dark:text-zinc-400">errors.log</span>. Logs never leave this computer.
          </p>
        </div>
        <button onClick={openLogs} disabled={busy}
          className="h-8 px-3.5 rounded-lg text-[12px] font-medium cursor-pointer transition-all flex items-center gap-1.5
            text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-white/10 bg-transparent
            hover:bg-zinc-50 dark:hover:bg-white/5 disabled:opacity-60">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={13} />}
          Open logs folder
        </button>
      </div>
    </div>
  );
}

export default function GeneralPage() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsHeader title="General" subtitle="Appearance and diagnostics." />
      <AppearanceCard />
      <DiagnosticsCard />
    </div>
  );
}
