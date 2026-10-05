"use client";
import { FileText } from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import ScriptWriterTool from "@/components/tools/script-writer-tool";

export default function ScriptWriterPage() {
  return (
    <AppLayout>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <StudioToolHeader
          icon={FileText}
          title="Script Writer"
          accent="#0057FC"
          backHref="/video-studio"
          backLabel="Video Studio"
          description="Generate full faceless video scripts with your local AI — tune tone, structure, and length."
        />

        {/* Tool fills the remaining height */}
        <div className="flex-1 min-h-0 flex">
          <ScriptWriterTool />
        </div>
      </div>
    </AppLayout>
  );
}
