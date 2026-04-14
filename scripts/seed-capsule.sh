#!/bin/sh
# Seed a capsule into local D1/R2 via the admin endpoint.
# Requires wrangler pages dev running on port 8788.
# Usage: npm run seed:capsule -- path/to/capsule.atomdojo

if [ -z "$1" ]; then
  echo "Usage: npm run seed:capsule -- <path-to-capsule.atomdojo>"
  exit 1
fi

if [ ! -f "$1" ]; then
  echo "Error: File not found: $1"
  exit 1
fi

curl -s -X POST http://localhost:8788/api/admin/seed \
  -H "Content-Type: application/json" \
  --data-binary "@$1"
echo ""
