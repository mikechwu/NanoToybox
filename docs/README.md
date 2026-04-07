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
# Open http://localhost:5173/lab/

# Run all checks
npm run typecheck       # TypeScript type-checking
npm run test:unit       # Vitest unit tests
npm run test:e2e        # Playwright E2E browser tests
npm run build           # Production build → dist/

# Python physics tests (requires numpy, numba)
python -m pytest tests/test_*.py -v
```

## Pre-Deploy Manual Checklist (WebGL-dependent)

These checks require a real browser with WebGL and cannot run in headless CI. Run before merging to main or deploying:

- [ ] **Main app:** Open `/lab/`, click Add → select a structure → place on canvas → verify atom count in status → open Settings → Clear → verify "Empty playground"
- [ ] **Drag interactions:** Atom mode (drag single atom), Move mode (translate molecule), Rotate mode (spin molecule). Flick an atom — verify no ghost spring after release
- [ ] **Settings panel:** Fixed 250px width, scrollbar-gutter stable; open/close settings sheet, switch Dark/Light theme, change speed, boundary mode
- [ ] **Viewer:** Open `/viewer/`, drag-drop an `.xyz` file, verify atoms and bonds render
- [ ] Placement camera framing: preview does not cause camera snap, drag past boundary works
- [ ] Review mode UI lock: enter review → dock Add/mode/Pause disabled with hints → Settings Add Molecule/Clear disabled → Live/Restart exit re-enables
- [ ] History export: record a timeline with 2+ molecules → open export dialog → export downloads valid `.atomdojo-history` file → verify file contains stable atom IDs and metadata
- [ ] Dock stability: Pause ↔ Resume toggle does not shift neighboring controls
- [ ] Bonded groups: panel expanded by default with Collapse/Expand disclosure hint visible; per-row inline color chip opens preset swatch popover with responsive layout; authored color overrides persist across theme/structure changes; persistent tracked highlight is feature-gated off (hover preview remains active)
- [ ] Verify bonded-group color persists across topology changes (group merge/split)
- [ ] Verify multi-color chip shows conic gradient when group has mixed colors
- [ ] Verify color popover accessible via Escape key
- [ ] **Watch app:** Open `watch/`, load an exported `.atomdojo` file, verify React shell renders, playback at x1 rate matches lab review mode, bonded-group analysis correct; load a second file then cancel — verify first document preserved (transactional open)

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
│  app/ (2 modules):     │
│  ├── frame-runtime.ts  │
│  │   (per-frame update │
│  │    pipeline seq.)   │
│  └── app-lifecycle.ts  │
│      (teardown seq.    │
│       and reset helpers)│
│                        │
│  runtime/ (35 modules):│
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
│  ├── BondedGroup×6    │  (portal popover for color editing,
│  │                     │   group color intents → atom overrides)
│  ├── Timeline×6       │  (recording, review, scrub, restart,
│  │                     │   clear, subsystem coordinator)
│  ├── HistoryExport×3  │  (stable atom identity, metadata registry,
│  │                     │   v1 file builder + download)
│  ├── RestartAdapter   │
│  ├── ReconciledSteps  │
│  ├── OrbitFollow      │
│  ├── DragTargetRefr.  │
│  ├── InteractionHi.   │
│  ├── ReviewModeHints  │
│  ├── CameraTargetRt.  │
│  ├── PlacementSolver  │
│  └── PlacementFraming │
└─────────────────────┘

src/history/ (4 modules):       watch/js/ (~15 modules):
├── v1 schema types             ├── 7 runtime modules
├── connected-component         │   (file-type, history loader,
│   computation                 │    playback, bonded-group,
├── bonded-group projection     │    scrub, renderer, bootstrap)
│   (shared by lab/ & watch/)   ├── 6 React components
└── bonded-group-utils          │   (shell, panels, controls)
                                ├── react-root
src/ui/ (1 file):               └── controller
└── review-parity.css
    (shared review-mode styles) watch/css/ (1 file):
                                └── shared CSS imports
```

### Key Architectural Decisions

- **React-authoritative UI** — all UI surfaces (DockLayout, DockBar, Segmented, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay) are React components with Zustand store. Imperative controllers remain only for PlacementController (canvas touch listeners) and StatusController (hint/coachmark surface).
- **Worker-first physics** — simulation runs off-thread via Web Worker with snapshot protocol. Automatic fallback to sync-mode if worker fails (5s warning, 15s fatal).
- **Dual Tersoff kernels** — JS fallback + C/Wasm kernel (compiled with Emscripten). Wasm enabled by default, ~11% faster. Force via `?kernel=js` for debugging.
- **Momentum-conserving force clamp** — global scaling (not per-atom) preserves Newton's 3rd law and force field shape. Interaction forces added after clamp.
- **Runtime module extraction** — main.ts delegates to feature modules in `lab/js/runtime/` and orchestration modules in `lab/js/app/` (frame-runtime.ts, app-lifecycle.ts). See `docs/architecture.md` for the full module inventory.

## Current Status

- **Interactive page: live** — real-time Tersoff simulation with drag, rotate, multi-molecule playground, speed control, and advanced settings
- **Web Worker physics** — off-thread simulation with snapshot sync, stall detection (5s warning / 15s fatal), automatic sync fallback
- **React UI** — all 11 UI components are React-authoritative with Zustand store, glassmorphic CSS, responsive layout (phone/tablet/desktop); panel fixed width 250px with scrollbar-gutter stable
- **Performance optimized** — InstancedMesh rendering (2 draw calls), on-the-fly Tersoff kernel (45% faster), spatial-hash neighbor/bond search (O(N))
- **Wasm Tersoff kernel** — deployed and enabled by default, automatic JS fallback
- **CI/CD** — GitHub Actions: typecheck, unit tests, build, E2E, deploy smoke, Python physics tests
- **Containment boundary** — dynamic soft wall with Contain/Remove modes, live atom count, auto-scaling radius
- **Placement camera framing** — smooth camera assist keeps scene + preview visible during molecule placement; continuous drag with pointer capture and per-frame cursor-lock reprojection
- **Review mode UI lock** — display-only enforcement across all React surfaces during timeline review; centralized selector, runtime guards, ActionHint tooltips (desktop), transient status hints (mobile)
- **History export** — export simulation timeline as v1 atomdojo-history files with stable atom identity tracking across topology changes (placement, removal, merge/split); full position + metadata export via download trigger
- Structure library: 15 canonical relaxed structures (60–720 atoms) with derived honeycomb geometry
- Numba-accelerated force engine: 250–480x faster than pure Python (for server-side use)
- Three.js trajectory viewer: functional at `viewer/index.html`
- Performance benchmarks in `lab/bench/`
- **Bonded group architecture** — display-source-aware projection, capability policy, annotation-model atom color overrides; inline color editing via per-row color chip with portal popover (preset swatches, responsive layout, disclosure-pattern panel expanded by default), conic-gradient multi-color chips, group color intents persist across topology changes; persistent tracked highlight feature-gated off (hover preview remains active); review-mode inspection deferred until historical topology exists
- **Watch app** — standalone app at `watch/` with React shell and review-parity UI for importing and playing back exported `.atomdojo` history files; shared CSS, shared data logic, canonical x1 playback rate; transactional file open preserves current document on failure; bonded-group analysis and automatic file-type detection
- **Shared history modules** — `src/history/` provides v1 schema types, connected-component computation, bonded-group projection, and bonded-group utilities shared between `lab/` and `watch/`; `src/ui/` provides shared review-parity CSS

## Project Goal

Build an immersive, interactive, scientifically accurate browser-based playground for carbon nanostructures (C60, graphene, CNTs, diamond). Users can explore, drag, rotate, and interact with real molecular dynamics simulations in real-time.
