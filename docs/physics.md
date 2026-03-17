# Physics & Simulation

## Tersoff Potential

The simulator implements the Tersoff (1988) empirical potential for carbon. Reference: J. Tersoff, Phys. Rev. B 39, 5566 (1989).

### Energy Expression

```
E = Σ_i Σ_{j>i} f_c(r_ij) · [f_R(r_ij) + b_ij · f_A(r_ij)]
```

| Term | Formula | Role |
|------|---------|------|
| f_R(r) | A · exp(-λ₁ · r) | Repulsive pair interaction |
| f_A(r) | -B · exp(-λ₂ · r) | Attractive pair interaction |
| f_c(r) | Smooth cosine cutoff between R-D and R+D | Smoothly turns off interactions |
| b_ij | (1 + (β·ζ_ij)^n)^(-1/2n) | Bond-order: weakens attraction in crowded environments |
| ζ_ij | Σ_k f_c(r_ik)·g(θ_ijk) | Sum of angular contributions from all third atoms k |
| g(θ) | 1 + c²/d² - c²/(d²+(h-cosθ)²) | Angular function favoring certain bond angles |

### Carbon Parameters

| Parameter | Value | Unit |
|-----------|-------|------|
| λ₁ | 3.4879 | Å⁻¹ |
| λ₂ | 2.2119 | Å⁻¹ |
| A | 1393.6 | eV |
| B | 346.74 | eV |
| n | 0.72751 | — |
| β | 1.5724×10⁻⁷ | — |
| c | 38049 | — |
| d | 4.3484 | — |
| h | -0.57058 | — |
| R | 1.95 | Å |
| D | 0.15 | Å |

### Force Derivation

Forces are computed as F = -∇E analytically. The derivative chain includes:
- Pair terms: straightforward df_R/dr, df_A/dr, df_c/dr
- Bond-order: db_ij/dζ_ij · dζ_ij/dr_k (through g(θ) → cosθ → positions)

**This is the most complex part of the code.** The 3-body force involves derivatives through:
```
positions → cos(θ_ijk) → g(θ) → ζ_ij → b_ij → energy
```

Force correctness is validated by finite-difference tests (Tests 1, 2, 7).

### Two Implementations

| File | Engine | Speed (C60) | Use case |
|------|--------|-------------|----------|
| `tersoff.py` | Pure Python | 20 ms | Reference, validation, force decomposition |
| `tersoff_fast.py` | Numba JIT | 0.06 ms | Production relaxation, library building |

Both produce identical results (verified to <0.01 eV/Å difference).

The pure Python version also provides `compute_2body_forces()` and `compute_force_decomposition()` for ML data generation.

## Velocity Verlet Integrator

```
v(t + dt/2) = v(t) + (dt/2) · F(t) / m
r(t + dt)   = r(t) + dt · v(t + dt/2)
F(t + dt)   = ComputeForces(r(t + dt))
v(t + dt)   = v(t + dt/2) + (dt/2) · F(t + dt) / m
```

Properties: symplectic, time-reversible, second-order accurate. Guarantees bounded energy fluctuation with no systematic drift.

**Explicit Euler is forbidden** — it causes catastrophic energy growth for Tersoff carbon.

## Unit System

| Quantity | Unit | Notes |
|----------|------|-------|
| Distance | Ångström (Å) | 10⁻¹⁰ m |
| Time | Femtosecond (fs) | 10⁻¹⁵ s |
| Energy | Electron-volt (eV) | 1.602×10⁻¹⁹ J |
| Force | eV/Å | 1.602×10⁻⁹ N |
| Mass | kg | Carbon: 1.9944×10⁻²⁶ kg |
| Temperature | Kelvin (K) | k_B = 8.617×10⁻⁵ eV/K |

### Unit Conversion (force → acceleration)

```
a (Å/fs²) = F (eV/Å) × 1.602176634×10⁻²⁹ / m (kg)
```

This is defined as `EV_ANGSTROM_TO_ACC` in `velocity_verlet.py`.

## Energy Minimization

Two minimizers available:

### Steepest Descent (adaptive)
- Moves atoms along force direction with adaptive step size
- Backtracking line search: step halved if energy increases
- Max displacement per atom capped at 0.1 Å/step
- Robust for all tested systems

### FIRE (Fast Inertial Relaxation Engine)
- Velocity-based optimizer with inertia
- Faster convergence near minimum
- Can diverge for some systems (e.g., diamond — use SD instead)

### Library CLI Strategy
The `library_cli.py` runs **all three methods** (SD, FIRE, SD+FIRE hybrid) and picks the result with lowest energy among converged solutions.

## Relaxation Quality Criteria

All structures in `structures/library/` must satisfy:
- Fmax < 1×10⁻³ eV/Å
- Energy monotonically decreased during minimization
- Bond lengths in physically reasonable range (1.3–1.6 Å for carbon)

**Critical:** The geometry generators produce coordinates far from equilibrium (Fmax 3–7 eV/Å). Never use generator output directly in MD simulations — always use library structures or relax first. Unrelaxed structures produce artifacts where self-relaxation dominates over applied physics. See [D9 in decisions.md](decisions.md) and [scaling-research.md](scaling-research.md) for details.

## Collision Dynamics

For multi-structure collision simulations, see [scaling-research.md](scaling-research.md) for the validated protocol. Key parameters:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Collision velocity | 0.01 Å/fs (1,000 m/s) | Energetic but physical (~2,400 K thermal) |
| Surface gap | 3.0 Å | Outside Tersoff range (2.1 Å), close enough for quick contact |
| Timestep | 0.5 fs | Standard for Tersoff carbon NVE |
| Aftermath duration | 200–300 fs | Sufficient for post-collision dynamics |

The Tersoff potential has a hard cutoff at R + D = 2.1 Å. Atoms from different structures do not interact at all until they are within this distance. Collision is confirmed by monitoring the inter-structure minimum distance dropping below 2.1 Å.

## Legacy Code Reference

The simulator physics was derived from the NCKU legacy codebase at `~/NCKU/carbon-sim/MPI/`:
- `TersoffC.h` — Force calculation (confirmed production code)
- `TFC.h` / `TFCSA.h` — Integration loop
- `MDcarbonSA.cpp` — Main entry point

The legacy code uses an **exponential** cutoff transition; our implementation uses the standard **cosine** form. Both are smooth and produce similar equilibrium structures.

CNT geometry generation was ported from `~/NCKU/Generate_CNT/` (MATLAB) — using the graphene-sheet-rolling algorithm with chiral vector rotation.

Fullerene coordinates (C60, C180, C540, C720) imported from `~/NCKU/FullereneLib/` (.mat files).
