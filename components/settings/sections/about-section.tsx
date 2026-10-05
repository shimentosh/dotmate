"use client";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { SettingsHeader } from "../settings-header";
import { BrandMark } from "@/components/brand-mark";
import { DevelopedBy } from "@/components/developed-by";
import { THIRD_PARTY_NOTICES, type Notice } from "@/lib/third-party-notices";
import { openExternal } from "@/lib/open-external";
import { logDebug } from "@/lib/log";
import { brand } from "@/brand.config";

const GROUPS: { key: Notice["delivery"]; label: string }[] = [
  { key: "bundled", label: "Included in the app" },
  { key: "downloaded at runtime", label: "Downloaded on demand from the original publisher" },
  { key: "user-installed", label: "Used if you install them yourself" },
];

export default function AboutPage() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch((e) => logDebug("about", "could not read app version", e));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SettingsHeader title="About" subtitle="Version, support and third-party notices." />

      <div className="rounded-2xl border border-zinc-200 dark:border-white/8 glass-card px-5 py-4 flex items-center gap-4">
        <BrandMark size={40} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">{brand.name}</p>
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{brand.tagline}</p>
          {version && <p className="text-[11px] text-zinc-400 mt-0.5 tabular-nums">Version {version}</p>}
        </div>
        {brand.supportUrl && (
          <button
            onClick={() => void openExternal(brand.supportUrl)}
            className="h-8 px-3.5 rounded-lg text-[12px] font-medium cursor-pointer transition-all flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-white/10 bg-transparent hover:bg-zinc-50 dark:hover:bg-white/5"
          >
            Support <ExternalLink size={12} />
          </button>
        )}
      </div>

      <DevelopedBy variant="card" />

      <div>
        <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-400 mb-2">Third-party notices</p>
        <p className="text-[12px] text-zinc-500 dark:text-zinc-400 leading-relaxed mb-3">
          {brand.name} is built on the open-source components below. Their licences apply to
          those components; the full notices ship in THIRD_PARTY_NOTICES.md with the source.
        </p>
        <div className="flex flex-col gap-4">
          {GROUPS.map(({ key, label }) => (
            <div key={key} className="rounded-xl border border-zinc-200 dark:border-white/8 overflow-hidden">
              <p className="px-4 py-2 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-white/[0.03] border-b border-zinc-100 dark:border-white/6">{label}</p>
              <div className="divide-y divide-zinc-100 dark:divide-white/5">
                {THIRD_PARTY_NOTICES.filter((n) => n.delivery === key).map((n) => (
                  <button
                    key={n.name}
                    onClick={() => void openExternal(n.url)}
                    className="w-full flex items-center gap-3 px-4 py-2 text-left bg-transparent border-none cursor-pointer hover:bg-zinc-50 dark:hover:bg-white/[0.03] transition-colors"
                  >
                    <span className="flex-1 min-w-0 text-[12.5px] text-zinc-700 dark:text-zinc-200 truncate">{n.name}</span>
                    <span className="shrink-0 max-w-[45%] text-right text-[11px] text-zinc-400 truncate">{n.license}</span>
                    <ExternalLink size={11} className="shrink-0 text-zinc-300 dark:text-zinc-600" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
