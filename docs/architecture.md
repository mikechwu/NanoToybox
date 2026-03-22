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
│   └── io/
│       └── output.py             # XYZ trajectory + CSV energy writers
│   └── wasm/
│       ├── tersoff.c             # C Tersoff kernel for Wasm (Emscripten)
│       └── Makefile              # Build: emcc -O3 -ffast-math → page/wasm/
├── tests/                        # 8 validation tests (see testing.md)
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
│   ├── index.html                # HTML shell, UI controls, settings sheet
│   ├── bench/                    # Performance benchmarks
│   │   ├── bench-physics.html    # Physics-only microbench (per-stage timing)
│   │   ├── bench-render.html     # Raw Three.js renderer microbench (3 modes)
│   │   ├── bench-distance.html   # Tersoff kernel benchmark (production on-the-fly)
│   │   ├── bench-celllist.html   # Cell-list equivalence validation
│   │   ├── bench-preWasm.html    # Pre-Wasm evaluation suite (validation + profiling + scaling)
│   │   ├── bench-kernel-profile.html  # Kernel stage profiling
│   │   ├── bench-wasm.html       # Wasm kernel benchmarks
│   │   ├── bench-spread.html     # Spread-domain sparse-grid benchmark (9-case span sweep)
│   │   └── bench-scenes.js       # Shared scene generator
│   ├── wasm/                     # Pre-built Wasm kernel (committed binaries)
│   │   ├── tersoff.wasm          # Compiled C Tersoff kernel
│   │   └── tersoff.js            # Emscripten glue code
│   ├── js/
│   │   ├── main.js               # Composition root + runtime orchestration
│   │   ├── scene.js              # Scene commit/clear/load (transaction-safe)
│   │   ├── placement.js          # Placement lifecycle, tangent computation, canvas listeners
│   │   ├── interaction.js        # Command dispatch, screen-to-physics projection
│   │   ├── status.js             # Status text, hint fade
│   │   ├── ui/
│   │   │   ├── overlay.js        # Sheet open/close, backdrop, help drill-in
│   │   │   ├── dock.js           # Buttons, placement mode, mode segmented
│   │   │   └── settings-sheet.js # Sliders, segmented controls, stat rows
│   │   ├── shared/
│   │   │   ├── segmented.js      # Segmented control wiring utility (returns disposer)
│   │   │   └── require-el.js     # Fail-fast DOM ref validation
│   │   ├── config.js             # Centralized page configuration
│   │   ├── physics.js            # Tersoff force engine + interaction forces
│   │   ├── renderer.js           # Three.js scene, InstancedMesh, PBR materials
│   │   ├── input.js              # Mouse/touch input, raycasting
│   │   ├── state-machine.js      # Interaction state transitions
│   │   ├── loader.js             # Structure library loader + bond topology
│   │   ├── fps-monitor.js        # Frame time measurement
│   │   ├── themes.js             # Theme definitions + CSS token bridge
│   │   └── tersoff-wasm.js       # Wasm kernel bridge
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
6. **Centralized page config** — all tuning constants, thresholds, and defaults in `page/js/config.js`; no scattered magic numbers

### Composition Root Pattern

`main.js` creates all subsystems (renderer, physics, stateMachine) and all UI controllers (overlay, dock, settingsSheet, placement, statusCtrl). Controllers receive dependencies at construction time — they do not import session, physics, or renderer directly.

Cross-controller communication uses callbacks wired by main.js. Controllers may import shared utilities (`segmented.js`, `require-el.js`) and domain modules (`loader.js`, `config.js`, `themes.js`) directly.

### State Ownership

Each state slice has one authoritative writer. Other modules emit intents via callbacks; the authoritative writer applies mutations.

| State slice | Authoritative writer | Intent sources |
|-------------|---------------------|---------------|
| `session.scene` | scene.js (commit/clear) | settings-sheet (clear button), placement (commit) |
| `session.playback` | main.js (frame loop) | dock (pause intent), settings-sheet (speed intent) |
| `session.interactionMode` | main.js (via dock intent) | dock (mode segmented) |
| `session.theme` | main.js (via settings intent) | settings-sheet (theme segmented) |
| placement state | placement.js (`_state`) | dock (add/cancel intents) |
| scheduler / effectsGate | main.js (frame loop only) | — |

### App Lifecycle

- **Construction:** `init()` creates all subsystems and controllers
- **Runtime:** `frameLoop()` gated by `_appRunning` flag
- **Teardown:** `destroyApp()` stops the frame loop, removes all global listeners, destroys all controllers and subsystems, nulls refs, and resets session/scheduler/effectsGate state
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
