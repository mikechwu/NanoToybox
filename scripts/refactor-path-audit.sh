#!/usr/bin/env bash
# refactor-path-audit.sh — surface every place that hardcodes a runtime path.
#
# Used during the architecture-convergence refactor (see
# .reports/2026-04-18-architecture-convergence-refactor-plan.md). Prints the
# living set of test/doc/comment consumers that the next file move will
# break. Run before opening every move PR; update everything it lists in
# the same PR.
#
# Usage:
#   scripts/refactor-path-audit.sh                 # full audit
#   scripts/refactor-path-audit.sh <path-fragment> # focus on one path

set -euo pipefail

cd "$(dirname "$0")/.."

FRAGMENT="${1:-}"

section() {
  printf '\n=== %s ===\n' "$1"
}

# Run a grep against an explicit search root and print labelled results.
search_in() {
  local label="$1"; local root="$2"; shift 2
  local files
  files="$(grep -rl "$@" "$root" 2>/dev/null | sort -u || true)"
  local n
  n="$(printf '%s\n' "$files" | grep -c . || true)"
  printf '%s: %s file(s)\n' "$label" "$n"
  if [ "$n" -gt 0 ]; then
    printf '%s\n' "$files" | sed 's/^/  /'
  fi
}

if [ -n "$FRAGMENT" ]; then
  section "Hits for path fragment: $FRAGMENT (tests/, docs/, README.md)"
  search_in "tests/ hits" tests/ -F "$FRAGMENT"
  search_in "docs/ hits" docs/ -F "$FRAGMENT"
  search_in "README.md hits" README.md -F "$FRAGMENT"
  exit 0
fi

section "[REVIEW QUEUE — heuristic] Broad fs.readFileSync consumers in tests/"
search_in "tests/ fs.readFileSync consumers (broad)" tests/ -E "(readFileSync|fs\.readFileSync)" --include="*.ts" --include="*.tsx"
printf 'Heuristic: includes fixture, migration, and golden-file readers that are NOT runtime path consumers. Use as a review queue, not a must-fix list.\n'

section "[LIKELY RUNTIME-PATH CONSUMERS — narrower heuristic] fs.readFileSync co-occurring with lab/js/ or watch/js/ in tests/"
narrowed=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if grep -lqE "(lab/js/|watch/js/)" "$f" 2>/dev/null; then
    narrowed+=("$f")
  fi
done < <(grep -rl -E "(readFileSync|fs\.readFileSync)" tests/ --include="*.ts" --include="*.tsx" 2>/dev/null | sort -u || true)
printf 'tests/ fs.readFileSync + runtime-path co-occurrence: %s file(s)\n' "${#narrowed[@]}"
for f in "${narrowed[@]}"; do
  printf '  %s\n' "$f"
done
printf 'Heuristic: confirm each by inspection. Likely needs path-string updates when the referenced source files move.\n'

section "[LITERAL PATH-STRING CONSUMERS — authoritative for the surface searched] tests/"
search_in "tests/ path-string consumers" tests/ -E "(lab/js/|watch/js/)"
printf 'Authoritative: every listed file contains at least one literal lab/js/ or watch/js/ path string and will need updates if any of those paths move.\n'

section "[DOC CONSUMERS — authoritative for the surface searched] docs/ and README.md"
search_in "docs/ path-string consumers" docs/ -E "(lab/js/|watch/js/)"
search_in "README.md path-string consumers" README.md -E "(lab/js/|watch/js/)"
printf 'Authoritative for the docs surface. PR 9 closeout requires these to be zero-stale.\n'

section "Summary"
printf 'Section labels indicate actionability:\n'
printf '  REVIEW QUEUE        — broad heuristic; expect false positives.\n'
printf '  LIKELY CONSUMERS    — narrower heuristic; confirm by inspection.\n'
printf '  AUTHORITATIVE       — every hit is real and must be reviewed.\n'
printf '\nThis script is the broad warning surface, NOT a precise breakage oracle.\n'
printf 'Per Rule 7, the authoritative must-fix list is the Layer 2 grep -rFn for the exact paths moved in your PR.\n'
