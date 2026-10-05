import type { NextConfig } from "next";

// The UI is always built as a fully static export (`out/`), which the Tauri
// desktop shell bundles directly (`frontendDist: "../out"`). There is no Node
// server, no API routes and no middleware — every tool runs on this machine.
const nextConfig: NextConfig = {
  output: "export",
  // Static export can't optimize images on the fly — serve them as-is.
  images: { unoptimized: true },
};

export default nextConfig;
