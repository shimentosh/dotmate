"use client";
import { useState, useRef, useCallback, useMemo, useEffect, forwardRef, useImperativeHandle } from "react";
import { ColorButton } from "@/components/editor/paint-picker";
import AppLayout from "@/components/layout/app-layout";
import {
  Upload, X, Music, Type, Trash2, Volume2, AlertCircle,
  CheckCircle2, Loader2, Download,
  Image as ImgIcon, Film, GripVertical,
  ImagePlus, Ratio, ChevronLeft, ChevronRight, Layers, Info,
  SlidersHorizontal, RectangleVertical, RectangleHorizontal, Square,
  Play, Pause,
} from "lucide-react";
import { FieldLabel, inputCls, SectionTitle, ToggleSwitch } from "@/components/tools/ui";
import { EffectPicker, type SlideEffect } from "@/components/tools/effect-picker";
import { ColorAdjustSection } from "@/components/tools/color-adjust";
import { WatermarkSettings, type WatermarkCfg, type WMPos, DEFAULT_WATERMARK } from "@/components/tools/watermark-settings";
import { PreviewErrorCard } from "@/components/preview/preview-error-card";
import { logDebug, logError } from "@/lib/log";
import { humanizeError } from "@/lib/error/app-error";
import { toastError, surfaceError } from "@/lib/toast";
import { useRenderJobs } from "@/store/render-jobs";
import { useRegisterTask } from "@/hooks/use-register-task";

/* ── Types ──────────────────────────────────────────────────────────────── */

type FitMode        = "contain" | "cover" | "blur-fill";
type AspRatio       = "16:9" | "9:16" | "1:1" | "4:5";
type TransitionType = "none" | "fade" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "zoom-fade" | "wipe-left" | "wipe-right" | "blur-fade" | "flash" | "glitch";
type ProgressBarStyle = "bar" | "pill" | "gradient" | "glow" | "neon" | "striped" | "line";
type ProgressBarPos   = "top" | "bottom";

interface ProgressBarCfg {
  enabled:      boolean;
  style:        ProgressBarStyle;
  position:     ProgressBarPos;
  height:       number;   // px at 1080-wide scale
  color:        string;
  color2:       string;   // second color for gradient / striped
  opacity:      number;
  margin:       number;   // inset from edges (px at 1080 scale)
  rounded:      boolean;
  showTrack:    boolean;
  trackColor:   string;
  trackOpacity: number;
}

const DEFAULT_PROGRESS_BAR: ProgressBarCfg = {
  enabled: false, style: "gradient", position: "bottom",
  height: 8, color: "#3D7EFD", color2: "#ec4899",
  opacity: 1, margin: 0, rounded: false,
  showTrack: true, trackColor: "#ffffff", trackOpacity: 0.15,
};

const PB_STYLE_LABELS: Record<ProgressBarStyle, string> = {
  bar:      "Bar",
  pill:     "Pill",
  gradient: "Gradient",
  glow:     "Glow",
  neon:     "Neon",
  striped:  "Striped",
  line:     "Line",
};

// WMPos, WMType, WatermarkCfg, SlideEffect → imported from @/components/tools/*

interface Slide {
  id: string; url: string; name: string; fitMode: FitMode; duration: number; effect: SlideEffect;
  audioSrc?: string | null; audioName?: string | null;
}
interface AudioTrack { id: string; src: string; name: string; durationSecs: number; }

/* ── Constants ───────────────────────────────────────────────────────────── */

const FPS = 30;

const TRANSITION_LABELS: Record<TransitionType, string> = {
  "none":       "None",
  "fade":       "Fade",
  "slide-left": "Slide ←",
  "slide-right":"Slide →",
  "slide-up":   "Slide ↑",
  "slide-down": "Slide ↓",
  "zoom-fade":  "Zoom Fade",
  "wipe-left":  "Wipe ←",
  "wipe-right": "Wipe →",
  "blur-fade":  "Blur Fade",
  "flash":      "Flash",
  "glitch":     "Glitch",
};

const DIMS: Record<AspRatio, { w: number; h: number }> = {
  "16:9": { w: 1280, h: 720  },
  "9:16": { w: 720,  h: 1280 },
  "1:1":  { w: 1080, h: 1080 },
  "4:5":  { w: 864,  h: 1080 },
};
// WM_POSITIONS → moved to @/components/tools/watermark-settings

/* ── Camera effects ──────────────────────────────────────────────────────── */
// SlideEffect, ALL_EFFECTS, EFFECT_LABELS, EFFECT_PREVIEW_STYLES → imported from @/components/tools/effect-picker

const EFFECT_PRESETS: { name: string; effects: SlideEffect[] }[] = [
  { name: "Ken Burns",      effects: ["ken-burns-up","ken-burns-down"] },
  { name: "Dynamic Zoom",  effects: ["zoom-in","zoom-out","diagonal-tr","diagonal-bl"] },
  { name: "Cinematic",     effects: ["scroll-up","scroll-right","scroll-down","scroll-left"] },
  { name: "Float",         effects: ["float"] },
  { name: "Shake",         effects: ["shake"] },
  { name: "Circular Orbit",effects: ["circular-orbit"] },
];

function slideHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* ── Slide timeline strip ─────────────────────────────────────────────────── */

const SEG_COLORS = ["#3D7EFD","#3D7EFD","#3b82f6","#10b981","#f59e0b","#ec4899","#06b6d4","#84cc16"];

function SlideshowTimeline({
  slides, compSlides, totalFrames, currentFrame, onSeek, onReorder, onResize,
}: {
  slides: Slide[];
  compSlides: { url: string; dframes: number; fitMode: FitMode }[];
  totalFrames: number;
  currentFrame: number;
  onSeek: (frame: number) => void;
  onReorder: (from: number, to: number) => void;
  onResize: (idx: number, newDurationSecs: number) => void;
}) {
  const trackRef     = useRef<HTMLDivElement>(null);
  const onSeekRef    = useRef(onSeek);
  const onReorderRef = useRef(onReorder);
  const onResizeRef  = useRef(onResize);
  useEffect(() => { onSeekRef.current    = onSeek;    }, [onSeek]);
  useEffect(() => { onReorderRef.current = onReorder; }, [onReorder]);
  useEffect(() => { onResizeRef.current  = onResize;  }, [onResize]);

  const [scrubbing,   setScrubbing]   = useState(false);
  const [reoActive,   setReoActive]   = useState(false);
  const [reoSrc,      setReoSrc]      = useState<number | null>(null);
  const [reoDst,      setReoDst]      = useState<number | null>(null);
  const [ctrlHeld,    setCtrlHeld]    = useState(false);
  const [resizing,    setResizing]    = useState(false);
  const [resizeSrc,   setResizeSrc]   = useState<number | null>(null); // render copy of resizeSrcRef
  const reoSrcRef             = useRef<number | null>(null);
  const resizeSrcRef          = useRef<number | null>(null);
  const resizeStartXRef       = useRef(0);
  const resizeStartDframesRef = useRef(0);
  const resizeTotalFramesRef  = useRef(0);

  /* ctrl key tracking for cursor / hint */
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.key === "Control") setCtrlHeld(true);  };
    const up = (e: KeyboardEvent) => { if (e.key === "Control") setCtrlHeld(false); };
    window.addEventListener("keydown", dn);
    window.addEventListener("keyup",   up);
    return () => { window.removeEventListener("keydown", dn); window.removeEventListener("keyup", up); };
  }, []);

  /* segs computed per render; keep ref for stable callbacks */
  const segs: { start: number; dframes: number; url: string; widthPct: number }[] = [];
  let c2 = 0;
  for (const s of compSlides) {
    segs.push({ start: c2, dframes: s.dframes, url: s.url, widthPct: (s.dframes / totalFrames) * 100 });
    c2 += s.dframes;
  }
  const segsRef = useRef(segs);
  useEffect(() => { segsRef.current = segs; });

  const frameFromX = useCallback((clientX: number) => {
    if (!trackRef.current) return 0;
    const { left, width } = trackRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - left) / width));
    return Math.round(pct * Math.max(1, totalFrames - 1));
  }, [totalFrames]);

  const segFromX = useCallback((clientX: number) => {
    if (!trackRef.current || segsRef.current.length === 0) return 0;
    const { left, width } = trackRef.current.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientX - left) / width));
    const f    = Math.round(pct * Math.max(1, totalFrames - 1));
    const idx  = segsRef.current.findLastIndex(s => f >= s.start);
    return Math.max(0, Math.min(segsRef.current.length - 1, idx));
  }, [totalFrames]);

  /* scrub drag — stable, onSeek via ref */
  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: MouseEvent) => { e.preventDefault(); onSeekRef.current(frameFromX(e.clientX)); };
    const onUp   = () => setScrubbing(false);
    document.addEventListener("mousemove", onMove, { passive: false });
    document.addEventListener("mouseup",   onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [scrubbing, frameFromX]);

  /* reorder drag — stable, onReorder via ref */
  useEffect(() => {
    if (!reoActive) return;
    const onMove = (e: MouseEvent) => { e.preventDefault(); setReoDst(segFromX(e.clientX)); };
    const onUp   = () => {
      const src = reoSrcRef.current;
      setReoDst(dst => {
        if (src !== null && dst !== null && src !== dst) onReorderRef.current(src, dst);
        return null;
      });
      reoSrcRef.current = null;
      setReoSrc(null);
      setReoActive(false);
    };
    document.addEventListener("mousemove", onMove, { passive: false });
    document.addEventListener("mouseup",   onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [reoActive, segFromX]);

  /* resize drag — adjust individual clip duration */
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      e.preventDefault();
      if (!trackRef.current || resizeSrcRef.current === null) return;
      const { width } = trackRef.current.getBoundingClientRect();
      const deltaX = e.clientX - resizeStartXRef.current;
      const deltaFrames = Math.round((deltaX / width) * resizeTotalFramesRef.current);
      const newDframes = Math.max(Math.round(FPS * 0.5), resizeStartDframesRef.current + deltaFrames);
      const clamped = Math.min(Math.round(FPS * 60), newDframes);
      onResizeRef.current(resizeSrcRef.current, clamped / FPS);
    };
    const onUp = () => { resizeSrcRef.current = null; setResizeSrc(null); setResizing(false); };
    document.addEventListener("mousemove", onMove, { passive: false });
    document.addEventListener("mouseup",   onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [resizing]);

  const phPct     = totalFrames > 1 ? (currentFrame / (totalFrames - 1)) * 100 : 0;
  const activeSeg = Math.max(0, segs.findLastIndex(s => currentFrame >= s.start));

  const fmtTime = (f: number) => {
    const s = f / FPS;
    return `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(Math.floor(s % 60)).padStart(2,"0")}.${String(Math.floor((s % 1) * 10))}`;
  };

  /* start dragging clip `i`'s right edge (resize handle mousedown) */
  const startResize = (e: React.MouseEvent, i: number, dframes: number) => {
    e.preventDefault();
    e.stopPropagation();
    resizeSrcRef.current = i;
    setResizeSrc(i);
    resizeStartXRef.current = e.clientX;
    resizeStartDframesRef.current = dframes;
    resizeTotalFramesRef.current = totalFrames;
    setResizing(true);
  };

  const cursor = resizing ? "col-resize" : scrubbing ? "col-resize" : reoActive ? "grabbing" : ctrlHeld ? "grab" : "pointer";

  return (
    <div
      ref={trackRef}
      className="self-stretch relative select-none"
      style={{ height: 58, background: "#0c0c0e", borderRadius: 12, flexShrink: 0, cursor }}
      onMouseDown={e => {
        e.preventDefault();
        if (e.ctrlKey || ctrlHeld) {
          const idx = segFromX(e.clientX);
          reoSrcRef.current = idx;
          setReoSrc(idx); setReoDst(idx); setReoActive(true);
        } else {
          setScrubbing(true);
          onSeekRef.current(frameFromX(e.clientX));
        }
      }}
    >
      {/* segments (clipped) */}
      <div style={{ position: "absolute", inset: 0, borderRadius: 12, overflow: "hidden" }}>
        {segs.map((seg, i) => {
          const color  = SEG_COLORS[i % SEG_COLORS.length];
          const isAct  = !reoActive && i === activeSeg;
          const isSrc  = reoActive && i === reoSrc;
          const isDst  = reoActive && i === reoDst && i !== reoSrc;
          return (
            <div key={slides[i]?.id ?? i} style={{
              position: "absolute",
              left: `${(seg.start / totalFrames) * 100}%`,
              width: `calc(${seg.widthPct}% - 1px)`,
              top: 0, bottom: 0,
              borderRight: "1px solid rgba(0,0,0,0.5)",
              overflow: "hidden",
              opacity: isSrc ? 0.4 : 1,
              transition: "opacity 0.12s",
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={seg.url} alt="" style={{
                position:"absolute", inset:0, width:"100%", height:"100%",
                objectFit:"cover", opacity: isAct ? 0.48 : 0.25, pointerEvents:"none",
              }} />
              <div style={{ position:"absolute", inset:0, background:color, opacity: isAct ? 0.28 : 0.15 }} />
              {isAct && <div style={{ position:"absolute", inset:0, boxShadow:`inset 0 0 0 1.5px ${color}` }} />}
              {isDst && <div style={{ position:"absolute", inset:0, background:"rgba(61,126,253,0.12)", boxShadow:"inset 0 0 0 2px #3D7EFD" }} />}
              <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, pointerEvents:"none" }}>
                <span style={{ fontSize:11, fontWeight:700, lineHeight:1, color: isDst ? "#3D7EFD" : isAct ? color : "rgba(255,255,255,0.45)" }}>{i + 1}</span>
                <span style={{ fontSize:9, lineHeight:1, color:"rgba(255,255,255,0.28)" }}>{(seg.dframes / FPS).toFixed(1)}s</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Resize handles — one per clip right edge, outside clipped layer */}
      {!reoActive && segs.map((seg, i) => {
        const rightPct = ((seg.start + seg.dframes) / totalFrames) * 100;
        const isResizingThis = resizing && resizeSrc === i;
        return (
          <div
            key={`rh-${i}`}
            style={{
              position: "absolute",
              top: 0, bottom: 0,
              left: `calc(${rightPct}% - 5px)`,
              width: 10,
              cursor: "col-resize",
              zIndex: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onMouseDown={e => startResize(e, i, seg.dframes)}
          >
            <div style={{
              width: 2,
              height: "55%",
              borderRadius: 2,
              background: isResizingThis ? "#3D7EFD" : "rgba(255,255,255,0.28)",
              transition: "background 0.12s",
            }} />
            {isResizingThis && (
              <div style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: "50%",
                transform: "translateX(-50%)",
                background: "rgba(15,15,18,0.95)",
                border: "1px solid rgba(61,126,253,0.5)",
                color: "#3D7EFD",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "monospace",
                padding: "2px 6px",
                borderRadius: 5,
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}>
                {(seg.dframes / FPS).toFixed(1)}s
              </div>
            )}
          </div>
        );
      })}

      {/* Ctrl held overlay hint */}
      {ctrlHeld && !reoActive && segs.length > 0 && (
        <div style={{
          position:"absolute", inset:0, borderRadius:12,
          border:"1px dashed rgba(61,126,253,0.4)",
          background:"rgba(61,126,253,0.04)",
          display:"flex", alignItems:"center", justifyContent:"center",
          pointerEvents:"none", zIndex:15,
        }}>
          <span style={{ fontSize:10, fontWeight:600, color:"rgba(61,126,253,0.8)", letterSpacing:"0.04em" }}>
            Click &amp; drag to reorder clips
          </span>
        </div>
      )}

      {/* reorder drag label */}
      {reoActive && reoSrc !== null && reoDst !== null && reoSrc !== reoDst && (
        <div style={{
          position:"absolute", bottom:"calc(100% + 8px)", left:"50%", transform:"translateX(-50%)",
          background:"rgba(15,15,18,0.95)", border:"1px solid rgba(61,126,253,0.5)",
          color:"#3D7EFD", fontSize:10, fontWeight:700, fontFamily:"monospace",
          padding:"3px 8px", borderRadius:6, whiteSpace:"nowrap", pointerEvents:"none", zIndex:30,
        }}>
          Clip {reoSrc + 1} → position {reoDst + 1}
        </div>
      )}

      {/* playhead (hidden during reorder so it doesn't confuse) */}
      {!reoActive && (
        <div style={{
          position:"absolute", top:0, bottom:0, left:`${phPct}%`,
          width:2, background:"#3D7EFD", transform:"translateX(-1px)",
          boxShadow:"0 0 8px rgba(61,126,253,0.8)", zIndex:20, pointerEvents:"none",
        }}>
          <div style={{
            position:"absolute", top:-5, left:"50%", transform:"translateX(-50%)",
            width:14, height:14, borderRadius:"50%", background:"#3D7EFD",
            boxShadow:"0 0 0 2px rgba(61,126,253,0.3), 0 2px 6px rgba(0,0,0,0.6)",
          }} />
          {scrubbing && (
            <div style={{
              position:"absolute", bottom:"calc(100% + 8px)", left:"50%", transform:"translateX(-50%)",
              background:"rgba(15,15,18,0.95)", border:"1px solid rgba(61,126,253,0.4)",
              color:"#3D7EFD", fontSize:10, fontWeight:700, fontFamily:"monospace",
              padding:"2px 6px", borderRadius:5, whiteSpace:"nowrap", pointerEvents:"none",
            }}>
              {fmtTime(currentFrame)}
            </div>
          )}
        </div>
      )}

      {segs.length === 0 && (
        <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", borderRadius:12 }}>
          <span style={{ fontSize:11, color:"rgba(255,255,255,0.2)" }}>Add images to see the timeline</span>
        </div>
      )}
    </div>
  );
}

/* ── Canvas renderer ──────────────────────────────────────────────────────── */

function coverFit(iw: number, ih: number, cw: number, ch: number) {
  const s = Math.max(cw / iw, ch / ih);
  return { dw: iw * s, dh: ih * s };
}
function containFit(iw: number, ih: number, cw: number, ch: number) {
  const s = Math.min(cw / iw, ch / ih);
  return { dw: iw * s, dh: ih * s };
}

function computeEffectCanvas(effect: SlideEffect, frame: number, dur: number, cw: number, ch: number, speed = 1) {
  if (effect === "none") return { sx: 1, sy: 1, tx: 0, ty: 0 };
  const raw = dur > 1 ? frame / (dur - 1) : 0;
  const p = Math.min(1, raw * speed);
  const f = frame * speed;
  switch (effect) {
    case "zoom-in":       return { sx: 1 + p * 0.18, sy: 1 + p * 0.18, tx: 0, ty: 0 };
    case "zoom-out":      return { sx: 1.18 - p * 0.18, sy: 1.18 - p * 0.18, tx: 0, ty: 0 };
    case "zoom-in-slow":  return { sx: 1 + p * 0.08, sy: 1 + p * 0.08, tx: 0, ty: 0 };
    case "zoom-out-slow": return { sx: 1.08 - p * 0.08, sy: 1.08 - p * 0.08, tx: 0, ty: 0 };
    case "float":         return { sx: 1.06, sy: 1.06, tx: 0, ty: Math.sin(f * 0.1) * 10 };
    case "shake": {
      const tx = Math.sin(f * 0.7) * 8 + Math.sin(f * 1.3) * 4;
      const ty = Math.sin(f * 0.5 + 1) * 6 + Math.cos(f * 1.1) * 3;
      return { sx: 1.06, sy: 1.06, tx, ty };
    }
    case "scroll-up":    return { sx: 1.15, sy: 1.15, tx: 0, ty: (0.5 - p) * 0.12 * ch };
    case "scroll-down":  return { sx: 1.15, sy: 1.15, tx: 0, ty: (p - 0.5) * 0.12 * ch };
    case "scroll-left":  return { sx: 1.15, sy: 1.15, tx: (0.5 - p) * 0.12 * cw, ty: 0 };
    case "scroll-right": return { sx: 1.15, sy: 1.15, tx: (p - 0.5) * 0.12 * cw, ty: 0 };
    case "diagonal-tl":  return { sx: 1.15, sy: 1.15, tx: (0.5-p)*0.08*cw, ty: (0.5-p)*0.08*ch };
    case "diagonal-tr":  return { sx: 1.15, sy: 1.15, tx: (p-0.5)*0.08*cw, ty: (0.5-p)*0.08*ch };
    case "diagonal-bl":  return { sx: 1.15, sy: 1.15, tx: (0.5-p)*0.08*cw, ty: (p-0.5)*0.08*ch };
    case "diagonal-br":  return { sx: 1.15, sy: 1.15, tx: (p-0.5)*0.08*cw, ty: (p-0.5)*0.08*ch };
    case "ken-burns-up":   return { sx: 1+p*0.15, sy: 1+p*0.15, tx: 0, ty: -p*0.06*ch };
    case "ken-burns-down": return { sx: 1+p*0.15, sy: 1+p*0.15, tx: 0, ty: p*0.06*ch };
    case "circular-orbit": {
      const angle = p * Math.PI * 2;
      return { sx: 1.2, sy: 1.2, tx: Math.cos(angle) * 0.07 * cw, ty: Math.sin(angle) * 0.07 * ch };
    }
    default: return { sx: 1, sy: 1, tx: 0, ty: 0 };
  }
}

function drawFullSlide(
  ctx: OffscreenCanvasRenderingContext2D,
  img: ImageBitmap, cw: number, ch: number,
  fitMode: FitMode, bgColor: string, blurAmount: number,
  effect: SlideEffect, effectFrame: number, effectDur: number,
  brightness = 100, saturation = 100, effectSpeed = 1,
) {
  if (fitMode === "contain") {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, cw, ch);
  } else if (fitMode === "blur-fill") {
    ctx.save();
    ctx.filter = `blur(${blurAmount}px)`;
    const { dw: bdw, dh: bdh } = coverFit(img.width, img.height, cw, ch);
    const bs = 1.12;
    ctx.drawImage(img, (cw - bdw * bs) / 2, (ch - bdh * bs) / 2, bdw * bs, bdh * bs);
    ctx.restore();
  }
  const { sx, sy, tx, ty } = computeEffectCanvas(effect, effectFrame, effectDur, cw, ch, effectSpeed);
  ctx.save();
  ctx.filter = `brightness(${brightness / 100}) saturate(${saturation / 100})`;
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(sx, sy);
  ctx.translate(tx, ty);
  const { dw, dh } = fitMode === "contain" ? containFit(img.width, img.height, cw, ch) : coverFit(img.width, img.height, cw, ch);
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function wmPositionPx(pos: WMPos, w: number, h: number, cw: number, ch: number): { x: number; y: number } {
  const x = pos.endsWith("right") ? cw * 0.95 - w : pos.endsWith("left") ? cw * 0.05 : (cw - w) / 2;
  const y = pos.startsWith("top") ? ch * 0.05 : pos.startsWith("bottom") ? ch * 0.95 - h : (ch - h) / 2;
  return { x, y };
}

function drawWatermarkCanvas(
  ctx: OffscreenCanvasRenderingContext2D,
  wm: WatermarkCfg, wmImg: ImageBitmap | null, cw: number, ch: number,
) {
  if (!wm.enabled) return;
  const sc = cw / 1080;
  ctx.save();
  ctx.globalAlpha = wm.opacity;
  if (wm.type === "text") {
    const fs = wm.fontSize * sc;
    ctx.font = `${wm.fontWeight} ${fs}px "${wm.font}", sans-serif`;
    ctx.fillStyle = wm.color;
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 8 * sc;
    ctx.shadowOffsetY = 2 * sc;
    const text = wm.text || "Watermark";
    const m = ctx.measureText(text);
    const th = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const { x, y } = wmPositionPx(wm.position, m.width, th, cw, ch);
    ctx.fillText(text, x, y + m.actualBoundingBoxAscent);
  } else if (wm.type === "image" && wmImg) {
    const imgW = wm.logoSize * sc;
    const imgH = (wmImg.height / wmImg.width) * imgW;
    const { x, y } = wmPositionPx(wm.position, imgW, imgH, cw, ch);
    if (wm.borderRadius > 0) {
      const r = Math.min(wm.borderRadius * sc, imgW / 2, imgH / 2);
      ctx.beginPath();
      ctx.roundRect(x, y, imgW, imgH, r);
      ctx.clip();
    }
    ctx.drawImage(wmImg, x, y, imgW, imgH);
  }
  ctx.restore();
}

async function prepareAudioBuffer(src: string, durationSecs: number, vol: number, fadeIn: boolean, fadeOut: boolean): Promise<AudioBuffer> {
  const ab = await fetch(src).then(r => r.arrayBuffer());
  const audioCtx = new AudioContext();
  // ALWAYS close the context: `decodeAudioData` rejects on corrupt/unsupported audio, and
  // real-time AudioContexts are a scarce OS resource (~6 concurrent) — a leak on each failed
  // render eventually makes `new AudioContext()` throw and kills every tool until restart.
  try {
    const source = await audioCtx.decodeAudioData(ab);
    const sr = source.sampleRate;
    const targetLen = Math.ceil(durationSecs * sr);
    const fadeSamples = Math.round(sr); // 1 second fade
    const out = audioCtx.createBuffer(source.numberOfChannels, targetLen, sr);
    for (let ch = 0; ch < source.numberOfChannels; ch++) {
      const srcData = source.getChannelData(ch);
      const dst = out.getChannelData(ch);
      for (let i = 0; i < targetLen; i++) {
        let v = vol;
        if (fadeIn  && i < fadeSamples)                v *= i / fadeSamples;
        if (fadeOut && i > targetLen - fadeSamples)    v *= (targetLen - i) / fadeSamples;
        dst[i] = srcData[i % source.length] * Math.max(0, v);
      }
    }
    return out;
  } finally {
    try { await audioCtx.close(); } catch { /* already closed */ }
  }
}

function getAudioDuration(src: string): Promise<number> {
  return new Promise(resolve => {
    const a = new Audio();
    a.onloadedmetadata = () => { resolve(a.duration); a.src = ""; };
    a.onerror = () => resolve(0);
    a.src = src;
  });
}

async function prepareMultiAudioBuffer(
  tracks: { src: string }[],
  durationSecs: number,
  vol: number,
  fadeIn: boolean,
  fadeOut: boolean,
): Promise<AudioBuffer> {
  const audioCtx = new AudioContext();
  // ALWAYS close the context (see prepareAudioBuffer) — a leaked context per failed decode
  // exhausts the ~6 hardware-context cap and breaks every tool until app restart.
  try {
    const decoded = await Promise.all(
      tracks.map(t => fetch(t.src).then(r => r.arrayBuffer()).then(ab => audioCtx.decodeAudioData(ab)))
    );
    const sr = decoded[0].sampleRate;
    const nCh = decoded[0].numberOfChannels;
    const targetLen = Math.ceil(durationSecs * sr);
    const fadeSamples = Math.round(sr);

    // Build concatenated samples
    const concatLen = decoded.reduce((a, d) => a + d.length, 0);

    // Rebuild concat per channel and fill output with looping + fades
    const out = audioCtx.createBuffer(nCh, targetLen, sr);
    for (let ch = 0; ch < nCh; ch++) {
      const concat = new Float32Array(concatLen);
      let off = 0;
      for (const d of decoded) {
        const data = d.numberOfChannels > ch ? d.getChannelData(ch) : new Float32Array(d.length);
        concat.set(data, off);
        off += d.length;
      }
      const dst = out.getChannelData(ch);
      for (let i = 0; i < targetLen; i++) {
        let v = vol;
        if (fadeIn  && i < fadeSamples)              v *= i / fadeSamples;
        if (fadeOut && i > targetLen - fadeSamples)  v *= (targetLen - i) / fadeSamples;
        dst[i] = concat[i % concatLen] * Math.max(0, v);
      }
    }
    return out;
  } finally {
    try { await audioCtx.close(); } catch { /* already closed */ }
  }
}

function blendTransition(
  ctx: OffscreenCanvasRenderingContext2D,
  tempA: OffscreenCanvas,
  tempB: OffscreenCanvas,
  cw: number, ch: number,
  type: TransitionType,
  rawT: number,
  local: number,
) {
  const t = rawT < 0.5 ? 2 * rawT * rawT : -1 + (4 - 2 * rawT) * rawT;

  switch (type) {
    case "none":
      ctx.drawImage(tempB, 0, 0);
      return;
    case "slide-left":
      ctx.drawImage(tempA, -t * cw, 0);
      ctx.drawImage(tempB, (1 - t) * cw, 0);
      return;
    case "slide-right":
      ctx.drawImage(tempA, t * cw, 0);
      ctx.drawImage(tempB, -(1 - t) * cw, 0);
      return;
    case "slide-up":
      ctx.drawImage(tempA, 0, -t * ch);
      ctx.drawImage(tempB, 0, (1 - t) * ch);
      return;
    case "slide-down":
      ctx.drawImage(tempA, 0, t * ch);
      ctx.drawImage(tempB, 0, -(1 - t) * ch);
      return;
    case "zoom-fade":
      ctx.globalAlpha = 1 - rawT;
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.scale(1 + t * 0.3, 1 + t * 0.3);
      ctx.translate(-cw / 2, -ch / 2);
      ctx.drawImage(tempA, 0, 0);
      ctx.restore();
      ctx.globalAlpha = rawT;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
      return;
    case "wipe-left":
      ctx.drawImage(tempA, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, t * cw, ch);
      ctx.clip();
      ctx.drawImage(tempB, 0, 0);
      ctx.restore();
      return;
    case "wipe-right":
      ctx.drawImage(tempA, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(cw * (1 - t), 0, t * cw, ch);
      ctx.clip();
      ctx.drawImage(tempB, 0, 0);
      ctx.restore();
      return;
    case "blur-fade":
      ctx.save();
      try { ctx.filter = `blur(${(1 - rawT) * 14}px)`; } catch (e) { logDebug("image-to-video", "canvas blur filter unsupported", e); }
      ctx.globalAlpha = 1 - rawT * 0.4;
      ctx.drawImage(tempA, 0, 0);
      ctx.restore();
      ctx.globalAlpha = rawT;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
      return;
    case "flash":
      ctx.drawImage(tempA, 0, 0);
      ctx.globalAlpha = rawT;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
      {
        const flashA = Math.sin(rawT * Math.PI) * 0.88;
        if (flashA > 0.01) {
          ctx.fillStyle = "#ffffff";
          ctx.globalAlpha = flashA;
          ctx.fillRect(0, 0, cw, ch);
          ctx.globalAlpha = 1;
        }
      }
      return;
    case "glitch": {
      const peak = Math.sin(rawT * Math.PI);
      const jX = Math.sin(local * 1.7) * 10 * peak;
      ctx.globalAlpha = 1 - rawT;
      ctx.drawImage(tempA, jX, 0);
      ctx.globalAlpha = rawT;
      ctx.drawImage(tempB, -jX * 0.5, 0);
      ctx.globalAlpha = 1;
      if (peak > 0.25) {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = peak * 0.12;
        ctx.drawImage(tempB, jX * 1.5, 0);
        ctx.restore();
      }
      return;
    }
    default: // fade
      ctx.drawImage(tempA, 0, 0);
      ctx.globalAlpha = rawT;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
  }
}

function drawSingleSlideWithTransition(
  ctx: OffscreenCanvasRenderingContext2D,
  img: ImageBitmap,
  cw: number, ch: number,
  fitMode: FitMode, bgColor: string, blurAmount: number,
  effect: SlideEffect, effectFrame: number, effectDur: number,
  brightness: number, saturation: number, effectSpeed: number,
  type: TransitionType,
  p: number,        // 0 = invisible/offscreen, 1 = fully visible
  isOutro: boolean,
  local: number,
) {
  const et = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
  const draw = () => drawFullSlide(ctx, img, cw, ch, fitMode, bgColor, blurAmount, effect, effectFrame, effectDur, brightness, saturation, effectSpeed);

  switch (type) {
    case "none": draw(); break;
    case "fade":
      ctx.globalAlpha = p; draw(); ctx.globalAlpha = 1; break;
    case "slide-left": {
      const tx = !isOutro ? (1-et)*cw : -(1-et)*cw;
      ctx.save(); ctx.translate(tx, 0); draw(); ctx.restore(); break;
    }
    case "slide-right": {
      const tx = !isOutro ? -(1-et)*cw : (1-et)*cw;
      ctx.save(); ctx.translate(tx, 0); draw(); ctx.restore(); break;
    }
    case "slide-up": {
      const ty = !isOutro ? (1-et)*ch : -(1-et)*ch;
      ctx.save(); ctx.translate(0, ty); draw(); ctx.restore(); break;
    }
    case "slide-down": {
      const ty = !isOutro ? -(1-et)*ch : (1-et)*ch;
      ctx.save(); ctx.translate(0, ty); draw(); ctx.restore(); break;
    }
    case "zoom-fade": {
      const sc = 0.75 + et*0.25;
      ctx.globalAlpha = p;
      ctx.save(); ctx.translate(cw/2,ch/2); ctx.scale(sc,sc); ctx.translate(-cw/2,-ch/2);
      draw(); ctx.restore(); ctx.globalAlpha = 1; break;
    }
    case "wipe-left":
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, et*cw, ch); ctx.clip(); draw(); ctx.restore(); break;
    case "wipe-right":
      ctx.save(); ctx.beginPath(); ctx.rect(cw*(1-et), 0, et*cw, ch); ctx.clip(); draw(); ctx.restore(); break;
    case "blur-fade":
      ctx.globalAlpha = p;
      ctx.save(); try { ctx.filter = `blur(${(1-p)*14}px)`; } catch (e) { logDebug("image-to-video", "canvas blur filter unsupported", e); }
      draw(); ctx.restore(); ctx.globalAlpha = 1; break;
    case "flash":
      draw();
      if ((1-p) > 0.01) { ctx.fillStyle="#fff"; ctx.globalAlpha=(1-p)*0.88; ctx.fillRect(0,0,cw,ch); ctx.globalAlpha=1; }
      break;
    case "glitch": {
      const jX = Math.sin(local*1.7)*10*(1-p);
      ctx.globalAlpha = p;
      ctx.save(); ctx.translate(isOutro ? -jX : jX, 0); draw(); ctx.restore();
      ctx.globalAlpha = 1; break;
    }
    default:
      ctx.globalAlpha = p; draw(); ctx.globalAlpha = 1;
  }
}

function roundRectPath(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawProgressBarCanvas(
  ctx: OffscreenCanvasRenderingContext2D,
  cfg: ProgressBarCfg,
  progress: number,
  cw: number, ch: number,
) {
  if (!cfg.enabled) return;
  const scale  = cw / 1080;
  const barH   = Math.max(1, cfg.height * scale);
  const mg     = cfg.margin * scale;
  const p      = Math.max(0, Math.min(1, progress));
  const totalW = cw - mg * 2;
  const fillW  = totalW * p;
  const y      = cfg.position === "top" ? mg : ch - mg - barH;
  const br     = cfg.rounded || cfg.style === "pill" ? barH / 2 : Math.min(3 * scale, barH / 2);

  ctx.save();
  ctx.globalAlpha = cfg.opacity;

  // Track
  if (cfg.showTrack) {
    ctx.save();
    ctx.globalAlpha = cfg.trackOpacity;
    ctx.fillStyle = cfg.trackColor;
    roundRectPath(ctx, mg, y, totalW, barH, br); ctx.fill();
    ctx.restore();
  }

  if (fillW < 1) { ctx.restore(); return; }

  // Fill
  ctx.save();
  if (cfg.style === "glow") {
    ctx.shadowColor = cfg.color;
    ctx.shadowBlur  = 10 * scale;
  } else if (cfg.style === "neon") {
    ctx.shadowColor = cfg.color;
    ctx.shadowBlur  = 18 * scale;
  }

  if (cfg.style === "gradient") {
    const g = ctx.createLinearGradient(mg, 0, mg + totalW, 0);
    g.addColorStop(0, cfg.color); g.addColorStop(1, cfg.color2);
    ctx.fillStyle = g;
  } else if (cfg.style === "striped") {
    const sz = 16 * scale;
    const pc = new OffscreenCanvas(sz, sz);
    const pctx = pc.getContext("2d")!;
    pctx.fillStyle = cfg.color;  pctx.fillRect(0, 0, sz, sz);
    pctx.fillStyle = cfg.color2;
    pctx.beginPath(); pctx.moveTo(0,0); pctx.lineTo(sz/2,0); pctx.lineTo(sz,sz/2); pctx.lineTo(sz,sz); pctx.lineTo(sz/2,sz); pctx.lineTo(0,sz/2); pctx.closePath(); pctx.fill();
    const pat = ctx.createPattern(pc, "repeat");
    ctx.fillStyle = pat ?? cfg.color;
  } else {
    ctx.fillStyle = cfg.color;
  }

  roundRectPath(ctx, mg, y, fillW, barH, br); ctx.fill();
  ctx.restore();

  // Neon white shine pass
  if (cfg.style === "neon") {
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = cfg.color; ctx.shadowBlur = 22 * scale;
    roundRectPath(ctx, mg, y, fillW, barH, br); ctx.fill();
    ctx.restore();
  }

  // Line style: dot at head
  if (cfg.style === "line" && p > 0.01) {
    ctx.save();
    const dotR = barH * 1.8;
    ctx.fillStyle = cfg.color;
    ctx.shadowColor = cfg.color; ctx.shadowBlur = 8 * scale;
    ctx.beginPath(); ctx.arc(mg + fillW, y + barH / 2, dotR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

interface RenderParams {
  slides: { url: string; dframes: number; fitMode: FitMode; effect: SlideEffect }[];
  cw: number; ch: number; fps: number; xfade: number;
  transitionType?: TransitionType;
  progressBar?: ProgressBarCfg;
  audioSrc: string | null;
  audioTracks?: { src: string }[];
  audioVol: number; audioFadeIn: boolean; audioFadeOut: boolean;
  wm: WatermarkCfg; bgColor: string; blurAmount: number;
  brightness?: number; saturation?: number; effectSpeed?: number;
  onProgress: (fraction: number) => void;
}

async function renderSlideshow(params: RenderParams): Promise<Blob> {
  const { slides, cw, ch, fps, xfade, transitionType = "fade", progressBar = DEFAULT_PROGRESS_BAR, audioSrc, audioTracks, audioVol, audioFadeIn, audioFadeOut, wm, bgColor, blurAmount, brightness = 100, saturation = 100, effectSpeed = 1, onProgress } = params;

  // Resources that MUST be released on every exit path (success or error). ImageBitmaps
  // hold full decoded RGBA (outside the JS heap, so GC doesn't reclaim them promptly); the
  // WebCodecs encoder sessions are a scarce pool ("Failed to create VideoEncoder" once
  // exhausted); the staged .part temp file orphans if getBlob() (its only cleanup) is never
  // reached. Without this try/finally an undecodable audio track (or any mid-render throw)
  // leaked all three — see the VtV renderVoiceToVideo finally block this mirrors.
  let images: ImageBitmap[] = [];
  let wmImg: ImageBitmap | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let videoSource: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let audioSource: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let output: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writer: any = null;
  let finalized = false;
  try {
    // Pre-load images
    images = await Promise.all(
      slides.map(s => fetch(s.url).then(r => r.blob()).then(b => createImageBitmap(b)))
    );

    // Pre-load watermark image
    if (wm.enabled && wm.type === "image" && wm.imageUrl) {
      wmImg = await fetch(wm.imageUrl).then(r => r.blob()).then(b => createImageBitmap(b));
    }

    // Ensure font is ready for canvas text
    if (wm.enabled && wm.type === "text" && wm.font) {
      try { await document.fonts.load(`${wm.fontWeight} ${wm.fontSize}px "${wm.font}"`); } catch (e) { logDebug("image-to-video", "watermark font preload failed — using fallback", e); }
    }

    const canvas = new OffscreenCanvas(cw, ch);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context");

    // Temp canvases for crossfade blending
    const tempA = new OffscreenCanvas(cw, ch);
    const ctxA  = tempA.getContext("2d")!;
    const tempB = new OffscreenCanvas(cw, ch);
    const ctxB  = tempB.getContext("2d")!;

    const {
      Output, CanvasSource, AudioBufferSource, Mp4OutputFormat,
      QUALITY_HIGH, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
    } = await import("mediabunny");
    const { createMp4Writer } = await import("@/lib/mp4-disk-writer");

    const videoCodec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1", "vp8"], { width: cw, height: ch, bitrate: QUALITY_HIGH });
    if (!videoCodec) throw new Error("Your browser does not support video encoding (WebCodecs). Try Chrome or Edge.");

    videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY_HIGH });
    // Stream the encode to disk (desktop) so the whole MP4 never sits in the heap.
    writer = await createMp4Writer();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: writer.fastStart }), target: writer.target });
    output.addVideoTrack(videoSource);

    const hasAudio = (audioTracks && audioTracks.length > 0) || !!audioSrc;
    if (hasAudio) {
      const audioCodec = await getFirstEncodableAudioCodec(["aac", "opus", "mp3"]);
      if (audioCodec) {
        audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 128_000 });
        output.addAudioTrack(audioSource);
      }
    }

    await output.start();

    // Build timeline
    let cur2 = 0;
    const timeline = slides.map(s => {
      const start = cur2; cur2 += s.dframes;
      return { ...s, start, end: cur2 };
    });
    const totalFrames = cur2;

    for (let frame = 0; frame < totalFrames; frame++) {
      ctx.clearRect(0, 0, cw, ch);

      let ci = timeline.findIndex(t => frame < t.end);
      if (ci < 0) ci = timeline.length - 1;
      const cur  = timeline[ci];
      const prev = ci > 0 ? timeline[ci - 1] : null;
      const local     = frame - cur.start;
      const prevLocal = prev ? frame - prev.start : 0;

      if (timeline.length === 1 && transitionType !== "none" && xfade > 0) {
        // Single-slide intro/outro — each transition type handled independently
        let p = 1, isOutro = false;
        if (frame < xfade)              { p = Math.max(0, Math.min(1, frame / xfade)); }
        else if (frame >= totalFrames - xfade) { p = Math.max(0, Math.min(1, (totalFrames - frame) / xfade)); isOutro = true; }
        if (p < 1) {
          drawSingleSlideWithTransition(ctx, images[ci], cw, ch, cur.fitMode, bgColor, blurAmount, cur.effect, local, cur.dframes, brightness, saturation, effectSpeed, transitionType, p, isOutro, local);
        } else {
          drawFullSlide(ctx, images[ci], cw, ch, cur.fitMode, bgColor, blurAmount, cur.effect, local, cur.dframes, brightness, saturation, effectSpeed);
        }
      } else if (prev && local < xfade && transitionType !== "none") {
        const rawT = Math.max(0, Math.min(1, local / xfade));
        ctxA.clearRect(0, 0, cw, ch);
        drawFullSlide(ctxA, images[ci - 1], cw, ch, prev.fitMode, bgColor, blurAmount, prev.effect, prevLocal, prev.dframes, brightness, saturation, effectSpeed);
        ctxB.clearRect(0, 0, cw, ch);
        drawFullSlide(ctxB, images[ci], cw, ch, cur.fitMode, bgColor, blurAmount, cur.effect, local, cur.dframes, brightness, saturation, effectSpeed);
        blendTransition(ctx, tempA, tempB, cw, ch, transitionType, rawT, local);
      } else {
        drawFullSlide(ctx, images[ci], cw, ch, cur.fitMode, bgColor, blurAmount, cur.effect, local, cur.dframes, brightness, saturation, effectSpeed);
      }

      drawWatermarkCanvas(ctx, wm, wmImg, cw, ch);
      drawProgressBarCanvas(ctx, progressBar, totalFrames > 1 ? frame / (totalFrames - 1) : 1, cw, ch);

      await videoSource.add(frame / fps, 1 / fps);
      onProgress((frame + 1) / totalFrames * (audioSource ? 0.85 : 0.95));
    }

    videoSource.close();
    videoSource = null;

    if (audioSource) {
      const hasMulti = audioTracks && audioTracks.length > 0;
      const buf = hasMulti
        ? await prepareMultiAudioBuffer(audioTracks!, totalFrames / fps, audioVol, audioFadeIn, audioFadeOut)
        : audioSrc
          ? await prepareAudioBuffer(audioSrc, totalFrames / fps, audioVol, audioFadeIn, audioFadeOut)
          : null;
      if (buf) { await audioSource.add(buf); }
      audioSource.close();
      audioSource = null;
      onProgress(0.97);
    }

    await output.finalize();
    finalized = true;
    onProgress(1);

    return await writer.getBlob();
  } finally {
    for (const img of images) { try { img.close(); } catch { /* */ } }
    try { wmImg?.close(); } catch { /* */ }
    try { videoSource?.close(); } catch { /* already closed */ }
    try { audioSource?.close(); } catch { /* already closed */ }
    // If we never finalized+read the output (cancel / error), drop the staged .part so it
    // doesn't linger until the 24h sweep. On the success path getBlob() already cleaned up.
    if (!finalized) { try { await writer?.discard(); } catch { /* */ } }
  }
}

/* ── Single-engine canvas preview ─────────────────────────────────────────────
 * The tool's ONLY preview: every frame is drawn by the SAME canvas functions the
 * export uses (drawFullSlide / blendTransition / watermark / progress bar), and
 * the audio is the SAME AudioBuffer the export encodes — so preview == export
 * BY CONSTRUCTION. */

type CanvasPreviewHandle = { getCurrentFrame: () => number; seekTo: (f: number) => void };

type CanvasPreviewProps = {
  slides: { url: string; dframes: number; fitMode: FitMode; effect: SlideEffect }[];
  totalFrames: number;
  cw: number; ch: number;
  bgColor: string; blurAmount: number; brightness: number; saturation: number; effectSpeed: number;
  transitionType: TransitionType; transitionFrames: number;
  wm: WatermarkCfg; progressBar: ProgressBarCfg;
  audioSrc: string | null;
  audioTracks: { src: string; durationSecs?: number }[];
  audioVol: number; audioFadeIn: boolean; audioFadeOut: boolean;
  maxWidth: number; maxHeight: number;
  /** Media-load / init failure of the preview (NOT transient per-frame draw errors). */
  onError?: (err: unknown) => void;
};

const SlideshowCanvasPreview = forwardRef<CanvasPreviewHandle, CanvasPreviewProps>(
  function SlideshowCanvasPreview(props, ref) {
    const {
      slides, totalFrames, cw, ch, bgColor, blurAmount, brightness, saturation, effectSpeed,
      transitionType, transitionFrames: xfade, wm, progressBar, audioSrc, audioTracks,
      audioVol, audioFadeIn, audioFadeOut, maxWidth, maxHeight, onError,
    } = props;
    // Latest-ref so media effects don't re-run on a new callback identity.
    const onErrorRef = useRef(onError);
    useEffect(() => { onErrorRef.current = onError; }, [onError]);
    const initFailedRef = useRef(false); // canvas init failed → stop drawing, host shows the error card
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const offRef = useRef<{ main: OffscreenCanvas; a: OffscreenCanvas; b: OffscreenCanvas } | null>(null);
    const imagesRef = useRef<Map<string, ImageBitmap>>(new Map());
    const wmImgRef = useRef<ImageBitmap | null>(null);
    const frameRef = useRef(0);          // fractional playhead
    const dirtyRef = useRef(true);       // force a redraw (props/media changed)
    const [playing, setPlaying] = useState(false);
  // Sync mirror of the play state for async audio guards (a state closure would be
  // stale by the time the buffer build completes).
  const playingRef = useRef(false);
  const buildingRef = useRef(false); // one audio-buffer build at a time
  const disposedRef = useRef(false);
    // Displayed playhead (state, not a ref read, so render stays pure) — updated by
    // the rAF loop only when the drawn frame actually changes.
    const [curFrame, setCurFrame] = useState(0);

    // ── Audio: the EXACT export buffer, played via AudioContext ──
    const audioRef = useRef<{ ctx: AudioContext; buf: AudioBuffer; node: AudioBufferSourceNode | null; key: string } | null>(null);
    const audioKey = JSON.stringify({ s: audioSrc, t: audioTracks.map(t => t.src), v: audioVol, fi: audioFadeIn, fo: audioFadeOut, d: totalFrames });
    const stopAudio = useCallback(() => {
      const a = audioRef.current;
      if (!a?.node) return;
      try { a.node.stop(); } catch (e) { logDebug("image-to-video", "audio node already stopped", e); }
      audioRef.current = { ...a, node: null };
    }, []);
    const startAudioAt = useCallback(async () => {
      const hasAudio = !!audioSrc || audioTracks.length > 0;
      if (!hasAudio) return;
      try {
        let a = audioRef.current;
        if (!a || a.key !== audioKey) {
          if (buildingRef.current) return; // a build is already in flight
          buildingRef.current = true;
          stopAudio();
          if (a) { try { void a.ctx.close(); } catch (e) { logDebug("image-to-video", "audio ctx close failed", e); } }
          audioRef.current = null;
          const buf = audioTracks.length > 0
            ? await prepareMultiAudioBuffer(audioTracks, totalFrames / FPS, audioVol, audioFadeIn, audioFadeOut)
            : await prepareAudioBuffer(audioSrc!, totalFrames / FPS, audioVol, audioFadeIn, audioFadeOut);
          buildingRef.current = false;
          if (disposedRef.current) return; // unmounted mid-build
          a = { ctx: new AudioContext(), buf, node: null, key: audioKey };
        }
        stopAudio();
        // The user may have paused while the buffer decoded — never start stale audio.
        if (!playingRef.current) { audioRef.current = { ...a, node: null }; return; }
        const node = a.ctx.createBufferSource();
        node.buffer = a.buf;
        node.connect(a.ctx.destination);
        // Offset from the CURRENT frame — the clock kept advancing during the build.
        node.start(0, Math.max(0, Math.min(frameRef.current / FPS, a.buf.duration - 0.01)));
        audioRef.current = { ...a, node };
      } catch (e) {
        logDebug("image-to-video", "preview audio failed (silent preview)", e);
      }
    }, [audioKey, audioSrc, audioTracks, audioVol, audioFadeIn, audioFadeOut, totalFrames, stopAudio]);

    // ── Media: decode slide images (cached by url) + the watermark image ──
    const urlKey = JSON.stringify(slides.map(s => s.url));
    useEffect(() => {
      let cancelled = false;
      (async () => {
        const cache = imagesRef.current;
        let failed = 0;
        let lastErr: unknown = null;
        for (const s of slides) {
          if (cache.has(s.url)) continue;
          try {
            const bmp = await fetch(s.url).then(r => r.blob()).then(b => createImageBitmap(b));
            if (cancelled) return;
            cache.set(s.url, bmp);
            dirtyRef.current = true;
          } catch (e) {
            failed++;
            lastErr = e;
            logDebug("image-to-video", "preview image decode failed", e);
          }
        }
        if (cancelled || failed === 0) return;
        if (!slides.some(s => cache.has(s.url))) {
          // Nothing decoded at all — the preview can't start.
          onErrorRef.current?.(lastErr ?? new Error("Preview images couldn't be loaded"));
        } else {
          // Some slides were skipped — aggregate into ONE toast (batch-failure rule).
          toastError(`${failed} of ${slides.length} image${slides.length !== 1 ? "s" : ""} couldn't be loaded.`, "Preview incomplete");
        }
      })();
      return () => { cancelled = true; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [urlKey]);
    useEffect(() => {
      let cancelled = false;
      wmImgRef.current = null;
      if (wm.enabled && wm.type === "image" && wm.imageUrl) {
        fetch(wm.imageUrl).then(r => r.blob()).then(b => createImageBitmap(b))
          .then(bmp => { if (!cancelled) { wmImgRef.current = bmp; dirtyRef.current = true; } })
          .catch(e => logDebug("image-to-video", "preview watermark decode failed", e));
      } else { dirtyRef.current = true; }
      return () => { cancelled = true; };
    }, [wm.enabled, wm.type, wm.imageUrl]);

    // Any visual prop change → redraw the current frame.
    useEffect(() => { dirtyRef.current = true; }, [
      urlKey, totalFrames, cw, ch, bgColor, blurAmount, brightness, saturation, effectSpeed,
      transitionType, xfade, wm, progressBar,
    ]);

    // ── The frame draw — the SAME per-frame logic as renderSlideshow's loop ──
    const draw = useCallback((frame: number) => {
      const canvas = canvasRef.current;
      if (!canvas || initFailedRef.current) return;
      try {
        if (!offRef.current || offRef.current.main.width !== cw || offRef.current.main.height !== ch) {
          offRef.current = { main: new OffscreenCanvas(cw, ch), a: new OffscreenCanvas(cw, ch), b: new OffscreenCanvas(cw, ch) };
        }
      } catch (e) {
        // No OffscreenCanvas support — an init failure, not a per-frame blip.
        initFailedRef.current = true;
        onErrorRef.current?.(e);
        return;
      }
      const { main, a: tempA, b: tempB } = offRef.current;
      const ctx = main.getContext("2d");
      const ctxA = tempA.getContext("2d");
      const ctxB = tempB.getContext("2d");
      if (!ctx || !ctxA || !ctxB) {
        initFailedRef.current = true;
        onErrorRef.current?.(new Error("Could not get 2D canvas context"));
        return;
      }
      ctx.clearRect(0, 0, cw, ch);

      let cur2 = 0;
      const timeline = slides.map(s => { const start = cur2; cur2 += s.dframes; return { ...s, start, end: cur2 }; });
      const total = Math.max(1, cur2);
      const f = Math.max(0, Math.min(Math.floor(frame), total - 1));
      let ci = timeline.findIndex(t => f < t.end);
      if (ci < 0) ci = timeline.length - 1;
      const images = imagesRef.current;
      if (timeline.length > 0 && images.has(timeline[ci].url)) {
        const cur = timeline[ci];
        const prev = ci > 0 ? timeline[ci - 1] : null;
        const local = f - cur.start;
        const prevLocal = prev ? f - prev.start : 0;
        const img = images.get(cur.url)!;
        if (timeline.length === 1 && transitionType !== "none" && xfade > 0) {
          let p = 1, isOutro = false;
          if (f < xfade) { p = Math.max(0, Math.min(1, f / xfade)); }
          else if (f >= total - xfade) { p = Math.max(0, Math.min(1, (total - f) / xfade)); isOutro = true; }
          if (p < 1) drawSingleSlideWithTransition(ctx, img, cw, ch, cur.fitMode, bgColor, blurAmount, cur.effect, local, cur.dframes, brightness, saturation, effectSpeed, transitionType, p, isOutro, local);
          else drawFullSlide(ctx, img, cw, ch, cur.fitMode, bgColor, blurAmount, cur.effect, local, cur.dframes, brightness, saturation, effectSpeed);
        } else if (prev && local < xfade && transitionType !== "none" && images.has(prev.url)) {
          const rawT = Math.max(0, Math.min(1, local / xfade));
          ctxA.clearRect(0, 0, cw, ch);
          drawFullSlide(ctxA, images.get(prev.url)!, cw, ch, prev.fitMode, bgColor, blurAmount, prev.effect, prevLocal, prev.dframes, brightness, saturation, effectSpeed);
          ctxB.clearRect(0, 0, cw, ch);
          drawFullSlide(ctxB, img, cw, ch, cur.fitMode, bgColor, blurAmount, cur.effect, local, cur.dframes, brightness, saturation, effectSpeed);
          blendTransition(ctx, tempA, tempB, cw, ch, transitionType, rawT, local);
        } else {
          drawFullSlide(ctx, img, cw, ch, cur.fitMode, bgColor, blurAmount, cur.effect, local, cur.dframes, brightness, saturation, effectSpeed);
        }
      } else {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, cw, ch);
      }
      drawWatermarkCanvas(ctx, wm, wmImgRef.current, cw, ch);
      drawProgressBarCanvas(ctx, progressBar, total > 1 ? f / (total - 1) : 1, cw, ch);

      const vctx = canvas.getContext("2d");
      if (vctx) { vctx.clearRect(0, 0, cw, ch); vctx.drawImage(main, 0, 0); }
    }, [slides, cw, ch, bgColor, blurAmount, brightness, saturation, effectSpeed, transitionType, xfade, wm, progressBar]);

    // ── Clock: rAF loop; draws when playing (advancing) or dirty (paused edit) ──
    useEffect(() => {
      let raf = 0;
      let last = 0;
      let lastDrawn = -1;
      const loop = (t: number) => {
        if (playing) {
          if (!last) last = t;
          frameRef.current += ((t - last) / 1000) * FPS;
          if (frameRef.current >= totalFrames) {
            frameRef.current = 0; // loop back to the start
            void startAudioAt();
          }
          last = t;
        } else {
          last = 0;
        }
        const f = Math.floor(frameRef.current);
        if (f !== lastDrawn || dirtyRef.current) {
          draw(frameRef.current);
          lastDrawn = f;
          dirtyRef.current = false;
          setCurFrame(f); // same-value updates are skipped by React
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }, [playing, totalFrames, draw, startAudioAt]);

    // Play/pause drives the audio with the clock. Ref-based (not a state updater —
    // side effects inside an updater run twice in StrictMode, and async audio guards
    // need a SYNC play-state source).
    const togglePlay = useCallback(() => {
      const next = !playingRef.current;
      playingRef.current = next;
      setPlaying(next);
      if (next) void startAudioAt();
      else stopAudio();
    }, [startAudioAt, stopAudio]);

    const seekTo = useCallback((f: number) => {
      frameRef.current = Math.max(0, Math.min(f, totalFrames - 1));
      dirtyRef.current = true;
      if (playingRef.current) void startAudioAt();
    }, [totalFrames, playing, startAudioAt]);

    useImperativeHandle(ref, () => ({
      getCurrentFrame: () => Math.floor(frameRef.current),
      seekTo,
    }), [seekTo]);

    // Teardown: stop audio + close the context.
    useEffect(() => () => {
      disposedRef.current = true;
      playingRef.current = false;
      stopAudio();
      const a = audioRef.current;
      if (a) {
        try { void a.ctx.close(); } catch (e) { logDebug("image-to-video", "audio ctx close on unmount failed", e); }
        audioRef.current = null;
      }
    }, [stopAudio]);

    // Fit the canvas into the available box at the composition's aspect.
    const scale = Math.min(maxWidth / cw, maxHeight / ch, 1);
    const dispW = Math.round(cw * scale);
    const dispH = Math.round(ch * scale);

    return (
      <div className="flex flex-col items-center gap-2">
        <canvas
          ref={canvasRef}
          width={cw}
          height={ch}
          onClick={togglePlay}
          className="rounded-lg cursor-pointer bg-black shadow-lg"
          style={{ width: dispW, height: dispH }}
        />
        <div className="flex items-center gap-2" style={{ width: dispW }}>
          <button
            onClick={togglePlay}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-zinc-100 dark:bg-white/10 hover:bg-zinc-200 dark:hover:bg-white/15 text-zinc-700 dark:text-zinc-200 border-none cursor-pointer transition-colors shrink-0"
            title={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <input
            type="range" min={0} max={Math.max(0, totalFrames - 1)} value={curFrame}
            onChange={e => seekTo(Number(e.target.value))}
            className="flex-1 min-w-0 cursor-pointer h-1 accent-violet-500"
          />
          <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400 shrink-0">
            {(curFrame / FPS).toFixed(1)}s / {(totalFrames / FPS).toFixed(1)}s
          </span>
        </div>
      </div>
    );
  },
);

// FieldLabel, inputCls, SectionTitle → imported from @/components/tools/ui

/* ── Main page ────────────────────────────────────────────────────────────── */

export default function ImageToVideoPage() {
  const audioInputRef     = useRef<HTMLInputElement>(null);
  const bulkAudioInputRef = useRef<HTMLInputElement>(null);

  // Single-engine canvas preview — every frame is drawn with the SAME functions
  // the export uses, so what you see is what renders.
  const canvasPreviewRef = useRef<CanvasPreviewHandle>(null);
  const previewSeekTo = useCallback((f: number) => {
    canvasPreviewRef.current?.seekTo(f);
  }, []);
  const previewCurrentFrame = useCallback(
    () => canvasPreviewRef.current?.getCurrentFrame() ?? 0,
    [],
  );
  // Preview failure surface: media-load/init errors swap the preview for the
  // error card; Retry clears the error and bumps the remount key.
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const onPreviewError = useCallback((err: unknown) => {
    setPreviewError(() => err ?? new Error("Preview failed"));
  }, []);
  const retryPreview = useCallback(() => {
    setPreviewError(null);
    setPreviewNonce(n => n + 1);
  }, []);

  /* state */
  const [slides, setSlides]         = useState<Slide[]>([]);
  const [ratio, setRatio]           = useState<AspRatio>("9:16");
  const [globalDur, setGlobalDur]   = useState(3);
  const [globalFit, setGlobalFit]   = useState<FitMode>("contain");
  const [bgColor, setBgColor]       = useState("#000000");
  const [audioSrc, setAudioSrc]       = useState<string|null>(null);
  const [audioName, setAudioName]     = useState<string|null>(null);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioVol, setAudioVol]       = useState(0.8);
  const [audioFadeIn, setAudioFadeIn]   = useState(false);
  const [audioFadeOut, setAudioFadeOut] = useState(false);
  const [blurAmount, setBlurAmount] = useState(22);
  const [wm, setWm]                 = useState<WatermarkCfg>(DEFAULT_WATERMARK);
  const [pb, setPb]                 = useState<ProgressBarCfg>(DEFAULT_PROGRESS_BAR);
  const [brightness, setBrightness]       = useState(100);
  const [saturation, setSaturation]       = useState(100);
  const [effectSpeed, setEffectSpeed]     = useState(1);
  const [transitionType, setTransitionType]       = useState<TransitionType>("fade");
  const [transitionDurSecs, setTransitionDurSecs] = useState(0.4);
  const [effectGroup, setEffectGroup]         = useState<SlideEffect[]>(["ken-burns-up","ken-burns-down"]);
  const [separateEffects, setSeparateEffects] = useState<SlideEffect[]>(["none"]);
  const [separateMode, setSeparateMode] = useState(false);
  const [previewIdx, setPreviewIdx]     = useState(0);
  const [genState, setGenState]         = useState<"idle"|"generating"|"done">("idle");
  const [genProgress, setGenProgress]   = useState(0);
  const [errors, setErrors]             = useState<string[]>([]);
  // Warn before navigating away mid-render (it runs on this page, dies on unmount).
  useRegisterTask(genState === "generating", { label: "Image-to-video render", kind: "studio" });
  const [isDragging, setIsDragging]     = useState(false);
  const [dragSrc, setDragSrc]           = useState<number | null>(null);
  const [dragDst, setDragDst]           = useState<number | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [genBlobUrl,   setGenBlobUrl]   = useState<string | null>(null);
  const [genOutPath,   setGenOutPath]   = useState<string | null>(null); // saved MP4 path (desktop)
  const [genBlob,      setGenBlob]      = useState<Blob | null>(null);   // for "save a copy" fallback
  const [showHelp,     setShowHelp]     = useState(false);
  const [openFeature,  setOpenFeature]  = useState<string | null>(null);
  const [rightOpen,    setRightOpen]    = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set(["video", "transitions", "effects", "color", "audio", "watermark"]));
  const toggleSection = (key: string) => setCollapsedSections(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  /* derived */
  const { w: compW, h: compH } = DIMS[ratio];
  const safePreviewIdx = Math.min(previewIdx, Math.max(0, slides.length - 1));

  const compSlides = useMemo(() =>
    slides.map((s, i) => ({
      url: s.url,
      dframes: Math.round(s.duration * FPS),
      fitMode: s.fitMode,
      effect: separateMode
        ? separateEffects[slideHash(s.id) % Math.max(1, separateEffects.length)]
        : effectGroup[i % Math.max(1, effectGroup.length)],
    })),
    [slides, separateMode, effectGroup, separateEffects]
  );

  const slideStarts = useMemo(() => {
    const arr: number[] = [];
    let c = 0;
    for (const s of compSlides) { arr.push(c); c += s.dframes; }
    return arr;
  }, [compSlides]);

  /* in separate mode show only the selected slide in the player */
  const playerSlides = useMemo(() =>
    separateMode && compSlides.length > 0
      ? [compSlides[safePreviewIdx]]
      : compSlides,
    [separateMode, compSlides, safePreviewIdx]
  );

  const totalFrames = Math.max(1, playerSlides.reduce((a, s) => a + s.dframes, 0));
  const totalSeconds = separateMode && slides.length > 0
    ? (slides[safePreviewIdx]?.duration ?? globalDur).toFixed(1)
    : (compSlides.reduce((a, s) => a + s.dframes, 0) / FPS).toFixed(1);

  const previewAudioSrc = separateMode
    ? (slides[safePreviewIdx]?.audioSrc ?? audioSrc)
    : audioSrc;

  const transitionFrames = Math.round(transitionDurSecs * FPS);

  /* image upload */
  const addImages = useCallback((files: FileList | null) => {
    if (!files) return;
    const errs: string[] = [];
    const newSlides: Slide[] = [];
    Array.from(files).forEach(f => {
      if (!f.type.startsWith("image/")) { errs.push(`${f.name}: not an image`); return; }
      if (f.size > 20 * 1024 * 1024) { errs.push(`${f.name}: exceeds 20 MB`); return; }
      newSlides.push({
        id: crypto.randomUUID(), url: URL.createObjectURL(f),
        name: f.name, fitMode: globalFit, duration: globalDur, effect: "none",
      });
    });
    if (errs.length) setErrors(errs);
    setSlides(prev => [...prev, ...newSlides]);
  }, [globalFit, globalDur]);

  const removeSlide = (id: string) =>
    setSlides(prev => prev.filter(s => s.id !== id));

  const updateSlide = (id: string, patch: Partial<Slide>) =>
    setSlides(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));

  const applyBulkFit = (fit: FitMode) => {
    setGlobalFit(fit);
    setSlides(prev => prev.map(s => ({ ...s, fitMode: fit })));
  };

  const reorderSlides = useCallback((from: number, to: number) => {
    setSlides(prev => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  /* audio */
  const loadAudio = (f: File) => {
    if (!f.type.startsWith("audio/")) { setErrors(["Audio file must be an audio format"]); return; }
    if (audioSrc) URL.revokeObjectURL(audioSrc);
    setAudioSrc(URL.createObjectURL(f));
    setAudioName(f.name);
  };

  const addAudioTracks = async (files: FileList | null) => {
    if (!files) return;
    const valid = Array.from(files).filter(f => f.type.startsWith("audio/"));
    if (!valid.length) { setErrors(["No valid audio files selected"]); return; }
    const newTracks = await Promise.all(valid.map(async f => {
      const src = URL.createObjectURL(f);
      const durationSecs = await getAudioDuration(src);
      return { id: crypto.randomUUID(), src, name: f.name, durationSecs };
    }));
    setAudioTracks(prev => [...prev, ...newTracks]);
  };

  const removeAudioTrack = (id: string) => {
    setAudioTracks(prev => {
      const t = prev.find(t => t.id === id);
      if (t) URL.revokeObjectURL(t.src);
      return prev.filter(t => t.id !== id);
    });
  };

  const loadSlideAudio = (slideId: string, f: File) => {
    if (!f.type.startsWith("audio/")) { setErrors([`${f.name}: not an audio format`]); return; }
    setSlides(prev => prev.map(s => {
      if (s.id !== slideId) return s;
      if (s.audioSrc) URL.revokeObjectURL(s.audioSrc);
      return { ...s, audioSrc: URL.createObjectURL(f), audioName: f.name };
    }));
  };

  const removeSlideAudio = (slideId: string) => {
    setSlides(prev => prev.map(s => {
      if (s.id !== slideId) return s;
      if (s.audioSrc) URL.revokeObjectURL(s.audioSrc);
      return { ...s, audioSrc: null, audioName: null };
    }));
  };

  const bulkAssignAudios = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const audioFiles = Array.from(files).filter(f => f.type.startsWith("audio/"));
    if (audioFiles.length === 0) { setErrors(["No valid audio files selected"]); return; }
    setSlides(prev => prev.map((s, i) => {
      const f = audioFiles[i % audioFiles.length];
      if (s.audioSrc) URL.revokeObjectURL(s.audioSrc);
      return { ...s, audioSrc: URL.createObjectURL(f), audioName: f.name };
    }));
  };

  /* drag-drop */
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    addImages(e.dataTransfer.files);
  }, [addImages]);

  /* generate */
  async function generate() {
    const errs: string[] = [];
    if (slides.length === 0) errs.push("Add at least one image.");
    if (errs.length) { setErrors(errs); return; }
    setErrors([]);
    setGenState("generating"); setGenProgress(0);
    if (genBlobUrl) { URL.revokeObjectURL(genBlobUrl); setGenBlobUrl(null); }
    setGenOutPath(null); setGenBlob(null);
    // Global render-dock job so progress stays visible across navigation.
    const dockId = useRenderJobs.getState().startJob({
      label: separateMode ? `${compSlides.length} clips` : "Slideshow video", kind: "image-to-video",
      href: typeof window !== "undefined" ? window.location.pathname + window.location.search : "/video-studio/image-to-video",
      total: separateMode ? compSlides.length : undefined,
    });
    // Auto-save a finished MP4 to Downloads (like the editor export) so it's actually
    // on disk + findable — the render dock's Open / Show-in-folder resolve this path.
    // The `<a download>` link is silently ignored by the Tauri webview. Returns the
    // saved path (desktop) or null (web / failure).
    const savedPaths: string[] = [];
    const saveToDownloads = async (blob: Blob, filename: string): Promise<string | null> => {
      try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (!isTauri()) return null;
        const { downloadDir, join } = await import("@tauri-apps/api/path");
        const { invokeWithBytes } = await import("@/lib/tauri-bytes");
        const dest = await join(await downloadDir(), filename);
        const path = await invokeWithBytes<string>("save_bytes", blob, { "dest-path": dest });
        savedPaths.push(path);
        const { addLocalExport } = await import("@/lib/local-exports");
        addLocalExport({ title: filename.replace(/\.mp4$/i, ""), path, width: compW, height: compH, durationFrames: totalFrames, fps: FPS });
        return path;
      } catch (e) { logError("image-to-video", "auto-save to Downloads failed", e); return null; }
    };

    try {
      if (separateMode) {
        // Render each slide as its own video
        for (let i = 0; i < compSlides.length; i++) {
          const slideAudio = slides[i]?.audioSrc ?? audioSrc;
          const blob = await renderSlideshow({
            slides: [compSlides[i]], cw: compW, ch: compH, fps: FPS,
            xfade: transitionType === "none" ? 0 : transitionFrames,
            transitionType,
            audioSrc: slideAudio, audioVol, audioFadeIn, audioFadeOut, wm, bgColor, blurAmount, brightness, saturation, effectSpeed,
            progressBar: pb,
            onProgress: p => { const pct = ((i + p) / compSlides.length) * 100; setGenProgress(pct); useRenderJobs.getState().setProgress(dockId, pct, { current: i + 1, total: compSlides.length }); },
          });
          await saveToDownloads(blob, `clip-${String(i + 1).padStart(2, "0")}.mp4`);
        }
        setGenState("done"); setGenProgress(100);
      } else {
        const blob = await renderSlideshow({
          slides: compSlides, cw: compW, ch: compH, fps: FPS,
          xfade: transitionType === "none" ? 0 : transitionFrames,
          transitionType,
          audioSrc: null,
          audioTracks: audioTracks.map(t => ({ src: t.src })),
          audioVol, audioFadeIn, audioFadeOut, wm, bgColor, blurAmount, brightness, saturation, effectSpeed,
          progressBar: pb,
          onProgress: p => { setGenProgress(p * 100); useRenderJobs.getState().setProgress(dockId, p * 100); },
        });
        const url = URL.createObjectURL(blob);
        setGenBlobUrl(url);
        setGenBlob(blob);
        const path = await saveToDownloads(blob, "Slideshow video.mp4");
        setGenOutPath(path);
        setGenState("done"); setGenProgress(100);
      }
      useRenderJobs.getState().finishJob(dockId, savedPaths[0] ? { outputPath: savedPaths[0] } : undefined);
    } catch (err) {
      logError("image-to-video", "render failed", err);
      setErrors([`Render failed: ${humanizeError(err)}`]);
      setGenState("idle"); setGenProgress(0);
      useRenderJobs.getState().failJob(dockId, humanizeError(err));
    }
  }

  /* keep playhead in bounds when total duration shrinks */
  useEffect(() => {
    if (previewCurrentFrame() >= totalFrames) previewSeekTo(0);
  }, [totalFrames, previewCurrentFrame, previewSeekTo]);

  /* poll currentFrame for the timeline strip */
  useEffect(() => {
    let id: number;
    const poll = () => {
      setCurrentFrame(previewCurrentFrame());
      id = requestAnimationFrame(poll);
    };
    id = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(id);
  }, [previewCurrentFrame]);

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <AppLayout>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        {/* ── Top bar (Text-to-Voice style): output switcher (left) + help (right) ── */}
        <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-zinc-200 dark:border-white/8 shrink-0">
          {/* Output mode switcher */}
          <div className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 rounded-xl w-fit shrink-0">
            {([["combined", Film, "Combined"], ["separate", Layers, "Separate"]] as const).map(([val, Icon, label]) => {
              const active = separateMode ? val === "separate" : val === "combined";
              return (
                <button key={val} onClick={() => setSeparateMode(val === "separate")}
                  title={val === "combined" ? "One merged video" : "One video per image"}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12.5px] font-semibold cursor-pointer border-none font-[inherit] transition-all ${
                    active
                      ? "bg-white dark:bg-white/10 text-zinc-900 dark:text-zinc-100 shadow-sm"
                      : "bg-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  }`}>
                  <Icon size={13} /> {label}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => setShowHelp(true)}
            title="How it works"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/8 cursor-pointer border border-zinc-200 dark:border-white/10 bg-transparent transition-colors shrink-0"
          >
            <Info size={14} />
          </button>
        </div>

        <div className="relative flex flex-1 min-h-0">
          {/* ── LEFT: inputs panel ── */}
          <div className="w-86 shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-white dark:bg-zinc-900 overflow-hidden">
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

            {/* Errors */}
            {errors.length > 0 && (
              <div className="rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/5 p-3 flex gap-2">
                <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
                <div>
                  {errors.map((e, i) => <p key={i} className="text-[11px] text-red-600 dark:text-red-400">{e}</p>)}
                </div>
                <button onClick={() => setErrors([])} className="ml-auto text-red-400 hover:text-red-600 cursor-pointer border-none bg-transparent shrink-0">
                  <X size={12} />
                </button>
              </div>
            )}

            {/* ── Images ── */}
            <div>
              <div className="mb-3">
                <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">Images</p>
              </div>
              {separateMode && slides.length > 0 && (
                <div className="flex items-center gap-1.5 mb-3 px-3 py-2 rounded-lg bg-violet-500/5 border border-violet-500/15">
                  <Layers size={11} className="text-violet-500 shrink-0" />
                  <p className="text-[11px] text-violet-600 dark:text-violet-400 flex-1">
                    {slides.length} separate video{slides.length !== 1 ? "s" : ""} · {globalDur}s each
                  </p>
                </div>
              )}
              {/* Drop zone */}
              <label
                className={`flex flex-col items-center justify-center w-full h-24 rounded-xl border-2 border-dashed cursor-pointer transition-colors mb-3 ${
                  isDragging
                    ? "border-violet-400 bg-violet-50 dark:bg-violet-500/5"
                    : "border-zinc-300 dark:border-white/20 bg-zinc-50/80 dark:bg-white/[0.04] hover:border-violet-400/50 hover:bg-zinc-50 dark:hover:bg-white/3"
                }`}
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
              >
                <input type="file" accept="image/*" multiple className="hidden"
                  onChange={e => addImages(e.target.files)} />
                <ImagePlus size={18} className="text-zinc-400 mb-1.5" />
                <p className="text-[12px] font-medium text-zinc-500">Drop images or click to upload</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">PNG, JPG, WebP · max 20 MB each</p>
              </label>

              {/* Bulk fit controls */}
              {slides.length > 0 && (
                <div className="mb-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mr-1">Bulk fit:</span>
                    {(["contain","cover","blur-fill"] as FitMode[]).map(f => (
                      <button key={f} onClick={() => applyBulkFit(f)}
                        className="h-6 px-2.5 rounded-md text-[10px] font-semibold cursor-pointer border transition-all"
                        style={{
                          background: globalFit === f ? "rgba(61,126,253,0.1)" : "transparent",
                          borderColor: globalFit === f ? "rgba(61,126,253,0.4)" : "rgba(0,0,0,0.08)",
                          color: globalFit === f ? "#3D7EFD" : undefined,
                        }}>
                        {f}
                      </button>
                    ))}
                  </div>
                  {globalFit === "blur-fill" && (
                    <div className="flex items-center gap-2 pl-1">
                      <span className="text-[10px] font-medium text-zinc-400 shrink-0 w-14">Blur</span>
                      <input type="range" min={0} max={60} step={1} value={blurAmount}
                        onChange={e => setBlurAmount(parseInt(e.target.value))}
                        className="flex-1 accent-violet-500" />
                      <span className="text-[10px] text-zinc-400 tabular-nums w-7 text-right">{blurAmount}px</span>
                    </div>
                  )}
                </div>
              )}

              {/* Slide list */}
              <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
                {slides.map((s, i) => {
                  const isActive = safePreviewIdx === i;
                  const isDragged = dragSrc === i;
                  const isOver = dragDst === i && dragSrc !== null && dragSrc !== i;
                  return (
                    <div
                      key={s.id}
                      draggable
                      onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragSrc(i); }}
                      onDragOver={e => { e.preventDefault(); if (dragSrc !== null && dragSrc !== i) setDragDst(i); }}
                      onDragLeave={() => setDragDst(null)}
                      onDrop={e => {
                        e.preventDefault();
                        if (dragSrc === null || dragSrc === i) { setDragSrc(null); setDragDst(null); return; }
                        const next = [...slides];
                        const [item] = next.splice(dragSrc, 1);
                        next.splice(i, 0, item);
                        setSlides(next);
                        setDragSrc(null); setDragDst(null);
                      }}
                      onDragEnd={() => { setDragSrc(null); setDragDst(null); }}
                      onClick={() => {
                        if (separateMode) {
                          setPreviewIdx(i);
                          previewSeekTo(0);
                        } else {
                          previewSeekTo(slideStarts[i] ?? 0);
                        }
                      }}
                      className={`relative flex items-center gap-2 p-2 rounded-lg border cursor-pointer group transition-all ${
                        isDragged ? "opacity-40" :
                        isActive
                          ? "border-violet-400/50 bg-violet-500/5 dark:bg-violet-500/8"
                          : "border-zinc-100 dark:border-white/8 bg-zinc-50 dark:bg-white/3 hover:border-zinc-200 dark:hover:border-white/12 hover:bg-zinc-100 dark:hover:bg-white/5"
                      } ${isOver ? "ring-2 ring-violet-400 ring-inset" : ""}`}
                    >
                      <GripVertical size={12} className="text-zinc-300 dark:text-zinc-600 shrink-0 cursor-grab active:cursor-grabbing" />
                      <div className={`w-10 h-10 rounded-md overflow-hidden shrink-0 bg-zinc-200 dark:bg-white/10 ring-2 transition-all ${isActive ? "ring-violet-400/60" : "ring-transparent"}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={s.url} alt={s.name} className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[11px] font-medium truncate ${isActive ? "text-violet-600 dark:text-violet-400" : "text-zinc-700 dark:text-zinc-300"}`}>{i + 1}. {s.name}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <select value={s.fitMode}
                            onChange={e => { e.stopPropagation(); updateSlide(s.id, { fitMode: e.target.value as FitMode }); }}
                            onClick={e => e.stopPropagation()}
                            className="h-5 px-1 rounded text-[10px] bg-white dark:bg-white/8 border border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 outline-none cursor-pointer">
                            <option value="contain">contain</option>
                            <option value="cover">cover</option>
                            <option value="blur-fill">blur</option>
                          </select>
                          {!separateMode && (
                            <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                              <input
                                type="number" min={0.5} max={60} step={0.5}
                                value={s.duration}
                                onChange={e => updateSlide(s.id, { duration: parseFloat(e.target.value) || 1 })}
                                className="w-10 h-5 px-1 rounded text-[10px] text-center bg-white dark:bg-white/8 border border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                              />
                              <span className="text-[9px] text-zinc-400">s</span>
                            </div>
                          )}
                          {isActive && (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-500">▶</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); removeSlide(s.id); }}
                        className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent transition-all shrink-0">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  );
                })}
                {slides.length === 0 && (
                  <p className="text-[12px] text-zinc-400 text-center py-4">No images yet</p>
                )}
              </div>
            </div>
            </div>

          {/* Generate button — sticky bottom */}
          <div className="px-5 py-4 border-t border-zinc-100 dark:border-white/8 shrink-0 space-y-2">
            {genState === "generating" && (
              <div>
                <div className="flex justify-between text-[10px] text-zinc-400 mb-1">
                  <span>Rendering…</span>
                  <span>{Math.min(Math.round(genProgress), 100)}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width:`${Math.min(genProgress,100)}%`, background:"linear-gradient(90deg,#3D7EFD,#003AAC)" }} />
                </div>
              </div>
            )}
            {genState === "done" && (
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 size={12} />
                {separateMode ? `${slides.length} videos ready — download below` : "Video ready — download below"}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={generate}
                disabled={genState === "generating" || slides.length === 0}
                className="flex-1 h-10 rounded-xl text-[13px] font-bold text-white cursor-pointer border-none flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity hover:opacity-90"
                style={{ background: "linear-gradient(135deg,#3D7EFD,#003AAC)" }}>
                {genState === "generating"
                  ? <><Loader2 size={13} className="animate-spin" /> Rendering…</>
                  : genState === "done"
                  ? <><CheckCircle2 size={13} /> Re-generate</>
                  : separateMode
                  ? <><Layers size={13} /> Generate {slides.length} Video{slides.length !== 1 ? "s" : ""}</>
                  : <><Film size={13} /> Generate Video</>}
              </button>
              {genState === "done" && !separateMode && (genBlobUrl || genBlob) && (
                <button
                  className="h-10 px-4 rounded-xl text-[13px] font-bold text-white cursor-pointer border-none flex items-center gap-1.5 transition-opacity hover:opacity-90"
                  style={{ background:"linear-gradient(135deg,#22c55e,#16a34a)" }}
                  onClick={async () => {
                    // Already auto-saved to Downloads → reveal it. Otherwise (web /
                    // save failed) native-save; the webview ignores `<a download>`.
                    if (genOutPath) {
                      const { revealLocalExport } = await import("@/lib/local-exports");
                      await revealLocalExport(genOutPath).catch(() => {});
                      return;
                    }
                    if (!genBlob) return;
                    const { saveBlobToDisk } = await import("@/lib/save-file");
                    await saveBlobToDisk(genBlob, "Slideshow video.mp4").catch(e => surfaceError(e, { operation: "save video" }));
                  }}>
                  <Download size={13} /> {genOutPath ? "Show in folder" : "Download"}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── RIGHT: styling panel ── */}
        {rightOpen && (
        <div className="w-95 shrink-0 order-last flex flex-col border-l border-zinc-200 dark:border-white/8 bg-white dark:bg-zinc-900 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-white/8 shrink-0">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={14} className="text-violet-500" />
              <h2 className="text-[14px] font-bold text-zinc-900 dark:text-zinc-50">Styling</h2>
            </div>
            <button onClick={() => setRightOpen(false)} className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/8 cursor-pointer border-none bg-transparent transition-colors">
              <X size={15} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

            {/* ── Video settings ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("video")} onToggle={() => toggleSection("video")}>Video Settings</SectionTitle>
              {!collapsedSections.has("video") && (
              <div className="space-y-3">
                {/* Aspect ratio — card grid (matches Voiceover to Video) */}
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-2">Aspect Ratio</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    {([
                      { id: "16:9", label: "Landscape", Icon: RectangleHorizontal },
                      { id: "9:16", label: "Portrait",  Icon: RectangleVertical },
                      { id: "1:1",  label: "Square",    Icon: Square },
                      { id: "4:5",  label: "Tall",      Icon: RectangleVertical },
                    ] as const).map(({ id, label, Icon }) => {
                      const active = ratio === id;
                      return (
                        <button key={id} onClick={() => setRatio(id as AspRatio)}
                          title={`${id} · ${DIMS[id as AspRatio].w}×${DIMS[id as AspRatio].h}`}
                          className={`flex flex-col items-center gap-1 py-2.5 rounded-xl border transition-all cursor-pointer font-[inherit] ${active ? "border-violet-500/50 bg-violet-500/8 ring-1 ring-violet-500/30" : "border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/4 hover:border-zinc-300 dark:hover:border-white/15"}`}>
                          <Icon size={16} strokeWidth={1.6} className={active ? "text-violet-500" : "text-zinc-400 dark:text-zinc-500"} />
                          <span className={`text-[10px] font-bold leading-none ${active ? "text-violet-600 dark:text-violet-400" : "text-zinc-600 dark:text-zinc-300"}`}>{id}</span>
                          <span className={`text-[8px] leading-none ${active ? "text-violet-400/70" : "text-zinc-400 dark:text-zinc-500"}`}>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* Clip duration + BG color */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>Clip Duration (s)</FieldLabel>
                    <input type="number" min={0.5} max={60} step={0.5}
                      value={globalDur}
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 1;
                        setGlobalDur(v);
                        setSlides(prev => prev.map(s => ({ ...s, duration: v })));
                      }}
                      className={inputCls("[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")} />
                  </div>
                  <div>
                    <FieldLabel>BG Color (contain)</FieldLabel>
                    <div className="flex gap-2">
                      <ColorButton value={bgColor} onChange={setBgColor} size={36} />
                      <input type="text" value={bgColor} onChange={e => setBgColor(e.target.value)}
                        className={inputCls("flex-1 min-w-0")} maxLength={7} />
                    </div>
                  </div>
                </div>
              </div>)}
            </div>

            {/* ── Transitions ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("transitions")} onToggle={() => toggleSection("transitions")}>Transitions</SectionTitle>
              {!collapsedSections.has("transitions") && (
                <div className="space-y-3">
                  {/* Duration slider — hidden for none */}
                  {transitionType !== "none" && (
                    <div className="flex items-center gap-2.5">
                      <span className="text-[10px] font-medium text-zinc-400 shrink-0 w-14">Duration</span>
                      <input type="range" min={0.1} max={2} step={0.1} value={transitionDurSecs}
                        onChange={e => setTransitionDurSecs(parseFloat(e.target.value))}
                        className="flex-1 accent-violet-500" />
                      <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">{transitionDurSecs.toFixed(1)}s</span>
                    </div>
                  )}
                  {/* Transition type grid */}
                  <div className="grid grid-cols-3 gap-1.5">
                    {(Object.keys(TRANSITION_LABELS) as TransitionType[]).map(type => {
                      const active = transitionType === type;
                      return (
                        <button
                          key={type}
                          onClick={() => setTransitionType(type)}
                          className="flex items-center justify-center h-9 px-1 rounded-lg border cursor-pointer transition-all text-[10px] font-semibold"
                          style={{
                            background: active ? "rgba(61,126,253,0.1)" : "transparent",
                            borderColor: active ? "rgba(61,126,253,0.45)" : "rgba(113,113,122,0.2)",
                            color: active ? "#3D7EFD" : undefined,
                          }}
                        >
                          {TRANSITION_LABELS[type]}
                        </button>
                      );
                    })}
                  </div>
                  {separateMode && transitionType !== "none" && (
                    <p className="text-[10px] text-zinc-400 pl-1">In Separate mode: fade in/out from black applied to each clip.</p>
                  )}
                </div>
              )}
            </div>

            {/* ── Effects ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("effects")} onToggle={() => toggleSection("effects")}>Effects</SectionTitle>
              {!collapsedSections.has("effects") && (
                <EffectPicker
                  selected={separateMode ? separateEffects : effectGroup}
                  onChange={effects => separateMode ? setSeparateEffects(effects) : setEffectGroup(effects)}
                  previewImage={slides[0]?.url}
                  hint={separateMode ? "Pick multiple — each clip gets one randomly" : "Camera motion — cycles across slides in sequence"}
                  showSpeed
                  speed={effectSpeed}
                  onSpeedChange={setEffectSpeed}
                />
              )}
            </div>

            {/* ── Color Adjust ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("color")} onToggle={() => toggleSection("color")}>Color Adjust</SectionTitle>
              {!collapsedSections.has("color") && (
                <ColorAdjustSection
                  brightness={brightness} onBrightnessChange={setBrightness}
                  saturation={saturation} onSaturationChange={setSaturation}
                />
              )}
            </div>

            {/* ── Audio ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("audio")} onToggle={() => toggleSection("audio")}>Background Audio</SectionTitle>

              {!collapsedSections.has("audio") && (separateMode ? (
                /* ── Per-slide audio (separate mode) ── */
                <div className="space-y-2.5">
                  {/* Bulk auto-assign */}
                  <div className="flex items-center gap-2">
                    <label className="flex-1 flex items-center gap-2 h-8 px-3 rounded-lg border border-dashed border-zinc-200 dark:border-white/10 cursor-pointer hover:bg-zinc-50 dark:hover:bg-white/3 transition-colors">
                      <input type="file" accept="audio/*" multiple ref={bulkAudioInputRef} className="hidden"
                        onChange={e => bulkAssignAudios(e.target.files)} />
                      <Music size={12} className="text-violet-500 shrink-0" />
                      <span className="text-[11px] text-zinc-500">Auto-assign multiple…</span>
                    </label>
                    <span className="text-[10px] text-zinc-400 shrink-0">cycles to all slides</span>
                  </div>

                  {/* Per-slide rows */}
                  {slides.length === 0 && (
                    <p className="text-[11px] text-zinc-400 text-center py-2">Add images first</p>
                  )}
                  <div className="space-y-1.5 max-h-52 overflow-y-auto">
                    {slides.map((s, i) => (
                      <div key={s.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-zinc-100 dark:border-white/8 bg-zinc-50 dark:bg-white/3">
                        {/* Slide thumb + number */}
                        <div className="w-7 h-7 rounded overflow-hidden shrink-0 bg-zinc-200 dark:bg-white/10">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={s.url} alt="" className="w-full h-full object-cover" />
                        </div>
                        <span className="text-[10px] font-medium text-zinc-400 shrink-0 w-4">{i + 1}</span>

                        {/* Audio info or upload */}
                        {s.audioSrc ? (
                          <>
                            <Music size={11} className="text-violet-500 shrink-0" />
                            <span className="text-[11px] text-zinc-600 dark:text-zinc-300 flex-1 truncate">{s.audioName}</span>
                            <button onClick={() => removeSlideAudio(s.id)}
                              className="text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent shrink-0 transition-colors">
                              <X size={11} />
                            </button>
                          </>
                        ) : (
                          <label className="flex-1 flex items-center gap-1.5 cursor-pointer">
                            <input type="file" accept="audio/*" className="hidden"
                              onChange={e => { const f = e.target.files?.[0]; if (f) loadSlideAudio(s.id, f); }} />
                            <Music size={11} className="text-zinc-300 dark:text-zinc-600 shrink-0" />
                            <span className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">+ Add audio</span>
                          </label>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Global volume */}
                  <div className="flex items-center gap-2.5 pt-1">
                    <Volume2 size={13} className="text-zinc-400 shrink-0" />
                    <input type="range" min={0} max={1} step={0.01} value={audioVol}
                      onChange={e => setAudioVol(parseFloat(e.target.value))}
                      className="flex-1 accent-violet-500" />
                    <span className="text-[11px] text-zinc-400 w-8 text-right tabular-nums">{Math.round(audioVol * 100)}%</span>
                  </div>
                </div>
              ) : (
                /* ── Multi-track audio (combined mode) ── */
                <div className="space-y-2">
                  {/* Track list */}
                  {audioTracks.length > 0 && (
                    <div className="space-y-1 max-h-44 overflow-y-auto">
                      {audioTracks.map((t, i) => {
                        const mins = Math.floor(t.durationSecs / 60);
                        const secs = Math.round(t.durationSecs % 60);
                        return (
                          <div key={t.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-zinc-100 dark:border-white/8 bg-zinc-50 dark:bg-white/3">
                            <span className="text-[10px] font-bold text-zinc-400 shrink-0 w-3.5 tabular-nums">{i + 1}</span>
                            <Music size={11} className="text-violet-500 shrink-0" />
                            <span className="text-[11px] text-zinc-700 dark:text-zinc-300 flex-1 truncate">{t.name}</span>
                            <span className="text-[10px] text-zinc-400 tabular-nums shrink-0">
                              {mins}:{String(secs).padStart(2,"0")}
                            </span>
                            <button onClick={() => removeAudioTrack(t.id)}
                              className="text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent transition-colors shrink-0">
                              <X size={11} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Upload local audio track(s) */}
                  <label className="flex items-center gap-2.5 h-9 px-3 rounded-lg border border-dashed border-zinc-200 dark:border-white/10 cursor-pointer hover:bg-zinc-50 dark:hover:bg-white/3 transition-colors">
                    <input type="file" accept="audio/*" multiple className="hidden"
                      onChange={e => addAudioTracks(e.target.files)} />
                    <Music size={13} className="text-zinc-400" />
                    <span className="text-[12px] text-zinc-500">
                      {audioTracks.length === 0 ? "Upload audio track(s)" : "+ Add more tracks"}
                    </span>
                  </label>

                  {audioTracks.length > 0 && (
                    <>
                      <p className="text-[10px] text-zinc-400 pl-1">
                        Tracks play in sequence · loops to fill video · overflow cut off
                      </p>
                      <div className="flex items-center gap-2.5">
                        <Volume2 size={13} className="text-zinc-400 shrink-0" />
                        <input type="range" min={0} max={1} step={0.01} value={audioVol}
                          onChange={e => setAudioVol(parseFloat(e.target.value))}
                          className="flex-1 accent-violet-500" />
                        <span className="text-[11px] text-zinc-400 w-8 text-right tabular-nums">{Math.round(audioVol * 100)}%</span>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>

            {/* ── Watermark ── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <button onClick={() => toggleSection("watermark")} className="flex items-center gap-1.5 cursor-pointer border-none bg-transparent p-0 group">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-400 group-hover:text-zinc-300 dark:group-hover:text-zinc-200 transition-colors">Watermark</p>
                  <ChevronRight size={11} className="text-zinc-500 transition-transform duration-200" style={{ transform: collapsedSections.has("watermark") ? "rotate(0deg)" : "rotate(90deg)" }} />
                </button>
                <ToggleSwitch checked={wm.enabled} onChange={v => setWm(w => ({ ...w, enabled: v }))} />
              </div>
              {!collapsedSections.has("watermark") && wm.enabled && (
                <WatermarkSettings value={wm} onChange={setWm} />
              )}
            </div>

            {/* ── Progress Bar ── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <button onClick={() => toggleSection("progressbar")} className="flex items-center gap-1.5 cursor-pointer border-none bg-transparent p-0 group">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-400 group-hover:text-zinc-300 dark:group-hover:text-zinc-200 transition-colors">Progress Bar</p>
                  <ChevronRight size={11} className="text-zinc-500 transition-transform duration-200" style={{ transform: collapsedSections.has("progressbar") ? "rotate(0deg)" : "rotate(90deg)" }} />
                </button>
                <ToggleSwitch checked={pb.enabled} onChange={v => setPb(c => ({ ...c, enabled: v }))} />
              </div>
              {!collapsedSections.has("progressbar") && (
                <div className="space-y-3" style={{ opacity: pb.enabled ? 1 : 0.45, pointerEvents: pb.enabled ? "auto" : "none" }}>

                  {/* Style grid */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-1.5">Style</p>
                    <div className="grid grid-cols-4 gap-1">
                      {(Object.keys(PB_STYLE_LABELS) as ProgressBarStyle[]).map(s => {
                        const active = pb.style === s;
                        return (
                          <button key={s} onClick={() => setPb(c => ({ ...c, style: s }))}
                            className="h-8 rounded-lg border cursor-pointer text-[9px] font-bold transition-all"
                            style={{
                              background: active ? "rgba(61,126,253,0.1)" : "transparent",
                              borderColor: active ? "rgba(61,126,253,0.45)" : "rgba(113,113,122,0.2)",
                              color: active ? "#3D7EFD" : undefined,
                            }}>
                            {PB_STYLE_LABELS[s]}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Mini live preview */}
                  <div className="rounded-lg overflow-hidden border border-zinc-200 dark:border-white/8" style={{ height: 32, background: "#18181b", position: "relative" }}>
                    <div style={{
                      position:"absolute",
                      left: pb.margin / 10, right: pb.margin / 10,
                      [pb.position]: pb.margin / 10,
                      height: Math.max(2, pb.height / 4),
                      opacity: pb.opacity,
                    }}>
                      {pb.showTrack && <div style={{ position:"absolute", inset:0, borderRadius: pb.rounded ? 999 : 2, background: pb.trackColor, opacity: pb.trackOpacity }} />}
                      <div style={{
                        position:"absolute", top:0, left:0, bottom:0, width:"60%",
                        borderRadius: pb.rounded || pb.style === "pill" ? 999 : 2,
                        background: pb.style === "gradient" ? `linear-gradient(90deg,${pb.color},${pb.color2})`
                          : pb.style === "striped" ? `repeating-linear-gradient(45deg,${pb.color} 0px,${pb.color} 4px,${pb.color2} 4px,${pb.color2} 8px)`
                          : pb.color,
                        boxShadow: pb.style === "glow" ? `0 0 6px ${pb.color}` : pb.style === "neon" ? `0 0 8px ${pb.color},0 0 16px ${pb.color}` : "none",
                      }} />
                    </div>
                  </div>

                  {/* Position */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-1.5">Position</p>
                    <div className="flex rounded-lg border border-zinc-200 dark:border-white/10 overflow-hidden p-0.5 gap-0.5 bg-zinc-100 dark:bg-white/5">
                      {(["top","bottom"] as ProgressBarPos[]).map(pos => {
                        const active = pb.position === pos;
                        return (
                          <button key={pos} onClick={() => setPb(c => ({ ...c, position: pos }))}
                            className="flex-1 h-7 rounded-md cursor-pointer border-none text-[10px] font-bold transition-all"
                            style={{ background: active ? "rgba(61,126,253,0.12)" : "transparent", color: active ? "#3D7EFD" : undefined }}>
                            {pos === "top" ? "↑ Top" : "↓ Bottom"}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Height */}
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] font-medium text-zinc-400 shrink-0 w-12">Height</span>
                    <input type="range" min={2} max={40} step={1} value={pb.height}
                      onChange={e => setPb(c => ({ ...c, height: parseInt(e.target.value) }))}
                      className="flex-1 accent-violet-500" />
                    <span className="text-[10px] text-zinc-400 tabular-nums w-6 text-right">{pb.height}</span>
                  </div>

                  {/* Margin */}
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] font-medium text-zinc-400 shrink-0 w-12">Margin</span>
                    <input type="range" min={0} max={80} step={2} value={pb.margin}
                      onChange={e => setPb(c => ({ ...c, margin: parseInt(e.target.value) }))}
                      className="flex-1 accent-violet-500" />
                    <span className="text-[10px] text-zinc-400 tabular-nums w-6 text-right">{pb.margin}</span>
                  </div>

                  {/* Opacity */}
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] font-medium text-zinc-400 shrink-0 w-12">Opacity</span>
                    <input type="range" min={0.1} max={1} step={0.05} value={pb.opacity}
                      onChange={e => setPb(c => ({ ...c, opacity: parseFloat(e.target.value) }))}
                      className="flex-1 accent-violet-500" />
                    <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">{Math.round(pb.opacity*100)}%</span>
                  </div>

                  {/* Colors */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-[10px] font-medium text-zinc-400 mb-1">{pb.style === "gradient" || pb.style === "striped" ? "Color 1" : "Color"}</p>
                      <div className="flex gap-1.5">
                        <ColorButton value={pb.color} onChange={v => setPb(c => ({ ...c, color: v }))} size={32} />
                        <input type="text" value={pb.color} onChange={e => setPb(c => ({ ...c, color: e.target.value }))}
                          className="flex-1 h-8 px-2 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 text-[10px] text-zinc-600 dark:text-zinc-300 outline-none font-mono" maxLength={7} />
                      </div>
                    </div>
                    {(pb.style === "gradient" || pb.style === "striped") && (
                      <div>
                        <p className="text-[10px] font-medium text-zinc-400 mb-1">Color 2</p>
                        <div className="flex gap-1.5">
                          <ColorButton value={pb.color2} onChange={v => setPb(c => ({ ...c, color2: v }))} size={32} />
                          <input type="text" value={pb.color2} onChange={e => setPb(c => ({ ...c, color2: e.target.value }))}
                            className="flex-1 h-8 px-2 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 text-[10px] text-zinc-600 dark:text-zinc-300 outline-none font-mono" maxLength={7} />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Rounded + Track row */}
                  <div className="flex items-center gap-3 pt-1">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={pb.rounded} onChange={e => setPb(c => ({ ...c, rounded: e.target.checked }))} className="accent-violet-500" />
                      <span className="text-[10px] font-medium text-zinc-500">Rounded</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={pb.showTrack} onChange={e => setPb(c => ({ ...c, showTrack: e.target.checked }))} className="accent-violet-500" />
                      <span className="text-[10px] font-medium text-zinc-500">Track</span>
                    </label>
                    {pb.showTrack && (
                      <div className="flex items-center gap-1.5 flex-1">
                        <ColorButton value={pb.trackColor} onChange={v => setPb(c => ({ ...c, trackColor: v }))} size={24} />
                        <input type="range" min={0.05} max={0.6} step={0.05} value={pb.trackOpacity}
                          onChange={e => setPb(c => ({ ...c, trackOpacity: parseFloat(e.target.value) }))}
                          className="flex-1 accent-violet-500" />
                        <span className="text-[10px] text-zinc-400 tabular-nums w-6 text-right">{Math.round(pb.trackOpacity*100)}%</span>
                      </div>
                    )}
                  </div>

                </div>
              )}
            </div>
          </div>
        </div>
        )}

        {/* Reopen styling button when collapsed */}
        {!rightOpen && (
          <button onClick={() => setRightOpen(true)} title="Styling" className="absolute top-3 right-3 z-30 w-9 h-9 rounded-lg flex items-center justify-center bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 text-zinc-500 hover:text-violet-500 shadow-sm cursor-pointer transition-colors">
            <SlidersHorizontal size={16} />
          </button>
        )}

        {/* ── CENTER: preview panel ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Toolbar header — output switcher now lives in the top header; this row
              keeps the preview info pills (the switcher moved up top, TTS-style). */}
          <div className="flex items-center justify-end px-4 py-3 border-b border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] shrink-0 gap-4">
            {/* Video info pills */}
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8">
                <Ratio size={11} className="text-zinc-400" />
                <span className="text-[11px] font-bold text-zinc-600 dark:text-zinc-300">{ratio}</span>
              </span>
              <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 text-[11px] text-zinc-500 dark:text-zinc-400">{compW}×{compH}</span>
              <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{totalSeconds}s</span>
              <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 text-[11px] text-zinc-400">{FPS}fps</span>
              {separateMode && slides.length > 0 && (
                <span className="px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[11px] font-semibold text-violet-500">
                  {safePreviewIdx + 1} / {slides.length}
                </span>
              )}
              {slides.length > 0 && (
                <span className="px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/6 border border-zinc-200 dark:border-white/8 text-[11px] text-zinc-400">
                  {slides.length} {separateMode ? "videos" : "clips"}
                </span>
              )}
              {audioSrc && (
                <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[11px] font-semibold text-violet-500">
                  <Music size={10}/> Audio
                </span>
              )}
              {wm.enabled && (
                <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[11px] font-semibold text-violet-500">
                  <Type size={10}/> Watermark
                </span>
              )}
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 overflow-hidden">

          {/* Player — the single-engine canvas preview (same draw code as the export).
              A media-load/init failure swaps it for the error card. */}
          <div className="relative flex-1 w-full flex items-center justify-center overflow-hidden">
            {previewError != null ? (
              <PreviewErrorCard
                error={previewError}
                operation="image-to-video-preview"
                onRetry={retryPreview}
              />
            ) : (
              <SlideshowCanvasPreview
                key={`${ratio}-${slides.length}-${previewNonce}`}
                ref={canvasPreviewRef}
                slides={playerSlides}
                totalFrames={totalFrames}
                cw={compW}
                ch={compH}
                bgColor={bgColor}
                blurAmount={blurAmount}
                brightness={brightness}
                saturation={saturation}
                effectSpeed={effectSpeed}
                transitionType={transitionType}
                transitionFrames={transitionFrames}
                wm={wm}
                progressBar={pb}
                audioSrc={separateMode ? previewAudioSrc : null}
                audioTracks={separateMode ? [] : audioTracks.map(t => ({ src: t.src, durationSecs: t.durationSecs }))}
                audioVol={audioVol}
                audioFadeIn={audioFadeIn}
                audioFadeOut={audioFadeOut}
                maxWidth={520}
                maxHeight={520}
                onError={onPreviewError}
              />
            )}
          </div>

          {/* Combined mode — timeline strip */}
          {!separateMode && (
            <SlideshowTimeline
              slides={slides}
              compSlides={compSlides}
              totalFrames={totalFrames}
              currentFrame={currentFrame}
              onSeek={f => { setCurrentFrame(f); previewSeekTo(f); }}
              onReorder={reorderSlides}
              onResize={(idx, secs) => {
                const rounded = Math.round(secs * 10) / 10;
                setSlides(prev => prev.map((s, i) => i === idx ? { ...s, duration: Math.max(0.5, rounded) } : s));
              }}
            />
          )}

          {/* Separate mode — slide navigation */}
          {separateMode && slides.length > 0 && (
            <div className="flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-white/5 overflow-hidden">
              <button
                onClick={() => { setPreviewIdx(i => Math.max(0, i - 1)); previewSeekTo(0); }}
                disabled={safePreviewIdx === 0}
                className="w-8 h-9 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/8 disabled:opacity-30 cursor-pointer border-none bg-transparent transition-colors">
                <ChevronLeft size={14} />
              </button>
              <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 px-2 tabular-nums min-w-[52px] text-center">
                {safePreviewIdx + 1} / {slides.length}
              </span>
              <button
                onClick={() => { setPreviewIdx(i => Math.min(slides.length - 1, i + 1)); previewSeekTo(0); }}
                disabled={safePreviewIdx === slides.length - 1}
                className="w-8 h-9 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/8 disabled:opacity-30 cursor-pointer border-none bg-transparent transition-colors">
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          {slides.length === 0 && (
            <div className="absolute flex flex-col items-center gap-2 pointer-events-none">
              <ImgIcon size={32} className="text-zinc-300 dark:text-zinc-700" />
              <p className="text-[13px] text-zinc-400 dark:text-zinc-600">Upload images to see the preview</p>
            </div>
          )}
          </div>{/* /content area */}
        </div>
        </div>
      </div>

      {/* ── Help modal ── */}
      {showHelp && (
        <div
          className="fixed inset-below-titlebar z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
          onClick={() => setShowHelp(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 shadow-2xl overflow-hidden"
            style={{ background: "#111114" }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: "rgba(61,126,253,0.15)" }}>
                  <Info size={12} className="text-violet-400" />
                </div>
                <span className="text-[14px] font-bold text-zinc-100">How Image to Video Works</span>
              </div>
              <button
                onClick={() => setShowHelp(false)}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/8 cursor-pointer border-none bg-transparent transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4 overflow-y-auto" style={{ maxHeight: "72vh" }}>

              {/* Output mode comparison */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2.5">Output Mode</p>
                <div className="grid grid-cols-2 gap-2.5">
                  {/* Combined */}
                  <div className="rounded-xl p-3.5 border" style={{ background: "rgba(61,126,253,0.05)", borderColor: "rgba(61,126,253,0.2)" }}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Film size={11} className="text-violet-400 shrink-0" />
                      <span className="text-[12px] font-bold text-violet-400">Combined</span>
                    </div>
                    <p className="text-[10px] text-zinc-400 mb-2.5 leading-relaxed">
                      All images merge into <span className="text-zinc-200 font-medium">one single video</span>
                    </p>
                    <ul className="space-y-1.5">
                      {["Effects cycle in sequence", "Shared background audio", "Single output file", "Great for slideshows"].map(item => (
                        <li key={item} className="flex items-start gap-1.5">
                          <span className="w-1 h-1 rounded-full bg-violet-500/60 shrink-0 mt-1.5" />
                          <span className="text-[10px] text-zinc-400 leading-snug">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {/* Separate */}
                  <div className="rounded-xl p-3.5 border border-white/8 bg-white/[0.03]">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Layers size={11} className="text-blue-400 shrink-0" />
                      <span className="text-[12px] font-bold text-blue-400">Separate</span>
                    </div>
                    <p className="text-[10px] text-zinc-400 mb-2.5 leading-relaxed">
                      Each image becomes its <span className="text-zinc-200 font-medium">own video clip</span>
                    </p>
                    <ul className="space-y-1.5">
                      {["Effects random per clip", "Per-slide audio", "N output files", "Great for social posts"].map(item => (
                        <li key={item} className="flex items-start gap-1.5">
                          <span className="w-1 h-1 rounded-full bg-blue-500/60 shrink-0 mt-1.5" />
                          <span className="text-[10px] text-zinc-400 leading-snug">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              {/* Feature list */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2.5">Features</p>
                <div className="rounded-xl border border-white/8 overflow-hidden">
                  {[
                    {
                      color: "#3D7EFD",
                      label: "Effects",
                      desc: "Camera motion on each slide. Click thumbnails to toggle on/off. Multiple effects cycle in sequence (combined) or are randomly assigned per clip (separate).",
                    },
                    {
                      color: "#f59e0b",
                      label: "Speed",
                      desc: "Controls how fast and intense the motion is. Lower = subtle drift, higher = dramatic movement.",
                    },
                    {
                      color: "#22d3ee",
                      label: "Color Adjust",
                      desc: "Brightness and saturation for all slides. 100% = original. Go lower for a dark/moody feel, higher for vivid punch.",
                    },
                    {
                      color: "#7FA5FE",
                      label: "Watermark",
                      desc: "Overlay your brand text or logo on the video. Control position, size, opacity, and font.",
                    },
                    {
                      color: "#34d399",
                      label: "Background Audio",
                      desc: "Add music that plays across the whole video. Supports multiple tracks in sequence with fade in/out.",
                    },
                  ].map(({ color, label, desc }, i, arr) => {
                    const isOpen = openFeature === label;
                    return (
                      <div
                        key={label}
                        style={{ borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.06)" : "none" }}
                      >
                        <button
                          onClick={() => setOpenFeature(isOpen ? null : label)}
                          className="w-full flex items-center gap-3 px-3.5 py-3 cursor-pointer border-none bg-transparent text-left transition-colors hover:bg-white/[0.03]"
                        >
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                          <span className="flex-1 text-[11px] font-semibold text-zinc-200">{label}</span>
                          <ChevronRight
                            size={11}
                            className="text-zinc-600 transition-transform duration-200"
                            style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
                          />
                        </button>
                        {isOpen && (
                          <div className="px-3.5 pb-3" style={{ paddingLeft: "2.25rem" }}>
                            <p className="text-[10px] text-zinc-500 leading-relaxed">{desc}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Tip */}
              <div className="flex gap-2.5 rounded-xl px-3.5 py-3" style={{ background: "rgba(61,126,253,0.06)", border: "1px solid rgba(61,126,253,0.15)" }}>
                <span className="text-[13px] shrink-0 mt-0.5">💡</span>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  <span className="text-zinc-200 font-semibold">Tip:</span> Start with{" "}
                  <span className="text-violet-400 font-semibold">Combined</span> for one polished video, or use{" "}
                  <span className="text-blue-400 font-semibold">Separate</span> to batch-export clips for social posts.
                </p>
              </div>

            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
