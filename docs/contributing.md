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
- Real-time (>30 FPS for 60–300 atom scenes)
- Beautiful visualization (Three.js, perspective 3D)
- Educational and accessible (not just for specialists)
- Expandable to ML surrogates for larger systems later

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
10. **The next main task is C/Wasm porting**, not Python optimization or ML improvement.
11. **Preserve all validation tests.** Don't delete tests even if they seem redundant.
12. **Don't add periodic boundaries** unless there's a clear product need.

### Process
13. **Run tests before claiming anything works.**
14. **Document decisions** in `docs/decisions.md` when making significant changes.
15. **Update `manifest.json`** when modifying the structure library.
16. **Write dev reports** for significant implementation milestones.

## Next Steps (Priority Order)

### 1. Port Tersoff to C → WebAssembly
- Translate `sim/potentials/tersoff_fast.py` (or `tersoff.py`) to C
- Compile with Emscripten to Wasm
- Validate: C60 forces must match Python reference to <1e-4
- Connect to `viewer/index.html` via JS bindings

### 2. Real-Time Browser Simulation
- Wasm force engine runs simulation loop
- Each frame: compute forces → Verlet step → send positions to Three.js
- Target: >30 FPS for C60 (estimated 0.06 ms/step in Wasm)

### 3. Website UI
- Structure preset selector (load from library)
- Temperature slider
- Play/pause/reset controls
- Energy display overlay

### 4. Expand Structure Library
- More CNT chiralities
- Larger graphene sheets
- Multi-structure scenes (C60 cluster, C60 on graphene)

### 5. ML (Future, When Needed)
- GNN architecture (avoid explicit descriptors)
- For systems >1000 atoms where analytical is too slow
- Use existing data pipeline and force decomposition code

## Development Workflow

```
1. Make changes to sim/ code
2. Run tests: python3 tests/test_01_dimer.py (etc.)
3. If adding structures: python3 scripts/library_cli.py <command>
4. If changing force engine: verify tersoff.py and tersoff_fast.py match
5. Write dev report in .reports/ for significant milestones
6. Update docs/ if architecture or decisions change
```

## Key Files to Know

| If you're working on... | Read these files |
|--------------------------|-----------------|
| Force calculation | `sim/potentials/tersoff.py`, `tersoff_fast.py` |
| Running simulations | `sim/integrators/velocity_verlet.py`, `sim/atoms.py` |
| Adding structures | `sim/structures/generate.py`, `scripts/library_cli.py` |
| ML pipeline | `ml/descriptors_v2.py`, `ml/train_v2.py` |
| Browser viewer | `viewer/index.html` |
| Validation | `tests/test_01_dimer.py` through `test_08_data_loading.py` |
| Performance | `sim/potentials/tersoff_fast.py`, `scripts/bottleneck_analysis.py` |

## Environment Setup

```bash
# Required
pip install numpy

# Strongly recommended (250-480x speedup)
pip install numba

# For plotting
pip install matplotlib

# For FullereneLib import
pip install scipy

# For ML experiments (currently deferred)
pip install scikit-learn
```
