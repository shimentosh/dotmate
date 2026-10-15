"use client";

import { Folder, Music, Play, RotateCcw, Square, Volume2, VolumeX, X } from "lucide-react";
import { SectionTitle, inputCls } from "@/components/tools/ui";
import { MusicLibraryBrowser } from "@/components/tools/music-library-browser";
import { MAX_PARALLEL, type QeSettings, type QeVideo } from "@/store/quick-edit";

function fmtSize(b: number) {
  if (b < 1_048_576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1_048_576).toFixed(1)} MB`;
}

/** A 0–max% slider with a tick at 100% (anything past it is a boost). */
function GainSlider({
  label, value, max, onChange, muted, onToggleMute, hint,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
  muted?: boolean;
  onToggleMute?: () => void;
  hint?: string;
}) {
  const pct = (value / max) * 100;
  const boosted = value > 100;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          {onToggleMute ? (
            <button onClick={onToggleMute} title={muted ? "Unmute" : "Mute"}
              className="p-0 bg-transparent border-none cursor-pointer text-zinc-400 hover:text-violet-500 flex">
              {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
          ) : <Volume2 size={12} className="text-zinc-400" />}
          <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">{label}</span>
        </div>
        <span className={`text-[11px] font-bold font-mono ${boosted ? "text-amber-500" : "text-violet-500"}`}>
          {value}%{boosted && " boost"}
        </span>
      </div>
      <div className="relative flex items-center h-5">
        <div className="absolute inset-x-0 h-1 rounded-full bg-zinc-200 dark:bg-white/10" />
        <div className="absolute left-0 h-1 rounded-full bg-brand-gradient" style={{ width: `${pct}%` }} />
        <div className="absolute w-px h-2.5 bg-zinc-400/70" style={{ left: `${(100 / max) * 100}%` }} title="100% — original level" />
        <div className="absolute w-3.5 h-3.5 rounded-full bg-white border-2 border-violet-500 shadow-sm" style={{ left: `calc(${pct}% - 7px)` }} />
        <input type="range" min={0} max={max} step={5} value={value} aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer" />
      </div>
      {hint && <p className="text-[9.5px] text-zinc-400 leading-snug mt-1">{hint}</p>}
    </div>
  );
}

function SecondsField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex-1 min-w-0">
      <span className="block text-[10.5px] font-medium text-zinc-500 mb-1">{label}</span>
      <div className="relative">
        <input type="number" min={0} step={0.5} value={value}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
          className={inputCls("h-8 pr-6 text-[12px] tabular-nums")} />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10.5px] text-zinc-400 pointer-events-none">s</span>
      </div>
    </label>
  );
}

export function EditPanel({
  music, settings, videos, outputDir, running, stopping,
  onMusic, onSetting, onChooseFolder, onStart, onStop, onRenderAgain,
}: {
  music: File | null;
  settings: QeSettings;
  videos: QeVideo[];
  outputDir: string | null;
  running: boolean;
  stopping: boolean;
  onMusic: (f: File | null) => void;
  onSetting: <K extends keyof QeSettings>(key: K, value: QeSettings[K]) => void;
  onChooseFolder: () => void;
  onStart: () => void;
  onStop: () => void;
  onRenderAgain: () => void;
}) {
  const checked = videos.filter((v) => v.checked && v.status === "ready");
  const pending = checked.filter((v) => v.render !== "done");
  const finished = videos.filter((v) => v.render === "done" || v.render === "failed").length;
  const rendering = videos.filter((v) => v.render === "rendering" || v.render === "queued").length;
  const nothingToChange = !music && settings.originalVolume === 100;
  const folderName = outputDir?.split(/[\\/]/).filter(Boolean).pop();
  // Show the naming on a real video, so it's clear the original name is kept.
  const sample = (checked[0] ?? videos[0])?.name.replace(/\.[^.]+$/, "") ?? "video";
  const outName = `${sample}${settings.suffix.trim() || "_edit"}.mp4`;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-6">
        {/* Music */}
        <div>
          <SectionTitle>Background Music</SectionTitle>
          {music ? (
            <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl border-2 border-violet-300 dark:border-violet-500/40 bg-violet-50 dark:bg-violet-500/8">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-violet-500">
                <Music size={15} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-100 truncate">{music.name}</p>
                <p className="text-[10.5px] text-zinc-400">{fmtSize(music.size)} · loops to fit each video</p>
              </div>
              <button onClick={() => onMusic(null)} disabled={running} title="Remove music"
                className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 cursor-pointer border-none bg-violet-200 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 hover:bg-red-100 dark:hover:bg-red-500/20 hover:text-red-500 transition disabled:opacity-40">
                <X size={10} />
              </button>
            </div>
          ) : (
            <MusicLibraryBrowser onPick={onMusic} />
          )}
        </div>

        {/* Volumes */}
        <div className="space-y-4">
          <SectionTitle>Volume</SectionTitle>
          {music && (
            <GainSlider label="Music" value={settings.musicVolume} max={300}
              onChange={(v) => onSetting("musicVolume", v)}
              hint="Above 100% boosts the music — a limiter keeps it from distorting." />
          )}
          <GainSlider label="Original audio" value={settings.originalVolume} max={200}
            onChange={(v) => onSetting("originalVolume", v)}
            muted={settings.originalVolume === 0}
            onToggleMute={() => onSetting("originalVolume", settings.originalVolume === 0 ? 100 : 0)} />
          <p className="text-[10px] text-zinc-400 -mt-1">Press play in the preview — changes are heard live.</p>
        </div>

        {music && (
          <div>
            <SectionTitle>Music Timing</SectionTitle>
            <div className="flex gap-2">
              <SecondsField label="Start at" value={settings.musicOffset} onChange={(v) => onSetting("musicOffset", v)} />
              <SecondsField label="Fade in" value={settings.fadeIn} onChange={(v) => onSetting("fadeIn", v)} />
              <SecondsField label="Fade out" value={settings.fadeOut} onChange={(v) => onSetting("fadeOut", v)} />
            </div>
          </div>
        )}

        {/* Output */}
        <div className="space-y-3">
          <SectionTitle>Output</SectionTitle>
          <button onClick={onChooseFolder} disabled={running}
            className="w-full h-9 px-3 rounded-lg flex items-center gap-2 text-left cursor-pointer border border-zinc-200 dark:border-white/10 bg-surface hover:border-zinc-300 dark:hover:border-white/15 transition-colors disabled:opacity-50">
            <Folder size={13} className="text-zinc-400 shrink-0" />
            <span className={`flex-1 truncate text-[12px] ${folderName ? "text-zinc-800 dark:text-zinc-100 font-semibold" : "text-zinc-400"}`}>
              {folderName ?? "Choose output folder…"}
            </span>
          </button>
          <label className="block">
            <span className="block text-[10.5px] font-medium text-zinc-500 mb-1">Add to the original name</span>
            <input value={settings.suffix} maxLength={40} disabled={running} placeholder="_edit"
              onChange={(e) => onSetting("suffix", e.target.value)}
              className={inputCls("h-8 text-[12px]")} />
            <span className="block text-[10px] text-zinc-400 mt-1 truncate" title={outName}>
              Saved as <span className="font-semibold text-zinc-600 dark:text-zinc-300">{outName}</span>
            </span>
            <span className="block text-[10px] text-zinc-400">The original file is never changed.</span>
          </label>
          <div>
            <span className="block text-[10.5px] font-medium text-zinc-500 mb-1">Render at once</span>
            <div className="flex items-center gap-1.5">
              {Array.from({ length: MAX_PARALLEL }, (_, i) => i + 1).map((n) => (
                <button key={n} onClick={() => onSetting("parallel", n)} disabled={running}
                  className={`w-9 h-8 rounded-lg text-[12px] font-bold cursor-pointer border transition-all font-[inherit] disabled:opacity-50 ${settings.parallel === n
                    ? "bg-violet-500/10 border-violet-500/40 text-violet-600 dark:text-violet-400"
                    : "bg-zinc-50 dark:bg-white/4 border-zinc-200 dark:border-white/8 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300"}`}>
                  {n}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-zinc-400 mt-1.5">The video is copied, not re-encoded, so each render takes seconds.</p>
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="px-5 py-4 border-t border-zinc-200 dark:border-white/8 shrink-0 space-y-2">
        {running ? (
          <button onClick={onStop} disabled={stopping}
            className="w-full h-10 rounded-xl text-[13px] font-bold cursor-pointer flex items-center justify-center gap-2 border border-red-500/30 bg-transparent text-red-500 hover:bg-red-500/8 transition-colors disabled:opacity-50">
            <Square size={12} /> {stopping ? "Stopping…" : `Stop · ${rendering} left`}
          </button>
        ) : pending.length > 0 || checked.length === 0 ? (
          <button onClick={onStart} disabled={!pending.length || nothingToChange}
            className="w-full h-10 rounded-xl text-[13px] font-bold text-white cursor-pointer border-none flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            style={{ background: "var(--brand-gradient)" }}>
            <Play size={13} />
            {checked.length === 0 ? "Select videos to render" : `Render ${pending.length} video${pending.length === 1 ? "" : "s"}`}
          </button>
        ) : (
          <button onClick={onRenderAgain} disabled={nothingToChange}
            className="w-full h-10 rounded-xl text-[13px] font-bold cursor-pointer flex items-center justify-center gap-2 border border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300 hover:bg-violet-500/15 transition-colors disabled:opacity-40">
            <RotateCcw size={13} /> Render {checked.length} again
          </button>
        )}
        <p className="text-[10px] text-zinc-400 text-center leading-snug">
          {nothingToChange ? "Add music or change the original volume to render."
            : running ? `${finished} finished · keeps going if you switch tools`
            : !outputDir ? "You'll choose a save folder first." : `Saving to “${folderName}”.`}
        </p>
      </div>
    </div>
  );
}
