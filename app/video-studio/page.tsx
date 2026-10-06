"use client";
import { Video } from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { PageHero } from "@/components/page-hero";
import { ToolGrid, STUDIO_TOOLS } from "@/components/tool-gallery";

export default function VideoStudioPage() {
  return (
    <AppLayout>
      <div className="min-h-full">
        <div className="w-full max-w-[1360px] mx-auto px-6 lg:px-10 pt-8 lg:pt-10 pb-16">
          <PageHero
            title="Video"
            accent="Studio"
            icon={Video}
            description="Write, voice, transcribe and assemble — every tool here runs on this computer."
            chips={[{ value: STUDIO_TOOLS.length, label: "tools" }]}
          />
          <ToolGrid tools={STUDIO_TOOLS} />
        </div>
      </div>
    </AppLayout>
  );
}
