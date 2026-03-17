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
| [Viewer](viewer.md) | Three.js trajectory viewer, usage, integration |
| [Project Decisions](decisions.md) | Key strategic decisions and their rationale |
| [Contributing](contributing.md) | How to continue development, rules, workflow |

## Quick Start

```bash
# Run all validation tests (requires numpy, matplotlib)
python3 tests/test_01_dimer.py
python3 tests/test_02_angular.py
# ... through test_08

# Generate a relaxed structure
python3 scripts/library_cli.py c60
python3 scripts/library_cli.py cnt 5 5 --cells 5

# List the structure library
python3 scripts/library_cli.py list

# Open the trajectory viewer
open viewer/index.html
```

## Project Goal

Build an immersive, interactive, scientifically accurate browser-based playground for carbon nanostructures (C60, graphene, CNTs, diamond). Users can explore, rotate, and watch real molecular dynamics simulations in real-time.

## Current Status

- Analytical Tersoff simulator: validated (8 tests pass)
- Structure library: 15 canonical relaxed structures (60–720 atoms)
- Numba-accelerated force engine: 250–480x faster than pure Python
- Three.js trajectory viewer: functional
- ML surrogate: explored, deferred (analytical is faster for target system sizes)
- **Next step: port Tersoff to C/Wasm and connect to viewer for browser deployment**
