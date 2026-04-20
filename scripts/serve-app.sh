#!/usr/bin/env bash
#
# serve-app.sh — local "full-stack" launcher for the atomdojo app.
#
# Wraps the canonical deploy-local pipeline:
#
#     npm run build              # vite build → dist/
#     npm run cf:d1:migrate      # apply D1 migrations to the local SQLite
#     npx wrangler pages dev ... # Cloudflare Pages emulation
#
# The raw Vite dev server (`npm run dev`) is NOT enough for the lab
# app: lab/watch bootstraps against `/api/*` and `/auth/*` endpoints
# implemented as Cloudflare Pages Functions under `functions/`.
# Those routes 404 in vite dev and the lab page silently fails to
# hydrate. The audit workbench has its own lighter-weight launcher
# (`serve-preview-audit.sh`) because it has no Functions dependency.
#
# What this script adds over running the three npm scripts yourself:
#   1. One command instead of three sequential terminals.
#   2. Banner up front with the exact URLs for /, /lab/, /watch/.
#   3. Port-collision preflight with actionable recovery commands
#      (process holder, kill commands, next-free port).
#   4. `--skip-build` / `--skip-migrate` for fast re-runs during the
#      inner loop — once dist/ + the local D1 are warm you can skip
#      the expensive steps without retyping the wrangler incantation.
#
# Usage:
#   scripts/serve-app.sh                    # full pipeline on 8788
#   scripts/serve-app.sh --open             # ...and open browser
#   scripts/serve-app.sh --port 8799        # override port
#   scripts/serve-app.sh --skip-build       # reuse existing dist/
#   scripts/serve-app.sh --skip-migrate     # skip `d1 migrations apply`
#   scripts/serve-app.sh --skip-build --skip-migrate   # fastest re-run
#   scripts/serve-app.sh -h | --help
#
# npm alias:
#   npm run app:serve
#   npm run app:serve -- --skip-build --open

set -euo pipefail

readonly DEFAULT_PORT=8788

usage() {
  cat <<'EOF'
Usage: scripts/serve-app.sh [options]

Runs the full local-deploy pipeline for atomdojo:
  1. vite build                                   (skipped with --skip-build)
  2. wrangler d1 migrations apply atomdojo-capsules --local
                                                  (skipped with --skip-migrate)
  3. wrangler pages dev dist --port <port>

Options:
  --open            Open the main URL in the default browser once
                    the server is accepting connections.
  --port <number>   Override the wrangler port (default: 8788).
  --skip-build      Reuse the existing dist/ instead of rebuilding.
                    Errors out if dist/ is missing.
  --skip-migrate    Skip the local D1 migration step. Safe once the
                    local database is already at head.
  -h, --help        Show this help.

Routes served:
  /               → redirects to /lab/
  /lab/           → lab app (main)
  /watch/         → watch app
  /account/, /viewer/, /privacy/, /terms/, /privacy-request/
  /api/*, /c/*, /auth/*  (Cloudflare Pages Functions)
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

open_browser=0
skip_build=0
skip_migrate=0
port="$DEFAULT_PORT"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --open)          open_browser=1; shift ;;
    --port)          port="${2:-}"; shift 2 ;;
    --skip-build)    skip_build=1; shift ;;
    --skip-migrate)  skip_migrate=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "error: --port must be an integer 1..65535 (got: $port)" >&2
  exit 2
fi

# Preflight: repo shape. Clear errors beat a cryptic tool error.
if [[ ! -f "$REPO_ROOT/vite.config.ts" ]]; then
  echo "error: vite.config.ts not found at $REPO_ROOT" >&2
  echo "       (script must run inside the NanoToybox repo)" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/wrangler.toml" ]]; then
  echo "error: wrangler.toml not found at $REPO_ROOT" >&2
  exit 1
fi
if [[ ! -d "$REPO_ROOT/node_modules/vite" ]]; then
  echo "error: node_modules not installed — run 'npm install' first" >&2
  exit 1
fi
if (( skip_build )) && [[ ! -d "$REPO_ROOT/dist" ]]; then
  echo "error: --skip-build requested but dist/ is missing" >&2
  echo "       (first run without --skip-build to produce the bundle)" >&2
  exit 1
fi

base_url="http://localhost:${port}"
main_url="$base_url/"
lab_url="$base_url/lab/"
watch_url="$base_url/watch/"

opener=""
if (( open_browser )); then
  if command -v open >/dev/null 2>&1; then
    opener="open"
  elif command -v xdg-open >/dev/null 2>&1; then
    opener="xdg-open"
  else
    echo "warning: --open requested but no 'open'/'xdg-open' found; continuing without auto-open" >&2
  fi
fi

steps=()
if (( skip_build ));   then steps+=("build:   skipped"); else steps+=("build:   npm run build"); fi
if (( skip_migrate )); then steps+=("migrate: skipped"); else steps+=("migrate: npm run cf:d1:migrate"); fi
steps+=("serve:   wrangler pages dev dist --port $port")

cat <<EOF
┌─────────────────────────────────────────────────────────────────────
│ atomdojo — local app server (full Cloudflare emulation)
│
│ Port:  $port (strict)
│ Root:  $REPO_ROOT
│
│ Pipeline:
│   1. ${steps[0]}
│   2. ${steps[1]}
│   3. ${steps[2]}
│
│ URLs (once ready):
│   Main   $main_url
│   Lab    $lab_url
│   Watch  $watch_url
│   Functions: /api/* /c/* /auth/* (emulated)
│
│ Press Ctrl-C to stop.
└─────────────────────────────────────────────────────────────────────
EOF

cd "$REPO_ROOT"

# Port-collision preflight. Wrangler will fail on collision, but its
# error is not actionable — we name the holder and suggest exact
# recovery commands. Falls back silently when lsof is unavailable.
if command -v lsof >/dev/null 2>&1; then
  holder=$(lsof -iTCP:"$port" -sTCP:LISTEN -nP -Fpcn 2>/dev/null || true)
  if [[ -n "$holder" ]]; then
    holder_pid=$(printf '%s\n' "$holder" | awk '/^p/ { sub(/^p/, ""); print; exit }')
    holder_cmd=$(printf '%s\n' "$holder" | awk '/^c/ { sub(/^c/, ""); print; exit }')
    suggest_port=$((port + 1))
    while (( suggest_port < port + 50 )); do
      if ! lsof -iTCP:"$suggest_port" -sTCP:LISTEN -nP >/dev/null 2>&1; then
        break
      fi
      suggest_port=$((suggest_port + 1))
    done
    # Preserve user-specified skip flags in the retry suggestion so
    # they don't lose the fast-path context they just chose.
    extra_flags=""
    (( skip_build ))   && extra_flags+=" --skip-build"
    (( skip_migrate )) && extra_flags+=" --skip-migrate"
    cat >&2 <<EOF

error: port $port is already in use

Held by: ${holder_cmd:-unknown} (PID ${holder_pid:-?})
  Stop it:      kill ${holder_pid:-<pid>}
  Force-stop:   kill -9 ${holder_pid:-<pid>}

Or pick a different port:
  scripts/serve-app.sh$extra_flags --port $suggest_port
  npm run app:serve --$extra_flags --port $suggest_port
EOF
    exit 1
  fi
fi

# ── Step 1: build ────────────────────────────────────────────────────
if (( skip_build )); then
  echo "==> skip-build: reusing existing dist/"
else
  echo "==> Building production bundle (npm run build)…"
  if ! npm run build --silent; then
    echo "error: production build failed — see output above" >&2
    exit 1
  fi
fi

# ── Step 2: migrate ──────────────────────────────────────────────────
# Wraps `npm run cf:d1:migrate` (wrangler d1 migrations apply
# atomdojo-capsules --local). Idempotent — already-applied migrations
# are skipped by wrangler. First-run failure usually means the local
# D1 has never been created; the error from wrangler is clear enough
# to let the user recover manually.
if (( skip_migrate )); then
  echo "==> skip-migrate: assuming local D1 is at head"
else
  echo "==> Applying local D1 migrations (npm run cf:d1:migrate)…"
  if ! npm run cf:d1:migrate --silent; then
    echo "error: D1 migration failed — see output above" >&2
    echo "       (re-run without --skip-migrate once the local DB is healthy)" >&2
    exit 1
  fi
fi

# ── Step 3: serve ────────────────────────────────────────────────────
# Explicit `npx wrangler pages dev dist --port <port>` rather than
# `npm run cf:dev` so the port is tunable. Matches the `cf:dev` npm
# script otherwise. `.dev.vars` at the repo root is picked up
# automatically by wrangler for local secrets.
echo "==> Starting wrangler pages dev on port ${port}..."

server_pid=
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

npx wrangler pages dev dist --port "$port" &
server_pid=$!

# Browser auto-open waits for the port to actually accept connections.
# Wrangler's cold start is longer than vite's; the 30-iteration /
# 0.5s budget is ~15s which covers worker-bundling on a cold cache.
if [[ -n "$opener" ]]; then
  for _ in $(seq 1 30); do
    if (echo >"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      "$opener" "$main_url" >/dev/null 2>&1 || true
      break
    fi
    sleep 0.5
  done
fi

wait "$server_pid"
