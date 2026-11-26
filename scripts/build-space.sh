#!/bin/sh
# Assemble the Hugging Face Space (static web demo) into a folder:
#   sh scripts/build-space.sh /path/to/space-repo
# Copies space/ plus the shared modules the demo runs (the same code as the desktop app).
set -e
OUT="${1:?usage: build-space.sh OUTPUT_DIR}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT/shared"
cp "$ROOT"/space/index.html "$ROOT"/space/app.js "$ROOT"/space/style.css "$ROOT"/space/README.md "$OUT"/
cp "$ROOT"/build/icon.svg "$OUT"/icon.svg
for f in biomarkers extractor calculators calculators-extended analysis questions caseRecord; do cp "$ROOT/src/shared/$f.js" "$OUT/shared/"; done
cp "$ROOT"/src/renderer/demo.js "$OUT"/shared/demo.js
echo "Space files written to $OUT"
