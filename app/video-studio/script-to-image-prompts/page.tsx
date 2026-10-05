"use client";
import { logDebug } from "@/lib/log";
import { humanizeError } from "@/lib/error/app-error";
import { saveBlobToDisk } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";
import { useState, useRef, useEffect } from "react";
import {
  Image, Upload, Sparkles, Copy, Check, RefreshCw, Download, AlertCircle, X,
  Loader2, Square, ChevronDown, HardDrive, Cpu,
} from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import { SectionTitle } from "@/components/tools/ui";
import { usePreference } from "@/lib/use-preference";
import { useRegisterTask } from "@/hooks/use-register-task";
import { openSettings } from "@/lib/open-settings";
import { runLocalBrain, useLocalBrains } from "@/lib/brain/local-brains";
import { defaultBrainToApply } from "@/lib/brain/local-ai-config";

// ── Types ─────────────────────────────────────────────────────────────────────
type StyleId   = "cinematic" | "photo" | "illustration" | "realistic" | "anime" | "minimal" | "darkfantasy" | "vintage";
type CardState = "generating" | "done" | "error";
type CountMode = "auto" | number;

interface PromptCard {
  id: string;
  index: number;
  prompt: string;
  state: CardState;
  checked: boolean;
}

// ── Styles ────────────────────────────────────────────────────────────────────
const VISUAL_STYLES: { id: StyleId; label: string; color: string }[] = [
  { id: "cinematic",    label: "Cinematic",      color: "#6366f1" },
  { id: "photo",        label: "Photography",    color: "#0ea5e9" },
  { id: "illustration", label: "Illustration",   color: "#0047D1" },
  { id: "realistic",    label: "Hyperrealistic", color: "#0057FC" },
  { id: "anime",        label: "Anime",          color: "#3D7EFD" },
  { id: "minimal",      label: "Minimal",        color: "#14b8a6" },
  { id: "darkfantasy",  label: "Dark Fantasy",   color: "#ef4444" },
  { id: "vintage",      label: "Vintage",        color: "#d97706" },
];

/** Style guidance fed to the LLM so every prompt bakes in a consistent look. */
const STYLE_GUIDE: Record<StyleId, string> = {
  cinematic:    "cinematic lighting, anamorphic bokeh, film grain, shallow depth of field, muted color grade, widescreen",
  photo:        "professional DSLR photography, studio lighting, sharp focus, clean composition, commercial quality",
  illustration: "flat vector illustration, bold geometric shapes, vibrant saturated palette, clean crisp lines, modern digital art",
  realistic:    "hyperrealistic render, 8K ultra-detailed, physically-based lighting, photorealistic textures, lifelike",
  anime:        "anime key visual, soft cel shading, expressive style, painterly backgrounds, vibrant colors, manga aesthetic",
  minimal:      "minimalist composition, generous negative space, muted neutral palette, simple geometric forms",
  darkfantasy:  "dark fantasy atmosphere, dramatic volumetric lighting, moody fog, epic scale, intricate fantasy details",
  vintage:      "vintage 35mm film, warm faded tones, film grain, nostalgic palette, analog aesthetic, retro",
};

const COUNT_PRESETS: CountMode[] = ["auto", 4, 6, 8, 12, 16, 24];

// ── LLM prompt construction ─────────────────────────────────────────────────
function buildSystem(style: StyleId, count: CountMode): string {
  const guide = STYLE_GUIDE[style];
  const countLine = count === "auto"
    ? "Decide the OPTIMAL number of images yourself — about one per distinct visual beat (roughly one image every 2–3 sentences). Favour variety over redundancy."
    : `Produce EXACTLY ${count} image prompts — no more, no fewer. Spread them evenly across the whole script.`;
  return `You are an elite AI image-prompt engineer for faceless-video creators.
First read the ENTIRE script and understand its story, subject and tone. Then write a sequence of image-generation prompts that VISUALLY narrate the script in order.

${countLine}

For EVERY prompt:
- Describe ONE concrete, vivid scene a camera could capture — real subjects, setting, action, lighting, composition and mood. No abstract ideas, no on-screen text, no captions.
- Make it SELF-CONTAINED: an image model sees only this single line, so never say "the previous image", "him" or "her" — re-name the subject each time.
- Keep recurring characters, locations and palette CONSISTENT across the whole set so the images feel like one cohesive video.
- Bake in this visual style: ${guide}.
- 18–40 words. End with quality boosters like "highly detailed, masterpiece, 8k".

Output ONLY the prompts — one prompt per line, in order, with NO numbering, NO blank lines, NO commentary and NO markdown. Each line is one complete prompt.`;
}

function parsePrompts(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["'`]+|["'`]+$/g, "").trim())
    .filter((l) => l.length >= 8 && !/^[-=~_*#]{2,}$/.test(l) && !/^(here are|prompt|image)\b.*:$/i.test(l));
}

// ── LLM call ──────────────────────────────────────────────────────────────────
/** The `usePreference` key the brain choice is stored under. */
const BRAIN_PREF_KEY = "scriptToImage.brain";

/** Ollama (`local:*`) or a CLI brain (`cli:*`) — both run on this machine. */
const runBrain = (engine: string, system: string, user: string, signal: AbortSignal): Promise<string> =>
  runLocalBrain({ engineId: engine, system, prompt: user, signal });

// ── Prompt card ─────────────────────────────────────────────────────────────
function PromptCardEl({ card, style, onCheck, onCopy, onRegenerate, copiedId }: {
  card: PromptCard; style: StyleId;
  onCheck: (id: string) => void; onCopy: (id: string, t: string) => void;
  onRegenerate: (id: string) => void; copiedId: string | null;
}) {
  const styleObj = VISUAL_STYLES.find((s) => s.id === style)!;
  const isCopied = copiedId === card.id;
  const isChecked = card.checked;

  return (
    <div className={`group relative rounded-2xl border transition-all duration-200 overflow-hidden ${
      isChecked
        ? "bg-zinc-50 dark:bg-white/2 border-zinc-200 dark:border-white/6 opacity-70"
        : card.state === "error"
          ? "bg-red-50/50 dark:bg-red-500/5 border-red-200 dark:border-red-500/20"
          : "bg-white dark:bg-white/4 border-zinc-200 dark:border-white/8 hover:border-zinc-300 dark:hover:border-white/14 hover:shadow-sm"
    }`}>
      <div className={`absolute left-0 top-0 bottom-0 w-0.5 transition-colors duration-200 ${
        isChecked ? "bg-emerald-400"
        : card.state === "error" ? "bg-red-400"
        : card.state === "generating" ? "bg-violet-400 animate-pulse"
        : "bg-linear-to-b from-[#3D7EFD] to-[#0047D1]"
      }`} />

      <div className="pl-4 pr-4 pt-3.5 pb-3.5">
        <div className="flex items-center gap-2 mb-2.5">
          <button
            onClick={() => card.state === "done" && onCheck(card.id)}
            className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border transition-all duration-150 ${
              card.state !== "done"
                ? "border-zinc-200 dark:border-white/10 bg-zinc-100 dark:bg-white/5 cursor-not-allowed opacity-40"
                : isChecked
                  ? "bg-emerald-500 border-emerald-500 cursor-pointer"
                  : "border-zinc-300 dark:border-white/20 bg-transparent hover:border-zinc-400 cursor-pointer"
            }`}
          >
            {isChecked && <Check size={10} className="text-white" strokeWidth={3} />}
          </button>
          <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-600 tabular-nums">#{card.index}</span>
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full leading-none"
            style={{ color: styleObj.color, background: `${styleObj.color}15`, border: `1px solid ${styleObj.color}30` }}>
            {styleObj.label}
          </span>
          <div className="flex-1" />
          {card.state === "done" && (
            <>
              <button onClick={() => onCopy(card.id, card.prompt)}
                className={`flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-semibold transition-all duration-150 border cursor-pointer font-[inherit] ${
                  isCopied
                    ? "bg-emerald-500/10 border-emerald-400/30 text-emerald-600 dark:text-emerald-400"
                    : "bg-zinc-50 dark:bg-white/6 border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-200"
                }`}>
                {isCopied ? <Check size={9} strokeWidth={2.5} /> : <Copy size={9} />}
                {isCopied ? "Copied" : "Copy"}
              </button>
              <button onClick={() => onRegenerate(card.id)} title="Regenerate this prompt"
                className="w-6 h-6 rounded-md flex items-center justify-center bg-zinc-50 dark:bg-white/6 border border-zinc-200 dark:border-white/10 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:border-zinc-300 cursor-pointer transition-all duration-150">
                <RefreshCw size={9} />
              </button>
            </>
          )}
        </div>

        {card.state === "generating" ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 size={13} className="text-violet-500 animate-spin shrink-0" />
            <span className="text-[12px] text-zinc-400 dark:text-zinc-500">Rewriting…</span>
          </div>
        ) : (
          <p className={`text-[12.5px] leading-relaxed font-medium transition-colors ${
            isChecked ? "text-zinc-400 dark:text-zinc-600 line-through" : "text-zinc-700 dark:text-zinc-200"
          }`}>
            {card.prompt}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ScriptToImagePromptsPage() {
  const [script, setScript]   = useState("");
  const [style, setStyle]     = useState<StyleId>("cinematic");
  const [count, setCount]     = useState<CountMode>("auto");
  const [customCount, setCustomCount] = useState("");
  const [cards, setCards]     = useState<PromptCard[]>([]);
  const [generating, setGenerating] = useState(false);
  const [filter, setFilter]   = useState<"all" | "undone">("all");
  const [dragOver, setDragOver] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [brainUsed, setBrainUsed] = useState<string | null>(null);

  // Brain (which LLM writes the prompts) — a local CLI or Ollama model on this
  // machine. "" = nothing picked yet → the Settings default applies.
  const [brainEngine, setBrainEngine] = usePreference(BRAIN_PREF_KEY, "");
  const { brains: localBrains, loading: brainsLoading, preferred } = useLocalBrains();
  const [brainOpen, setBrainOpen] = useState(false);
  const brainRef = useRef<HTMLDivElement>(null);

  const fileRef  = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Warn before navigating away while generating prompts; "Leave & stop" aborts.
  useRegisterTask(generating, {
    label: "Script to Image Prompts",
    kind: "studio",
    onAbort: () => abortRef.current?.abort(),
  });

  // Once detection settles, make sure the picker sits on a brain that exists on
  // THIS machine. Untouched (""), or a remembered brain that isn't available here
  // any more → the Settings default brain, else the first detected one. An
  // explicit, still-available choice is never overridden.
  useEffect(() => {
    if (brainsLoading || !localBrains.length) return;
    if (localBrains.some((b) => b.id === brainEngine)) return;
    setBrainEngine(defaultBrainToApply(BRAIN_PREF_KEY, localBrains) ?? preferred?.id ?? localBrains[0].id);
  }, [localBrains, brainsLoading, preferred, brainEngine, setBrainEngine]);

  useEffect(() => {
    if (!brainOpen) return;
    const h = (e: MouseEvent) => { if (brainRef.current && !brainRef.current.contains(e.target as Node)) setBrainOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [brainOpen]);

  // Only brains actually present on THIS machine are offered (a CLI on PATH, or a
  // model Ollama reports) — never a hardcoded fallback that would error on use.
  const selectedBrain = localBrains.find((b) => b.id === brainEngine);
  const brainReady    = !!selectedBrain;
  const noBrains      = !brainsLoading && localBrains.length === 0;
  const brainLabel    = selectedBrain?.label ?? (brainsLoading ? "Detecting local AI…" : "No local AI found");
  const canGenerate   = !!script.trim() && brainReady;

  const effectiveCount: CountMode = count === "auto"
    ? "auto"
    : Math.max(1, Math.min(60, Number(customCount) || (count as number)));

  const doneCount  = cards.filter((c) => c.checked).length;
  const readyCount = cards.filter((c) => c.state === "done").length;
  const hasCards   = cards.length > 0;
  const visible    = filter === "undone" ? cards.filter((c) => !c.checked) : cards;
  const undoneCount = cards.filter((c) => !c.checked && c.state === "done").length;

  async function handleGenerate() {
    if (!script.trim()) { setInputError("Paste a script or upload a .txt file to get started."); return; }
    if (script.trim().length < 40) { setInputError("Add a bit more script — at least a couple of sentences."); return; }
    if (!brainReady) return;
    setInputError(null); setError(null); setFilter("all"); setBrainUsed(null);
    setGenerating(true);
    setCards([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const raw = await runBrain(brainEngine, buildSystem(style, effectiveCount), script.trim(), ctrl.signal);
      // A CLI brain can't be interrupted mid-answer — drop a result that lands after Stop.
      if (ctrl.signal.aborted) return;
      let prompts = parsePrompts(raw);
      if (effectiveCount !== "auto") prompts = prompts.slice(0, effectiveCount);
      if (!prompts.length) throw new Error("The model returned no usable prompts — try again or pick another brain.");
      setBrainUsed(brainLabel);
      setCards(prompts.map((p, i) => ({ id: `${Date.now()}-${i}`, index: i + 1, prompt: p, state: "done", checked: false })));
    } catch (e) {
      if ((e as Error).name !== "AbortError" && !ctrl.signal.aborted) setError(humanizeError(e, { operation: "generate-prompts" }));
    } finally {
      // A stopped CLI run can settle after a newer run started — leave that one alone.
      if (abortRef.current === ctrl) {
        setGenerating(false);
        abortRef.current = null;
      }
    }
  }

  function handleStop() { abortRef.current?.abort(); setGenerating(false); }

  async function handleRegenerate(id: string) {
    const card = cards.find((c) => c.id === id);
    if (!card || !brainReady) return;
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, state: "generating" } : c)));
    const ctrl = new AbortController();
    try {
      const sys = `You are an elite AI image-prompt engineer. Rewrite the given image prompt as ONE fresh alternative — same scene and subject, ${STYLE_GUIDE[style]} style, but a different angle, framing or detail. 18–40 words. Output ONLY the single prompt, no commentary.`;
      const text = await runBrain(brainEngine, sys, card.prompt, ctrl.signal);
      const next = parsePrompts(text)[0] || card.prompt;
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, state: "done", prompt: next } : c)));
    } catch (e) {
      logDebug("script-to-image-prompts", "Regenerate prompt failed, keeping original", e);
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, state: "done" } : c)));
    }
  }

  function handleCopy(id: string, text: string) {
    navigator.clipboard.writeText(text).catch((e: unknown) => { logDebug("script-to-image-prompts", "Clipboard write failed", e); });
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1800);
  }
  function handleCopyAll() {
    const text = cards.filter((c) => c.prompt).map((c, i) => `Prompt #${i + 1}\n${c.prompt}`).join("\n\n");
    navigator.clipboard.writeText(text).catch((e: unknown) => { logDebug("script-to-image-prompts", "Clipboard write failed", e); });
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1800);
  }
  function handleExport() {
    const lines = cards.filter((c) => c.prompt).map((c) => `Prompt #${c.index}\n${c.prompt}`).join("\n\n---\n\n");
    const blob = new Blob([lines], { type: "text/plain" });
    void saveBlobToDisk(blob, "image-prompts.txt").catch(e => surfaceError(e, { operation: "save prompts" }));
  }
  function loadFile(file: File) {
    if (!file.name.endsWith(".txt") && file.type !== "text/plain") { setInputError("Only .txt files are supported."); return; }
    const reader = new FileReader();
    reader.onload = (e) => { setScript((e.target?.result as string) ?? ""); setInputError(null); };
    reader.onerror = () => setInputError("Failed to read file. Please try again.");
    reader.readAsText(file);
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        <StudioToolHeader
          icon={Image}
          title="Script to Image Prompts"
          accent="#3D7EFD"
          backHref="/video-studio"
          backLabel="Video Studio"
          description="Turn a whole script into a coherent set of ready-to-use AI image prompts."
        />

        <div className="flex flex-1 min-h-0">
          {/* ── LEFT: controls ── */}
          {/* Glassy/translucent so the app's ambient background shows through —
              seamless with the (transparent) result area on the right. */}
          <div className="w-[324px] shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-white/55 dark:bg-zinc-900/40 backdrop-blur-xl overflow-hidden">
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-5 space-y-6">

              {/* ── Your Script ── */}
              <div>
                <SectionTitle>Your Script</SectionTitle>
                <div className={`rounded-xl border transition-all duration-200 overflow-hidden ${
                  dragOver ? "border-violet-400 ring-2 ring-violet-400/15"
                  : inputError ? "border-red-300 dark:border-red-500/40"
                  : "border-zinc-200 dark:border-white/10"
                }`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) loadFile(f); }}
                >
                  <textarea value={script}
                    onChange={(e) => { setScript(e.target.value); setInputError(null); }}
                    placeholder={"Paste your full video script here…\n\nThe AI reads the whole thing and writes a cohesive set of image prompts — consistent characters, setting and style across every shot."}
                    rows={9}
                    className="w-full px-3.5 py-3 bg-transparent text-[12.5px] text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-300 dark:placeholder:text-zinc-600 resize-none outline-none leading-relaxed font-[inherit]" />
                  <div className="flex items-center justify-between px-3.5 py-2 border-t border-zinc-100 dark:border-white/6">
                    <span className="text-[10px]">
                      {effectiveCount === "auto"
                        ? <span className="font-semibold text-violet-500">AI picks the best number of images</span>
                        : <span className="font-semibold text-violet-500">{effectiveCount} prompt{effectiveCount !== 1 ? "s" : ""}</span>}
                    </span>
                    <span className="text-[10px] text-zinc-300 dark:text-zinc-600 tabular-nums">{script.length} chars</span>
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <button onClick={() => fileRef.current?.click()}
                    className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg border border-dashed border-zinc-200 dark:border-white/10 text-[11px] font-semibold text-zinc-400 dark:text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:border-zinc-300 dark:hover:border-white/20 bg-transparent cursor-pointer font-[inherit] transition-colors">
                    <Upload size={11} /> Upload .txt
                  </button>
                  {script && (
                    <button onClick={() => { setScript(""); setInputError(null); setCards([]); }}
                      className="h-8 px-3 rounded-lg border border-zinc-200 dark:border-white/10 text-[11px] font-semibold text-zinc-400 hover:text-red-500 bg-transparent cursor-pointer font-[inherit] transition-colors">
                      Clear
                    </button>
                  )}
                  <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; }} />
                </div>

                {inputError && (
                  <div className="mt-2 flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-500/8 border border-red-200 dark:border-red-500/25">
                    <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
                    <p className="text-[12px] text-red-700 dark:text-red-400 leading-snug">{inputError}</p>
                  </div>
                )}
              </div>

              {/* ── How many images ── */}
              <div>
                <SectionTitle>How many images</SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {COUNT_PRESETS.map((c) => {
                    const active = count === c && !(c !== "auto" && customCount);
                    return (
                      <button key={String(c)} onClick={() => { setCount(c); setCustomCount(""); }}
                        className={`min-w-[44px] flex-1 py-2 rounded-lg text-[12px] font-semibold cursor-pointer font-[inherit] border transition-all duration-150 ${
                          active ? "bg-violet-500/8 border-violet-400/30 text-violet-600 dark:text-violet-400"
                                 : "bg-white dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20"
                        }`}>
                        {c === "auto" ? "Auto" : c}
                      </button>
                    );
                  })}
                  <input value={customCount} inputMode="numeric"
                    onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ""); setCustomCount(v); if (v) setCount(Number(v)); }}
                    placeholder="#"
                    className={`w-[52px] py-2 text-center rounded-lg text-[12px] font-semibold font-[inherit] border outline-none transition-all duration-150 ${
                      customCount ? "bg-violet-500/8 border-violet-400/30 text-violet-600 dark:text-violet-400"
                                  : "bg-white dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-500 placeholder:text-zinc-400 focus:border-violet-400/50"
                    }`} />
                </div>
                <p className="mt-2 text-[9.5px] text-zinc-400 dark:text-zinc-600">
                  {count === "auto" ? "The AI chooses one image per visual beat." : "Exactly this many, spread across the script."}
                </p>
              </div>

              {/* ── Visual style ── */}
              <div>
                <SectionTitle>Visual style</SectionTitle>
                <div className="grid grid-cols-4 gap-1.5">
                  {VISUAL_STYLES.map((s) => {
                    const active = style === s.id;
                    return (
                      <button key={s.id} onClick={() => setStyle(s.id)}
                        className={`flex flex-col items-center gap-1 py-2.5 px-1.5 rounded-xl text-center cursor-pointer font-[inherit] border transition-all duration-150 ${
                          active ? "text-zinc-800 dark:text-zinc-100" : "border-zinc-200 dark:border-white/8 bg-white dark:bg-white/4 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-white/6"
                        }`}
                        style={active ? { background: `${s.color}0e`, borderColor: `${s.color}40` } : {}}>
                        <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: `${s.color}${active ? "22" : "12"}` }}>
                          <div className="w-2 h-2 rounded-full" style={{ background: s.color, opacity: active ? 1 : 0.6 }} />
                        </div>
                        <span className="text-[10px] font-semibold leading-tight" style={active ? { color: s.color } : {}}>{s.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

            </div>{/* end scrollable */}

            {/* ── Bottom bar — AI brain + Generate ── */}
            <div className="px-5 py-4 border-t border-zinc-100 dark:border-white/8 shrink-0 space-y-2.5">
              {/* AI brain — sits just above Generate; menu opens upward */}
              <div className="relative" ref={brainRef}>
                <SectionTitle>AI brain</SectionTitle>
                <button type="button" onClick={() => setBrainOpen((v) => !v)}
                  className="w-full h-9 flex items-center justify-between gap-2 px-3 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 cursor-pointer font-[inherit] hover:border-violet-400/60 transition-colors">
                  <span className="flex items-center gap-1.5 min-w-0">
                    {brainsLoading && !selectedBrain
                      ? <Loader2 size={12} className="text-violet-400 shrink-0 animate-spin" />
                      : <HardDrive size={12} className="text-violet-400 shrink-0" />}
                    <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-200 truncate">{brainLabel}</span>
                  </span>
                  <ChevronDown size={13} className={`text-zinc-400 shrink-0 transition-transform ${brainOpen ? "rotate-180" : ""}`} />
                </button>
                {brainOpen && (
                  <div className="absolute z-20 left-0 right-0 bottom-full mb-1 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-lg overflow-hidden max-h-64 overflow-y-auto no-scrollbar">
                    {localBrains.map((b) => (
                      <button key={b.id} type="button"
                        onClick={() => { setBrainEngine(b.id); setBrainOpen(false); }}
                        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer bg-transparent border-none font-[inherit] text-left hover:bg-zinc-100 dark:hover:bg-white/6 transition-colors">
                        <HardDrive size={12} className="text-violet-400 shrink-0" />
                        <span className="text-[11.5px] text-zinc-700 dark:text-zinc-200 truncate flex-1">{b.label}</span>
                        {b.sub && (
                          <span className="text-[8.5px] font-semibold text-zinc-400 dark:text-zinc-500 truncate max-w-[90px] shrink-0">{b.sub}</span>
                        )}
                        {brainEngine === b.id && <Check size={12} className="text-violet-500 shrink-0" />}
                      </button>
                    ))}
                    {localBrains.length === 0 && (
                      <p className="text-[11.5px] text-zinc-400 text-center py-4 px-3">
                        {brainsLoading ? "Detecting local AI…" : "No models available"}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {!generating ? (
                <button onClick={handleGenerate} disabled={!canGenerate}
                  title={brainReady ? undefined : brainsLoading ? "Detecting local AI…" : "Install a local AI model first"}
                  className={`w-full flex items-center justify-center gap-2 h-11 rounded-xl text-[13px] font-bold cursor-pointer border-none font-[inherit] transition-all duration-200 ${
                    !canGenerate ? "bg-zinc-100 dark:bg-white/6 text-zinc-400 cursor-not-allowed" : "text-white shadow-lg hover:opacity-90 active:scale-[0.99]"
                  }`}
                  style={canGenerate ? { background: "linear-gradient(135deg,#3D7EFD,#0047D1)", boxShadow: "0 8px 24px rgba(61,126,253,0.35)" } : {}}>
                  <Sparkles size={14} />
                  {effectiveCount === "auto" ? "Generate Image Prompts" : `Generate ${effectiveCount} Prompt${effectiveCount !== 1 ? "s" : ""}`}
                </button>
              ) : (
                <button onClick={handleStop}
                  className="w-full flex items-center justify-center gap-2 h-11 rounded-xl text-[13px] font-bold bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/25 text-red-600 dark:text-red-400 hover:bg-red-100 cursor-pointer font-[inherit] transition-colors">
                  <X size={13} /> Stop
                </button>
              )}
              {!generating && script.trim() && brainReady && (
                <div className="flex items-center justify-center gap-1.5 text-[10px] text-zinc-400 dark:text-zinc-600">
                  <span>Runs on your machine</span>
                </div>
              )}
              {noBrains && (
                <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/[0.02]">
                  <Cpu size={13} className="text-zinc-400 shrink-0 mt-0.5" />
                  <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 leading-snug">
                    No local AI found. Run AI locally — install Ollama or an AI CLI (Claude Code, Codex, Gemini).{" "}
                    <button onClick={() => openSettings("local-ai")} className="text-violet-500 font-medium underline hover:no-underline cursor-pointer border-none bg-transparent p-0 font-[inherit]">
                      Install a local model →
                    </button>
                  </p>
                </div>
              )}
              {error && (
                <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-red-50 dark:bg-red-500/8 border border-red-200 dark:border-red-500/25">
                  <AlertCircle size={13} className="text-red-500 shrink-0 mt-0.5" />
                  <p className="text-[11.5px] text-red-700 dark:text-red-400 leading-snug">{error}</p>
                </div>
              )}
            </div>
          </div>{/* end LEFT */}

          {/* ── RIGHT: output ── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] shrink-0 gap-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <Image size={13} style={{ color: "#3D7EFD" }} />
                <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300 truncate">
                  {hasCards ? `${readyCount} prompt${readyCount !== 1 ? "s" : ""}` : "No prompts yet"}
                </span>
                {hasCards && doneCount > 0 && (
                  <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                    <span className="text-zinc-300 dark:text-zinc-700">·</span>
                    <span className="font-bold text-emerald-600 dark:text-emerald-400">{doneCount}</span> done
                  </span>
                )}
                {brainUsed && (
                  <span className="hidden md:flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-600">
                    <Sparkles size={9} className="text-violet-400" /> by {brainUsed}
                  </span>
                )}
              </div>

              {hasCards && (
                <div className="flex items-center gap-2 shrink-0">
                  {undoneCount > 0 && (
                    <button onClick={() => setFilter((f) => (f === "undone" ? "all" : "undone"))}
                      className={`flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11px] font-semibold cursor-pointer font-[inherit] border transition-all duration-150 ${
                        filter === "undone" ? "bg-violet-500/8 border-violet-400/30 text-violet-600 dark:text-violet-400" : "bg-white dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300"
                      }`}>
                      <Square size={10} /> {filter === "undone" ? `Showing ${undoneCount} undone` : `${undoneCount} undone`}
                    </button>
                  )}
                  {readyCount > 0 && (<>
                    <button onClick={() => setCards((prev) => prev.map((c) => (c.state === "done" ? { ...c, checked: true } : c)))}
                      className="flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11px] font-semibold bg-white dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 cursor-pointer font-[inherit] transition-colors">
                      <Check size={10} /> All done
                    </button>
                    <button onClick={handleCopyAll}
                      className={`flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11px] font-semibold cursor-pointer font-[inherit] border transition-all duration-150 ${
                        copiedAll ? "bg-emerald-500/8 border-emerald-400/30 text-emerald-600 dark:text-emerald-400" : "bg-white dark:bg-white/5 border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300"
                      }`}>
                      {copiedAll ? <Check size={10} /> : <Copy size={10} />} {copiedAll ? "Copied!" : "Copy all"}
                    </button>
                    <button onClick={handleExport}
                      className="flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11px] font-semibold bg-white dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 cursor-pointer font-[inherit] transition-colors">
                      <Download size={10} /> Export .txt
                    </button>
                  </>)}
                </div>
              )}
            </div>

            {/* Body */}
            {!hasCards && !generating ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "rgba(61,126,253,0.08)", border: "1px solid rgba(61,126,253,0.18)" }}>
                  <Image size={24} color="#3D7EFD" strokeWidth={1.5} />
                </div>
                <p className="text-[14px] font-semibold text-zinc-500 dark:text-zinc-400">No prompts yet</p>
                <p className="text-[12px] text-zinc-400 dark:text-zinc-600 max-w-xs leading-relaxed">
                  Paste your script, choose how many images and a style, then hit Generate — the AI writes a cohesive set.
                </p>
              </div>
            ) : generating && !hasCards ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-5 text-center">
                <Loader2 size={24} className="text-violet-500 animate-spin" />
                <p className="text-[13.5px] font-semibold text-zinc-600 dark:text-zinc-300">Reading your script & writing prompts…</p>
                <p className="text-[11.5px] text-zinc-400 dark:text-zinc-600">Crafting a cohesive, on-style set.</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-5">
                {visible.length > 0 ? (
                  <div className="flex flex-col gap-3 max-w-[760px] mx-auto">
                    {visible.map((card) => (
                      <PromptCardEl key={card.id} card={card} style={style}
                        onCheck={(id) => setCards((prev) => prev.map((c) => (c.id === id ? { ...c, checked: !c.checked } : c)))}
                        onCopy={handleCopy} onRegenerate={handleRegenerate} copiedId={copiedId} />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Check size={20} className="text-emerald-400 mb-3" strokeWidth={2} />
                    <p className="text-[13.5px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1">All prompts marked done!</p>
                    <button onClick={() => setFilter("all")} className="mt-2 text-[11.5px] text-violet-500 hover:text-violet-600 cursor-pointer bg-transparent border-none font-[inherit] transition-colors">Show all prompts</button>
                  </div>
                )}
              </div>
            )}

          </div>{/* end RIGHT */}
        </div>
      </div>
    </AppLayout>
  );
}
