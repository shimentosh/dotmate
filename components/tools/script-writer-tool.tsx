"use client";
import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  Sparkles, Wand2, Mic, ChevronDown, Settings2,
  Clock, Lock, Check, Type, Square, AlertCircle, Cpu, Zap,
  Loader2, TrendingUp, Plus, Copy, Download, Pencil, Eye,
  Bold, Italic, Code, Heading1, Heading2, List, ListOrdered,
  Gauge, Hash, AlignLeft, Anchor,
  type LucideIcon,
} from "lucide-react";
import { RangeSlider, MiniToggle } from "@/components/tools/studio-ui";
import { openSettings } from "@/lib/open-settings";
import { usePreference } from "@/lib/use-preference";
import { runLocalBrain, useLocalBrains, type LocalBrainOption } from "@/lib/brain/local-brains";
import { defaultBrainToApply } from "@/lib/brain/local-ai-config";
import { extractJson } from "@/lib/brain/cli-brain";
import { TTS_PREFILL_KEY } from "@/lib/handoff";
import { logDebug } from "@/lib/log";
import { saveBlobToDisk } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";
import { humanizeError } from "@/lib/error/app-error";

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const SCRIPT_TYPES = [
  "⊘ None","📚 Tutorial","📖 Story","📋 Listicle","🎯 Explainer",
  "⭐ Review","🎬 Documentary","💪 Motivational","👻 Scary Stories",
  "🌙 Bedtime Stories","📜 Interesting History","🤓 Fun Facts",
  "😂 Long Form Jokes","💡 Life Pro Tips","🤔 Philosophy",
  "📣 Product Marketing","🔍 True Crime","🕵️ Mystery & Thriller",
  "🔬 Science & Tech","👁️ Conspiracy Theories","✨ Self Improvement",
  "💰 Wealth & Success","🏙️ Urban Legends","👽 Paranormal",
  "⚕️ Medical Mysteries","🚀 Space & Astronomy","🧠 Psychology Facts",
  "🏕️ Survival Stories","🏛️ Ancient Civilizations","❓ Unsolved Mysteries",
  "🐻 Nature & Wildlife","💼 Business Stories","💕 Relationship Advice",
  "🌟 Inspirational",
];
const POVS           = ["First Person","Second Person","Third Person","None"];
const TONES          = ["Informative","Casual","Professional","Persuasive","Motivational","Inspirational"];
const HOOK_TYPES     = ["Question Hook","Shock Hook","Story Hook","Fact Hook","Promise Hook"];
const HOOK_LENGTHS   = ["1 sentence","2–3 sentences","4–5 sentences"];
const INTRO_STYLES   = ["Personal Story","Bold Statement","Question","Statistic","Quote"];
const INTRO_LENGTHS  = ["1–2 sentences","3–4 sentences","1 paragraph"];
const ENDING_STYLES  = ["Summary & Recap","Call to Action","Cliffhanger","Inspirational Quote","Open Challenge"];
const ENDING_CTAS    = ["Subscribe","Comment Below","Share This","Follow for More","Visit the Link","None"];
const ENDING_LENGTHS = ["1–2 sentences","3–4 sentences","1 paragraph"];
const STRUCTURES     = ["Hook","Intro","Main","Ending"];
const PRESETS        = [{ label: "500", value: 500 },{ label: "1K", value: 1000 },{ label: "5K", value: 5000 },{ label: "10K", value: 10000 },{ label: "50K", value: 50000 }];

const DURATIONS = [
  "Short · 15s","Short · 30s","Short · 45s","Short · 1 min",
  "Medium · 2 min","Medium · 3 min","Medium · 4 min","Medium · 5 min",
  "Long · 7 min","Long · 10 min","Long · 12 min","Long · 15 min",
  "Extended · 18 min","Extended · 22 min","Extended · 28 min","Extended · 32 min",
];

// Words above this threshold → agentic multi-section generation
const AGENTIC_THRESHOLD = 1200;
const WPM = 150;

const PLATFORMS = [
  {
    id: "general" as const,
    label: "General",
    emoji: "✦",
    systemPrompt:
      "You are a professional faceless video script writer creating engaging, clear, and compelling content.",
  },
  {
    id: "tiktok" as const,
    label: "TikTok",
    emoji: "🎵",
    systemPrompt: `You are an expert TikTok/Reels viral script writer. Apply these rules without exception:
HOOK: The FIRST 3 seconds must grab attention — shocking fact, bold claim, or unanswered question. No slow starts.
PACING: Short punchy sentences only (max 8 words each). Never ramble.
PATTERN INTERRUPTS: Shift the angle or thought every 20-25 seconds to re-engage viewers about to scroll away.
LANGUAGE: Address the viewer directly using "you" throughout.
CTA: End with a strong clear action — "Follow for more," "Comment below," or "Share this now."
ENERGY: High-energy, conversational, feels like a friend talking — not a lecture.`,
  },
  {
    id: "youtube-short" as const,
    label: "YT Short",
    emoji: "⚡",
    systemPrompt: `You are a YouTube Shorts script writer. Rules:
Instant hook — NO slow intro. Start mid-action or mid-thought in the first 2 seconds.
Deliver ONE focused idea or revelation under 50 seconds of speech.
Suggest visual cues in [brackets] (what to show on screen) to boost production.
Write a loop-worthy ending that naturally circles back to the opening hook.`,
  },
  {
    id: "youtube" as const,
    label: "YouTube",
    emoji: "▶",
    systemPrompt: `You are a YouTube long-form script writer optimizing for watch-time and retention. Rules:
Open with a hook + value promise ("In the next X minutes you'll discover exactly how to...").
Use open loops to tease later content and prevent drop-off ("We'll cover that in a moment, but first...").
Plant a subscribe nudge at the first natural chapter break.
Add a relatable moment or unexpected twist every 2-3 minutes to reset attention.
Use chapter-worthy sections with clear spoken transitions ("Now here's where it gets interesting...").
End with a discussion question to spark comments.`,
  },
  {
    id: "podcast" as const,
    label: "Podcast",
    emoji: "🎙",
    systemPrompt: `You are a podcast script writer. Rules:
Write in natural spoken language — contractions, rhythm, casual flow. Write HOW people actually talk.
Use vivid descriptions since there is no video (paint mental pictures with words).
Add callback references to earlier points: "Remember when I mentioned X? Here's why that matters now."
Structure clearly: strong intro, well-marked segments with spoken transitions, outro with next-episode tease.
Vary sentence rhythm to create natural listening pacing — mix short and long sentences.`,
  },
] as const;

type PlatformId = typeof PLATFORMS[number]["id"];

/* ─── Types ──────────────────────────────────────────────────────────────────── */

interface OutlineSection {
  title: string;
  role: string;
  targetWords: number;
  instructions: string;
  keyPoints: string[];
}

type GenPhase =
  | { kind: "planning" }
  | { kind: "writing"; current: number; total: number; title: string };

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

/** The `usePreference` key the brain choice is stored under. */
const MODEL_PREF_KEY = "scriptWriter.model";

function fmtWords(n: number) {
  if (n >= 1000) return `${n % 1000 === 0 ? n / 1000 : (n / 1000).toFixed(1)}K`;
  return String(n);
}
export function fmtDuration(words: number) {
  const s = Math.round((words / WPM) * 60);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

/* ─── Script analysis ──────────────────────────────────────────────────────────
   Lightweight, fully client-side read on script quality — pacing, readability,
   hook strength and lexical variety rolled into a single "Script Health" score
   so the writer gets an at-a-glance signal of whether the script is great. */

function countSyllables(raw: string): number {
  const word = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  if (word.length <= 3) return 1;
  const trimmed = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

export interface ScriptAnalysis {
  words: number;
  sentences: number;
  durationLabel: string;
  avgSentenceLen: number;
  readingEase: number;
  gradeLabel: string;
  uniqueRatio: number;
  hook: { hits: number; label: string };
  score: number;
  rating: string;
  color: string;
  tips: string[];
}

export function analyzeScript(text: string): ScriptAnalysis | null {
  const clean = text.trim();
  if (!clean) return null;

  const wordsArr = clean.split(/\s+/).filter(Boolean);
  const words = wordsArr.length;
  const sentenceArr = clean.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  const sentences = Math.max(1, sentenceArr.length);
  const syllables = wordsArr.reduce((a, w) => a + countSyllables(w), 0);

  const avgSentenceLen = words / sentences;
  const readingEase = Math.max(0, Math.min(100,
    206.835 - 1.015 * avgSentenceLen - 84.6 * (syllables / Math.max(1, words))));
  const uniqueRatio =
    new Set(wordsArr.map(w => w.toLowerCase().replace(/[^a-z']/g, ""))).size / Math.max(1, words);

  // Hook strength on the opening line
  const firstRaw = sentenceArr[0] ?? "";
  const first = firstRaw.toLowerCase();
  const hookSignals = [
    firstRaw.trim().endsWith("?"),
    /\bwhat if\b|\bimagine\b|\bdid you know\b|\bhere'?s\b|\bstop\b|\bever\b|\bwhy\b/.test(first),
    /\d/.test(first),
  ];
  const hits = hookSignals.filter(Boolean).length;
  const hook = { hits, label: hits >= 2 ? "Strong hook" : hits === 1 ? "Decent hook" : "Weak hook" };

  // Component scores (spoken-video tuned)
  const pacingScore = avgSentenceLen <= 8 ? 72
    : avgSentenceLen <= 18 ? 100
    : avgSentenceLen <= 24 ? 82
    : avgSentenceLen <= 30 ? 58 : 38;
  const easeScore = readingEase >= 70 ? 100 : readingEase >= 55 ? 86 : readingEase >= 40 ? 66 : 46;
  const varietyScore = uniqueRatio >= 0.45 ? 100 : uniqueRatio >= 0.35 ? 86 : uniqueRatio >= 0.28 ? 70 : 55;
  const hookScore = hits >= 2 ? 100 : hits === 1 ? 80 : 48;
  const lengthScore = words >= 80 ? 100 : words >= 40 ? 80 : words >= 15 ? 60 : 40;

  const score = Math.round(
    pacingScore * 0.28 + easeScore * 0.24 + hookScore * 0.22 + varietyScore * 0.13 + lengthScore * 0.13,
  );
  const rating = score >= 85 ? "Great" : score >= 70 ? "Good" : score >= 55 ? "Fair" : "Needs work";
  const color  = score >= 85 ? "#10b981" : score >= 70 ? "#22c55e" : score >= 55 ? "#f59e0b" : "#ef4444";
  const gradeLabel = readingEase >= 80 ? "Very easy" : readingEase >= 65 ? "Easy"
    : readingEase >= 50 ? "Plain" : readingEase >= 35 ? "Fairly hard" : "Hard";

  const tips: string[] = [];
  if (hits === 0) tips.push("Open with a question, bold claim, or a surprising number.");
  if (avgSentenceLen > 24) tips.push("Shorten sentences — spoken scripts flow best under ~18 words.");
  if (readingEase < 55) tips.push("Simplify the wording so it's easier to listen to.");
  if (uniqueRatio < 0.3) tips.push("Vary your vocabulary to avoid repetition.");
  if (words < 40) tips.push("Add more substance — this reads quite short.");

  return {
    words, sentences, durationLabel: fmtDuration(words), avgSentenceLen,
    readingEase, gradeLabel, uniqueRatio, hook, score, rating, color, tips,
  };
}

function wordsPerSection(total: number): number {
  if (total <= 3000) return 600;
  if (total <= 10000) return 900;
  if (total <= 25000) return 1200;
  return 1500;
}
function calcSectionCount(total: number): number {
  return Math.min(20, Math.max(2, Math.ceil(total / wordsPerSection(total))));
}

/** Comparison key — lowercase, alphanumerics + single spaces only. */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
/**
 * Strip sentences from a freshly-generated section that already appear in the
 * text written so far. Weak local models often echo the "previous content"
 * context verbatim; this removes those duplicate sentences so long scripts don't
 * repeat themselves. Only drops substantial (≥10-word) exact repeats.
 */
function stripRepeatedSentences(prev: string, section: string): string {
  if (!prev.trim()) return section;
  const prevNorm = normalizeText(prev);
  const chunks = section.split(/(?<=[.!?])\s+/);
  const kept = chunks.filter((c) => {
    const nc = normalizeText(c);
    if (nc.split(" ").length < 10) return true; // keep short fragments / connectors
    return !prevNorm.includes(nc);
  });
  return kept.join(" ").replace(/\s+\n/g, "\n").trim();
}

/**
 * Pull a leading title/headline the model emitted (a "# Heading", a "**Bold**"
 * line, a "Title: …" label, or a short title-case line followed by a blank) out
 * of the script body so it can populate the document title instead of cluttering
 * the spoken script. Returns the remaining body unchanged when none is found.
 */
function splitLeadingHeadline(text: string): { headline: string | null; body: string } {
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return { headline: null, body: text };

  const first = lines[i].trim();
  const nextBlank = i + 1 >= lines.length || !lines[i + 1].trim();
  const words = first.split(/\s+/).length;

  const md      = first.match(/^#{1,3}\s+(.+)$/);
  const labeled = first.match(/^(?:title|headline)\s*[:\-]\s*(.+)$/i);
  const bold    = first.match(/^\*\*(.+?)\*\*$/);

  let headline: string | null = null;
  if (md) headline = md[1];
  else if (labeled) headline = labeled[1];
  else if (bold && (nextBlank || words <= 12)) headline = bold[1];
  else if (nextBlank && words <= 12 && first.length <= 90 && !/[.!?,:;]$/.test(first)) headline = first;

  if (!headline) return { headline: null, body: text };
  headline = headline.replace(/^[#*\s]+|[*\s]+$/g, "").trim();
  const body = lines.slice(i + 1).join("\n").replace(/^\n+/, "").trim();
  return { headline, body };
}
/* ─── ModelPicker sub-components ────────────────────────────────────────────── */

const DROP_CLS        = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-xl shadow-2xl overflow-hidden";
const ITEM_ACTIVE_CLS = "bg-violet-500/8 text-violet-500";
const ITEM_CLS        = "w-full flex items-center gap-2.5 px-3.5 py-2.5 bg-transparent border-none cursor-pointer font-[inherit] text-left text-[13px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors";
const TRIGGER_CLS     = "w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-white dark:bg-white/6 border border-zinc-200 dark:border-white/10 cursor-pointer font-[inherit] text-[13px] font-medium text-zinc-700 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 shadow-xs transition-colors";

// macOS "System Settings" grouped-list styles
const SECTION_LBL = "text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500 px-1.5 mb-1.5";
const GROUP_CLS   = "rounded-xl border border-zinc-200/70 dark:border-white/8 bg-zinc-50/70 dark:bg-white/3 overflow-hidden divide-y divide-zinc-200/55 dark:divide-white/6";

/* Every brain is a local one (a CLI process or an Ollama model on this machine). */
function BrainIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
      <rect width="20" height="20" rx="5" fill="#0f766e"/>
      <rect x="4" y="5" width="12" height="8" rx="1.5" stroke="white" strokeWidth="1.3" fill="none"/>
      <circle cx="10" cy="9" r="2" stroke="white" strokeWidth="1.2" fill="none"/>
      <path d="M7 13v2M13 13v2" stroke="white" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

interface BrainGroup { label: string; brains: LocalBrainOption[] }

/** Only brains actually available are offered (a CLI on PATH, a model Ollama
 *  reports, or a provider with a saved API key) — never a hardcoded fallback. */
function buildGroups(brains: LocalBrainOption[]): BrainGroup[] {
  const groups: BrainGroup[] = [];
  const cli    = brains.filter(b => b.kind === "cli");
  const ollama = brains.filter(b => b.kind === "ollama");
  const api    = brains.filter(b => b.kind === "api");
  if (cli.length)    groups.push({ label: "AI CLI (this machine)", brains: cli });
  if (ollama.length) groups.push({ label: "Local AI (Ollama)", brains: ollama });
  if (api.length)    groups.push({ label: "Your API keys (cloud)", brains: api });
  return groups;
}

function ModelPicker({ value, onChange, brains, loading }: {
  value: string; onChange: (v: string) => void;
  brains: LocalBrainOption[]; loading: boolean;
}) {
  const [open, setOpen]               = useState(false);
  const [openUp, setOpenUp]           = useState(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [query, setQuery]             = useState("");
  const triggerRef  = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef   = useRef<HTMLInputElement>(null);

  const groups   = buildGroups(brains);
  const allItems = groups.flatMap(g => g.brains);
  const selected = allItems.find(b => b.id === value) ?? allItems[0];

  function handleOpen() {
    if (!triggerRef.current) return;
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const raw  = triggerRef.current.getBoundingClientRect();
    const r    = new DOMRect(raw.left / zoom, raw.top / zoom, raw.width / zoom, raw.height / zoom);
    setTriggerRect(r);
    setOpenUp(window.innerHeight / zoom - r.bottom < 320);
    setQuery("");  // each open starts with a clear search
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onMouse(e: MouseEvent) {
      if (!triggerRef.current?.contains(e.target as Node) && !dropdownRef.current?.contains(e.target as Node))
        setOpen(false);
    }
    function onScroll(e: Event) {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onMouse);
    window.addEventListener("scroll", onScroll, true);
    setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const dropdown = open && triggerRect ? createPortal(
    <div ref={dropdownRef} className={DROP_CLS} style={{
      position: "fixed",
      ...(openUp ? { bottom: window.innerHeight - triggerRect.top + 4 } : { top: triggerRect.bottom + 4 }),
      left: triggerRect.left,
      width: Math.max(triggerRect.width, 280),
      zIndex: 99999,
    }}>
      {/* The collapsed list has at most a few engine choices and no per-model
          selection, so the legacy selected-header + search box are omitted. */}
      <div className="max-h-64 overflow-y-auto">
        {groups.map((group, gi) => {
          const filtered = group.brains.filter(b =>
            !query || b.label.toLowerCase().includes(query.toLowerCase())
          );
          if (!filtered.length) return null;
          return (
            <div key={group.label}>
              {gi > 0 && <div className="h-px bg-zinc-100 dark:bg-white/6" />}
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-600 px-3.5 pt-2.5 pb-1">{group.label}</p>
              {filtered.map(b => {
                const active = b.id === value;
                return (
                  <button key={b.id} onClick={() => { onChange(b.id); setOpen(false); }}
                    className={`${ITEM_CLS} ${active ? ITEM_ACTIVE_CLS : ""}`}>
                    <BrainIcon size={16} />
                    <span className={`flex-1 min-w-0 truncate text-[13px] font-${active ? "semibold" : "normal"}`}>{b.label}</span>
                    {b.sub && (
                      <span className="text-[10.5px] text-zinc-400 dark:text-zinc-500 truncate max-w-[110px] shrink-0">{b.sub}</span>
                    )}
                    {active && <Check size={11} className="text-violet-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          );
        })}
        {allItems.length === 0 && (
          <p className="text-[12px] text-zinc-400 text-center py-6 px-4">{loading ? "Detecting local AI…" : "No models available"}</p>
        )}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div ref={triggerRef} className="relative">
      <button onClick={handleOpen}
        className="inline-flex max-w-full items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white dark:bg-white/6 border border-zinc-200 dark:border-white/10 cursor-pointer font-[inherit] text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 shadow-xs transition-colors">
        {selected ? <BrainIcon size={14} />
          : loading ? <Loader2 size={14} className="text-zinc-400 shrink-0 animate-spin" />
          : <Cpu size={14} className="text-zinc-400 shrink-0" />}
        <span className="text-left font-medium truncate min-w-0">{selected?.label ?? (loading ? "Detecting…" : "Select model…")}</span>
        <ChevronDown size={12} className="text-zinc-400 shrink-0" />
      </button>
      {dropdown}
    </div>
  );
}

function SelectBox({ value, onChange, options, disabled, searchable, label, plain }: {
  value: string; onChange: (v: string) => void; options: readonly string[];
  disabled?: boolean; searchable?: boolean; label?: string; plain?: boolean;
}) {
  const [open, setOpen]               = useState(false);
  const [placement, setPlacement]     = useState<"down" | "up" | "right">("down");
  const [zoom, setZoom]               = useState(1);
  const [query, setQuery]             = useState("");
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const triggerRef  = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef   = useRef<HTMLInputElement>(null);

  // Estimate the menu's height from its option count so placement is accurate:
  // short menus (POV) open downward; only long ones (Duration) need to flip.
  const menuH = Math.min(340, 56 + options.length * 36);

  function handleOpen() {
    if (disabled || !triggerRef.current) return;
    // The Studio UI is rendered with CSS `zoom` on <html>, so getBoundingClientRect
    // returns scaled pixels while position:fixed expects unscaled CSS units. Divide
    // the rect (and viewport) by zoom — same correction the model picker uses.
    const z   = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const raw = triggerRef.current.getBoundingClientRect();
    const r   = new DOMRect(raw.left / z, raw.top / z, raw.width / z, raw.height / z);
    const vw  = window.innerWidth / z;
    const vh2 = window.innerHeight / z;
    setZoom(z);
    setTriggerRect(r);
    // Keep the menu ATTACHED to the trigger: open downward when it fits, flip up
    // when it would clip the bottom. Right is only a last resort (no vertical room).
    const width = plain ? 236 : Math.max(r.width, 200);
    if (vh2 - r.bottom >= menuH + 12) setPlacement("down");
    else if (r.top >= menuH + 12) setPlacement("up");
    else if (vw - r.right >= width + 16) setPlacement("right");
    else setPlacement("down");
    setQuery("");  // each open starts with a clear search
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onMouse(e: MouseEvent) {
      if (!triggerRef.current?.contains(e.target as Node) && !dropdownRef.current?.contains(e.target as Node))
        setOpen(false);
    }
    function onScroll(e: Event) {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onMouse);
    window.addEventListener("scroll", onScroll, true);
    if (searchable) setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, searchable]);

  const filteredOptions = searchable && query
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase()))
    : options;

  const grouped = filteredOptions.reduce<{ group: string; items: string[] }[]>((acc, o) => {
    const grp  = o.includes(" · ") ? o.split(" · ")[0] : "";
    const last = acc[acc.length - 1];
    if (last && last.group === grp) last.items.push(o);
    else acc.push({ group: grp, items: [o] });
    return acc;
  }, []);
  const hasGroups = grouped.some(g => g.group !== "");

  const ddWidth = plain ? 236 : Math.max(triggerRect?.width ?? 200, 200);
  const ddLeft  = plain && triggerRect ? Math.max(8, triggerRect.right - ddWidth) : (triggerRect?.left ?? 0);

  // Position per placement, clamped so the menu always stays within the viewport.
  // Use the zoom-adjusted viewport height (matches the zoom-divided triggerRect).
  const vh = (typeof window !== "undefined" ? window.innerHeight : 800) / zoom;
  const placeStyle: React.CSSProperties =
    !triggerRect ? {} :
    placement === "right"
      ? { top: Math.min(Math.max(8, triggerRect.top), Math.max(8, vh - menuH - 8)), left: triggerRect.right + 6, width: ddWidth, maxHeight: menuH }
      : placement === "up"
        ? { bottom: vh - triggerRect.top + 4, left: ddLeft, width: ddWidth, maxHeight: Math.min(menuH, triggerRect.top - 12) }
        : { top: triggerRect.bottom + 4, left: ddLeft, width: ddWidth, maxHeight: Math.min(menuH, vh - triggerRect.bottom - 12) };

  const dropdown = open && triggerRect ? createPortal(
    <div ref={dropdownRef} className={DROP_CLS} style={{
      position: "fixed",
      ...placeStyle,
      overflowY: "auto",
      zIndex: 99999,
    }}>
      <button onClick={() => setOpen(false)}
        className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 bg-violet-500/5 border-b border-violet-500/15 cursor-pointer font-[inherit] hover:bg-violet-500/8 transition-colors">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-violet-500">{label ?? "Select"}</span>
        <ChevronDown size={13} className="text-zinc-400 rotate-180 shrink-0" />
      </button>
      {searchable && (
        <div className="px-2.5 py-2 border-b border-zinc-100 dark:border-white/6">
          <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…"
            className="w-full bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 rounded-lg px-3 py-1.5 text-[12px] text-zinc-700 dark:text-zinc-300 placeholder:text-zinc-400 outline-none focus:border-violet-500/40 transition-colors" />
        </div>
      )}
      <div className="max-h-60 overflow-y-auto">
        {grouped.map(({ group, items }, gi) => (
          <div key={gi}>
            {hasGroups && group && (
              <p className={`text-[9.5px] font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-600 px-3.5 pt-2.5 pb-1 ${gi > 0 ? "border-t border-zinc-100 dark:border-white/6" : ""}`}>
                {group}
              </p>
            )}
            {items.map(o => {
              const lbl    = o.includes(" · ") ? o.split(" · ")[1] : o;
              const active = o === value;
              return (
                <button key={o} onClick={() => { onChange(o); setOpen(false); }}
                  className={`${ITEM_CLS} ${active ? ITEM_ACTIVE_CLS : ""}`}>
                  <span className={`flex-1 text-[13px] font-${active ? "semibold" : "normal"}`}>{lbl}</span>
                  {active && <Check size={11} className="text-violet-500 shrink-0" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body
  ) : null;

  if (plain) {
    const lbl = value.includes(" · ") ? value.split(" · ")[1] : value;
    return (
      <div ref={triggerRef} className="relative">
        <button onClick={handleOpen}
          className="flex items-center gap-1 max-w-full bg-transparent border-none font-[inherit] text-[12.5px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 transition-colors"
          style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1 }}>
          <span className="truncate">{lbl}</span>
          <ChevronDown size={13} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""} text-zinc-400`} />
        </button>
        {dropdown}
      </div>
    );
  }

  return (
    <div ref={triggerRef} className="relative">
      <button onClick={handleOpen} className={TRIGGER_CLS}
        style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1 }}>
        <span className="flex-1 text-left font-medium truncate">{value}</span>
        <ChevronDown size={13} className="text-zinc-400 shrink-0" />
      </button>
      {dropdown}
    </div>
  );
}

/* Minimal inline-markdown → React: **bold**, *italic* / _italic_, `code`. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*.+?\*\*|`.+?`|\*[^*]+?\*|_[^_]+?_)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++} className="font-semibold text-zinc-900 dark:text-zinc-50">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++} className="px-1.5 py-0.5 rounded-md text-[0.86em] font-mono bg-zinc-100 dark:bg-white/10 text-violet-600 dark:text-violet-400">{t.slice(1, -1)}</code>);
    else out.push(<em key={k++} className="italic">{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type MdBlock =
  | { t: "h"; lvl: number; s: string }
  | { t: "p"; s: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "hr" };

/* Notion-style document renderer for the script — a centered reading column with
   comfortable typography. Parses the lightweight markdown LLMs emit (headings,
   **bold**, bullet / numbered lists, paragraphs). */
function NotionDoc({ text, title }: { text: string; title?: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: "p", s: para.join(" ") }); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) { flush(); continue; }
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); blocks.push({ t: "h", lvl: h[1].length, s: h[2] }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(raw)) { flush(); blocks.push({ t: "hr" }); continue; }
    const bullet = raw.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      flush();
      const items = [bullet[1]];
      while (i + 1 < lines.length && /^[-*•]\s+/.test(lines[i + 1].trim())) items.push(lines[++i].trim().replace(/^[-*•]\s+/, ""));
      blocks.push({ t: "ul", items }); continue;
    }
    const num = raw.match(/^\d+\.\s+(.*)$/);
    if (num) {
      flush();
      const items = [num[1]];
      while (i + 1 < lines.length && /^\d+\.\s+/.test(lines[i + 1].trim())) items.push(lines[++i].trim().replace(/^\d+\.\s+/, ""));
      blocks.push({ t: "ol", items }); continue;
    }
    para.push(raw);
  }
  flush();

  return (
    <div className="max-w-[680px] mx-auto w-full px-6 sm:px-10 py-8 text-[15.5px] leading-[1.85] text-zinc-700 dark:text-zinc-300">
      {title && <h1 className="text-[27px] font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mb-5 leading-tight">{title}</h1>}
      {blocks.map((b, i) => {
        if (b.t === "h") {
          const cls = b.lvl === 1 ? "text-[21px] font-bold mt-6 mb-2" : b.lvl === 2 ? "text-[18px] font-bold mt-5 mb-2" : "text-[15.5px] font-semibold mt-4 mb-1.5";
          return <div key={i} className={`text-zinc-900 dark:text-zinc-100 ${cls}`}>{renderInline(b.s)}</div>;
        }
        if (b.t === "hr") return <hr key={i} className="my-6 border-zinc-200 dark:border-white/10" />;
        if (b.t === "ul") return (
          <ul key={i} className="my-2.5 space-y-1.5">
            {b.items.map((it, j) => (
              <li key={j} className="flex gap-2.5"><span className="mt-[10px] w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 shrink-0" /><span className="flex-1">{renderInline(it)}</span></li>
            ))}
          </ul>
        );
        if (b.t === "ol") return (
          <ol key={i} className="my-2.5 space-y-1.5">
            {b.items.map((it, j) => (
              <li key={j} className="flex gap-2.5"><span className="text-zinc-400 dark:text-zinc-500 tabular-nums shrink-0 min-w-[1.3em]">{j + 1}.</span><span className="flex-1">{renderInline(it)}</span></li>
            ))}
          </ol>
        );
        return <p key={i} className="mb-4 last:mb-0">{renderInline(b.s)}</p>;
      })}
    </div>
  );
}

/* ── markdown ⇄ HTML for the WYSIWYG editor ──────────────────────────────────── */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMdToHtml(s: string): string {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>");
  h = h.replace(/(^|[^_])_([^_\n]+?)_/g, "$1<em>$2</em>");
  return h;
}
/* markdown → HTML string for seeding the contenteditable surface. */
function mdToHtml(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const html: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { html.push(`<p>${inlineMdToHtml(para.join(" "))}</p>`); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) { flush(); continue; }
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); html.push(`<h${h[1].length}>${inlineMdToHtml(h[2])}</h${h[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(raw)) { flush(); html.push("<hr>"); continue; }
    const bullet = raw.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      flush();
      const items = [bullet[1]];
      while (i + 1 < lines.length && /^[-*•]\s+/.test(lines[i + 1].trim())) items.push(lines[++i].trim().replace(/^[-*•]\s+/, ""));
      html.push(`<ul>${items.map(it => `<li>${inlineMdToHtml(it)}</li>`).join("")}</ul>`); continue;
    }
    const num = raw.match(/^\d+\.\s+(.*)$/);
    if (num) {
      flush();
      const items = [num[1]];
      while (i + 1 < lines.length && /^\d+\.\s+/.test(lines[i + 1].trim())) items.push(lines[++i].trim().replace(/^\d+\.\s+/, ""));
      html.push(`<ol>${items.map(it => `<li>${inlineMdToHtml(it)}</li>`).join("")}</ol>`); continue;
    }
    para.push(raw);
  }
  flush();
  return html.join("");
}
/* Serialize one block element's inline content back to markdown. */
function serializeInline(node: Node): string {
  let out = "";
  node.childNodes.forEach(ch => {
    if (ch.nodeType === Node.TEXT_NODE) { out += ch.textContent ?? ""; return; }
    if (ch.nodeType !== Node.ELEMENT_NODE) return;
    const el = ch as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") { out += "\n"; return; }
    const inner = serializeInline(el);
    if (!inner.trim()) { out += inner; return; }
    if (tag === "strong" || tag === "b") out += `**${inner}**`;
    else if (tag === "em" || tag === "i") out += `*${inner}*`;
    else if (tag === "code") out += "`" + inner + "`";
    else {
      const fw = el.style.fontWeight;
      const fs = el.style.fontStyle;
      if (fw === "bold" || parseInt(fw) >= 600) out += `**${inner}**`;
      else if (fs === "italic") out += `*${inner}*`;
      else out += inner;
    }
  });
  return out;
}
/* contenteditable DOM → markdown (canonical storage for save / copy / generation). */
function htmlToMd(root: HTMLElement): string {
  const blocks: string[] = [];
  root.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) { const t = (node.textContent ?? "").trim(); if (t) blocks.push(t); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-3]$/.test(tag)) { const t = serializeInline(el).trim(); if (t) blocks.push("#".repeat(Number(tag[1])) + " " + t); }
    else if (tag === "ul") { const items = Array.from(el.querySelectorAll(":scope > li")).map(li => "- " + serializeInline(li).trim()); if (items.length) blocks.push(items.join("\n")); }
    else if (tag === "ol") { const items = Array.from(el.querySelectorAll(":scope > li")).map((li, i) => `${i + 1}. ` + serializeInline(li).trim()); if (items.length) blocks.push(items.join("\n")); }
    else if (tag === "hr") blocks.push("---");
    else { const t = serializeInline(el).trim(); if (t) blocks.push(t); }
  });
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* Toolbar buttons for the rich editor — static data; RichEditor maps each
   `action` onto the command it runs. */
type EditorAction = "bold" | "italic" | "code" | "h1" | "h2" | "ul" | "ol";
const EDITOR_TOOLS: ({ sep: true } | { icon: LucideIcon; title: string; action: EditorAction })[] = [
  { icon: Bold,        title: "Bold (Ctrl+B)",   action: "bold" },
  { icon: Italic,      title: "Italic (Ctrl+I)", action: "italic" },
  { icon: Code,        title: "Inline code",     action: "code" },
  { sep: true },
  { icon: Heading1,    title: "Heading 1",       action: "h1" },
  { icon: Heading2,    title: "Heading 2",       action: "h2" },
  { sep: true },
  { icon: List,        title: "Bulleted list",   action: "ul" },
  { icon: ListOrdered, title: "Numbered list",   action: "ol" },
];

/* Notion-style WYSIWYG editor. Renders/edits formatted text (no visible markdown
   markers) and serializes back to markdown so save / copy / generation keep working.
   Uncontrolled while typing (DOM owns the caret); innerHTML is only reset when the
   value changes from outside (a fresh generation or a new script). */
function RichEditor({ value, onChange }: { value: string; onChange: (md: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastMd = useRef<string | null>(null);

  useEffect(() => { try { document.execCommand("styleWithCSS", false, "false"); } catch (e) { logDebug("script-writer", "execCommand styleWithCSS not supported", e); } }, []);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (value === lastMd.current) return;           // our own edit — keep caret, skip reset
    el.innerHTML = value.trim() ? mdToHtml(value) : "";
    lastMd.current = value;
  }, [value]);

  const emit = () => {
    const el = ref.current; if (!el) return;
    const md = htmlToMd(el);
    lastMd.current = md;
    onChange(md);
  };
  const exec = (command: string, arg?: string) => { ref.current?.focus(); document.execCommand(command, false, arg); emit(); };
  const toggleBlock = (tag: string) => {
    ref.current?.focus();
    const sel = window.getSelection();
    let block: HTMLElement | null = sel?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? sel.anchorNode as HTMLElement
      : sel?.anchorNode?.parentElement ?? null;
    while (block && block !== ref.current && !/^(h[1-3]|p|div|li)$/.test(block.tagName.toLowerCase())) block = block.parentElement;
    const cur = block?.tagName.toLowerCase();
    document.execCommand("formatBlock", false, cur === tag ? "p" : tag);
    emit();
  };
  const wrapCode = () => {
    ref.current?.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const code = document.createElement("code");
    try { sel.getRangeAt(0).surroundContents(code); } catch (e) { logDebug("script-writer", "surroundContents failed (selection spans elements)", e); }
    emit();
  };

  const runTool = (action: EditorAction) => {
    switch (action) {
      case "bold":   exec("bold"); break;
      case "italic": exec("italic"); break;
      case "code":   wrapCode(); break;
      case "h1":     toggleBlock("h1"); break;
      case "h2":     toggleBlock("h2"); break;
      case "ul":     exec("insertUnorderedList"); break;
      case "ol":     exec("insertOrderedList"); break;
    }
  };

  return (
    <>
      <div className="shrink-0 flex items-center gap-0.5 px-3 py-1.5 border-b border-zinc-100 dark:border-white/6 bg-zinc-50/60 dark:bg-white/[0.02] overflow-x-auto no-scrollbar">
        {EDITOR_TOOLS.map((t, i) => "sep" in t ? (
          <span key={i} className="w-px h-4 bg-zinc-200 dark:bg-white/10 mx-1 shrink-0" />
        ) : (
          <button key={i} title={t.title} onMouseDown={e => e.preventDefault()} onClick={() => runTool(t.action)}
            className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-white/10 transition-colors">
            <t.icon size={14} />
          </button>
        ))}
        <span className="ml-auto pl-2 pr-1 text-[10.5px] text-zinc-400 dark:text-zinc-500 shrink-0 hidden sm:block">Rich text</span>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        data-placeholder="Write or paste your script…"
        className="rich-editor flex-1 min-h-0 overflow-y-auto outline-none w-full max-w-[720px] mx-auto px-6 sm:px-10 py-8 text-[15.5px] leading-[1.85] text-zinc-700 dark:text-zinc-300"
      />
    </>
  );
}

/* Elegant "AI is writing" placeholder shown in the output while a generation is
   in flight but no text has landed yet (a CLI brain returns the whole script at
   once, so there's nothing to stream — an empty page would just read as
   "stuck"). A shimmering document skeleton + a live status line reads as the AI
   drafting the script. */
function GeneratingSkeleton({ label }: { label?: string }) {
  // Varied line widths per paragraph → looks like real prose, not a table.
  const paras = [
    ["94%", "88%", "97%", "68%"],
    ["86%", "95%", "58%"],
    ["91%", "82%", "97%", "74%", "46%"],
  ];
  return (
    <div className="max-w-[680px] mx-auto w-full px-6 sm:px-10 py-8 animate-step-in">
      {/* Live status line */}
      <div className="flex items-center gap-2.5 mb-7">
        <span className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/12 text-violet-500">
          <span className="absolute inset-0 rounded-lg bg-violet-500/15 animate-ping" />
          <Sparkles size={14} className="relative animate-pulse" />
        </span>
        <span className="text-[13.5px] font-semibold text-zinc-600 dark:text-zinc-300">
          {label ? `${label} is writing your script` : "Writing your script"}
        </span>
        <span className="flex items-end gap-1 ml-0.5 pb-0.5">
          {[0, 1, 2].map(i => (
            <span key={i} className="h-1.5 w-1.5 rounded-full bg-violet-500/70 animate-bounce"
              style={{ animationDelay: `${i * 0.16}s`, animationDuration: "1s" }} />
          ))}
        </span>
      </div>
      {/* Title skeleton */}
      <div className="shimmer h-7 w-2/3 rounded-lg mb-6" />
      {/* Paragraph skeletons */}
      <div className="flex flex-col gap-6">
        {paras.map((widths, pi) => (
          <div key={pi} className="flex flex-col gap-3">
            {widths.map((w, li) => (
              <div key={li} className="shimmer h-3.5 rounded-md"
                style={{ width: w, animationDelay: `${(pi * 4 + li) * 0.09}s` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────────────────────── */

export default function ScriptWriterTool() {
  const router = useRouter();
  // ── State ──────────────────────────────────────────────────────────────────
  const [topic,       setTopic]       = useState("");
  const [script,      setScript]      = useState("");
  const [platform]                    = useState<PlatformId>("general");
  // Form defaults are remembered on this machine so a new script inherits your
  // last-used settings instead of resetting every time.
  const [tone,        setTone]        = usePreference("scriptWriter.tone", "Informative");
  const [scriptType,  setScriptType]  = usePreference("scriptWriter.type", "⊘ None");
  const [pov,         setPov]         = usePreference("scriptWriter.pov", "Third Person");
  const [duration,    setDuration]    = usePreference("scriptWriter.duration", "Medium · 3 min");
  // The chosen local brain. "" = nothing picked yet → the Settings default applies.
  const [model,       setModel]       = usePreference(MODEL_PREF_KEY, "");
  const [advanced,    setAdvanced]    = useState(true);
  const [exactLen,    setExactLen]    = usePreference<boolean>("scriptWriter.exactLen", false);
  const [wordCount,   setWordCount]   = usePreference<number>("scriptWriter.wordCount", 1000);
  const [viralMode,   setViralMode]   = usePreference<boolean>("scriptWriter.viral", false);
  const [structure,   setStructure]   = usePreference<string[]>("scriptWriter.structure", ["Hook","Intro","Main","Ending"]);

  const [hookType,    setHookType]    = useState("Question Hook");
  const [hookLen,     setHookLen]     = useState("2–3 sentences");
  const [introStyle,  setIntroStyle]  = useState("Bold Statement");
  const [introLen,    setIntroLen]    = useState("3–4 sentences");
  const [endingStyle, setEndingStyle] = useState("Call to Action");
  const [endingCta,   setEndingCta]   = useState("Subscribe");
  const [endingLen,   setEndingLen]   = useState("1–2 sentences");
  const [generating,  setGenerating]  = useState(false);
  const [genError,    setGenError]    = useState("");
  const [genPhase,    setGenPhase]    = useState<GenPhase | null>(null);
  const [genProgress, setGenProgress] = useState(0);
  // Local brains (CLI + Ollama) come from ONE shared probe so this picker and every
  // other brain picker always offer the same list.
  const { brains, loading: brainsLoading, preferred } = useLocalBrains();
  const abortRef = useRef<AbortController | null>(null);

  // ── Document ─────────────────────────────────────────────────────────────────
  const [title,         setTitle]         = useState("");
  // true → the title is AI/auto-owned (safe to refresh on regenerate);
  // false → the user typed it (never overwrite).
  const titleAutoRef = useRef(true);
  // Latest title for the memoised generate handler, refreshed after each commit.
  const titleRef = useRef("");
  useEffect(() => { titleRef.current = title; }, [title]);
  const [copied,        setCopied]        = useState(false);
  const [downloaded,    setDownloaded]    = useState(false);  // green check flash on the Download button
  const [editMode,      setEditMode]      = useState(false);  // Notion preview (false) vs raw textarea (true)
  const [showSectionDetail, setShowSectionDetail] = useState(false);  // structure per-section style/length controls (collapsed by default)

  // Start a fresh script — clears the document, keeps the form settings.
  const handleNewScript = useCallback(() => {
    if (generating) return;
    setTitle(""); setTopic(""); setScript(""); setGenError("");
    titleAutoRef.current = true;
  }, [generating]);

  // ── Brain selection ────────────────────────────────────────────────────────
  // Once detection settles, make sure the picker sits on a brain that exists on
  // THIS machine. Untouched (""), or a remembered brain that isn't available here
  // any more → the Settings default brain (Settings → Local AI → Brain), else the
  // first detected one. An explicit, still-available choice is never overridden.
  useEffect(() => {
    if (brainsLoading || !brains.length) return;
    if (brains.some(b => b.id === model)) return;
    setModel(defaultBrainToApply(MODEL_PREF_KEY, brains) ?? preferred?.id ?? brains[0].id);
  }, [brains, brainsLoading, preferred, model, setModel]);

  // ── Computed ───────────────────────────────────────────────────────────────
  const editorWords = script.trim() ? script.trim().split(/\s+/).length : 0;
  const hasAnyModel = brains.length > 0;
  const selectedBrain = brains.find(b => b.id === model);
  // Generation runs only on a brain that's actually present on this machine.
  const modelReady = !!selectedBrain;
  const writing = editMode && !generating;  // raw textarea vs. Notion reading view

  // Script Health analysis — recomputed only when the script settles (not mid-stream).
  const analysis = useMemo(() => (generating ? null : analyzeScript(script)), [script, generating]);
  const [showAnalysis, setShowAnalysis] = useState(false);

  function targetWords(): number {
    if (exactLen) return wordCount;
    const match = duration.match(/([\d.]+)\s*(s|min)/);
    if (!match) return 500;
    const num = parseFloat(match[1]);
    const seconds = match[2] === "min" ? num * 60 : num;
    return Math.round((seconds / 60) * WPM);
  }

  const tw = targetWords();
  const usingAgentic = tw > AGENTIC_THRESHOLD;
  const numSections  = usingAgentic ? calcSectionCount(tw) : 1;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function toggleStructure(s: string) {
    setStructure(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  async function copyScript() {
    if (!script.trim()) return;
    try { await navigator.clipboard.writeText(script); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) { logDebug("script-writer", "Failed to copy script to clipboard", e); }
  }
  async function downloadScript() {
    if (!script.trim()) return;
    const name = (title.trim() || "script").replace(/[^\w\-]+/g, "_").slice(0, 60);
    const blob = new Blob([script], { type: "text/plain;charset=utf-8" });
    const res = await saveBlobToDisk(blob, `${name}.txt`).catch(e => { surfaceError(e, { operation: "save script" }); return null; });
    if (res && res.saved !== false) {
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 1500);
    }
  }

  // Hand the current script off to the Text-to-Voice tool (sessionStorage prefill).
  function goToTextToVoice() {
    if (!script.trim()) return;
    try { sessionStorage.setItem(TTS_PREFILL_KEY, script); } catch (e) { logDebug("script-writer", "Failed to store TTS prefill in sessionStorage (private mode)", e); }
    router.push("/video-studio/text-to-voice");
  }

  // ── Prompt builders ────────────────────────────────────────────────────────
  function buildPrompt(): { system: string; user: string } {
    const plt = PLATFORMS.find(p => p.id === platform) ?? PLATFORMS[0];
    const parts: string[] = [plt.systemPrompt];
    if (viralMode) {
      parts.push(`Apply viral content techniques throughout: open loops that tease what's coming, curiosity gaps that demand answers, pattern interrupts every 20-30 seconds, specific numbers and named examples instead of vague claims, emotional peaks followed by relief, and social proof (studies, experts, common experiences).`);
    }
    parts.push(`Write a ${tone.toLowerCase()} script.`);
    if (scriptType !== "⊘ None") parts.push(`Script type: ${scriptType.replace(/^\S+ /, "")}.`);
    parts.push(`Point of view: ${pov}.`);
    if (exactLen) parts.push(`Target approximately ${wordCount} words.`);
    else parts.push(`Estimated duration: ${duration}.`);
    if (structure.length) parts.push(`Include sections: ${structure.join(", ")}.`);
    if (structure.includes("Hook")) parts.push(`Hook style: ${hookType}, length: ${hookLen}.`);
    if (structure.includes("Intro")) parts.push(`Intro style: ${introStyle}, length: ${introLen}.`);
    if (structure.includes("Ending")) parts.push(`Ending style: ${endingStyle}, CTA: ${endingCta}, length: ${endingLen}.`);
    parts.push("Output only the raw script text. No headings, labels, or meta-commentary.");
    return { system: parts.join(" "), user: `Topic: ${topic}` };
  }

  function buildOutlinePrompt(sectionCount: number, totalWords: number): { system: string; user: string } {
    const plt = PLATFORMS.find(p => p.id === platform) ?? PLATFORMS[0];
    return {
      system: `You are a script structure planner for viral ${plt.label} content.
Create a ${sectionCount}-section outline. Return ONLY valid JSON — no markdown, no code blocks, no explanation.
Required format exactly: {"sections":[{"title":"string","role":"hook|intro|main|transition|ending","targetWords":number,"instructions":"string","keyPoints":["string"]}]}
The targetWords across all sections must sum close to ${totalWords}.`,
      user: `Create a ${sectionCount}-section script outline.
Platform: ${plt.label}
Topic: ${topic}
Total word target: ~${totalWords} words
Tone: ${tone}
Script type: ${scriptType !== "⊘ None" ? scriptType.replace(/^\S+ /, "") : "general faceless video"}
POV: ${pov}
Include sections for: ${structure.join(", ")}
${viralMode ? "Apply viral content techniques: hooks, curiosity gaps, pattern interrupts, strong emotional arc." : ""}
${structure.includes("Hook") ? `Hook: ${hookType} style, ${hookLen}.` : ""}
${structure.includes("Intro") ? `Intro: ${introStyle} style, ${introLen}.` : ""}
${structure.includes("Ending") ? `Ending: ${endingStyle} style, CTA: ${endingCta}, ${endingLen}.` : ""}`,
    };
  }

  function buildSectionPrompt(
    section: OutlineSection,
    outline: OutlineSection[],
    prevContent: string,
    idx: number,
  ): { system: string; user: string } {
    const plt = PLATFORMS.find(p => p.id === platform) ?? PLATFORMS[0];
    const outlineSummary = outline.map((s, i) => `${i + 1}. ${s.title} (${s.role})`).join(", ");
    return {
      system: `You are writing one section of a ${plt.label} script.
${plt.systemPrompt}
${viralMode ? "Use viral techniques: open loops, curiosity gaps, pattern interrupts, specific details." : ""}
CRITICAL RULES:
- Write ONLY this section — nothing before or after it
- NO section headers, labels, or meta-commentary
- Do NOT repeat, quote, or rephrase any earlier text — write only NEW words that come next
- Continue naturally from the previous content without re-introducing the topic
- Write as raw script text only, exactly as the narrator will speak it
- Target ${section.targetWords} words for this section`,
      user: `Full script outline: ${outlineSummary}
Topic: ${topic}
Tone: ${tone} | POV: ${pov}

Writing section ${idx + 1} of ${outline.length}: "${section.title}" (${section.role})
Instructions: ${section.instructions}
Key points to cover: ${section.keyPoints.length > 0 ? section.keyPoints.join(" • ") : "Develop naturally from the topic"}
Target: ~${section.targetWords} words

${prevContent ? `For continuity only, the previous section ended with: "...${prevContent}". Do NOT repeat those words — write what comes next.` : "This is the first section — begin the script."}`,
    };
  }

  function buildFallbackOutline(sectionCount: number, totalWords: number): OutlineSection[] {
    const sections: OutlineSection[] = [];
    const wps = Math.round(totalWords / sectionCount);
    let remaining = sectionCount;

    if (structure.includes("Hook") && remaining > 1) {
      sections.push({ title: "Hook", role: "hook", targetWords: Math.max(100, Math.round(wps * 0.6)),
        instructions: `Open with a compelling ${hookType.toLowerCase()} that immediately grabs attention.`,
        keyPoints: ["Attention-grabbing opening", "Set up the core tension or curiosity"] });
      remaining--;
    }
    if (structure.includes("Intro") && remaining > 1) {
      sections.push({ title: "Introduction", role: "intro", targetWords: wps,
        instructions: `Write a ${introStyle.toLowerCase()} style introduction that sets up the topic.`,
        keyPoints: ["Introduce the topic", "Establish credibility or stakes", "Preview what the viewer will learn"] });
      remaining--;
    }
    const hasEnding = structure.includes("Ending") && remaining > 1;
    const mainCount = hasEnding ? remaining - 1 : remaining;
    const mainWps   = Math.round((totalWords - sections.reduce((a, s) => a + s.targetWords, 0)) / (mainCount + (hasEnding ? 1 : 0)));
    for (let i = 0; i < mainCount; i++) {
      sections.push({ title: `Main Point ${i + 1}`, role: "main", targetWords: mainWps,
        instructions: "Explore a key aspect of the topic with specific examples, surprising facts, or compelling stories.",
        keyPoints: [`Core idea ${i + 1}`, "Supporting evidence or example", "Why this matters to the viewer"] });
    }
    if (hasEnding) {
      sections.push({ title: "Ending", role: "ending", targetWords: Math.max(100, Math.round(wps * 0.7)),
        instructions: `Conclude with a ${endingStyle.toLowerCase()}. CTA: ${endingCta}.`,
        keyPoints: ["Recap the core message", "Deliver the call to action", "Leave the viewer with something memorable"] });
    }
    if (sections.length === 0) {
      sections.push({ title: "Script", role: "main", targetWords: totalWords,
        instructions: "Write the complete script naturally.", keyPoints: [] });
    }
    return sections;
  }

  function parseOutline(text: string, sectionCount: number, totalWords: number): OutlineSection[] {
    try {
      // extractJson tolerates the prose / ```json fences brains wrap answers in.
      const parsed = extractJson<{ sections?: Partial<OutlineSection>[] }>(text);
      if (parsed && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
        return parsed.sections.map((s, i) => ({
          title: s.title ?? `Section ${i + 1}`,
          role: s.role ?? "main",
          targetWords: s.targetWords ?? Math.round(totalWords / parsed.sections!.length),
          instructions: s.instructions ?? "Write this section naturally.",
          keyPoints: Array.isArray(s.keyPoints) ? s.keyPoints : [],
        }));
      }
    } catch (e) { logDebug("script-writer", "Failed to parse outline JSON from LLM, using fallback", e); }
    return buildFallbackOutline(sectionCount, totalWords);
  }

  // ── LLM call ───────────────────────────────────────────────────────────────
  /**
   * Run a turn on the selected local brain. Ollama streams token-by-token; a CLI
   * brain (Claude Code / Codex / Gemini) buffers and fires `onChunk` once at the
   * end, so the UI still fills in — just in one step rather than a typewriter.
   *
   * A CLI brain can't be interrupted mid-answer, so chunks that land after Stop
   * are dropped here rather than written into the editor.
   */
  async function callLLM(
    system: string, user: string, signal: AbortSignal,
    onChunk?: (text: string) => void,
  ): Promise<string> {
    return runLocalBrain({
      engineId: model, system, prompt: user, signal,
      onChunk: onChunk ? (text) => { if (!signal.aborted) onChunk(text); } : undefined,
    });
  }

  // ── Single-shot generation (< AGENTIC_THRESHOLD words) ────────────────────
  async function generateSingleShot(signal: AbortSignal): Promise<string> {
    const { system, user } = buildPrompt();
    return callLLM(system, user, signal, text => setScript(s => s + text));
  }

  // ── Agentic generation (> AGENTIC_THRESHOLD words) ────────────────────────
  async function generateAgentically(signal: AbortSignal): Promise<string> {
    const totalWords   = tw;
    const sectionCount = calcSectionCount(totalWords);

    // Phase 1: plan the structure
    setGenPhase({ kind: "planning" });
    setGenProgress(0);
    const outlinePrompt = buildOutlinePrompt(sectionCount, totalWords);
    const outlineText   = await callLLM(outlinePrompt.system, outlinePrompt.user, signal);
    if (signal.aborted) return "";

    const outline = parseOutline(outlineText, sectionCount, totalWords);

    // Phase 2: generate each section
    let accumulated = "";
    for (let i = 0; i < outline.length; i++) {
      if (signal.aborted) break;
      const section = outline[i];
      setGenPhase({ kind: "writing", current: i + 1, total: outline.length, title: section.title });
      setGenProgress(Math.round(((i + 1) / (outline.length + 1)) * 100));

      // A short tail (last ~40 words) is enough continuity context — feeding more
      // tempts weak models to echo it back, which causes duplicated paragraphs.
      const prevWords = accumulated.trim().split(/\s+/).slice(-40).join(" ");
      const sectionPrompt = buildSectionPrompt(section, outline, prevWords, i);

      // Stream real-time into the editor
      let currentSection = "";
      await callLLM(sectionPrompt.system, sectionPrompt.user, signal, chunk => {
        currentSection += chunk;
        setScript(accumulated + (accumulated ? "\n\n" : "") + currentSection);
      });

      if (!signal.aborted) {
        // Drop any sentences the model echoed from earlier sections before appending.
        const cleaned = stripRepeatedSentences(accumulated, currentSection.trim());
        if (cleaned) accumulated += (accumulated ? "\n\n" : "") + cleaned;
        setScript(accumulated);
      }
    }

    setGenProgress(100);
    return accumulated;
  }

  // Generate a short, compelling document title from the topic + finished script.
  // Uses the same brain; returns "" on any failure.
  async function generateTitle(scriptText: string, signal: AbortSignal): Promise<string> {
    const sys = "You write punchy, specific titles for short videos. Output ONLY the title text — no quotes, no surrounding punctuation, Title Case, max 9 words.";
    const user = `Topic: ${topic}\n\nScript excerpt:\n${scriptText.slice(0, 800)}\n\nWrite the single best title.`;
    try {
      const raw = await callLLM(sys, user, signal);
      const line = (raw || "").split("\n").map(s => s.trim()).find(Boolean) ?? "";
      return line.replace(/^["'#*\s]+|["'*\s.]+$/g, "").slice(0, 90).trim();
    } catch (e) {
      logDebug("script-writer", "Failed to generate title (best-effort)", e);
      return "";
    }
  }

  // ── Main generate handler ──────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!topic.trim() || generating || !modelReady) return;
    setGenError("");
    setScript("");
    setEditMode(false);   // land on the Notion preview so the stream renders nicely
    setGenPhase(null);
    setGenProgress(0);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setGenerating(true);

    try {
      const finalText = usingAgentic
        ? await generateAgentically(ctrl.signal)
        : await generateSingleShot(ctrl.signal);

      // Put a good title in the title field (not the raw topic), and keep it out
      // of the script body. Only touches the title when the user hasn't set one.
      if (!ctrl.signal.aborted && finalText) {
        const { headline, body } = splitLeadingHeadline(finalText);
        const cur = titleRef.current.trim();
        // Refresh the title when it's empty/the topic OR was AI-set last time —
        // but never when the user typed their own.
        const canSetTitle = !cur || cur === topic.trim() || titleAutoRef.current;
        if (headline) {
          setScript(body);
          if (canSetTitle) { setTitle(headline); titleAutoRef.current = true; }
        } else if (canSetTitle) {
          // No headline in the script — AI-generate a polished title.
          const t = await generateTitle(body || finalText, ctrl.signal);
          if (t && !ctrl.signal.aborted) { setTitle(t); titleAutoRef.current = true; }
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== "AbortError" && !ctrl.signal.aborted) {
        setGenError(humanizeError(err, { operation: "generate script" }));
      }
    } finally {
      // A stopped CLI run can settle after a newer run started — leave that one alone.
      if (abortRef.current === ctrl) {
        setGenerating(false);
        setGenPhase(null);
        abortRef.current = null;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, model, modelReady, platform, viralMode, tone, scriptType, pov, duration, exactLen, wordCount,
      structure, hookType, hookLen, introStyle, introLen, endingStyle, endingCta, endingLen,
      generating, usingAgentic]);

  function handleStop() {
    abortRef.current?.abort();
    setGenerating(false);
    setGenPhase(null);
  }

  // ⌘/Ctrl+Enter generates from anywhere in the tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !generating && topic.trim() && modelReady) {
        e.preventDefault();
        void handleGenerate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleGenerate, generating, topic, modelReady]);

  // ── JSX ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 min-w-0 min-h-0 flex overflow-hidden">

      {/* ═══════════════ CONTROLS COLUMN ═══════════════ */}
      <div className="w-[340px] shrink-0 flex flex-col min-h-0 border-r border-zinc-200 dark:border-white/8 bg-zinc-50/60 dark:bg-[#0b0b0d]">
        <div className="flex items-center gap-2 px-3.5 h-[52px] border-b border-zinc-100 dark:border-white/6 shrink-0">
          <div className="relative flex-1 min-w-0 flex items-center">
            <Pencil size={11} className="text-zinc-300 dark:text-zinc-600 shrink-0 mr-1.5" />
            <input value={title} onChange={e => { setTitle(e.target.value); titleAutoRef.current = false; }} placeholder={topic.trim() ? topic.slice(0, 38) : "Untitled script"}
              className="w-full bg-transparent border-none outline-none text-[13.5px] font-bold text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 placeholder:font-medium truncate" />
          </div>
          <button onClick={handleNewScript} disabled={generating} title="New script"
            className="w-7 h-7 -mr-1 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/6 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed">
            <Plus size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3.5 py-2.5 flex flex-col gap-2 min-h-0">

      {/* ── Prompt Card (grows to fill spare height, but never shrinks below
            its content — so a short window scrolls the panel instead of clipping) ── */}
      <div className="grow shrink-0 flex flex-col bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 rounded-2xl overflow-hidden">

        {/* Topic header */}
        <div className="shrink-0 flex items-center gap-2 px-3.5 py-2 border-b border-zinc-100 dark:border-white/6">
          <Sparkles size={12} className="text-violet-500 shrink-0" />
          <span className="text-[11.5px] font-semibold text-zinc-500 dark:text-zinc-400 flex-1">Topic / Prompt</span>
          <span className="text-[11px] text-zinc-400 tabular-nums">{topic.length} / 300</span>
        </div>

        <textarea
          value={topic}
          onChange={e => setTopic(e.target.value.slice(0, 300))}
          placeholder={`e.g. Why humans need 8 hours of sleep`}
          className="flex-1 min-h-[110px] w-full bg-transparent border-none outline-none resize-none text-[13.5px] text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400 px-3.5 py-2.5 leading-snug font-[inherit]"
          style={{ boxSizing: "border-box" }}
        />

        {/* Model row (compact footer) */}
        <div className="shrink-0 flex items-center gap-2 px-3.5 py-1.5 border-t border-zinc-100 dark:border-white/6 bg-zinc-50 dark:bg-white/2">
          <div className="flex items-center gap-1.5 shrink-0">
            <Sparkles size={11} className="text-violet-500" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">AI Model</span>
          </div>
          <div className="flex-1 min-w-0 flex justify-end">
            <ModelPicker value={model} onChange={setModel} brains={brains} loading={brainsLoading} />
          </div>
        </div>

        {/* Error banner */}
        {genError && (
          <div className="flex items-start gap-2.5 px-4 py-3 bg-red-50 dark:bg-red-500/8 border-t border-red-100 dark:border-red-500/20">
            <AlertCircle size={13} className="text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[12px] text-red-600 dark:text-red-400">{genError}</p>
              <button onClick={() => openSettings("local-ai")} className="text-[11px] text-red-500 underline hover:no-underline cursor-pointer border-none bg-transparent p-0">
                Go to Settings → Local AI
              </button>
            </div>
            <button onClick={() => setGenError("")} className="text-red-400 hover:text-red-600 bg-transparent border-none cursor-pointer text-[16px] leading-none shrink-0">×</button>
          </div>
        )}
      </div>

      {/* ── Advanced Options ── */}
      <div className="shrink-0 rounded-2xl border border-zinc-200/80 dark:border-white/8 bg-white dark:bg-white/3 overflow-hidden">
        <button
          onClick={() => setAdvanced(a => !a)}
          className="w-full flex items-center gap-2.5 px-3.5 py-2 border-none cursor-pointer font-[inherit] bg-transparent">
          <div className={`flex items-center justify-center w-6 h-6 rounded-[7px] transition-colors ${advanced ? "bg-violet-500" : "bg-zinc-100 dark:bg-white/8"}`}>
            <Settings2 size={12} className={advanced ? "text-white" : "text-zinc-400"} />
          </div>
          <span className="text-[13px] font-semibold flex-1 text-left text-zinc-800 dark:text-zinc-100">Advanced Options</span>
          {!advanced && viralMode && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-500 border border-violet-500/20">🔥 Viral</span>
          )}
          <ChevronDown size={15} className={`shrink-0 transition-transform ${advanced ? "text-violet-500 rotate-180" : "text-zinc-400"}`} />
        </button>

        {advanced && (
          <div className="px-3 pb-3.5 pt-1.5 flex flex-col gap-2">

            {/* Viral mode — standalone compact row */}
            <div className={`${GROUP_CLS} ${viralMode ? "ring-1 ring-violet-500/25" : ""}`}>
              <div className="flex items-center gap-2.5 px-3 py-1.5">
                <div className="flex items-center justify-center w-6 h-6 rounded-md shrink-0 transition-colors" style={{ background: viralMode ? "var(--brand-gradient)" : undefined, backgroundColor: viralMode ? undefined : "rgba(120,120,128,0.12)" }}>
                  <TrendingUp size={12} className={viralMode ? "text-white" : "text-zinc-400 dark:text-zinc-500"} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100 leading-tight">Viral Mode</p>
                  <p className="text-[10.5px] text-zinc-400 leading-snug truncate">Open loops · curiosity gaps · pattern interrupts</p>
                </div>
                <MiniToggle on={viralMode} onChange={setViralMode} />
              </div>
            </div>

            {/* GROUP · Content — 2-col compact tiles */}
            <div>
              <p className={SECTION_LBL}>Content</p>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { label: "Tone",     dropLabel: "Select Tone",          value: tone,       set: setTone,       options: TONES         },
                  { label: "Type",     dropLabel: "Select Script Type",   value: scriptType, set: setScriptType, options: SCRIPT_TYPES, searchable: true },
                  { label: "POV",      dropLabel: "Select Point of View", value: pov,        set: setPov,        options: POVS          },
                  { label: "Duration", dropLabel: "Select Duration",      value: duration,   set: setDuration,   options: DURATIONS, disabled: exactLen },
                ] as { label: string; dropLabel: string; value: string; set: (v: string) => void; options: readonly string[]; disabled?: boolean; searchable?: boolean }[]).map(({ label, dropLabel, value, set, options, disabled, searchable }) => (
                  <div key={label} className="min-w-0 rounded-xl border border-zinc-200/70 dark:border-white/8 bg-zinc-50/70 dark:bg-white/3 px-2.5 py-1.5" style={{ opacity: disabled ? 0.5 : 1 }}>
                    <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500 mb-0.5">
                      {label}{disabled && <Lock size={9} className="text-zinc-400 shrink-0" />}
                    </p>
                    <SelectBox plain value={value} onChange={v => set(v as never)} options={options} disabled={!!disabled} searchable={!!searchable} label={dropLabel} />
                  </div>
                ))}
              </div>
            </div>

            {/* Exact word count — standalone compact row */}
            <div className={GROUP_CLS}>
              <div className="flex items-center gap-2.5 px-3 py-1.5">
                <div className="flex items-center justify-center w-6 h-6 rounded-md shrink-0 transition-colors" style={{ background: exactLen ? "var(--brand-gradient)" : undefined, backgroundColor: exactLen ? undefined : "rgba(120,120,128,0.12)" }}>
                  <Hash size={12} className={exactLen ? "text-white" : "text-zinc-400 dark:text-zinc-500"} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100 leading-tight">Exact word count</p>
                  <p className="text-[10.5px] text-zinc-400 leading-snug truncate">Override the estimated duration</p>
                </div>
                <MiniToggle on={exactLen} onChange={setExactLen} />
              </div>
                {exactLen && (
                  <div className="px-3.5 pt-2.5 pb-3">
                    <div className="flex items-baseline justify-center gap-2 mb-2.5">
                      <span className="text-[20px] font-bold text-violet-500 tabular-nums leading-none">{fmtWords(wordCount)}</span>
                      <span className="text-[11.5px] font-semibold text-zinc-400">words · {fmtDuration(wordCount)}</span>
                      {wordCount > AGENTIC_THRESHOLD && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-[10px] font-semibold text-violet-500">
                          <Loader2 size={8} />{numSections} sections
                        </span>
                      )}
                    </div>
                    <RangeSlider value={wordCount} onChange={setWordCount} min={500} max={50000} step={100} />
                    <div className="flex gap-1.5 mt-3.5">
                      {PRESETS.map(({ label, value }) => (
                        <button key={value} onClick={() => setWordCount(value)}
                          className={`flex-1 h-8 rounded-lg text-[11px] font-semibold cursor-pointer font-[inherit] transition-all duration-150 ${
                            wordCount === value
                              ? "text-white shadow-sm"
                              : "bg-white dark:bg-white/5 text-zinc-400 dark:text-zinc-500 border border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/15 hover:text-zinc-600 dark:hover:text-zinc-300"
                          }`}
                          style={wordCount === value ? { background: "var(--brand-gradient)" } : {}}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {wordCount > AGENTIC_THRESHOLD && (
                      <p className="text-[11px] text-zinc-400 mt-3 flex items-center gap-1.5 leading-snug">
                        <Loader2 size={11} className="text-violet-500/70 shrink-0" />
                        <span>Long script — AI plans {numSections} sections and writes them one by one</span>
                      </p>
                    )}
                  </div>
                )}
              </div>

            {/* GROUP · Structure */}
            <div>
              <div className="flex items-center justify-between gap-2 px-1.5 mb-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">Structure</p>
                <button onClick={() => setShowSectionDetail(v => !v)}
                  className="flex items-center gap-0.5 text-[10.5px] font-semibold text-violet-500 hover:text-violet-600 cursor-pointer bg-transparent border-none p-0 font-[inherit]">
                  {showSectionDetail ? "Hide" : "Customize"}
                  <ChevronDown size={11} className={`transition-transform ${showSectionDetail ? "rotate-180" : ""}`} />
                </button>
              </div>
              <div className={GROUP_CLS}>
                <div className="px-3 py-2.5 flex flex-wrap gap-1.5">
                  {STRUCTURES.map(s => {
                    const on = structure.includes(s);
                    return (
                      <button key={s} onClick={() => toggleStructure(s)}
                        className={`flex items-center gap-1.5 h-7 px-3 rounded-full text-[11.5px] font-semibold cursor-pointer font-[inherit] border transition-all duration-150 ${
                          on
                            ? "bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400"
                            : "bg-white dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-400 hover:border-zinc-300 dark:hover:border-white/20 hover:text-zinc-500"
                        }`}>
                        <span className="w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-200"
                          style={{ background: on ? "#22c55e" : "#d4d4d8", boxShadow: on ? "0 0 5px #22c55e" : "none" }} />
                        {s}
                      </button>
                    );
                  })}
                </div>
                {showSectionDetail && structure.includes("Hook") && (
                  <div className="px-3.5 py-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500 mb-1">
                      <span className="w-1 h-3 rounded-full bg-green-500/70 shrink-0" />Hook
                    </p>
                    <div className="flex items-center justify-between gap-3 py-1">
                      <span className="text-[12px] text-zinc-600 dark:text-zinc-300">Style</span>
                      <SelectBox plain value={hookType} onChange={setHookType} options={HOOK_TYPES} label="Hook Style" />
                    </div>
                    <div className="flex items-center justify-between gap-3 py-1">
                      <span className="text-[12px] text-zinc-600 dark:text-zinc-300">Length</span>
                      <SelectBox plain value={hookLen} onChange={setHookLen} options={HOOK_LENGTHS} label="Hook Length" />
                    </div>
                  </div>
                )}
                {showSectionDetail && structure.includes("Intro") && (
                  <div className="px-3.5 py-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500 mb-1">
                      <span className="w-1 h-3 rounded-full bg-green-500/70 shrink-0" />Intro
                    </p>
                    <div className="flex items-center justify-between gap-3 py-1">
                      <span className="text-[12px] text-zinc-600 dark:text-zinc-300">Style</span>
                      <SelectBox plain value={introStyle} onChange={setIntroStyle} options={INTRO_STYLES} label="Intro Style" />
                    </div>
                    <div className="flex items-center justify-between gap-3 py-1">
                      <span className="text-[12px] text-zinc-600 dark:text-zinc-300">Length</span>
                      <SelectBox plain value={introLen} onChange={setIntroLen} options={INTRO_LENGTHS} label="Intro Length" />
                    </div>
                  </div>
                )}
                {showSectionDetail && structure.includes("Ending") && (
                  <div className="px-3.5 py-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500 mb-1">
                      <span className="w-1 h-3 rounded-full bg-green-500/70 shrink-0" />Ending
                    </p>
                    <div className="flex items-center justify-between gap-3 py-1">
                      <span className="text-[12px] text-zinc-600 dark:text-zinc-300">Style</span>
                      <SelectBox plain value={endingStyle} onChange={setEndingStyle} options={ENDING_STYLES} label="Ending Style" />
                    </div>
                    <div className="flex items-center justify-between gap-3 py-1">
                      <span className="text-[12px] text-zinc-600 dark:text-zinc-300">Call to action</span>
                      <SelectBox plain value={endingCta} onChange={setEndingCta} options={ENDING_CTAS} label="Call to Action" />
                    </div>
                    <div className="flex items-center justify-between gap-3 py-1">
                      <span className="text-[12px] text-zinc-600 dark:text-zinc-300">Length</span>
                      <SelectBox plain value={endingLen} onChange={setEndingLen} options={ENDING_LENGTHS} label="Ending Length" />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
        </div>{/* /controls scroll */}

        {/* Sticky generate footer — always visible */}
        <div className="shrink-0 px-3.5 py-3 border-t border-zinc-200 dark:border-white/8 bg-white dark:bg-[#0e0e11] flex flex-col gap-2">
          {usingAgentic && (
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px]">
              <span className="text-zinc-500 dark:text-zinc-400">{numSections} sections</span>
            </div>
          )}
          {generating ? (
            <button
              onClick={handleStop}
              className="w-full h-10 flex items-center justify-center gap-2 rounded-xl text-[13px] font-semibold cursor-pointer border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 text-zinc-600 dark:text-zinc-300 hover:border-red-300 dark:hover:border-red-500/40 hover:text-red-500 transition-all">
              <Square size={12} className="fill-current" /> Stop generating
            </button>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={!topic.trim() || !modelReady}
              title={modelReady ? undefined : brainsLoading ? "Detecting local AI…" : "Install a local AI model first"}
              className="w-full h-10 flex items-center justify-center gap-2 rounded-xl text-[13px] font-bold text-white cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: "var(--brand-gradient)" }}>
              <Wand2 size={14} />
              {usingAgentic ? "Generate Script (Agentic)" : "Generate Script"}
            </button>
          )}
        </div>
      </div>{/* /controls column */}

      {/* ═══════════════ OUTPUT COLUMN ═══════════════ */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 px-4 py-4 gap-4 bg-zinc-50 dark:bg-[#0b0b0d]">

      {/* ── Agentic progress panel ── */}
      {genPhase && (
        <div className="bg-white dark:bg-white/3 border border-violet-200 dark:border-violet-500/25 rounded-2xl overflow-hidden">
          <div className="px-4 py-3.5">
            <div className="flex items-center gap-2.5 mb-3">
              <Loader2 size={13} className="text-violet-500 animate-spin shrink-0" />
              <span className="text-[12.5px] font-semibold text-zinc-600 dark:text-zinc-200">
                {genPhase.kind === "planning" && "Planning script structure…"}
                {genPhase.kind === "writing" && `Writing: ${genPhase.title}`}
              </span>
              {genPhase.kind === "writing" && (
                <span className="ml-auto text-[11px] text-zinc-400 tabular-nums shrink-0">
                  {genPhase.current} / {genPhase.total}
                </span>
              )}
            </div>

            {/* Section dots (max 15, then show bar only) */}
            {genPhase.kind === "writing" && genPhase.total <= 15 && (
              <div className="flex gap-1 mb-2.5">
                {Array.from({ length: genPhase.total }, (_, i) => (
                  <div key={i} className={`flex-1 h-1.5 rounded-full transition-all duration-500 ${
                    i < genPhase.current - 1
                      ? "bg-green-500"
                      : i === genPhase.current - 1
                      ? "bg-violet-500"
                      : "bg-zinc-100 dark:bg-white/10"
                  }`} />
                ))}
              </div>
            )}

            {/* Progress bar */}
            <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: `${genPhase.kind === "planning" ? 5 : genProgress}%`, background: "var(--brand-gradient)" }} />
            </div>

            {genPhase.kind === "writing" && editorWords > 0 && (
              <p className="text-[11px] text-zinc-400 mt-2 flex items-center gap-1">
                <Type size={9} className="shrink-0" />
                <span className="tabular-nums">{editorWords.toLocaleString()} words written so far</span>
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Script Editor ── */}
      <div className={`relative flex-1 min-h-0 flex flex-col bg-white dark:bg-white/3 border rounded-2xl overflow-hidden transition-colors ${generating ? "border-violet-300 dark:border-violet-500/40" : "border-zinc-200 dark:border-white/8"}`}>
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-zinc-100 dark:border-white/6 shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <Type size={13} className="text-zinc-400 shrink-0" />
            <span className="text-[12.5px] font-semibold text-zinc-600 dark:text-zinc-300 shrink-0">Script</span>
            {generating && !genPhase && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-violet-500 animate-pulse shrink-0">
                <Cpu size={10} className="shrink-0" /> Generating…
              </span>
            )}
            <span className="text-zinc-300 dark:text-zinc-700 shrink-0">·</span>
            <span className="text-[11px] text-zinc-400 tabular-nums shrink-0">{editorWords.toLocaleString()} words</span>
            {editorWords > 0 && (
              <span className="hidden md:flex items-center gap-1 text-[11px] text-zinc-400 shrink-0">
                <Clock size={9} /> ~{fmtDuration(editorWords)}
              </span>
            )}
          </div>

          {/* ── Script Health analysis (own slot — never overlaps the controls) ── */}
          {analysis && (
            <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setShowAnalysis(v => !v)}
                  title="Script analysis"
                  className="flex items-center gap-1.5 h-6 pl-1.5 pr-2 rounded-full text-[11px] font-bold cursor-pointer border transition-all hover:opacity-90"
                  style={{ color: analysis.color, background: `${analysis.color}14`, borderColor: `${analysis.color}33` }}
                >
                  <Gauge size={11} />
                  <span className="tabular-nums">{analysis.score}</span>
                  <span className="hidden sm:inline">· {analysis.rating}</span>
                  <ChevronDown size={10} className={`transition-transform ${showAnalysis ? "rotate-180" : ""}`} />
                </button>

                {showAnalysis && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowAnalysis(false)} />
                    <div className="absolute right-0 top-full mt-2 z-50 w-[296px] rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden">
                      {/* Score header */}
                      <div className="px-4 pt-3.5 pb-3 border-b border-zinc-100 dark:border-white/8">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Sparkles size={13} style={{ color: analysis.color }} />
                            <span className="text-[12px] font-bold text-zinc-700 dark:text-zinc-200">Script Health</span>
                          </div>
                          <div className="flex items-baseline gap-1">
                            <span className="text-[19px] font-extrabold tabular-nums leading-none" style={{ color: analysis.color }}>{analysis.score}</span>
                            <span className="text-[10px] font-semibold text-zinc-400">/100</span>
                          </div>
                        </div>
                        <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${analysis.score}%`, background: analysis.color }} />
                        </div>
                        <p className="text-[10.5px] font-semibold mt-1.5" style={{ color: analysis.color }}>{analysis.rating}</p>
                      </div>

                      {/* Metrics grid */}
                      <div className="grid grid-cols-2 gap-px bg-zinc-100 dark:bg-white/8">
                        {[
                          { icon: Type,      label: "Words",       value: analysis.words.toLocaleString() },
                          { icon: Clock,     label: "Duration",    value: `~${analysis.durationLabel}` },
                          { icon: Hash,      label: "Sentences",   value: String(analysis.sentences) },
                          { icon: AlignLeft, label: "Avg / sent.", value: `${analysis.avgSentenceLen.toFixed(1)}w` },
                          { icon: TrendingUp,label: "Readability", value: analysis.gradeLabel },
                          { icon: Anchor,    label: "Hook",        value: analysis.hook.label },
                        ].map(m => (
                          <div key={m.label} className="bg-white dark:bg-zinc-900 px-3 py-2">
                            <div className="flex items-center gap-1 text-zinc-400 dark:text-zinc-500 mb-0.5">
                              <m.icon size={10} />
                              <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">{m.label}</span>
                            </div>
                            <p className="text-[12px] font-bold text-zinc-700 dark:text-zinc-200 truncate">{m.value}</p>
                          </div>
                        ))}
                      </div>

                      {/* Tips / all-clear */}
                      <div className="px-4 py-3">
                        {analysis.tips.length === 0 ? (
                          <div className="flex items-center gap-2 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                            <Check size={13} strokeWidth={2.5} /> Looks great — well-paced and easy to follow.
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">Suggestions</p>
                            {analysis.tips.map((t, i) => (
                              <div key={i} className="flex items-start gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                                <Zap size={11} className="text-violet-500 shrink-0 mt-0.5" />
                                <span>{t}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          <div className="flex items-center gap-1 shrink-0">
            {/* Preview (Notion) / Write (raw) toggle */}
            <div className="flex items-center rounded-lg border border-zinc-200 dark:border-white/10 overflow-hidden mr-1.5">
              <button onClick={() => setEditMode(false)} disabled={generating} title="Reading view"
                className={`flex items-center gap-1 h-7 px-2 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${!writing ? "bg-violet-500/10 text-violet-600 dark:text-violet-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"}`}>
                <Eye size={12} /> Read
              </button>
              <button onClick={() => setEditMode(true)} disabled={generating} title="Edit raw text"
                className={`flex items-center gap-1 h-7 px-2 text-[11px] font-medium border-l border-zinc-200 dark:border-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${writing ? "bg-violet-500/10 text-violet-600 dark:text-violet-400" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"}`}>
                <Pencil size={11} /> Write
              </button>
            </div>
            <button onClick={copyScript} disabled={!script.trim()} title="Copy script"
              className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-white/10 hover:text-zinc-700 dark:hover:text-zinc-200 hover:border-zinc-300 dark:hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}
            </button>
            <button onClick={downloadScript} disabled={!script.trim()} title="Download .txt"
              className={`flex items-center gap-1 h-7 rounded-lg text-[11px] font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${downloaded ? "px-2.5 text-green-600 dark:text-green-400 border-green-500/40 bg-green-500/10" : "w-7 justify-center text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-white/10 hover:text-zinc-700 dark:hover:text-zinc-200 hover:border-zinc-300 dark:hover:border-white/20"}`}>
              {downloaded ? <><Check size={12} className="animate-[savedPop_.45s_cubic-bezier(.34,1.56,.64,1)]" /> Downloaded</> : <Download size={12} />}
            </button>
          </div>
        </div>
        {generating && !script.trim() ? (
          // A CLI brain returns the whole script at once (no streaming), so show
          // an animated "AI is writing" skeleton instead of a dead page.
          <div className="flex-1 min-h-0 overflow-y-auto">
            <GeneratingSkeleton label={selectedBrain?.label} />
          </div>
        ) : writing ? (
          <RichEditor value={script} onChange={setScript} />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {script.trim() ? (
              // Click anywhere on the rendered script to jump into Write mode
              // (skip if the user is selecting text, so copy/select still works).
              <div
                onClick={() => { if (!window.getSelection()?.toString()) setEditMode(true); }}
                className="cursor-text"
                title="Click to edit"
              >
                <NotionDoc text={script} title={title.trim() || topic.trim() || undefined} />
              </div>
            ) : (
              <button onClick={() => setEditMode(true)}
                className="block w-full max-w-[680px] mx-auto px-6 sm:px-10 py-10 text-left bg-transparent border-none cursor-text font-[inherit] text-[15px] leading-[1.85] text-zinc-400 dark:text-zinc-500">
                Your AI-generated script will appear here. Click to write or paste your own…
              </button>
            )}
          </div>
        )}

        {/* Floating action — turn the written script into a voiceover */}
        {script.trim() && !generating && (
          <button onClick={goToTextToVoice} title="Create a voiceover from this script"
            className="absolute bottom-5 right-5 z-10 flex items-center gap-2 h-11 pl-4 pr-5 rounded-xl text-[13px] font-semibold text-white cursor-pointer shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all"
            style={{ background: "var(--brand-gradient)" }}>
            <Mic size={16} /> Generate Audio
          </button>
        )}
      </div>

      {/* ── Hint when no models available ── */}
      {!brainsLoading && !hasAnyModel && (
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/[0.02]">
          <Cpu size={13} className="text-zinc-400 shrink-0" />
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400 flex-1">
            No local AI found. Run AI locally — install Ollama or an AI CLI (Claude Code, Codex, Gemini).{" "}
            <button onClick={() => openSettings("local-ai")} className="text-violet-500 font-medium underline hover:no-underline cursor-pointer border-none bg-transparent p-0">
              Install a local model →
            </button>
            {" "}or{" "}
            <button onClick={() => openSettings("api-keys")} className="text-violet-500 font-medium underline hover:no-underline cursor-pointer border-none bg-transparent p-0 font-[inherit]">
              use your own API key →
            </button>
          </p>
        </div>
      )}
      </div>
    </div>
  );
}
