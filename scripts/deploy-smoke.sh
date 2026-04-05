#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://127.0.0.1:4173}"

echo "=== Deploy Smoke Test ==="

echo "Checking product pages..."
curl -sf "$BASE/lab/" > /dev/null
echo "  ✓ /lab/"
curl -sf "$BASE/viewer/" > /dev/null
echo "  ✓ /viewer/"

echo "Checking dev pages (sample)..."
curl -sf "$BASE/lab/bench/bench-physics.html" > /dev/null
echo "  ✓ /lab/bench/bench-physics.html"
curl -sf "$BASE/lab/bench/bench-wasm.html" > /dev/null
echo "  ✓ /lab/bench/bench-wasm.html"

echo "Checking static assets..."
curl -sf "$BASE/structures/library/manifest.json" > /dev/null
echo "  ✓ /structures/library/manifest.json"

echo "Checking Vite-emitted Wasm assets in dist/..."
WASM_FILE=$(find dist/assets -name 'tersoff-*.wasm' 2>/dev/null | head -1)
if [ -n "$WASM_FILE" ]; then
  # Verify the emitted wasm is also accessible via the preview server
  WASM_BASENAME=$(basename "$WASM_FILE")
  curl -sf "$BASE/assets/$WASM_BASENAME" -o /dev/null
  echo "  ✓ Wasm binary served: /assets/$WASM_BASENAME"
else
  echo "  ✗ No tersoff-*.wasm found in dist/assets/"
  exit 1
fi

GLUE_FILE=$(find dist/assets -name 'tersoff-*.js' 2>/dev/null | head -1)
if [ -n "$GLUE_FILE" ]; then
  GLUE_BASENAME=$(basename "$GLUE_FILE")
  curl -sf "$BASE/assets/$GLUE_BASENAME" -o /dev/null
  echo "  ✓ Wasm glue served: /assets/$GLUE_BASENAME"
else
  echo "  ✗ No tersoff-*.js found in dist/assets/"
  exit 1
fi

echo "=== All deploy smoke checks passed ==="
