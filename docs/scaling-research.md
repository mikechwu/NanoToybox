# Scaling Research: Real-Time Browser Visualization Limits

## Motivation

Atom Dojo aims to deliver real-time molecular dynamics in a web browser. This research quantifies the practical limits — at what atom count does real-time (30 FPS) visualization become infeasible — by measuring three independent bottlenecks: Tersoff force computation, Three.js rendering, and XYZ data transfer.

The research also validates collision dynamics between library structures, establishing correct protocols for multi-structure simulation.

## Methodology

All experiments run via `scripts/scaling_research.py`. Results are saved to `outputs/scaling_research/`.

### Structure Preparation

A critical finding of this research is that **all structures must be relaxed to 0K equilibrium before use in collision simulations**. The geometry generators (`sim/structures/generate.py`) produce initial coordinates far from equilibrium:

| Source | Example | Fmax (eV/Å) | Note |
|--------|---------|-------------|------|
| Generator (`c60()`) | C60 | 3.29 | 14.9 eV above minimum |
| Generator (`graphene()`) | Graphene | 3.49 | Edge atoms severely strained |
| Generator (`diamond()`) | Diamond | 7.05 | Worst case |
| Library (`structures/library/`) | C60 | 0.0007 | Properly relaxed |

Using unrelaxed structures produces artifacts: structures shrink or expand during simulation as they relax, masking the collision physics with self-relaxation dynamics.

The research script uses library structures where available (C60, graphene 6x6/10x10, CNT variants, diamond 2x2x2) and relaxes larger structures via steepest descent / FIRE before collision.

### Collision Protocol

Each collision scenario follows this protocol:

1. **Load relaxed structures** from the library (Fmax < 10⁻³ eV/Å)
2. **Compute bounding extents** along the collision axis
3. **Place structures** with a controlled surface-to-surface gap (typically 3.0 Å)
4. **Assign rigid-body velocities** toward each other (0.01 Å/fs = 1000 m/s per body)
5. **Calculate time-to-contact** analytically: t = gap / (2 × v)
6. **Simulate** for approach + collision + 200–300 fs aftermath
7. **Monitor per step**: inter-structure minimum distance, PE, KE, center-of-mass positions
8. **Confirm collision**: min distance drops below 2.1 Å (Tersoff cutoff)

Velocity of 0.01 Å/fs (1000 m/s) is chosen as an energetic but physically reasonable collision speed — comparable to thermal velocities at ~2400 K. The 3.0 Å surface gap ensures structures start well outside the Tersoff interaction range (2.1 Å) but close enough to collide within ~150 fs.

### Benchmarking

Force evaluation timing uses `time.perf_counter()` with warmup rounds (1–2) and multiple repetitions (2–10 depending on system size). Collision simulations record per-step wall-clock time.

## Results

### Bottleneck 1: Tersoff Force Computation

Measured with Numba JIT engine on desktop CPU. The force evaluation scales as t ~ N^1.70:

| Structure | Atoms | Time (ms) | Equiv. FPS |
|-----------|------:|----------:|----------:|
| C60 | 60 | 0.06 | 17,300 |
| CNT (5,5)x5 | 100 | 0.24 | 4,100 |
| Graphene 10x10 | 200 | 0.51 | 1,900 |
| Graphene 15x15 | 450 | 2.3 | 430 |
| Graphene 20x20 | 800 | 3.3 | 310 |
| Diamond 5x5x5 | 1,000 | 5.1 | 200 |
| Graphene 25x25 | 1,250 | 6.0 | 170 |
| Graphene 30x30 | 1,800 | 21.3 | 47 |
| Diamond 7x7x7 | 2,744 | 61.7 | 16 |
| Graphene 40x40 | 3,200 | 73.9 | 14 |
| Diamond 8x8x8 | 4,096 | 128.9 | 8 |
| Graphene 50x50 | 5,000 | 526.5 | 2 |

**Fitted scaling law:** t = 7.2 × 10⁻⁵ × N^1.70 ms

**30 FPS limit (Numba):** ~2,100 atoms

**60 FPS limit (Numba):** ~1,400 atoms

### Bottleneck 2: Three.js Rendering

> **Update:** The interactive page now uses InstancedMesh (2 draw calls) and spatial-hash bond detection (O(N)). The estimates below apply to the **trajectory viewer** (`viewer/index.html`) which currently still uses individual meshes and O(N^2) bond detection.

The trajectory viewer uses individual `THREE.Mesh` per atom and an O(N²) nested loop for bond detection. Estimated costs:

| Atoms | Draw Calls | Pair Checks | Frame Time (ms) | FPS |
|------:|----------:|-----------:|----------------:|----:|
| 60 | 150 | 1,770 | 3.3 | 144 |
| 100 | 250 | 4,950 | 7.5 | 134 |
| 200 | 500 | 19,900 | 24.9 | 40 |
| 500 | 1,250 | 124,750 | 137 | 7 |
| 1,000 | 2,500 | 499,500 | 525 | 2 |
| 5,000 | 12,500 | 12.5M | 12,600 | <1 |

The trajectory viewer's rendering limit at 30 FPS is approximately **250 atoms**. The interactive page (`lab/`) has no such limit — InstancedMesh rendering is linear in instance count (2 draw calls regardless of atom count).

### Bottleneck 3: Data Transfer (XYZ File Size)

| Atoms | Frames | Size (MB) |
|------:|-------:|----------:|
| 200 | 500 | 4.5 |
| 1,000 | 500 | 22.5 |
| 5,000 | 500 | 112.5 |
| 10,000 | 1,000 | 450.0 |

File size is not a practical bottleneck for the current target range (<2,000 atoms). It becomes relevant only for very large trajectories (>100 MB) that strain browser memory and parsing.

### Collision Simulation Results

All 8 scenarios use relaxed library structures and confirmed collision via monitored inter-structure minimum distance:

| Scenario | Atoms | Contact (fs) | Min Dist (Å) | ms/step | FPS |
|----------|------:|-------------:|--------------:|--------:|----:|
| C60 + C60 head-on | 120 | 45.0 | 2.07 | 1.3 | 770 |
| C60 → graphene 10x10 | 260 | 52.0 | 2.08 | 2.9 | 350 |
| 4x C60 converging | 240 | 149.5 | 2.07 | 2.5 | 407 |
| CNT x CNT crossing | 400 | 47.0 | 2.08 | 4.2 | 238 |
| 2x graphene 15x15 | 900 | 45.5 | 2.07 | 10.5 | 96 |
| 2x graphene 20x20 | 1,600 | 45.5 | 2.07 | 27.6 | 36 |
| 2x diamond 4x4x4 | 1,024 | 76.0 | 1.19 | 11.5 | 87 |
| 2x graphene 30x30 | 3,600 | 46.0 | 2.07 | 117.4 | 9 |

The diamond collision produces the deepest penetration (min dist 1.19 Å) due to the rigid 3D lattice transmitting the impact force through the bulk rather than deflecting. Graphene sheets bounce apart after collision (final distance ~10 Å) because the 2D sheets buckle and spring back.

Collision trajectories are saved as XYZ files in `outputs/scaling_research/` and viewable in the Three.js viewer.

## Practical Limits Summary

> **Update (2026-03-25):** The interactive page (`lab/`) now uses InstancedMesh rendering, on-the-fly Tersoff distances, spatial-hash neighbor/bond search, and a dedicated Web Worker for physics (`simulation-worker.ts`). The "unoptimized viewer" row below is historical. See `docs/viewer.md` for current optimization status. Browser benchmark data is in `lab/bench/`.

| Configuration | Max Atoms (30 FPS) | Limiting Bottleneck |
|---------------|-------------------:|---------------------|
| ~~Unoptimized viewer~~ (historical) | ~~~250~~ | ~~O(N²) bond detection in JS~~ |
| Current interactive page (InstancedMesh + spatial hash + on-the-fly) | ~2,400 (estimated) | Tersoff kernel + O(N²) stages eliminated |
| Optimized viewer + Numba Tersoff (server) | ~2,100 | Tersoff force computation |
| + C/Wasm Tersoff (est. 2–5x kernel) | ~3,000–5,000 | Remaining physics stages |

### Implications for the Browser Deployment Roadmap

1. **Phase 1 (60–720 atoms):** Achieved. InstancedMesh rendering and on-the-fly Tersoff run comfortably at 60+ FPS. Multi-molecule playground is live.

2. **Phase 2 (720–2,400 atoms):** Achieved with current optimizations (InstancedMesh + spatial hash + on-the-fly kernel). Smooth at 30+ FPS at the physics wall (~2,400 atoms estimated).

3. **Phase 3 (2,400–5,000+ atoms):** C/Wasm Tersoff kernel deployed and enabled by default (~11% faster than JS JIT). Physics runs on a dedicated Web Worker thread (`simulation-worker.ts`), keeping the main thread responsive. Further throughput gains require algorithmic improvements (e.g., O(N) Tersoff, GPU compute).

4. **Beyond 5,000 atoms:** Not practical for real-time browser MD. Pre-computed trajectories with stride-based playback (now supported in the viewer) are the viable approach.

## Collision Protocol Lessons

### Use Library Structures, Not Generators

The geometry generators produce coordinates that are far from equilibrium. Using them directly in MD leads to:
- Artificial structure deformation (shrinking/expansion) during simulation
- Residual force magnitudes (3–7 eV/Å) that dominate over collision forces
- Energy artifacts that obscure collision energetics

Always use `structures/library/*.xyz` for dynamics. For structures not in the library, relax with `simple_minimize()` or `minimize()` to Fmax < 10⁻³ eV/Å first.

### Placement Verification

Multi-structure placement must verify no atomic overlap before simulation:
- Compute bounding extents of each structure
- Calculate surface-to-surface gap (not center-to-center distance)
- Verify minimum inter-structure distance > 1.5 Å for all pairs
- For multi-body scenarios, check all pairwise distances

An initial overlap (atoms within ~1 Å) produces immediate catastrophic repulsion with energies in the thousands of eV — unmistakable as an "explosion" in the trajectory.

### Simulation Duration

The simulation must be long enough to cover three phases:
1. **Approach** (~150 fs for 3 Å gap at 0.01 Å/fs relative speed)
2. **Collision** (~50–100 fs of strong interaction)
3. **Aftermath** (200–300 fs of post-collision dynamics: bouncing, deformation, energy redistribution)

Total: 400–700 fs (800–1400 steps at dt = 0.5 fs) for a complete collision event.

## Reproducing the Research

```bash
# Run the full scaling research (takes 5-10 minutes with Numba)
python3 scripts/scaling_research.py

# Results saved to:
#   outputs/scaling_research/results.json          — machine-readable data
#   outputs/scaling_research/collision_*.xyz        — viewable trajectories

# View a collision trajectory in the trajectory viewer
open viewer/index.html
# Then drag-drop any collision_*.xyz file
# Use Stride=20 at 30 fps for long trajectories

# Or interact with structures in real-time
# Open http://localhost:8788/lab/ (requires npm run app:serve — Lab
# needs Pages Functions; raw npm run dev 404s on /api/*)
```
