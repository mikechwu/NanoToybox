#!/usr/bin/env bash
#
# serve-preview-audit.sh — local launcher for the capsule preview
# audit workbench at `preview-audit/`.
#
# The audit page is dev-only. It is gated out of production builds by
# `vite.config.ts` (only included when `command === 'serve'` or
# `PREVIEW_AUDIT_BUILD === '1'`) and has a runtime `import.meta.env.PROD`
# guard as defence-in-depth. The Vite dev server is the intended way
# to use the page — this script is a thin wrapper that prints the
# audit URL up front and pins the port so the URL is stable across
# runs.
#
# Usage:
#   scripts/serve-preview-audit.sh               # serve, print URL
#   scripts/serve-preview-audit.sh --open        # ...and open browser
#   scripts/serve-preview-audit.sh --port 5180   # override port
#   scripts/serve-preview-audit.sh -h | --help
#
# npm alias:
#   npm run preview-audit:serve

set -euo pipefail

readonly DEFAULT_PORT=5173
readonly AUDIT_PATH="/preview-audit/"

usage() {
  cat <<'EOF'
Usage: scripts/serve-preview-audit.sh [options]

Options:
  --open            Open the audit URL in the default browser once
                    the dev server is accepting connections.
  --port <number>   Override the dev-server port (default: 5173).
  -h, --help        Show this help.

Strict-port binding: if the chosen port is in use the command fails
instead of silently binding somewhere else the user would have to
discover.
EOF
}

# Resolve repo root independent of the invocation cwd so the script
# works from any directory (and from editor "run file" shortcuts).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

open_browser=0
port="$DEFAULT_PORT"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --open)    open_browser=1; shift ;;
    --port)    port="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Preflight: repo shape we expect. Clear errors beat a cryptic Vite
# stack trace when someone has copied the script outside the tree.
if [[ ! -d "$REPO_ROOT/preview-audit" ]]; then
  echo "error: preview-audit/ not found at $REPO_ROOT" >&2
  echo "       (script must run inside the NanoToybox repo)" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/vite.config.ts" ]]; then
  echo "error: vite.config.ts not found at $REPO_ROOT" >&2
  exit 1
fi
if [[ ! -d "$REPO_ROOT/node_modules/vite" ]]; then
  echo "error: node_modules not installed — run 'npm install' first" >&2
  exit 1
fi

if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "error: --port must be an integer 1..65535 (got: $port)" >&2
  exit 2
fi

url="http://localhost:${port}${AUDIT_PATH}"

# Pick the platform's URL opener. Missing opener downgrades to a
# warning rather than an error — the user still has the printed URL.
opener=""
if [[ "$open_browser" -eq 1 ]]; then
  if command -v open >/dev/null 2>&1; then
    opener="open"
  elif command -v xdg-open >/dev/null 2>&1; then
    opener="xdg-open"
  else
    echo "warning: --open requested but no 'open'/'xdg-open' found; continuing without auto-open" >&2
  fi
fi

cat <<EOF
┌─────────────────────────────────────────────────────────────────────
│ Capsule preview audit (dev-only)
│
│ URL:  $url
│ Port: $port (strict)
│ Root: $REPO_ROOT
│
│ Dev-only. Gated out of production builds (vite.config.ts).
│ Press Ctrl-C to stop the dev server.
└─────────────────────────────────────────────────────────────────────
EOF

cd "$REPO_ROOT"

# Preflight: port availability. Strict-port will still catch a
# collision, but Vite's stack trace is not actionable. Detect up
# front with lsof so we can name the offending process and suggest
# the exact commands to recover. Falls back silently when lsof is
# unavailable — Vite's error remains the safety net.
if command -v lsof >/dev/null 2>&1; then
  holder=$(lsof -iTCP:"$port" -sTCP:LISTEN -nP -Fpcn 2>/dev/null || true)
  if [[ -n "$holder" ]]; then
    holder_pid=$(printf '%s\n' "$holder" | awk '/^p/ { sub(/^p/, ""); print; exit }')
    holder_cmd=$(printf '%s\n' "$holder" | awk '/^c/ { sub(/^c/, ""); print; exit }')
    # Scan a small window for the next free port so the suggestion
    # the user copies actually works.
    suggest_port=$((port + 1))
    while (( suggest_port < port + 50 )); do
      if ! lsof -iTCP:"$suggest_port" -sTCP:LISTEN -nP >/dev/null 2>&1; then
        break
      fi
      suggest_port=$((suggest_port + 1))
    done
    cat >&2 <<EOF

error: port $port is already in use

Held by: ${holder_cmd:-unknown} (PID ${holder_pid:-?})
  Stop it:      kill ${holder_pid:-<pid>}
  Force-stop:   kill -9 ${holder_pid:-<pid>}

Or pick a different port:
  scripts/serve-preview-audit.sh --port $suggest_port
  npm run preview-audit:serve -- --port $suggest_port
EOF
    exit 1
  fi
fi

# Track the vite PID so the EXIT trap can clean up even if the user
# interrupts mid-start. Vite itself handles SIGINT cleanly when it
# owns the terminal, but a backgrounded PID needs an explicit kill.
vite_pid=
cleanup() {
  if [[ -n "$vite_pid" ]] && kill -0 "$vite_pid" 2>/dev/null; then
    kill "$vite_pid" 2>/dev/null || true
    wait "$vite_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Strict-port so a conflict exits rather than silently binding
# elsewhere (the reason this script exists is URL stability).
npx vite --port "$port" --strictPort &
vite_pid=$!

# Browser auto-open waits for the listener. Polling /dev/tcp is bash-
# specific but we explicitly require bash via the shebang; timeout
# ~10s covers cold-start + type-check latency on modest hardware.
if [[ -n "$opener" ]]; then
  for _ in $(seq 1 20); do
    if (echo >"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      "$opener" "$url" >/dev/null 2>&1 || true
      break
    fi
    sleep 0.5
  done
fi

wait "$vite_pid"
