#!/usr/bin/env node
/**
 * VENDOR-ONLY helper (optional Supertonic voices — see README "Supertonic").
 *
 * Fetches the Supertonic 3 model assets into `src-tauri/supertonic-staging/`
 * (gitignored) so `pack-supertonic-archive.sh` can pack them into the single
 * `.tar.gz` the app downloads on first use. Layout the Rust engine expects:
 *
 *     supertonic-staging/
 *     ├── onnx/{tts.json, unicode_indexer.json, duration_predictor.onnx,
 *     │         text_encoder.onnx, vector_estimator.onnx, vocoder.onnx}
 *     ├── voice_styles/{F1..F5,M1..M5}.json
 *     └── onnxruntime.dll   (Windows ONNX Runtime matching the resolved `ort`
 *                            version — see Cargo.lock; ort 2.0.0-rc.12 ↔ ORT ~1.22)
 *
 * Run once on the build machine:
 *
 *     node src-tauri/scripts/fetch-supertonic-assets.mjs
 *
 * It mirrors the `onnx/` + `voice_styles/` trees from the HuggingFace repo
 * `Supertone/supertonic-3` (config is MIT, weights OpenRAIL-M — keep the licence).
 * Already-present files are skipped, so re-runs are cheap and resumable.
 *
 * The ONNX Runtime shared library (`onnxruntime.dll` on Windows) is NOT fetched
 * here — its release asset name is platform/arch-specific. Drop the build that
 * matches the `ort` version our crate resolves (see the README) next to the
 * mirrored assets, or set ONNXRUNTIME_DLL_URL to a direct download URL.
 *
 * No external deps — uses Node 18+ global fetch.
 */
import { mkdir, stat, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HF_REPO = process.env.SUPERTONIC_HF_REPO || "Supertone/supertonic-3";
const HF_REV = process.env.SUPERTONIC_HF_REV || "main";
const DLL_URL = process.env.ONNXRUNTIME_DLL_URL || "";

const here = dirname(fileURLToPath(import.meta.url));
const DEST = resolve(here, "..", "supertonic-staging");

// Only mirror the directories the engine reads — skip everything else in the repo
// (sample audio, READMEs, python code, etc.).
const KEEP_PREFIXES = ["onnx/", "voice_styles/"];
// …plus these top-level config files if the repo keeps them at the root.
const KEEP_ROOT = new Set(["tts.json", "unicode_indexer.json"]);

const treeUrl = `https://huggingface.co/api/models/${HF_REPO}/tree/${HF_REV}?recursive=true`;
const resolveUrl = (p) =>
  `https://huggingface.co/${HF_REPO}/resolve/${HF_REV}/${p.split("/").map(encodeURIComponent).join("/")}`;

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function download(url, outPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(outPath), { recursive: true });
  const part = `${outPath}.part`;
  await writeFile(part, buf);
  await rename(part, outPath); // atomic — a half-written file never looks complete
  return buf.length;
}

function wanted(path) {
  if (KEEP_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (!path.includes("/") && KEEP_ROOT.has(path)) return true;
  return false;
}

async function main() {
  console.log(`Supertonic assets → ${DEST}`);
  console.log(`Listing ${HF_REPO}@${HF_REV} …`);

  const treeRes = await fetch(treeUrl, { redirect: "follow" });
  if (!treeRes.ok) {
    throw new Error(
      `Could not list HuggingFace repo ${HF_REPO} (${treeRes.status}). ` +
      `Set SUPERTONIC_HF_REPO / SUPERTONIC_HF_REV if it moved.`,
    );
  }
  const tree = await treeRes.json();
  const files = tree.filter((e) => e.type === "file" && wanted(e.path));
  if (files.length === 0) {
    throw new Error(
      `No onnx/ or voice_styles/ files found in ${HF_REPO}. ` +
      `The repo layout may differ — check it and adjust KEEP_PREFIXES.`,
    );
  }

  let fetched = 0, skipped = 0, bytes = 0;
  for (const f of files) {
    const out = join(DEST, f.path);
    if (await exists(out)) { skipped++; continue; }
    process.stdout.write(`  ↓ ${f.path} … `);
    const n = await download(resolveUrl(f.path), out);
    bytes += n; fetched++;
    console.log(`${(n / 1e6).toFixed(1)} MB`);
  }
  console.log(`\nModels: ${fetched} fetched, ${skipped} already present (${(bytes / 1e6).toFixed(1)} MB new).`);

  // ── ONNX Runtime shared library ──────────────────────────────────────────
  const dllOut = join(DEST, "onnxruntime.dll");
  if (await exists(dllOut)) {
    console.log("onnxruntime.dll already present — keeping it.");
  } else if (DLL_URL) {
    process.stdout.write(`  ↓ onnxruntime.dll … `);
    const n = await download(DLL_URL, dllOut);
    console.log(`${(n / 1e6).toFixed(1)} MB`);
  } else {
    console.log(
      "\n⚠  onnxruntime.dll NOT fetched. Drop the Windows ONNX Runtime build that\n" +
      "   matches the `ort` version in Cargo.lock into that folder, or re-run with\n" +
      "   ONNXRUNTIME_DLL_URL=<direct-download-url>.",
    );
  }

  console.log("\n✓ Supertonic assets staged. Next: bash src-tauri/scripts/pack-supertonic-archive.sh");
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
