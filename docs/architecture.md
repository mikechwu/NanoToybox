# Architecture

## Repository Structure

```
NanoToybox/
├── sim/                          # Core simulation engine
│   ├── atoms.py                  # Atom container (positions, velocities, forces, KE, temperature)
│   ├── minimizer.py              # Energy minimizers (steepest descent + FIRE)
│   ├── potentials/
│   │   ├── tersoff.py            # Pure Python Tersoff potential (reference)
│   │   └── tersoff_fast.py       # Numba JIT-compiled Tersoff (250-480x faster)
│   ├── integrators/
│   │   └── velocity_verlet.py    # Velocity Verlet NVE integrator
│   ├── structures/
│   │   ├── generate.py           # Geometry generators (CNT, graphene, C60, diamond)
│   │   ├── generators.py         # Legacy generators (used by some tests)
│   │   └── library.py            # Structure catalog with CATALOG dict
│   ├── io/
│   │   └── output.py             # XYZ trajectory + CSV energy writers
│   └── wasm/
│       ├── tersoff.c             # C Tersoff kernel for Wasm (Emscripten)
│       └── Makefile              # Build: emcc -O3 -fno-math-errno -ffinite-math-only → page/wasm/
├── tests/                        # Python validation + JS unit + E2E suites (see testing.md)
├── scripts/                      # CLI tools and analysis scripts
│   ├── library_cli.py            # Structure library management CLI
│   ├── plot_energy.py            # Energy curve plotting
│   ├── plot_bonds.py             # Bond histogram plotting
│   ├── plot_angles.py            # Angle distribution plotting
│   ├── bottleneck_analysis.py    # Performance profiling
│   ├── scaling_analysis.py       # N-scaling benchmarks (analytical vs ML)
│   ├── scaling_research.py       # Real-time limit research (collisions, rendering, data)
│   ├── product_scaling.py        # Website feasibility benchmarks
│   └── generate_*.py             # Dataset generation scripts
├── structures/
│   └── library/                  # 15 canonical relaxed 0K structures (XYZ + manifest.json)
├── page/                         # Interactive carbon playground (real-time simulation)
│   ├── index.html                # HTML shell + #react-root mount + #hint surface
│   ├── bench/                    # Performance benchmarks
│   │   ├── bench-physics.html    # Physics-only microbench (per-stage timing)
│   │   ├── bench-render.html     # Raw Three.js renderer microbench (3 modes)
│   │   ├── bench-distance.html   # Tersoff kernel benchmark (production on-the-fly)
│   │   ├── bench-celllist.html   # Cell-list equivalence validation
│   │   ├── bench-preWasm.html    # Pre-Wasm evaluation suite (validation + profiling + scaling)
│   │   ├── bench-kernel-profile.html  # Kernel stage profiling
│   │   ├── bench-wasm.html       # Wasm kernel benchmarks
│   │   ├── bench-spread.html     # Spread-domain sparse-grid benchmark (9-case span sweep)
│   │   └── bench-scenes.ts       # Shared scene generator
│   ├── wasm/                     # Pre-built Wasm kernel (committed binaries)
│   │   ├── tersoff.wasm          # Compiled C Tersoff kernel
│   │   └── tersoff.js            # Emscripten glue code
│   ├── js/
│   │   ├── main.ts               # Composition root — wires subsystems, delegates to runtime/
│   │   ├── runtime/              # Runtime modules extracted from main.ts
│   │   │   ├── scene-runtime.ts      # Scene mutation wrappers + scene-to-UI projection
│   │   │   ├── worker-lifecycle.ts   # Worker bridge creation, init, stall detection, teardown
│   │   │   ├── snapshot-reconciler.ts # Worker snapshot → physics/renderer reconciliation
│   │   │   ├── overlay-layout.ts     # Hint clearance + triad sizing (RAF-coalesced, ResizeObserver)
│   │   │   ├── overlay-runtime.ts    # Overlay open/close policy (Escape, outside-click)
│   │   │   ├── interaction-dispatch.ts # Interaction command effects + worker mirroring
│   │   │   ├── input-bindings.ts     # InputManager construction, sync, callback wiring
│   │   │   ├── ui-bindings.ts        # Zustand store callback registration
│   │   │   ├── atom-source.ts        # Renderer-to-input atom-picking adapter
│   │   │   ├── focus-runtime.ts     # Focus resolution: molecule lookup, centroid, pivot update
│   │   │   └── onboarding.ts        # Coachmark scheduling, pacing, persistence, achievements
│   │   ├── scene.ts              # Scene commit/clear/load (transaction-safe)
│   │   ├── placement.ts          # Placement lifecycle, tangent computation, canvas listeners
│   │   ├── interaction.ts        # Command dispatch, screen-to-physics projection
│   │   ├── status.ts             # Hint fade + contextual coachmarks (hint-only)
│   │   ├── ui/
│   │   │   └── coachmarks.ts     # Onboarding copy and IDs (placement, future hints)
│   │   ├── components/           # React-authoritative UI components
│   │   │   ├── DockLayout.tsx    # Dock positioning wrapper ([data-dock-root] measurement root)
│   │   │   ├── DockBar.tsx       # Toolbar (add, pause, settings, mode; role="toolbar")
│   │   │   ├── Segmented.tsx     # Shared native-radio segmented control
│   │   │   ├── SettingsSheet.tsx # Settings sheet with all controls
│   │   │   ├── StructureChooser.tsx # Structure picker sheet
│   │   │   ├── SheetOverlay.tsx  # Sheet backdrop
│   │   │   ├── StatusBar.tsx     # Scene status display
│   │   │   ├── FPSDisplay.tsx    # FPS/simulation status
│   │   │   ├── CameraControls.tsx # Mode chip, "?" help glyph, Center Object / Return action
│   │   │   └── QuickHelp.tsx    # Mode-aware gesture reference card
│   │   ├── store/
│   │   │   ├── app-store.ts      # Zustand store for UI state
│   │   │   └── selectors/
│   │   │       ├── dock.ts       # selectDockSurface derived selector
│   │   │       └── camera.ts    # selectCameraMode selector + CameraMode type
│   │   ├── hooks/
│   │   │   └── useSheetAnimation.ts # Sheet open/close CSS transitions
│   │   ├── react-root.tsx        # React mount/unmount entry point
│   │   ├── config.ts             # Centralized page configuration
│   │   ├── physics.ts            # Tersoff force engine + interaction forces
│   │   ├── renderer.ts           # Three.js scene, InstancedMesh, PBR materials, orbit + interactive triad
│   │   ├── orbit-math.ts         # Pure orbit math: arcball deltas, rigid rotation, shared constants
│   │   ├── input.ts              # Mouse/touch input, raycasting, triad drag/tap/snap, background orbit
│   │   ├── state-machine.ts      # Interaction state transitions
│   │   ├── loader.ts             # Structure library loader + bond topology
│   │   ├── format-status.ts      # Shared FPS/status text formatter
│   │   ├── scheduler-pure.ts     # Pure-function scheduler computations
│   │   ├── simulation-worker.ts  # Web Worker for off-thread physics
│   │   ├── worker-bridge.ts      # Main↔Worker bridge protocol
│   │   ├── themes.ts             # Theme definitions + CSS token bridge
│   │   └── tersoff-wasm.ts       # Wasm kernel bridge
├── viewer/
│   └── index.html                # Three.js pre-computed trajectory viewer
├── data/                         # ML training/test datasets (NPY + metadata)
├── ml/                           # ML surrogate code (deferred — see ml-surrogate.md)
├── outputs/                      # Test output artifacts (energy CSVs, trajectories, plots)
└── docs/                         # This documentation
```

## Module Dependencies

```
sim/atoms.py                      ← no dependencies
sim/potentials/tersoff.py         ← numpy only
sim/potentials/tersoff_fast.py    ← numpy + numba
sim/integrators/velocity_verlet.py ← sim.atoms
sim/minimizer.py                  ← sim.atoms
sim/structures/generate.py        ← sim.atoms
sim/io/output.py                  ← numpy, pathlib
```

## Data Flow

### Simulation Pipeline
```
Structure Generator → Atoms → Minimizer → Relaxed Atoms → Integrator → Trajectory
       ↓                                       ↓                          ↓
   generate.py                          library_cli.py              output.py
   (geometry)                          (relax + save)           (XYZ + CSV)
```

### Collision Research Pipeline
```
Library Structures → Place + Gap → Assign Velocities → NVE Dynamics → Monitor → Trajectory
        ↓                ↓               ↓                  ↓             ↓
  structures/library/  place_for_    set_collision_     vv_step()    min_dist,
  (relaxed 0K)         collision()   velocities()                   PE, KE, COM
```

### ML Pipeline (deferred)
```
Trajectory → Force Decomposition → NPY Export → Descriptors → MLP → Predicted Forces
                  ↓                     ↓            ↓
          tersoff.py              generate_*.py  descriptors_v2.py
    (F_total, F_2body, F_resid)    (data/)        (ml/)
```

## Key Design Decisions

1. **Python reference + Numba acceleration** — pure Python for correctness, Numba for speed
2. **Tersoff potential only** — empirical but well-validated for carbon; sufficient for visualization
3. **No periodic boundaries** — all structures are finite/free-standing (simplifies force calculation)
4. **XYZ format throughout** — human-readable, viewer-compatible, ASE-compatible
5. **Analytical first, ML later** — ML explored and deferred; analytical is faster for <1000 atoms
6. **Centralized page config** — all tuning constants, thresholds, and defaults in `page/js/config.ts`; no scattered magic numbers

### Composition Root Pattern

`main.ts` (~1070 lines) is the composition root: it creates all subsystems (renderer, physics, stateMachine), mounts the React UI, owns the frame loop and scheduler, and wires global listeners. Runtime responsibilities are delegated to 11 modules in `page/js/runtime/`:

- **scene-runtime.ts** — scene mutation wrappers, scene-to-store projection, worker scene mirroring
- **worker-lifecycle.ts** — worker bridge creation, init, stall detection (5s warning / 15s fatal), teardown
- **snapshot-reconciler.ts** — worker snapshot → physics position sync, atom-remap handling, bond refresh
- **overlay-layout.ts** — hint clearance and triad sizing/positioning (RAF-coalesced, ResizeObserver)
- **overlay-runtime.ts** — overlay open/close policy (Escape, outside-click, device-mode switch)
- **interaction-dispatch.ts** — interaction command side effects and worker mirroring (flick ordering)
- **input-bindings.ts** — InputManager construction, sync (scene-mutation resync contract)
- **ui-bindings.ts** — Zustand store callback registration (React intents → imperative commands)
- **atom-source.ts** — shared renderer-to-input atom-picking adapter
- **focus-runtime.ts** — focus resolution: molecule lookup, centroid computation, camera pivot update
- **onboarding.ts** — coachmark scheduling, pacing, persistence, achievement-triggered progressive hints

React components (DockLayout, DockBar, Segmented, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay, CameraControls, QuickHelp) are authoritative for all UI surfaces. Imperative controllers remain only for PlacementController and StatusController (hint-only).

`main.ts` must not be re-grown: new runtime logic goes into `page/js/runtime/`, new UI surfaces into `page/js/components/`.

### State Ownership

Each state slice has one authoritative writer. Other modules emit intents via callbacks; the authoritative writer applies mutations.

| State slice | Authoritative writer | Intent sources |
|-------------|---------------------|---------------|
| `session.scene` | scene-runtime.ts (commit/clear/add) | React SettingsSheet (clear), PlacementController (commit) |
| `session.playback` | main.ts (frame loop) | React DockBar (pause), React SettingsSheet (speed) |
| `session.interactionMode` | main.ts (via store callback) | React DockBar (mode segmented) |
| Camera mode (`cameraMode`) | Zustand store (`app-store.ts`) | CameraControls chip, Esc key, double-tap center, overlay close |
| Camera focus (`lastFocusedMoleculeId`) | focus-runtime.ts (via store) | interaction-dispatch (orbit), input-bindings (free-look), placement |
| UI chrome (sheets, theme, etc.) | Zustand store (`app-store.ts`) | React components |
| `session.theme` | main.ts (via settings callback) | React SettingsSheet (theme segmented) |
| placement state | placement.ts (`_state`) | React DockBar (add/cancel via dockCallbacks) |
| scheduler / effectsGate | main.ts (frame loop only) | — |

### Overlay Close Policy

Unified outside-click dismiss rule (all devices): a capture-phase `pointerdown` handler on `document` closes the open sheet when the primary pointer hits the backdrop or renderer canvas. Clicks inside either sheet, the dock, or HUD chrome (`#info`, `#fps`, `#hint`) do not dismiss. The event is consumed (`stopPropagation` + `preventDefault`) to prevent canvas interaction from the same gesture. The dock sits above the backdrop in z-order (z-index 205 vs 200) so dock buttons remain interactive while sheets are open.

### Overlay Layout Contract

`overlay-layout.ts` (`createOverlayLayout`) owns bottom-overlay layout arbitration via `doLayout()` (RAF-coalesced). It measures the dock region via `document.querySelector(DOCK_ROOT_SELECTOR)` (`[data-dock-root]` on DockLayout's root element) and `getBoundingClientRect()`, producing separate layout outputs:

- **Hint** (`--hint-bottom` CSS var): always clears the dock top edge + gap
- **Triad** (`renderer.setOverlayLayout({ triadSize, triadLeft, triadBottom })`): interactive camera orbit control on touch devices (drag=rotate, tap=snap-to-axis, double-tap=reset). Phone clears full-width dock; tablet/desktop uses safe-area corner margins. `triadLeft` accounts for `env(safe-area-inset-left)`. Sizes 96–140px on phone, 120–200px on tablet/desktop. `CONFIG.orbit` defines `rotateSpeed` and `triadHitPadding`.

Layout updates are triggered by `window.resize` and a `ResizeObserver` on the `[data-dock-root]` element (DockLayout's root), coalesced to one computation per frame. All dock child surfaces must be in normal document flow inside the measured root so `getBoundingClientRect()` reflects the total bottom-control footprint.

### App Lifecycle

- **Construction:** `init()` creates all subsystems and controllers
- **Runtime:** `frameLoop()` gated by `_appRunning` flag
- **Teardown:** `destroyApp()` stops the frame loop, removes all global listeners (including capture-phase), disconnects the dock `ResizeObserver`, cancels any pending layout RAF, destroys all controllers and subsystems, nulls refs, and resets session/scheduler/effectsGate state
- All controllers expose `destroy()` for listener cleanup
- Renderer GPU disposal is intentionally deferred (browser reclaims on page unload)

## External Dependencies

| Package | Required | Purpose |
|---------|----------|---------|
| numpy | Yes | Core numerics |
| numba | Recommended | 250-480x speedup for force evaluation |
| matplotlib | Optional | Plot generation |
| scipy | Optional | .mat file loading (optional fullerene import) |
| scikit-learn | Optional | ML pilot training |
