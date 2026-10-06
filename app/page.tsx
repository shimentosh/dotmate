"use client";
import { useMemo, useState } from "react";
import { LayoutGrid, SearchX } from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { ToolGrid, SectionHeading, UTILITY_TOOLS, STUDIO_TOOLS, type GalleryTool } from "@/components/tool-gallery";
import { HomeHero, RequestToolButton } from "@/components/home-connect";
import { brand } from "@/brand.config";

/** Every word of the query must appear in the tool's name, description or tags. */
function matches(tool: GalleryTool, words: string[]): boolean {
  const hay = `${tool.name} ${tool.desc} ${tool.cat} ${tool.badge ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export default function HomePage() {
  const [query, setQuery] = useState("");
  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searching = words.length > 0;
  const results = useMemo(
    () => (searching ? [...STUDIO_TOOLS, ...UTILITY_TOOLS].filter((t) => matches(t, words)) : []),
    [searching, words],
  );

  return (
    <AppLayout>
      <div className="min-h-full">
        <div className="w-full max-w-[1360px] mx-auto px-6 lg:px-10 pt-8 lg:pt-10 pb-16">
          <HomeHero
            icon={LayoutGrid}
            title={brand.name}
            description={brand.tagline}
            chips={[
              { value: UTILITY_TOOLS.length + STUDIO_TOOLS.length, label: "tools" },
              { label: "No account" },
              { label: "Runs on this computer" },
            ]}
            query={query}
            onQuery={setQuery}
          />

          {searching ? (
            <section aria-labelledby="home-results" aria-live="polite">
              <SectionHeading id="home-results" title="Results" hint={`for “${query.trim()}”`} count={results.length} />
              {results.length > 0 ? (
                <ToolGrid tools={results} />
              ) : (
                <div className="flex flex-col items-center text-center gap-3 py-14 px-6 rounded-xl border border-dashed border-zinc-300 dark:border-white/10 bg-surface">
                  <span className="w-11 h-11 rounded-xl flex items-center justify-center bg-surface-muted text-zinc-400">
                    <SearchX size={19} />
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">No tool matches “{query.trim()}”</p>
                    <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400 max-w-sm">
                      Need it? Request it and it may land in a future update.
                    </p>
                  </div>
                  <RequestToolButton query={query} />
                </div>
              )}
            </section>
          ) : (
            <>
              <section aria-labelledby="home-create">
                <SectionHeading id="home-create" title="Create" hint="Write, voice and assemble videos" count={STUDIO_TOOLS.length} />
                <ToolGrid tools={STUDIO_TOOLS} />
              </section>

              <section aria-labelledby="home-utilities" className="mt-10">
                <SectionHeading id="home-utilities" title="Utilities" hint="Trim, merge, shuffle and download" count={UTILITY_TOOLS.length} />
                <ToolGrid tools={UTILITY_TOOLS} />
              </section>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
