import type { Metadata } from "next";
import "./globals.css";
import { AppInit } from "@/components/app-init";
import { DisableZoom } from "@/components/disable-zoom";
import { DisableContextMenu } from "@/components/disable-context-menu";
import { BrandMark } from "@/components/brand-mark";
import { NavGuardProvider } from "@/contexts/nav-guard-context";
import { ErrorBoundary } from "@/components/error-boundary";
import { RenderDock } from "@/components/render-dock";
import { RenderGuard } from "@/components/render-guard";
import { FirstRunGate } from "@/components/first-run-gate";
import { Toaster } from "@/components/toaster";
import { brand } from "@/brand.config";

export const metadata: Metadata = {
  title: brand.name,
  description: brand.tagline,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets the theme class before the UI shows (no flash). Must be `async src`
            — React 19 treats an async external script as a hoistable resource and
            runs it; an inline script would be reconciled on the client instead. */}
        <script async src="/theme-init.js" />
      </head>
      <body className="app-native" suppressHydrationWarning>
        {/* Splash — part of the static HTML so it paints immediately; AppInit
            fades it out once the app has mounted. Always dark. */}
        <div
          id="app-splash"
          style={{
            position: "fixed", inset: 0, zIndex: 99999,
            background: "radial-gradient(120% 90% at 50% 42%, #0e1426 0%, #0d0d0f 62%)",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: "24px",
            transition: "opacity 0.5s ease",
          }}
        >
          <div style={{ position: "relative", display: "grid", placeItems: "center" }}>
            <div className="app-splash-glow" />
            <div className="app-splash-logo">
              <BrandMark size={78} tone="light" />
            </div>
          </div>
          <div style={{ textAlign: "center", position: "relative" }}>
            <div style={{
              fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif",
              fontSize: 27, fontWeight: 800, letterSpacing: "-0.03em",
              color: "#fff", lineHeight: 1,
            }}>
              {brand.name}
            </div>
          </div>
          <div className="app-splash-bar" aria-hidden="true">
            <span className="app-splash-bar-fill" />
          </div>
          <div style={{
            position: "absolute", left: 0, right: 0, bottom: 28,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 7, opacity: 0.75,
          }}>
            <span style={{
              fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif", fontSize: 9.5, fontWeight: 600,
              letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)",
            }}>
              Developed by
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element -- static export */}
            <img src={brand.developer.logoOnDark} alt={brand.developer.name} style={{ height: 15, width: "auto" }} />
          </div>
        </div>

        <AppInit />
        <DisableZoom />
        {/* Kills the WebView's default right-click menu in production builds. */}
        <DisableContextMenu />
        <FirstRunGate />
        {/* Warns before a navigation would terminate a running task. */}
        <NavGuardProvider>
          <ErrorBoundary label="app">{children}</ErrorBoundary>
        </NavGuardProvider>
        {/* Floating render progress — survives page navigation. */}
        <RenderDock />
        <RenderGuard />
        <Toaster />
      </body>
    </html>
  );
}
