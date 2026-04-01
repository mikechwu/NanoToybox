# Contributing & Development Guide

## For New Developers (and New Claude Sessions)

Read these docs in order:
1. `README.md` — project overview and quick start
2. `architecture.md` — where everything lives
3. `physics.md` — how the simulator works
4. `decisions.md` — why things are the way they are

Then run the test suite to verify the codebase is healthy:
```bash
python3 tests/test_01_dimer.py && echo "Test 1 OK"
python3 tests/test_02_angular.py && echo "Test 2 OK"
```

## Ultimate Goal

Build an **immersive, interactive, scientifically accurate browser-based playground** for carbon nanostructures. Users explore C60, graphene, CNTs, and diamond with real-time molecular dynamics running in the browser.

The long-term vision:
- Real physics (Tersoff potential, velocity Verlet)
- Real-time (>30 FPS for 60–300 atom scenes, up to ~2,100 atoms with optimized viewer)
- Beautiful visualization (Three.js, perspective 3D)
- Educational and accessible (not just for specialists)
- Expandable to ML surrogates for larger systems later

Measured limits (see [scaling-research.md](scaling-research.md)):
- Numba Tersoff: 30 FPS up to ~2,100 atoms; C/Wasm (browser): ~3,000–5,000 atoms (measured ~11% faster than JS JIT)
- Interactive page (InstancedMesh + spatial hash + Wasm): ~2,400 atoms at 30 FPS
- Trajectory viewer (`viewer/`): ~250 atoms at 30 FPS (still O(N²) individual meshes)
- Optimized viewer (InstancedMesh + neighbor list): ~5,000–10,000 atoms

## Rules to Obey

### Physics First
1. **Never approximate physics without validation.** Every force implementation must pass finite-difference checks (Tests 1, 2, 7).
2. **Energy conservation is non-negotiable.** NVE drift must be < 1e-3 for any accepted simulation.
3. **All library structures must be relaxed** to Fmax < 1e-3 eV/Å via the multi-minimizer pipeline.
4. **Don't skip the test ladder.** Tests 1-2 must pass before Tests 3-4 are meaningful.

### Code Quality
5. **Use Numba (`tersoff_fast.py`) for production**, pure Python (`tersoff.py`) for reference/validation.
6. **Keep the two implementations in sync.** Any physics change must be made in both files.
7. **Use the library CLI** to add structures — never hand-place atoms in XYZ files.
8. **Explicit Euler is forbidden.** Use velocity Verlet only.

### Architecture
9. **Don't restart ML work** unless >1000 atoms are needed or a GNN framework is available.
10. **Preserve all validation tests.** Don't delete tests even if they seem redundant.
11. **Don't add periodic boundaries** unless there's a clear product need.

### Process
12. **Run tests before claiming anything works.**
13. **Document decisions** in `docs/decisions.md` when making significant changes.
14. **Update `manifest.json`** when modifying the structure library.

## Completed Milestones

- Real-time Tersoff simulation in the browser (`page/js/physics.ts`)
- Interactive page with drag/rotate/structure presets (`page/index.html`)
- Camera-plane force projection (forces align with user's visual perspective)
- Inertia-normalized rotation (consistent feel across molecule sizes)
- Interactive 3D axis triad (drag=orbit, tap=snap, double-tap=reset on mobile), dark/light themes, dock + sheet settings
- InstancedMesh rendering — 2 draw calls for atoms+bonds, geometric capacity growth (`page/js/renderer.ts`)
- On-the-fly Tersoff kernel — 45% faster than cached at 2040 atoms, eliminates 127 MB N×N cache (`page/js/physics.ts`)
- Cell-list spatial acceleration — O(N) neighbor and bond detection instead of O(N²) (`page/js/physics.ts`)
- C/Wasm Tersoff kernel — ~11% faster than JS JIT, enabled by default, automatic JS fallback (`sim/wasm/`, `page/js/tersoff-wasm.ts`)
- Containment boundary — dynamic soft harmonic wall (`page/js/physics.ts`), Contain/Remove toggle, live atom count, auto-scaling radius with hysteresis shrinkage
- Dock + sheet navigation — responsive two-tier UI with React components (`page/js/components/`)
- React UI migration — primary surfaces (DockLayout, DockBar, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay, CameraControls, OnboardingOverlay, BondedGroupsPanel, TimelineBar) are React-authoritative with Zustand store. Supporting subcomponents: Segmented, Icons, TimelineActionHint
- Web Worker physics — off-thread simulation via `page/js/simulation-worker.ts` with automatic JS fallback
- Runtime module extraction — 24 modules in `page/js/runtime/` (summary: scene, worker, snapshot, overlay, interaction, input, UI bindings, focus, onboarding, bonded-groups, timeline, restart, reconciled-steps, orbit-follow-update, drag-target-refresh); see `docs/architecture.md` for the full module-by-module inventory. main.ts reduced to composition-root-only
- Object View panel — Center + Follow buttons with inline SVG icons, positioned below status block
- Page-load onboarding overlay — welcome card with sink-to-Settings animation, page-lifetime dismissal

## Architecture Rules

See `docs/architecture.md` for the full module map and state ownership model.

- **React components are the sole UI authority.** Primary surfaces (DockLayout, DockBar, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay, CameraControls, OnboardingOverlay, BondedGroupsPanel, TimelineBar) are React-authoritative. Supporting subcomponents (Segmented, Icons, TimelineActionHint) are composed by those surfaces; some are pure prop-driven helpers.
- **Imperative controllers** remain only for PlacementController (canvas touch listeners) and StatusController (hint/coachmark surface). Both expose `destroy()`.
- **Callbacks flow through the store.** React components invoke imperative callbacks (dockCallbacks, settingsCallbacks, chooserCallbacks) registered by main.ts into the Zustand store.
- **New globals require teardown.** Register via `addGlobalListener()` in main.ts.
- **Do not re-grow main.ts.** Extract new runtime logic into `page/js/runtime/` and new UI surfaces into `page/js/components/`.
- **State writes go through authoritative writers.** See state ownership table in architecture.md.

## Next Steps (Priority Order)

### 1. Expand Structure Library
- More CNT chiralities, larger graphene sheets
- Multi-structure collision presets

### 3. Viewer Modernization
- Port trajectory viewer (`viewer/index.html`) to InstancedMesh + spatial hash
- Currently limited to ~250 atoms at 30 FPS due to individual meshes + O(N²) bonds

### 4. ML (Future, When Needed)
- GNN architecture for >5,000 atoms where Wasm is too slow
- Use existing data pipeline and force decomposition code

## Development Workflow

### TypeScript / React (interactive page)

```
1. npm run dev                    # Vite dev server with HMR
2. Make changes to page/js/ code
3. npm run typecheck              # TypeScript type-checking
4. npm run test:unit              # Vitest unit suite
5. npm run test:e2e               # Playwright E2E suite
6. npm run build                  # Production build → dist/
```

### Debug Query Params

The app supports URL-based debug overrides via `getDebugParam()` in `config.ts`.
All debug params must be routed through this single reader.

| Param | Effect | Used by |
|-------|--------|---------|
| `?kernel=js\|wasm` | Force physics kernel | `physics.ts` |
| `?e2e=1` | Suppress onboarding overlay | `runtime/onboarding.ts` |

E2E tests inject `?e2e=1` via `gotoApp()` from `tests/e2e/helpers.ts`.

### Python (simulation engine)

```
1. Make changes to sim/ code
2. python -m pytest tests/test_*.py -v
3. If adding structures: python scripts/library_cli.py <command>
4. If changing force engine: verify tersoff.py and tersoff_fast.py match
5. Document significant changes in docs/decisions.md
6. Update docs/ if architecture or decisions change
```

## Key Files to Know

| If you're working on... | Read these files |
|--------------------------|-----------------|
| Interactive page | `page/index.html`, `page/js/main.ts`, `page/js/components/*`, `page/js/store/app-store.ts`, `docs/viewer.md` |
| React UI components | `page/js/components/*.tsx`, `page/js/store/app-store.ts`, `page/js/hooks/*`, `page/js/react-root.tsx` |
| Web Worker / bridge | `page/js/simulation-worker.ts`, `page/js/worker-bridge.ts`, `src/types/worker-protocol.ts` |
| Runtime modules (scene, worker, input) | `page/js/runtime/scene-runtime.ts`, `page/js/runtime/worker-lifecycle.ts`, `page/js/runtime/snapshot-reconciler.ts`, `page/js/runtime/input-bindings.ts`, `page/js/runtime/interaction-dispatch.ts` |
| Overlay layout & open/close policy | `page/js/runtime/overlay-layout.ts`, `page/js/runtime/overlay-runtime.ts` |
| Focus resolution & onboarding | `page/js/runtime/focus-runtime.ts`, `page/js/runtime/onboarding.ts`, `page/js/components/OnboardingOverlay.tsx` |
| Object View & icons | `page/js/components/CameraControls.tsx`, `page/js/components/Icons.tsx` |
| E2E test helpers | `tests/e2e/helpers.ts` (gotoApp), `tests/e2e/camera-onboarding.spec.ts` |
| Bonded clusters (panel + highlight) | `page/js/runtime/bonded-group-runtime.ts`, `page/js/runtime/bonded-group-highlight-runtime.ts`, `page/js/runtime/bonded-group-coordinator.ts`, `page/js/components/BondedGroupsPanel.tsx` |
| Store callback wiring | `page/js/runtime/ui-bindings.ts`, `page/js/store/app-store.ts` |
| Scene / placement | `page/js/scene.ts`, `page/js/placement.ts` |
| Browser physics | `page/js/physics.ts` (JS Tersoff), `sim/wasm/tersoff.c` (Wasm kernel) |
| Force calculation (Python) | `sim/potentials/tersoff.py`, `tersoff_fast.py` |
| Running simulations | `sim/integrators/velocity_verlet.py`, `sim/atoms.py` |
| Adding structures | `sim/structures/generate.py`, `scripts/library_cli.py` |
| Collision simulations | `scripts/scaling_research.py`, `docs/scaling-research.md` |
| Trajectory viewer | `viewer/index.html` |
| Validation | `tests/test_01_dimer.py` through `test_08_data_loading.py` |
| Performance & scaling | `scripts/scaling_research.py`, `docs/scaling-research.md` |

## Environment Setup

```bash
# Required
pip install numpy

# Strongly recommended (250-480x speedup)
pip install numba

# For plotting
pip install matplotlib

# For optional .mat file loading
pip install scipy

# For ML experiments (currently deferred)
pip install scikit-learn
```
