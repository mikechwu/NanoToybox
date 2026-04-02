# NanoToybox Developer Documentation

Welcome to the NanoToybox project — a browser-based interactive carbon nanostructure simulation playground.

## Documentation Index

| Document | Purpose |
|----------|---------|
| [Architecture](architecture.md) | System overview, module map, data flow, state ownership |
| [Physics & Simulation](physics.md) | Tersoff potential, integrator, units, validation |
| [Structure Library](structure-library.md) | Canonical structures, generation pipeline, CLI usage |
| [ML Surrogate](ml-surrogate.md) | Force decomposition, training pipeline, lessons learned |
| [Testing & Validation](testing.md) | Test ladder, pass criteria, how to run |
| [Viewer](viewer.md) | Trajectory viewer and interactive page |
| [Project Decisions](decisions.md) | Key strategic decisions and their rationale |
| [Scaling Research](scaling-research.md) | Real-time browser limits, collision benchmarks, bottleneck analysis |
| [Contributing](contributing.md) | How to continue development, rules, workflow |

## Quick Start

```bash
# Install dependencies (first time only)
npm install

# Launch the interactive page (Vite dev server with HMR)
npm run dev
# Open http://localhost:5173/NanoToybox/page/

# Run all checks
npm run typecheck       # TypeScript type-checking
npm run test:unit       # Vitest unit tests (427 tests)
npm run test:e2e        # Playwright E2E browser tests (19 tests)
npm run build           # Production build → dist/

# Python physics tests (requires numpy, numba)
python -m pytest tests/test_*.py -v
```

## Pre-Deploy Manual Checklist (WebGL-dependent)

These checks require a real browser with WebGL and cannot run in headless CI. Run before merging to main or deploying:

- [ ] **Main app:** Open `/page/`, click Add → select a structure → place on canvas → verify atom count in status → open Settings → Clear → verify "Empty playground"
- [ ] **Drag interactions:** Atom mode (drag single atom), Move mode (translate molecule), Rotate mode (spin molecule). Flick an atom — verify no ghost spring after release
- [ ] **Settings:** Open/close settings sheet, switch Dark/Light theme, change speed, boundary mode
- [ ] **Viewer:** Open `/viewer/`, drag-drop an `.xyz` file, verify atoms and bonds render

Automated checks (typecheck, build, unit tests, Playwright E2E, deploy smoke) run in CI on every push/PR.

## Architecture Overview

```
Browser                          Web Worker
┌─────────────────────┐          ┌──────────────────────┐
│  React UI (Zustand)  │          │  PhysicsEngine       │
│  ├── Dock            │          │  ├── Tersoff (JS/Wasm)│
│  ├── SettingsSheet   │◄─snapshots──┤  ├── Velocity Verlet│
│  ├── StructureChooser│          │  └── Safety controls  │
│  ├── StatusBar       │──commands──►│                      │
│  ├── FPSDisplay      │          └──────────────────────┘
│  └── SheetOverlay    │
│                      │
│  Renderer (Three.js) │          Python (development)
│  ├── InstancedMesh   │          ┌──────────────────────┐
│  └── PBR materials   │          │  sim/ reference engine│
│                      │          │  tests/ validation    │
│  PlacementController │          │  scripts/ CLI tools   │
│  StatusController    │          └──────────────────────┘
│  (hint-only)         │
│                      │
│  runtime/ (26 modules):│
│  ├── SceneRuntime     │
│  ├── WorkerLifecycle  │
│  ├── SnapshotReconc.  │
│  ├── OverlayLayout    │
│  ├── OverlayRuntime   │
│  ├── InteractionDisp. │
│  ├── InputBindings    │
│  ├── UIBindings       │
│  ├── AtomSource       │
│  ├── FocusRuntime     │
│  ├── Onboarding       │
│  ├── BondedGroup×3    │
│  ├── Timeline×5       │
│  ├── RestartAdapter   │
│  ├── ReconciledSteps  │
│  ├── OrbitFollow      │
│  ├── DragTargetRefr.  │
│  ├── InteractionHi.   │
│  └── PlacementSolver  │
└─────────────────────┘
```

### Key Architectural Decisions

- **React-authoritative UI** — all UI surfaces (DockLayout, DockBar, Segmented, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay) are React components with Zustand store. Imperative controllers remain only for PlacementController (canvas touch listeners) and StatusController (hint/coachmark surface).
- **Worker-first physics** — simulation runs off-thread via Web Worker with snapshot protocol. Automatic fallback to sync-mode if worker fails (5s warning, 15s fatal).
- **Dual Tersoff kernels** — JS fallback + C/Wasm kernel (compiled with Emscripten). Wasm enabled by default, ~11% faster. Force via `?kernel=js` for debugging.
- **Momentum-conserving force clamp** — global scaling (not per-atom) preserves Newton's 3rd law and force field shape. Interaction forces added after clamp.
- **Runtime module extraction** — main.ts delegates to 26 focused modules in `page/js/runtime/` (scene, worker lifecycle, snapshot reconciler, overlay layout/runtime, interaction dispatch, input bindings, UI bindings, atom source, focus resolution, onboarding, bonded-groups, timeline, restart, reconciled-steps, orbit-follow-update, drag-target-refresh, interaction-highlight, placement-solver). main.ts is composition-root-only (~1150 lines).

## Current Status

- **Interactive page: live** — real-time Tersoff simulation with drag, rotate, multi-molecule playground, speed control, and advanced settings
- **Web Worker physics** — off-thread simulation with snapshot sync, stall detection (5s warning / 15s fatal), automatic sync fallback
- **React UI** — all 11 UI components are React-authoritative with Zustand store, glassmorphic CSS, responsive layout (phone/tablet/desktop)
- **Performance optimized** — InstancedMesh rendering (2 draw calls), on-the-fly Tersoff kernel (45% faster), spatial-hash neighbor/bond search (O(N))
- **Wasm Tersoff kernel** — deployed and enabled by default, automatic JS fallback
- **CI/CD** — GitHub Actions: typecheck, unit tests (427), build, E2E (19), deploy smoke, Python physics tests
- **Containment boundary** — dynamic soft wall with Contain/Remove modes, live atom count, auto-scaling radius
- Structure library: 15 canonical relaxed structures (60–720 atoms)
- Numba-accelerated force engine: 250–480x faster than pure Python (for server-side use)
- Three.js trajectory viewer: functional at `viewer/index.html`
- Performance benchmarks in `page/bench/`

## Project Goal

Build an immersive, interactive, scientifically accurate browser-based playground for carbon nanostructures (C60, graphene, CNTs, diamond). Users can explore, drag, rotate, and interact with real molecular dynamics simulations in real-time.
