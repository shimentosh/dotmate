// Build the fully static frontend (`next build` with output:"export" → ./out),
// which the Tauri shell bundles as `frontendDist`. No server, no baked URLs.
//
// A previous dev/build run can leave generated route types in .next/types that
// reference routes which no longer exist; clear them so the build's typecheck
// only sees the current route set.
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

for (const d of [".next/types", ".next/dev/types"]) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* not present */ }
}
execSync("next build", { stdio: "inherit" });
