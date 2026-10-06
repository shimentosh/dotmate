"use client";
import { Wand2 } from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { PageHero } from "@/components/page-hero";
import { ToolGrid, UTILITY_TOOLS } from "@/components/tool-gallery";

export default function ToolsPage() {
  return (
    <AppLayout>
      <div className="min-h-full">
        <div className="w-full max-w-[1360px] mx-auto px-6 lg:px-10 pt-8 lg:pt-10 pb-16">
          <PageHero
            title="Media"
            accent="Tools"
            icon={Wand2}
            description="Standalone tools for every step — trim, merge, shuffle, download and voice your video content."
            chips={[{ value: UTILITY_TOOLS.length, label: "tools" }]}
          />
          <ToolGrid tools={UTILITY_TOOLS} />
        </div>
      </div>
    </AppLayout>
  );
}
