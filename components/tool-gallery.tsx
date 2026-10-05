"use client";
/**
 * The tool gallery — the home page and the /tools + /video-studio hubs render
 * cards from here. Each card is a small illustrative mockup inside a mac-style
 * window frame, plus the tool's name, badges and one-line description.
 */
import React from "react";
import Link from "next/link";
import { ArrowRight, Film, Music2, Shuffle, Download, Wand2 } from "lucide-react";
import { FaYoutube, FaInstagram, FaFacebook } from "react-icons/fa";
import { FaTiktok, FaXTwitter } from "react-icons/fa6";

/* ─── Mockup visuals ──────────────────────────────────────────────────────── */

function BatchClipsMockup() {
  const color = "#0057FC";
  // One long recording → many marked moments → a stack of numbered clips.
  const marks = [8, 19, 31, 46, 58, 71, 84];
  return (
    <div className="relative w-full h-full flex flex-col justify-center gap-2.5 px-5 overflow-hidden">
      <div className="w-full h-7 rounded-lg relative overflow-hidden"
        style={{ background: `${color}14`, border: `1px solid ${color}30` }}>
        <div className="absolute inset-0" style={{ background: "repeating-linear-gradient(90deg, transparent, transparent 9px, rgba(0,0,0,0.12) 9px, rgba(0,0,0,0.12) 10px)" }} />
        {marks.map((m) => (
          <div key={m} className="absolute top-1 bottom-1 w-[7px] rounded-sm" style={{ left: `${m}%`, background: `${color}cc` }} />
        ))}
      </div>
      <div className="flex gap-1.5">
        {["01", "02", "03", "04", "05"].map((n, i) => (
          <div key={n} className="flex-1 h-9 rounded-md flex items-center justify-center"
            style={{ background: `${color}${20 + i * 6}`, border: `1px solid ${color}45` }}>
            <span className="text-[9px] font-bold font-mono" style={{ color: `${color}dd` }}>{n}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono text-zinc-400 dark:text-white/[0.28]">clip_001.mp4 … clip_200.mp4</span>
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ color, background: `${color}18` }}>EXPORT ALL</span>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function ClipMergerMockup() {
  const color = "#3D7EFD";
  return (
    <div className="relative w-full h-full flex items-center justify-center gap-3 px-4 overflow-hidden">
      {/* Input clips */}
      <div className="flex flex-col gap-1.5">
        {["A", "B", "C"].map((l, i) => (
          <div key={l} className="w-[50px] h-[28px] rounded-md flex items-center gap-1.5 px-2"
            style={{ background: `${color}${18 + i * 8}`, border: `1px solid ${color}45` }}>
            <Film size={9} style={{ color: `${color}cc` }} strokeWidth={1.8} />
            <span className="text-[9px] font-bold" style={{ color: `${color}cc` }}>{l}</span>
          </div>
        ))}
      </div>
      {/* Arrow */}
      <div className="flex items-center shrink-0">
        <div className="w-6 h-[1.5px] rounded-full" style={{ background: `${color}60` }} />
        <div className="border-t-[4px] border-b-[4px] border-l-[7px] border-transparent"
          style={{ borderLeftColor: `${color}80` }} />
      </div>
      {/* Output */}
      <div className="w-[58px] h-[100px] rounded-lg flex flex-col items-center justify-center gap-2 relative overflow-hidden"
        style={{ background: `${color}22`, border: `1.5px solid ${color}60` }}>
        <div className="absolute top-0 inset-x-0 h-1" style={{ background: `${color}50` }} />
        <div className="absolute bottom-0 inset-x-0 h-1" style={{ background: `${color}50` }} />
        <Film size={16} style={{ color: `${color}dd` }} strokeWidth={1.5} />
        <span className="text-[9px] font-bold" style={{ color: `${color}dd` }}>MP4</span>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function AudioMergerMockup() {
  const color = "#0047D1";
  // Draggable source files (each with its own mini waveform) merging into one.
  const sourceWaves = [
    [5, 9, 6, 11, 7, 9, 5, 8, 6, 10, 7, 9],
    [7, 5, 10, 6, 9, 7, 11, 6, 8, 5, 9, 6],
    [6, 10, 7, 9, 5, 11, 6, 8, 10, 6, 7, 9],
  ];
  const mergedWave = [8, 14, 10, 18, 12, 16, 9, 15, 11, 17, 13, 10, 16, 12, 14, 9, 15, 11];
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center gap-1.5 px-5 overflow-hidden">
      {/* Draggable source rows */}
      <div className="w-full flex flex-col gap-1">
        {sourceWaves.map((wave, i) => (
          <div key={i} className="w-full flex items-center gap-2 rounded-md px-2 py-1"
            style={{ background: `${color}14`, border: `1px solid ${color}2e` }}>
            {/* grip handle */}
            <div className="grid grid-cols-2 gap-[2px] shrink-0">
              {Array.from({ length: 6 }).map((_, d) => (
                <span key={d} className="w-[2px] h-[2px] rounded-full" style={{ background: `${color}66` }} />
              ))}
            </div>
            <Music2 size={10} style={{ color: `${color}bb` }} strokeWidth={1.8} />
            <div className="flex-1 flex items-center gap-[2px] h-3">
              {wave.map((h, j) => (
                <div key={j} className="flex-1 rounded-full" style={{ height: h, maxWidth: 3, background: `${color}55` }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* Merge arrow */}
      <div className="border-l-[4px] border-r-[4px] border-t-[5px] border-transparent -my-0.5"
        style={{ borderTopColor: `${color}70` }} />
      {/* Merged output */}
      <div className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5"
        style={{ background: `${color}22`, border: `1.5px solid ${color}55` }}>
        <Music2 size={11} style={{ color: `${color}dd` }} strokeWidth={1.6} />
        <div className="flex-1 flex items-center gap-[2px] h-4">
          {mergedWave.map((h, j) => (
            <div key={j} className="flex-1 rounded-full" style={{ height: h, maxWidth: 4, background: `${color}cc` }} />
          ))}
        </div>
        <span className="text-[8px] font-bold font-mono shrink-0" style={{ color: `${color}dd` }}>MP3</span>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function FileShufflerMockup() {
  const color = "#3D7EFD";
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center gap-3 px-5 overflow-hidden">
      {/* Shuffle icon header */}
      <div className="w-9 h-9 rounded-xl flex items-center justify-center"
        style={{ background: `${color}20`, border: `1.5px solid ${color}45` }}>
        <Shuffle size={16} style={{ color }} strokeWidth={1.7} />
      </div>
      {/* Before → After row */}
      <div className="flex items-center gap-3 w-full">
        {/* Before */}
        <div className="grid grid-cols-2 gap-1">
          {["001","002","003","004"].map((l, i) => (
            <div key={i} className="w-[34px] h-[24px] rounded-md flex items-center justify-center text-[8px] font-bold font-mono"
              style={{ background: `${color}15`, border: `1px solid ${color}30`, color: `${color}80` }}>
              {l}
            </div>
          ))}
        </div>
        {/* Arrow */}
        <div className="flex items-center shrink-0">
          <div className="w-5 h-[1.5px]" style={{ background: `${color}50` }} />
          <div className="border-t-[4px] border-b-[4px] border-l-[6px] border-transparent"
            style={{ borderLeftColor: `${color}70` }} />
        </div>
        {/* After */}
        <div className="grid grid-cols-2 gap-1">
          {["004","001","003","002"].map((l, i) => (
            <div key={i} className="w-[34px] h-[24px] rounded-md flex items-center justify-center text-[8px] font-bold font-mono"
              style={{ background: `${color}28`, border: `1.5px solid ${color}55`, color: `${color}cc` }}>
              {l}
            </div>
          ))}
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function VideoDownloaderMockup() {
  const platforms = [
    { Icon: FaYoutube,  color: "#ef4444" },
    { Icon: FaTiktok,   color: "#71717a" },
    { Icon: FaInstagram, color: "#0047D1" },
    { Icon: FaXTwitter, color: "#a1a1aa" },
    { Icon: FaFacebook, color: "#3b82f6" },
  ];
  const color = "#0047D1";
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center gap-4 px-5 overflow-hidden">
      {/* Platform icons */}
      <div className="flex items-center gap-2">
        {platforms.map(({ Icon, color: c }, i) => (
          <div key={i} className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: `${c}18`, border: `1px solid ${c}35` }}>
            <Icon size={16} style={{ color: c }} />
          </div>
        ))}
      </div>
      {/* Download icon + bar */}
      <div className="w-full flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: `${color}20`, border: `1px solid ${color}40` }}>
            <Download size={11} style={{ color }} strokeWidth={2} />
          </div>
          <div className="flex-1 h-[3px] rounded-full overflow-hidden bg-black/[0.08] dark:bg-white/[0.08]">
            <div className="h-full rounded-full" style={{ width: "72%", background: "linear-gradient(90deg, #3D7EFD, #0047D1)" }} />
          </div>
          <span className="text-[9px] font-bold font-mono shrink-0" style={{ color }}>72%</span>
        </div>
        <span className="text-[9px] font-mono pl-8 text-zinc-400 dark:text-white/[0.22]">video.mp4 · 87.3 MB</span>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function ScriptMockup() {
  return (
    <div className="relative w-full h-full flex items-start px-5 pt-5 overflow-hidden">
      <div className="w-full space-y-[7px]">
        {[92, 76, 88, 55, 70, 82].map((w, i) => (
          <div key={i} className="h-[4px] rounded-full bg-zinc-300 dark:bg-white/[0.11]" style={{ width: `${w}%` }} />
        ))}
        <div className="flex items-center gap-[5px] pt-1">
          <div className="h-[4px] rounded-full w-24" style={{ background: "rgba(0,87,252,0.65)" }} />
          <div className="w-[2px] h-[14px] rounded-full animate-pulse" style={{ background: "#0057FC" }} />
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function CarouselMockup() {
  const color = "#0047D1";
  // One consistent hue; the front card is more opaque so the stack reads crisp
  // instead of muddy overlapping translucency.
  const cards = [
    { rotate: -11, x: -34, fill: `${color}26`, brd: `${color}55`, front: false, z: 1 },
    { rotate:  11, x:  34, fill: `${color}26`, brd: `${color}55`, front: false, z: 2 },
    { rotate:   0, x:   0, fill: `${color}45`, brd: `${color}99`, front: true,  z: 3 },
  ];
  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      {cards.map((c, i) => (
        <div key={i} className="absolute w-[84px] h-[56px] rounded-xl"
          style={{
            transform: `rotate(${c.rotate}deg) translateX(${c.x}px)`,
            background: c.fill,
            border: `1.5px solid ${c.brd}`,
            boxShadow: c.front ? "0 6px 16px rgba(0,0,0,0.18)" : "0 3px 8px rgba(0,0,0,0.12)",
            zIndex: c.z,
          }}>
          {c.front && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: `${color}cc`, boxShadow: `0 2px 6px ${color}55` }}>
                <div className="ml-0.5 border-t-[4px] border-b-[4px] border-l-[7px] border-transparent"
                  style={{ borderLeftColor: "#fff" }} />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FilmstripMockup() {
  const color = "#0057FC";
  return (
    <div className="relative w-full h-full flex items-center justify-center gap-1.5 px-4 overflow-hidden">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className="flex-1 rounded-lg overflow-hidden relative"
          style={{ height: 54, background: `${color}22`, border: `1px solid ${color}45` }}>
          <div className="absolute top-0 inset-x-0 h-1.5" style={{ background: `${color}55` }} />
          <div className="absolute bottom-0 inset-x-0 h-1.5" style={{ background: `${color}55` }} />
          {i === 2 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-6 h-6 rounded-full flex items-center justify-center"
                style={{ background: `${color}45`, border: `1px solid ${color}65` }}>
                <div className="ml-0.5 border-t-[4px] border-b-[4px] border-l-[7px] border-transparent"
                  style={{ borderLeftColor: color }} />
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function TextToVoiceMockup() {
  const color = "#0047D1";
  const waveBars = [6, 12, 20, 30, 22, 15, 28, 18, 10, 24];
  return (
    <div className="relative w-full h-full flex items-center px-5 gap-5 overflow-hidden">
      <div className="flex-1 space-y-[7px]">
        {[85, 65, 78, 52].map((w, i) => (
          <div key={i} className="h-[4px] rounded-full" style={{ width: `${w}%`, background: `${color}28` }} />
        ))}
      </div>
      <div className="flex items-end gap-[3px] h-10 shrink-0">
        {waveBars.map((h, i) => (
          <div key={i} className="w-[3px] rounded-full"
            style={{ height: `${h}px`, background: `${color}${(50 + i * 5).toString(16).padStart(2, "0")}` }} />
        ))}
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function VoiceToTextMockup() {
  const color = "#003AAC";
  return (
    <div className="relative w-full h-full flex items-center px-5 gap-5 overflow-hidden">
      {/* Mic */}
      <div className="shrink-0 flex flex-col items-center gap-1.5">
        <div className="w-9 h-11 rounded-[14px] relative flex items-end justify-center pb-2.5"
          style={{ background: `${color}20`, border: `1.5px solid ${color}55`, boxShadow: `0 0 14px ${color}28` }}>
          <div className="w-[3px] h-[18px] rounded-full" style={{ background: `${color}90` }} />
        </div>
        <div className="w-7 h-[1.5px] rounded-full" style={{ background: `${color}45` }} />
        <div className="w-4 h-2 rounded-b-full" style={{ background: `${color}30` }} />
      </div>
      {/* Text */}
      <div className="flex-1 space-y-[7px]">
        {[90, 72, 84].map((w, i) => (
          <div key={i} className="h-[4px] rounded-full" style={{ width: `${w}%`, background: `${color}30` }} />
        ))}
        <div className="flex items-center gap-[5px] pt-0.5">
          <div className="h-[4px] rounded-full w-10" style={{ background: `${color}18` }} />
          <div className="w-[2px] h-[14px] rounded-full animate-pulse" style={{ background: color }} />
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

function ScriptToImageMockup() {
  const color = "#3D7EFD";
  return (
    <div className="relative w-full h-full flex items-center justify-center px-5 overflow-hidden">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: `${color}20`, border: `1.5px solid ${color}50` }}>
          <Wand2 size={18} style={{ color }} strokeWidth={1.6} />
        </div>
        <div className="grid grid-cols-2 gap-2 w-full max-w-[150px]">
          {[0,1,2,3].map(i => (
            <div key={i} className="h-[36px] rounded-lg relative overflow-hidden"
              style={{ background: `${color}16`, border: `1px solid ${color}30` }}>
              <div className="absolute inset-0 flex flex-col justify-end p-1.5 gap-[3px]">
                <div className="h-[3px] rounded-full w-full" style={{ background: `${color}40` }} />
                <div className="h-[3px] rounded-full w-2/3" style={{ background: `${color}28` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-t from-[#f4f4f5] dark:from-[#101012] to-transparent" />
    </div>
  );
}

/* ─── macOS window chrome ─────────────────────────────────────────────────── */
function WindowChrome({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 h-8 shrink-0 border-b border-black/[0.07] dark:border-white/[0.08]">
      <div className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(255,95,87,0.85)"  }} />
      <div className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(255,189,46,0.85)" }} />
      <div className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(40,200,64,0.85)"  }} />
      <span className="text-[10px] font-medium ml-1.5 truncate text-zinc-400 dark:text-white/30">{label}</span>
    </div>
  );
}

/* ─── Tool definitions ────────────────────────────────────────────────────── */
export interface GalleryTool {
  name: string;
  desc: string;
  href: string;
  color: string;
  cat: string;
  badge?: string;
  fileName: string;
  Mockup: () => React.ReactNode;
}

/** Everyday media utilities (the /tools hub). */
export const UTILITY_TOOLS: GalleryTool[] = [
  { name: "Quick Trim", desc: "Mark many short clips across long recordings and export them all — or trim whole files.", href: "/tools/quick-trim", color: "#0057FC", cat: "Visual", badge: "Batch", fileName: "clip_001.mp4", Mockup: BatchClipsMockup },
  { name: "Clip Merger", desc: "Merge main clips with random B-roll and music in bulk.", href: "/tools/merger", color: "#3D7EFD", cat: "Visual", fileName: "merged.mp4", Mockup: ClipMergerMockup },
  { name: "Audio Toolkit", desc: "Merge, loop, or extract audio — one hub for your audio tasks.", href: "/tools/audio-merger", color: "#0047D1", cat: "Voice", fileName: "audio.mp3", Mockup: AudioMergerMockup },
  { name: "File Shuffler", desc: "Randomize video names, order, and file dates before reposting.", href: "/tools/file-shuffler", color: "#3D7EFD", cat: "Visual", fileName: "shuffle.zip", Mockup: FileShufflerMockup },
  { name: "Video Downloader", desc: "Download from YouTube, TikTok, Instagram, X and many more sites.", href: "/tools/video-downloader", color: "#0047D1", cat: "Download", fileName: "video.mp4", Mockup: VideoDownloaderMockup },
  { name: "Bulk Voice", desc: "Turn many scripts into voiceovers in one run, on-device.", href: "/tools/bulk-voice", color: "#0047D1", cat: "Voice", badge: "Bulk", fileName: "voices.zip", Mockup: TextToVoiceMockup },
];

/** Creation tools (the /video-studio hub). */
export const STUDIO_TOOLS: GalleryTool[] = [
  { name: "Script Writer", desc: "Generate scripts for any topic, tone, and style with a local AI.", href: "/video-studio/script-writer", color: "#0057FC", badge: "Local AI", cat: "Script", fileName: "script.txt", Mockup: ScriptMockup },
  { name: "Script to Image Prompts", desc: "Turn a whole script into a coherent set of AI image prompts.", href: "/video-studio/script-to-image-prompts", color: "#3D7EFD", badge: "Local AI", cat: "Script", fileName: "prompts.txt", Mockup: ScriptToImageMockup },
  { name: "AI Voiceover", desc: "Convert any script into a voiceover with on-device voices.", href: "/video-studio/text-to-voice", color: "#0047D1", cat: "Voice", fileName: "tts.wav", Mockup: TextToVoiceMockup },
  { name: "Carousel Video", desc: "Blend images and video with 18 cinematic transition styles.", href: "/video-studio/carousel-to-video", color: "#0047D1", cat: "Video", fileName: "carousel.mp4", Mockup: CarouselMockup },
  { name: "Image to Video", desc: "Turn a set of images into a polished slideshow video.", href: "/video-studio/image-to-video", color: "#0057FC", cat: "Video", fileName: "slideshow.mp4", Mockup: FilmstripMockup },
  { name: "Speech to Text", desc: "Transcribe any audio or video into text, privately on-device.", href: "/video-studio/voice-to-text", color: "#003AAC", cat: "Voice", fileName: "transcript.txt", Mockup: VoiceToTextMockup },
];

/* ─── Tool card ──────────────────────────────────────────────────────────── */
export function ToolCard({ tool }: { tool: GalleryTool }) {
  const { name, desc, href, color, badge, cat, fileName, Mockup } = tool;
  return (
    <Link href={href}
      className="group flex flex-col rounded-2xl overflow-hidden no-underline transition-all duration-200 cursor-pointer hover:-translate-y-1.5 border border-zinc-200/80 dark:border-white/[0.07] shadow-sm shadow-black/[0.04] dark:shadow-none"
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = `0 20px 48px rgba(0,0,0,0.18), 0 0 0 1px ${color}35`; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = ""; }}>
      {/* Window area — light screen in light mode, dark glass in dark mode */}
      <div className="flex flex-col relative bg-[#f4f4f5] dark:bg-[#101012]" style={{ height: 160 }}>
        <WindowChrome label={fileName} />
        <div className="flex-1 overflow-hidden relative">
          <Mockup />
        </div>
      </div>

      {/* Info footer */}
      <div className="flex flex-col px-4 pt-4 pb-4 bg-white dark:bg-[#18181b] bg-linear-to-b from-violet-500/[0.08] to-violet-500/[0.03] dark:from-violet-500/[0.13] dark:to-violet-500/[0.05] border-t border-zinc-100 dark:border-white/[0.05]">
        {/* Title gets its own row so it never truncates — only the arrow sits beside it */}
        <div className="flex items-center gap-2 mb-2">
          <span className="flex-1 min-w-0 truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 tracking-tight">{name}</span>
          <ArrowRight size={14} className="shrink-0 text-zinc-300 dark:text-zinc-600 group-hover:text-violet-400 transition-colors" />
        </div>
        {/* Badges on their own row */}
        <div className="flex items-center gap-2 mb-2.5">
          {badge && (
            <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full leading-none"
              style={{ color, background: `${color}18`, border: `1px solid ${color}38` }}>
              {badge.toUpperCase()}
            </span>
          )}
          <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-md leading-none"
            style={{ color, background: `${color}12`, border: `1px solid ${color}28` }}>
            {cat}
          </span>
        </div>
        {/* Description — clamped to a uniform two lines so every card is the same height */}
        <p className="text-[13px] text-zinc-500 dark:text-zinc-500 leading-relaxed line-clamp-2 min-h-[42px]">{desc}</p>
      </div>
    </Link>
  );
}

export function ToolGrid({ tools }: { tools: GalleryTool[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
      {tools.map(tool => <ToolCard key={tool.href} tool={tool} />)}
    </div>
  );
}
