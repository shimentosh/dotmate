"use client";
import { LayoutGrid } from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { PageHero } from "@/components/page-hero";
import { ToolGrid, UTILITY_TOOLS, STUDIO_TOOLS } from "@/components/tool-gallery";
import { brand } from "@/brand.config";

export default function HomePage() {
  return (
    <AppLayout>
      <div className="min-h-full">
        <div className="w-full px-8 pt-10 pb-20">
          <PageHero
            accent={brand.name}
            icon={LayoutGrid}
            description={brand.tagline}
            chips={[
              { value: UTILITY_TOOLS.length + STUDIO_TOOLS.length, label: "tools" },
              { label: "No account" },
              { label: "Runs on this computer" },
            ]}
          />

          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500 mb-3">Create</p>
          <ToolGrid tools={STUDIO_TOOLS} />

          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500 mt-10 mb-3">Utilities</p>
          <ToolGrid tools={UTILITY_TOOLS} />
        </div>
      </div>
    </AppLayout>
  );
}
