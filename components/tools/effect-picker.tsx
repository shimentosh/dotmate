"use client";
import React, { useState, useEffect } from "react";
import { FieldLabel } from "./ui";

export type SlideEffect =
  | "none" | "zoom-in" | "zoom-out" | "zoom-in-slow" | "zoom-out-slow"
  | "float" | "shake"
  | "scroll-up" | "scroll-down" | "scroll-left" | "scroll-right"
  | "diagonal-tl" | "diagonal-tr" | "diagonal-bl" | "diagonal-br"
  | "ken-burns-up" | "ken-burns-down"
  | "circular-orbit";

export const ALL_EFFECTS: SlideEffect[] = [
  "none", "zoom-in", "zoom-out", "zoom-in-slow", "zoom-out-slow",
  "float", "shake",
  "scroll-up", "scroll-down", "scroll-left", "scroll-right",
  "diagonal-tl", "diagonal-tr", "diagonal-bl", "diagonal-br",
  "ken-burns-up", "ken-burns-down",
  "circular-orbit",
];

export const EFFECT_LABELS: Record<SlideEffect, string> = {
  "none":           "None",
  "zoom-in":        "Zoom In",       "zoom-out":       "Zoom Out",
  "zoom-in-slow":   "Zoom In Slow",  "zoom-out-slow":  "Zoom Out Slow",
  "float":          "Float",         "shake":          "Shake",
  "scroll-up":      "Scroll Up",     "scroll-down":    "Scroll Down",
  "scroll-left":    "Scroll Left",   "scroll-right":   "Scroll Right",
  "diagonal-tl":    "Diagonal ↖",    "diagonal-tr":    "Diagonal ↗",
  "diagonal-bl":    "Diagonal ↙",    "diagonal-br":    "Diagonal ↘",
  "ken-burns-up":   "Ken Burns ↑",   "ken-burns-down": "Ken Burns ↓",
  "circular-orbit": "Circular Orbit",
};

export const EFFECT_PREVIEW_STYLES: Record<SlideEffect, React.CSSProperties> = {
  "none":           {},
  "zoom-in":        { transform: "scale(1.15)" },
  "zoom-out":       { transform: "scale(1.04)" },
  "zoom-in-slow":   { transform: "scale(1.06)" },
  "zoom-out-slow":  { transform: "scale(1.06)" },
  "float":          { transform: "scale(1.06) translateY(6px)" },
  "shake":          { transform: "scale(1.06) translate(3px, 2px)" },
  "scroll-up":      { transform: "scale(1.15) translateY(-6%)" },
  "scroll-down":    { transform: "scale(1.15) translateY(6%)" },
  "scroll-left":    { transform: "scale(1.15) translateX(-6%)" },
  "scroll-right":   { transform: "scale(1.15) translateX(6%)" },
  "diagonal-tl":    { transform: "scale(1.15) translate(-4%, -4%)" },
  "diagonal-tr":    { transform: "scale(1.15) translate(4%, -4%)" },
  "diagonal-bl":    { transform: "scale(1.15) translate(-4%, 4%)" },
  "diagonal-br":    { transform: "scale(1.15) translate(4%, 4%)" },
  "ken-burns-up":   { transform: "scale(1.12) translateY(-4.5%)" },
  "ken-burns-down": { transform: "scale(1.12) translateY(4.5%)" },
  "circular-orbit": { transform: "scale(1.2) translateX(7%)" },
};

/* ── Animated previews (editor-style cards) ──────────────────────────────────
   Each card animates a sample image with the effect's motion (RAF loop, t∈0–1),
   so the preview reflects the export's motion. */
// Local preview plate (bundled in public/) — no third-party URLs, works offline.
const EFFECT_SAMPLE_IMG = "/transition-preview-a.webp";

const EFFECT_ANIM: Record<SlideEffect, (t: number) => React.CSSProperties> = {
  "none":           () => ({}),
  "zoom-in":        t => ({ transform: `scale(${1.04 + Math.sin(t * Math.PI) * 0.22})` }),
  "zoom-out":       t => ({ transform: `scale(${1.26 - Math.sin(t * Math.PI) * 0.22})` }),
  "zoom-in-slow":   t => ({ transform: `scale(${1.02 + Math.sin(t * Math.PI) * 0.15})` }),
  "zoom-out-slow":  t => ({ transform: `scale(${1.17 - Math.sin(t * Math.PI) * 0.15})` }),
  "float":          t => ({ transform: `translate(${Math.sin(t * Math.PI * 2) * 3}%,${Math.cos(t * Math.PI * 2) * 2}%) rotate(${Math.sin(t * Math.PI * 2) * 1.5}deg) scale(1.1)` }),
  "shake":          t => ({ transform: `translate(${Math.sin(t * Math.PI * 6) * 4}px,${Math.cos(t * Math.PI * 5) * 3}px) scale(1.06)` }),
  "scroll-up":      t => ({ transform: `scale(1.15) translateY(${-Math.sin(t * Math.PI) * 9}%)` }),
  "scroll-down":    t => ({ transform: `scale(1.15) translateY(${Math.sin(t * Math.PI) * 9}%)` }),
  "scroll-left":    t => ({ transform: `scale(1.15) translateX(${-Math.sin(t * Math.PI) * 9}%)` }),
  "scroll-right":   t => ({ transform: `scale(1.15) translateX(${Math.sin(t * Math.PI) * 9}%)` }),
  "diagonal-tl":    t => ({ transform: `scale(1.15) translate(${-Math.sin(t * Math.PI) * 7}%,${-Math.sin(t * Math.PI) * 7}%)` }),
  "diagonal-tr":    t => ({ transform: `scale(1.15) translate(${Math.sin(t * Math.PI) * 7}%,${-Math.sin(t * Math.PI) * 7}%)` }),
  "diagonal-bl":    t => ({ transform: `scale(1.15) translate(${-Math.sin(t * Math.PI) * 7}%,${Math.sin(t * Math.PI) * 7}%)` }),
  "diagonal-br":    t => ({ transform: `scale(1.15) translate(${Math.sin(t * Math.PI) * 7}%,${Math.sin(t * Math.PI) * 7}%)` }),
  "ken-burns-up":   t => ({ transform: `scale(${1.06 + Math.sin(t * Math.PI) * 0.16}) translateY(${-Math.sin(t * Math.PI) * 6}%)` }),
  "ken-burns-down": t => ({ transform: `scale(${1.06 + Math.sin(t * Math.PI) * 0.16}) translateY(${Math.sin(t * Math.PI) * 6}%)` }),
  "circular-orbit": t => ({ transform: `scale(1.12) translate(${Math.cos(t * Math.PI * 2) * 5}%,${Math.sin(t * Math.PI * 2) * 5}%)` }),
};

/** RAF loop driving an effect's per-frame style (t∈0–1, looping over animMs). */
function useEffectAnim(animFn: (t: number) => React.CSSProperties, animMs: number): React.CSSProperties {
  const [style, setStyle] = useState<React.CSSProperties>({});
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setStyle(animFn(((now - t0) % animMs) / animMs));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animFn, animMs]);
  return style;
}

/* Log-scaled speed slider so the slow range (0.05×–1×) gets ~half the track. */
const SPD_MIN = 0.05, SPD_MAX = 4;
const spdToSlider = (s: number) =>
  Math.round(1000 * Math.log(Math.min(SPD_MAX, Math.max(SPD_MIN, s)) / SPD_MIN) / Math.log(SPD_MAX / SPD_MIN));
const spdFromSlider = (v: number) =>
  Math.round(SPD_MIN * Math.pow(SPD_MAX / SPD_MIN, v / 1000) * 100) / 100;

/** One animated effect card (editor style). Loop period scales with `speed`. */
function EffectCard({ effect, selected, previewImage, onToggle, speed = 1 }: {
  effect: SlideEffect; selected: boolean; previewImage?: string | null; onToggle: () => void; speed?: number;
}) {
  // Higher speed → shorter loop (faster motion), mirroring the export's `p = raw * speed`.
  const animMs = Math.min(40000, Math.max(300, 2600 / Math.max(0.05, speed)));
  const animStyle = useEffectAnim(EFFECT_ANIM[effect], animMs);
  const src = previewImage || EFFECT_SAMPLE_IMG;
  return (
    <div
      onClick={onToggle}
      className="hover:scale-[1.04]"
      style={{
        position: "relative", borderRadius: 8, overflow: "hidden", cursor: "pointer",
        boxShadow: selected ? "0 0 0 2px #0057FC" : "0 0 0 1px rgba(255,255,255,0.08)",
        transition: "transform 0.15s, box-shadow 0.15s",
      }}
    >
      <div style={{ width: "100%", aspectRatio: "1/1", background: "#111", overflow: "hidden", position: "relative" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          style={{
            position: "absolute", inset: 0, width: "100%", height: "100%",
            objectFit: "cover", transformOrigin: "center center", transition: "none",
            ...animStyle,
          }}
        />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.72) 0%, transparent 50%)", pointerEvents: "none" }} />
      </div>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "2px 2px 4px", display: "flex", justifyContent: "center" }}>
        <span style={{ fontSize: 7, fontWeight: 600, color: "#fff", textAlign: "center", lineHeight: 1.2, textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>
          {EFFECT_LABELS[effect]}
        </span>
      </div>
      {selected && (
        <div style={{ position: "absolute", top: 3, right: 3, width: 12, height: 12, borderRadius: "50%", background: "#0057FC", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="7" height="7" viewBox="0 0 7 7" fill="none">
            <path d="M1 3.5L2.8 5.3L6 1.5" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </div>
  );
}

interface EffectPickerProps {
  selected: SlideEffect[];
  onChange: (effects: SlideEffect[]) => void;
  previewImage?: string | null;
  hint?: string;
  showSpeed?: boolean;
  speed?: number;
  onSpeedChange?: (v: number) => void;
}

export function EffectPicker({
  selected,
  onChange,
  previewImage,
  hint,
  showSpeed = false,
  speed = 1,
  onSpeedChange,
}: EffectPickerProps) {
  function toggle(effect: SlideEffect) {
    if (effect === "none") { onChange(["none"]); return; }
    if (selected.includes(effect)) {
      const next = selected.filter(e => e !== effect);
      onChange(next.length ? next : ["none"]);
    } else {
      onChange([...selected.filter(e => e !== "none"), effect]);
    }
  }

  return (
    <>
      {hint && (
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-2.5">{hint}</p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 5 }}>
        {ALL_EFFECTS.map(effect => (
          <EffectCard
            key={effect}
            effect={effect}
            selected={selected.includes(effect)}
            previewImage={previewImage}
            onToggle={() => toggle(effect)}
            speed={speed}
          />
        ))}
      </div>

      {showSpeed && onSpeedChange && (
        <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-white/8">
          <div className="flex items-center justify-between mb-1.5">
            <FieldLabel>Speed</FieldLabel>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-zinc-400 tabular-nums">{speed.toFixed(2)}×</span>
              {speed !== 1 && (
                <button
                  onClick={() => onSpeedChange(1)}
                  className="text-[9px] text-violet-500 hover:text-violet-600 cursor-pointer border-none bg-transparent leading-none font-semibold ml-1"
                >
                  reset
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-zinc-400 w-6 shrink-0">0.05×</span>
            <input
              type="range" min={0} max={1000} step={1} value={spdToSlider(speed)}
              onChange={e => onSpeedChange(spdFromSlider(parseInt(e.target.value)))}
              className="flex-1 accent-violet-500 cursor-pointer"
            />
            <span className="text-[9px] text-zinc-400 w-4 shrink-0">4×</span>
          </div>
          <div className="flex justify-between px-2 mt-0.5">
            {[0.1, 0.25, 0.5, 1, 2].map(v => (
              <button
                key={v}
                onClick={() => onSpeedChange(v)}
                className="text-[9px] tabular-nums cursor-pointer border-none bg-transparent transition-colors"
                style={{ color: speed === v ? "#0057FC" : "#a1a1aa" }}
              >
                {v}×
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
