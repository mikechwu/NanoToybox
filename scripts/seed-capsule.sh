#!/bin/sh
# Seed a capsule into local D1/R2 via the admin endpoint.
# Requires `wrangler pages dev` running on port 8788 with
# DEV_ADMIN_ENABLED=true (see playwright.pages-dev.config.ts).
#
# Usage:
#   npm run seed:capsule                  # uses default fixture
#   npm run seed:capsule -- path/to/file  # custom capsule
#
# Default fixture: tests/e2e/fixtures/poster-smoke-capsule.json — the same
# minimal capsule the pages-dev poster smoke uses, so this script is also a
# convenient way to manually reproduce the smoke's seed state.

DEFAULT_FIXTURE="tests/e2e/fixtures/poster-smoke-capsule.json"
TARGET="${1:-$DEFAULT_FIXTURE}"

if [ ! -f "$TARGET" ]; then
  echo "Error: File not found: $TARGET"
  exit 1
fi

curl -s -X POST http://localhost:8788/api/admin/seed \
  -H "Content-Type: application/json" \
  --data-binary "@$TARGET"
echo ""
