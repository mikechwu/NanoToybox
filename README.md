# NanoToybox

Interactive carbon nanostructure simulation playground running real-time molecular dynamics in the browser.

Drag atoms, spin molecules, and watch carbon structures respond with real Tersoff physics — no server required. Publish a session as a compact **capsule** and share a short code or link that opens instantly in the Watch viewer.

## Demo

Serve locally and open in your browser: 

```bash
git clone https://github.com/mikechwu/NanoToybox.git
cd NanoToybox
npm install
npm run dev
# Open http://localhost:5173/lab/
```

Or visit the live demo at [atomdojo.pages.dev](https://atomdojo.pages.dev/lab/).

## Features

- **Real-time Tersoff potential** — full analytical carbon force field with dual JS/Wasm kernels
- **Off-thread physics** — Web Worker simulation with automatic sync-mode fallback
- **Multi-molecule playground** — add multiple structures, collide them, watch them interact
- **Three interaction modes** — Atom (drag single atom), Move (translate molecule), Rotate (spin via torque)
- **Placement mode** — new molecules appear adjacent to existing ones; translucent preview with drag-to-adjust
- **15 structure presets** — C60, C180, C540, C720, carbon nanotubes (armchair/zigzag/chiral), graphene, diamond
- **3D rendering** — PBR materials, camera-relative lighting, interactive XYZ triad (drag=orbit, tap=snap, double-tap=reset)
- **NVE dynamics by default** — energy-conserving; adjustable damping slider (0 to heavy)
- **Dark/Light themes** — full UI adaptation with glassmorphic panels
- **Containment boundary** — soft harmonic wall with Contain/Remove toggle, live atom count, auto-scaling radius
- **Responsive UI** — phone (bottom sheet), tablet (side panel), desktop (non-modal panel)
- **Bonded-group color editing** — inline color chip with preset swatch popover; group color intents persist across topology changes, multi-color chips for mixed groups, perceptual lift for 3D readability
- **React + Zustand** — all UI surfaces are React-authoritative with reactive store

### Watch (trajectory viewer)

- **Pre-computed trajectory playback** — load full simulation histories and scrub through them frame-by-frame
- **Smooth playback** — linear interpolation on by default for fluid motion between keyframes; Hermite (velocity-based) and Catmull-Rom (experimental) available in settings
- **Dock controls** — play/pause, speed, repeat, Smooth toggle, and interpolation method picker
- **Capsule and full file support** — loads compact capsule files (position-only with authored appearance) or full simulation histories; reconstructs bond topology on the fly via shared topology builders
- **Authored color import** — capsule files carry per-group color assignments from the lab; Watch applies them so playback colors match the original session
- **Shared rendering** — same PBR materials, camera orbit, XYZ triad, overlay layout, and theme system as the interactive lab

### Share links (capsule publishing)

- **One-click publish** — Lab's export dialog can publish a capsule to the cloud and return a 12-character share code (Crockford Base32, grouped as `7M4K-2D8Q-9T1V`) plus a share URL
- **Open anywhere** — Watch accepts a pasted code, a `watch/?c=<code>` URL, or a `/c/:code` preview route
- **Signed-in publishing** — Google or GitHub OAuth gates publish; reads are public. Per-user quota (10/24h sliding window) plus per-IP WAF rate limits keep abuse in check
- **Popup-first OAuth** — sign-in opens a provider popup and returns to a dedicated `/auth/popup-complete` landing page that notifies the opener via `postMessage` + `BroadcastChannel` and closes itself; Lab's in-memory state (loaded molecules, interaction mode, camera) is preserved across the flow
- **Popup-blocked UX** — no silent same-tab fallback; the UI surfaces explicit Retry / Continue-in-tab / Back controls. Same-tab fallback uses a resume-publish intent (sessionStorage, 10-min TTL) plus a `?authReturn=1` query-marker handshake
- **Never-401 session probe** — `GET /api/auth/session` always returns 200 with a `{ status: 'signed-in' | 'signed-out' }` discriminator and `Cache-Control: no-store, private` / `Vary: Cookie`; stale cookies are opportunistically cleared on signed-out responses so devtools no longer flags normal signed-out state as a failure
- **Cloudflare-backed** — Pages Functions under `functions/` persist metadata in D1 and capsule bodies in R2; a companion cron Worker in `workers/cron-sweeper/` expires sessions and sweeps orphaned R2 objects

## How It Works

The page loads relaxed carbon structures from a pre-computed library, then runs the Tersoff (1988) interatomic potential via a Web Worker at ~60 FPS. User interactions (drag, rotate) inject forces into the simulation, and the structure responds through real bond forces — not animation.

| Component | Technology |
|-----------|-----------|
| Physics | Tersoff potential (JS + C/Wasm), Velocity Verlet integration |
| Worker | Web Worker with snapshot protocol, stall detection, sync fallback |
| Rendering | Three.js v0.170, InstancedMesh (2 draw calls), PBR materials |
| Interaction | Raycasting + camera-plane projection |
| UI | React 19, Zustand store, CSS custom properties |

## Controls

### Modes

Select **Atom**, **Move**, or **Rotate** in the dock's segmented control.

### Desktop

| Gesture | Action |
|---------|--------|
| Left-drag on atom | Interact (depends on mode) |
| Left-drag fast + release | Flick / push atom (Atom mode) |
| Ctrl+click on atom | Rotate molecule (shortcut, any mode) |
| Right-drag | Orbit camera |
| Scroll | Zoom |

### Mobile

| Gesture | Action |
|---------|--------|
| 1-finger drag on atom | Interact (depends on mode) |
| Drag triad | Orbit camera |
| 1-finger drag on background | Orbit camera |
| Tap axis end on triad | Snap to that view |
| Double-tap triad center | Reset to default view |
| 2-finger pinch | Zoom |
| 2-finger drag | Pan camera |

## Project Structure

```
NanoToybox/
├── lab/                       # Interactive playground (main app)
│   ├── index.html
│   └── js/
│       ├── main.ts             # Composition root — RAF lifecycle, global wiring, delegates to app/ and runtime/
│       ├── app/                # App-level orchestration (frame sequencing, teardown)
│       ├── runtime/            # Feature runtime modules (scene, worker, overlay, input, UI)
│       ├── components/         # React UI components (Dock, SettingsSheet, etc.)
│       ├── store/              # Zustand state management
│       ├── hooks/              # React hooks (sheet animation)
│       ├── physics.ts          # Tersoff force engine
│       ├── simulation-worker.ts # Off-thread physics worker
│       ├── worker-bridge.ts    # Main↔Worker protocol bridge
│       ├── renderer.ts         # Three.js visualization
│       ├── orbit-math.ts       # Pure orbit math (arcball deltas, shared constants)
│       ├── ui/                 # Coachmark definitions
│       └── ...                 # See docs/architecture.md for full module map
├── watch/                      # Trajectory viewer app (smooth playback, interpolation, dock controls)
├── viewer/                     # Minimal trajectory viewer (static)
├── sim/                        # Python simulation engine
│   ├── potentials/             # Tersoff (Python + Numba)
│   ├── integrators/            # Velocity Verlet
│   ├── structures/             # Geometry generators
│   ├── io/                     # XYZ output
│   └── wasm/                   # C Tersoff kernel + Emscripten build
├── src/                        # Shared modules consumed by both lab/ and watch/
│   ├── topology/               # Bond rules, topology builders, policy resolution
│   ├── history/                # V1 file types (full + capsule), bond-policy types, connected components, bonded-group projection, units
│   ├── ui/                     # Shared CSS tokens, hooks, component styles
│   ├── config/                 # Playback speed constants, viewer defaults, bond defaults
│   ├── appearance/             # Bonded-group color assignment logic
│   ├── input/                  # Camera gesture constants
│   └── types/                  # Shared TypeScript type definitions
├── structures/library/         # 15 relaxed 0K structures
├── scripts/                    # CLI tools, scaling research
├── tests/                      # Unit, E2E, and physics validation tests
├── functions/                  # Cloudflare Pages Functions (share-link backend)
│   ├── api/capsules/           # Publish, read, report endpoints
│   ├── api/auth/               # Session (200-contract probe) + logout
│   ├── api/admin/              # Moderation + sweeper endpoints (admin-gated)
│   ├── auth/                   # Google + GitHub OAuth start/callback + popup-complete landing page
│   └── c/[code].ts             # /c/:code share-preview route
├── migrations/                 # D1 schema migrations (capsule_share, audit/quota, indexes)
├── workers/cron-sweeper/       # Scheduled Worker — sessions + R2 orphan sweeps
└── docs/                       # Developer documentation
```

## Development

### Interactive page

```bash
npm install          # first time only
npm run dev          # Vite dev server with HMR (frontend only)
npm run build        # production build → dist/
npm run preview      # preview built output
npm run typecheck    # TypeScript type-check (frontend + functions + cron)
npm run test:unit    # Vitest unit tests
npm run test:e2e     # Playwright E2E browser tests
```

`npm run typecheck` fans out to `typecheck:frontend`, `typecheck:functions`, and `typecheck:cron` — the repo has a split tsconfig (`tsconfig.json` for the Vite app, `tsconfig.functions.json` for Pages Functions, `workers/cron-sweeper/tsconfig.json` for the cron Worker).

### Share-link backend (Pages Functions, D1, R2)

The capsule publishing feature runs on Cloudflare Pages Functions. Run the frontend + backend locally with Wrangler:

```bash
npm run build          # build dist/ first (Wrangler serves from it)
npm run cf:d1:migrate  # apply D1 migrations to the local SQLite shim
npm run cf:dev         # wrangler pages dev dist (Functions + D1/R2 bindings)
# Open http://localhost:8788/lab/
```

Share-link auth flows (popup OAuth, `/auth/popup-complete`, session probe) require the Pages Functions runtime — run `npm run cf:dev` rather than `npm run dev`. Lab detects the Vite dev host (`:5173`) and skips the popup with a console pointer to the wrangler command.

Create a `.dev.vars` file in the repo root for local secrets (not committed). Typical keys:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — OAuth credentials
- `SESSION_SECRET` — HMAC key for the session cookie
- `AUTH_DEV_USER_ID` — optional localhost-only dev bypass for signed-in routes
- `DEV_ADMIN_ENABLED=true` — optional localhost-only admin gate for moderation/sweep endpoints
- `CRON_SECRET` — shared secret for the cron Worker to call admin sweep endpoints

Seed a capsule for manual testing:

```bash
npm run seed:capsule    # POSTs a fixture capsule to the local dev server
```

The companion cron Worker lives in `workers/cron-sweeper/` with its own scripts: `npm run cron:dev` (local), `npm run cron:deploy`, `npm run cron:tail`.

### Python simulation engine

```bash
pip install numpy numba matplotlib

# Run validation tests
python -m pytest tests/test_*.py -v

# Generate a new structure
python scripts/library_cli.py c60
python scripts/library_cli.py cnt 5 5 --cells 5
```

### Wasm kernel (requires Emscripten)

```bash
make -C sim/wasm     # Rebuild tersoff.wasm + glue
```

## CI/CD

- **CI** runs on every push/PR: typecheck, unit tests, build, Playwright E2E, deploy smoke check, Python physics tests
- **Deploy** to Cloudflare Pages on push to main: build → verify → E2E → deploy

### Deployment

- **Frontend + Pages Functions** deploy together to Cloudflare Pages. Bindings (D1 `atomdojo-capsules`, R2 `atomdojo-capsules-prod`) and WAF rules are declared in `wrangler.toml`; secrets (`SESSION_SECRET`, OAuth credentials, `CRON_SECRET`) are set via `wrangler pages secret put ...` in the Cloudflare dashboard
- **D1 migrations** live in `migrations/` and are applied with `wrangler d1 migrations apply atomdojo-capsules` (add `--local` for the dev SQLite shim, omit for production)
- **Cron Worker** in `workers/cron-sweeper/` is a separate deployable. It calls admin sweep endpoints (`X-Cron-Secret` auth) on a schedule — `0 */6 * * *` expires sessions, `30 3 * * *` sweeps orphaned R2 objects. Deploy with `npm run cron:deploy`

## Documentation

Detailed docs in [`docs/`](docs/):

- [Architecture](docs/architecture.md) — module map, data flow, state ownership
- [Physics](docs/physics.md) — Tersoff potential, units, validation
- [Structure Library](docs/structure-library.md) — 15 canonical structures
- [Viewer & Interactive Page](docs/viewer.md) — product behavior and usage
- [Scaling Research](docs/scaling-research.md) — real-time limits, collision benchmarks
- [Decisions](docs/decisions.md) — key design rationale
- [Testing & Validation](docs/testing.md) — test ladder, pass criteria, how to run
- [ML Surrogate](docs/ml-surrogate.md) — force decomposition, training pipeline (deferred)
- [Operations](docs/operations.md) — share-link deployment runbook, secrets, sweeps, reconciliation
- [Contributing](docs/contributing.md) — development guide

## License

[MIT](LICENSE)
