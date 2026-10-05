"use client";
import { FieldLabel } from "./ui";

interface ColorAdjustProps {
  brightness: number;
  onBrightnessChange: (v: number) => void;
  saturation: number;
  onSaturationChange: (v: number) => void;
}

export function ColorAdjustSection({
  brightness,
  onBrightnessChange,
  saturation,
  onSaturationChange,
}: ColorAdjustProps) {
  return (
    <div className="space-y-3">
      {/* Brightness */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <FieldLabel>Brightness</FieldLabel>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-zinc-400 tabular-nums w-8 text-right">{brightness}%</span>
            {brightness !== 100 && (
              <button
                onClick={() => onBrightnessChange(100)}
                className="text-[9px] text-violet-500 hover:text-violet-600 cursor-pointer border-none bg-transparent leading-none font-semibold ml-1"
              >
                reset
              </button>
            )}
          </div>
        </div>
        <input
          type="range" min={0} max={200} step={1} value={brightness}
          onChange={e => onBrightnessChange(parseInt(e.target.value))}
          className="w-full accent-violet-500 cursor-pointer"
        />
      </div>

      {/* Saturation */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <FieldLabel>Saturation</FieldLabel>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-zinc-400 tabular-nums w-8 text-right">{saturation}%</span>
            {saturation !== 100 && (
              <button
                onClick={() => onSaturationChange(100)}
                className="text-[9px] text-violet-500 hover:text-violet-600 cursor-pointer border-none bg-transparent leading-none font-semibold ml-1"
              >
                reset
              </button>
            )}
          </div>
        </div>
        <input
          type="range" min={0} max={200} step={1} value={saturation}
          onChange={e => onSaturationChange(parseInt(e.target.value))}
          className="w-full accent-violet-500 cursor-pointer"
        />
      </div>
    </div>
  );
}
