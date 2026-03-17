# Project Decisions

Key strategic and technical decisions made during development, with rationale.

## D1: Analytical Tersoff for First Website (not ML)

**Decision:** Use the analytical Tersoff potential compiled to WebAssembly for the first website version. Defer ML surrogates.

**Rationale:** Scaling benchmarks showed analytical Tersoff handles all target scenes (60–300 atoms) at >200 FPS in estimated Wasm. ML provided no speed advantage — descriptor computation has the same O(N·neighbors²) complexity as the analytical force. ML only becomes worthwhile for >1000 atoms with a GNN that avoids explicit descriptors.

**Evidence:** dev_report_simdev9, dev_report_simdev10

## D2: Python Reference + Numba Acceleration

**Decision:** Write the reference implementation in pure Python, accelerate with Numba JIT.

**Rationale:** Python enables rapid development and debugging. A force sign error was found and fixed in minutes during Test 1. Numba provides 250–480x speedup with minimal code changes (just `@njit` decorator), bridging the gap to C performance. The pure Python version remains the authoritative reference for validation.

**Evidence:** bottleneck_analysis.py, tersoff_fast.py benchmarks

## D3: Velocity Verlet (Euler Forbidden)

**Decision:** Use velocity Verlet for all MD. Explicit Euler is explicitly forbidden.

**Rationale:** Velocity Verlet is symplectic (no energy drift), time-reversible, and second-order accurate. Euler is non-symplectic and causes catastrophic energy growth within hundreds of steps. The legacy code also uses velocity Verlet.

## D4: Per-Atom Force Residual as ML Target

**Decision:** ML target is F_residual = F_total - F_2body (per-atom 3D vector).

**Rationale:** Compared three options (per-atom force, per-bond order, local energy). Per-atom force is simplest to train, easiest to debug, and compatible with standard GNN architectures. Non-conservative forces are acceptable for visualization use case; fallback to energy-based target if conservation is critical.

**Evidence:** res3 proposal, dev_report_simdev7

## D5: Cosine Cutoff (not Legacy Exponential)

**Decision:** Use standard Tersoff cosine cutoff, not the legacy code's exponential variant.

**Rationale:** Both are smooth and produce similar equilibrium structures. The cosine form is standard in literature and easier to verify. The difference is documented as a known caveat.

## D6: Multi-Minimizer Best-of-Three Strategy

**Decision:** The library CLI runs all three minimizers (SD, FIRE, SD+FIRE) and picks the best result.

**Rationale:** Different minimizers perform best for different structures. FIRE wins for CNTs, SD wins for diamond (FIRE diverges), SD+FIRE wins for graphene. Running all three and picking the lowest energy ensures the library always has the best available structure.

## D7: CNT Generation via Graphene Rolling

**Decision:** Port the NCKU MATLAB CNT generator, which uses the chiral vector rotation + cylindrical rolling method.

**Rationale:** This is the standard algorithm for generating CNT coordinates from first principles. It supports any chirality (n,m) — armchair, zigzag, and chiral — from a single code path. The MATLAB code was validated in published research.

## D8: No Periodic Boundaries

**Decision:** All structures use free (non-periodic) boundary conditions.

**Rationale:** Simplifies the force calculation significantly (no minimum image convention, no ghost atoms). Edge effects exist for graphene but are acceptable for visualization. The website shows finite structures, not infinite crystals.

## D9: Relaxed Library Structures Required for Dynamics

**Decision:** All collision and MD simulations must use structures relaxed to Fmax < 10⁻³ eV/Å. Never use raw generator output directly.

**Rationale:** The geometry generators produce coordinates far from equilibrium (Fmax 3–7 eV/Å). In dynamics, these unrelaxed structures undergo rapid self-relaxation (shrinking/expansion) that dominates over any applied physics. For C60, the generated coordinates are 14.9 eV above the relaxed minimum with residual forces 4,763x larger than the library version. This was discovered during scaling research when collision simulations showed structures deforming before any collision occurred. The fix: load from `structures/library/` or relax with `simple_minimize()` before use.

**Evidence:** scaling_research.py v1→v3 evolution, outputs/scaling_research/results.json

## D10: Collision Placement by Surface Gap (not Center Distance)

**Decision:** Multi-structure collision scenarios are set up by computing bounding extents and placing structures with a controlled surface-to-surface gap.

**Rationale:** Naively placing structures by center-to-center distance ignores structure size and can produce overlapping atoms (initial distance < 1 Å), causing instant catastrophic repulsion. The 4x C60 scenario initially placed balls at offset 5.0 Å from origin, resulting in inter-atomic distances of 0.45 Å and PE = +1,079 eV (positive = massive repulsion). The corrected placement uses `place_for_collision()` which computes actual bounding box extents and achieves a verified surface gap of 3.0 Å with initial min distance 4.19 Å.

**Evidence:** scaling_research.py Scenario 3, collision_4xc60.xyz trajectory comparison
