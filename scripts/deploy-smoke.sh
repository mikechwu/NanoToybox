#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://127.0.0.1:4173}"

echo "=== Deploy Smoke Test ==="

echo "Checking product pages..."
curl -sf "$BASE/lab/" > /dev/null
echo "  ✓ /lab/"
curl -sf "$BASE/viewer/" > /dev/null
echo "  ✓ /viewer/"

echo "Checking policy + account pages..."
curl -sf "$BASE/privacy/" > /dev/null
echo "  ✓ /privacy/"
curl -sf "$BASE/terms/" > /dev/null
echo "  ✓ /terms/"
curl -sf "$BASE/account/" > /dev/null
echo "  ✓ /account/"
curl -sf "$BASE/privacy-request/" > /dev/null
echo "  ✓ /privacy-request/"

# --- Policy segment gating ---
# Source of truth: src/policy/policy-config.ts (ACTIVE_POLICY_SEGMENTS).
# The Vite build injects that list into a `<meta name="policy-active-
# segments">` tag on /privacy and /terms. We read the meta tag at smoke
# time and derive both the allow-list AND the deny-list from it, so a
# phase rollout updates the TS config and nothing else.
echo "Checking policy segment gating..."
PRIVACY_HTML=$(curl -sSf "$BASE/privacy/")
TERMS_HTML=$(curl -sSf "$BASE/terms/")

extract_segments() {
  echo "$1" | grep -oE 'name="policy-active-segments" content="[^"]*"' \
    | sed -E 's/.*content="([^"]*)".*/\1/' \
    | tr ',' ' '
}

PRIVACY_ACTIVE=$(extract_segments "$PRIVACY_HTML")
TERMS_ACTIVE=$(extract_segments "$TERMS_HTML")

if [ -z "$PRIVACY_ACTIVE" ]; then
  echo "  ✗ /privacy missing <meta name=\"policy-active-segments\"> — Vite plugin not wired?"
  exit 1
fi
if [ -z "$TERMS_ACTIVE" ]; then
  echo "  ✗ /terms missing <meta name=\"policy-active-segments\">"
  exit 1
fi
if [ "$PRIVACY_ACTIVE" != "$TERMS_ACTIVE" ]; then
  echo "  ✗ active segments diverge between pages: privacy=[$PRIVACY_ACTIVE] terms=[$TERMS_ACTIVE]"
  exit 1
fi
echo "  meta active segments: [$PRIVACY_ACTIVE]"

# Each listed segment must appear in the markup of both pages.
for SEG in $PRIVACY_ACTIVE; do
  echo "$PRIVACY_HTML" | grep -q "data-policy-segment=\"$SEG\"" \
    || { echo "  ✗ /privacy claims segment $SEG active but no markup found"; exit 1; }
done
echo "  ✓ /privacy markup matches active list"

# All A-Z letters NOT in the active list must NOT appear in either page.
ALL_SEGMENTS="A B C D E F G"
for SEG in $ALL_SEGMENTS; do
  is_active=0
  for ACTIVE in $PRIVACY_ACTIVE; do
    if [ "$SEG" = "$ACTIVE" ]; then is_active=1; break; fi
  done
  if [ "$is_active" -eq 0 ]; then
    if echo "$PRIVACY_HTML" | grep -q "data-policy-segment=\"$SEG\""; then
      echo "  ✗ /privacy has segment $SEG markup but config says inactive"
      exit 1
    fi
    if echo "$TERMS_HTML" | grep -q "data-policy-segment=\"$SEG\""; then
      echo "  ✗ /terms has segment $SEG markup but config says inactive"
      exit 1
    fi
  fi
done
echo "  ✓ no inactive-segment markup leaked"

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
