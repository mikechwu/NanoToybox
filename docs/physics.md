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

In the browser engine this is `ACC_FACTOR` in `page/js/physics.ts`; in the Python engine it is `EV_ANGSTROM_TO_ACC` in `sim/integrators/velocity_verlet.py`.

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

## Implementation Notes

The simulator uses the standard cosine cutoff transition (not the exponential variant found in some implementations). Both are smooth and produce similar equilibrium structures.

### Four implementations

| Implementation | Location | Use |
|---------------|----------|-----|
| Pure Python | `sim/potentials/tersoff.py` | Reference, validation, force decomposition |
| Numba JIT | `sim/potentials/tersoff_fast.py` | Server-side relaxation, library building |
| TypeScript | `page/js/physics.ts` | Browser interactive page (JS fallback kernel) |
| C/Wasm | `sim/wasm/tersoff.c` → `page/wasm/tersoff.wasm` | Browser default (~11% faster than JS JIT) |

All four use identical Tersoff (1988) carbon parameters and produce consistent results.

The Wasm bridge (`tersoff-wasm.ts`) marshals the short neighbor list in CSR format into Wasm memory. The marshal copies exactly `totalNl` live entries, not the full allocated capacity, to avoid stale-data overhead on every step.

### Containment Boundary

The interactive page applies a soft containment boundary to prevent atoms from expanding to arbitrarily large distances (which would degrade spatial hash and rendering performance).

| Parameter | Config key | Default | Description |
|-----------|-----------|---------|-------------|
| Spring constant | `wall.springK` | 5.0 eV/Å² | Harmonic restoring force in Contain mode |
| Target density | `wall.density` | 0.00005 atoms/ų | Determines wall radius from atom count |
| Padding | `wall.padding` | 50 Å | Minimum clearance beyond density-derived radius |
| Remove margin | `wall.removeMargin` | 10 Å | Extra distance past R_wall before removal |
| Shrink hysteresis | `wall.shrinkHysteresis` | 2.0 | Only shrink if R_wall > target × this factor |
| Recenter threshold | `wall.recenterThreshold` | 0.25 | Recenter wall after >25% atoms removed in one event |

**Contain mode:** Harmonic wall force **F** = −K × (r − R\_wall) × **r̂** (radially inward) for atoms beyond R\_wall. Energy conservation maintained at O(dt²).

**Remove mode:** No wall force. Atoms beyond R_wall + removeMargin are deleted. Post-removal: forces recomputed via JS Tersoff kernel (intentional slow-path to avoid CSR re-marshal). Wall radius shrinks with hysteresis; wall center recenters after large asymmetric removals.

**Wall radius:** `R_wall = cbrt(3N / (4π × density)) + padding`. Monotonically increasing in Contain mode. In Remove mode, shrinks when `R_wall > target × shrinkHysteresis`. Resets on scene clear or when all atoms are removed.

### JavaScript Implementation Details

The browser implementation (`page/js/physics.ts`) includes several optimizations beyond a direct port:

- **On-the-fly distance computation** — distances and unit vectors are computed inline from the `pos` array instead of pre-cached in N×N `Float64Array` buffers. Benchmarked 45% faster than the cached approach at 2040 atoms because the `pos` array (~49 KB) fits in L1 cache while the N×N arrays (~127 MB at 2040 atoms) cause main-memory random-access traffic.
- **Spatial hash acceleration** — `buildNeighborList()` and `updateBondList()` use a Teschner spatial hash (3-pass: count, prefix-sum, scatter) instead of O(N²) all-pairs scans. `tableSize = 2N` — O(N) time and memory regardless of domain extent. No dense grid allocation, no span-dependent costs. Neighbor hash uses 2.60 Å cells; bond hash uses 1.8 Å cells. Shared `_buildCellGrid()` helper with 27-cell stencil lookup and cell-coordinate collision filtering. Validated via `page/bench/bench-celllist.html` (equivalence against all-pairs reference) and `page/bench/bench-spread.html` (span-independence under dynamic expansion).
- **InstancedMesh rendering** — atoms and bonds are rendered via `THREE.InstancedMesh` (2 draw calls total) instead of individual `THREE.Mesh` objects. Active-instance compaction for bonds (only visible bonds uploaded). Highlight via separate overlay mesh.

### Force Safety Controls

**Force clamping (`clampForces`):** After computing Tersoff and wall forces, the engine finds the maximum per-atom force magnitude. If it exceeds `F_MAX` (`CONFIG.physics.fMax`, default 50 eV/Å), all forces are scaled down by `F_MAX / maxMag` — a single global scalar applied to every component. This preserves ΣF = 0 for internal forces and keeps the relative force field shape intact. It is momentum-conserving. The clamp runs inside `computeForces()` after Tersoff+wall but before interaction (drag/rotate) forces are added, so user-applied forces are never diluted.

**Velocity safety (`applySafetyControls`):** Called once per simulation tick after the scheduler-requested substep batch (both worker and sync paths). Per-atom velocity cap at `V_HARD_MAX` (0.15 Å/fs) and global KE cap at `max(KE_CAP_MULT × keInitial, n × 5.0)` eV. The KE cap uses uniform scaling (momentum-direction-preserving). Both are last-resort guards against numerical blow-up, not routine friction — typical thermal velocities are 10–30x below the cap.

**Wasm compilation:** `sim/wasm/tersoff.c` compiled with `-O3 -fno-math-errno -ffinite-math-only` (not `-ffast-math`). This preserves IEEE 754 associativity rules to maintain force cancellation accuracy.

### Worker Architecture

`page/js/simulation-worker.ts` runs `PhysicsEngine` on a dedicated Web Worker thread. The main thread communicates via `page/js/worker-bridge.ts` using a typed `WorkerCommand` / `WorkerEvent` message protocol (`src/types/worker-protocol.ts`). Worker lifecycle (creation, init, stall detection, teardown) is managed by `page/js/runtime/worker-lifecycle.ts`. Worker snapshot reconciliation (position sync, atom-remap, bond refresh) is owned by `page/js/runtime/snapshot-reconciler.ts`. If the worker fails to initialize or stalls (5s warning sets stalled flag, 15s fatal triggers sync fallback), the engine falls back to synchronous `PhysicsEngine` on the main thread. Both paths use identical `physics.ts` code.

CNT geometry is generated via the graphene-sheet-rolling algorithm with chiral vector rotation (`sim/structures/generate.py`). Fullerene coordinates (C60, C180, C540, C720) are stored as relaxed structures in the library.
