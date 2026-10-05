"use client";
import { useRef } from "react";
import { ColorButton } from "@/components/editor/paint-picker";
import { Upload, X, Type, Image as ImgIcon } from "lucide-react";
import { FieldLabel, inputCls } from "./ui";
import { FontSelect } from "@/components/ui/font-select";

export type WMPos =
  | "top-left" | "top-center" | "top-right"
  | "mid-left" | "center" | "mid-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

export type WMType = "text" | "image";

export interface WatermarkCfg {
  enabled: boolean;
  type: WMType;
  text: string;
  font: string;
  fontSize: number;
  fontWeight: string;
  color: string;
  opacity: number;
  position: WMPos;
  imageUrl: string | null;
  logoSize: number;
  borderRadius: number;
}

export const DEFAULT_WATERMARK: WatermarkCfg = {
  enabled: false,
  type: "text",
  text: "",
  font: "Arial",
  fontSize: 36,
  fontWeight: "700",
  color: "#ffffff",
  opacity: 0.85,
  position: "bottom-right",
  imageUrl: null,
  logoSize: 120,
  borderRadius: 0,
};

const WM_POSITIONS: WMPos[] = [
  "top-left", "top-center", "top-right",
  "mid-left", "center", "mid-right",
  "bottom-left", "bottom-center", "bottom-right",
];

const POS_ICON: Record<WMPos, string> = {
  "top-left": "↖", "top-center": "↑", "top-right": "↗",
  "mid-left": "←", "center": "·",    "mid-right": "→",
  "bottom-left": "↙", "bottom-center": "↓", "bottom-right": "↘",
};

const FONT_WEIGHTS = [
  ["100", "Thin"], ["300", "Light"], ["400", "Regular"], ["500", "Medium"],
  ["600", "SemiBold"], ["700", "Bold"], ["800", "ExtraBold"], ["900", "Black"],
] as const;

interface WatermarkSettingsProps {
  value: WatermarkCfg;
  onChange: (updater: (prev: WatermarkCfg) => WatermarkCfg) => void;
}

export function WatermarkSettings({ value: wm, onChange: setWm }: WatermarkSettingsProps) {
  const wmImgInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-3">
      {/* Type toggle */}
      <div className="flex rounded-lg border border-zinc-200 dark:border-white/10 overflow-hidden">
        {(["text", "image"] as WMType[]).map(t => (
          <button
            key={t}
            onClick={() => setWm(w => ({ ...w, type: t }))}
            className="flex-1 h-8 text-[12px] font-semibold cursor-pointer border-none transition-colors"
            style={{
              background: wm.type === t ? "rgba(0,87,252,0.1)" : "transparent",
              color: wm.type === t ? "#0057FC" : undefined,
            }}
          >
            {t === "text"
              ? <span className="flex items-center justify-center gap-1"><Type size={11} /> Text</span>
              : <span className="flex items-center justify-center gap-1"><ImgIcon size={11} /> Logo</span>}
          </button>
        ))}
      </div>

      {wm.type === "text" ? (
        <div className="space-y-2">
          <input
            value={wm.text}
            onChange={e => setWm(w => ({ ...w, text: e.target.value }))}
            placeholder="Your watermark text"
            className={inputCls()}
          />
          <div>
            <FieldLabel>Font</FieldLabel>
            <FontSelect value={wm.font} onChange={font => setWm(w => ({ ...w, font }))} dropUp />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>Size (px)</FieldLabel>
              <input
                type="number" min={12} max={120} value={wm.fontSize}
                onChange={e => setWm(w => ({ ...w, fontSize: parseInt(e.target.value) || 36 }))}
                className={inputCls("h-8 text-[12px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")}
              />
            </div>
            <div>
              <FieldLabel>Weight</FieldLabel>
              <select
                value={wm.fontWeight}
                onChange={e => setWm(w => ({ ...w, fontWeight: e.target.value }))}
                className={inputCls("h-8 text-[12px]")}
              >
                {FONT_WEIGHTS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>
          {/* Color + Opacity share a 2-col row (mirrors the Size / Weight grid
              above). Both cells get min-w-0 — grid items default to
              min-width:auto, and a range input has an intrinsic min-width — so
              without it the opacity slider would overflow its column and clip. */}
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <FieldLabel>Color</FieldLabel>
              <div className="flex gap-2">
                <ColorButton value={wm.color} onChange={v => setWm(w => ({ ...w, color: v }))} size={36} />
                <input
                  type="text" value={wm.color} maxLength={7}
                  onChange={e => setWm(w => ({ ...w, color: e.target.value }))}
                  className={inputCls("flex-1 min-w-0 h-9")}
                />
              </div>
            </div>
            <div className="min-w-0">
              <FieldLabel>Opacity</FieldLabel>
              <div className="flex items-center gap-2 h-9">
                <input
                  type="range" min={0.1} max={1} step={0.05} value={wm.opacity}
                  onChange={e => setWm(w => ({ ...w, opacity: parseFloat(e.target.value) }))}
                  className="flex-1 min-w-0 accent-violet-500"
                />
                <span className="text-[11px] text-zinc-400 w-9 text-right tabular-nums shrink-0">{Math.round(wm.opacity * 100)}%</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div>
          {!wm.imageUrl ? (
            <label className="flex items-center gap-2 h-10 px-3 rounded-lg border border-dashed border-zinc-200 dark:border-white/10 cursor-pointer hover:bg-zinc-50 dark:hover:bg-white/3 transition-colors">
              <input
                type="file" accept="image/*" ref={wmImgInputRef} className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) setWm(w => ({ ...w, imageUrl: URL.createObjectURL(f) }));
                }}
              />
              <Upload size={13} className="text-zinc-400" />
              <span className="text-[12px] text-zinc-500">Upload logo / image</span>
            </label>
          ) : (
            <div className="flex items-center gap-2 p-2 rounded-lg border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={wm.imageUrl} alt="watermark" className="w-10 h-10 object-contain rounded" />
              <span className="text-[11px] text-zinc-500 flex-1">Logo uploaded</span>
              <button
                onClick={() => setWm(w => ({ ...w, imageUrl: null }))}
                className="text-zinc-400 hover:text-red-500 cursor-pointer border-none bg-transparent transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          )}
          <div className="mt-2 space-y-2">
            {([
              { label: "Size",    min: 40,  max: 400, step: 10,   value: wm.logoSize,     unit: "px", display: wm.logoSize,                      onVal: (v: number) => setWm(w => ({ ...w, logoSize: v })) },
              { label: "Radius",  min: 0,   max: 200, step: 2,    value: wm.borderRadius, unit: "px", display: wm.borderRadius,                   onVal: (v: number) => setWm(w => ({ ...w, borderRadius: v })) },
              { label: "Opacity", min: 0.1, max: 1,   step: 0.05, value: wm.opacity,      unit: "%",  display: Math.round(wm.opacity * 100),       onVal: (v: number) => setWm(w => ({ ...w, opacity: v })) },
            ] as const).map(({ label, min, max, step, value, unit, display, onVal }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 font-medium w-12 shrink-0">{label}</span>
                <input
                  type="range" min={min} max={max} step={step} value={value}
                  onChange={e => onVal(parseFloat(e.target.value))}
                  className="flex-1 accent-violet-500"
                />
                <span className="text-[10px] text-zinc-400 w-10 tabular-nums text-right">
                  {display}{unit}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Position grid */}
      <div>
        <FieldLabel>Position</FieldLabel>
        <div className="grid grid-cols-3 gap-1">
          {WM_POSITIONS.map(p => (
            <button
              key={p}
              onClick={() => setWm(w => ({ ...w, position: p }))}
              className="h-7 rounded-md border text-[10px] cursor-pointer transition-all"
              style={{
                background:   wm.position === p ? "rgba(0,87,252,0.12)" : "transparent",
                borderColor:  wm.position === p ? "rgba(0,87,252,0.4)"  : "rgba(0,0,0,0.08)",
                color:        wm.position === p ? "#0057FC" : undefined,
              }}
            >
              {POS_ICON[p]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
