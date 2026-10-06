"use client";
import { logDebug, logWarn, logError } from "@/lib/log";
import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import {
  Download, X, CheckCircle2,
  AlertCircle, Loader2, FolderOpen, Clock, Zap,
  ListVideo, Trash2, StopCircle, TerminalSquare, Video, Music,
  ExternalLink, FolderInput, KeyRound, RefreshCw,
} from "lucide-react";
import {
  SiYoutube, SiTiktok, SiInstagram, SiX, SiFacebook,
  SiVimeo, SiReddit, SiDailymotion, SiTwitch, SiPinterest,
} from "react-icons/si";
import type { IconType } from "react-icons";
import AppLayout from "@/components/layout/app-layout";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import { FieldLabel, SectionTitle, ToggleSwitch } from "@/components/tools/ui";
import { openExternal } from "@/lib/open-external";
import { brand, storageKey } from "@/brand.config";
import { useRegisterTask } from "@/hooks/use-register-task";

const COOKIES_KEY = storageKey("ytdlp-cookies-path");

/** One-click cookies.txt exporter (Chrome/Edge) — opens its store page in the browser. */
const COOKIES_EXTENSION_URL = "https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc";

/* ─── Tauri guard ────────────────────────────────────────────────────────────── */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ─── Platform data ──────────────────────────────────────────────────────────── */
const PLATFORMS: { name: string; color: string; pattern: RegExp; Icon: IconType }[] = [
  { name: "YouTube",     color: "#ff0000", pattern: /youtube\.com|youtu\.be/i,       Icon: SiYoutube     },
  { name: "TikTok",      color: "#000000", pattern: /tiktok\.com/i,                  Icon: SiTiktok      },
  { name: "Instagram",   color: "#e1306c", pattern: /instagram\.com/i,               Icon: SiInstagram   },
  { name: "Twitter/X",   color: "#1da1f2", pattern: /twitter\.com|x\.com/i,          Icon: SiX           },
  { name: "Facebook",    color: "#1877f2", pattern: /facebook\.com|fb\.watch/i,      Icon: SiFacebook    },
  { name: "Vimeo",       color: "#19b7ea", pattern: /vimeo\.com/i,                   Icon: SiVimeo       },
  { name: "Reddit",      color: "#ff4500", pattern: /reddit\.com/i,                  Icon: SiReddit      },
  { name: "Dailymotion", color: "#0066dc", pattern: /dailymotion\.com/i,             Icon: SiDailymotion },
  { name: "Twitch",      color: "#9147ff", pattern: /twitch\.tv/i,                   Icon: SiTwitch      },
  { name: "Pinterest",   color: "#e60023", pattern: /pinterest\.com/i,               Icon: SiPinterest   },
];

/* ─── Quality / format maps ──────────────────────────────────────────────────── */
const QUALITIES = ["4K · 2160p", "1080p HD", "720p HD", "480p", "360p", "Audio only"] as const;
const FORMATS   = ["MP4", "WebM", "MKV", "MP3", "M4A"] as const;
type Quality = typeof QUALITIES[number];
type Format  = typeof FORMATS[number];

const QUALITY_CODE: Record<Quality, string> = {
  "4K · 2160p": "bestvideo[height<=2160]+bestaudio/best[height<=2160]",
  "1080p HD":   "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
  "720p HD":    "bestvideo[height<=720]+bestaudio/best[height<=720]",
  "480p":       "bestvideo[height<=480]+bestaudio/best[height<=480]",
  "360p":       "bestvideo[height<=360]+bestaudio/best[height<=360]",
  "Audio only": "bestaudio/best",
};

const FORMAT_MERGE: Record<Format, string> = {
  MP4:  "mp4",
  WebM: "webm",
  MKV:  "mkv",
  MP3:  "mp3",
  M4A:  "m4a",
};

/* ─── Types ──────────────────────────────────────────────────────────────────── */
type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

interface DownloadJob {
  id: string;
  /** The single source URL this job downloads. One pasted line → one job. */
  url: string;
  /** Resolved video title (from metadata, then filename); empty until known. */
  title: string;
  /** Channel / uploader, when metadata resolves it. */
  uploader: string;
  isPlaylist: boolean;
  playlistRange: string;
  /** yt-dlp args captured at queue time, so later format changes don't affect this job. */
  formatCode: string;
  mergeFormat: string;
  /** yt-dlp --download-sections spec (e.g. "*0:30-2:30"), or "" for the full video. */
  downloadSection: string;
  /** Path to a cookies.txt for YouTube auth, captured at queue time ("" = none). */
  cookiesPath: string;
  outputDir: string;
  status: JobStatus;
  percent: number;
  speed: string;
  eta: string;
  filename: string;
  currentItem: number;
  totalItems: number;
  error?: string;
}

/** How many downloads run at once; the rest wait in the queue. */
const MAX_CONCURRENT = 3;

/** Title pre-fetch budget. Each title look-up spawns a yt-dlp process, so a huge
 *  paste (1000+ links) must NOT fire one per link — that storm froze the app.
 *  We resolve at most MAX_TITLE_PREFETCH titles, TITLE_FETCH_CONCURRENCY at a time;
 *  every other card fills its title in from the download's own output as it runs. */
const TITLE_FETCH_CONCURRENCY = 4;
const MAX_TITLE_PREFETCH = 60;

/** Run async tasks with a fixed concurrency cap (a tiny worker pool). */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(workers);
}

interface ProgressPayload {
  id: string;
  percent: number;
  speed: string;
  eta: string;
  filename: string;
  current_item: number;
  total_items: number;
}

interface CompletePayload {
  id: string;
  output_dir: string;
}

interface ErrorPayload {
  id: string;
  message: string;
}

/* ─── Helpers ────────────────────────────────────────────────────────────────── */
function detectPlatform(url: string) {
  return PLATFORMS.find(p => p.pattern.test(url)) ?? null;
}

function isPlaylistUrl(url: string): boolean {
  return /[?&]list=/.test(url) || /\/playlist[?/]/.test(url);
}

/** YouTube serves only a truncated (~100-item) playlist from a `watch?v=…&list=…`
 *  URL — its watch-page side panel is capped. The canonical `playlist?list=…`
 *  page paginates through the WHOLE list, so we rewrite watch+list URLs to it.
 *  Endless Mixes/radios (list=RD…) have no full list and are left untouched. */
function normalizePlaylistUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "youtube.com" && host !== "m.youtube.com") return url;
    if (u.pathname !== "/watch") return url;          // already /playlist (or not a watch URL)
    const list = u.searchParams.get("list");
    if (!list || /^RD/i.test(list)) return url;       // no playlist, or an endless Mix
    return `https://www.youtube.com/playlist?list=${list}`;
  } catch {
    return url;
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Seconds → m:ss or h:mm:ss for the fetched-length readout. */
function fmtClock(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** "mm:ss" / "hh:mm:ss" / plain seconds → seconds (null if empty/invalid). */
function parseTime(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(":").map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/* ─── Dual-handle clip range slider ───────────────────────────────────────── */
function ClipRangeSlider({ duration, startSec, endSec, onChange }: {
  duration: number; startSec: number; endSec: number;
  onChange: (start: number, end: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<"start" | "end" | null>(null);

  const s = Math.min(Math.max(0, startSec), duration);
  const e = Math.min(Math.max(0, endSec), duration);
  const leftPct  = duration ? (s / duration) * 100 : 0;
  const rightPct = duration ? (e / duration) * 100 : 100;

  function valueAt(clientX: number): number {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(ratio * duration);
  }
  function onMove(ev: React.PointerEvent) {
    if (!drag.current) return;
    const v = valueAt(ev.clientX);
    if (drag.current === "start") onChange(Math.min(v, e - 1), e);
    else                          onChange(s, Math.max(v, s + 1));
  }
  function onDown(which: "start" | "end", ev: React.PointerEvent) {
    ev.preventDefault();
    drag.current = which;
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  }
  function onUp(ev: React.PointerEvent) {
    drag.current = null;
    try { (ev.currentTarget as Element).releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-2 text-[10.5px] font-semibold tabular-nums">
        <span className="text-violet-600 dark:text-violet-400">{fmtClock(s)}</span>
        <span className="px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
          {fmtClock(Math.max(0, e - s))} clip
        </span>
        <span className="text-violet-600 dark:text-violet-400">{fmtClock(e)}</span>
      </div>
      <div ref={trackRef} onPointerMove={onMove} onPointerUp={onUp}
        className="relative h-6 flex items-center">
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-zinc-200 dark:bg-white/10" />
        <div className="absolute h-1.5 rounded-full"
          style={{ left: `${leftPct}%`, right: `${100 - rightPct}%`, background: "var(--brand-gradient)" }} />
        <div onPointerDown={ev => onDown("start", ev)}
          className="absolute w-4 h-4 -ml-2 rounded-full bg-white border-2 border-violet-500 shadow-md cursor-grab active:cursor-grabbing touch-none transition-transform hover:scale-110"
          style={{ left: `${leftPct}%` }} />
        <div onPointerDown={ev => onDown("end", ev)}
          className="absolute w-4 h-4 -ml-2 rounded-full bg-white border-2 border-violet-500 shadow-md cursor-grab active:cursor-grabbing touch-none transition-transform hover:scale-110"
          style={{ left: `${rightPct}%` }} />
      </div>
    </div>
  );
}

/** A short, human-readable label for a URL (host + last path segment) for queued items. */
function readableUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    return seg ? `${u.hostname.replace(/^www\./, "")} · ${seg}` : u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Best-effort absolute path of a finished download, for Open / Reveal / Save-all. */
function jobFilePath(job: DownloadJob): string | null {
  if (!job.filename) return null;
  // yt-dlp may report an already-absolute path — use it as-is.
  if (/^[a-zA-Z]:[\\/]/.test(job.filename) || job.filename.startsWith("/")) return job.filename;
  const base = job.filename.split(/[/\\]/).pop() || "";
  if (!base || !job.outputDir) return null;
  const sep = job.outputDir.includes("\\") ? "\\" : "/";
  return job.outputDir.replace(/[\\/]+$/, "") + sep + base;
}

/** Turn yt-dlp's raw stderr into a short, friendly line + whether a cookies.txt would fix it.
 *  Works for any site (YouTube, Instagram, Facebook, TikTok, X, …) — the patterns are generic. */
function humanizeError(raw: string | undefined): { message: string; needsCookies: boolean } {
  const r = (raw || "").trim();
  if (!r) return { message: "Download failed.", needsCookies: false };
  const has = (re: RegExp) => re.test(r);
  if (has(/sign in to confirm|not a bot|--cookies|login required|log ?in required|members?-only|private (video|account|content)|please log ?in|join this channel|requires.*(login|account)|rate.?limit/i))
    return { message: "This needs sign-in. Add a cookies.txt for this site, then retry.", needsCookies: true };
  if (has(/http error 401|http error 403|forbidden|unauthorized/i))
    return { message: "Access denied — a cookies.txt usually fixes this.", needsCookies: true };
  if (has(/age[- ]restricted|confirm your age|inappropriate/i))
    return { message: "Age-restricted — add a cookies.txt to download.", needsCookies: true };
  if (has(/video unavailable|been removed|deleted|no longer available|not available in your|geo|in your country/i))
    return { message: "Unavailable (removed, private, or region-blocked).", needsCookies: false };
  if (has(/requested format|format is not available|no video formats/i))
    return { message: "That quality/format isn't available — try another.", needsCookies: false };
  if (has(/unsupported url|not a valid url|unable to extract|no media found/i))
    return { message: "Unsupported or invalid link.", needsCookies: false };
  if (has(/ffmpeg|ffprobe/i))
    return { message: "FFmpeg is required for this format. Install ffmpeg and retry.", needsCookies: false };
  if (has(/unable to download (webpage|video)|timed out|timeout|connection|getaddrinfo|network|reset by peer|10054|temporary failure/i))
    return { message: "Network error — check your connection and retry.", needsCookies: false };
  // Fallback: strip the "ERROR:" prefix + "[extractor] id:" noise; keep the first line.
  let msg = r.split("\n")[0].replace(/^error:\s*/i, "").replace(/^\[[^\]]+\]\s*[\w-]*:\s*/i, "").trim();
  if (msg.length > 160) msg = msg.slice(0, 157) + "…";
  return { message: msg || "Download failed.", needsCookies: false };
}

/* ─── JobCard ────────────────────────────────────────────────────────────────── */
// memo'd: with 1000+ cards on screen, a progress tick on one download must not
// re-render every card. Stays cheap as long as its props (job + handlers) are stable.
const JobCard = memo(function JobCard({ job, onCancel, onRemove, onOpen, onReveal, onRetry, onAddCookies, hasCookies }: {
  job: DownloadJob;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onOpen:   (job: DownloadJob) => void;
  onReveal: (job: DownloadJob) => void;
  onRetry:  (id: string) => void;
  onAddCookies: () => void;
  hasCookies: boolean;
}) {
  const basename = job.filename.split(/[/\\]/).pop()?.replace(/\.[a-z0-9]+$/i, "") || "";
  // Prefer the real title, then the (extension-stripped) downloaded filename, then a tidy URL.
  const displayName = job.title || basename || readableUrl(job.url);
  const platform = detectPlatform(job.url);
  // Running but no bytes yet (connecting / resolving formats) — show "Preparing…"
  // with a pulsing bar so a 0% download never reads as frozen.
  const preparing = job.status === "running" && job.percent === 0 && !job.speed;
  const err = job.status === "error" ? humanizeError(job.error) : null;
  // Cookies set but still an auth error → they're likely expired; nudge an update.
  const errMsg = err && err.needsCookies && hasCookies
    ? "Sign-in failed — your cookies.txt may have expired. Update it and retry."
    : err?.message;

  return (
    // content-visibility:auto lets the webview skip layout/paint for off-screen
    // cards, so a queue of 1000+ stays smooth without a virtualization lib.
    // contain-intrinsic-size reserves an estimated height to keep the scrollbar stable.
    <div
      className="bg-white dark:bg-white/[0.035] border border-black/[0.06] dark:border-white/[0.07] rounded-2xl px-4 py-3.5 shadow-sm"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 78px" }}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {job.status === "queued"    && <Clock        size={15} className="text-zinc-400" />}
          {job.status === "running"   && <Loader2      size={15} className="text-violet-500 animate-spin" />}
          {job.status === "done"      && <CheckCircle2 size={15} className="text-green-500" />}
          {job.status === "error"     && <AlertCircle  size={15} className="text-red-500" />}
          {job.status === "cancelled" && <StopCircle   size={15} className="text-zinc-400" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-200 truncate flex items-center gap-1.5 min-w-0">
              {platform && (
                <platform.Icon size={12} className="shrink-0" style={{ color: platform.color === "#000000" ? undefined : platform.color }} />
              )}
              <span className="truncate">{displayName}</span>
            </p>
            <div className="flex items-center gap-1.5 shrink-0">
              {job.totalItems > 1 && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 tabular-nums">
                  {job.currentItem}/{job.totalItems}
                </span>
              )}
              {job.status === "queued" && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-zinc-400/15 text-zinc-500 dark:text-zinc-400">
                  Queued
                </span>
              )}
            </div>
          </div>

          {/* Always show which link this card is for, so a title never hides the source. */}
          {(job.title || basename) && (
            <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 truncate mb-1">{readableUrl(job.url)}</p>
          )}

          {job.status === "queued" && (
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">Waiting for a free slot…</p>
          )}

          {job.status === "running" && (
            <>
              <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden mb-1.5">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${preparing ? "w-1/3 animate-pulse" : ""}`}
                  style={{
                    ...(preparing ? {} : { width: `${job.percent}%` }),
                    background: "var(--brand-gradient)",
                  }}
                />
              </div>
              <div className="flex items-center gap-3 text-[10.5px] text-zinc-400">
                <span className="tabular-nums">{preparing ? "Preparing…" : `${job.percent.toFixed(1)}%`}</span>
                {job.speed && job.speed !== "merging…" && (
                  <span className="flex items-center gap-1">
                    <Zap size={9} />
                    {job.speed}
                  </span>
                )}
                {job.speed === "merging…" && <span>Merging…</span>}
                {job.eta && job.eta !== "Unknown" && (
                  <span className="flex items-center gap-1">
                    <Clock size={9} />
                    ETA {job.eta}
                  </span>
                )}
              </div>
            </>
          )}

          {job.status === "done" && (
            <p className="text-[11px] text-green-600/70 dark:text-green-500/60 truncate">
              Saved → {job.outputDir}
            </p>
          )}

          {job.status === "error" && err && (
            <>
              <p className="text-[11px] text-red-500/90 line-clamp-2" title={job.error}>{errMsg}</p>
              <div className="flex items-center gap-1.5 mt-1.5">
                {err.needsCookies && (
                  <button onClick={onAddCookies} title="Pick a cookies.txt and retry"
                    className="flex items-center gap-1 h-6 px-2.5 rounded-md text-[10.5px] font-semibold text-white border-none cursor-pointer hover:opacity-90"
                    style={{ background: "var(--brand-gradient)" }}>
                    <KeyRound size={11} /> {hasCookies ? "Update cookies.txt" : "Add cookies.txt"}
                  </button>
                )}
                <button onClick={() => onRetry(job.id)} title="Retry this download"
                  className="flex items-center gap-1 h-6 px-2.5 rounded-md text-[10.5px] font-semibold text-violet-600 dark:text-violet-400 border border-violet-500/30 bg-violet-500/5 hover:bg-violet-500/10 cursor-pointer transition-colors">
                  <RefreshCw size={11} /> Retry
                </button>
              </div>
            </>
          )}

          {job.status === "cancelled" && (
            <div className="flex items-center gap-2">
              <p className="text-[11px] text-zinc-400">Cancelled</p>
              <button onClick={() => onRetry(job.id)}
                className="flex items-center gap-1 text-[10.5px] font-semibold text-violet-500 hover:text-violet-400 border-none bg-transparent cursor-pointer">
                <RefreshCw size={10} /> Retry
              </button>
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-1">
          {(job.status === "running" || job.status === "queued") && (
            <button
              onClick={() => onCancel(job.id)}
              title={job.status === "queued" ? "Remove from queue" : "Cancel"}
              className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-500/8 transition-colors border-none bg-transparent cursor-pointer"
            >
              <X size={13} />
            </button>
          )}
          {job.status === "done" && (
            <>
              <button
                onClick={() => onOpen(job)}
                title="Open file"
                className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-violet-500 hover:bg-violet-500/8 transition-colors border-none bg-transparent cursor-pointer"
              >
                <ExternalLink size={13} />
              </button>
              <button
                onClick={() => onReveal(job)}
                title="Show in folder"
                className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-violet-500 hover:bg-violet-500/8 transition-colors border-none bg-transparent cursor-pointer"
              >
                <FolderOpen size={13} />
              </button>
            </>
          )}
          {job.status !== "running" && (
            <button
              onClick={() => onRemove(job.id)}
              title="Dismiss"
              className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/8 transition-colors border-none bg-transparent cursor-pointer"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

/* ─── Page ───────────────────────────────────────────────────────────────────── */
export default function VideoDownloaderPage() {
  const [ytdlpVersion, setYtdlpVersion] = useState<string | null>(null);
  const [ytdlpMissing, setYtdlpMissing] = useState(false);
  const [ytdlpInstalling, setYtdlpInstalling] = useState(false);

  /** yt-dlp (or the FFmpeg it merges with) is missing → download both, then re-check. */
  const installYtdlp = useCallback(async () => {
    setYtdlpInstalling(true);
    try {
      const { ensureToolDeps } = await import("@/lib/deps-local");
      await ensureToolDeps(["ytdlp", "ffmpeg"]);
      const { invoke } = await import("@tauri-apps/api/core");
      setYtdlpVersion(await invoke<string>("ytdlp_check"));
      setYtdlpMissing(false);
    } catch (e) {
      logWarn("video-downloader", "yt-dlp install failed", e);
      setYtdlpMissing(true);
    } finally {
      setYtdlpInstalling(false);
    }
  }, []);
  // `isTauri` is only knowable on the client, so the SSR markup and the first client
  // render must NOT branch on it (that causes a hydration mismatch). Gate any
  // Tauri-dependent UI on `mounted`, which flips true only after hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    try { const saved = localStorage.getItem(COOKIES_KEY); if (saved) setCookiesPath(saved); } catch (e) { logDebug("video-downloader", "Could not read cookies path from localStorage", e); }
  }, []);

  const [urlInput,      setUrlInput]      = useState("");
  const [outputDir,     setOutputDir]     = useState("");
  const [quality,       setQuality]       = useState<Quality>("1080p HD");
  const [format,        setFormat]        = useState<Format>("MP4");
  const [playlistRange, setPlaylistRange] = useState("");
  // Path to a user-selected cookies.txt (site sign-in), persisted across sessions.
  const [cookiesPath,   setCookiesPath]   = useState("");
  const [cookiesOpen,   setCookiesOpen]   = useState(false);
  // Clip-a-section: download only part of a long video.
  const [clipEnabled,   setClipEnabled]   = useState(false);
  const [clipStart,     setClipStart]     = useState("");
  const [clipEnd,       setClipEnd]       = useState("");
  const [infoDuration,  setInfoDuration]  = useState<number | null>(null);
  const [fetchingInfo,  setFetchingInfo]  = useState(false);
  const [infoError,     setInfoError]     = useState<string | null>(null);
  const [jobs,          setJobs]          = useState<DownloadJob[]>([]);
  // Ids already handed to the backend — prevents the scheduler from launching one twice.
  const startedRef = useRef<Set<string>>(new Set());
  // Live mirror of `jobs` so stable (useCallback) handlers can read current state
  // without being re-created on every progress tick (which would defeat JobCard's memo).
  const jobsRef = useRef<DownloadJob[]>(jobs);
  jobsRef.current = jobs;
  // Same idea for the cookies path, so stable handlers (retry) always use the latest file.
  const cookiesPathRef = useRef<string>(cookiesPath);
  cookiesPathRef.current = cookiesPath;

  // Downloads land in the OS Downloads folder automatically (no folder field).
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      try {
        const { downloadDir } = await import("@tauri-apps/api/path");
        setOutputDir(await downloadDir());
      } catch (e) {
        logDebug("video-downloader", "Could not read downloads dir", e);
      }
    })();
  }, []);

  // Check yt-dlp + wire event listeners
  useEffect(() => {
    if (!isTauri) return;

    let cleanup: Array<() => void> = [];

    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen }  = await import("@tauri-apps/api/event");

      invoke<string>("ytdlp_check")
        .then(v => setYtdlpVersion(v))
        .catch(() => void installYtdlp());

      const u1 = await listen<ProgressPayload>("ytdlp_progress", ({ payload: p }) => {
        setJobs(prev => prev.map(j => j.id !== p.id ? j : {
          ...j,
          status:      "running",
          percent:     p.percent,
          speed:       p.speed,
          eta:         p.eta,
          filename:    p.filename || j.filename,
          currentItem: p.current_item,
          totalItems:  p.total_items,
        }));
      });

      const u2 = await listen<CompletePayload>("ytdlp_complete", ({ payload: p }) => {
        setJobs(prev => prev.map(j => j.id !== p.id ? j : {
          ...j,
          status:  "done",
          percent: 100,
        }));
      });

      const u3 = await listen<ErrorPayload>("ytdlp_error", ({ payload: p }) => {
        setJobs(prev => prev.map(j => j.id !== p.id ? j : {
          ...j,
          status: p.message === "Cancelled" ? "cancelled" : "error",
          error:  p.message,
        }));
      });

      cleanup = [u1, u2, u3];
    })();

    return () => cleanup.forEach(fn => fn());
  }, [installYtdlp]);

  // Derived once per input change (not on every progress-tick re-render) — splitting
  // a 1000-line paste each tick was a needless cost while downloads were running.
  const urls          = useMemo(() => urlInput.split("\n").map(u => u.trim()).filter(Boolean), [urlInput]);
  const hasPlaylist   = useMemo(() => urls.some(isPlaylistUrl), [urls]);
  const firstPlatform = useMemo(() => (urls.length > 0 ? detectPlatform(urls[0]) : null), [urls]);

  const isAudio      = format === "MP3" || format === "M4A";
  const effectiveQuality: Quality = isAudio ? "Audio only" : quality;
  const formatCode   = QUALITY_CODE[effectiveQuality];
  const mergeFormat  = FORMAT_MERGE[format];

  const runningCount = jobs.filter(j => j.status === "running").length;
  const queuedCount  = jobs.filter(j => j.status === "queued").length;
  const doneJobs     = jobs.filter(j => j.status === "done");
  const errorCount   = jobs.filter(j => j.status === "error").length;
  // Any failure that a cookies.txt would fix → drives the top "needs sign-in" banner.
  const needsSignIn  = useMemo(() => jobs.some(j => j.status === "error" && humanizeError(j.error).needsCookies), [jobs]);
  const canDownload  = isTauri && !ytdlpMissing && !ytdlpInstalling && urls.length > 0 && outputDir.trim().length > 0;

  // Let the user pick / clear a cookies.txt for site sign-in (persisted, all platforms).
  // useCallback so JobCard's "Add cookies.txt" prop stays stable (keeps memo effective).
  const pickCookies = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const file = await open({
        multiple: false,
        title: "Select your cookies.txt",
        filters: [{ name: "Cookies", extensions: ["txt"] }],
      });
      if (typeof file === "string") {
        setCookiesPath(file);
        try { localStorage.setItem(COOKIES_KEY, file); } catch (e) { logDebug("video-downloader", "Could not persist cookies path", e); }
      }
    } catch (e) { logDebug("video-downloader", "Cookies dialog unavailable or cancelled", e); }
  }, []);
  function clearCookies() {
    setCookiesPath("");
    try { localStorage.removeItem(COOKIES_KEY); } catch (e) { logDebug("video-downloader", "Could not clear cookies path from localStorage", e); }
  }

  // Requeue one failed/cancelled job (with the latest cookies file).
  const handleRetry = useCallback((id: string) => {
    startedRef.current.delete(id); // let the scheduler pick it up again
    setJobs(prev => prev.map(j => j.id !== id ? j : {
      ...j, status: "queued", percent: 0, speed: "", eta: "", error: undefined,
      currentItem: 1, totalItems: 1, cookiesPath: cookiesPathRef.current,
    }));
  }, []);

  // Requeue every failed job at once (after adding cookies, say).
  const handleRetryAll = useCallback(() => {
    jobsRef.current.forEach(j => { if (j.status === "error") startedRef.current.delete(j.id); });
    setJobs(prev => prev.map(j => j.status !== "error" ? j : {
      ...j, status: "queued", percent: 0, speed: "", eta: "", error: undefined,
      currentItem: 1, totalItems: 1, cookiesPath: cookiesPathRef.current,
    }));
  }, []);

  // Fetch a video's title up front so queued items show something meaningful (best-effort).
  async function fetchTitle(id: string, url: string) {
    if (!isTauri) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke<string>("ytdlp_fetch_info", { url, cookiesPath: cookiesPath || undefined });
      const meta = JSON.parse(raw) as { title?: string; uploader?: string; channel?: string };
      setJobs(prev => prev.map(j => j.id !== id ? j : {
        ...j,
        title:    meta.title    || j.title,
        uploader: meta.uploader || meta.channel || j.uploader,
      }));
    } catch (e) {
      logDebug("video-downloader", "Could not prefetch title", e);
    }
  }

  // Fetch the first URL's length up front so the user can pick a clip range.
  async function fetchInfo() {
    if (fetchingInfo) return;
    setInfoError(null);
    if (!isTauri) { setInfoError(`Length fetching needs the ${brand.name} desktop app.`); return; }
    if (ytdlpMissing || ytdlpInstalling) { setInfoError("yt-dlp isn't ready yet — wait for the download to finish."); return; }
    if (urls.length === 0) { setInfoError("Paste a video link first."); return; }
    setFetchingInfo(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke<string>("ytdlp_fetch_info", { url: urls[0], cookiesPath: cookiesPath || undefined });
      const meta = JSON.parse(raw) as { duration?: number };
      if (typeof meta.duration === "number" && meta.duration > 0) {
        setInfoDuration(meta.duration);
      } else {
        setInfoError("Couldn't read this video's length (it may be a live stream).");
      }
    } catch (err) {
      setInfoError(typeof err === "string" ? err.split("\n")[0] : "Failed to fetch — check the link.");
    } finally {
      setFetchingInfo(false);
    }
  }

  // Hand a single queued job to the backend.
  async function launchJob(job: DownloadJob) {
    setJobs(prev => prev.map(j => j.id !== job.id ? j : { ...j, status: "running" }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const extra: string[] = [];
      if (job.isPlaylist && job.playlistRange) extra.push("--playlist-items", job.playlistRange);
      if (job.downloadSection) {
        extra.push("--download-sections", job.downloadSection);
        // Keyframe cuts keep video clips frame-accurate; not needed for audio extraction.
        const isAudioJob = ["mp3", "m4a", "aac"].includes(job.mergeFormat);
        if (!isAudioJob) extra.push("--force-keyframes-at-cuts");
      }
      await invoke("ytdlp_start", {
        id:        job.id,
        urls:      [job.url],
        outputDir: job.outputDir,
        formatCode:  job.formatCode,
        mergeFormat: job.mergeFormat,
        extraArgs:   extra,
        cookiesPath: job.cookiesPath || undefined,
      });
    } catch (err) {
      setJobs(prev => prev.map(j => j.id !== job.id ? j : { ...j, status: "error", error: String(err) }));
    }
  }

  // Scheduler: keep up to MAX_CONCURRENT downloads running; start the next queued job as slots free up.
  useEffect(() => {
    if (!isTauri) return;
    if (runningCount >= MAX_CONCURRENT) return;
    const next = jobs.find(j => j.status === "queued" && !startedRef.current.has(j.id));
    if (!next) return;
    startedRef.current.add(next.id);
    void launchJob(next);
  }, [jobs, runningCount]);

  // Open a finished download in the OS default player.
  const handleOpenFile = useCallback(async (job: DownloadJob) => {
    if (!isTauri) return;
    const path = jobFilePath(job);
    const { invoke } = await import("@tauri-apps/api/core");
    if (path) await invoke("open_file", { path }).catch((e: unknown) => { logWarn("video-downloader", "open_file failed, falling back to output dir", e); return invoke("open_file", { path: job.outputDir }); });
    else      await invoke("open_file", { path: job.outputDir }).catch((e: unknown) => logWarn("video-downloader", "open_file (output dir) failed", e));
  }, []);

  // Reveal a finished download in the OS file manager (falls back to its folder).
  const handleReveal = useCallback(async (job: DownloadJob) => {
    if (!isTauri) return;
    const path = jobFilePath(job);
    const { invoke } = await import("@tauri-apps/api/core");
    if (path) await invoke("reveal_in_folder", { path }).catch((e: unknown) => { logWarn("video-downloader", "reveal_in_folder failed, falling back to output dir", e); return invoke("open_file", { path: job.outputDir }); });
    else      await invoke("open_file", { path: job.outputDir }).catch((e: unknown) => logWarn("video-downloader", "open_file (output dir) failed", e));
  }, []);

  // Open the Downloads folder where files were saved.
  async function handleOpenFolder() {
    if (!isTauri) return;
    const dir = doneJobs[0]?.outputDir || outputDir;
    if (!dir) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_file", { path: dir }).catch((e: unknown) => logWarn("video-downloader", "open_file (folder) failed", e));
  }

  // Bulk "Save all": copy every finished file into a folder the user picks now.
  async function handleSaveAll() {
    if (!isTauri || doneJobs.length === 0) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dest = await open({ directory: true, multiple: false, title: "Save all downloads to…" });
      if (typeof dest !== "string") return;
      const files = doneJobs.map(jobFilePath).filter((p): p is string => !!p);
      if (files.length === 0) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("copy_files", { files, destDir: dest });
      await invoke("open_file", { path: dest }).catch((e: unknown) => logWarn("video-downloader", "open_file (save-all dest) failed", e));
    } catch (e) {
      logError("video-downloader", "Save all failed", e);
    }
  }

  // One pasted line → one queued job. The scheduler starts them MAX_CONCURRENT at a time.
  // Picking a destination folder (native dialog — no browser permission prompt) is
  // the gesture that starts the batch; cancelling the picker cancels the download.
  async function handleDownload() {
    if (!canDownload) return;

    // Ask where to save first; everything downloads into the chosen folder.
    let dir = outputDir.trim();
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dest = await open({
        directory: true,
        multiple: false,
        title: "Save downloads to…",
        defaultPath: dir || undefined,
      });
      if (typeof dest !== "string") return; // user cancelled the picker
      dir = dest;
      setOutputDir(dest);                    // remember it for the footer / next run
    } catch (e) {
      logDebug("video-downloader", "Folder picker unavailable or cancelled", e);
    }

    const range = playlistRange.trim();
    // Build the yt-dlp --download-sections spec: *START-END (blank start → 0, blank end → inf).
    const section = clipEnabled && (clipStart.trim() || clipEnd.trim())
      ? `*${clipStart.trim() || "0"}-${clipEnd.trim() || "inf"}`
      : "";

    const newJobs: DownloadJob[] = urls.map(rawUrl => {
      // Rewrite watch?v=…&list=… → playlist?list=… so the FULL playlist downloads,
      // not just the ~100 items YouTube exposes on the watch page.
      const url = normalizePlaylistUrl(rawUrl);
      const playlist = isPlaylistUrl(url);
      return {
        id:           uid(),
        url,
        title:        "",
        uploader:     "",
        isPlaylist:   playlist,
        playlistRange: playlist ? range : "",
        formatCode,
        mergeFormat,
        downloadSection: section,
        cookiesPath,
        outputDir:    dir,
        status:       "queued",
        percent:      0,
        speed:        "",
        eta:          "",
        filename:     "",
        currentItem:  1,
        totalItems:   1,
      };
    });

    setJobs(prev => [...newJobs, ...prev]);
    setUrlInput("");
    setPlaylistRange("");
    setInfoDuration(null);

    // Resolve titles in the background so cards are readable while they wait — but
    // bounded: each look-up spawns a yt-dlp process, so a 1000-link paste must not
    // fire 1000 at once. Pre-fetch only the first MAX_TITLE_PREFETCH, a few at a
    // time; the rest get their title from the download's own output as they run.
    const titleTargets = newJobs.filter(j => !j.isPlaylist).slice(0, MAX_TITLE_PREFETCH);
    void runPool(titleTargets, TITLE_FETCH_CONCURRENCY, j => fetchTitle(j.id, j.url));
  }

  const handleCancel = useCallback(async (id: string) => {
    if (!isTauri) return;
    const job = jobsRef.current.find(j => j.id === id);
    // A queued job has no running process yet — just drop it from the queue.
    if (job && job.status === "queued") {
      startedRef.current.add(id); // belt-and-suspenders: never let the scheduler pick it up
      setJobs(prev => prev.map(j => j.id !== id ? j : { ...j, status: "cancelled" }));
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ytdlp_cancel", { id }).catch((e: unknown) => logWarn("video-downloader", "ytdlp_cancel failed", e));
  }, []);

  const handleRemove = useCallback((id: string) => {
    setJobs(prev => prev.filter(j => j.id !== id));
  }, []);

  // Warn before navigating away while downloads are running/queued; "Leave & stop"
  // cancels each active job (ytdlp_cancel via handleCancel) so nothing is orphaned.
  useRegisterTask(runningCount > 0 || queuedCount > 0, {
    label: "Video Downloader",
    kind: "tools",
    onAbort: () => {
      for (const j of jobsRef.current) {
        if (j.status === "running" || j.status === "queued") void handleCancel(j.id);
      }
    },
  });

  const downloadLabel = urls.length > 1
    ? `Add ${urls.length} to queue`
    : `Download ${format}`;

  const videoFormats: Format[]   = ["MP4", "WebM", "MKV"];
  const audioFormats: Format[]   = ["MP3", "M4A"];
  const videoQualities: Quality[] = QUALITIES.filter(q => q !== "Audio only");

  return (
    <AppLayout>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        {/* No actions strip — the yt-dlp version badge lives in the Downloads
            toolbar (right panel) instead. StudioToolHeader renders nothing here. */}
        <StudioToolHeader
          icon={Download}
          title="Video Downloader"
          accent="#0057FC"
          backHref="/tools"
          backLabel="Tools"
          description="Download from YouTube, TikTok, Instagram, Twitter/X and 50+ platforms."
        />

        <div className="flex flex-1 min-h-0">
          {/* ── LEFT — controls ── */}
          {/* Glassy/translucent so the app's ambient background shows through —
              seamless with the (transparent) downloads panel on the right. */}
          <div className="w-[380px] shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-panel overflow-hidden">
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

              {/* Source */}
              <div>
                <SectionTitle>Source</SectionTitle>
                <div className="relative rounded-xl bg-zinc-50 dark:bg-white/[0.04] border border-zinc-200 dark:border-white/10 focus-within:border-violet-500/40 transition-colors px-3 py-2.5">
                  <textarea
                    value={urlInput}
                    onChange={e => { setUrlInput(e.target.value); setInfoDuration(null); setInfoError(null); }}
                    placeholder={"Paste video links…\none per line for bulk"}
                    rows={4}
                    className="w-full bg-transparent border-none outline-none text-[13px] text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400 font-[inherit] resize-none leading-relaxed"
                  />
                  {urlInput && (
                    <button onClick={() => setUrlInput("")} title="Clear"
                      className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded-md text-zinc-300 dark:text-zinc-600 hover:text-zinc-500 hover:bg-black/5 dark:hover:bg-white/5 border-none bg-transparent cursor-pointer">
                      <X size={13} />
                    </button>
                  )}
                </div>
                {(firstPlatform || urls.length > 1) && (
                  <div className="flex items-center gap-2 mt-2 px-0.5">
                    {firstPlatform && (
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                        <firstPlatform.Icon size={12} style={{ color: firstPlatform.color === "#000000" ? undefined : firstPlatform.color }} />
                        {firstPlatform.name}
                      </span>
                    )}
                    {urls.length > 1 && (
                      <span className="ml-auto text-[11px] font-medium text-violet-600 dark:text-violet-400">{urls.length} links · {urls.length} downloads</span>
                    )}
                  </div>
                )}
                {hasPlaylist && (
                  <div className="flex items-center gap-2 mt-2 px-3 py-2.5 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/[0.04]">
                    <ListVideo size={13} className="text-violet-500 shrink-0" />
                    <input
                      value={playlistRange}
                      onChange={e => setPlaylistRange(e.target.value)}
                      placeholder="Playlist range — e.g. 1-10 (optional)"
                      className="flex-1 bg-transparent border-none outline-none text-[12.5px] text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400 font-[inherit]"
                    />
                  </div>
                )}
              </div>

              {/* Format */}
              <div>
                <SectionTitle>Format</SectionTitle>

                {/* Video / Audio segmented */}
                <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-zinc-100 dark:bg-white/[0.06] mb-3">
                  <button type="button"
                    onClick={() => { setFormat("MP4"); if (quality === "Audio only") setQuality("1080p HD"); }}
                    className={`flex items-center justify-center gap-1.5 h-9 rounded-lg text-[12.5px] font-semibold transition-all cursor-pointer border-none ${
                      !isAudio ? "bg-white dark:bg-white/[0.12] text-violet-600 dark:text-violet-400 shadow-sm" : "bg-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                    }`}>
                    <Video size={14} /> Video
                  </button>
                  <button type="button"
                    onClick={() => setFormat("MP3")}
                    className={`flex items-center justify-center gap-1.5 h-9 rounded-lg text-[12.5px] font-semibold transition-all cursor-pointer border-none ${
                      isAudio ? "bg-white dark:bg-white/[0.12] text-violet-600 dark:text-violet-400 shadow-sm" : "bg-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                    }`}>
                    <Music size={14} /> Audio
                  </button>
                </div>

                {/* Quality (video only) */}
                {!isAudio && (
                  <>
                    <FieldLabel>Quality</FieldLabel>
                    <div className="grid grid-cols-2 gap-1.5 mb-3">
                      {videoQualities.map(q => {
                        const active = quality === q;
                        return (
                          <button key={q} onClick={() => setQuality(q)}
                            className={`h-9 rounded-lg text-[12px] font-semibold cursor-pointer border transition-all ${
                              active ? "bg-violet-500/10 border-violet-500/40 text-violet-600 dark:text-violet-400"
                                : "bg-zinc-50 dark:bg-white/[0.04] text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/15"
                            }`}>
                            {q}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}

                {/* Container type */}
                <FieldLabel>File type</FieldLabel>
                <div className="flex gap-1.5">
                  {(isAudio ? audioFormats : videoFormats).map(f => {
                    const active = format === f;
                    return (
                      <button key={f} onClick={() => setFormat(f)}
                        className={`flex-1 h-9 rounded-lg text-[12px] font-semibold cursor-pointer border transition-all ${
                          active ? "bg-violet-500/10 border-violet-500/40 text-violet-600 dark:text-violet-400"
                            : "bg-zinc-50 dark:bg-white/[0.04] text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/15"
                        }`}>
                        {f}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Clip section — download only part of a long video */}
              <div>
                <SectionTitle>Clip Section</SectionTitle>
                <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300">Download only a section</p>
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-snug">Grab a clip from a long video instead of the whole file.</p>
                  </div>
                  <ToggleSwitch checked={clipEnabled} onChange={setClipEnabled} />
                </div>

                {clipEnabled && (
                  <div className="mt-3 space-y-3">
                    {/* Visual scrubber — appears once the length is known */}
                    {infoDuration != null && infoDuration > 0 ? (
                      <div className="px-3 py-3 rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/3">
                        <ClipRangeSlider
                          duration={infoDuration}
                          startSec={parseTime(clipStart) ?? 0}
                          endSec={parseTime(clipEnd) ?? infoDuration}
                          onChange={(st, en) => { setClipStart(fmtClock(st)); setClipEnd(fmtClock(en)); }}
                        />
                      </div>
                    ) : (
                      <button onClick={fetchInfo} disabled={fetchingInfo}
                        className="w-full flex items-center justify-center gap-1.5 h-9 rounded-lg text-[12px] font-semibold cursor-pointer border transition-all disabled:opacity-40 disabled:cursor-not-allowed border-violet-500/30 bg-violet-500/5 text-violet-600 dark:text-violet-400 hover:border-violet-500/50 hover:bg-violet-500/10">
                        {fetchingInfo ? <Loader2 size={13} className="animate-spin" /> : <Clock size={13} />}
                        {fetchingInfo ? "Fetching length…" : "Fetch length to scrub"}
                      </button>
                    )}

                    {infoError && (
                      <p className="flex items-start gap-1.5 text-[10.5px] text-amber-600 dark:text-amber-400 leading-snug">
                        <AlertCircle size={12} className="shrink-0 mt-px" /> {infoError}
                      </p>
                    )}

                    {/* Precise inputs */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <FieldLabel>Start</FieldLabel>
                        <input value={clipStart} onChange={e => setClipStart(e.target.value)} placeholder="0:00"
                          className="w-full h-9 px-3 rounded-lg text-[13px] tabular-nums outline-none bg-white dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/10 transition-all" />
                      </div>
                      <div>
                        <FieldLabel>End</FieldLabel>
                        <input value={clipEnd} onChange={e => setClipEnd(e.target.value)} placeholder={infoDuration != null ? fmtClock(infoDuration) : "end"}
                          className="w-full h-9 px-3 rounded-lg text-[13px] tabular-nums outline-none bg-white dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/10 transition-all" />
                      </div>
                    </div>

                    {infoDuration != null && infoDuration > 0 ? (
                      <button onClick={fetchInfo} disabled={fetchingInfo}
                        className="text-[10.5px] text-zinc-400 dark:text-zinc-500 hover:text-violet-500 bg-transparent border-none cursor-pointer transition-colors disabled:opacity-50">
                        {fetchingInfo ? "Refreshing…" : `Full length ${fmtClock(infoDuration)} · re-fetch`}
                      </button>
                    ) : (
                      <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-snug">
                        Drag the handles after fetching, or type <b>mm:ss</b> / <b>hh:mm:ss</b> — e.g. <span className="font-mono">1:30</span>–<span className="font-mono">3:30</span> grabs 2 min.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Bottom bar */}
            <div className="px-5 py-4 border-t border-zinc-100 dark:border-white/8 shrink-0 space-y-2.5">
              <button
                onClick={handleDownload}
                disabled={!canDownload}
                className="w-full h-10 flex items-center justify-center gap-2 rounded-xl text-[13px] font-bold text-white border-none cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 active:scale-[0.99]"
                style={{ background: "var(--brand-gradient)" }}
              >
                <Download size={15} />
                {downloadLabel}
              </button>
            </div>
          </div>

          {/* ── RIGHT — activity ── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] shrink-0 gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <Download size={13} className="text-violet-500" />
                <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300 shrink-0">
                  Downloads{jobs.length > 0 ? ` · ${jobs.length}` : ""}
                </span>
                {queuedCount > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 tabular-nums">{queuedCount} queued</span>
                )}
                {runningCount > 0 && (
                  <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 tabular-nums">
                    <Loader2 size={9} className="animate-spin" /> {runningCount}
                  </span>
                )}
                {doneJobs.length > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 tabular-nums">{doneJobs.length} done</span>
                )}
                {errorCount > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/10 text-red-500 tabular-nums">{errorCount} failed</span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {doneJobs.length > 0 && (
                  <>
                    <button onClick={handleOpenFolder} className="flex items-center gap-1 text-[10.5px] text-zinc-400 hover:text-violet-500 border-none bg-transparent cursor-pointer transition-colors">
                      <FolderOpen size={12} /> Open folder
                    </button>
                    <button onClick={handleSaveAll} className="flex items-center gap-1 text-[10.5px] font-semibold text-violet-600 dark:text-violet-400 hover:text-violet-500 border-none bg-transparent cursor-pointer transition-colors">
                      <FolderInput size={12} /> Save all ({doneJobs.length})
                    </button>
                  </>
                )}
                {errorCount > 0 && (
                  <button onClick={handleRetryAll} className="flex items-center gap-1 text-[10.5px] font-semibold text-violet-600 dark:text-violet-400 hover:text-violet-500 border-none bg-transparent cursor-pointer transition-colors">
                    <RefreshCw size={11} /> Retry failed ({errorCount})
                  </button>
                )}
                {jobs.some(j => j.status !== "running") && (
                  <button onClick={() => setJobs(prev => prev.filter(j => j.status === "running"))} className="text-[10.5px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 border-none bg-transparent cursor-pointer transition-colors">
                    Clear finished
                  </button>
                )}
                {mounted && isTauri && (
                  <button onClick={() => setCookiesOpen(true)} title="Sign-in / cookies for downloads"
                    className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${
                      cookiesPath
                        ? "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
                        : "bg-zinc-400/10 text-zinc-500 dark:text-zinc-400 border-zinc-400/20 hover:text-violet-500 hover:border-violet-500/30"
                    }`}>
                    <KeyRound size={11} /> {cookiesPath ? "Cookies on" : "Sign in"}
                  </button>
                )}
                {ytdlpVersion && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
                    yt-dlp {ytdlpVersion}
                  </span>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">

              {/* Banners */}
              {mounted && !isTauri && (
                <div className="flex items-start gap-3 px-4 py-3 rounded-2xl bg-violet-500/[0.07] border border-violet-500/20">
                  <TerminalSquare size={16} className="text-violet-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[13px] font-semibold text-violet-700 dark:text-violet-400">Desktop app required</p>
                    <p className="text-[11.5px] text-violet-600/70 dark:text-violet-500/60 mt-0.5">Run the {brand.name} desktop app to use the downloader.</p>
                  </div>
                </div>
              )}
              {ytdlpInstalling && (
                <div className="flex items-start gap-3 px-4 py-3 rounded-2xl bg-blue-500/[0.07] border border-blue-500/20">
                  <Loader2 size={16} className="text-blue-500 shrink-0 mt-0.5 animate-spin" />
                  <div>
                    <p className="text-[13px] font-semibold text-blue-700 dark:text-blue-400">Downloading yt-dlp…</p>
                    <p className="text-[11.5px] text-blue-600/70 dark:text-blue-400/60 mt-0.5">
                      The downloader engine is missing, so {brand.name} is fetching it now. This happens only once.
                    </p>
                  </div>
                </div>
              )}
              {ytdlpMissing && !ytdlpInstalling && (
                <div className="flex items-start gap-3 px-4 py-3 rounded-2xl bg-amber-500/[0.07] border border-amber-500/20">
                  <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-amber-700 dark:text-amber-400">Couldn&apos;t download yt-dlp</p>
                    <p className="text-[11.5px] text-amber-600/70 dark:text-amber-500/60 mt-0.5">
                      Check your internet connection and try again.
                    </p>
                  </div>
                  <button onClick={() => void installYtdlp()}
                    className="shrink-0 rounded-lg border border-amber-500/30 px-3 py-1.5 text-[12px] font-semibold text-amber-700 dark:text-amber-400 hover:bg-amber-500/10">
                    Retry
                  </button>
                </div>
              )}
              {needsSignIn && (
                <div className="flex items-start gap-3 px-4 py-3 rounded-2xl bg-amber-500/[0.08] border border-amber-500/25">
                  <KeyRound size={16} className="text-amber-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-amber-700 dark:text-amber-400">Some downloads need sign-in</p>
                    <p className="text-[11.5px] text-amber-600/80 dark:text-amber-500/70 mt-0.5">
                      The site is blocking anonymous downloads (&ldquo;confirm you&rsquo;re not a bot&rdquo;). {cookiesPath ? "Your cookies.txt may have expired — update it, then" : "Add a cookies.txt, then"} retry.
                    </p>
                  </div>
                  <button onClick={() => setCookiesOpen(true)}
                    className="shrink-0 self-center flex items-center gap-1 h-8 px-3 rounded-lg text-[11.5px] font-bold text-white border-none cursor-pointer hover:opacity-90"
                    style={{ background: "var(--brand-gradient)" }}>
                    <KeyRound size={12} /> {cookiesPath ? "Update" : "Add cookies"}
                  </button>
                </div>
              )}

              {/* Jobs / empty */}
              {jobs.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {jobs.map(job => (
                    <JobCard key={job.id} job={job} onCancel={handleCancel} onRemove={handleRemove} onOpen={handleOpenFile} onReveal={handleReveal}
                      onRetry={handleRetry} onAddCookies={pickCookies} hasCookies={cookiesPath.length > 0} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center text-center py-16">
                  <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 flex items-center justify-center mb-4">
                    <Download size={24} strokeWidth={1.4} className="text-zinc-400" />
                  </div>
                  <p className="text-[14px] font-semibold text-zinc-500 dark:text-zinc-400">No downloads yet</p>
                  <p className="text-[12px] text-zinc-400 dark:text-zinc-600 mt-1 max-w-[280px]">
                    Paste a link on the left, pick a format, and hit download. Finished files land in your Downloads folder.
                  </p>
                </div>
              )}

            </div>

            {/* Supported platforms — pinned footer */}
            <div className="shrink-0 border-t border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] px-5 py-2.5">
              <div className="flex items-center gap-2 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500 shrink-0 mr-0.5">Supported</span>
                {PLATFORMS.map(p => (
                  <span key={p.name}
                    className="flex items-center gap-1.5 h-7 px-3 rounded-full text-[11.5px] font-medium border border-black/[0.06] dark:border-white/[0.08] bg-white dark:bg-white/[0.04] text-zinc-600 dark:text-zinc-400 shrink-0">
                    <p.Icon size={13} className="shrink-0" style={{ color: p.color === "#000000" ? undefined : p.color }} />
                    {p.name}
                  </span>
                ))}
                <span className="flex items-center h-7 px-3 rounded-full text-[11.5px] font-medium border border-dashed border-zinc-300 dark:border-white/[0.10] text-zinc-400 dark:text-zinc-500 shrink-0">
                  +50 more
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Sign-in / cookies modal — opened from the toolbar chip */}
        {cookiesOpen && (
          <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setCookiesOpen(false)}>
            <div onClick={e => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 shadow-2xl p-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="flex items-center gap-2 text-[14px] font-bold text-zinc-800 dark:text-zinc-100">
                  <KeyRound size={15} className="text-violet-500" /> Sign-in / Cookies
                </h3>
                <button onClick={() => setCookiesOpen(false)} title="Close"
                  className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/8 border-none bg-transparent cursor-pointer">
                  <X size={15} />
                </button>
              </div>
              <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 leading-snug mb-3">
                Some sites block anonymous downloads or hide full playlists. Add a <b>cookies.txt</b> exported while signed in — used for every download.
              </p>
              {cookiesPath && (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-green-500/30 bg-green-500/[0.06] mb-2.5">
                  <CheckCircle2 size={13} className="text-green-500 shrink-0" />
                  <span className="flex-1 text-[11.5px] font-medium text-zinc-700 dark:text-zinc-200 truncate" title={cookiesPath}>
                    {cookiesPath.split(/[\\/]/).pop()}
                  </span>
                  <button onClick={clearCookies} title="Remove"
                    className="w-5 h-5 flex items-center justify-center rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-500/10 border-none bg-transparent cursor-pointer">
                    <X size={13} />
                  </button>
                </div>
              )}
              <button onClick={pickCookies}
                className="w-full h-10 flex items-center justify-center gap-1.5 rounded-xl text-[13px] font-bold text-white border-none cursor-pointer hover:opacity-90 transition-opacity"
                style={{ background: "var(--brand-gradient)" }}>
                <KeyRound size={14} /> {cookiesPath ? "Replace cookies.txt" : "Select cookies.txt"}
              </button>
              <button onClick={() => openExternal(COOKIES_EXTENSION_URL)}
                className="w-full mt-2 inline-flex items-center justify-center gap-1 text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:text-violet-500 border-none bg-transparent cursor-pointer transition-colors">
                <ExternalLink size={12} /> Get the one-click cookies.txt extension
              </button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
