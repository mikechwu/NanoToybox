# NanoToybox

Interactive carbon nanostructure simulation playground running real-time molecular dynamics in the browser.

Drag atoms, spin molecules, and watch carbon structures respond with real Tersoff physics — no server required.

## Demo

Serve locally and open in your browser:

```bash
git clone https://github.com/mikechwu/NanoToybox.git
cd NanoToybox
npm install
npm run dev
# Open http://localhost:5173/NanoToybox/page/
```

Or visit the live demo at [mikechwu.github.io/NanoToybox](https://mikechwu.github.io/NanoToybox/page/).

## Features

- **Real-time Tersoff potential** — full analytical carbon force field with dual JS/Wasm kernels
- **Off-thread physics** — Web Worker simulation with automatic sync-mode fallback
- **Multi-molecule playground** — add multiple structures, collide them, watch them interact
- **Three interaction modes** — Atom (drag single atom), Move (translate molecule), Rotate (spin via torque)
- **Placement mode** — new molecules appear adjacent to existing ones; translucent preview with drag-to-adjust
- **15 structure presets** — C60, C180, C540, C720, carbon nanotubes (armchair/zigzag/chiral), graphene, diamond
- **3D rendering** — PBR materials, camera-relative lighting, XYZ orientation axes
- **NVE dynamics by default** — energy-conserving; adjustable damping slider (0 to heavy)
- **Dark/Light themes** — full UI adaptation with glassmorphic panels
- **Containment boundary** — soft harmonic wall with Contain/Remove toggle, live atom count, auto-scaling radius
- **Responsive UI** — phone (bottom sheet), tablet (side panel), desktop (non-modal panel)
- **React + Zustand** — all UI surfaces are React-authoritative with reactive store

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
| 2-finger pinch | Zoom |
| 2-finger drag | Pan camera |

## Project Structure

```
NanoToybox/
├── page/                       # Interactive playground (main app)
│   ├── index.html
│   └── js/
│       ├── main.ts             # Composition root + runtime orchestration
│       ├── components/         # React UI components (Dock, SettingsSheet, etc.)
│       ├── store/              # Zustand state management
│       ├── hooks/              # React hooks (sheet animation)
│       ├── physics.ts          # Tersoff force engine
│       ├── simulation-worker.ts # Off-thread physics worker
│       ├── worker-bridge.ts    # Main↔Worker protocol bridge
│       ├── renderer.ts         # Three.js visualization
│       ├── ui/                 # Coachmark definitions
│       └── ...                 # See docs/architecture.md for full module map
├── viewer/                     # Pre-computed trajectory viewer
├── sim/                        # Python simulation engine
│   ├── potentials/             # Tersoff (Python + Numba)
│   ├── integrators/            # Velocity Verlet
│   ├── structures/             # Geometry generators
│   ├── io/                     # XYZ output
│   └── wasm/                   # C Tersoff kernel + Emscripten build
├── src/types/                  # Shared TypeScript type definitions
├── structures/library/         # 15 relaxed 0K structures
├── scripts/                    # CLI tools, scaling research
├── tests/                      # Unit, E2E, and physics validation tests
└── docs/                       # Developer documentation
```

## Development

### Interactive page

```bash
npm install          # first time only
npm run dev          # Vite dev server with HMR
npm run build        # production build → dist/
npm run preview      # preview built output
npm run typecheck    # TypeScript type-checking
npm run test:unit    # Vitest unit tests
npm run test:e2e     # Playwright E2E browser tests
```

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
- **Deploy** to GitHub Pages on push to main: build → verify → E2E → deploy

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
- [Contributing](docs/contributing.md) — development guide

## License

[MIT](LICENSE)
