"use client";

/**
 * On-device Whisper (desktop only). Lets the user pick which whisper.cpp model
 * the desktop app uses for offline transcription, and download it once. Renders
 * nothing on the web build (no native Whisper there).
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Download, CheckCircle2, Cpu } from "lucide-react";
import {
  WHISPER_MODELS,
  getWhisperModel,
  setWhisperModel,
  localWhisperAvailable,
  whisperModelStatus,
  downloadWhisperModel,
  type WhisperModelSize,
  type WhisperModelStatus,
} from "@/lib/whisper-local";
import { logDebug, logWarn } from "@/lib/log";

export function WhisperLocalCard() {
  const [available] = useState<boolean>(() => localWhisperAvailable());
  // Client-only (rendered inside the settings modal), so read storage directly.
  const [model, setModel] = useState<WhisperModelSize>(() => getWhisperModel());
  const [status, setStatus] = useState<Record<string, WhisperModelStatus>>({});
  const [downloading, setDownloading] = useState<WhisperModelSize | null>(null);
  const [pct, setPct] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const entries = await Promise.all(
        WHISPER_MODELS.map(async (m) => [m.size, await whisperModelStatus(m.size)] as const),
      );
      setStatus(Object.fromEntries(entries));
    } catch (e) {
      logDebug("whisper-local-card", "Failed to check whisper model status (desktop-only)", e);
    }
  }, []);

  useEffect(() => {
    // Kick off the async on-disk model check (state is set after it resolves).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (available) void refresh();
  }, [available, refresh]);

  if (!available) return null;

  function pick(size: WhisperModelSize) {
    setModel(size);
    setWhisperModel(size);
  }

  async function download(size: WhisperModelSize) {
    setDownloading(size);
    setPct(0);
    try {
      await downloadWhisperModel(size, (p) => setPct(p.pct < 0 ? 0 : p.pct));
      await refresh();
    } catch (e) {
      logWarn("whisper-local-card", "Whisper model download failed", e);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/[0.03] p-5 mb-5">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="w-8 h-8 rounded-xl bg-violet-500/10 flex items-center justify-center">
          <Cpu size={15} className="text-violet-500" />
        </div>
        <div>
          <p className="text-[14px] font-bold text-zinc-900 dark:text-zinc-100">
            Whisper — Speech to Text
          </p>
          <p className="text-[12px] text-zinc-500">
            On-device speech transcription — free, private, works offline. Pick a
            model below; it downloads once, then it&apos;s cached forever.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {WHISPER_MODELS.map((m) => {
          const st = status[m.size];
          const installed = !!st?.installed;
          const isActive = model === m.size;
          const isDownloading = downloading === m.size;
          return (
            <div
              key={m.size}
              className={[
                "flex items-center gap-3 rounded-xl border p-3 transition-colors",
                isActive
                  ? "border-violet-400/70 bg-violet-50/60 dark:bg-violet-500/10"
                  : "border-zinc-200 dark:border-white/10",
              ].join(" ")}
            >
              <button
                type="button"
                onClick={() => pick(m.size)}
                className="flex items-center gap-2.5 flex-1 min-w-0 bg-transparent border-none cursor-pointer text-left p-0"
              >
                <span
                  className={[
                    "w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center",
                    isActive ? "border-violet-500" : "border-zinc-300 dark:border-white/20",
                  ].join(" ")}
                >
                  {isActive && <span className="w-2 h-2 rounded-full bg-violet-500" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                    {m.label}
                  </span>
                  <span className="block text-[11px] text-zinc-500">~{m.mb} MB download</span>
                </span>
              </button>

              {installed ? (
                <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 size={13} /> Installed
                </span>
              ) : isDownloading ? (
                <span className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-500">
                  <Loader2 size={12} className="animate-spin" />
                  {pct > 0 ? `${pct}%` : "Downloading…"}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => download(m.size)}
                  disabled={!!downloading}
                  className="shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-semibold text-white bg-brand-gradient hover:opacity-90 disabled:opacity-50 cursor-pointer border-none"
                >
                  <Download size={12} /> Download
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] text-zinc-400">
        The selected model is used automatically for captions, AI Media and the AI
        Director when you transcribe a voiceover in the desktop app.
      </p>
    </div>
  );
}
