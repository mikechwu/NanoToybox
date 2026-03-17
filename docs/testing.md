# Testing & Validation

## Test Ladder

Tests are numbered in order of complexity. Earlier tests must pass before later tests are meaningful.

| Test | File | What it validates | Pass criteria |
|------|------|-------------------|---------------|
| 1 | `test_01_dimer.py` | 2-body pair forces | Energy continuity, F≈-dE/dr (<1e-3), NVE drift <1e-4 |
| 2 | `test_02_angular.py` | 3-body angular forces | Energy varies with angle, force consistency (<1e-3) |
| 3 | `test_03_graphene.py` | Many-body flat system | Bond length ~1.42±5%, NVE drift <1e-3, no collapse |
| 4 | `test_04_c60.py` | Full curved system | 90/90 bonds preserved, NVE drift <1e-3 |
| 5 | `test_05_static_validation.py` | 0K relaxation | All systems converge to Fmax <1e-3, structures stationary at 0K |
| 6 | `test_06_perturbation.py` | Near-equilibrium response | Energy increases on perturbation, oscillates back, no instability |
| 7 | `test_07_multiатом_forces.py` | Multi-atom force accuracy | Finite-diff on relaxed C60/graphene, max error <1e-3 |
| 8 | `test_08_data_loading.py` | ML data pipeline | NPY shapes correct, decomposition verified, no NaN |

## Running Tests

```bash
# Run individual test
python3 tests/test_01_dimer.py

# Run all tests sequentially
for t in tests/test_0*.py; do echo "=== $t ===" && python3 "$t" || echo "FAILED"; done
```

Each test prints PASS/FAIL and returns exit code 0 (pass) or 1 (fail).

## Test Details

### Test 1: 2-Atom Dimer
- Sweeps distance r across cutoff region
- Checks energy is zero beyond cutoff (continuity)
- Verifies F = -dE/dr via finite difference at 7 distances (ε=1e-5 Å)
- Runs 10,000-step NVE with small initial velocity
- **Key metric:** force relative error < 1e-3, NVE drift < 1e-4

### Test 2: 3-Atom Angular
- 3 atoms with variable angle θ (60°–180°)
- Verifies energy varies meaningfully (>0.01 eV range)
- Finite-difference force check at 5 angles, all 9 force components
- **Key metric:** force error < 1e-3, angular sensitivity confirmed

### Test 3: Small Graphene
- 18-atom graphene patch (3×3 cells)
- Thermalized at 50K, 5000-step NVE
- Checks average bond length within 5% of 1.42 Å
- **Key metric:** structural stability, NVE conservation

### Test 4: C60
- 60-atom Buckminsterfullerene
- Thermalized at 100K, 5000-step NVE
- Checks all 90 bonds preserved, radius of gyration stable
- **Key metric:** no bond breaking, NVE drift < 1e-3

### Test 5: Static Validation
- Relaxes dimer, triangle, graphene, C60 to 0K
- Reports residual forces (must be < 1e-3 eV/Å)
- Runs 0K stability check (100 steps, zero velocity → near-zero displacement)
- Saves relaxed structures

### Test 6: Perturbation
- Starts from relaxed structures
- Applies ±0.05 Å random perturbation
- Runs 500-step NVE, verifies sensible oscillation
- **Key metric:** energy increases on perturbation, no explosion

### Test 7: Multi-Atom Forces
- Finite-difference force check on **relaxed** C60 (180 components) and graphene (54 components)
- ε = 1e-5 Å, checks all atoms in all directions
- **Key metric:** max relative error < 1e-3

### Test 8: Data Loading
- Loads all datasets in `data/`
- Verifies NPY array shapes match metadata
- Confirms F_total = F_2body + F_residual to machine precision
- Checks train/val/test split validity

## Output Artifacts

Each test writes results to `outputs/testN_*/`:
- `energy.csv` — energy time series
- `trajectory.xyz` — atomic trajectories
- `energy_components.png` — energy plot (if matplotlib available)

## When to Run Tests

- After **any change** to `sim/potentials/tersoff.py` or `tersoff_fast.py`
- After changing `sim/integrators/velocity_verlet.py`
- After modifying `sim/minimizer.py`
- After modifying structure generators
- Before generating ML training data
- Before claiming any validation result
