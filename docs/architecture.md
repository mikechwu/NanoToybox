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
│   ├── index.html                # HTML shell, UI controls, advanced settings panel
│   └── js/
│       ├── main.js               # Entry point, frame loop, command dispatch
│       ├── physics.js            # Tersoff force engine (full analytical, optimized JS)
│       ├── renderer.js           # Three.js scene, PBR materials, ViewHelper axes
│       ├── input.js              # Mouse/touch input, raycasting, camera-plane projection
│       ├── state-machine.js      # Interaction states (idle/hover/drag/rotate/camera)
│       ├── loader.js             # Structure library loader + bond topology
│       ├── fps-monitor.js        # Frame time measurement + degradation tiers
│       └── themes.js             # Dark/light theme definitions
├── viewer/
│   └── index.html                # Three.js pre-computed trajectory viewer
├── data/                         # ML training/test datasets (NPY + metadata)
├── ml/                           # ML surrogate code (deferred — see ml-surrogate.md)
├── outputs/                      # Test output artifacts (energy CSVs, trajectories, plots)
├── .reports/                     # Research proposals + dev reports (history)
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

## External Dependencies

| Package | Required | Purpose |
|---------|----------|---------|
| numpy | Yes | Core numerics |
| numba | Recommended | 250-480x speedup for force evaluation |
| matplotlib | Optional | Plot generation |
| scipy | Optional | .mat file loading (optional fullerene import) |
| scikit-learn | Optional | ML pilot training |
