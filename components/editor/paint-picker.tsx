"use client";

/**
 * PaintPicker — a Figma-style colour + gradient picker popover.
 *
 * One control for a shape's fill: SOLID (SV square + hue + alpha + hex + eyedropper)
 * or a LINEAR GRADIENT (multi-stop ramp with draggable stops + a per-stop colour
 * editor). It reads/writes the editor's `styles.fill` / `styles.background` through
 * `parsePaint` / `paintToStyle`, emitting the exact `linear-gradient(<deg>deg,
 * <hex[aa]> <pos>%, …)` string the render compiler (compile.ts `parseShapeBackground`
 * → `gradient_buffer_stops`) bakes — so preview == export, N stops and all.
 *
 * Self-contained: portals to <body> so the panel's overflow can't clip it, owns
 * click-outside / Esc, and carries its own colour maths + theme tokens (matching the
 * properties panel's `--cap-*` vars).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pipette, Plus, ArrowLeftRight, RotateCw, X } from "lucide-react";

/* ── Model ──────────────────────────────────────────────────────────────────── */
export type PaintStop = { hex: string; alpha: number; pos: number }; // hex #rrggbb · alpha 0..1 · pos 0..100
export type GradientKind = "linear" | "radial";
export type Paint =
  | { type: "solid"; hex: string; alpha: number }
  | { type: "gradient"; kind: GradientKind; angle: number; stops: PaintStop[] };

const ACCENT = "#0057FC";
const T = {
  bg:        "var(--cap-bg, #212126)",
  bgDeep:    "var(--cap-bg-deep, #1c1c20)",
  border:    "var(--cap-border, rgba(255,255,255,0.10))",
  text:      "var(--cap-text, #e4e4ea)",
  textMuted: "var(--cap-text-muted, #8b8b9a)",
  textDim:   "var(--cap-text-dim, #6e6e7a)",
};
// Transparency checkerboard (behind anything that can be semi-opaque).
const CHECKER =
  "repeating-conic-gradient(rgba(255,255,255,0.22) 0% 25%, rgba(0,0,0,0.28) 0% 50%)";

/* ── Colour maths ───────────────────────────────────────────────────────────── */
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function normHex(hex: string): string {
  let h = (hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "#0057FC";
  return "#" + h.toLowerCase();
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normHex(hex).slice(1);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}
type HSV = { h: number; s: number; v: number };
function rgbToHsv(r: number, g: number, b: number): HSV {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
const hexToHsv = (hex: string): HSV => { const { r, g, b } = hexToRgb(hex); return rgbToHsv(r, g, b); };
const hsvToHex = (h: HSV): string => { const { r, g, b } = hsvToRgb(h.h, h.s, h.v); return rgbToHex(r, g, b); };

/** Any CSS colour string ("#rgb", "#rrggbb(aa)", "rgb()/rgba()") → opaque hex + alpha. */
function parseCssColor(c: string): { hex: string; alpha: number } {
  if (!c || c === "transparent") return { hex: "#0057FC", alpha: c === "transparent" ? 0 : 1 };
  const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i);
  if (m) {
    let a = m[4] == null ? 1 : (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (!isFinite(a)) a = 1;
    return { hex: rgbToHex(+m[1], +m[2], +m[3]), alpha: clamp01(a) };
  }
  const h = c.trim().replace(/^#/, "");
  if (h.length === 8) return { hex: normHex(h), alpha: parseInt(h.slice(6, 8), 16) / 255 };
  if (h.length === 4) return { hex: normHex(h.slice(0, 3)), alpha: parseInt(h[3] + h[3], 16) / 255 };
  return { hex: normHex(h), alpha: 1 };
}

/** Stop → CSS colour token: #rrggbb, or #rrggbbaa when it carries alpha. */
export function stopCssColor(hex: string, alpha: number): string {
  const a = clampByte(clamp01(alpha) * 255);
  return a >= 255 ? normHex(hex) : normHex(hex) + a.toString(16).padStart(2, "0");
}

/* ── Serialise ↔ styles ─────────────────────────────────────────────────────── */
/** Parse a shape's `styles` into a Paint (gradient `background` wins over `fill`). */
export function parsePaint(styles: Record<string, unknown> | undefined): Paint {
  const bg = styles?.background;
  if (typeof bg === "string") {
    const t = bg.trim();
    const lin = t.match(/^linear-gradient\(\s*([\d.]+)deg\s*,\s*([\s\S]+)\)$/i);
    const rad = lin ? null : t.match(/^radial-gradient\(\s*([\s\S]+)\)$/i);
    if (lin || rad) {
      let toks = splitTopLevelCommas((lin ? lin[2] : rad![1]));
      // Drop a leading shape/position spec on radials ("circle at 50% 50%", …).
      if (rad && toks.length >= 3 && /(circle|ellipse|closest-|farthest-|\bat\b)/i.test(toks[0]) && !/#|rgb\(|hsl\(/i.test(toks[0])) {
        toks = toks.slice(1);
      }
      const parsed = toks.map(t2 => t2.trim()).filter(Boolean).map(splitStop);
      const n = parsed.length;
      if (n >= 2) {
        const stops: PaintStop[] = parsed.map((p, i) => {
          const c = parseCssColor(p.color);
          return { hex: c.hex, alpha: c.alpha, pos: p.pos ?? (n <= 1 ? 0 : (i / (n - 1)) * 100) };
        });
        return { type: "gradient", kind: rad ? "radial" : "linear", angle: lin ? (parseFloat(lin[1]) || 0) : 90, stops };
      }
    }
  }
  const fill = typeof styles?.fill === "string" ? (styles.fill as string) : "#0057FC";
  const { hex, alpha } = parseCssColor(fill);
  return { type: "solid", hex, alpha };
}

/** Build the gradient CSS the compiler parses (stops in the order given — the
 *  compiler sorts by position for rendering). Radials are centre → box edge. */
export function buildGradientCss(p: Extract<Paint, { type: "gradient" }>): string {
  const stops = p.stops.map(st => `${stopCssColor(st.hex, st.alpha)} ${Math.round(st.pos)}%`).join(", ");
  return p.kind === "radial"
    ? `radial-gradient(${stops})`
    : `linear-gradient(${Math.round(p.angle)}deg, ${stops})`;
}

/** Paint → the `styles` patch to persist (solid clears any prior gradient). */
export function paintToStyle(p: Paint): { fill?: string; background?: string } {
  return p.type === "solid"
    ? { fill: stopCssColor(p.hex, p.alpha), background: undefined }
    : { background: buildGradientCss(p) };
}

function splitStop(tok: string): { color: string; pos: number | null } {
  const t = tok.trim();
  const m = t.match(/^(.*\S)\s+(-?[\d.]+)%$/);
  if (m) return { color: m[1].trim(), pos: Math.max(0, Math.min(100, parseFloat(m[2]))) };
  return { color: t, pos: null };
}
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map(t => t.trim()).filter(Boolean);
}

/** Colour the ramp shows at position `pos` (0..100) — for previews + adding a stop. */
function sampleStops(stops: PaintStop[], pos: number): { hex: string; alpha: number } {
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  if (!s.length) return { hex: "#ffffff", alpha: 1 };
  if (pos <= s[0].pos) return { hex: s[0].hex, alpha: s[0].alpha };
  const last = s[s.length - 1];
  if (pos >= last.pos) return { hex: last.hex, alpha: last.alpha };
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    if (pos >= a.pos && pos <= b.pos) {
      const f = (pos - a.pos) / Math.max(1e-4, b.pos - a.pos);
      const ca = hexToRgb(a.hex), cb = hexToRgb(b.hex);
      return {
        hex: rgbToHex(ca.r + (cb.r - ca.r) * f, ca.g + (cb.g - ca.g) * f, ca.b + (cb.b - ca.b) * f),
        alpha: a.alpha + (b.alpha - a.alpha) * f,
      };
    }
  }
  return { hex: last.hex, alpha: last.alpha };
}

/** Gather the distinct solid colours already used across the project's overlays —
 *  the "On this project" swatch row. Reads fill / stroke / color / gradient stops. */
export function collectSwatches(overlays: Array<{ styles?: Record<string, unknown> }>): string[] {
  const seen = new Set<string>();
  const push = (c: unknown) => {
    if (typeof c !== "string") return;
    const hex = parseCssColor(c).hex.toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(hex)) seen.add(hex);
  };
  for (const o of overlays) {
    const st = o?.styles;
    if (!st) continue;
    push(st.fill); push(st.stroke); push(st.color);
    if (typeof st.background === "string" && st.background.includes("gradient")) {
      const m = st.background.match(/^linear-gradient\(\s*[\d.]+deg\s*,\s*([\s\S]+)\)$/i);
      if (m) splitTopLevelCommas(m[1]).forEach(tok => push(splitStop(tok).color));
    }
  }
  return [...seen];
}

/** CSS to visualise a Paint on a swatch (checkerboard shows through alpha). */
export function paintPreviewCss(p: Paint): string {
  if (p.type === "solid") return stopCssColor(p.hex, p.alpha);
  const list = [...p.stops].sort((a, b) => a.pos - b.pos)
    .map(s => `${stopCssColor(s.hex, s.alpha)} ${Math.round(s.pos)}%`).join(", ");
  return p.kind === "radial" ? `radial-gradient(circle, ${list})` : `linear-gradient(90deg, ${list})`;
}

/* ── Drag helper ────────────────────────────────────────────────────────────── */
/** Track pointer over an element, reporting 0..1 fractions until mouse-up. */
function beginAreaDrag(el: HTMLElement, e: React.MouseEvent, cb: (fx: number, fy: number) => void) {
  const r = el.getBoundingClientRect();
  const at = (cx: number, cy: number) => cb(clamp01((cx - r.left) / r.width), clamp01((cy - r.top) / r.height));
  at(e.clientX, e.clientY);
  const onMove = (ev: MouseEvent) => at(ev.clientX, ev.clientY);
  const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/* ── Small inputs ───────────────────────────────────────────────────────────── */
function HexField({ hex, onChange, className = "" }: { hex: string; onChange: (h: string) => void; className?: string }) {
  const [val, setVal] = useState(hex.replace("#", "").toUpperCase());
  // Re-sync the draft when the prop changes (adjust-state-during-render pattern).
  const [prevHex, setPrevHex] = useState(hex);
  if (prevHex !== hex) { setPrevHex(hex); setVal(hex.replace("#", "").toUpperCase()); }
  const commit = () => {
    const c = val.replace(/[^0-9a-fA-F]/g, "");
    if (c.length === 6 || c.length === 3) onChange(normHex(c));
    else setVal(hex.replace("#", "").toUpperCase());
  };
  return (
    <input value={val} maxLength={6} onChange={e => setVal(e.target.value.toUpperCase())} onBlur={commit}
      onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`h-7 min-w-0 rounded px-2 text-[12px] font-mono uppercase focus:outline-none ${className}`}
      style={{ background: T.bgDeep, border: `1px solid ${T.border}`, color: T.text }} />
  );
}
function PercentField({ value, onChange, width = 52 }: { value: number; onChange: (v: number) => void; width?: number }) {
  const [val, setVal] = useState(String(Math.round(value)));
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) { setPrevValue(value); setVal(String(Math.round(value))); }
  const commit = () => {
    const n = parseFloat(val);
    if (isFinite(n)) onChange(Math.max(0, Math.min(100, n)));
    else setVal(String(Math.round(value)));
  };
  return (
    <div className="flex items-center h-7 rounded px-1.5 shrink-0" style={{ width, background: T.bgDeep, border: `1px solid ${T.border}` }}>
      <input value={val} onChange={e => setVal(e.target.value)} onBlur={commit}
        onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-full min-w-0 bg-transparent text-[12px] tabular-nums focus:outline-none" style={{ color: T.text }} />
      <span className="text-[11px] shrink-0" style={{ color: T.textDim }}>%</span>
    </div>
  );
}

/* ── Trigger button ─────────────────────────────────────────────────────────── */
/** The full paint control: a swatch that opens the Figma-style picker. Use for a
 *  shape/text FILL that can be a solid OR a gradient. For a plain solid colour
 *  field, prefer `<ColorButton>` (string in/out). `allowGradient={false}` locks it
 *  to solid; `showAlpha={false}` hides the opacity controls. `size` sets the swatch
 *  px (default 24). */
export function PaintButton({ value, onChange, swatches, allowGradient = true, allowRadial = true, showAlpha = true, size = 24, title = "Edit fill" }: {
  value: Paint; onChange: (p: Paint) => void; swatches?: string[];
  allowGradient?: boolean; allowRadial?: boolean; showAlpha?: boolean; size?: number; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)} title={title}
        className="rounded shrink-0 relative cursor-pointer overflow-hidden"
        style={{ width: size, height: size, boxShadow: `0 0 0 1px ${T.border}, 0 0 0 3px ${T.bg}` }}>
        <span className="absolute inset-0" style={{ background: CHECKER, backgroundSize: "8px 8px" }} />
        <span className="absolute inset-0" style={{ background: paintPreviewCss(value) }} />
      </button>
      {open && <PaintPopover anchorRef={btnRef} value={value} onChange={onChange} swatches={swatches}
        allowGradient={allowGradient} allowRadial={allowRadial} showAlpha={showAlpha} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Solid-colour picker over a plain hex string — the drop-in replacement for a
 *  native `<input type="color">`. Emits `#rrggbb`, or `#rrggbbaa` when `alpha` is
 *  on (the caller opts in; otherwise the opacity UI is hidden and 6-hex is emitted).
 *  `value` may be any CSS colour; non-hex falls back gracefully. */
export function ColorButton({ value, onChange, alpha = false, swatches, size = 24, title = "Pick a colour" }: {
  value: string; onChange: (hex: string) => void; alpha?: boolean; swatches?: string[]; size?: number; title?: string;
}) {
  const cur = parseCssColor(value || "#000000");
  const paint: Paint = { type: "solid", hex: cur.hex, alpha: alpha ? cur.alpha : 1 };
  return (
    <PaintButton value={paint} allowGradient={false} showAlpha={alpha} swatches={swatches} size={size} title={title}
      onChange={p => { if (p.type === "solid") onChange(alpha ? stopCssColor(p.hex, p.alpha) : p.hex); }} />
  );
}

/* ── Popover ────────────────────────────────────────────────────────────────── */
function PaintPopover({ anchorRef, value, onChange, swatches, onClose, allowGradient = true, allowRadial = true, showAlpha = true }: {
  anchorRef: React.RefObject<HTMLElement | null>; value: Paint; onChange: (p: Paint) => void; swatches?: string[]; onClose: () => void;
  allowGradient?: boolean; allowRadial?: boolean; showAlpha?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const W = 256;

  // Position beside the anchor (prefer left of the right-hand panel), clamped to view.
  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 460;
    if (!r) { setPos({ left: 120, top: 80 }); return; }
    let left = r.left - W - 12;
    if (left < 8) left = Math.min(window.innerWidth - W - 8, r.right + 12);
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, r.top - 8));
    setPos({ left, top });
  }, [anchorRef]);

  // Dismiss on outside-click / Esc.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [anchorRef, onClose]);

  const isGrad = value.type === "gradient";
  const [sel, setSel] = useState(0);
  const stops = isGrad ? value.stops : [];
  const selIdx = isGrad ? Math.min(sel, stops.length - 1) : 0;
  const active = isGrad ? stops[selIdx] : value; // { hex, alpha } either way

  // HSV mirror of the active colour (kept in sync but not clobbered mid-drag).
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(active.hex));
  const syncKey = `${active.hex}|${selIdx}|${value.type}`;
  const [prevSyncKey, setPrevSyncKey] = useState(syncKey);
  if (prevSyncKey !== syncKey) {
    setPrevSyncKey(syncKey);
    if (hsvToHex(hsv).toLowerCase() !== active.hex.toLowerCase()) setHsv(hexToHsv(active.hex));
  }

  const setActiveColor = (hex: string, alpha = active.alpha) => {
    if (value.type === "solid") onChange({ type: "solid", hex, alpha });
    else onChange({ ...value, stops: value.stops.map((s, i) => (i === selIdx ? { ...s, hex, alpha } : s)) });
  };
  const setActiveAlpha = (alpha: number) => setActiveColor(active.hex, clamp01(alpha));
  const applyHsv = (next: HSV) => { setHsv(next); setActiveColor(hsvToHex(next)); };

  const toSolid = () => {
    if (value.type === "solid") return;
    const s = value.stops[selIdx] ?? value.stops[0];
    onChange({ type: "solid", hex: s.hex, alpha: s.alpha });
  };
  const toGradient = () => {
    if (value.type === "gradient") return;
    onChange({ type: "gradient", kind: "linear", angle: 90, stops: [
      { hex: value.hex, alpha: value.alpha, pos: 0 },
      { hex: "#ffffff", alpha: 1, pos: 100 },
    ] });
    setSel(0);
  };

  const hueRgb = hsvToRgb(hsv.h, 1, 1);
  const hueHex = rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b);

  return createPortal(
    <div ref={ref} onMouseDown={e => e.stopPropagation()}
      className="fixed z-[99999] rounded-xl select-none"
      style={{
        left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: W,
        background: T.bg, border: `1px solid ${T.border}`,
        boxShadow: "0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)",
        maxHeight: "92vh", overflowY: "auto",
      }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1 flex-1">
          {allowGradient ? (
            <>
              <PaintTypeTab active={!isGrad} onClick={toSolid}>Solid</PaintTypeTab>
              <PaintTypeTab active={isGrad} onClick={toGradient}>Gradient</PaintTypeTab>
            </>
          ) : (
            <span className="text-[12px] font-semibold" style={{ color: T.textMuted }}>Color</span>
          )}
        </div>
        <button type="button" onClick={onClose} className="p-1 rounded cursor-pointer" style={{ color: T.textMuted }} title="Close">
          <X size={14} />
        </button>
      </div>

      {/* Gradient controls */}
      {isGrad && (
        <div className="px-3 pb-2 space-y-2">
          <div className="flex items-center gap-1.5">
            {allowRadial ? (
              <select value={value.kind} onChange={e => onChange({ ...value, kind: e.target.value as GradientKind })}
                className="h-7 px-1.5 rounded flex-1 text-[12px] cursor-pointer focus:outline-none"
                style={{ background: T.bgDeep, border: `1px solid ${T.border}`, color: T.text }}>
                <option value="linear">Linear</option>
                <option value="radial">Radial</option>
              </select>
            ) : (
              <div className="h-7 px-2 rounded flex-1 text-[12px] flex items-center" style={{ background: T.bgDeep, border: `1px solid ${T.border}`, color: T.text }}>Linear</div>
            )}
            <IconBtn title="Reverse colours" onClick={() => onChange({ ...value, stops: reverseStops(value.stops) })}><ArrowLeftRight size={13} /></IconBtn>
          </div>
          {(allowRadial ? value.kind === "linear" : true) && (
            <div className="flex items-center gap-2">
              <AngleDial angle={value.angle} onChange={a => onChange({ ...value, angle: a })} />
              <DegreeField value={value.angle} onChange={a => onChange({ ...value, angle: a })} />
              <IconBtn title="Rotate 90°" onClick={() => onChange({ ...value, angle: (Math.round(value.angle) + 90) % 360 })}><RotateCw size={13} /></IconBtn>
            </div>
          )}
          <GradientRamp stops={value.stops} sel={selIdx} onSel={setSel}
            onChange={next => onChange({ ...value, stops: next })} />
        </div>
      )}

      {/* SV square */}
      <div className="px-3">
        <div className="relative w-full rounded-md overflow-hidden cursor-crosshair"
          style={{ height: 148, background: hueHex, boxShadow: `inset 0 0 0 1px ${T.border}` }}
          onMouseDown={e => beginAreaDrag(e.currentTarget, e, (fx, fy) => applyHsv({ ...hsv, s: fx, v: 1 - fy }))}>
          <div className="absolute inset-0" style={{ background: "linear-gradient(to right, #fff, rgba(255,255,255,0))" }} />
          <div className="absolute inset-0" style={{ background: "linear-gradient(to top, #000, rgba(0,0,0,0))" }} />
          <div className="absolute rounded-full pointer-events-none"
            style={{
              left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, transform: "translate(-50%,-50%)",
              width: 14, height: 14, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.35)",
              background: hsvToHex(hsv),
            }} />
        </div>
      </div>

      {/* Eyedropper + hue + alpha */}
      <div className="px-3 pt-2.5 pb-2 flex items-center gap-2.5">
        <Eyedropper onPick={hex => setActiveColor(normHex(hex))} />
        <div className="flex-1 space-y-2.5">
          {/* Hue */}
          <div className="relative h-3 rounded-full cursor-pointer"
            style={{ background: "linear-gradient(to right,#f00 0%,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00 100%)" }}
            onMouseDown={e => beginAreaDrag(e.currentTarget, e, fx => applyHsv({ ...hsv, h: fx * 360 }))}>
            <SliderThumb left={hsv.h / 360} fill={hueHex} />
          </div>
          {/* Alpha */}
          {showAlpha && (
            <div className="relative h-3 rounded-full cursor-pointer overflow-hidden" style={{ boxShadow: `inset 0 0 0 1px ${T.border}` }}
              onMouseDown={e => beginAreaDrag(e.currentTarget, e, fx => setActiveAlpha(fx))}>
              <div className="absolute inset-0" style={{ background: CHECKER, backgroundSize: "8px 8px" }} />
              <div className="absolute inset-0" style={{ background: `linear-gradient(to right, ${stopCssColor(active.hex, 0)}, ${stopCssColor(active.hex, 1)})` }} />
              <SliderThumb left={active.alpha} fill={stopCssColor(active.hex, active.alpha)} />
            </div>
          )}
        </div>
      </div>

      {/* Hex + opacity */}
      <div className="px-3 pb-2.5 flex items-center gap-1.5">
        <div className="flex items-center h-7 px-2 rounded text-[11px] shrink-0" style={{ background: T.bgDeep, border: `1px solid ${T.border}`, color: T.textMuted }}>Hex</div>
        <HexField hex={active.hex} onChange={hex => setActiveColor(hex)} className="flex-1" />
        {showAlpha && <PercentField value={active.alpha * 100} onChange={v => setActiveAlpha(v / 100)} width={58} />}
      </div>

      {/* Stops list */}
      {isGrad && (
        <div className="px-3 pb-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: T.textMuted }}>Stops</span>
            <button type="button" title="Add stop" onClick={() => addStop(value, onChange, setSel)}
              className="w-5 h-5 flex items-center justify-center rounded cursor-pointer" style={{ background: T.bgDeep, border: `1px solid ${T.border}`, color: T.textMuted }}>
              <Plus size={12} />
            </button>
          </div>
          <div className="space-y-1">
            {value.stops.map((s, i) => (
              <div key={i} onClick={() => setSel(i)}
                className="flex items-center gap-1.5 p-1 rounded-md cursor-pointer"
                style={{ background: i === selIdx ? "rgba(0,87,252,0.14)" : "transparent", border: `1px solid ${i === selIdx ? ACCENT : "transparent"}` }}>
                <PercentField value={s.pos} width={52}
                  onChange={v => onChange({ ...value, stops: value.stops.map((st, j) => (j === i ? { ...st, pos: v } : st)) })} />
                <span className="w-5 h-5 rounded shrink-0 relative overflow-hidden" style={{ boxShadow: `0 0 0 1px ${T.border}` }}>
                  <span className="absolute inset-0" style={{ background: CHECKER, backgroundSize: "6px 6px" }} />
                  <span className="absolute inset-0" style={{ background: stopCssColor(s.hex, s.alpha) }} />
                </span>
                <HexField hex={s.hex} onChange={hex => onChange({ ...value, stops: value.stops.map((st, j) => (j === i ? { ...st, hex } : st)) })} className="flex-1" />
                <PercentField value={s.alpha * 100} width={50}
                  onChange={v => onChange({ ...value, stops: value.stops.map((st, j) => (j === i ? { ...st, alpha: v / 100 } : st)) })} />
                <button type="button" title="Remove stop" disabled={value.stops.length <= 2}
                  onClick={e => { e.stopPropagation(); removeStop(value, onChange, i, selIdx, setSel); }}
                  className="w-5 h-5 flex items-center justify-center rounded cursor-pointer disabled:opacity-30 disabled:cursor-default shrink-0"
                  style={{ color: T.textDim }}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Document swatches */}
      {!!swatches?.length && (
        <div className="px-3 pb-3 pt-1" style={{ borderTop: `1px solid ${T.border}` }}>
          <div className="text-[11px] mb-1.5 pt-1.5" style={{ color: T.textMuted }}>On this project</div>
          <div className="flex flex-wrap gap-1">
            {swatches.slice(0, 28).map((c, i) => (
              <button key={i} type="button" title={c.toUpperCase()} onClick={() => setActiveColor(normHex(c))}
                className="w-5 h-5 rounded cursor-pointer" style={{ background: normHex(c), boxShadow: `0 0 0 1px ${T.border}` }} />
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/* ── Sub-parts ──────────────────────────────────────────────────────────────── */
function PaintTypeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="h-7 px-3 rounded-md text-[12px] font-semibold cursor-pointer transition-colors border-none"
      style={{
        background: active ? "rgba(0,87,252,0.16)" : T.bgDeep,
        border: `1px solid ${active ? ACCENT : T.border}`,
        color: active ? ACCENT : T.textMuted,
      }}>{children}</button>
  );
}
function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button type="button" onClick={onClick} title={title}
      className="h-7 w-7 shrink-0 rounded flex items-center justify-center cursor-pointer"
      style={{ background: T.bgDeep, border: `1px solid ${T.border}`, color: T.textMuted }}>{children}</button>
  );
}

/** Circular rotation knob — drag to aim the gradient. CSS angle: 0° up, 90° right. */
function AngleDial({ angle, onChange }: { angle: number; onChange: (a: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const rad = (angle * Math.PI) / 180;
  const dirDeg = (Math.atan2(-Math.cos(rad), Math.sin(rad)) * 180) / Math.PI;
  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = ref.current; if (!el) return;
    const set = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      const dx = cx - (r.left + r.width / 2);
      const dy = cy - (r.top + r.height / 2);
      const mathDeg = (Math.atan2(-dy, dx) * 180) / Math.PI;
      onChange(((Math.round(90 - mathDeg) % 360) + 360) % 360);
    };
    set(e.clientX, e.clientY);
    const onMove = (ev: MouseEvent) => set(ev.clientX, ev.clientY);
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  return (
    <div ref={ref} onMouseDown={drag} title="Drag to rotate"
      className="relative shrink-0 rounded-full cursor-grab active:cursor-grabbing"
      style={{ width: 30, height: 30, background: T.bgDeep, border: `1px solid ${T.border}` }}>
      <span className="absolute rounded-full" style={{ width: 4, height: 4, background: T.textDim, left: "50%", top: "50%", transform: "translate(-50%,-50%)" }} />
      <span className="absolute" style={{ height: 2, width: 12, background: ACCENT, borderRadius: 2, left: "50%", top: "50%", transformOrigin: "1px 50%", transform: `translate(-1px,-50%) rotate(${dirDeg}deg)` }} />
    </div>
  );
}

/** Degree input (0–359) — type or scrub; wraps. */
function DegreeField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [val, setVal] = useState(String(Math.round(value)));
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) { setPrevValue(value); setVal(String(Math.round(value))); }
  const commit = () => {
    const n = parseFloat(val);
    if (isFinite(n)) onChange(((Math.round(n) % 360) + 360) % 360);
    else setVal(String(Math.round(value)));
  };
  return (
    <div className="flex items-center h-7 rounded px-2 flex-1" style={{ background: T.bgDeep, border: `1px solid ${T.border}` }}>
      <input value={val} onChange={e => setVal(e.target.value)} onBlur={commit}
        onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-full min-w-0 bg-transparent text-[12px] tabular-nums focus:outline-none" style={{ color: T.text }} />
      <span className="text-[11px] shrink-0" style={{ color: T.textDim }}>°</span>
    </div>
  );
}
function SliderThumb({ left, fill }: { left: number; fill: string }) {
  return (
    <div className="absolute top-1/2 pointer-events-none rounded-full"
      style={{ left: `${clamp01(left) * 100}%`, transform: "translate(-50%,-50%)", width: 14, height: 14, background: fill, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }} />
  );
}
function Eyedropper({ onPick }: { onPick: (hex: string) => void }) {
  const supported = typeof window !== "undefined" && "EyeDropper" in window;
  if (!supported) return null;
  const pick = async () => {
    try {
      const ED = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const res = await new ED().open();
      if (res?.sRGBHex) onPick(res.sRGBHex);
    } catch { /* dismissed */ }
  };
  return (
    <button type="button" onClick={pick} title="Pick a colour from the screen"
      className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center cursor-pointer"
      style={{ background: T.bgDeep, border: `1px solid ${T.border}`, color: T.textMuted }}>
      <Pipette size={15} />
    </button>
  );
}

/** The gradient ramp with draggable stops. Click empty track to add a stop there. */
function GradientRamp({ stops, sel, onSel, onChange }: {
  stops: PaintStop[]; sel: number; onSel: (i: number) => void; onChange: (next: PaintStop[]) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const rampCss = `linear-gradient(90deg, ${[...stops].sort((a, b) => a.pos - b.pos)
    .map(s => `${stopCssColor(s.hex, s.alpha)} ${Math.round(s.pos)}%`).join(", ")})`;

  const dragStop = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    onSel(i);
    const bar = barRef.current; if (!bar) return;
    const r = bar.getBoundingClientRect();
    const move = (cx: number) => {
      const p = Math.max(0, Math.min(100, ((cx - r.left) / r.width) * 100));
      onChange(stops.map((s, j) => (j === i ? { ...s, pos: p } : s)));
    };
    const onMove = (ev: MouseEvent) => move(ev.clientX);
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const addAt = (e: React.MouseEvent) => {
    const bar = barRef.current; if (!bar) return;
    const r = bar.getBoundingClientRect();
    const pos = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    const c = sampleStops(stops, pos);
    const next = [...stops, { hex: c.hex, alpha: c.alpha, pos }];
    onChange(next);
    onSel(next.length - 1);
  };

  return (
    <div className="relative rounded-md overflow-hidden" style={{ height: 26, boxShadow: `inset 0 0 0 1px ${T.border}` }}>
      <div className="absolute inset-0" style={{ background: CHECKER, backgroundSize: "10px 10px" }} />
      <div ref={barRef} className="absolute inset-0 cursor-copy" style={{ background: rampCss }} onMouseDown={addAt} />
      {stops.map((s, i) => (
        <button key={i} type="button" onMouseDown={dragStop(i)} title={`${Math.round(s.pos)}%`}
          className="absolute rounded-full cursor-ew-resize border-none p-0"
          style={{
            left: `${Math.max(0, Math.min(100, s.pos))}%`, top: "50%", transform: "translate(-50%,-50%)",
            width: i === sel ? 15 : 13, height: i === sel ? 15 : 13, background: stopCssColor(s.hex, s.alpha),
            boxShadow: i === sel
              ? `0 0 0 2px #fff, 0 0 0 3.5px ${ACCENT}, 0 1px 3px rgba(0,0,0,0.6)`
              : "0 0 0 2px #fff, 0 0 0 3px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.6)",
          }} />
      ))}
    </div>
  );
}

/* ── stop ops ───────────────────────────────────────────────────────────────── */
function reverseStops(stops: PaintStop[]): PaintStop[] {
  const rev = [...stops].reverse();
  return stops.map((s, i) => ({ ...rev[i], pos: s.pos }));
}
function addStop(value: Extract<Paint, { type: "gradient" }>, onChange: (p: Paint) => void, setSel: (i: number) => void) {
  const sorted = [...value.stops].sort((a, b) => a.pos - b.pos);
  // Insert into the widest gap.
  let gapPos = 50, best = -1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const g = sorted[i + 1].pos - sorted[i].pos;
    if (g > best) { best = g; gapPos = (sorted[i].pos + sorted[i + 1].pos) / 2; }
  }
  const c = sampleStops(value.stops, gapPos);
  const next = [...value.stops, { hex: c.hex, alpha: c.alpha, pos: gapPos }];
  onChange({ ...value, stops: next });
  setSel(next.length - 1);
}
function removeStop(value: Extract<Paint, { type: "gradient" }>, onChange: (p: Paint) => void, i: number, selIdx: number, setSel: (i: number) => void) {
  if (value.stops.length <= 2) return;
  const next = value.stops.filter((_, j) => j !== i);
  onChange({ ...value, stops: next });
  if (selIdx >= next.length) setSel(next.length - 1);
  else if (i < selIdx) setSel(selIdx - 1);
}
