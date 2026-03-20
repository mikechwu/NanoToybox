# NanoToybox Developer Documentation

Welcome to the NanoToybox project — a browser-based interactive carbon nanostructure simulation playground.

## Documentation Index

| Document | Purpose |
|----------|---------|
| [Architecture](architecture.md) | System overview, module map, data flow |
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
# Launch the interactive page (requires serving from repo root)
python3 -m http.server 8000
# Open http://localhost:8000/page/

# Run all validation tests (requires numpy, matplotlib)
python3 tests/test_01_dimer.py
python3 tests/test_02_angular.py
# ... through test_08

# Generate a relaxed structure
python3 scripts/library_cli.py c60
python3 scripts/library_cli.py cnt 5 5 --cells 5

# List the structure library
python3 scripts/library_cli.py list
```

## Project Goal

Build an immersive, interactive, scientifically accurate browser-based playground for carbon nanostructures (C60, graphene, CNTs, diamond). Users can explore, drag, rotate, and interact with real molecular dynamics simulations in real-time.

## Current Status

- **Interactive page: live** (`page/index.html`) — real-time Tersoff simulation in the browser with drag, rotate, multi-molecule playground, speed control, and advanced settings
- **Performance optimized**: InstancedMesh rendering (2 draw calls), on-the-fly Tersoff kernel (45% faster), cell-list neighbor/bond search (O(N) instead of O(N²))
- Analytical Tersoff simulator: validated (8 tests pass) in Python, ported to JavaScript for browser
- Structure library: 15 canonical relaxed structures (60–720 atoms)
- Numba-accelerated force engine: 250–480x faster than pure Python (for server-side use)
- Three.js trajectory viewer: functional at `viewer/index.html` (pre-computed trajectory playback)
- Scaling research: completed — real-time limit ~2,100 atoms (Numba)
- Collision simulations: 8 verified scenarios with relaxed structures (120–3,600 atoms)
- ML surrogate: explored, deferred (analytical is faster for target system sizes)
- Performance benchmarks in `page/bench/` (physics, renderer, kernel, cell-list validation)
- **Wasm Tersoff kernel**: deployed and enabled by default (~11% faster than JS JIT, automatic JS fallback)
- **Next steps**: Web Workers for responsiveness, viewer modernization
