"use client";
/**
 * Inline background-music picker for a tool's "Background Music" section: drop or
 * browse an audio file from this computer. The selection is handed back as a
 * browser `File` via onPick — the shape the merger / carousel pipelines feed to
 * the local ffmpeg / WebCodecs code.
 */
import { useRef, useState } from "react";
import { Upload } from "lucide-react";

export function MusicLibraryBrowser({ onPick }: { onPick: (file: File) => void }) {
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-white/8 bg-white/60 dark:bg-white/[0.03] overflow-hidden">
      <div className="p-2">
        <div
          onDragEnter={e => { e.preventDefault(); setDrag(true); }}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => {
            e.preventDefault(); setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f && f.type.startsWith("audio/")) onPick(f);
          }}
          onClick={() => fileRef.current?.click()}
          className={`flex items-center gap-3 px-3.5 py-4 rounded-xl border-2 border-dashed transition-colors cursor-pointer ${
            drag ? "border-violet-400 bg-violet-50 dark:bg-violet-500/5"
                 : "border-zinc-300 dark:border-white/20 bg-zinc-50/80 dark:bg-white/[0.04] hover:border-violet-400/50 hover:bg-zinc-50 dark:hover:bg-white/3"}`}
        >
          <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.aac,.ogg,.flac,.m4a" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${drag ? "bg-violet-500" : "bg-zinc-100 dark:bg-white/6"}`}>
            <Upload size={14} className={drag ? "text-white" : "text-zinc-400"} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">Drop an audio file <span className="text-zinc-400 font-normal">or browse</span></p>
            <p className="text-[10px] text-zinc-400">MP3, WAV, AAC, FLAC…</p>
          </div>
        </div>
      </div>
    </div>
  );
}
