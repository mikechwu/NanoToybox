# ML Surrogate

## Status: Explored, Deferred

The ML surrogate was explored in development phases simdev7–simdev9. Key conclusion: **analytical Tersoff in Wasm is faster than ML for all target system sizes (<1000 atoms)**. ML work is preserved for future use.

## Force Decomposition

```
F_total = F_2body + F_residual
```

- `F_2body`: analytical Tersoff pair forces with bond-order b=1 (no angular modulation)
- `F_residual`: everything else (angular/bond-order effects) — this is the ML learning target

Implemented in `sim/potentials/tersoff.py`:
- `compute_2body_forces(positions)` → (energy, forces)
- `compute_force_decomposition(positions)` → dict with total, 2body, residual

**Important:** This is a computational decomposition relative to the chosen analytical baseline, not a fundamental physical 3-body force.

## Descriptors

Two versions of atom-centered symmetry functions (Behler-Parrinello style):

| Version | File | Dimension | Angular functions |
|---------|------|-----------|-------------------|
| v1 | `ml/descriptors.py` | 12 | 4 (insufficient for C60) |
| v2 | `ml/descriptors_v2.py` | 36 | 24 (sufficient for C60) |

All descriptors are rotation- and translation-invariant.

## Pilot Results

| Model | Train | Test MAE | C60 Rollout | Speedup |
|-------|-------|----------|-------------|---------|
| MLP(64,64) + 12D desc | 22k atoms | 0.925 eV/Å | UNSTABLE | 1.18x |
| MLP(128,128,64) + 36D desc | 28k atoms | 0.922 eV/Å | STABLE | 0.86x |

### Why C60 v1 Failed
All 60 C60 atoms had identical 12D descriptors (2% unique) — the descriptor couldn't distinguish subtly different angular environments. v2's 24 angular functions resolved this.

### Why ML is Slower
Descriptor computation scales as O(N·neighbors²) — the same complexity as the analytical 3-body force. In Python, descriptors are actually slower. In C++, both would be similar speed. **No net advantage.**

## When to Restart ML

| Trigger | Justification |
|---------|---------------|
| Systems >1000 atoms | Analytical Wasm becomes >16 ms/step |
| GNN architecture available | Avoids explicit descriptor computation |
| Multi-element potentials | Tersoff is carbon-only |
| DFT-accuracy needed | Tersoff is empirical |

## Dataset

22 datasets in `data/`, each with `positions.npy`, `forces_total.npy`, `forces_2body.npy`, `forces_residual.npy`, `energies.npy`, `metadata.json`.

Total: ~800 frames across equilibrium, perturbation (0.02–0.10 Å), thermal (50–500K), and strain (±1–3%) cases.

## Code Location

```
ml/
├── descriptors.py      # v1 (12D) — historical
├── descriptors_v2.py   # v2 (36D) — current
├── train_pilot.py      # v1 training
├── train_v2.py         # v2 training
├── rollout_test.py     # MD rollout with ML forces
├── diagnose_c60.py     # C60 failure analysis
└── models/             # Saved sklearn models (.pkl)
```
