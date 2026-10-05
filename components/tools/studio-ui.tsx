"use client";
import { useRef } from "react";

/* Small shared controls for the Script Writer panel. Colours come from the theme
   tokens in app/globals.css (--c-surface-*, --c-border-*). */
const GRADIENT = "linear-gradient(135deg, #0057FC 0%, #0047D1 100%)";
const FULL = 9999;

export function RangeSlider({ value, onChange, min = 0, max = 100, step = 1 }: {
  value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const trackRef = useRef<HTMLDivElement>(null);

  function compute(clientX: number) {
    const rect = trackRef.current!.getBoundingClientRect();
    const raw = ((clientX - rect.left) / rect.width) * (max - min) + min;
    return Math.max(min, Math.min(max, Math.round(raw / step) * step));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(compute(e.clientX));
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    onChange(compute(e.clientX));
  }

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      style={{ height: 6, borderRadius: FULL, background: "var(--c-surface-3)", border: "1px solid var(--c-border-1)", position: "relative", cursor: "pointer", userSelect: "none", touchAction: "none" }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: `var(--tool-accent, ${GRADIENT})`, borderRadius: FULL }} />
      <div style={{ position: "absolute", top: "50%", left: `${pct}%`, transform: "translate(-50%,-50%)", width: 16, height: 16, borderRadius: FULL, background: "#fff", border: "2px solid var(--tool-accent, #0057FC)", boxShadow: "0 1px 4px rgba(0,0,0,0.4)", pointerEvents: "none" }} />
    </div>
  );
}

export function MiniToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div onClick={() => onChange(!on)} style={{ width: 40, height: 22, borderRadius: FULL, background: on ? GRADIENT : "var(--c-surface-3)", border: `1px solid ${on ? "transparent" : "var(--c-border-2)"}`, cursor: "pointer", position: "relative", transition: "all 0.2s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 2, left: on ? 20 : 2, width: 16, height: 16, borderRadius: FULL, background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
    </div>
  );
}
