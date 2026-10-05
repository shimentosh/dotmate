"use client";
import { useEffect, useRef, useState } from "react";
import { Minus, Maximize2 } from "lucide-react";

/* ─── Floating settings panel ────────────────────────────────────────────────
   A compact, Figma/Illustrator-style panel that floats over a tool's canvas:
   drag it by the header, double-click the header (or hit the button) to
   minimize. Bounds are clamped to `boundsRef` so it can't be dragged out of the
   canvas. Originally built for Quick Trim; shared across the Tools pages so the
   floating-settings layout stays identical (import, don't re-copy). */
export function FloatingPanel({
  title,
  icon: Icon,
  boundsRef,
  width = 240,
  children,
}: {
  title: string;
  icon: React.ElementType;
  boundsRef: React.RefObject<HTMLElement | null>;
  width?: number;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [min, setMin] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Initial spot: top-right of the canvas, with a small margin.
  useEffect(() => {
    if (pos || !boundsRef.current) return;
    const r = boundsRef.current.getBoundingClientRect();
    setPos({ x: Math.max(12, r.width - width - 18), y: 16 });
  }, [pos, boundsRef, width]);

  // Keep the panel inside the canvas when the window/canvas is resized smaller —
  // otherwise it stays at its old x and gets clipped off the right edge.
  useEffect(() => {
    const bounds = boundsRef.current;
    if (!bounds) return;
    const clamp = () => {
      const b = bounds.getBoundingClientRect();
      const ph = panelRef.current?.getBoundingClientRect().height ?? 44;
      const maxX = Math.max(8, b.width - width - 8);
      const maxY = Math.max(8, b.height - Math.min(ph, 44)); // keep the header reachable
      setPos(p => {
        if (!p) return p;
        const x = Math.min(Math.max(8, p.x), maxX);
        const y = Math.min(Math.max(8, p.y), maxY);
        return x === p.x && y === p.y ? p : { x, y };
      });
    };
    const ro = new ResizeObserver(clamp);
    ro.observe(bounds);
    window.addEventListener("resize", clamp);
    return () => { ro.disconnect(); window.removeEventListener("resize", clamp); };
  }, [boundsRef, width]);

  function onHeaderDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const panel = panelRef.current, bounds = boundsRef.current;
    if (!panel || !bounds) return;
    const pr = panel.getBoundingClientRect();
    const offX = e.clientX - pr.left, offY = e.clientY - pr.top;
    const onMove = (ev: MouseEvent) => {
      const b = bounds.getBoundingClientRect();
      const ph = panel.getBoundingClientRect().height;
      const x = Math.max(8, Math.min(ev.clientX - b.left - offX, b.width - width - 8));
      const y = Math.max(8, Math.min(ev.clientY - b.top - offY, b.height - Math.min(ph, 44)));
      setPos({ x, y });
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  }

  if (!pos) return null;

  return (
    <div
      ref={panelRef}
      style={{ left: pos.x, top: pos.y, width }}
      className="absolute z-30 rounded-xl border border-zinc-200/70 dark:border-white/10 bg-white/75 dark:bg-zinc-900/70 backdrop-blur-2xl shadow-[0_18px_50px_-12px_rgba(0,0,0,0.5)] overflow-hidden select-none"
    >
      {/* Header — drag handle */}
      <div
        onMouseDown={onHeaderDown}
        onDoubleClick={() => setMin(m => !m)}
        className="flex items-center gap-1.5 h-8 pl-2.5 pr-1 cursor-grab active:cursor-grabbing border-b border-zinc-200/60 dark:border-white/8 bg-zinc-50/70 dark:bg-white/[0.04]"
      >
        <Icon size={11} className="text-violet-500 shrink-0" />
        <span className="flex-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400 truncate">{title}</span>
        <button
          onClick={() => setMin(m => !m)}
          title={min ? "Expand" : "Minimize"}
          className="w-5.5 h-5.5 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-white/10 transition-colors cursor-pointer border-none bg-transparent shrink-0"
        >
          {min ? <Maximize2 size={10} /> : <Minus size={11} />}
        </button>
      </div>
      {!min && <div className="p-2.5 max-h-[70vh] overflow-y-auto">{children}</div>}
    </div>
  );
}

/* Compact input style for controls living inside a FloatingPanel — translucent
   fill that sits on the glass card rather than a hard solid block. Shared so
   every tool's floating-panel inputs match Quick Trim. */
export const PANEL_INPUT =
  "w-full h-7 px-2.5 rounded-lg text-[12px] outline-none bg-zinc-100/80 dark:bg-white/[0.05] border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/10 transition-all [color-scheme:light] dark:[color-scheme:dark] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none";
