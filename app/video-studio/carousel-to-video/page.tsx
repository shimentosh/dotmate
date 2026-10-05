"use client";
import { useState, useRef, useCallback, useMemo, useEffect, forwardRef, useImperativeHandle } from "react";
import { ColorButton } from "@/components/editor/paint-picker";
import AppLayout from "@/components/layout/app-layout";
import {
  X, Trash2, AlertCircle, Film, GripVertical,
  Info, Download, Loader2, CheckCircle2, Volume2, ImagePlus, Music,
  Play, Pause,
  RectangleHorizontal, RectangleVertical, Square, Shrink, Expand, Focus,
  Clock, Palette,
} from "lucide-react";
import { PreviewErrorCard } from "@/components/preview/preview-error-card";
import { FieldLabel, inputCls, SectionTitle, ToggleSwitch } from "@/components/tools/ui";
import { type WatermarkCfg, type WMPos, DEFAULT_WATERMARK } from "@/components/tools/watermark-settings";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import { MusicLibraryBrowser } from "@/components/tools/music-library-browser";
import { logDebug, logError } from "@/lib/log";
import { surfaceError } from "@/lib/toast";
import { humanizeError } from "@/lib/error/app-error";
import { useRegisterTask } from "@/hooks/use-register-task";
import { useRenderJobs } from "@/store/render-jobs";

/* ── Types ──────────────────────────────────────────────────────────────── */

type MediaType  = "image" | "video";
type FitMode    = "contain" | "cover" | "blur-fill";
type AspRatio   = "16:9" | "9:16" | "1:1" | "4:5" | "3:4";

export type TransitionStyle =
  | "fade"
  | "slide-left" | "slide-right" | "slide-up" | "slide-down"
  | "push-left"  | "push-right"  | "push-up"   | "push-down"
  | "zoom-in"    | "zoom-out"
  | "wipe-right" | "wipe-left"   | "wipe-up"
  | "3d-flip-h"  | "3d-flip-v"
  | "glitch"     | "cube-left";

interface MediaItem {
  id: string;
  url: string;
  name: string;
  type: MediaType;
  duration: number;
  fitMode: FitMode;
  videoDuration?: number;
}
interface AudioTrack { id: string; src: string; name: string; durationSecs: number; }

type SlideTemplate = "none" | "lower-third" | "big-title" | "typewriter" | "neon" | "glitch-fx" | "film" | "lines";
type LayoutMode = "fullscreen" | "fan" | "split" | "float" | "tilt" | "tinder" | "filmstrip" | "polaroid" | "spotlight" | "story" | "magazine" | "vintage" | "neon-frame" | "gallery";
type FanStyle = "trio" | "duo" | "solo" | "peek" | "stack";
const LAYOUT_META: { id: LayoutMode; label: string; desc: string }[] = [
  { id: "fullscreen", label: "Full Screen",  desc: "Classic full-frame" },
  { id: "fan",        label: "3D Carousel",  desc: "Multi-card depth" },
  { id: "split",      label: "Split Panel",  desc: "Dual-panel editorial" },
  { id: "float",      label: "Float Glow",   desc: "Levitating card" },
  { id: "tilt",       label: "Tilt Stack",   desc: "Angled scatter" },
  { id: "tinder",     label: "Tinder",       desc: "Swipe cards" },
  { id: "filmstrip",  label: "Filmstrip",    desc: "Film reel strip" },
  { id: "polaroid",   label: "Polaroid",     desc: "Photo prints" },
  { id: "spotlight",  label: "Spotlight",    desc: "Stage focus" },
  { id: "story",      label: "Story",        desc: "Social stories" },
  { id: "magazine",   label: "Magazine",     desc: "Editorial cover" },
  { id: "vintage",    label: "Vintage",      desc: "Retro film look" },
  { id: "neon-frame", label: "Neon Frame",   desc: "Cyberpunk glow" },
  { id: "gallery",    label: "Gallery",      desc: "Museum wall" },
];

const FAN_STYLE_META: { id: FanStyle; label: string; desc: string }[] = [
  { id: "trio",  label: "Trio",   desc: "3 cards" },
  { id: "duo",   label: "Duo",    desc: "2 cards" },
  { id: "solo",  label: "Solo",   desc: "1 focused" },
  { id: "peek",  label: "Peek",   desc: "Big + slivers" },
  { id: "stack", label: "Stack",  desc: "Deck depth" },
];

interface TemplateCfg {
  line1: string;
  line2: string;
  accentColor: string;
}

const DEFAULT_TEMPLATE_CFG: TemplateCfg = {
  line1: "", line2: "", accentColor: "#3D7EFD",
};

const TEMPLATE_LABELS: Record<SlideTemplate, string> = {
  "none": "None", "lower-third": "Lower Third", "big-title": "Big Title",
  "typewriter": "Typewriter", "neon": "Neon Glow", "glitch-fx": "Glitch",
  "film": "Film", "lines": "Lines",
};

/* ── Constants ───────────────────────────────────────────────────────────── */

const FPS  = 30;
const DIMS: Record<AspRatio, { w: number; h: number }> = {
  "16:9": { w: 1280, h: 720  },
  "9:16": { w: 720,  h: 1280 },
  "1:1":  { w: 1080, h: 1080 },
  "4:5":  { w: 864,  h: 1080 },
  "3:4":  { w: 810,  h: 1080 },
};

const TRANSITION_LABELS: Record<TransitionStyle, string> = {
  "fade":      "Fade",
  "slide-left":"Slide Left", "slide-right":"Slide Right",
  "slide-up":  "Slide Up",   "slide-down": "Slide Down",
  "push-left": "Push Left",  "push-right": "Push Right",
  "push-up":   "Push Up",    "push-down":  "Push Down",
  "zoom-in":   "Zoom In",    "zoom-out":   "Zoom Out",
  "wipe-right":"Wipe Right", "wipe-left":  "Wipe Left", "wipe-up": "Wipe Up",
  "3d-flip-h": "3D Flip H",  "3d-flip-v":  "3D Flip V",
  "glitch":    "Glitch",     "cube-left":  "3D Cube",
};

const ALL_TRANSITIONS: TransitionStyle[] = [
  "fade",
  "slide-left", "slide-right", "slide-up", "slide-down",
  "push-left",  "push-right",  "push-up",  "push-down",
  "zoom-in",    "zoom-out",
  "wipe-right", "wipe-left",   "wipe-up",
  "3d-flip-h",  "3d-flip-v",
  "glitch",     "cube-left",
];

/* ── Easing ──────────────────────────────────────────────────────────────── */

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

/* ── Fan layout computation ──────────────────────────────────────────────── */

interface FanCardDef {
  url: string; type: MediaType; timelineIdx: number;
  x: number; y: number; w: number; h: number;
  opacity: number; rotation: number; scale: number;
  isMain: boolean; zOrder: number;
}

type FanTL = { url: string; type: MediaType; dframes: number; start: number; end: number };

function computeFanLayout(
  fanStyle: FanStyle, W: number, H: number,
  ci: number, timeline: FanTL[],
  inTransition: boolean, tPraw: number,
  cardScale = 1,
): FanCardDef[] {
  const s = cardScale;
  const tP = easeOutCubic(Math.min(1, Math.max(0, tPraw)));
  const cur  = timeline[ci];
  const prev = ci > 0 ? timeline[ci - 1] : null;
  const next = ci < timeline.length - 1 ? timeline[ci + 1] : null;
  const pp   = ci > 1 ? timeline[ci - 2] : null;
  const nn   = ci < timeline.length - 2 ? timeline[ci + 2] : null;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  if (fanStyle === "trio") {
    const cW = W*0.60*s, cH = H*0.78*s, sW = W*0.38*s, sH = H*0.72*s;
    const cx0 = (W-cW)/2, cy0 = (H-cH)/2, sy0 = (H-sH)/2;
    const gap = W*0.030, lx0 = cx0-sW-gap, rx0 = cx0+cW+gap;
    const cards: FanCardDef[] = [];
    if (pp && inTransition && tP > 0)
      cards.push({ url:pp.url, type:pp.type, timelineIdx:ci-2, x:lx0-(sW+gap)*tP, y:sy0, w:sW, h:sH, opacity:0.75*(1-tP), rotation:0, scale:1, isMain:false, zOrder:0 });
    if (next)
      cards.push({ url:next.url, type:next.type, timelineIdx:ci+1, x:inTransition?rx0+sW*(1-tP):rx0, y:sy0, w:sW, h:sH, opacity:inTransition?0.75*tP:0.75, rotation:0, scale:1, isMain:false, zOrder:1 });
    if (prev)
      cards.push({ url:prev.url, type:prev.type, timelineIdx:ci-1,
        x:lerp(inTransition?cx0:lx0, inTransition?lx0:lx0, inTransition?tP:0),
        y:lerp(inTransition?cy0:sy0, inTransition?sy0:sy0, inTransition?tP:0),
        w:lerp(inTransition?cW:sW, inTransition?sW:sW, inTransition?tP:0),
        h:lerp(inTransition?cH:sH, inTransition?sH:sH, inTransition?tP:0),
        opacity:inTransition?1-0.25*tP:0.75, rotation:0, scale:1, isMain:false, zOrder:2 });
    cards.push({ url:cur.url, type:cur.type, timelineIdx:ci,
      x:inTransition?lerp(rx0,cx0,tP):cx0, y:inTransition?lerp(sy0,cy0,tP):cy0,
      w:inTransition?lerp(sW,cW,tP):cW, h:inTransition?lerp(sH,cH,tP):cH,
      opacity:inTransition?lerp(0.75,1,tP):1, rotation:0, scale:1, isMain:true, zOrder:3 });
    return cards;
  }

  if (fanStyle === "duo") {
    const cW = W*0.62*s, cH = H*0.80*s, nW = W*0.36*s, nH = H*0.74*s;
    const gap = W*0.025, cx0 = (W-(cW+gap+nW))/2, cy0 = (H-cH)/2;
    const nx0 = cx0+cW+gap, ny0 = (H-nH)/2;
    const cards: FanCardDef[] = [];
    if (prev && inTransition)
      cards.push({ url:prev.url, type:prev.type, timelineIdx:ci-1,
        x:cx0-(cW+W*0.06)*tP, y:cy0, w:cW, h:cH, opacity:1-tP, rotation:0, scale:1, isMain:false, zOrder:0 });
    cards.push({ url:cur.url, type:cur.type, timelineIdx:ci,
      x:inTransition?lerp(nx0,cx0,tP):cx0, y:inTransition?lerp(ny0,cy0,tP):cy0,
      w:inTransition?lerp(nW,cW,tP):cW, h:inTransition?lerp(nH,cH,tP):cH,
      opacity:inTransition?lerp(0.78,1,tP):1, rotation:0, scale:1, isMain:true, zOrder:2 });
    if (next)
      cards.push({ url:next.url, type:next.type, timelineIdx:ci+1,
        x:inTransition?nx0+(nW+W*0.05)*(1-tP):nx0, y:ny0, w:nW, h:nH,
        opacity:inTransition?0.78*tP:0.78, rotation:0, scale:1, isMain:false, zOrder:1 });
    return cards;
  }

  if (fanStyle === "solo") {
    const cW = W*0.80*s, cH = H*0.84*s, cx0 = (W-cW)/2, cy0 = (H-cH)/2;
    const cards: FanCardDef[] = [];
    if (prev && inTransition)
      cards.push({ url:prev.url, type:prev.type, timelineIdx:ci-1, x:cx0, y:cy0, w:cW, h:cH, opacity:1-tP, rotation:0, scale:1, isMain:false, zOrder:0 });
    cards.push({ url:cur.url, type:cur.type, timelineIdx:ci, x:cx0, y:cy0, w:cW, h:cH, opacity:inTransition?tP:1, rotation:0, scale:1, isMain:true, zOrder:1 });
    return cards;
  }

  if (fanStyle === "peek") {
    const cW = W*0.80*s, cH = H*0.82*s, sW = W*0.10*s, sH = H*0.76*s;
    const cx0 = (W-cW)/2, cy0 = (H-cH)/2, sy0 = (H-sH)/2;
    const gap = W*0.008, lx0 = cx0-sW-gap, rx0 = cx0+cW+gap;
    const cards: FanCardDef[] = [];
    if (pp && inTransition && tP > 0)
      cards.push({ url:pp.url, type:pp.type, timelineIdx:ci-2, x:lx0-(sW+gap)*tP, y:sy0, w:sW, h:sH, opacity:0.55*(1-tP), rotation:0, scale:1, isMain:false, zOrder:0 });
    if (next)
      cards.push({ url:next.url, type:next.type, timelineIdx:ci+1, x:inTransition?rx0+sW*(1-tP):rx0, y:sy0, w:sW, h:sH, opacity:inTransition?0.55*tP:0.55, rotation:0, scale:1, isMain:false, zOrder:1 });
    if (prev)
      cards.push({ url:prev.url, type:prev.type, timelineIdx:ci-1,
        x:inTransition?lerp(cx0,lx0,tP):lx0, y:inTransition?lerp(cy0,sy0,tP):sy0,
        w:inTransition?lerp(cW,sW,tP):sW, h:inTransition?lerp(cH,sH,tP):sH,
        opacity:inTransition?lerp(1,0.55,tP):0.55, rotation:0, scale:1, isMain:false, zOrder:2 });
    cards.push({ url:cur.url, type:cur.type, timelineIdx:ci,
      x:inTransition?lerp(rx0,cx0,tP):cx0, y:inTransition?lerp(sy0,cy0,tP):cy0,
      w:inTransition?lerp(sW,cW,tP):cW, h:inTransition?lerp(sH,cH,tP):cH,
      opacity:inTransition?lerp(0.55,1,tP):1, rotation:0, scale:1, isMain:true, zOrder:3 });
    return cards;
  }

  // "stack"
  {
    const cW = W*0.72*s, cH = H*0.80*s, cx0 = (W-cW)/2, cy0 = (H-cH)/2;
    const cards: FanCardDef[] = [];
    if (inTransition) {
      if (prev)
        cards.push({ url:prev.url, type:prev.type, timelineIdx:ci-1,
          x:cx0+tP*W*0.65, y:cy0, w:cW, h:cH,
          opacity:1-tP, rotation:tP*18, scale:lerp(1,0.88,tP), isMain:false, zOrder:5 });
      if (nn)
        cards.push({ url:nn.url, type:nn.type, timelineIdx:ci+2,
          x:cx0+lerp(18,10,tP), y:cy0+lerp(14,8,tP), w:cW, h:cH,
          opacity:lerp(0.28,0.42,tP), rotation:lerp(9,5,tP), scale:lerp(0.86,0.92,tP), isMain:false, zOrder:1 });
      if (next)
        cards.push({ url:next.url, type:next.type, timelineIdx:ci+1,
          x:cx0+lerp(10,0,tP), y:cy0+lerp(8,0,tP), w:cW, h:cH,
          opacity:lerp(0.42,0.7,tP), rotation:lerp(5,0,tP), scale:lerp(0.92,1,tP), isMain:false, zOrder:2 });
      cards.push({ url:cur.url, type:cur.type, timelineIdx:ci,
        x:cx0, y:cy0, w:cW, h:cH,
        opacity:lerp(0.7,1,tP), rotation:lerp(-4,0,tP), scale:lerp(0.94,1,tP), isMain:true, zOrder:4 });
    } else {
      if (nn)
        cards.push({ url:nn.url, type:nn.type, timelineIdx:ci+2, x:cx0+18, y:cy0+14, w:cW, h:cH, opacity:0.28, rotation:9, scale:0.86, isMain:false, zOrder:1 });
      if (next)
        cards.push({ url:next.url, type:next.type, timelineIdx:ci+1, x:cx0+10, y:cy0+8, w:cW, h:cH, opacity:0.42, rotation:5, scale:0.92, isMain:false, zOrder:2 });
      cards.push({ url:cur.url, type:cur.type, timelineIdx:ci, x:cx0, y:cy0, w:cW, h:cH, opacity:1, rotation:0, scale:1, isMain:true, zOrder:3 });
    }
    return cards;
  }
}

/* ── Canvas export ───────────────────────────────────────────────────────── */

function coverFit(iw: number, ih: number, cw: number, ch: number) {
  const s = Math.max(cw / iw, ch / ih);
  return { dw: iw * s, dh: ih * s };
}
function containFit(iw: number, ih: number, cw: number, ch: number) {
  const s = Math.min(cw / iw, ch / ih);
  return { dw: iw * s, dh: ih * s };
}

async function seekVideo(vid: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(vid.currentTime - time) < 1 / FPS / 2) return;
  return new Promise(resolve => {
    const onSeeked = () => { vid.removeEventListener("seeked", onSeeked); resolve(); };
    vid.addEventListener("seeked", onSeeked);
    vid.currentTime = time;
  });
}

function drawMediaToCanvas(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  media: ImageBitmap | HTMLVideoElement,
  cw: number, ch: number,
  fitMode: FitMode, bgColor: string, blurAmount: number,
  zoom = 1,   // extra scale on the foreground media (Image Size slider); 1 = plain fit
  radiusFrac = 0,  // corner rounding as a fraction of the short side (Image Radius slider)
) {
  const w = "videoWidth" in media ? media.videoWidth  : media.width;
  const h = "videoWidth" in media ? media.videoHeight : media.height;
  // Background fills (contain letterbox / blur-fill) — full frame, NOT rounded by the
  // image radius (the CARD radius, applied by the caller's card clip, rounds the frame).
  if (fitMode === "contain") {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, cw, ch);
  } else if (fitMode === "blur-fill" && !("videoWidth" in media)) {
    ctx.save();
    ctx.filter = `blur(${blurAmount}px)`;
    const { dw: bw, dh: bh } = coverFit(w, h, cw, ch);
    ctx.drawImage(media as ImageBitmap, (cw - bw * 1.12) / 2, (ch - bh * 1.12) / 2, bw * 1.12, bh * 1.12);
    ctx.restore();
  }
  const { dw, dh } = fitMode === "contain" ? containFit(w, h, cw, ch) : coverFit(w, h, cw, ch);
  const zw = dw * zoom, zh = dh * zoom;
  const ix = (cw - zw) / 2, iy = (ch - zh) / 2;
  ctx.save();
  // Image Radius rounds the ACTUAL drawn image rect (clamped to the frame), so it
  // hugs the image even when it's smaller than the frame (Image Size < 100% / contain)
  // — clipping the full frame left the corners far from a shrunk image.
  if (radiusFrac > 0) {
    const rx0 = Math.max(0, ix), ry0 = Math.max(0, iy);
    const rw = Math.min(cw, ix + zw) - rx0, rh = Math.min(ch, iy + zh) - ry0;
    if (rw > 0 && rh > 0) { ctx.beginPath(); ctx.roundRect(rx0, ry0, rw, rh, radiusFrac * Math.min(rw, rh)); ctx.clip(); }
  }
  ctx.drawImage(media, ix, iy, zw, zh);
  ctx.restore();
}

function wmPositionPx(pos: WMPos, w: number, h: number, cw: number, ch: number) {
  const x = pos.endsWith("right") ? cw * 0.95 - w : pos.endsWith("left") ? cw * 0.05 : (cw - w) / 2;
  const y = pos.startsWith("top") ? ch * 0.05 : pos.startsWith("bottom") ? ch * 0.95 - h : (ch - h) / 2;
  return { x, y };
}

function drawWmCanvas(
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
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 8 * sc; ctx.shadowOffsetY = 2 * sc;
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
      ctx.beginPath(); ctx.roundRect(x, y, imgW, imgH, r); ctx.clip();
    }
    ctx.drawImage(wmImg, x, y, imgW, imgH);
  }
  ctx.restore();
}

// Canvas-compatible transition (2D approximations of CSS transitions)
function applyCanvasTransition(
  ctx: OffscreenCanvasRenderingContext2D,
  cw: number, ch: number,
  tempA: OffscreenCanvas, tempB: OffscreenCanvas,
  p: number, style: TransitionStyle,
) {
  const e = easeOutCubic(p);
  // NOTE: no clearRect here — the caller has already cleared+filled the full frame
  // (in unscaled space). Clearing again here runs in the scaled transform and would
  // punch transparent holes into the background fill at the borders.

  switch (style) {
    case "fade":
      ctx.drawImage(tempA, 0, 0);
      ctx.globalAlpha = e;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
      break;

    case "slide-left":
    case "push-left":
      ctx.drawImage(tempA, -e * cw, 0);
      ctx.drawImage(tempB, (1 - e) * cw, 0);
      break;

    case "slide-right":
    case "push-right":
      ctx.drawImage(tempA, e * cw, 0);
      ctx.drawImage(tempB, -(1 - e) * cw, 0);
      break;

    case "slide-up":
    case "push-up":
      ctx.drawImage(tempA, 0, -e * ch);
      ctx.drawImage(tempB, 0, (1 - e) * ch);
      break;

    case "slide-down":
    case "push-down":
      ctx.drawImage(tempA, 0, e * ch);
      ctx.drawImage(tempB, 0, -(1 - e) * ch);
      break;

    case "zoom-in":
      ctx.save();
      ctx.globalAlpha = 1 - e;
      ctx.translate(cw / 2, ch / 2);
      ctx.scale(1 + e * 0.3, 1 + e * 0.3);
      ctx.drawImage(tempA, -cw / 2, -ch / 2);
      ctx.restore();
      ctx.globalAlpha = e;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
      break;

    case "zoom-out":
      ctx.save();
      ctx.globalAlpha = 1 - e;
      ctx.translate(cw / 2, ch / 2);
      ctx.scale(1 - e * 0.3, 1 - e * 0.3);
      ctx.drawImage(tempA, -cw / 2, -ch / 2);
      ctx.restore();
      ctx.globalAlpha = e;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
      break;

    case "wipe-right":
      ctx.drawImage(tempA, 0, 0);
      ctx.drawImage(tempB, 0, 0, e * cw, ch, 0, 0, e * cw, ch);
      break;

    case "wipe-left":
      ctx.drawImage(tempA, 0, 0);
      ctx.drawImage(tempB, (1 - e) * cw, 0, e * cw, ch, (1 - e) * cw, 0, e * cw, ch);
      break;

    case "wipe-up":
      ctx.drawImage(tempA, 0, 0);
      ctx.drawImage(tempB, 0, (1 - e) * ch, cw, e * ch, 0, (1 - e) * ch, cw, e * ch);
      break;

    case "3d-flip-h":
    case "cube-left": {
      // 2D approximation: scaleX 1→0 then 0→1
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      if (e < 0.5) {
        const sx = 1 - e * 2;
        ctx.scale(sx, 1);
        ctx.drawImage(tempA, -cw / 2, -ch / 2);
      } else {
        const sx = (e - 0.5) * 2;
        ctx.scale(sx, 1);
        ctx.drawImage(tempB, -cw / 2, -ch / 2);
      }
      ctx.restore();
      break;
    }

    case "3d-flip-v": {
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      if (e < 0.5) {
        const sy = 1 - e * 2;
        ctx.scale(1, sy);
        ctx.drawImage(tempA, -cw / 2, -ch / 2);
      } else {
        const sy = (e - 0.5) * 2;
        ctx.scale(1, sy);
        ctx.drawImage(tempB, -cw / 2, -ch / 2);
      }
      ctx.restore();
      break;
    }

    case "glitch": {
      const gx = Math.round(Math.sin(e * 47) * 18 * (1 - e));
      const gy = Math.round(Math.cos(e * 31) * 10 * (1 - e));
      ctx.globalAlpha = 1 - e;
      ctx.drawImage(tempA, gx, gy);
      ctx.globalAlpha = e;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
      break;
    }

    default:
      ctx.drawImage(tempA, 0, 0);
      ctx.globalAlpha = e;
      ctx.drawImage(tempB, 0, 0);
      ctx.globalAlpha = 1;
  }
}

/* ── Canvas template overlay ─────────────────────────────────────────────── */

function drawTemplateCanvas(
  ctx: OffscreenCanvasRenderingContext2D,
  template: SlideTemplate, cfg: TemplateCfg,
  cw: number, ch: number,
  localFrame: number, totalDframes: number,
) {
  if (template === "none") return;
  const sc = cw / 720;
  const ENTER = 20, EXIT = 14;
  const eoc = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const eob = (t: number) => { const c = 2.70158; return 1 + c * Math.pow(t - 1, 3) + (c - 1) * Math.pow(t - 1, 2); };
  const cl01 = (v: number) => Math.min(1, Math.max(0, v));
  const enterP = cl01(localFrame / ENTER);
  const exitP  = cl01((localFrame - (totalDframes - EXIT)) / EXIT);

  if (template === "lower-third") {
    const slideX = (1 - eoc(enterP)) * -cw * 1.1 - exitP * cw * 1.1;
    const textOp = cl01((localFrame - 8) / 10) * (1 - exitP);
    const barH = 48 * sc, barW = 5 * sc;
    const by = ch * 0.86 - barH / 2;
    const line1 = cfg.line1 || "Your Name";
    ctx.save();
    ctx.font = `700 ${14 * sc}px Inter, sans-serif`;
    const txtW = Math.max(ctx.measureText(line1).width, cfg.line2 ? ctx.measureText(cfg.line2.toUpperCase()).width : 0);
    const boxW = txtW + 34 * sc;
    ctx.fillStyle = cfg.accentColor;
    ctx.fillRect(slideX, by, barW, barH);
    ctx.fillStyle = "rgba(8,8,10,0.9)";
    ctx.fillRect(slideX + barW, by, boxW, barH);
    ctx.globalAlpha = textOp;
    ctx.fillStyle = "#fff";
    ctx.fillText(line1, slideX + barW + 14 * sc, by + barH * 0.45 + 5 * sc);
    if (cfg.line2) {
      ctx.fillStyle = cfg.accentColor;
      ctx.font = `600 ${10 * sc}px Inter, sans-serif`;
      ctx.fillText(cfg.line2.toUpperCase(), slideX + barW + 14 * sc, by + barH * 0.72 + 5 * sc);
    }
    ctx.restore();
    return;
  }

  if (template === "big-title") {
    const sp = eob(cl01(localFrame / 24));
    const ty = (1 - sp) * 55 * sc;
    const op = cl01(localFrame / 12) * (1 - exitP);
    const grad = ctx.createLinearGradient(0, ch * 0.4, 0, ch);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,0.75)");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.globalAlpha = op;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 24 * sc; ctx.shadowOffsetY = 4 * sc;
    ctx.fillStyle = "#fff";
    ctx.font = `900 ${34 * sc}px Inter, sans-serif`;
    ctx.fillText(cfg.line1 || "BIG TITLE", cw / 2, ch * 0.84 + ty - (cfg.line2 ? 14 * sc : 0));
    if (cfg.line2) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = cfg.accentColor;
      ctx.font = `600 ${12 * sc}px Inter, sans-serif`;
      ctx.fillText(cfg.line2.toUpperCase(), cw / 2, ch * 0.84 + ty + 16 * sc);
    }
    ctx.textAlign = "left";
    ctx.restore();
    return;
  }

  if (template === "typewriter") {
    const text = cfg.line1 || "Your text appears here...";
    const writeEnd = Math.round(totalDframes * 0.68);
    const chars = Math.floor(cl01(localFrame / writeEnd) * text.length);
    const cursor = Math.floor(localFrame / 7) % 2 === 0 && localFrame < totalDframes * 0.9;
    const sub = cl01((localFrame - writeEnd) / 12);
    const grad = ctx.createLinearGradient(0, ch * 0.58, 0, ch);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,0.82)");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 8 * sc; ctx.shadowOffsetY = 2 * sc;
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${15 * sc}px "Courier New", monospace`;
    const displayed = text.slice(0, chars) + (cursor ? "|" : "");
    const maxLineW = cw - 44 * sc;
    let lineY = ch * 0.85;
    let word = "";
    const lines2: string[] = [];
    for (const ch2 of displayed) {
      const test = word + ch2;
      if (ctx.measureText(test).width > maxLineW && word) { lines2.push(word); word = ch2; } else word = test;
    }
    if (word) lines2.push(word);
    const lineH = 20 * sc;
    lineY = ch * 0.85 - (lines2.length - 1) * lineH;
    for (const l of lines2) { ctx.fillText(l, 22 * sc, lineY); lineY += lineH; }
    if (cfg.line2 && sub > 0) {
      ctx.globalAlpha = sub;
      ctx.fillStyle = cfg.accentColor;
      ctx.font = `700 ${10 * sc}px Inter, sans-serif`;
      ctx.fillText(cfg.line2.toUpperCase(), 22 * sc, lineY + 6 * sc);
    }
    ctx.restore();
    return;
  }

  if (template === "neon") {
    const op = eoc(enterP) * (1 - exitP);
    const pulse = 0.78 + Math.sin(localFrame * 0.18) * 0.22;
    const glow = (9 + pulse * 15) * sc;
    const vig = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.2, cw / 2, ch / 2, Math.min(cw, ch) * 0.75);
    vig.addColorStop(0, "rgba(0,0,0,0)"); vig.addColorStop(1, "rgba(0,0,0,0.68)");
    ctx.fillStyle = vig; ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.globalAlpha = op;
    ctx.textAlign = "center";
    ctx.fillStyle = cfg.accentColor;
    ctx.font = `900 ${28 * sc}px Inter, sans-serif`;
    ctx.shadowColor = cfg.accentColor; ctx.shadowBlur = glow * 3.5;
    ctx.fillText((cfg.line1 || "NEON").toUpperCase(), cw / 2, ch / 2 + 10 * sc);
    if (cfg.line2) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.font = `${11 * sc}px Inter, sans-serif`;
      ctx.fillText(cfg.line2.toUpperCase(), cw / 2, ch / 2 + 30 * sc);
    }
    ctx.textAlign = "left";
    ctx.restore();
    return;
  }

  if (template === "glitch-fx") {
    const f = localFrame;
    const burst = f < 10 || (f % 20 < 3 && f > 20);
    const ox = burst ? (((f * 7919) % 40) - 20) * sc : 0;
    const oy = burst ? (((f * 1337) % 20) - 10) * sc : 0;
    const op = cl01(localFrame / 6) * (1 - exitP);
    if (burst) {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = "rgba(255,0,60,0.2)"; ctx.fillRect(ox * 1.6, 0, cw, ch);
      ctx.fillStyle = "rgba(0,200,255,0.2)"; ctx.fillRect(-ox * 1.3, 0, cw, ch);
      for (let i = 0; i < 3; i++) {
        const ly = ((f * 17 + i * 31) % 100) / 100 * ch;
        const lh2 = (1 + i % 2) * sc;
        ctx.fillStyle = i % 2 === 0 ? "rgba(255,50,50,0.55)" : "rgba(50,220,255,0.55)";
        ctx.fillRect(0, ly, cw, lh2);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = op;
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = `900 ${30 * sc}px "Courier New", monospace`;
    ctx.shadowColor = cfg.accentColor; ctx.shadowBlur = Math.abs(ox) * 0.4;
    ctx.fillText((cfg.line1 || "GLITCH").toUpperCase(), cw / 2 + ox, ch / 2 + oy + 10 * sc);
    if (cfg.line2) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = cfg.accentColor;
      ctx.font = `700 ${10 * sc}px monospace`;
      ctx.fillText(cfg.line2.toUpperCase(), cw / 2, ch * 0.84);
    }
    ctx.textAlign = "left";
    ctx.restore();
    return;
  }

  if (template === "film") {
    const fo = eoc(cl01(localFrame / 12));
    const scratch = ((localFrame * 3571) % 180) < 2;
    const sx = ((localFrame * 1987) % 98) + 1;
    ctx.save();
    ctx.globalAlpha = fo;
    ctx.fillStyle = "rgba(110,70,30,0.14)"; ctx.fillRect(0, 0, cw, ch);
    const vig2 = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.2, cw / 2, ch / 2, Math.min(cw, ch) * 0.75);
    vig2.addColorStop(0, "rgba(0,0,0,0)"); vig2.addColorStop(1, "rgba(0,0,0,0.7)");
    ctx.fillStyle = vig2; ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.fillRect(0, 0, cw, ch * 0.09);
    ctx.fillRect(0, ch * 0.91, cw, ch * 0.09);
    if (scratch) {
      ctx.fillStyle = "rgba(255,235,180,0.6)"; ctx.fillRect(sx / 100 * cw, 0, sc, ch);
    }
    if (cfg.line1) {
      ctx.fillStyle = "rgba(255,235,170,0.75)";
      ctx.font = `${9.5 * sc}px "Courier New", monospace`;
      ctx.fillText(cfg.line1.toUpperCase(), 18 * sc, ch * 0.89);
    }
    ctx.restore();
    return;
  }

  if (template === "lines") {
    const lp = eoc(cl01(localFrame / 22));
    const lw = lp * 0.42 * cw;
    const top = cl01((localFrame - 18) / 14) * (1 - exitP);
    const bop = lp * (1 - exitP);
    const cy2 = ch / 2;
    const lineH2 = 1.5 * sc;
    const gap2 = 8 * sc;
    ctx.save();
    const makeLineGrad = () => {
      const g = ctx.createLinearGradient((cw - lw) / 2, 0, (cw + lw) / 2, 0);
      g.addColorStop(0, "transparent"); g.addColorStop(0.5, cfg.accentColor); g.addColorStop(1, "transparent");
      return g;
    };
    ctx.globalAlpha = bop;
    ctx.fillStyle = makeLineGrad();
    ctx.fillRect((cw - lw) / 2, cy2 - gap2 - lineH2, lw, lineH2);
    ctx.fillRect((cw - lw) / 2, cy2 + gap2, lw, lineH2);
    ctx.globalAlpha = top;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 12 * sc;
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${18 * sc}px Inter, sans-serif`;
    ctx.fillText((cfg.line1 || "TITLE").toUpperCase(), cw / 2, cy2 + 6 * sc);
    if (cfg.line2) {
      ctx.fillStyle = cfg.accentColor;
      ctx.font = `600 ${10 * sc}px Inter, sans-serif`;
      ctx.fillText(cfg.line2.toUpperCase(), cw / 2, cy2 + 22 * sc);
    }
    ctx.textAlign = "left";
    ctx.restore();
    return;
  }
}

interface RenderParams {
  items: { url: string; type: MediaType; dframes: number; fitMode: FitMode }[];
  transition: TransitionStyle;
  xfade: number;
  cw: number; ch: number; fps: number;
  audioSrc: string | null;
  audioTracks?: { src: string }[];
  audioVol: number; audioFadeIn: boolean; audioFadeOut: boolean;
  sfxSrc: string | null;
  sfxVol: number;
  template: SlideTemplate;
  templateCfg: TemplateCfg;
  wm: WatermarkCfg; bgColor: string; blurAmount: number;
  layoutMode: LayoutMode;
  fanStyle: FanStyle;
  cardScale: number;
  imageZoom: number;   // extra zoom applied to the media inside its frame/card (1 = fit)
  cardRadius: number;  // rounds the CARD/frame container, fraction of the short side
  imageRadius: number; // rounds the MEDIA itself, fraction of the short side
  brightness: number; saturation: number; contrast: number; hue: number;
  onProgress: (f: number) => void;
}

/** Load the carousel's media for canvas drawing: images → ImageBitmap, videos → a
 *  muted, preloaded <video> (seeked per frame). SHARED by the export and the
 *  single-engine preview so both draw from identical handles. */
async function loadCarouselMedia(items: RenderParams["items"]): Promise<(ImageBitmap | HTMLVideoElement)[]> {
  return Promise.all(
    items.map(async item => {
      if (item.type === "image") {
        return fetch(item.url).then(r => r.blob()).then(b => createImageBitmap(b));
      } else {
        const vid = document.createElement("video");
        vid.src = item.url;
        vid.muted = true;
        vid.preload = "auto";
        await new Promise<void>((resolve, reject) => {
          vid.oncanplaythrough = () => resolve();
          vid.onerror = () => reject(new Error(`Failed to load video: ${item.url}`));
          vid.load();
          setTimeout(() => resolve(), 5000); // fallback
        });
        return vid;
      }
    })
  );
}

/** Draw ONE carousel frame (all layout modes + transitions + templates + watermark) —
 *  the SHARED per-frame renderer used by BOTH the export loop and the single-engine
 *  preview, so preview == export by construction. Videos are seeked to the exact
 *  frame time, matching the export. The colour pass (brightness/saturation/contrast/
 *  hue) is applied by the caller. */
async function drawCarouselFrame(o: {
  ctx: OffscreenCanvasRenderingContext2D;
  ctxA: OffscreenCanvasRenderingContext2D;
  ctxB: OffscreenCanvasRenderingContext2D;
  tempA: OffscreenCanvas;
  tempB: OffscreenCanvas;
  frame: number;
  timeline: (RenderParams["items"][number] & { start: number; end: number; idx: number })[];
  mediaHandles: (ImageBitmap | HTMLVideoElement)[];
  wmImg: ImageBitmap | null;
  params: RenderParams;
}): Promise<void> {
  const { ctx, ctxA, ctxB, tempA, tempB, frame, timeline, mediaHandles, wmImg, params } = o;
  const { transition, xfade, cw, ch, fps, template, templateCfg, wm, bgColor, blurAmount, fanStyle, cardScale, imageZoom, cardRadius, imageRadius } = params;
    // Clear + fill the WHOLE frame first, every frame — before any layout scaling.
    // Layouts that scale (e.g. Card Size < 100%) or slide (transitions) only cover
    // part of the canvas; without this the uncovered border keeps stale pixels from
    // the previous frame → a visible "blink"/flicker at slide edges (preview + export).
    ctx.clearRect(0, 0, cw, ch);
    if (bgColor && bgColor !== "transparent") { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, cw, ch); }
    let ci = timeline.findIndex(t => frame < t.end);
    if (ci < 0) ci = timeline.length - 1;
    const cur  = timeline[ci];
    const prev = ci > 0 ? timeline[ci - 1] : null;
    const local = frame - cur.start;

    const inTransition = !!prev && local < xfade;

    if (params.layoutMode === "fan") {
      const fanTL2: FanTL[] = timeline.map(t => ({ url: t.url, type: t.type, dframes: t.dframes, start: t.start, end: t.end }));
      const cards = computeFanLayout(fanStyle, cw, ch, ci, fanTL2, inTransition, inTransition ? local / xfade : 0, cardScale);
      const R = Math.min(cw, ch) * 0.028;

      // Seek cur
      const curMedia2 = mediaHandles[ci];
      if (curMedia2 instanceof HTMLVideoElement) await seekVideo(curMedia2, local / fps);
      // Seek prev for side card
      if (ci > 0) {
        const pm = mediaHandles[ci - 1];
        const ps = inTransition ? (frame - (timeline[ci-1]?.start ?? 0)) / fps : ((timeline[ci-1]?.dframes ?? 1) - 1) / fps;
        if (pm instanceof HTMLVideoElement) await seekVideo(pm, ps);
      }

      // Blurred background
      ctx.save(); ctx.filter = "blur(28px)";
      const bm = curMedia2;
      const bmw = "videoWidth" in bm ? bm.videoWidth : bm.width;
      const bmh = "videoWidth" in bm ? bm.videoHeight : bm.height;
      if (bmw && bmh) {
        const bsc = Math.max(cw / bmw, ch / bmh) * 1.15;
        ctx.drawImage(bm, (cw - bmw * bsc) / 2, (ch - bmh * bsc) / 2, bmw * bsc, bmh * bsc);
      }
      ctx.restore();
      ctx.fillStyle = "rgba(0,0,0,0.50)"; ctx.fillRect(0, 0, cw, ch);

      // Draw cards in zOrder
      for (const card of cards) {
        const media = mediaHandles[card.timelineIdx];
        if (!media) continue;
        const cardFit = timeline[card.timelineIdx]?.fitMode ?? "cover";
        drawFanCanvasCard(ctx, media, card.x, card.y, card.w, card.h, R, card.opacity, card.rotation, card.scale, cardFit, bgColor, blurAmount, imageZoom, cardRadius);
        if (card.isMain && template !== "none") {
          ctx.save();
          if (card.rotation !== 0 || card.scale !== 1) {
            ctx.translate(card.x + card.w / 2, card.y + card.h / 2);
            ctx.rotate(card.rotation * Math.PI / 180);
            ctx.scale(card.scale, card.scale);
            ctx.translate(-card.w / 2, -card.h / 2);
            ctx.beginPath(); ctx.roundRect(0, 0, card.w, card.h, R / card.scale); ctx.clip();
            drawTemplateCanvas(ctx, template, templateCfg, card.w, card.h, local, cur.dframes);
          } else {
            ctx.translate(card.x, card.y);
            ctx.beginPath(); ctx.roundRect(0, 0, card.w, card.h, R); ctx.clip();
            drawTemplateCanvas(ctx, template, templateCfg, card.w, card.h, local, cur.dframes);
          }
          ctx.restore();
        }
      }
    } else if (params.layoutMode === "split") {
      // ── Split Panel canvas rendering ──────────────────────────────────
      const lw2 = Math.round(cw * 0.56);
      const rw2 = cw - lw2;
      const curMedia2 = mediaHandles[ci];
      if (curMedia2 instanceof HTMLVideoElement) await seekVideo(curMedia2, local / fps);
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = "#08080b"; ctx.fillRect(0, 0, cw, ch);
      ctx.save();
      ctx.translate(cw / 2, ch / 2); ctx.scale(cardScale, cardScale); ctx.translate(-cw / 2, -ch / 2);

      // Blurred full canvas (visible on right panel)
      const bm2 = curMedia2;
      const bmw2 = "videoWidth" in bm2 ? bm2.videoWidth : (bm2 as ImageBitmap).width;
      const bmh2 = "videoWidth" in bm2 ? bm2.videoHeight : (bm2 as ImageBitmap).height;
      if (bmw2 && bmh2) {
        ctx.save(); ctx.filter = "blur(28px)"; ctx.globalAlpha = 0.65;
        const bsc2 = Math.max(cw / bmw2, ch / bmh2) * 1.1;
        ctx.drawImage(bm2, (cw - bmw2 * bsc2) / 2, (ch - bmh2 * bsc2) / 2, bmw2 * bsc2, bmh2 * bsc2);
        ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      }
      // Dark overlay on right only
      ctx.fillStyle = "rgba(4,4,8,0.72)"; ctx.fillRect(lw2, 0, rw2, ch);
      // Sharp image on left panel
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, lw2, ch); ctx.clip();
      drawMediaToCanvas(ctx, curMedia2, cw, ch, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      const gr2 = ctx.createLinearGradient(lw2 * 0.82, 0, lw2, 0);
      gr2.addColorStop(0, "rgba(0,0,0,0)"); gr2.addColorStop(1, "rgba(0,0,0,0.42)");
      ctx.fillStyle = gr2; ctx.fillRect(0, 0, lw2, ch);
      ctx.restore();
      // Divider
      ctx.save(); ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(lw2, ch * 0.08); ctx.lineTo(lw2, ch * 0.92); ctx.stroke(); ctx.restore();
      // Slide counter
      const fcSz = Math.max(10, Math.round(ch * 0.014));
      ctx.font = `600 ${fcSz}px Inter, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.32)"; ctx.textAlign = "left";
      ctx.fillText(`${String(ci + 1).padStart(2, "0")} / ${String(timeline.length).padStart(2, "0")}`, lw2 + rw2 * 0.14, ch * 0.12);
      // Accent line
      ctx.fillStyle = "#3D7EFD"; ctx.fillRect(lw2 + rw2 * 0.14, ch * 0.165, 28, 2);
      // Template on right panel
      if (template !== "none") {
        ctx.save(); ctx.translate(lw2, 0); ctx.beginPath(); ctx.rect(0, 0, rw2, ch); ctx.clip();
        drawTemplateCanvas(ctx, template, templateCfg, rw2, ch, local, cur.dframes); ctx.restore();
      }
      ctx.restore();

    } else if (params.layoutMode === "float") {
      // ── Float Glow canvas rendering ───────────────────────────────────
      const s = cardScale;
      const fW = Math.round(cw * 0.72 * s), fH = Math.round(ch * 0.78 * s);
      const fX = (cw - fW) / 2, fY = (ch - fH) / 2;
      const fR = Math.min(cw, ch) * 0.022;
      const curMedia2 = mediaHandles[ci];
      if (curMedia2 instanceof HTMLVideoElement) await seekVideo(curMedia2, local / fps);
      ctx.clearRect(0, 0, cw, ch);
      // Dark radial gradient bg
      const radG = ctx.createRadialGradient(cw / 2, ch * 0.38, 0, cw / 2, ch * 0.38, cw * 0.72);
      radG.addColorStop(0, "#16101e"); radG.addColorStop(0.55, "#09080e"); radG.addColorStop(1, "#040408");
      ctx.fillStyle = radG; ctx.fillRect(0, 0, cw, ch);
      // Ambient glow
      ctx.save(); ctx.filter = "blur(50px)"; ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#3D7EFD"; ctx.beginPath();
      ctx.ellipse(cw / 2, fY + fH * 0.5, fW * 0.38, fH * 0.34, 0, 0, Math.PI * 2); ctx.fill();
      ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      // Card
      ctx.save(); ctx.beginPath(); ctx.roundRect(fX, fY, fW, fH, fR); ctx.clip();
      drawMediaToCanvas(ctx, curMedia2, cw, ch, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius); ctx.restore();
      // Card border
      ctx.save(); ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(fX, fY, fW, fH, fR); ctx.stroke(); ctx.restore();
      // Template
      if (template !== "none") {
        ctx.save(); ctx.translate(fX, fY); ctx.beginPath(); ctx.roundRect(0, 0, fW, fH, fR); ctx.clip();
        drawTemplateCanvas(ctx, template, templateCfg, fW, fH, local, cur.dframes); ctx.restore();
      }
      // Progress dots
      const dotGap = Math.round(cw * 0.006), dotH2 = Math.max(3, Math.round(ch * 0.005));
      const dotW2 = dotH2 * 5, dotSm = dotH2;
      let dxOff = (cw - (timeline.length * (dotSm + dotGap) + (dotW2 - dotSm))) / 2;
      const dotY2 = ch * 0.94;
      for (let i = 0; i < timeline.length; i++) {
        ctx.fillStyle = i === ci ? "#3D7EFD" : "rgba(255,255,255,0.22)";
        const dw3 = i === ci ? dotW2 : dotSm;
        ctx.beginPath(); ctx.roundRect(dxOff, dotY2, dw3, dotH2, dotH2 / 2); ctx.fill();
        dxOff += dw3 + dotGap;
      }

    } else if (params.layoutMode === "tilt") {
      // ── Tilt Stack canvas rendering ───────────────────────────────────
      const s = cardScale;
      const tW = Math.round(cw * 0.68 * s), tH = Math.round(ch * 0.76 * s);
      const tX = (cw - tW) / 2, tY = (ch - tH) / 2;
      const tR = Math.min(cw, ch) * 0.022;
      const curMedia2 = mediaHandles[ci];
      if (curMedia2 instanceof HTMLVideoElement) await seekVideo(curMedia2, local / fps);
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = "#0c0b10"; ctx.fillRect(0, 0, cw, ch);
      const tgG = ctx.createRadialGradient(cw / 2, 0, 0, cw / 2, 0, cw * 0.6);
      tgG.addColorStop(0, "rgba(61,126,253,0.07)"); tgG.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = tgG; ctx.fillRect(0, 0, cw, ch);
      // Back cards (if not in transition)
      if (!inTransition) {
        const drawBackCard = (mediaIdx: number, dx: number, dy: number, deg: number, alpha: number) => {
          const bm3 = mediaHandles[mediaIdx];
          if (!bm3) return;
          ctx.save(); ctx.globalAlpha = alpha;
          const pivX = tX + tW / 2 + dx, pivY = tY + tH * 0.85 + dy;
          ctx.translate(pivX, pivY); ctx.rotate(deg * Math.PI / 180); ctx.translate(-tW / 2, -tH * 0.85);
          ctx.beginPath(); ctx.roundRect(0, 0, tW, tH, tR); ctx.clip();
          drawMediaToCanvas(ctx, bm3, tW, tH, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius); ctx.restore();
        };
        if (ci + 2 < timeline.length) drawBackCard(ci + 2, 24, 18, 9, 0.18);
        if (ci + 1 < timeline.length) drawBackCard(ci + 1, 13, 10, 5, 0.40);
      }
      // Previous exiting
      if (inTransition && prev) {
        const eT2 = easeOutCubic(Math.min(1, local / xfade));
        const pm2 = mediaHandles[ci - 1];
        if (pm2 instanceof HTMLVideoElement) await seekVideo(pm2, (frame - prev.start) / fps);
        if (pm2) {
          ctx.save(); ctx.globalAlpha = 1 - eT2;
          const pivX2 = tX + tW / 2 + (-eT2 * cw * 0.55), pivY2 = tY + tH * 0.85 + (eT2 * 24);
          ctx.translate(pivX2, pivY2); ctx.rotate(-eT2 * 22 * Math.PI / 180); ctx.translate(-tW / 2, -tH * 0.85);
          ctx.beginPath(); ctx.roundRect(0, 0, tW, tH, tR); ctx.clip();
          drawMediaToCanvas(ctx, pm2, tW, tH, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius); ctx.restore();
        }
      }
      // Current card — the caption is drawn INSIDE the same clip+transform, so it
      // tilts and fades in WITH the card (no static-centre caption/border flashing
      // over an offset card — that misalignment was the "blink").
      const eT3 = inTransition ? easeOutCubic(Math.min(1, local / xfade)) : 1;
      ctx.save(); ctx.globalAlpha = inTransition ? 0.55 + 0.45 * eT3 : 1;
      if (inTransition) {
        const pivX3 = tX + tW / 2 + (1 - eT3) * cw * 0.45, pivY3 = tY + tH * 0.85 + (1 - eT3) * -18;
        ctx.translate(pivX3, pivY3); ctx.rotate((1 - eT3) * 18 * Math.PI / 180); ctx.translate(-tW / 2, -tH * 0.85);
      } else {
        ctx.translate(tX, tY);
      }
      ctx.beginPath(); ctx.roundRect(0, 0, tW, tH, tR); ctx.clip();
      drawMediaToCanvas(ctx, curMedia2, tW, tH, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      if (template !== "none") drawTemplateCanvas(ctx, template, templateCfg, tW, tH, local, cur.dframes);
      // Card border (rides the same transform as the card)
      ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(0, 0, tW, tH, tR); ctx.stroke();
      ctx.restore();

    } else if (params.layoutMode === "tinder") {
      // ── Tinder canvas ─────────────────────────────────────────────────
      const ROTS3 = [-3, 2, -4, 3, -1, 4, -2, 3];
      const cR3 = ROTS3[ci % ROTS3.length];
      const pR3 = ci > 0 ? ROTS3[(ci - 1) % ROTS3.length] : 0;
      const eT5 = easeOutCubic(Math.min(1, local / xfade));
      const s = cardScale;
      const tW3 = Math.round(cw * 0.80 * s), tH3 = Math.round(ch * 0.84 * s);
      const tX3 = (cw - tW3) / 2, tY3 = (ch - tH3) / 2 - Math.round(ch * 0.02);
      const tRr = Math.min(cw, ch) * 0.030;
      const curM3 = mediaHandles[ci];
      if (curM3 instanceof HTMLVideoElement) await seekVideo(curM3, local / fps);
      // Blurred bg
      ctx.clearRect(0, 0, cw, ch);
      const bm4 = curM3;
      const bw4 = "videoWidth" in bm4 ? bm4.videoWidth : (bm4 as ImageBitmap).width;
      const bh4 = "videoWidth" in bm4 ? bm4.videoHeight : (bm4 as ImageBitmap).height;
      if (bw4 && bh4) {
        ctx.save(); ctx.filter = "blur(28px)"; ctx.globalAlpha = 0.72;
        const bs4 = Math.max(cw / bw4, ch / bh4) * 1.15;
        ctx.drawImage(bm4, (cw - bw4 * bs4) / 2, (ch - bh4 * bs4) / 2, bw4 * bs4, bh4 * bs4);
        ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      }
      ctx.fillStyle = "rgba(0,0,0,0.42)"; ctx.fillRect(0, 0, cw, ch);
      // Entering card
      ctx.save();
      if (inTransition) {
        const sc5 = 0.88 + 0.12 * eT5;
        ctx.translate(tX3 + tW3 / 2, tY3 + tH3 / 2);
        ctx.scale(sc5, sc5); ctx.rotate(cR3 * (1 - eT5) * Math.PI / 180);
        ctx.translate(-tW3 / 2, -tH3 / 2);
        ctx.globalAlpha = eT5;
      } else {
        ctx.translate(tX3 + tW3 / 2, tY3 + tH3 / 2);
        ctx.rotate(cR3 * Math.PI / 180);
        ctx.translate(-tW3 / 2, -tH3 / 2);
      }
      ctx.beginPath(); ctx.roundRect(0, 0, tW3, tH3, tRr); ctx.clip();
      drawMediaToCanvas(ctx, curM3, tW3, tH3, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      if (template !== "none") drawTemplateCanvas(ctx, template, templateCfg, tW3, tH3, local, cur.dframes);
      ctx.restore();
      // Previous swiping off
      if (inTransition && prev) {
        const pm4 = mediaHandles[ci - 1];
        if (pm4 instanceof HTMLVideoElement) await seekVideo(pm4, (frame - prev.start) / fps);
        if (pm4) {
          ctx.save();
          const tx6 = eT5 * cw * 1.25, ty6 = eT5 * -28, rot6 = pR3 + eT5 * 26;
          ctx.translate(tX3 + tW3 / 2 + tx6, tY3 + tH3 + ty6);
          ctx.rotate(rot6 * Math.PI / 180); ctx.translate(-tW3 / 2, -tH3);
          ctx.beginPath(); ctx.roundRect(0, 0, tW3, tH3, tRr); ctx.clip();
          drawMediaToCanvas(ctx, pm4, tW3, tH3, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius); ctx.restore();
        }
      }
      // Progress dots
      const dtGap = Math.round(cw * 0.008), dtH5 = Math.max(3, Math.round(ch * 0.005)), dtW5 = dtH5 * 4;
      let dxOff2 = (cw - (timeline.length * (dtH5 + dtGap) + (dtW5 - dtH5))) / 2;
      const dtY5 = ch * 0.94;
      for (let i = 0; i < timeline.length; i++) {
        ctx.fillStyle = i === ci ? "#3D7EFD" : "rgba(255,255,255,0.28)";
        const dw5 = i === ci ? dtW5 : dtH5;
        ctx.beginPath(); ctx.roundRect(dxOff2, dtY5, dw5, dtH5, dtH5 / 2); ctx.fill();
        dxOff2 += dw5 + dtGap;
      }

    } else if (params.layoutMode === "filmstrip") {
      // ── Filmstrip canvas ──────────────────────────────────────────────
      const ffW = Math.round(cw * 0.40 * cardScale), ffH = Math.round(ch * 0.60 * cardScale);
      const spac = Math.round(ffW * 1.16);
      const eT6 = easeOutCubic(Math.min(1, local / xfade));
      const strOff = inTransition ? -eT6 * spac : 0;
      const fcX = (cw - ffW) / 2, fcY = (ch - ffH) / 2;
      const fbH = ffH + Math.round(ch * 0.07), fbY = fcY - Math.round(ch * 0.035);
      const curM4 = mediaHandles[ci];
      if (curM4 instanceof HTMLVideoElement) await seekVideo(curM4, local / fps);
      ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = "#0a0a08"; ctx.fillRect(0, 0, cw, ch);
      // Film bar
      ctx.fillStyle = "#111"; ctx.fillRect(0, fbY, cw, fbH);
      // Sprocket holes
      for (let i = 0; i < 10; i++) {
        const hx = (cw / 10) * i + cw / 20 - Math.round(cw * 0.01);
        ctx.fillStyle = "#050504";
        ctx.beginPath(); ctx.roundRect(hx, fbY + 4, Math.round(cw * 0.02), Math.round(ch * 0.012), 2); ctx.fill();
        ctx.beginPath(); ctx.roundRect(hx, fbY + fbH - 4 - Math.round(ch * 0.012), Math.round(cw * 0.02), Math.round(ch * 0.012), 2); ctx.fill();
      }
      // Frames
      const fItems2 = [
        ...(prev ? [{ m: mediaHandles[ci - 1], xOff: -spac, isCur: false }] : []),
        { m: curM4, xOff: 0, isCur: true },
        ...(ci + 1 < timeline.length ? [{ m: mediaHandles[ci + 1], xOff: spac, isCur: false }] : []),
        ...(ci + 2 < timeline.length ? [{ m: mediaHandles[ci + 2], xOff: spac * 2, isCur: false }] : []),
      ];
      for (const fi of fItems2) {
        if (!fi.m) continue;
        const fx2 = fcX + fi.xOff + strOff;
        if (fx2 + ffW < -ffW || fx2 > cw + ffW) continue;
        ctx.save();
        ctx.globalAlpha = fi.isCur ? 1 : (Math.abs(fi.xOff) <= spac ? 0.55 : 0.28);
        ctx.translate(fx2, fcY); ctx.beginPath(); ctx.rect(0, 0, ffW, ffH); ctx.clip();
        drawMediaToCanvas(ctx, fi.m, ffW, ffH, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
        if (fi.isCur && template !== "none") drawTemplateCanvas(ctx, template, templateCfg, ffW, ffH, local, cur.dframes);
        ctx.restore();
        if (fi.isCur) { ctx.save(); ctx.strokeStyle = "rgba(61,126,253,0.6)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.rect(fx2, fcY, ffW, ffH); ctx.stroke(); ctx.restore(); }
      }
      // Frame number
      const fnSz = Math.max(9, Math.round(ch * 0.014));
      ctx.font = `600 ${fnSz}px monospace`; ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.textAlign = "center";
      ctx.fillText(`FRAME ${String(ci + 1).padStart(3, "0")} / ${String(timeline.length).padStart(3, "0")}`, cw / 2, fbY + fbH + fnSz + 4);

    } else if (params.layoutMode === "polaroid") {
      // ── Polaroid canvas ───────────────────────────────────────────────
      const ROTS4 = [-4, 3, -2, 5, -3, 2, -5, 4];
      const pRot = ROTS4[ci % ROTS4.length];
      const curM5 = mediaHandles[ci];
      if (curM5 instanceof HTMLVideoElement) await seekVideo(curM5, local / fps);
      ctx.clearRect(0, 0, cw, ch);
      const lg4 = ctx.createLinearGradient(0, 0, cw, ch);
      lg4.addColorStop(0, "#ece8e3"); lg4.addColorStop(1, "#ddd8d2");
      ctx.fillStyle = lg4; ctx.fillRect(0, 0, cw, ch);
      const pW4 = Math.round(cw * 0.66 * cardScale), brdr = Math.round(pW4 * 0.05), bot4 = Math.round(pW4 * 0.17);
      const imgH4 = Math.round(pW4 * 0.76);
      const pH4 = imgH4 + brdr * 2 + bot4;
      const pX4 = (cw - pW4) / 2, pY4 = (ch - pH4) / 2 - Math.round(ch * 0.02);
      // Shadow
      ctx.save(); ctx.filter = "blur(18px)"; ctx.globalAlpha = 0.18;
      ctx.fillStyle = "#000";
      ctx.translate(pX4 + pW4 * 0.5, pY4 + pH4 * 0.5 + 18);
      ctx.rotate(pRot * 0.7 * Math.PI / 180);
      ctx.fillRect(-pW4 * 0.44, -pH4 * 0.44, pW4 * 0.88, pH4 * 0.88);
      ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      // White frame + rotate
      ctx.save();
      ctx.translate(pX4 + pW4 / 2, pY4 + pH4 / 2);
      const pRot2 = inTransition ? pRot * easeOutCubic(Math.min(1, local / xfade)) : pRot;
      ctx.rotate(pRot2 * Math.PI / 180);
      ctx.translate(-pW4 / 2, -pH4 / 2);
      // White border
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.roundRect(0, 0, pW4, pH4, 3); ctx.fill();
      ctx.save(); ctx.translate(brdr, brdr); ctx.beginPath(); ctx.rect(0, 0, pW4 - brdr * 2, imgH4); ctx.clip();
      drawMediaToCanvas(ctx, curM5, pW4 - brdr * 2, imgH4, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      if (template !== "none") drawTemplateCanvas(ctx, template, templateCfg, pW4 - brdr * 2, imgH4, local, cur.dframes);
      ctx.restore();
      // Bottom text
      const txtSz = Math.max(10, Math.round(pW4 * 0.040));
      ctx.font = `400 ${txtSz}px 'Comic Sans MS', cursive, sans-serif`;
      ctx.fillStyle = "#2c2c2c"; ctx.textAlign = "center";
      const botTxt = templateCfg.line1 || `${String(ci + 1).padStart(2, "0")} / ${String(timeline.length).padStart(2, "0")}`;
      ctx.fillText(botTxt, pW4 / 2, brdr + imgH4 + bot4 * 0.62);
      ctx.restore();

    } else if (params.layoutMode === "story") {
      // ── Story canvas ──────────────────────────────────────────────────
      const scW2 = Math.round(cw * 0.90 * cardScale), scH2 = Math.round(ch * 0.76 * cardScale);
      const scX2 = (cw - scW2) / 2, scY2 = (ch - scH2) / 2 + Math.round(ch * 0.035);
      const scRr = Math.min(cw, ch) * 0.032;
      const curMs = mediaHandles[ci];
      if (curMs instanceof HTMLVideoElement) await seekVideo(curMs, local / fps);
      const bms = curMs;
      const bmws = "videoWidth" in bms ? bms.videoWidth : (bms as ImageBitmap).width;
      const bmhs = "videoWidth" in bms ? bms.videoHeight : (bms as ImageBitmap).height;
      ctx.clearRect(0, 0, cw, ch);
      if (bmws && bmhs) {
        ctx.save(); ctx.filter = "blur(32px)"; ctx.globalAlpha = 0.80;
        const bss = Math.max(cw / bmws, ch / bmhs) * 1.12;
        ctx.drawImage(bms, (cw - bmws * bss) / 2, (ch - bmhs * bss) / 2, bmws * bss, bmhs * bss);
        ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      }
      ctx.fillStyle = "rgba(0,0,0,0.40)"; ctx.fillRect(0, 0, cw, ch);
      // Progress bars
      const pbH = Math.max(2, Math.round(ch * 0.003)), pbGap = Math.round(cw * 0.005);
      const pbTot = cw * 0.92, pbW = (pbTot - pbGap * (timeline.length - 1)) / timeline.length;
      const pbX0 = (cw - pbTot) / 2, pbY0 = ch * 0.045;
      for (let i = 0; i < timeline.length; i++) {
        const prog = i === ci && !inTransition ? local / cur.dframes : (i < ci ? 1 : 0);
        ctx.fillStyle = "rgba(255,255,255,0.28)"; ctx.beginPath(); ctx.roundRect(pbX0 + i * (pbW + pbGap), pbY0, pbW, pbH, 2); ctx.fill();
        if (prog > 0) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.roundRect(pbX0 + i * (pbW + pbGap), pbY0, pbW * prog, pbH, 2); ctx.fill(); }
      }
      // Handle area (just text)
      const hSz = Math.max(10, Math.round(ch * 0.016));
      ctx.font = `700 ${hSz}px Inter, sans-serif`; ctx.fillStyle = "#fff"; ctx.textAlign = "left";
      ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 4;
      ctx.fillText(templateCfg.line1 || "@handle", cw * 0.10, ch * 0.092);
      ctx.shadowBlur = 0;
      // Card
      const eTs = inTransition ? easeOutCubic(Math.min(1, local / xfade)) : 1;
      ctx.save(); ctx.globalAlpha = inTransition ? eTs : 1;
      ctx.translate(scX2 + scW2 / 2, scY2 + scH2 / 2); ctx.scale(inTransition ? 0.94 + 0.06 * eTs : 1, inTransition ? 0.94 + 0.06 * eTs : 1); ctx.translate(-scW2 / 2, -scH2 / 2);
      ctx.beginPath(); ctx.roundRect(0, 0, scW2, scH2, scRr); ctx.clip();
      drawMediaToCanvas(ctx, curMs, scW2, scH2, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      if (template !== "none") drawTemplateCanvas(ctx, template, templateCfg, scW2, scH2, local, cur.dframes);
      ctx.restore();

    } else if (params.layoutMode === "magazine") {
      // ── Magazine canvas ───────────────────────────────────────────────
      const curMm = mediaHandles[ci];
      if (curMm instanceof HTMLVideoElement) await seekVideo(curMm, local / fps);
      const eTm = inTransition ? easeOutCubic(Math.min(1, local / xfade)) : 1;
      ctx.clearRect(0, 0, cw, ch);
      ctx.save();
      ctx.translate(cw / 2, ch / 2); ctx.scale(cardScale, cardScale); ctx.translate(-cw / 2, -ch / 2);
      ctx.globalAlpha = inTransition ? 0.38 + 0.62 * eTm : 1;
      drawMediaToCanvas(ctx, curMm, cw, ch, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius); ctx.globalAlpha = 1;
      // Top bar
      const tbH = Math.round(ch * 0.082);
      ctx.fillStyle = "rgba(0,0,0,0.76)"; ctx.fillRect(0, 0, cw, tbH);
      const mTSz = Math.max(10, Math.round(cw * 0.022));
      ctx.font = `900 ${mTSz}px Georgia, serif`; ctx.fillStyle = "#fff"; ctx.textAlign = "left";
      ctx.fillText(templateCfg.line1 || "MAGAZINE", cw * 0.045, tbH * 0.66);
      const iSz = Math.max(8, Math.round(cw * 0.013));
      ctx.font = `600 ${iSz}px Inter, sans-serif`; ctx.fillStyle = "rgba(255,255,255,0.42)"; ctx.textAlign = "right";
      ctx.fillText(`Issue ${String(ci + 1).padStart(2, "0")}`, cw * 0.955, tbH * 0.66);
      // Bottom gradient + text
      const bgrd = ctx.createLinearGradient(0, ch * 0.60, 0, ch);
      bgrd.addColorStop(0, "rgba(0,0,0,0)"); bgrd.addColorStop(1, "rgba(0,0,0,0.90)");
      ctx.fillStyle = bgrd; ctx.fillRect(0, 0, cw, ch);
      // Accent line
      ctx.fillStyle = templateCfg.accentColor; ctx.fillRect(cw * 0.055, ch * 0.78, 28, 2.5);
      // Headline
      const hlSz = Math.max(14, Math.round(cw * 0.034));
      ctx.font = `900 ${hlSz}px Georgia, serif`; ctx.fillStyle = "#fff"; ctx.textAlign = "left";
      const hlText = templateCfg.line2 || "";
      const maxW = cw * 0.85;
      const words = hlText ? hlText.split(" ") : []; let line2 = "", lY = ch * 0.836;
      for (const wd of words) {
        const test = line2 ? line2 + " " + wd : wd;
        if (ctx.measureText(test).width > maxW && line2) { ctx.fillText(line2, cw * 0.055, lY); line2 = wd; lY += hlSz * 1.25; }
        else line2 = test;
      }
      if (line2) ctx.fillText(line2, cw * 0.055, lY);
      // Read more
      const rmSz = Math.max(8, Math.round(cw * 0.013));
      ctx.font = `700 ${rmSz}px Inter, sans-serif`; ctx.fillStyle = templateCfg.accentColor;
      ctx.fillText("Read More →", cw * 0.055, ch * 0.945);
      ctx.restore();

    } else if (params.layoutMode === "vintage") {
      // ── Vintage canvas ────────────────────────────────────────────────
      const vW = Math.round(cw * 0.78 * cardScale), vH = Math.round(ch * 0.76 * cardScale);
      const vX = (cw - vW) / 2, vY = (ch - vH) / 2;
      const curMv = mediaHandles[ci];
      if (curMv instanceof HTMLVideoElement) await seekVideo(curMv, local / fps);
      ctx.clearRect(0, 0, cw, ch);
      const vBg = ctx.createLinearGradient(0, 0, cw, ch);
      vBg.addColorStop(0, "#2a1f15"); vBg.addColorStop(0.55, "#1a1208"); vBg.addColorStop(1, "#241a0e");
      ctx.fillStyle = vBg; ctx.fillRect(0, 0, cw, ch);
      // Warm blurred bg overlay
      const bMv = curMv;
      const bWv = "videoWidth" in bMv ? bMv.videoWidth : (bMv as ImageBitmap).width;
      const bHv = "videoWidth" in bMv ? bMv.videoHeight : (bMv as ImageBitmap).height;
      if (bWv && bHv) {
        ctx.save(); ctx.filter = "blur(24px)"; ctx.globalAlpha = 0.28;
        const bsv = Math.max(cw / bWv, ch / bHv) * 1.1;
        ctx.drawImage(bMv, (cw - bWv * bsv) / 2, (ch - bHv * bsv) / 2, bWv * bsv, bHv * bsv);
        ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      }
      // Gold border
      const eTv = inTransition ? easeOutCubic(Math.min(1, local / xfade)) : 1;
      ctx.save(); ctx.globalAlpha = eTv; ctx.strokeStyle = "rgba(201,165,90,0.48)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(vX - 7, vY - 7, vW + 14, vH + 14, 2); ctx.stroke();
      // Card
      ctx.beginPath(); ctx.roundRect(vX, vY, vW, vH, 2); ctx.clip();
      drawMediaToCanvas(ctx, curMv, vW, vH, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      // Sepia warm overlay
      ctx.fillStyle = "rgba(110,70,15,0.22)"; ctx.fillRect(0, 0, vW, vH);
      if (template !== "none") drawTemplateCanvas(ctx, template, templateCfg, vW, vH, local, cur.dframes);
      ctx.restore();
      // Caption
      const capSz = Math.max(9, Math.round(cw * 0.013));
      ctx.font = `400 ${capSz}px Georgia, serif`; ctx.fillStyle = "rgba(201,165,90,0.70)"; ctx.textAlign = "center";
      ctx.fillText(`${String(ci + 1).padStart(2, "0")} · ${String(timeline.length).padStart(2, "0")}`, cw / 2, ch * 0.945);

    } else if (params.layoutMode === "neon-frame") {
      // ── Neon Frame canvas ─────────────────────────────────────────────
      const nW = Math.round(cw * 0.78 * cardScale), nH = Math.round(ch * 0.82 * cardScale);
      const nX = (cw - nW) / 2, nY = (ch - nH) / 2;
      const nR = Math.min(cw, ch) * 0.026;
      const curMn = mediaHandles[ci];
      if (curMn instanceof HTMLVideoElement) await seekVideo(curMn, local / fps);
      const pulse2 = 0.70 + Math.sin(frame * 0.12) * 0.30;
      const nc2 = templateCfg.accentColor;
      const eTn = inTransition ? easeOutCubic(Math.min(1, local / xfade)) : 1;
      ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = "#030308"; ctx.fillRect(0, 0, cw, ch);
      // Dark blurred bg
      const bMn = curMn;
      const bWn = "videoWidth" in bMn ? bMn.videoWidth : (bMn as ImageBitmap).width;
      const bHn = "videoWidth" in bMn ? bMn.videoHeight : (bMn as ImageBitmap).height;
      if (bWn && bHn) {
        ctx.save(); ctx.filter = "blur(32px)"; ctx.globalAlpha = 0.20;
        const bsn = Math.max(cw / bWn, ch / bHn) * 1.1;
        ctx.drawImage(bMn, (cw - bWn * bsn) / 2, (ch - bHn * bsn) / 2, bWn * bsn, bHn * bsn);
        ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      }
      // Neon glow rings
      for (const [pad, blur, op] of [[2, 2, 0.88], [7, 6, 0.42], [16, 14, 0.18]] as [number,number,number][]) {
        ctx.save(); ctx.globalAlpha = eTn * pulse2 * op;
        ctx.strokeStyle = nc2; ctx.lineWidth = pad === 2 ? 2 : 1;
        ctx.shadowColor = nc2; ctx.shadowBlur = (blur + 1) * pulse2 * 4;
        ctx.beginPath(); ctx.roundRect(nX - pad, nY - pad, nW + pad * 2, nH + pad * 2, nR + pad); ctx.stroke();
        ctx.restore();
      }
      // Card
      ctx.save(); ctx.globalAlpha = eTn;
      ctx.beginPath(); ctx.roundRect(nX, nY, nW, nH, nR); ctx.clip();
      drawMediaToCanvas(ctx, curMn, nW, nH, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      if (template !== "none") drawTemplateCanvas(ctx, template, templateCfg, nW, nH, local, cur.dframes);
      ctx.restore();
      // Corner sparks
      ctx.save(); ctx.globalAlpha = eTn * pulse2; ctx.fillStyle = nc2; ctx.shadowColor = nc2; ctx.shadowBlur = 6;
      for (const [x, y] of [[nX,nY],[nX+nW,nY],[nX,nY+nH],[nX+nW,nY+nH]] as [number,number][]) {
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

    } else if (params.layoutMode === "gallery") {
      // ── Gallery canvas ────────────────────────────────────────────────
      const gW = Math.round(cw * 0.68 * cardScale), gH = Math.round(ch * 0.66 * cardScale);
      const gX = (cw - gW) / 2, gY = (ch - gH) / 2 - Math.round(ch * 0.04);
      const gFW = Math.round(gW * 0.054), gMW = Math.round(gW * 0.026);
      const curMg = mediaHandles[ci];
      if (curMg instanceof HTMLVideoElement) await seekVideo(curMg, local / fps);
      const eTg = inTransition ? easeOutCubic(Math.min(1, local / xfade)) : 1;
      // Wall background
      ctx.clearRect(0, 0, cw, ch);
      const wallG = ctx.createLinearGradient(0, 0, cw, ch);
      wallG.addColorStop(0, "#e8e2da"); wallG.addColorStop(0.55, "#d4cec6"); wallG.addColorStop(1, "#cdc7be");
      ctx.fillStyle = wallG; ctx.fillRect(0, 0, cw, ch);
      // Frame shadow
      ctx.save(); ctx.filter = "blur(14px)"; ctx.globalAlpha = 0.22 * eTg;
      ctx.fillStyle = "#000"; ctx.fillRect(gX + gFW * 0.6, gY + gFW * 0.6 + 8, gW, gH); ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      // Dark wood frame
      ctx.save(); ctx.globalAlpha = eTg;
      const fGrd = ctx.createLinearGradient(gX, gY, gX + gW, gY + gH);
      fGrd.addColorStop(0, "#2c1e14"); fGrd.addColorStop(0.42, "#1a110a"); fGrd.addColorStop(0.62, "#241711"); fGrd.addColorStop(1, "#2c1e14");
      ctx.fillStyle = fGrd; ctx.beginPath(); ctx.roundRect(gX, gY, gW, gH, 2); ctx.fill();
      // Matte
      ctx.fillStyle = "#f0ece5"; ctx.fillRect(gX + gFW, gY + gFW, gW - gFW * 2, gH - gFW * 2);
      // Photo inside matte
      const pInX = gX + gFW + gMW, pInY = gY + gFW + gMW;
      const pInW = gW - (gFW + gMW) * 2, pInH = gH - (gFW + gMW) * 2;
      ctx.save(); ctx.translate(pInX, pInY); ctx.beginPath(); ctx.rect(0, 0, pInW, pInH); ctx.clip();
      drawMediaToCanvas(ctx, curMg, pInW, pInH, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      if (template !== "none") drawTemplateCanvas(ctx, template, templateCfg, pInW, pInH, local, cur.dframes);
      ctx.restore();
      // Frame highlight
      ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.beginPath(); ctx.roundRect(gX, gY, gW, gH, 2);
      ctx.rect(gX + gFW, gY + gFW, gW - gFW * 2, gH - gFW * 2); ctx.fill("evenodd");
      ctx.restore();
      // Placard
      const plSz = Math.max(8, Math.round(cw * 0.013));
      const plX = gX + gW * 0.27, plY = gY + gH + Math.round(ch * 0.028);
      ctx.fillStyle = "#f8f4ee"; ctx.beginPath(); ctx.roundRect(plX, plY, gW * 0.46, plSz * 2.8, 1); ctx.fill();
      ctx.strokeStyle = "#c0b8b0"; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.roundRect(plX, plY, gW * 0.46, plSz * 2.8, 1); ctx.stroke();
      ctx.font = `italic 400 ${plSz}px Georgia, serif`; ctx.fillStyle = "#2c2419"; ctx.textAlign = "center";
      ctx.fillText(templateCfg.line1 || `Slide ${ci + 1}`, plX + gW * 0.23, plY + plSz * 1.9);

    } else if (params.layoutMode === "spotlight") {
      // ── Spotlight canvas ──────────────────────────────────────────────
      const sW3 = Math.round(cw * 0.76 * cardScale), sH3 = Math.round(ch * 0.82 * cardScale);
      const sX3 = (cw - sW3) / 2, sY3 = (ch - sH3) / 2;
      const sRr3 = Math.min(cw, ch) * 0.026;
      const curM6 = mediaHandles[ci];
      if (curM6 instanceof HTMLVideoElement) await seekVideo(curM6, local / fps);
      ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch);
      // Very dark blurred bg
      const bm6 = curM6;
      const bw6 = "videoWidth" in bm6 ? bm6.videoWidth : (bm6 as ImageBitmap).width;
      const bh6 = "videoWidth" in bm6 ? bm6.videoHeight : (bm6 as ImageBitmap).height;
      if (bw6 && bh6) {
        ctx.save(); ctx.filter = "blur(38px)"; ctx.globalAlpha = 0.30;
        const bs6 = Math.max(cw / bw6, ch / bh6) * 1.15;
        ctx.drawImage(bm6, (cw - bw6 * bs6) / 2, (ch - bh6 * bs6) / 2, bw6 * bs6, bh6 * bs6);
        ctx.filter = "none"; ctx.globalAlpha = 1; ctx.restore();
      }
      // Vignette
      const vigG = ctx.createRadialGradient(cw / 2, ch * 0.47, 0, cw / 2, ch * 0.47, cw * 0.62);
      vigG.addColorStop(0, "rgba(0,0,0,0)"); vigG.addColorStop(0.5, "rgba(0,0,0,0)");
      vigG.addColorStop(0.75, "rgba(0,0,0,0.78)"); vigG.addColorStop(1, "rgba(0,0,0,0.97)");
      ctx.fillStyle = vigG; ctx.fillRect(0, 0, cw, ch);
      // Spotlight beam
      ctx.save(); ctx.globalAlpha = 0.055;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(cw * 0.38, 0); ctx.lineTo(cw * 0.62, 0);
      ctx.lineTo(cw * 0.5 + sW3 * 0.3, sY3 + sH3 * 0.3);
      ctx.lineTo(cw * 0.5 - sW3 * 0.3, sY3 + sH3 * 0.3);
      ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; ctx.restore();
      // Card
      const eT7 = inTransition ? easeOutCubic(Math.min(1, local / xfade)) : 1;
      ctx.save(); ctx.globalAlpha = inTransition ? eT7 : 1;
      ctx.translate(sX3 + sW3 / 2, sY3 + sH3 / 2);
      const sc7 = inTransition ? 0.93 + 0.07 * eT7 : 1;
      ctx.scale(sc7, sc7); ctx.translate(-sW3 / 2, -sH3 / 2);
      ctx.beginPath(); ctx.roundRect(0, 0, sW3, sH3, sRr3); ctx.clip();
      drawMediaToCanvas(ctx, curM6, sW3, sH3, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
      if (template !== "none") drawTemplateCanvas(ctx, template, templateCfg, sW3, sH3, local, cur.dframes);
      ctx.restore();

    } else {
      // ── Fullscreen canvas rendering (existing) ────────────────────────
      if (inTransition && prev) {
        const tProg = local / xfade;
        const prevLocal = frame - prev.start;

        ctxA.clearRect(0, 0, cw, ch);
        const prevMedia = mediaHandles[ci - 1];
        if (prevMedia instanceof HTMLVideoElement) {
          await seekVideo(prevMedia, prevLocal / fps);
        }
        drawMediaToCanvas(ctxA, prevMedia, cw, ch, prev.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
        drawTemplateCanvas(ctxA, template, templateCfg, cw, ch, prevLocal, prev.dframes);

        ctxB.clearRect(0, 0, cw, ch);
        const curMedia = mediaHandles[ci];
        if (curMedia instanceof HTMLVideoElement) {
          await seekVideo(curMedia, local / fps);
        }
        drawMediaToCanvas(ctxB, curMedia, cw, ch, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
        drawTemplateCanvas(ctxB, template, templateCfg, cw, ch, local, cur.dframes);

        ctx.save();
        ctx.translate(cw / 2, ch / 2); ctx.scale(cardScale, cardScale); ctx.translate(-cw / 2, -ch / 2);
        // Clip to the card box (rounded by Card Radius): transitions slide full-size
        // images past the frame edges, which — combined with Card Size < 100% —
        // would spill into the border. Clipping keeps every pixel inside the card.
        ctx.beginPath();
        if (cardRadius > 0) ctx.roundRect(0, 0, cw, ch, cardRadius * Math.min(cw, ch)); else ctx.rect(0, 0, cw, ch);
        ctx.clip();
        applyCanvasTransition(ctx, cw, ch, tempA, tempB, tProg, transition);
        ctx.restore();
      } else {
        // (full frame already cleared+filled at the top — don't wipe the bg border)
        const media = mediaHandles[ci];
        if (media instanceof HTMLVideoElement) {
          await seekVideo(media, local / fps);
        }
        ctx.save();
        ctx.translate(cw / 2, ch / 2); ctx.scale(cardScale, cardScale); ctx.translate(-cw / 2, -ch / 2);
        // Clip "cover" overflow to the card box (rounded by Card Radius).
        ctx.beginPath();
        if (cardRadius > 0) ctx.roundRect(0, 0, cw, ch, cardRadius * Math.min(cw, ch)); else ctx.rect(0, 0, cw, ch);
        ctx.clip();
        drawMediaToCanvas(ctx, media, cw, ch, cur.fitMode, bgColor, blurAmount, imageZoom, imageRadius);
        drawTemplateCanvas(ctx, template, templateCfg, cw, ch, local, cur.dframes);
        ctx.restore();
      }
    }

    drawWmCanvas(ctx, wm, wmImg, cw, ch);
}

/** Build the final audio mix (bg tracks looped-to-fill OR single src OR silence, 1s
 *  fades, + the transition SFX stamped at every slide boundary) — the SHARED audio
 *  builder used by BOTH the export encode and the single-engine preview. */
async function prepareCarouselAudioBuffer(o: {
  audioSrc: string | null;
  audioTracks?: { src: string }[];
  audioVol: number;
  audioFadeIn: boolean;
  audioFadeOut: boolean;
  sfxSrc: string | null;
  sfxVol: number;
  durationSecs: number;
  transitionStartFrames: number[];
  fps: number;
}): Promise<AudioBuffer> {
  const { audioSrc, audioTracks, audioVol, audioFadeIn, audioFadeOut, sfxSrc, sfxVol, durationSecs, transitionStartFrames, fps } = o;
    const audioCtx = new AudioContext();
    // ALWAYS close the context — a leak on a failed decodeAudioData exhausts the ~6
    // hardware-context cap and breaks every tool until app restart (mirrors image-to-video).
    try {
    const fadeSamples = Math.round(audioCtx.sampleRate);

    let sourceBuffer: AudioBuffer;
    if (audioTracks && audioTracks.length > 0) {
      const decoded = await Promise.all(
        audioTracks.map(t => fetch(t.src).then(r => r.arrayBuffer()).then(ab => audioCtx.decodeAudioData(ab)))
      );
      const sr = decoded[0].sampleRate;
      const nCh = decoded[0].numberOfChannels;
      const concatLen = decoded.reduce((a, d) => a + d.length, 0);
      const targetLen = Math.ceil(durationSecs * sr);
      const out = audioCtx.createBuffer(nCh, targetLen, sr);
      for (let ch = 0; ch < nCh; ch++) {
        const concat = new Float32Array(concatLen);
        let off = 0;
        for (const d of decoded) {
          const data = d.numberOfChannels > ch ? d.getChannelData(ch) : new Float32Array(d.length);
          concat.set(data, off); off += d.length;
        }
        const dst = out.getChannelData(ch);
        for (let i = 0; i < targetLen; i++) {
          let v = audioVol;
          if (audioFadeIn  && i < fadeSamples) v *= i / fadeSamples;
          if (audioFadeOut && i > targetLen - fadeSamples) v *= (targetLen - i) / fadeSamples;
          dst[i] = concat[i % concatLen] * Math.max(0, v);
        }
      }
      sourceBuffer = out;
    } else if (audioSrc) {
      const ab = await fetch(audioSrc).then(r => r.arrayBuffer());
      const src = await audioCtx.decodeAudioData(ab);
      const sr = src.sampleRate;
      const targetLen = Math.ceil(durationSecs * sr);
      const fadeSamp  = Math.round(sr);
      const out = audioCtx.createBuffer(src.numberOfChannels, targetLen, sr);
      for (let ch = 0; ch < src.numberOfChannels; ch++) {
        const srcD = src.getChannelData(ch);
        const dst  = out.getChannelData(ch);
        for (let i = 0; i < targetLen; i++) {
          let v = audioVol;
          if (audioFadeIn  && i < fadeSamp) v *= i / fadeSamp;
          if (audioFadeOut && i > targetLen - fadeSamp) v *= (targetLen - i) / fadeSamp;
          dst[i] = srcD[i % src.length] * Math.max(0, v);
        }
      }
      sourceBuffer = out;
    } else {
      // No background audio — create a silent buffer so SFX can still be mixed in
      const sr = audioCtx.sampleRate;
      const targetLen = Math.ceil(durationSecs * sr);
      sourceBuffer = audioCtx.createBuffer(2, targetLen, sr);
    }

    // Mix SFX at every transition point
    if (sfxSrc && sfxVol > 0) {
      const sfxAb = await fetch(sfxSrc).then(r => r.arrayBuffer());
      const sfxBuf = await audioCtx.decodeAudioData(sfxAb);
      const sr = sourceBuffer.sampleRate;
      for (const tFrame of transitionStartFrames) {
        const offsetSample = Math.round((tFrame / fps) * sr);
        for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) {
          const dst = sourceBuffer.getChannelData(ch);
          const src = sfxBuf.numberOfChannels > ch ? sfxBuf.getChannelData(ch) : sfxBuf.getChannelData(0);
          for (let i = 0; i < sfxBuf.length && offsetSample + i < dst.length; i++) {
            dst[offsetSample + i] = Math.max(-1, Math.min(1, dst[offsetSample + i] + src[i] * sfxVol));
          }
        }
      }
    }
    return sourceBuffer;
    } finally {
      try { await audioCtx.close(); } catch { /* already closed */ }
    }
}


async function renderCarousel(params: RenderParams): Promise<Blob> {
  // Per-frame drawing params (transition/template/layout/…) ride `params` into the
  // shared drawCarouselFrame; only what the encode loop itself needs is destructured.
  const {
    items, cw, ch, fps,
    audioSrc, audioTracks, audioVol, audioFadeIn, audioFadeOut,
    sfxSrc, sfxVol, wm,
    brightness, saturation, contrast, hue, onProgress,
  } = params;

  // Load all media
  const mediaHandles = await loadCarouselMedia(items);

  let wmImg: ImageBitmap | null = null;
  if (wm.enabled && wm.type === "image" && wm.imageUrl) {
    wmImg = await fetch(wm.imageUrl).then(r => r.blob()).then(b => createImageBitmap(b));
  }
  if (wm.enabled && wm.type === "text" && wm.font) {
    try { await document.fonts.load(`${wm.fontWeight} ${wm.fontSize}px "${wm.font}"`); } catch (e) { logDebug("carousel-to-video", "watermark font preload failed — using fallback", e); }
  }

  // Release the decoded media (ImageBitmaps + <video> elements) + watermark bitmap on
  // EVERY exit — success OR throw. These are heavy (full-res <video> elements hold
  // decoder resources), so without this each render accumulated host/GPU memory until
  // GC eventually reclaimed it; the try/finally below always runs it.
  const releaseMedia = () => {
    for (const m of mediaHandles) {
      if (typeof HTMLVideoElement !== "undefined" && m instanceof HTMLVideoElement) {
        try { m.pause(); m.removeAttribute("src"); m.load(); } catch { /* ignore */ }
      } else {
        (m as { close?: () => void }).close?.();
      }
    }
    wmImg?.close();
  };

  // Encoder/output/writer are declared OUT here (not inside the try) so the finally can
  // close the WebCodecs encoder sessions + discard the staged temp file on a mid-render
  // throw (e.g. an undecodable audio track in prepareCarouselAudioBuffer). Otherwise those
  // leaked while releaseMedia only freed the media bitmaps.
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
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext("2d")!;
  const tempA = new OffscreenCanvas(cw, ch);
  const ctxA = tempA.getContext("2d")!;
  const tempB = new OffscreenCanvas(cw, ch);
  const ctxB = tempB.getContext("2d")!;
  const colorCanvas = new OffscreenCanvas(cw, ch);
  const colorCtx = colorCanvas.getContext("2d")!;
  const colorFilterStr = [
    brightness !== 100 ? `brightness(${brightness}%)` : "",
    saturation !== 100 ? `saturate(${saturation}%)` : "",
    contrast   !== 100 ? `contrast(${contrast}%)` : "",
    hue        !== 0   ? `hue-rotate(${hue}deg)` : "",
  ].filter(Boolean).join(" ");

  const {
    Output, CanvasSource, AudioBufferSource, Mp4OutputFormat,
    QUALITY_HIGH, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
  } = await import("mediabunny");
  const { createMp4Writer } = await import("@/lib/mp4-disk-writer");

  const videoCodec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1", "vp8"], { width: cw, height: ch, bitrate: QUALITY_HIGH });
  if (!videoCodec) throw new Error("Your browser does not support video encoding. Try Chrome or Edge.");

  videoSource = new CanvasSource(colorCanvas, { codec: videoCodec, bitrate: QUALITY_HIGH });
  // Stream the encode to disk (desktop) so the whole MP4 never sits in the heap.
  writer = await createMp4Writer();
  output = new Output({ format: new Mp4OutputFormat({ fastStart: writer.fastStart }), target: writer.target });
  output.addVideoTrack(videoSource);

  const hasAudio = (audioTracks && audioTracks.length > 0) || !!audioSrc || !!sfxSrc;
  if (hasAudio) {
    const audioCodec = await getFirstEncodableAudioCodec(["aac", "opus", "mp3"]);
    if (audioCodec) {
      audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 128_000 });
      output.addAudioTrack(audioSource);
    }
  }

  await output.start();

  let c2 = 0;
  const timeline = items.map((item, idx) => {
    const start = c2; c2 += item.dframes;
    return { ...item, start, end: c2, idx };
  });
  const totalFrames = c2;

  for (let frame = 0; frame < totalFrames; frame++) {
    await drawCarouselFrame({ ctx, ctxA, ctxB, tempA, tempB, frame, timeline, mediaHandles, wmImg, params });
    colorCtx.clearRect(0, 0, cw, ch);
    if (colorFilterStr) {
      colorCtx.filter = colorFilterStr;
      colorCtx.drawImage(canvas, 0, 0);
      colorCtx.filter = "none";
    } else {
      colorCtx.drawImage(canvas, 0, 0);
    }
    await videoSource.add(frame / fps, 1 / fps);
    onProgress((frame + 1) / totalFrames * (audioSource ? 0.85 : 0.95));
  }

  videoSource.close();
  videoSource = null;

  if (audioSource && hasAudio) {
    const sourceBuffer = await prepareCarouselAudioBuffer({
      audioSrc, audioTracks, audioVol, audioFadeIn, audioFadeOut, sfxSrc, sfxVol,
      durationSecs: totalFrames / fps,
      transitionStartFrames: timeline.slice(1).map(t => t.start),
      fps,
    });
    await audioSource.add(sourceBuffer);
    audioSource.close();
    audioSource = null;
    onProgress(0.97);
  }

  await output.finalize();
  finalized = true;
  onProgress(1);
  return await writer.getBlob();
  } finally {
    try { videoSource?.close(); } catch { /* already closed */ }
    try { audioSource?.close(); } catch { /* already closed */ }
    // Drop the staged .part if we never finalized+read it (getBlob cleans up on success).
    if (!finalized) { try { await writer?.discard(); } catch { /* */ } }
    releaseMedia();
  }
}

/* ── Single-engine canvas preview ─────────────────────────────────────────────
 * The ONLY preview for this tool: every frame is drawn by the SAME
 * drawCarouselFrame the export encodes, the colour pass is the same filter string,
 * and the audio is the SAME AudioBuffer (bg tracks + transition SFX) — so
 * preview == export BY CONSTRUCTION. */

type CarouselPreviewHandle = { getCurrentFrame: () => number; seekTo: (f: number) => void };

const CarouselCanvasPreview = forwardRef<CarouselPreviewHandle, {
  params: Omit<RenderParams, "onProgress">;
  totalFrames: number;
  maxHeight: number;
  /** Media-load/init failure (NOT transient per-frame draws; audio stays silent). */
  onError?: (err: unknown) => void;
}>(function CarouselCanvasPreview({ params, totalFrames, maxHeight, onError }, ref) {
  const { cw, ch } = params;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offRef = useRef<{ main: OffscreenCanvas; a: OffscreenCanvas; b: OffscreenCanvas } | null>(null);
  const mediaRef = useRef<(ImageBitmap | HTMLVideoElement)[] | null>(null);
  const wmImgRef = useRef<ImageBitmap | null>(null);
  const frameRef = useRef(0);        // fractional playhead
  const dirtyRef = useRef(true);     // force a redraw (props/media changed)
  const busyRef = useRef(false);     // an async draw is in flight (video seeks await)
  const [playing, setPlaying] = useState(false);
  // Sync mirror of the play state for async audio guards (a state closure would be
  // stale by the time the buffer build completes).
  const playingRef = useRef(false);
  const disposedRef = useRef(false);
  const [curFrame, setCurFrame] = useState(0);
  // True when the browser/WebView is blocking audio (AudioContext stuck suspended);
  // we show an "Enable sound" button so a fresh click can unlock + start it.
  const [soundBlocked, setSoundBlocked] = useState(false);

  const timeline = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const item of params.items) { starts.push(acc); acc += item.dframes; }
    return params.items.map((item, idx) => ({ ...item, start: starts[idx], end: starts[idx] + item.dframes, idx }));
  }, [params.items]);

  // The export's colour pass, applied on the blit to the visible canvas.
  const colorFilterStr = [
    params.brightness !== 100 ? `brightness(${params.brightness}%)` : "",
    params.saturation !== 100 ? `saturate(${params.saturation}%)` : "",
    params.contrast   !== 100 ? `contrast(${params.contrast}%)` : "",
    params.hue        !== 0   ? `hue-rotate(${params.hue}deg)` : "",
  ].filter(Boolean).join(" ");

  // Media handles — the SAME loader the export uses (images → bitmaps, videos → <video>).
  const mediaKey = JSON.stringify(params.items.map(i => [i.url, i.type]));
  useEffect(() => {
    let cancelled = false;
    mediaRef.current = null;
    loadCarouselMedia(params.items)
      .then(handles => { if (!cancelled) { mediaRef.current = handles; dirtyRef.current = true; } })
      .catch(e => {
        if (cancelled) return;
        logDebug("carousel-to-video", "preview media load failed", e);
        onError?.(e);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey]);
  useEffect(() => {
    let cancelled = false;
    wmImgRef.current = null;
    if (params.wm.enabled && params.wm.type === "image" && params.wm.imageUrl) {
      fetch(params.wm.imageUrl).then(r => r.blob()).then(b => createImageBitmap(b))
        .then(bmp => { if (!cancelled) { wmImgRef.current = bmp; dirtyRef.current = true; } })
        .catch(e => {
          // The export fetches this same image and would fail too — surface it.
          if (cancelled) return;
          logDebug("carousel-to-video", "preview watermark load failed", e);
          onError?.(e);
        });
    } else { dirtyRef.current = true; }
    return () => { cancelled = true; };
  }, [params.wm.enabled, params.wm.type, params.wm.imageUrl, onError]);

  // Any visual param change → redraw the current frame.
  const visualKey = JSON.stringify({ ...params, items: undefined });
  useEffect(() => { dirtyRef.current = true; }, [visualKey, mediaKey, totalFrames]);

  // ── Audio: play the ORIGINAL media through <audio> elements, synced EVERY frame —
  // the SAME model as the editor's AudioMixer (the Web Audio API / AudioContext is
  // silent in the desktop WebView; media elements work perfectly). Background music
  // is seeked to the playhead and looped to fill; the transition SFX fires each time
  // the playhead crosses a slide boundary. `play()` is retried every tick until it
  // sticks (matches the editor's autoplay-tolerant behaviour). ──
  const bgElRef = useRef<HTMLAudioElement | null>(null);
  const bgSrcRef = useRef<string | null>(null);
  const sfxElRef = useRef<HTMLAudioElement | null>(null);
  const sfxSrcRef = useRef<string | null>(null);
  const lastAudioFrameRef = useRef(0); // previous frame — for SFX boundary crossing

  const stopAudio = useCallback(() => {
    bgElRef.current?.pause();
    sfxElRef.current?.pause();
  }, []);

  // Per-frame audio sync (called from the rAF loop, like AudioMixer.sync).
  const syncAudio = useCallback((frame: number, isPlaying: boolean) => {
    // ── Background music ──
    const bgSrc = params.audioTracks?.[0]?.src ?? params.audioSrc ?? null;
    if (bgSrc) {
      if (!bgElRef.current || bgSrcRef.current !== bgSrc) {
        bgElRef.current?.pause();
        const el = new Audio(bgSrc);
        el.preload = "auto";
        el.loop = true; // fill the whole video; drift-seek keeps it on the playhead
        bgElRef.current = el;
        bgSrcRef.current = bgSrc;
      }
      const bg = bgElRef.current;
      bg.volume = Math.max(0, Math.min(1, params.audioVol ?? 1));
      if (isPlaying) {
        if (bg.duration && Number.isFinite(bg.duration)) {
          const target = (frame / FPS) % bg.duration;
          if (Math.abs(bg.currentTime - target) > 0.4) { try { bg.currentTime = target; } catch { /* not seekable yet */ } }
        }
        if (bg.paused) bg.play().then(() => setSoundBlocked(false), () => setSoundBlocked(true));
      } else if (!bg.paused) {
        bg.pause();
      }
    } else if (bgElRef.current && !bgElRef.current.paused) {
      bgElRef.current.pause();
    }

    // ── Transition SFX (fire on each slide-boundary crossing) ──
    const sfxSrc = params.sfxSrc;
    if (sfxSrc && (params.sfxVol ?? 0) > 0) {
      if (!sfxElRef.current || sfxSrcRef.current !== sfxSrc) {
        const el = new Audio(sfxSrc);
        el.preload = "auto";
        sfxElRef.current = el;
        sfxSrcRef.current = sfxSrc;
      }
      const sfx = sfxElRef.current;
      sfx.volume = Math.max(0, Math.min(1, params.sfxVol ?? 1));
      if (isPlaying) {
        const prev = frame < lastAudioFrameRef.current ? -1 : lastAudioFrameRef.current; // reset on loop wrap
        for (const t of timeline.slice(1)) {
          if (prev < t.start && frame >= t.start) {
            try { sfx.currentTime = 0; } catch { /* not seekable yet */ }
            void sfx.play().catch(() => { /* autoplay gate — ignore, bg unlock covers it */ });
            break;
          }
        }
      }
    }
    lastAudioFrameRef.current = frame;
  }, [params.audioTracks, params.audioSrc, params.audioVol, params.sfxSrc, params.sfxVol, timeline]);

  // ── The frame draw — delegates to the export's drawCarouselFrame ──
  const draw = useCallback(async (frame: number) => {
    const canvas = canvasRef.current;
    if (!canvas || busyRef.current) return;
    if (!offRef.current || offRef.current.main.width !== cw || offRef.current.main.height !== ch) {
      offRef.current = { main: new OffscreenCanvas(cw, ch), a: new OffscreenCanvas(cw, ch), b: new OffscreenCanvas(cw, ch) };
    }
    const { main, a: tempA, b: tempB } = offRef.current;
    const ctx = main.getContext("2d")!;
    busyRef.current = true;
    try {
      const media = mediaRef.current;
      if (media && timeline.length > 0) {
        const end = Math.max(1, timeline[timeline.length - 1].end);
        const f = Math.max(0, Math.min(Math.floor(frame), end - 1));
        await drawCarouselFrame({
          ctx, ctxA: tempA.getContext("2d")!, ctxB: tempB.getContext("2d")!, tempA, tempB,
          frame: f, timeline, mediaHandles: media, wmImg: wmImgRef.current,
          params: { ...params, onProgress: () => {} },
        });
      } else {
        ctx.clearRect(0, 0, cw, ch);
        ctx.fillStyle = params.bgColor;
        ctx.fillRect(0, 0, cw, ch);
      }
      const vctx = canvas.getContext("2d");
      if (vctx) {
        vctx.clearRect(0, 0, cw, ch);
        vctx.filter = colorFilterStr || "none";
        vctx.drawImage(main, 0, 0);
        vctx.filter = "none";
      }
    } catch (e) {
      logDebug("carousel-to-video", "preview draw failed", e);
    } finally {
      busyRef.current = false;
    }
  }, [cw, ch, timeline, params, colorFilterStr]);

  // Latest-value refs so the rAF clock below NEVER tears down on a param change.
  // (If `draw`/`totalFrames` were effect deps, editing duration, Card Size, colour,
  // etc. WHILE PLAYING would recreate the loop and reset its wall-clock — so live
  // edits wouldn't smoothly take on the running preview. Reading through refs makes
  // every change reflect instantly without restarting playback.)
  const drawRef = useRef(draw);
  const syncAudioRef = useRef(syncAudio);
  const totalFramesRef = useRef(totalFrames);
  useEffect(() => { drawRef.current = draw; dirtyRef.current = true; }, [draw]);
  useEffect(() => { syncAudioRef.current = syncAudio; }, [syncAudio]);
  useEffect(() => { totalFramesRef.current = totalFrames; }, [totalFrames]);

  // ── Clock: rAF loop; draws when playing (advancing) or dirty (paused edit).
  // draw() is async (video seeks) — ticks are skipped while one is in flight, and
  // wall-clock advancement keeps A/V in sync. Only `playing` gates advancement, so
  // the loop is created once per play/pause and reads live values through refs.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let lastDrawn = -1;
    const loop = (t: number) => {
      if (playing) {
        if (!last) last = t;
        frameRef.current += ((t - last) / 1000) * FPS;
        if (frameRef.current >= totalFramesRef.current) {
          frameRef.current = 0; // loop playback back to the start
        }
        last = t;
      } else {
        last = 0;
      }
      const f = Math.floor(frameRef.current);
      // Keep the <audio> elements synced to the playhead EVERY tick (like the editor).
      syncAudioRef.current(f, playing);
      if ((f !== lastDrawn || dirtyRef.current) && !busyRef.current) {
        lastDrawn = f;
        dirtyRef.current = false;
        void drawRef.current(f).then(() => setCurFrame(f));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = useCallback(() => {
    const next = !playingRef.current;
    playingRef.current = next;
    setPlaying(next);
    // Kick the audio inside the click gesture (unlocks autoplay); the rAF loop then
    // keeps it synced every tick. On pause, stop immediately.
    if (next) syncAudio(Math.floor(frameRef.current), true);
    else stopAudio();
  }, [syncAudio, stopAudio]);

  // Spacebar toggles play/pause — but never while typing in a field or on a button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || t?.isContentEditable) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  const seekTo = useCallback((f: number) => {
    frameRef.current = Math.max(0, Math.min(f, totalFrames - 1));
    dirtyRef.current = true;
    lastAudioFrameRef.current = Math.floor(frameRef.current); // don't re-fire SFX on a scrub
    // Re-sync the <audio> to the new position immediately.
    syncAudio(Math.floor(frameRef.current), playingRef.current);
  }, [totalFrames, syncAudio]);

  useImperativeHandle(ref, () => ({
    getCurrentFrame: () => Math.floor(frameRef.current),
    seekTo,
  }), [seekTo]);

  // Teardown: stop + release the <audio> elements.
  useEffect(() => () => {
    disposedRef.current = true;
    playingRef.current = false;
    stopAudio();
    for (const r of [bgElRef, sfxElRef]) { if (r.current) { r.current.pause(); r.current.src = ""; r.current = null; } }
  }, [stopAudio]);

  // Fit the canvas into the available box at the composition's aspect.
  const scale = Math.min(maxHeight / ch, 1);
  const dispW = Math.round(cw * scale);
  const dispH = Math.round(ch * scale);

  const enableSound = () => {
    setSoundBlocked(false);
    // Fresh click gesture — force a play + sync.
    void bgElRef.current?.play().catch(() => {});
    syncAudio(Math.floor(frameRef.current), true);
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: dispW }}>
        <canvas
          ref={canvasRef}
          width={cw}
          height={ch}
          onClick={togglePlay}
          className="rounded-lg cursor-pointer bg-black shadow-lg max-w-full block"
          style={{ width: dispW, height: dispH, maxHeight }}
        />
        {soundBlocked && (
          <button onClick={enableSound} title="The browser blocked audio — click to enable"
            className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-semibold text-white bg-black/70 hover:bg-black/85 backdrop-blur-sm border border-white/20 cursor-pointer transition-colors">
            🔇 Enable sound
          </button>
        )}
      </div>
      <div className="flex items-center gap-2" style={{ width: Math.min(dispW, 520) }}>
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
});

function drawFanCanvasCard(
  ctx: OffscreenCanvasRenderingContext2D,
  media: ImageBitmap | HTMLVideoElement,
  x: number, y: number, w: number, h: number,
  radius: number, opacity: number,
  rotation = 0, scale = 1,
  fitMode: FitMode = "cover", bgColor = "#000000", blurAmount = 0, zoom = 1, radiusFrac = 0,
) {
  const mw = "videoWidth" in media ? media.videoWidth  : media.width;
  const mh = "videoWidth" in media ? media.videoHeight : media.height;
  if (!mw || !mh) return;
  // The Image Radius slider overrides the card's built-in corner radius when set.
  const effR = radiusFrac > 0 ? radiusFrac * Math.min(w, h) : radius;

  ctx.save();
  if (rotation !== 0 || scale !== 1) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.scale(scale, scale);
    ctx.translate(-w / 2, -h / 2);
    x = 0; y = 0;
  }
  // shadow
  ctx.globalAlpha = opacity;
  ctx.shadowColor = "rgba(0,0,0,0.58)"; ctx.shadowBlur = 26; ctx.shadowOffsetY = 10;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, effR / scale);
  ctx.fillStyle = "rgba(0,0,0,0.01)"; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  // clip to the card
  ctx.beginPath(); ctx.roundRect(x, y, w, h, effR / scale); ctx.clip();

  // Honour the slide's fit mode inside the card (contain / cover / blur-fill),
  // plus the Image Size zoom on the foreground media.
  const cover   = Math.max(w / mw, h / mh) * zoom;
  const contain = Math.min(w / mw, h / mh) * zoom;
  if (fitMode === "contain") {
    ctx.fillStyle = bgColor && bgColor !== "transparent" ? bgColor : "#000000";
    ctx.fillRect(x, y, w, h);
    const dw = mw * contain, dh = mh * contain;
    ctx.drawImage(media, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } else if (fitMode === "blur-fill") {
    // blurred, over-scaled fill behind the contained image (not zoomed)
    const bsc = Math.max(w / mw, h / mh) * 1.12, bdw = mw * bsc, bdh = mh * bsc;
    ctx.save();
    ctx.filter = `blur(${blurAmount > 0 ? blurAmount : 24}px)`;
    ctx.drawImage(media, x + (w - bdw) / 2, y + (h - bdh) / 2, bdw, bdh);
    ctx.restore();
    const dw = mw * contain, dh = mh * contain;
    ctx.drawImage(media, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } else {
    const dw = mw * cover, dh = mh * cover;
    ctx.drawImage(media, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  ctx.restore();
}

function getAudioDuration(src: string): Promise<number> {
  return new Promise(resolve => {
    const a = new Audio();
    a.onloadedmetadata = () => { resolve(a.duration); a.src = ""; };
    a.onerror = () => resolve(0);
    a.src = src;
  });
}

function getVideoDuration(src: string): Promise<number> {
  return new Promise(resolve => {
    const v = document.createElement("video");
    v.onloadedmetadata = () => { resolve(v.duration); v.src = ""; };
    v.onerror = () => resolve(5);
    v.src = src;
  });
}

/* ── Transition picker mini-icons ────────────────────────────────────────── */

const SEG_COLORS = ["#3D7EFD","#3D7EFD","#3b82f6","#10b981","#f59e0b","#ec4899","#06b6d4","#84cc16"];

/* ── Template mini-previews ──────────────────────────────────────────────── */

function TemplateMiniPreview({ style, active }: { style: SlideTemplate; active: boolean }) {
  const A = active ? "#3D7EFD" : "#d4d4d8";
  const W = "#fff";
  const s = { width: 44, height: 32 };
  const border = <rect x={1} y={1} width={42} height={30} rx={3} stroke={A} strokeWidth={1.2} fill="none" />;

  if (style === "none") return (
    <svg {...s} viewBox="0 0 44 32">
      <rect x={1} y={1} width={42} height={30} rx={3} fill={A} opacity={0.25} />{border}
    </svg>
  );

  if (style === "lower-third") return (
    <svg {...s} viewBox="0 0 44 32">
      <rect x={1} y={1} width={42} height={30} rx={3} fill={A} opacity={0.15} />
      <rect x={1} y={22} width={3} height={9} rx={1} fill={A} opacity={0.9} />
      <rect x={4} y={22} width={26} height={9} rx={0} fill="rgba(0,0,0,0.7)" />
      <rect x={6} y={24.5} width={14} height={2} rx={1} fill={W} opacity={0.9} />
      <rect x={6} y={28} width={10} height={1.4} rx={0.7} fill={A} opacity={0.8} />
      {border}
    </svg>
  );

  if (style === "big-title") return (
    <svg {...s} viewBox="0 0 44 32">
      <rect x={1} y={1} width={42} height={30} rx={3} fill={A} opacity={0.15} />
      <rect x={1} y={18} width={42} height={13} rx={0} fill="rgba(0,0,0,0.6)" />
      <rect x={8} y={21} width={28} height={3} rx={1} fill={W} opacity={0.9} />
      <rect x={14} y={26} width={16} height={2} rx={1} fill={A} opacity={0.8} />
      {border}
    </svg>
  );

  if (style === "typewriter") return (
    <svg {...s} viewBox="0 0 44 32">
      <rect x={1} y={1} width={42} height={30} rx={3} fill={A} opacity={0.15} />
      <rect x={1} y={20} width={42} height={11} rx={0} fill="rgba(0,0,0,0.65)" />
      <rect x={5} y={23} width={20} height={2} rx={1} fill={W} opacity={0.85} />
      <rect x={25} y={22.5} width={1.5} height={3} rx={0.5} fill={A} opacity={0.9} />
      <rect x={5} y={27} width={14} height={1.5} rx={0.75} fill={W} opacity={0.5} />
      {border}
    </svg>
  );

  if (style === "neon") return (
    <svg {...s} viewBox="0 0 44 32">
      <rect x={1} y={1} width={42} height={30} rx={3} fill="rgba(0,0,0,0.5)" />
      <rect x={10} y={13} width={24} height={3.5} rx={1} fill={A} opacity={0.9} />
      <rect x={10} y={13} width={24} height={3.5} rx={1} fill={A} opacity={0.3} filter="blur(2px)" />
      <rect x={15} y={18} width={14} height={2} rx={1} fill={W} opacity={0.5} />
      {border}
    </svg>
  );

  if (style === "glitch-fx") return (
    <svg {...s} viewBox="0 0 44 32">
      <rect x={1} y={1} width={42} height={30} rx={3} fill={A} opacity={0.15} />
      <rect x={4} y={13} width={24} height={4} rx={1} fill={W} opacity={0.8} />
      <rect x={7} y={13} width={24} height={4} rx={1} fill="rgba(255,0,60,0.35)" />
      <rect x={1} y={13} width={24} height={4} rx={1} fill="rgba(0,200,255,0.35)" />
      <rect x={3} y={7} width={30} height={1.5} rx={0.5} fill={A} opacity={0.5} />
      <rect x={8} y={21} width={18} height={1.5} rx={0.5} fill={A} opacity={0.4} />
      {border}
    </svg>
  );

  if (style === "film") return (
    <svg {...s} viewBox="0 0 44 32">
      <rect x={1} y={1} width={42} height={30} rx={3} fill="rgba(110,70,30,0.25)" />
      <rect x={1} y={1} width={42} height={4} rx={0} fill="rgba(0,0,0,0.8)" />
      <rect x={1} y={27} width={42} height={4} rx={0} fill="rgba(0,0,0,0.8)" />
      <rect x={20} y={1} width={1} height={30} fill="rgba(255,235,180,0.4)" />
      <rect x={5} y={28.5} width={16} height={1.5} rx={0.5} fill="rgba(255,235,170,0.7)" />
      {border}
    </svg>
  );

  if (style === "lines") return (
    <svg {...s} viewBox="0 0 44 32">
      <rect x={1} y={1} width={42} height={30} rx={3} fill={A} opacity={0.15} />
      <line x1={8} y1={13} x2={36} y2={13} stroke={A} strokeWidth={1} opacity={0.9} />
      <line x1={8} y1={20} x2={36} y2={20} stroke={A} strokeWidth={1} opacity={0.9} />
      <rect x={11} y={14.5} width={22} height={2.5} rx={1} fill={W} opacity={0.85} />
      <rect x={16} y={18} width={12} height={1.5} rx={0.75} fill={A} opacity={0.7} />
      {border}
    </svg>
  );

  return null;
}

function TransitionIcon({ style }: { style: TransitionStyle }) {
  const A = "#3D7EFD";
  const B = "#3b82f6";
  const s = { width: 28, height: 20 };

  switch (style) {
    case "fade":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={1} y={1} width={12} height={18} rx={2} fill={A} opacity={0.9} />
          <rect x={15} y={1} width={12} height={18} rx={2} fill={B} opacity={0.4} />
        </svg>
      );
    case "slide-left": case "push-left":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={-4} y={1} width={14} height={18} rx={2} fill={A} opacity={0.8} />
          <rect x={12} y={1} width={14} height={18} rx={2} fill={B} opacity={0.9} />
          <path d="M18 7l4 3-4 3" stroke="#fff" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        </svg>
      );
    case "slide-right": case "push-right":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={14} y={1} width={14} height={18} rx={2} fill={A} opacity={0.8} />
          <rect x={2} y={1} width={14} height={18} rx={2} fill={B} opacity={0.9} />
          <path d="M10 7l-4 3 4 3" stroke="#fff" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        </svg>
      );
    case "slide-up": case "push-up":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={-3} width={24} height={12} rx={2} fill={A} opacity={0.8} />
          <rect x={2} y={11} width={24} height={12} rx={2} fill={B} opacity={0.9} />
          <path d="M11 8l3-4 3 4" stroke="#fff" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        </svg>
      );
    case "slide-down": case "push-down":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={11} width={24} height={12} rx={2} fill={A} opacity={0.8} />
          <rect x={2} y={-1} width={24} height={12} rx={2} fill={B} opacity={0.9} />
          <path d="M11 12l3 4 3-4" stroke="#fff" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        </svg>
      );
    case "zoom-in":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={1} width={24} height={18} rx={2} fill={A} opacity={0.4} />
          <rect x={8} y={5} width={12} height={10} rx={2} fill={A} opacity={0.9} />
          <rect x={4} y={2} width={20} height={16} rx={2} fill={B} opacity={0.5} />
        </svg>
      );
    case "zoom-out":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={4} y={2} width={20} height={16} rx={2} fill={A} opacity={0.9} />
          <rect x={2} y={1} width={24} height={18} rx={2} fill={B} opacity={0.3} />
          <rect x={8} y={5} width={12} height={10} rx={2} fill={B} opacity={0.7} />
        </svg>
      );
    case "wipe-right":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={1} width={24} height={18} rx={2} fill={A} opacity={0.7} />
          <rect x={2} y={1} width={12} height={18} rx={2} fill={B} opacity={0.9} />
          <line x1={14} y1={0} x2={14} y2={20} stroke="#fff" strokeWidth={1.5} strokeDasharray="3 2" />
        </svg>
      );
    case "wipe-left":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={1} width={24} height={18} rx={2} fill={A} opacity={0.7} />
          <rect x={14} y={1} width={12} height={18} rx={2} fill={B} opacity={0.9} />
          <line x1={14} y1={0} x2={14} y2={20} stroke="#fff" strokeWidth={1.5} strokeDasharray="3 2" />
        </svg>
      );
    case "wipe-up":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={1} width={24} height={18} rx={2} fill={A} opacity={0.7} />
          <rect x={2} y={1} width={24} height={9} rx={2} fill={B} opacity={0.9} />
          <line x1={0} y1={10} x2={28} y2={10} stroke="#fff" strokeWidth={1.5} strokeDasharray="3 2" />
        </svg>
      );
    case "3d-flip-h":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={3} width={8} height={14} rx={1} fill={A} opacity={0.9} />
          <rect x={11} y={1} width={6} height={18} rx={1} fill={A} opacity={0.5} />
          <rect x={18} y={3} width={8} height={14} rx={1} fill={B} opacity={0.9} />
        </svg>
      );
    case "3d-flip-v":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={2} width={24} height={6} rx={1} fill={A} opacity={0.9} />
          <rect x={2} y={9} width={24} height={3} rx={1} fill={A} opacity={0.5} />
          <rect x={2} y={13} width={24} height={6} rx={1} fill={B} opacity={0.9} />
        </svg>
      );
    case "cube-left":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={2} width={12} height={16} rx={1} fill={A} opacity={0.9} />
          <rect x={14} y={2} width={12} height={16} rx={1} fill={B} opacity={0.5} />
          <line x1={14} y1={2} x2={14} y2={18} stroke="rgba(255,255,255,0.5)" strokeWidth={1} />
          <path d="M14 2 L18 4 L18 16 L14 18" fill="rgba(255,255,255,0.15)" />
        </svg>
      );
    case "glitch":
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={1} width={24} height={18} rx={2} fill={A} opacity={0.7} />
          <rect x={2} y={5} width={24} height={4} rx={0} fill={B} opacity={0.8} />
          <rect x={6} y={11} width={18} height={3} rx={0} fill={B} opacity={0.6} />
          <rect x={2} y={15} width={10} height={2} rx={0} fill={B} opacity={0.9} />
        </svg>
      );
    default:
      return (
        <svg {...s} viewBox="0 0 28 20">
          <rect x={2} y={1} width={24} height={18} rx={2} fill={A} opacity={0.7} />
        </svg>
      );
  }
}

/* ── Main page ────────────────────────────────────────────────────────────── */

export default function CarouselToVideoPage() {
  const [items, setItems]             = useState<MediaItem[]>([]);
  const [ratio, setRatio]             = useState<AspRatio>("9:16");
  const [globalDur, setGlobalDur]     = useState(3);
  const [globalFit, setGlobalFit]     = useState<FitMode>("cover");
  const [brightness, setBrightness]   = useState(100);
  const [saturation, setSaturation]   = useState(100);
  const [contrast,   setContrast]     = useState(100);
  const [hue,        setHue]          = useState(0);
  const [bgColor, setBgColor]         = useState("#000000");
  const [blurAmount, setBlurAmount]   = useState(22);
  const [transition, setTransition]   = useState<TransitionStyle>("slide-left");
  const [xfade, setXfade]             = useState(18);

  const [audioSrc, setAudioSrc]           = useState<string | null>(null);
  const [audioName, setAudioName]         = useState<string | null>(null);
  const [audioTracks, setAudioTracks]     = useState<AudioTrack[]>([]);
  const [audioVol, setAudioVol]           = useState(0.8);
  const [audioFadeIn, setAudioFadeIn]     = useState(false);
  const [audioFadeOut, setAudioFadeOut]   = useState(true);
  const [sfxSrc, setSfxSrc]               = useState<string | null>(null);
  const [sfxName, setSfxName]             = useState<string | null>(null);
  const [sfxVol, setSfxVol]               = useState(1.0);
  const [template, setTemplate]           = useState<SlideTemplate>("none");
  const [layoutMode, setLayoutMode]       = useState<LayoutMode>("fullscreen");
  const [fanStyle, setFanStyle]           = useState<FanStyle>("trio");
  const [cardScale, setCardScale]         = useState(1.0);
  const [imageZoom, setImageZoom]         = useState(1.0);
  const [cardRadius, setCardRadius]       = useState(0);
  const [imageRadius, setImageRadius]     = useState(0);
  const [templateCfg, setTemplateCfg]     = useState<TemplateCfg>(DEFAULT_TEMPLATE_CFG);
  const patchCfg = (p: Partial<TemplateCfg>) => setTemplateCfg(prev => ({ ...prev, ...p }));

  const [wm, setWm]                       = useState<WatermarkCfg>(DEFAULT_WATERMARK);
  const [genState, setGenState]           = useState<"idle" | "generating" | "done">("idle");
  const [genProgress, setGenProgress]     = useState(0);
  const [errors, setErrors]               = useState<string[]>([]);
  // Warn before navigating away mid-render (it runs on this page, dies on unmount).
  useRegisterTask(genState === "generating", { label: "Carousel video render", kind: "studio" });
  const [isDragging, setIsDragging]       = useState(false);
  const [dragSrc, setDragSrc]             = useState<number | null>(null);
  const [dragDst, setDragDst]             = useState<number | null>(null);
  const [currentFrame, setCurrentFrame]   = useState(0);
  const [genBlobUrl, setGenBlobUrl]       = useState<string | null>(null);
  const [genOutPath, setGenOutPath]       = useState<string | null>(null); // saved MP4 path (desktop)
  const [genBlob,    setGenBlob]          = useState<Blob | null>(null);    // for "save a copy" on web/fallback
  const [rightOpen, setRightOpen]         = useState(true); // Design sidebar visible
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set(["output", "adjust", "transition", "transition-adv", "template", "sfx", "audio", "watermark", "color"])
  );
  const toggleSection = (key: string) => setCollapsedSections(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const { w: compW, h: compH } = DIMS[ratio];

  const compItems = useMemo(() =>
    items.map(item => ({
      url: item.url,
      type: item.type,
      dframes: Math.round(item.duration * FPS),
      fitMode: item.fitMode,
    })),
    [items]
  );

  const totalFrames  = Math.max(1, compItems.reduce((a, s) => a + s.dframes, 0));
  const totalSeconds = (compItems.reduce((a, s) => a + s.dframes, 0) / FPS).toFixed(1);

  // Params for the single-engine canvas preview — IDENTICAL to what generate() passes
  // renderCarousel (minus onProgress), so the preview IS the export. Note audioSrc is
  // null here exactly like the export (bg audio rides audioTracks).
  const previewParams = useMemo<Omit<RenderParams, "onProgress">>(() => ({
    items: compItems, transition, xfade,
    cw: compW, ch: compH, fps: FPS,
    audioSrc: null,
    audioTracks: audioTracks.map(t => ({ src: t.src })),
    audioVol, audioFadeIn, audioFadeOut, sfxSrc, sfxVol,
    template, templateCfg,
    wm, bgColor, blurAmount, layoutMode, fanStyle, cardScale, imageZoom, cardRadius, imageRadius,
    brightness, saturation, contrast, hue,
  }), [compItems, transition, xfade, compW, compH, audioTracks, audioVol, audioFadeIn, audioFadeOut, sfxSrc, sfxVol, template, templateCfg, wm, bgColor, blurAmount, layoutMode, fanStyle, cardScale, imageZoom, cardRadius, imageRadius, brightness, saturation, contrast, hue]);

  // Handle to the canvas preview (the ONLY preview engine) + its error surface:
  // a media-load/init failure overlays PreviewErrorCard on the preview frame;
  // Retry clears the error and bumps the remount key so the engine reloads.
  const canvasPreviewRef = useRef<CarouselPreviewHandle>(null);
  const [previewError, setPreviewError] = useState<{ error: unknown } | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const onPreviewError = useCallback((err: unknown) => setPreviewError({ error: err }), []);
  const retryPreview = useCallback(() => {
    setPreviewError(null);
    setPreviewEpoch(e => e + 1);
  }, []);
  // Changing the media set (or the watermark image) re-triggers the preview's own
  // load, so drop a stale pinned error alongside it. Done during render (React's
  // "adjust state when a prop changes" pattern) rather than in an effect.
  const previewMediaKey = JSON.stringify(compItems.map(i => [i.url, i.type]));
  const previewResetKey = JSON.stringify([previewMediaKey, wm.enabled, wm.type, wm.imageUrl]);
  const [prevResetKey, setPrevResetKey] = useState(previewResetKey);
  if (prevResetKey !== previewResetKey) {
    setPrevResetKey(previewResetKey);
    setPreviewError(null);
  }
  const previewSeekTo = useCallback((f: number) => { canvasPreviewRef.current?.seekTo(f); }, []);
  const previewCurrentFrame = useCallback(() => canvasPreviewRef.current?.getCurrentFrame() ?? 0, []);

  /* media upload */
  const addMedia = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const errs: string[] = [];
    const newItems: MediaItem[] = [];
    await Promise.all(Array.from(files).map(async f => {
      const isImage = f.type.startsWith("image/");
      const isVideo = f.type.startsWith("video/");
      if (!isImage && !isVideo) { errs.push(`${f.name}: unsupported type`); return; }
      if (f.size > 200 * 1024 * 1024) { errs.push(`${f.name}: exceeds 200 MB`); return; }
      const url = URL.createObjectURL(f);
      let duration = globalDur;
      if (isVideo) {
        duration = Math.min(await getVideoDuration(url), 30);
      }
      newItems.push({
        id: crypto.randomUUID(), url, name: f.name,
        type: isImage ? "image" : "video",
        duration, fitMode: globalFit,
        ...(isVideo ? { videoDuration: duration } : {}),
      });
    }));
    if (errs.length) setErrors(errs);
    setItems(prev => [...prev, ...newItems]);
  }, [globalFit, globalDur]);

  const removeItem   = (id: string) => setItems(prev => prev.filter(s => s.id !== id));
  const updateItem   = (id: string, patch: Partial<MediaItem>) =>
    setItems(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  const applyBulkFit = (fit: FitMode) => {
    setGlobalFit(fit);
    setItems(prev => prev.map(s => ({ ...s, fitMode: fit })));
  };
  // Apply one duration to EVERY slide at once (videos clamp to their own length).
  const applyBulkDuration = (dur: number) => {
    const d = Math.max(0.5, dur || 1);
    setGlobalDur(d);
    setItems(prev => prev.map(s => {
      const max = s.type === "video" ? (s.videoDuration ?? 60) : 60;
      return { ...s, duration: Math.max(0.5, Math.min(max, d)) };
    }));
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    addMedia(e.dataTransfer.files);
  }, [addMedia]);

  /* audio */
  // Add ONE background track from a local File (upload → MusicLibraryBrowser).
  const addAudioTrackFile = async (f: File) => {
    const src = URL.createObjectURL(f);
    const durationSecs = await getAudioDuration(src);
    setAudioTracks(prev => [...prev, { id: crypto.randomUUID(), src, name: f.name.replace(/\.[^/.]+$/, ""), durationSecs }]);
  };
  const removeAudioTrack = (id: string) => {
    setAudioTracks(prev => { const t = prev.find(t => t.id === id); if (t) URL.revokeObjectURL(t.src); return prev.filter(t => t.id !== id); });
  };
  // Pick the transition SFX from a local File (upload → MusicLibraryBrowser).
  const pickSfxFile = (f: File) => {
    setSfxSrc(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f); });
    setSfxName(f.name.replace(/\.[^/.]+$/, ""));
  };

  /* generate */
  async function generate() {
    const errs: string[] = [];
    if (items.length === 0) errs.push("Add at least one image or video.");
    if (errs.length) { setErrors(errs); return; }
    setErrors([]);
    setGenState("generating"); setGenProgress(0);
    if (genBlobUrl) { URL.revokeObjectURL(genBlobUrl); setGenBlobUrl(null); }
    setGenOutPath(null); setGenBlob(null);
    // Global render-dock job so progress stays visible across navigation.
    const dockId = useRenderJobs.getState().startJob({
      label: "Carousel video", kind: "carousel",
      href: typeof window !== "undefined" ? window.location.pathname + window.location.search : "/video-studio/carousel-to-video",
    });
    try {
      const blob = await renderCarousel({
        items: compItems, transition, xfade,
        cw: compW, ch: compH, fps: FPS,
        audioSrc: null,
        audioTracks: audioTracks.map(t => ({ src: t.src })),
        audioVol, audioFadeIn, audioFadeOut, sfxSrc, sfxVol,
        template, templateCfg,
        wm, bgColor, blurAmount, layoutMode, fanStyle, cardScale, imageZoom, cardRadius, imageRadius,
        brightness, saturation, contrast, hue,
        onProgress: p => { setGenProgress(p * 100); useRenderJobs.getState().setProgress(dockId, p * 100); },
      });
      const url = URL.createObjectURL(blob);
      setGenBlobUrl(url);
      setGenBlob(blob);
      // Persist the finished MP4 to Downloads (like the editor export) so it's
      // actually on disk + findable — the render dock's Open / Show-in-folder resolve
      // this path. The old `<a download>` link is silently ignored by the Tauri webview.
      let outputPath: string | null = null;
      try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (isTauri()) {
          const { downloadDir, join } = await import("@tauri-apps/api/path");
          const { invokeWithBytes } = await import("@/lib/tauri-bytes");
          const dest = await join(await downloadDir(), "Carousel video.mp4");
          outputPath = await invokeWithBytes<string>("save_bytes", blob, { "dest-path": dest });
          setGenOutPath(outputPath);
          const { addLocalExport } = await import("@/lib/local-exports");
          addLocalExport({
            title: "Carousel video", path: outputPath,
            width: compW, height: compH, durationFrames: totalFrames, fps: FPS,
          });
        }
      } catch (e) {
        logError("carousel-to-video", "auto-save to Downloads failed", e);
      }
      setGenState("done"); setGenProgress(100);
      useRenderJobs.getState().finishJob(dockId, outputPath ? { outputPath } : undefined);
    } catch (err) {
      logError("carousel-to-video", "render failed", err);
      setErrors([`Render failed: ${humanizeError(err)}`]);
      setGenState("idle"); setGenProgress(0);
      useRenderJobs.getState().failJob(dockId, humanizeError(err));
    }
  }

  useEffect(() => {
    if (previewCurrentFrame() >= totalFrames) previewSeekTo(0);
  }, [totalFrames, previewCurrentFrame, previewSeekTo]);


  useEffect(() => {
    let id: number;
    const poll = () => { setCurrentFrame(previewCurrentFrame()); id = requestAnimationFrame(poll); };
    id = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(id);
  }, [previewCurrentFrame]);

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <AppLayout>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        <StudioToolHeader
          icon={Film}
          title="Carousel Video"
          accent="#ec4899"
          description={`Blend images & videos into cinematic carousels · ${items.length} clip${items.length !== 1 ? "s" : ""} · ${totalSeconds}s`}
        />

        <div className="flex flex-1 min-h-0">
          {/* ── LEFT PANEL ── */}
          {/* Transparent so the ambient AppBackground gradient shows through (the
              border-r still separates it from the preview). */}
          <div className="w-95 shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 overflow-hidden">
            {/* overflow-x-hidden: `overflow-y-auto` alone makes the x-axis compute
                to `auto` too (CSS spec), so a 1px-wide child would show a stray
                horizontal scrollbar. This panel only ever scrolls vertically. */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-5 space-y-6">

            {/* Errors */}
            {errors.length > 0 && (
              <div className="rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/5 p-3 flex gap-2">
                <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
                <div className="flex-1">
                  {errors.map((e, i) => <p key={i} className="text-[11px] text-red-600 dark:text-red-400">{e}</p>)}
                </div>
                <button onClick={() => setErrors([])} className="text-red-400 hover:text-red-600 cursor-pointer border-none bg-transparent shrink-0"><X size={12} /></button>
              </div>
            )}

            {/* ── Media ── */}
            <div>
              <SectionTitle>Media</SectionTitle>
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
                <input type="file" accept="image/*,video/*" multiple className="hidden"
                  onChange={e => addMedia(e.target.files)} />
                <ImagePlus size={18} className="text-zinc-400 mb-1.5" />
                <p className="text-[12px] font-medium text-zinc-500">Drop images or videos, or click</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">PNG, JPG, WebP, MP4, MOV · max 200 MB each</p>
              </label>

              {/* Item list */}
              <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
                {items.map((item, i) => {
                  const isDragged = dragSrc === i;
                  const isOver    = dragDst === i && dragSrc !== null && dragSrc !== i;
                  return (
                    <div
                      key={item.id}
                      draggable
                      onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragSrc(i); }}
                      onDragOver={e => { e.preventDefault(); if (dragSrc !== null && dragSrc !== i) setDragDst(i); }}
                      onDragLeave={() => setDragDst(null)}
                      onDrop={e => {
                        e.preventDefault();
                        if (dragSrc === null || dragSrc === i) { setDragSrc(null); setDragDst(null); return; }
                        const next = [...items];
                        const [itm] = next.splice(dragSrc, 1);
                        next.splice(i, 0, itm);
                        setItems(next);
                        setDragSrc(null); setDragDst(null);
                      }}
                      onDragEnd={() => { setDragSrc(null); setDragDst(null); }}
                      className={`relative flex items-center gap-2 p-2 rounded-lg border group transition-all ${
                        isDragged ? "opacity-40" :
                        "border-zinc-100 dark:border-white/8 bg-zinc-50 dark:bg-white/3 hover:border-zinc-200 dark:hover:border-white/12"
                      } ${isOver ? "ring-2 ring-violet-400 ring-inset" : ""}`}
                    >
                      <GripVertical size={12} className="text-zinc-300 dark:text-zinc-600 shrink-0 cursor-grab" />
                      <div className="w-10 h-10 rounded-md overflow-hidden shrink-0 bg-zinc-200 dark:bg-white/10 relative">
                        {item.type === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={item.url} alt={item.name} className="w-full h-full object-cover" />
                        ) : (
                          // eslint-disable-next-line jsx-a11y/media-has-caption
                          <video src={item.url} className="w-full h-full object-cover" muted />
                        )}
                        {item.type === "video" && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                            <Film size={10} className="text-white" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-medium truncate text-zinc-700 dark:text-zinc-300">{i + 1}. {item.name}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <select value={item.fitMode}
                            onChange={e => { e.stopPropagation(); updateItem(item.id, { fitMode: e.target.value as FitMode }); }}
                            onClick={e => e.stopPropagation()}
                            className="h-5 px-1 rounded text-[10px] bg-white dark:bg-white/8 border border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 outline-none cursor-pointer [color-scheme:light] dark:[color-scheme:dark]">
                            <option value="contain" className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">contain</option>
                            <option value="cover" className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">cover</option>
                            <option value="blur-fill" className="bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">blur</option>
                          </select>
                          <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                            <input
                              type="number" min={0.5} max={item.type === "video" ? (item.videoDuration ?? 60) : 60} step={0.5}
                              value={item.duration}
                              onChange={e => updateItem(item.id, { duration: parseFloat(e.target.value) || 1 })}
                              className="w-10 h-5 px-1 rounded text-[10px] text-center bg-white dark:bg-white/8 border border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-400 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                            />
                            <span className="text-[9px] text-zinc-400">s</span>
                          </div>
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full font-semibold"
                            style={{
                              background: item.type === "video" ? "rgba(61,126,253,0.1)" : "rgba(61,126,253,0.1)",
                              color: item.type === "video" ? "#3D7EFD" : "#3D7EFD",
                            }}>
                            {item.type}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); removeItem(item.id); }}
                        className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent transition-all shrink-0">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <p className="text-[12px] text-zinc-400 text-center py-4">No media yet</p>
                )}
              </div>
            </div>

            {/* ── Output Settings ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("output")} onToggle={() => toggleSection("output")}>Output Settings</SectionTitle>
              {!collapsedSections.has("output") && (
                <div className="space-y-4">
                  {/* Aspect ratio */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-2">Aspect Ratio</p>
                    <div className="grid grid-cols-5 gap-1.5">
                      {([
                        { id: "16:9", label: "Wide",   Icon: RectangleHorizontal },
                        { id: "9:16", label: "Story",  Icon: RectangleVertical },
                        { id: "1:1",  label: "Square", Icon: Square },
                        { id: "4:5",  label: "Post",   Icon: RectangleVertical },
                        { id: "3:4",  label: "Photo",  Icon: RectangleVertical },
                      ] as { id: AspRatio; label: string; Icon: typeof Square }[]).map(({ id, label, Icon }) => {
                        const active = ratio === id;
                        return (
                          <button key={id} onClick={() => setRatio(id)}
                            className={`flex flex-col items-center gap-1 py-2 rounded-xl border transition-all cursor-pointer font-[inherit] ${active ? "border-violet-500/50 bg-violet-500/8 ring-1 ring-violet-500/30" : "border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/4 hover:border-zinc-300 dark:hover:border-white/15"}`}>
                            <Icon size={16} strokeWidth={1.6} className={active ? "text-violet-500" : "text-zinc-400 dark:text-zinc-500"} />
                            <span className={`text-[10px] font-bold leading-none ${active ? "text-violet-600 dark:text-violet-400" : "text-zinc-600 dark:text-zinc-300"}`}>{id}</span>
                            <span className={`text-[8px] leading-none ${active ? "text-violet-400/70" : "text-zinc-400 dark:text-zinc-500"}`}>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Fit mode */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-2">Fit Mode</p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {([
                        { id: "contain",   label: "Contain", sub: "Fit inside", Icon: Shrink },
                        { id: "cover",     label: "Cover",    sub: "Fill frame", Icon: Expand },
                        { id: "blur-fill", label: "Blur",     sub: "Soft pad",   Icon: Focus },
                      ] as { id: FitMode; label: string; sub: string; Icon: typeof Square }[]).map(({ id, label, sub, Icon }) => {
                        const active = globalFit === id;
                        return (
                          <button key={id} onClick={() => applyBulkFit(id)}
                            className={`flex flex-col items-center gap-1 py-2.5 rounded-xl border transition-all cursor-pointer font-[inherit] ${active ? "border-violet-500/50 bg-violet-500/8 ring-1 ring-violet-500/30" : "border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/4 hover:border-zinc-300 dark:hover:border-white/15"}`}>
                            <Icon size={18} strokeWidth={1.6} className={active ? "text-violet-500" : "text-zinc-400 dark:text-zinc-500"} />
                            <span className={`text-[11px] font-bold leading-none ${active ? "text-violet-600 dark:text-violet-400" : "text-zinc-600 dark:text-zinc-300"}`}>{label}</span>
                            <span className={`text-[8.5px] leading-none ${active ? "text-violet-400/70" : "text-zinc-400 dark:text-zinc-500"}`}>{sub}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Blur amount (only for blur-fill) */}
                  {globalFit === "blur-fill" && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/4">
                      <Focus size={13} className="text-violet-500 shrink-0" />
                      <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 shrink-0">Blur</span>
                      <input type="range" min={0} max={60} step={1} value={blurAmount}
                        onChange={e => setBlurAmount(parseInt(e.target.value))}
                        className="flex-1 accent-violet-500" />
                      <span className="text-[10px] font-semibold text-violet-500 tabular-nums w-9 text-right">{blurAmount}px</span>
                    </div>
                  )}

                  {/* Duration + Background */}
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/4 p-2.5">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide text-zinc-400">
                          <Clock size={10} className="text-violet-500" /> Duration
                        </span>
                        {items.length > 0 && (
                          <button type="button" onClick={() => applyBulkDuration(globalDur)}
                            title={`Set all ${items.length} slides to ${globalDur}s`}
                            className="text-[9px] font-bold text-violet-500 hover:text-violet-600 cursor-pointer bg-transparent border-none p-0">
                            Apply all {items.length}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input type="number" min={0.5} max={60} step={0.5} value={globalDur}
                          onChange={e => setGlobalDur(parseFloat(e.target.value) || 1)}
                          className={inputCls("!h-8 text-[13px] font-semibold")} />
                        <span className="text-[10px] font-semibold text-zinc-400 shrink-0">sec</span>
                      </div>
                      <p className="text-[8.5px] text-zinc-400 mt-1 leading-tight">Per new slide</p>
                    </div>
                    <div className="rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/4 p-2.5">
                      <span className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">
                        <Palette size={10} className="text-violet-500" /> Background
                      </span>
                      <div className="flex items-center gap-1.5">
                        <ColorButton value={bgColor} onChange={setBgColor} size={32} />
                        <input type="text" value={bgColor} onChange={e => setBgColor(e.target.value)}
                          className={inputCls("!h-8 font-mono text-[11px]")} />
                      </div>
                      <p className="text-[8.5px] text-zinc-400 mt-1 leading-tight">Letterbox fill</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── Transition Style ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("transition")} onToggle={() => toggleSection("transition")}>Transition Style</SectionTitle>
              {!collapsedSections.has("transition") && (
                <div className="space-y-3">
                  {layoutMode !== "fullscreen" && (
                    <p className="text-[10px] text-amber-500/80 dark:text-amber-400/70 leading-relaxed">
                      Transition style applies to <span className="font-semibold">Full Screen</span> layout only. Other layouts use built-in animations.
                    </p>
                  )}
                  <div className="grid grid-cols-3 gap-1.5">
                    {ALL_TRANSITIONS.map(t => {
                      const active = transition === t;
                      return (
                        <button
                          key={t}
                          onClick={() => setTransition(t)}
                          className="flex flex-col items-center gap-1 p-2 rounded-lg border cursor-pointer transition-all"
                          style={{
                            background: active ? "rgba(61,126,253,0.08)" : "transparent",
                            borderColor: active ? "rgba(61,126,253,0.45)" : "rgba(0,0,0,0.08)",
                            opacity: layoutMode !== "fullscreen" ? 0.45 : 1,
                          }}
                        >
                          <TransitionIcon style={t} />
                          <span className="text-[9px] font-semibold leading-none"
                            style={{ color: active ? "#3D7EFD" : "rgba(0,0,0,0.4)" }}>
                            {TRANSITION_LABELS[t]}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Transition duration */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold text-zinc-400 shrink-0 w-24">Transition (frames)</span>
                    <input type="range" min={6} max={60} step={3} value={xfade}
                      onChange={e => setXfade(parseInt(e.target.value))}
                      className="flex-1 accent-violet-500" />
                    <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">{xfade}f</span>
                  </div>
                </div>
              )}
            </div>

            {/* ── Color Adjust ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("color")} onToggle={() => toggleSection("color")}>Color Adjust</SectionTitle>
              {!collapsedSections.has("color") && (
                <div className="space-y-2.5">
                  {([
                    { label: "Brightness", value: brightness, set: setBrightness, min: 0, max: 200, unit: "%", isDefault: brightness === 100, defaultVal: 100 },
                    { label: "Saturation", value: saturation, set: setSaturation, min: 0, max: 200, unit: "%", isDefault: saturation === 100, defaultVal: 100 },
                    { label: "Contrast",   value: contrast,   set: setContrast,   min: 0, max: 200, unit: "%", isDefault: contrast === 100,   defaultVal: 100 },
                    { label: "Hue",        value: hue,        set: setHue,        min: -180, max: 180, unit: "°", isDefault: hue === 0, defaultVal: 0 },
                  ] as const).map(({ label, value, set, min, max, unit, isDefault, defaultVal }) => (
                    <div key={label}>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{label}</label>
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] text-zinc-400 tabular-nums w-10 text-right">{value}{unit}</span>
                          {!isDefault && (
                            <button onClick={() => set(defaultVal as never)}
                              className="text-[9px] text-violet-500 hover:text-violet-600 cursor-pointer border-none bg-transparent font-semibold leading-none ml-1">
                              reset
                            </button>
                          )}
                        </div>
                      </div>
                      <input type="range" min={min} max={max} step={1} value={value}
                        onChange={e => set(parseInt(e.target.value) as never)}
                        className="w-full accent-violet-500 cursor-pointer" />
                    </div>
                  ))}
                  {(brightness !== 100 || saturation !== 100 || contrast !== 100 || hue !== 0) && (
                    <button
                      onClick={() => { setBrightness(100); setSaturation(100); setContrast(100); setHue(0); }}
                      className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer border-none bg-transparent transition-colors">
                      Reset all
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ── Sound Effects ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("sfx")} onToggle={() => toggleSection("sfx")}>Transition Sound Effect</SectionTitle>
              {!collapsedSections.has("sfx") && (
                <div className="space-y-3">
                  <p className="text-[10px] text-zinc-400">Plays once at every slide transition.</p>

                  {sfxSrc && (
                    <div className="flex items-center gap-2 p-2 rounded-lg border border-violet-200/50 dark:border-violet-500/20 bg-violet-50/50 dark:bg-violet-500/5">
                      <Volume2 size={11} className="text-violet-500 shrink-0" />
                      <p className="text-[11px] flex-1 truncate text-zinc-700 dark:text-zinc-300">{sfxName}</p>
                      <button
                        onClick={() => { URL.revokeObjectURL(sfxSrc); setSfxSrc(null); setSfxName(null); }}
                        className="text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent">
                        <X size={11} />
                      </button>
                    </div>
                  )}

                  {/* Pick a sound effect file from this computer. */}
                  <MusicLibraryBrowser onPick={pickSfxFile} />

                  {sfxSrc && (
                    <div className="flex items-center gap-2">
                      <Volume2 size={11} className="text-zinc-400 shrink-0" />
                      <input type="range" min={0} max={1} step={0.05} value={sfxVol}
                        onChange={e => setSfxVol(parseFloat(e.target.value))}
                        className="flex-1 accent-violet-500" />
                      <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">{Math.round(sfxVol * 100)}%</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Audio ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("audio")} onToggle={() => toggleSection("audio")}>Background Audio</SectionTitle>
              {!collapsedSections.has("audio") && (
                <div className="space-y-3">
                  {audioTracks.length > 0 ? (
                    <div className="space-y-1.5">
                      {audioTracks.map(t => (
                        <div key={t.id} className="flex items-center gap-2 p-2 rounded-lg border border-zinc-100 dark:border-white/8 bg-zinc-50 dark:bg-white/3">
                          <Music size={11} className="text-violet-500 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-medium truncate text-zinc-700 dark:text-zinc-300">{t.name}</p>
                            <p className="text-[10px] text-zinc-400">{t.durationSecs.toFixed(1)}s</p>
                          </div>
                          <button onClick={() => removeAudioTrack(t.id)} className="text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent"><X size={11} /></button>
                        </div>
                      ))}
                    </div>
                  ) : audioSrc ? (
                    <div className="flex items-center gap-2 p-2 rounded-lg border border-violet-200/50 dark:border-violet-500/20 bg-violet-50/50 dark:bg-violet-500/5">
                      <Music size={11} className="text-violet-500 shrink-0" />
                      <p className="text-[11px] flex-1 truncate text-zinc-700 dark:text-zinc-300">{audioName}</p>
                      <button onClick={() => { URL.revokeObjectURL(audioSrc); setAudioSrc(null); setAudioName(null); }} className="text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent"><X size={11} /></button>
                    </div>
                  ) : null}

                  {/* Add a background track from this computer. */}
                  <MusicLibraryBrowser onPick={addAudioTrackFile} />

                  <div className="flex items-center gap-2">
                    <Volume2 size={11} className="text-zinc-400 shrink-0" />
                    <input type="range" min={0} max={1} step={0.05} value={audioVol}
                      onChange={e => setAudioVol(parseFloat(e.target.value))}
                      className="flex-1 accent-violet-500" />
                    <span className="text-[10px] text-zinc-400 tabular-nums w-8 text-right">{Math.round(audioVol * 100)}%</span>
                  </div>
                  <div className="flex gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <ToggleSwitch checked={audioFadeIn} onChange={setAudioFadeIn} />
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Fade in</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <ToggleSwitch checked={audioFadeOut} onChange={setAudioFadeOut} />
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Fade out</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* ── Watermark (upcoming — controls hidden for now) ── */}
            <div>
              <div className="flex items-center gap-2 py-1">
                <span className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">Watermark</span>
                <span className="text-[8.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-violet-500/12 text-violet-500 dark:text-violet-400">Upcoming</span>
              </div>
              <p className="text-[10.5px] text-zinc-400 leading-snug">Custom watermarks are coming soon.</p>
            </div>
          </div>

          {/* Generate button */}
          <div className="px-5 py-4 border-t border-zinc-100 dark:border-white/8 shrink-0 space-y-2">
            {genState === "generating" && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400">Rendering…</span>
                  <span className="text-[10px] text-zinc-400 tabular-nums">{Math.round(genProgress)}%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                  <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${genProgress}%` }} />
                </div>
              </div>
            )}

            {genState === "done" && (genBlobUrl || genBlob) && (
              <button
                onClick={async () => {
                  // Already auto-saved to Downloads → reveal it. Otherwise (web build /
                  // save failed) fall back to the native save helper — the webview
                  // ignores `<a download>`, so it can't be a plain link.
                  if (genOutPath) {
                    const { revealLocalExport } = await import("@/lib/local-exports");
                    await revealLocalExport(genOutPath).catch(() => {});
                    return;
                  }
                  if (!genBlob) return;
                  const { saveBlobToDisk } = await import("@/lib/save-file");
                  await saveBlobToDisk(genBlob, "Carousel video.mp4").catch(e => surfaceError(e, { operation: "save video" }));
                }}
                className="flex items-center justify-center gap-2 w-full h-9 rounded-xl text-[13px] font-semibold text-white border-none cursor-pointer transition-all font-[inherit]"
                style={{ background: "linear-gradient(135deg,#22c55e,#16a34a)" }}>
                <Download size={14} /> {genOutPath ? "Show in folder" : "Download Video"}
              </button>
            )}

            <button
              onClick={generate}
              disabled={genState === "generating" || items.length === 0}
              className="w-full h-10 rounded-xl text-[13px] font-bold text-white cursor-pointer border-none transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ background: "linear-gradient(135deg,#3D7EFD,#003AAC)" }}>
              {genState === "generating" ? (
                <><Loader2 size={14} className="animate-spin" /> Rendering…</>
              ) : genState === "done" ? (
                <><CheckCircle2 size={14} /> Re-render</>
              ) : (
                <><Film size={14} /> Generate Video</>
              )}
            </button>
          </div>
        </div>

        {/* ── RIGHT SIDEBAR: layout & template design (toggleable) ── */}
        {rightOpen && (
        <div className="w-88 shrink-0 order-last flex flex-col border-l border-zinc-200 dark:border-white/8 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-white/8 shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-1 h-4 rounded-full bg-violet-500" />
              <h2 className="text-[14px] font-bold text-zinc-900 dark:text-zinc-50">Design</h2>
            </div>
            <button onClick={() => setRightOpen(false)} title="Hide panel"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/8 bg-transparent border-none cursor-pointer transition-colors">
              <X size={15} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto [&>div]:px-5 [&>div]:py-4 [&>div]:border-b [&>div]:border-zinc-100 dark:[&>div]:border-white/8">
            {/* ── Layout Mode ── */}
            <div>
              <SectionTitle>Layout Style</SectionTitle>
              <div className="grid grid-cols-3 gap-1.5 mb-3">
                {LAYOUT_META.map(({ id, label, desc }) => {
                  const active = layoutMode === id;
                  return (
                    <button key={id} onClick={() => setLayoutMode(id)}
                      className="flex flex-col items-center gap-1 p-2 rounded-xl border cursor-pointer transition-all"
                      style={{
                        background: active ? "rgba(61,126,253,0.09)" : "transparent",
                        borderColor: active ? "rgba(61,126,253,0.5)" : "rgba(0,0,0,0.08)",
                      }}>
                      {/* Mini SVG preview */}
                      {id === "fullscreen" && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={40} height={28} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/></svg>}
                      {id === "fan"        && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={4} width={11} height={20} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.5}/><rect x={14} y={0} width={12} height={28} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/><rect x={29} y={4} width={11} height={20} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.5}/></svg>}
                      {id === "split"      && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={21} height={28} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/><rect x={23} y={0} width={17} height={28} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.42}/></svg>}
                      {id === "float"      && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={40} height={28} rx={2} fill={active?"#16101e":"#e4e4e7"}/><ellipse cx={20} cy={14} rx={10} ry={7} fill={active?"#3D7EFD":"rgba(0,0,0,0.08)"} opacity={0.45} filter="url(#g)"/><rect x={5} y={4} width={30} height={20} rx={3} fill={active?"#3D7EFD":"#a1a1aa"}/></svg>}
                      {id === "tilt"       && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={9} y={6} width={24} height={20} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.28} transform="rotate(8 21 16)"/><rect x={7} y={4} width={24} height={21} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.52} transform="rotate(4 19 14)"/><rect x={5} y={1} width={24} height={23} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/></svg>}
                      {id === "tinder"     && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={4} y={1} width={26} height={24} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.35} transform="rotate(-4 17 13)"/><rect x={5} y={2} width={26} height={24} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/><text x={33} y={12} fontSize={9} fill={active?"#ef4444":"#a1a1aa"} fontWeight="900">✕</text></svg>}
                      {id === "filmstrip"  && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={7} width={40} height={14} fill="#111"/><rect x={1} y={8} width={4} height={3} rx={1} fill="#000" opacity={0.7}/><rect x={35} y={8} width={4} height={3} rx={1} fill="#000" opacity={0.7}/><rect x={1} y={17} width={4} height={3} rx={1} fill="#000" opacity={0.7}/><rect x={35} y={17} width={4} height={3} rx={1} fill="#000" opacity={0.7}/><rect x={6} y={8} width={8} height={12} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.5}/><rect x={16} y={7} width={8} height={14} fill={active?"#3D7EFD":"#d4d4d8"}/><rect x={26} y={8} width={8} height={12} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.5}/></svg>}
                      {id === "polaroid"   && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={7} y={1} width={24} height={26} rx={1} fill="#fff" stroke="#e0e0e0" strokeWidth={0.5} transform="rotate(3 19 14)"/><rect x={9} y={3} width={20} height={15} fill={active?"#3D7EFD":"#d4d4d8"} transform="rotate(3 19 10)"/></svg>}
                      {id === "spotlight"  && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={40} height={28} rx={2} fill="#050508"/><polygon points="14,0 26,0 30,14 10,14" fill="rgba(255,255,255,0.07)"/><rect x={8} y={5} width={24} height={18} rx={2} fill={active?"#3D7EFD":"#555"}/></svg>}
                      {id === "story"      && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={40} height={28} rx={2} fill={active?"#16101e":"#1c1c1c"}/><rect x={2} y={2} width={36} height={2} rx={1} fill="rgba(255,255,255,0.25)"/><rect x={2} y={2} width={18} height={2} rx={1} fill="#fff"/><rect x={4} y={7} width={32} height={19} rx={2} fill={active?"#3D7EFD":"#555"}/></svg>}
                      {id === "magazine"   && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={40} height={28} rx={2} fill={active?"#3D7EFD":"#888"}/><rect x={0} y={0} width={40} height={6} rx={0} fill="rgba(0,0,0,0.72)"/><rect x={3} y={19} width={16} height={2} rx={1} fill="#fff" opacity={0.9}/><rect x={3} y={22} width={24} height={4} rx={1} fill="#fff"/></svg>}
                      {id === "vintage"    && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={40} height={28} rx={2} fill={active?"#2a1f15":"#2a1f15"}/><rect x={5} y={4} width={30} height={20} rx={1} fill={active?"#3D7EFD":"#7a6040"}/><rect x={3} y={2} width={34} height={24} rx={2} fill="none" stroke={active?"#c9a55a":"#5a4a30"} strokeWidth={1}/><circle cx={5} cy={4} r={1.2} fill={active?"#c9a55a":"#5a4a30"}/><circle cx={35} cy={4} r={1.2} fill={active?"#c9a55a":"#5a4a30"}/><circle cx={5} cy={24} r={1.2} fill={active?"#c9a55a":"#5a4a30"}/><circle cx={35} cy={24} r={1.2} fill={active?"#c9a55a":"#5a4a30"}/></svg>}
                      {id === "neon-frame" && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={40} height={28} rx={2} fill="#030308"/><rect x={5} y={3} width={30} height={22} rx={2} fill={active?"#3D7EFD":"#444"} opacity={0.7}/><rect x={5} y={3} width={30} height={22} rx={2} fill="none" stroke={active?"#3D7EFD":"#888"} strokeWidth={1.5} filter={active?"url(#glow)":undefined}/><circle cx={5} cy={3} r={1.5} fill={active?"#3D7EFD":"#555"}/><circle cx={35} cy={3} r={1.5} fill={active?"#3D7EFD":"#555"}/><circle cx={5} cy={25} r={1.5} fill={active?"#3D7EFD":"#555"}/><circle cx={35} cy={25} r={1.5} fill={active?"#3D7EFD":"#555"}/></svg>}
                      {id === "gallery"    && <svg width={40} height={28} viewBox="0 0 40 28"><rect x={0} y={0} width={40} height={28} rx={2} fill="#e0dbd4"/><rect x={8} y={4} width={24} height={18} rx={1} fill="#2c1e14"/><rect x={11} y={6.5} width={18} height={13} fill="#f0ece5"/><rect x={13} y={8} width={14} height={9} fill={active?"#3D7EFD":"#aaa"}/><rect x={14} y={22} width={12} height={3} rx={0.5} fill="#f8f4ee"/></svg>}
                      <span className="text-[8.5px] font-bold leading-none text-center" style={{ color: active ? "#3D7EFD" : "#71717a" }}>{label}</span>
                      <span className="text-[7px] leading-none text-center" style={{ color: active ? "#3D7EFD66" : "#a1a1aa" }}>{desc}</span>
                    </button>
                  );
                })}
              </div>

              {/* Fan style sub-picker — only when fan is active */}
              {layoutMode === "fan" && (
                <div className="pt-2 border-t border-zinc-100 dark:border-white/8">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-2">Card Layout</p>
                  <div className="grid grid-cols-5 gap-1.5">
                    {FAN_STYLE_META.map(({ id, label, desc }) => {
                      const active = fanStyle === id;
                      return (
                        <button key={id} onClick={() => setFanStyle(id)}
                          className="flex flex-col items-center gap-1 p-1.5 rounded-lg border cursor-pointer transition-all"
                          style={{
                            background: active ? "rgba(61,126,253,0.10)" : "transparent",
                            borderColor: active ? "rgba(61,126,253,0.5)" : "rgba(0,0,0,0.08)",
                          }}>
                          {id === "trio"  && <svg width={36} height={26} viewBox="0 0 36 26"><rect x={0}  y={3} width={10} height={20} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.5}/><rect x={12} y={0} width={12} height={26} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/><rect x={26} y={3} width={10} height={20} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.5}/></svg>}
                          {id === "duo"   && <svg width={36} height={26} viewBox="0 0 36 26"><rect x={0}  y={0} width={21} height={26} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/><rect x={23} y={3} width={13} height={20} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.55}/></svg>}
                          {id === "solo"  && <svg width={36} height={26} viewBox="0 0 36 26"><rect x={4}  y={0} width={28} height={26} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/></svg>}
                          {id === "peek"  && <svg width={36} height={26} viewBox="0 0 36 26"><rect x={0}  y={4} width={4}  height={18} rx={1} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.4}/><rect x={5}  y={0} width={26} height={26} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/><rect x={32} y={4} width={4}  height={18} rx={1} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.4}/></svg>}
                          {id === "stack" && <svg width={36} height={26} viewBox="0 0 36 26"><rect x={7}  y={4} width={22} height={19} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.3} transform="rotate(5 18 13)"/><rect x={5}  y={2} width={22} height={20} rx={2} fill={active?"#3D7EFD":"#d4d4d8"} opacity={0.5} transform="rotate(2 16 12)"/><rect x={4}  y={0} width={22} height={22} rx={2} fill={active?"#3D7EFD":"#d4d4d8"}/></svg>}
                          <span className="text-[8px] font-semibold leading-none" style={{ color: active ? "#3D7EFD" : "#a1a1aa" }}>{label}</span>
                          <span className="text-[7px] leading-none text-center" style={{ color: active ? "#3D7EFD55" : "#d4d4d8" }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Fine-tune adjustments — collapsible, OFF by default */}
              <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-white/8">
                <SectionTitle collapsed={collapsedSections.has("adjust")} onToggle={() => toggleSection("adjust")}>Adjustments</SectionTitle>
                {!collapsedSections.has("adjust") && (
                <div>
              {/* Card size slider — applies to all layouts */}
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Card Size</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] tabular-nums text-zinc-400">{Math.round(cardScale * 100)}%</span>
                    {cardScale !== 1.0 && (
                      <button onClick={() => setCardScale(1.0)}
                        className="text-[9px] text-violet-500 hover:text-violet-600 cursor-pointer border-none bg-transparent font-semibold leading-none">
                        reset
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-zinc-400 shrink-0">50%</span>
                  <input
                    type="range" min={0.5} max={1.3} step={0.05} value={cardScale}
                    onChange={e => setCardScale(parseFloat(e.target.value))}
                    className="flex-1 accent-violet-500 cursor-pointer"
                  />
                  <span className="text-[9px] text-zinc-400 shrink-0">130%</span>
                </div>
                <div className="flex justify-between px-4 mt-0.5">
                  {[0.6, 0.8, 1.0, 1.2].map(v => (
                    <button key={v} onClick={() => setCardScale(v)}
                      className="text-[9px] tabular-nums cursor-pointer border-none bg-transparent transition-colors"
                      style={{ color: cardScale === v ? "#3D7EFD" : "#a1a1aa" }}>
                      {Math.round(v * 100)}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Image size (zoom) slider — scales the media inside its frame, on
                  top of the fit mode. Works on every layout. */}
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Image Size</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] tabular-nums text-zinc-400">{Math.round(imageZoom * 100)}%</span>
                    {imageZoom !== 1.0 && (
                      <button onClick={() => setImageZoom(1.0)}
                        className="text-[9px] text-violet-500 hover:text-violet-600 cursor-pointer border-none bg-transparent font-semibold leading-none">
                        reset
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-zinc-400 shrink-0">50%</span>
                  <input
                    type="range" min={0.5} max={2} step={0.05} value={imageZoom}
                    onChange={e => setImageZoom(parseFloat(e.target.value))}
                    className="flex-1 accent-violet-500 cursor-pointer"
                  />
                  <span className="text-[9px] text-zinc-400 shrink-0">200%</span>
                </div>
                <div className="flex justify-between px-4 mt-0.5">
                  {[0.75, 1.0, 1.5, 2.0].map(v => (
                    <button key={v} onClick={() => setImageZoom(v)}
                      className="text-[9px] tabular-nums cursor-pointer border-none bg-transparent transition-colors"
                      style={{ color: imageZoom === v ? "#3D7EFD" : "#a1a1aa" }}>
                      {Math.round(v * 100)}%
                    </button>
                  ))}
                </div>
                <p className="text-[9.5px] text-zinc-400 mt-1 leading-snug">Zooms the image inside its frame — pairs with the Fit Mode (contain / cover / blur-fill).</p>
              </div>

              {/* Card radius — rounds the CARD / frame container on every layout. */}
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Card Radius</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] tabular-nums text-zinc-400">{Math.round(cardRadius * 200)}%</span>
                    {cardRadius !== 0 && (
                      <button onClick={() => setCardRadius(0)}
                        className="text-[9px] text-violet-500 hover:text-violet-600 cursor-pointer border-none bg-transparent font-semibold leading-none">
                        reset
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-zinc-400 shrink-0">0</span>
                  <input
                    type="range" min={0} max={0.5} step={0.01} value={cardRadius}
                    onChange={e => setCardRadius(parseFloat(e.target.value))}
                    className="flex-1 accent-violet-500 cursor-pointer"
                  />
                  <span className="text-[9px] text-zinc-400 shrink-0">Round</span>
                </div>
                <p className="text-[9.5px] text-zinc-400 mt-1 leading-snug">Rounds the card/frame corners.</p>
              </div>

              {/* Image radius — rounds the MEDIA itself (inside the card). */}
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Image Radius</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] tabular-nums text-zinc-400">{Math.round(imageRadius * 200)}%</span>
                    {imageRadius !== 0 && (
                      <button onClick={() => setImageRadius(0)}
                        className="text-[9px] text-violet-500 hover:text-violet-600 cursor-pointer border-none bg-transparent font-semibold leading-none">
                        reset
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-zinc-400 shrink-0">0</span>
                  <input
                    type="range" min={0} max={0.5} step={0.01} value={imageRadius}
                    onChange={e => setImageRadius(parseFloat(e.target.value))}
                    className="flex-1 accent-violet-500 cursor-pointer"
                  />
                  <span className="text-[9px] text-zinc-400 shrink-0">Round</span>
                </div>
                <p className="text-[9.5px] text-zinc-400 mt-1 leading-snug">Rounds the image itself — visible with contain / smaller Image Size.</p>
              </div>
                </div>
                )}
              </div>
            </div>

            {/* ── Slide Template ── */}
            <div>
              <SectionTitle collapsed={collapsedSections.has("template")} onToggle={() => toggleSection("template")}>Slide Template</SectionTitle>
              {!collapsedSections.has("template") && <>

              {/* Template picker */}
              <div className="grid grid-cols-4 gap-1.5 mb-4">
                {(["none", "lower-third", "big-title", "typewriter", "neon", "glitch-fx", "film", "lines"] as SlideTemplate[]).map(t => {
                  const active = template === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setTemplate(t)}
                      className="flex flex-col items-center gap-1.5 p-1.5 rounded-lg border cursor-pointer transition-all"
                      style={{
                        background: active ? "rgba(61,126,253,0.08)" : "transparent",
                        borderColor: active ? "rgba(61,126,253,0.45)" : "rgba(0,0,0,0.08)",
                      }}
                    >
                      <TemplateMiniPreview style={t} active={active} />
                      <span className="text-[8.5px] font-semibold leading-none text-center"
                        style={{ color: active ? "#3D7EFD" : "rgba(0,0,0,0.4)" }}>
                        {TEMPLATE_LABELS[t]}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Template config fields — always visible */}
              <div className="space-y-2.5 pt-2 border-t border-zinc-100 dark:border-white/8">
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-1">
                    {layoutMode === "story"    ? "Handle / Username" :
                     layoutMode === "magazine" ? "Magazine Name" :
                     layoutMode === "gallery"  ? "Caption / Title" :
                     layoutMode === "vintage"  ? "Caption" :
                     layoutMode === "polaroid" ? "Bottom Text" :
                     template === "lower-third" ? "Name / Title" :
                     template === "typewriter"  ? "Body Text" : "Main Text"}
                  </label>
                  <input
                    value={templateCfg.line1}
                    onChange={e => patchCfg({ line1: e.target.value })}
                    placeholder={
                      layoutMode === "story"    ? "your_handle" :
                      layoutMode === "magazine" ? "MAGAZINE" :
                      layoutMode === "gallery"  ? "Slide title" :
                      layoutMode === "vintage"  ? "◆ caption ◆" :
                      layoutMode === "polaroid" ? "Caption text" :
                      template === "lower-third" ? "Your Name" :
                      template === "typewriter"  ? "Your text appears here..." :
                      template === "film"        ? "Location or scene title" :
                      "Main text"
                    }
                    className={inputCls()}
                  />
                </div>
                {layoutMode !== "vintage" && layoutMode !== "polaroid" && template !== "film" && (
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-1">
                      {layoutMode === "story"    ? "Subtitle" :
                       layoutMode === "magazine" ? "Headline" :
                       layoutMode === "gallery"  ? "Medium / Year" :
                       template === "lower-third" ? "Role / Tag" : "Subtitle / Tag"}
                    </label>
                    <input
                      value={templateCfg.line2}
                      onChange={e => patchCfg({ line2: e.target.value })}
                      placeholder={
                        layoutMode === "magazine" ? "Your story headline here" :
                        layoutMode === "gallery"  ? "Oil on canvas, 2024" :
                        template === "lower-third" ? "Director · Creator" : "Optional subtitle"
                      }
                      className={inputCls()}
                    />
                  </div>
                )}
                <div>
                  <FieldLabel>Accent Color</FieldLabel>
                  <div className="flex items-center gap-2">
                    <ColorButton value={templateCfg.accentColor} onChange={v => patchCfg({ accentColor: v })} size={36} />
                    <input
                      type="text" value={templateCfg.accentColor} maxLength={7}
                      onChange={e => patchCfg({ accentColor: e.target.value })}
                      className={inputCls("flex-1 h-9 font-mono text-[11px]")}
                    />
                  </div>
                </div>
              </div>
              </>}
            </div>

          </div>
        </div>
        )}

        {/* ── RIGHT: preview ── */}
        <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Reopen the Design sidebar when hidden */}
          {!rightOpen && (
            <button onClick={() => setRightOpen(true)} title="Show design panel"
              className="absolute top-3 right-3 z-10 flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold text-violet-600 dark:text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/25 cursor-pointer transition-colors">
              <span className="w-1 h-3.5 rounded-full bg-violet-500" /> Design
            </button>
          )}
          <div className="flex-1 flex items-center justify-center p-6">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "rgba(61,126,253,0.08)" }}>
                  <Film size={28} className="text-violet-500/60" />
                </div>
                <div>
                  <p className="text-[15px] font-semibold text-zinc-400 dark:text-zinc-500 mb-1">No media added</p>
                  <p className="text-[12px] text-zinc-400 dark:text-zinc-600">Upload images or videos to preview your carousel</p>
                </div>
              </div>
            ) : (
              <div className="relative flex items-center justify-center w-full h-full">
                <CarouselCanvasPreview
                  key={`${layoutMode}:${previewEpoch}`}
                  ref={canvasPreviewRef}
                  params={previewParams}
                  totalFrames={totalFrames}
                  maxHeight={600}
                  onError={onPreviewError}
                />
                {previewError && (
                  <PreviewErrorCard
                    error={previewError.error}
                    operation="carousel-preview"
                    onRetry={retryPreview}
                  />
                )}
              </div>
            )}
          </div>

          {/* Status bar */}
          <div className="h-10 px-5 border-t border-zinc-100 dark:border-white/8 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-zinc-400">{transition} · {(xfade / FPS * 1000).toFixed(0)}ms transition</span>
              <span className="text-[11px] text-zinc-300 dark:text-zinc-600">·</span>
              <span className="text-[11px] text-zinc-400">{compW}×{compH} · {FPS}fps</span>
            </div>
            <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
              {(currentFrame / FPS).toFixed(2)}s / {totalSeconds}s
            </span>
          </div>
        </div>
        </div>
      </div>
    </AppLayout>
  );
}
