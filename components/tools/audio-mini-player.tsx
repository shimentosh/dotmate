"use client";
import { useState, useEffect, useRef } from "react";
import { Play, Pause, Download } from "lucide-react";
import { saveBlobToDisk } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";

function fmtDur(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Compact inline audio player (play/pause + progress bar + download) for a
 * generated voiceover clip. Shared by Text-to-Voice and Bulk Voice — was an
 * identical per-page copy in each.
 */
export function MiniPlayer({ url, blob, name }: { url: string; blob: Blob; name: string }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dur, setDur] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const a = new Audio(url);
    audioRef.current = a;
    a.onloadedmetadata = () => setDur(a.duration || 0);
    a.ontimeupdate = () => setProgress(a.currentTime / Math.max(a.duration, 1));
    a.onended = () => { setPlaying(false); setProgress(0); };
    return () => { a.pause(); a.src = ""; };
  }, [url]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); } else { a.play(); setPlaying(true); }
  }

  function download() {
    const ext = blob.type.includes("wav") ? "wav" : "mp3";
    void saveBlobToDisk(blob, `${name.replace(/[^a-z0-9]/gi, "_") || "audio"}.${ext}`)
      .catch(e => surfaceError(e, { operation: "save audio" }));
  }

  return (
    <div className="flex items-center gap-2.5 mt-2 px-3 py-2 rounded-xl bg-zinc-50 dark:bg-white/4 border border-zinc-200 dark:border-white/8">
      <button onClick={toggle}
        className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center cursor-pointer border-none bg-linear-to-br from-[#3D7EFD] to-[#0047D1] hover:brightness-110 transition shadow-md shadow-violet-500/20">
        {playing ? <Pause size={11} className="text-white fill-white" /> : <Play size={11} className="text-white fill-white ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="h-1 rounded-full bg-zinc-200 dark:bg-white/10 overflow-hidden">
          <div className="h-full rounded-full bg-linear-to-r from-[#3D7EFD] to-[#0047D1] transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
        <p className="text-[9.5px] text-zinc-400 mt-0.5 tabular-nums">
          {fmtDur(progress * dur)} / {dur ? fmtDur(dur) : "—"}
        </p>
      </div>
      <button onClick={download} title="Download"
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 cursor-pointer border-none bg-emerald-500/10 hover:bg-emerald-500/20 transition">
        <Download size={11} className="text-emerald-600 dark:text-emerald-400" />
      </button>
    </div>
  );
}
