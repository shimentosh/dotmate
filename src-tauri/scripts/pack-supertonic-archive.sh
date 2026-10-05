#!/usr/bin/env bash
# VENDOR-ONLY: package the Supertonic 3 assets into ONE .tar.gz for hosting, so
# the app can download + extract them on first use. (Supertonic has no public
# archive in this layout, so it stays hidden unless a vendor hosts one.)
#
# The archive's single top-level folder `supertonic-3/` is stripped on extract by
# the Rust side (tts_command.rs), so it lands at <app_data>/models/supertonic/.
# It INCLUDES a Windows onnxruntime.dll — the archive therefore only works on
# Windows builds.
#
#   node src-tauri/scripts/fetch-supertonic-assets.mjs     # stage the assets
#   bash src-tauri/scripts/pack-supertonic-archive.sh [output.tar.gz]
#
# Then upload the result to a host you control and build the app with
#   SUPERTONIC_ARCHIVE_URL=https://your-host/supertonic-3.tar.gz corepack pnpm tauri:build
# (read at compile time by src-tauri/src/sources.rs). The weights are OpenRAIL-M:
# ship the licence and flow its use restrictions down to your end users.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # …/src-tauri
SRC="$HERE/supertonic-staging"
OUT="${1:-$HERE/dist-assets/supertonic-3.tar.gz}"

for need in "$SRC/onnx/vocoder.onnx" "$SRC/voice_styles/F1.json" "$SRC/onnxruntime.dll"; do
  [ -f "$need" ] || { echo "missing required asset: $need" >&2; exit 1; }
done

STAGE_ROOT="$(mktemp -d)"
STAGE="$STAGE_ROOT/supertonic-3"
mkdir -p "$STAGE" "$(dirname "$OUT")"
cp -r "$SRC/onnx" "$STAGE/"
cp -r "$SRC/voice_styles" "$STAGE/"
cp "$SRC/onnxruntime.dll" "$STAGE/"

echo "Packing → $OUT"
tar -czf "$OUT" -C "$STAGE_ROOT" supertonic-3
rm -rf "$STAGE_ROOT"
echo "Done. $(du -m "$OUT" | cut -f1) MB at: $OUT"
