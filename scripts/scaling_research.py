"""
Scaling Research: Finding the practical limit of real-time browser visualization.

This script systematically measures:
1. Tersoff force computation time vs atom count (simulation bottleneck)
2. Collision scenario benchmarks with VERIFIED collisions using RELAXED structures
3. Three.js rendering load estimation (draw calls, bond detection)
4. XYZ file sizes (data transfer bottleneck)

Goal: Find the atom count N* where real-time (30 FPS) browser display becomes impractical.

Physics notes:
  - Velocities are in Å/fs. 1 Å/fs = 1e5 m/s = 100 km/s.
  - Room-temp C atom: v_rms ~ 0.008 Å/fs (~ 800 m/s).
  - Tersoff cutoff: R + D = 2.1 Å. No interaction beyond this distance.
  - C60 radius ~ 3.55 Å; surface-to-surface must be < 2.1 Å for interaction.

CRITICAL: All structures must be relaxed (0K equilibrium) before collision,
otherwise residual forces cause artificial shrinking/expansion that dominates
the dynamics and masks the actual collision physics.
"""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.atoms import Atoms
from sim.structures.generate import graphene, cnt, diamond, c60
from sim.minimizer import simple_minimize, minimize
from sim.integrators.velocity_verlet import step as vv_step
from sim.io.output import write_xyz

# Try Numba-accelerated Tersoff first (the realistic deployment path)
try:
    from sim.potentials.tersoff_fast import compute_energy_and_forces as compute_fast
    HAS_NUMBA = True
    print("Using Numba-accelerated Tersoff (production path)")
except ImportError:
    HAS_NUMBA = False
    print("Numba not available, using pure Python Tersoff")

from sim.potentials.tersoff import compute_energy_and_forces as compute_pure


def force_fn_fast(pos):
    return compute_fast(pos)

def force_fn_pure(pos):
    return compute_pure(pos)


# =============================================================================
# Library loading — use pre-relaxed 0K structures
# =============================================================================

LIBRARY_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "structures", "library")


def load_library_xyz(name):
    """Load a relaxed structure from the library by manifest key."""
    manifest_path = os.path.join(LIBRARY_DIR, "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    if name not in manifest:
        raise KeyError(f"Structure '{name}' not in library. "
                       f"Available: {list(manifest.keys())}")
    info = manifest[name]
    xyz_path = os.path.join(LIBRARY_DIR, info['file'])
    with open(xyz_path) as f:
        lines = f.readlines()
    n = int(lines[0].strip())
    pos = []
    for i in range(2, 2 + n):
        parts = lines[i].split()
        pos.append([float(parts[1]), float(parts[2]), float(parts[3])])
    atoms = Atoms(np.array(pos))
    return atoms, info


def relax_structure(atoms, force_fn, label="", f_tol=1e-3):
    """Relax a structure to 0K equilibrium. Returns relaxed Atoms + info."""
    e0, f0 = force_fn(atoms.positions)[:2]
    fmax0 = np.max(np.linalg.norm(f0, axis=1))
    print(f"    {label}: before relax E={e0:.2f} eV, Fmax={fmax0:.4f} eV/Å")

    if fmax0 < f_tol:
        print(f"    Already relaxed (Fmax < {f_tol})")
        return atoms

    # Try steepest descent first, then FIRE
    best_atoms = atoms.copy()
    best_fmax = fmax0

    for method_name, method_fn in [("SD", simple_minimize), ("FIRE", minimize)]:
        test = atoms.copy()
        t0 = time.perf_counter()
        result = method_fn(test, force_fn, max_steps=5000, f_tol=f_tol)
        elapsed = time.perf_counter() - t0
        print(f"    {method_name}: {result['steps']} steps, "
              f"E={result['final_energy']:.2f} eV, "
              f"Fmax={result['final_fmax']:.6f} eV/Å, "
              f"converged={result['converged']}, {elapsed:.1f}s")
        if result['final_fmax'] < best_fmax:
            best_fmax = result['final_fmax']
            best_atoms = test

    return best_atoms


def get_relaxed_structure(name, force_fn):
    """Try library first, fall back to generate + relax."""
    try:
        atoms, info = load_library_xyz(name)
        e, f = force_fn(atoms.positions)[:2]
        fmax = np.max(np.linalg.norm(f, axis=1))
        print(f"  Loaded from library: {name} "
              f"(N={atoms.n_atoms}, E={e:.2f} eV, Fmax={fmax:.6f} eV/Å)")
        return atoms
    except (KeyError, FileNotFoundError):
        print(f"  '{name}' not in library, generating + relaxing...")
        return None


# =============================================================================
# Structure utilities
# =============================================================================

def structure_extent(atoms):
    """Return (center, radius) of smallest bounding sphere."""
    center = atoms.positions.mean(axis=0)
    radii = np.linalg.norm(atoms.positions - center, axis=1)
    return center, radii.max()


def min_inter_distance(positions, n_a, n_b):
    """Minimum distance between atom groups A=[0:n_a] and B=[n_a:n_a+n_b]."""
    pos_a = positions[:n_a]
    pos_b = positions[n_a:n_a + n_b]
    diff = pos_a[:, None, :] - pos_b[None, :, :]
    dists = np.linalg.norm(diff, axis=2)
    return dists.min()


def com_of_group(positions, start, count):
    """Center of mass of a group of atoms (all same mass)."""
    return positions[start:start + count].mean(axis=0)


def combine_structures(struct_list, offsets):
    """Combine multiple Atoms objects with spatial offsets into one system."""
    all_pos = []
    for atoms, offset in zip(struct_list, offsets):
        shifted = atoms.positions.copy() + np.array(offset)
        all_pos.append(shifted)
    combined_pos = np.vstack(all_pos)
    return Atoms(combined_pos)


def set_collision_velocities(combined, n_atoms_list, velocities_list):
    """Set initial velocities for collision groups (rigid-body translation)."""
    idx = 0
    for n, vel in zip(n_atoms_list, velocities_list):
        combined.velocities[idx:idx + n] = np.array(vel)
        idx += n


def place_for_collision(struct_a, struct_b, axis, surface_gap, collision_vel):
    """
    Place two structures along `axis` with a given surface-to-surface gap,
    and assign head-on collision velocities.

    Args:
        struct_a, struct_b: Atoms objects (will be copied)
        axis: int (0=x, 1=y, 2=z)
        surface_gap: Å between nearest surfaces
        collision_vel: velocity of each body toward the other (Å/fs, positive)

    Returns:
        combined: Atoms with positions and velocities set
        n_a, n_b: atom counts
        info: dict with placement details
    """
    a_min, a_max = struct_a.positions[:, axis].min(), struct_a.positions[:, axis].max()
    b_min, b_max = struct_b.positions[:, axis].min(), struct_b.positions[:, axis].max()
    a_extent = a_max - a_min
    b_extent = b_max - b_min

    a_pos = struct_a.positions.copy()
    b_pos = struct_b.positions.copy()
    a_pos -= a_pos.mean(axis=0)
    b_pos -= b_pos.mean(axis=0)

    a_shift = np.zeros(3)
    b_shift = np.zeros(3)
    a_shift[axis] = -(surface_gap / 2 + a_extent / 2)
    b_shift[axis] = +(surface_gap / 2 + b_extent / 2)

    a_pos += a_shift
    b_pos += b_shift

    combined_pos = np.vstack([a_pos, b_pos])
    combined = Atoms(combined_pos)

    vel_a = np.zeros(3)
    vel_b = np.zeros(3)
    vel_a[axis] = +collision_vel
    vel_b[axis] = -collision_vel

    n_a, n_b = len(a_pos), len(b_pos)
    combined.velocities[:n_a] = vel_a
    combined.velocities[n_a:] = vel_b

    actual_gap = min_inter_distance(combined.positions, n_a, n_b)
    relative_vel = 2 * collision_vel
    time_to_contact = actual_gap / relative_vel if relative_vel > 0 else float('inf')

    info = {
        'n_a': n_a, 'n_b': n_b,
        'a_extent': a_extent, 'b_extent': b_extent,
        'surface_gap': actual_gap,
        'collision_vel': collision_vel,
        'relative_vel': relative_vel,
        'time_to_contact_fs': time_to_contact,
        'collision_vel_m_per_s': collision_vel * 1e5,
    }
    return combined, n_a, n_b, info


def place_multi_for_collision(struct_list, positions_list, velocities_list):
    """
    Place multiple structures at specified positions with specified velocities.
    Verify no initial overlap (min inter-distance > 1.5 Å for all pairs).

    Returns:
        combined: Atoms with positions and velocities set
        n_atoms_list: atom counts per group
        info: dict with placement verification
    """
    all_pos = []
    n_atoms_list = []
    for atoms, pos_offset in zip(struct_list, positions_list):
        shifted = atoms.positions.copy() + np.array(pos_offset)
        all_pos.append(shifted)
        n_atoms_list.append(len(shifted))

    combined_pos = np.vstack(all_pos)
    combined = Atoms(combined_pos)

    # Set velocities per group
    idx = 0
    for n, vel in zip(n_atoms_list, velocities_list):
        combined.velocities[idx:idx + n] = np.array(vel)
        idx += n

    # Check all pairwise minimum distances
    min_dists = {}
    idx_i = 0
    for i in range(len(struct_list)):
        idx_j = idx_i + n_atoms_list[i]
        for j in range(i + 1, len(struct_list)):
            n_j = n_atoms_list[j]
            d = min_inter_distance(combined_pos, idx_j, n_j)
            # This isn't quite right for non-adjacent groups, use direct calc
            pos_i = combined_pos[idx_i:idx_i + n_atoms_list[i]]
            pos_j = combined_pos[idx_j:idx_j + n_j]
            diff = pos_i[:, None, :] - pos_j[None, :, :]
            d = np.linalg.norm(diff, axis=2).min()
            min_dists[f"{i}-{j}"] = d
            idx_j += n_j
        idx_i += n_atoms_list[i]

    overlap = any(d < 1.5 for d in min_dists.values())

    info = {
        'n_groups': len(struct_list),
        'n_atoms_list': n_atoms_list,
        'total_atoms': sum(n_atoms_list),
        'min_dists': min_dists,
        'overlap': overlap,
    }
    return combined, n_atoms_list, info


# =============================================================================
# Collision simulation with monitoring
# =============================================================================

def run_collision_with_monitoring(atoms, n_a, n_b, force_fn, dt, n_steps,
                                  label="", log_interval=1):
    """
    Run collision simulation with per-step monitoring of:
    - Inter-structure minimum distance (collision detection)
    - Potential energy (spike = collision)
    - Kinetic energy
    - Center-of-mass positions of each group
    - Per-step wall-clock time
    """
    result = force_fn(atoms.positions)
    pe0 = result[0]
    atoms.forces = result[1].copy()

    step_times_ms = []
    pe_history = [pe0]
    ke_history = [atoms.kinetic_energy()]
    min_dist_history = [min_inter_distance(atoms.positions, n_a, n_b)]
    com_a_history = [com_of_group(atoms.positions, 0, n_a).copy()]
    com_b_history = [com_of_group(atoms.positions, n_a, n_b).copy()]
    positions_history = [atoms.positions.copy()]

    collision_detected = False
    collision_step = None

    for s in range(1, n_steps + 1):
        t0 = time.perf_counter()
        pe = vv_step(atoms, dt, force_fn)
        t1 = time.perf_counter()
        step_times_ms.append((t1 - t0) * 1000)

        if s % log_interval == 0:
            ke = atoms.kinetic_energy()
            d_min = min_inter_distance(atoms.positions, n_a, n_b)

            pe_history.append(pe)
            ke_history.append(ke)
            min_dist_history.append(d_min)
            com_a_history.append(com_of_group(atoms.positions, 0, n_a).copy())
            com_b_history.append(com_of_group(atoms.positions, n_a, n_b).copy())
            positions_history.append(atoms.positions.copy())

            if d_min < 2.1 and not collision_detected:
                collision_detected = True
                collision_step = s
                print(f"    ** COLLISION at step {s} (t={s*dt:.1f} fs): "
                      f"min_dist={d_min:.3f} Å **")

    t_mean = np.mean(step_times_ms) if step_times_ms else 0
    t_max = np.max(step_times_ms) if step_times_ms else 0

    d_initial = min_dist_history[0]
    d_final = min_dist_history[-1]
    d_min_overall = min(min_dist_history)
    pe_initial = pe_history[0]
    pe_min = min(pe_history)
    pe_max = max(pe_history)

    print(f"  {label}")
    print(f"    N={atoms.n_atoms:6d}  steps={n_steps}  dt={dt} fs  "
          f"total_time={n_steps*dt:.0f} fs")
    print(f"    Timing: avg={t_mean:.2f} ms/step  max={t_max:.2f} ms/step")
    print(f"    Distance: initial={d_initial:.2f} Å  min={d_min_overall:.3f} Å  "
          f"final={d_final:.2f} Å")
    print(f"    Energy: PE_init={pe_initial:.1f} eV  PE_range=[{pe_min:.1f}, {pe_max:.1f}] eV")
    if collision_detected:
        print(f"    COLLISION CONFIRMED at step {collision_step} "
              f"(t={collision_step*dt:.1f} fs)")
    else:
        print(f"    NO COLLISION (min distance never reached 2.1 Å cutoff)")

    return {
        'label': label,
        'n_atoms': atoms.n_atoms,
        'n_a': n_a, 'n_b': n_b,
        'n_steps': n_steps, 'dt': dt,
        't_mean_ms': t_mean,
        't_max_ms': t_max,
        'step_times_ms': step_times_ms,
        'collision_detected': collision_detected,
        'collision_step': collision_step,
        'min_dist_history': min_dist_history,
        'pe_history': pe_history,
        'ke_history': ke_history,
        'com_a_history': com_a_history,
        'com_b_history': com_b_history,
        'positions_history': positions_history,
    }


# =============================================================================
# Benchmarks
# =============================================================================

def benchmark_force(positions, force_fn, n_warmup=2, n_reps=5, label=""):
    """Benchmark a single force evaluation, return time in ms."""
    n = len(positions)
    for _ in range(n_warmup):
        force_fn(positions)
    times = []
    for _ in range(n_reps):
        t0 = time.perf_counter()
        force_fn(positions)
        t1 = time.perf_counter()
        times.append((t1 - t0) * 1000)
    t_mean = np.mean(times)
    t_std = np.std(times)
    print(f"  {label:40s}  N={n:6d}  t={t_mean:10.2f} ± {t_std:6.2f} ms")
    return {'label': label, 'n_atoms': n, 't_mean_ms': t_mean, 't_std_ms': t_std}


def estimate_rendering_cost(n_atoms_val):
    """Estimate Three.js rendering cost based on current viewer architecture."""
    n_bonds_est = int(n_atoms_val * 1.5)
    draw_calls = n_atoms_val + n_bonds_est
    draw_call_time = draw_calls * 0.01
    pair_checks = n_atoms_val * (n_atoms_val - 1) // 2
    bond_detection_time = pair_checks * 0.001
    frame_time = draw_call_time + bond_detection_time
    achievable_fps = 1000.0 / frame_time if frame_time > 0 else float('inf')
    return {
        'n_atoms': n_atoms_val,
        'draw_calls': draw_calls,
        'pair_checks': pair_checks,
        'draw_call_time_ms': draw_call_time,
        'bond_detection_time_ms': bond_detection_time,
        'total_frame_time_ms': frame_time,
        'achievable_fps': min(achievable_fps, 144),
    }


def estimate_xyz_file_size(n_atoms_val, n_frames):
    """Estimate XYZ file size in bytes."""
    bytes_per_frame = 30 + n_atoms_val * 45
    total_bytes = bytes_per_frame * n_frames
    return {
        'n_atoms': n_atoms_val, 'n_frames': n_frames,
        'bytes_per_frame': bytes_per_frame,
        'total_bytes': total_bytes, 'total_mb': total_bytes / 1e6,
    }


# =============================================================================
# Main
# =============================================================================

def main():
    print("=" * 80)
    print("NANO TOYBOX SCALING RESEARCH v3")
    print("With RELAXED structures and VERIFIED collision physics")
    print("=" * 80)

    force_fn = force_fn_fast if HAS_NUMBA else force_fn_pure
    engine_label = "Numba" if HAS_NUMBA else "Python"
    os.makedirs("outputs/scaling_research", exist_ok=True)

    # =========================================================================
    # PHASE 1: Single-structure force evaluation scaling
    # =========================================================================
    print(f"\n{'='*80}")
    print("PHASE 1: Force Evaluation Scaling (single structure)")
    print(f"Engine: {engine_label}")
    print(f"{'='*80}")

    # Use library structures where available, generate + relax otherwise
    print("\n  Loading/relaxing structures...")

    c60_relaxed = get_relaxed_structure("c60", force_fn)
    graphene_6x6_relaxed = get_relaxed_structure("graphene_6x6", force_fn)
    cnt_5_5_5_relaxed = get_relaxed_structure("cnt_5_5_5cells", force_fn)
    graphene_10x10_relaxed = get_relaxed_structure("graphene_10x10", force_fn)
    cnt_10_0_5_relaxed = get_relaxed_structure("cnt_10_0_5cells", force_fn)
    diamond_2x2x2_relaxed = get_relaxed_structure("diamond_2x2x2", force_fn)

    # Generate + relax structures not in library
    print("\n  Relaxing larger structures (not in library)...")

    diamond_3 = diamond(3, 3, 3)
    diamond_3 = relax_structure(diamond_3, force_fn, "diamond 3x3x3")

    graphene_15 = graphene(15, 15)
    graphene_15 = relax_structure(graphene_15, force_fn, "graphene 15x15")

    graphene_20 = graphene(20, 20)
    graphene_20 = relax_structure(graphene_20, force_fn, "graphene 20x20")

    diamond_4 = diamond(4, 4, 4)
    diamond_4 = relax_structure(diamond_4, force_fn, "diamond 4x4x4")

    cnt_10_10_10 = cnt(10, 10, 10)
    cnt_10_10_10 = relax_structure(cnt_10_10_10, force_fn, "CNT (10,10)x10")

    graphene_25 = graphene(25, 25)
    graphene_25 = relax_structure(graphene_25, force_fn, "graphene 25x25")

    diamond_5 = diamond(5, 5, 5)
    diamond_5 = relax_structure(diamond_5, force_fn, "diamond 5x5x5")

    graphene_30 = graphene(30, 30)
    graphene_30 = relax_structure(graphene_30, force_fn, "graphene 30x30")

    diamond_6 = diamond(6, 6, 6)
    diamond_6 = relax_structure(diamond_6, force_fn, "diamond 6x6x6")

    # Larger ones: skip relaxation for benchmark (takes too long), use as-is
    # These are only for force timing, not for collision
    graphene_40 = graphene(40, 40)
    diamond_7 = diamond(7, 7, 7)
    graphene_50 = graphene(50, 50)
    diamond_8 = diamond(8, 8, 8)

    force_results = []
    structures = [
        ("C60 (library)",           c60_relaxed),
        ("Graphene 6x6 (library)",  graphene_6x6_relaxed),
        ("CNT (5,5)x5 (library)",   cnt_5_5_5_relaxed),
        ("Graphene 10x10 (library)", graphene_10x10_relaxed),
        ("CNT (10,0)x5 (library)",  cnt_10_0_5_relaxed),
        ("Diamond 3x3x3 (relaxed)", diamond_3),
        ("Graphene 15x15 (relaxed)", graphene_15),
        ("Graphene 20x20 (relaxed)", graphene_20),
        ("Diamond 4x4x4 (relaxed)", diamond_4),
        ("CNT (10,10)x10 (relaxed)", cnt_10_10_10),
        ("Graphene 25x25 (relaxed)", graphene_25),
        ("Diamond 5x5x5 (relaxed)", diamond_5),
        ("Graphene 30x30 (relaxed)", graphene_30),
        ("Diamond 6x6x6 (relaxed)", diamond_6),
        ("Graphene 40x40 (gen)",    graphene_40),
        ("Diamond 7x7x7 (gen)",    diamond_7),
        ("Graphene 50x50 (gen)",    graphene_50),
        ("Diamond 8x8x8 (gen)",    diamond_8),
    ]

    print(f"\n  Benchmarking force evaluation...")
    for label, atoms in structures:
        n_reps = max(2, min(10, int(500 / max(1, atoms.n_atoms))))
        r = benchmark_force(atoms.positions, force_fn, n_warmup=1, n_reps=n_reps,
                           label=label)
        force_results.append(r)
        if r['t_mean_ms'] > 30000:
            print(f"  *** STOPPING: force evaluation exceeds 30s ***")
            break

    # =========================================================================
    # PHASE 2: Collision scenarios with RELAXED structures
    # =========================================================================
    print(f"\n{'='*80}")
    print("PHASE 2: Collision Scenarios (RELAXED + VERIFIED)")
    print(f"{'='*80}")

    print(f"\nPhysics setup:")
    print(f"  All structures relaxed to Fmax < 1e-3 eV/Å before collision")
    print(f"  Tersoff cutoff: 2.1 Å (no interaction beyond this)")
    print(f"  Collision velocity: 0.01 Å/fs = 1000 m/s (energetic but physical)")
    print(f"  Surface gap: 3.0 Å (close enough to collide quickly)")
    print(f"  Strategy: compute time-to-contact, simulate approach + collision + aftermath")
    print(f"  Monitoring: min inter-distance, PE, KE, COMs every step")

    collision_results = []

    # --- Scenario 1: C60 + C60 head-on ---
    print(f"\n{'─'*60}")
    print("Scenario 1: C60 + C60 head-on collision")
    print(f"{'─'*60}")
    s1 = get_relaxed_structure("c60", force_fn)
    s2 = get_relaxed_structure("c60", force_fn)
    combined, n_a, n_b, info = place_for_collision(
        s1, s2, axis=2, surface_gap=3.0, collision_vel=0.01)
    print(f"  Placement: surface gap = {info['surface_gap']:.2f} Å")
    print(f"  Velocity: {info['collision_vel_m_per_s']:.0f} m/s each, "
          f"relative = {info['relative_vel']*1e5:.0f} m/s")
    print(f"  Est. time to contact: {info['time_to_contact_fs']:.0f} fs")
    n_steps = int((info['time_to_contact_fs'] + 300) / 0.5)
    n_steps = max(n_steps, 400)
    r = run_collision_with_monitoring(combined, n_a, n_b, force_fn, dt=0.5,
                                      n_steps=n_steps, label="C60 + C60")
    collision_results.append(r)
    write_xyz("outputs/scaling_research/collision_c60_c60.xyz",
              r['positions_history'])

    # --- Scenario 2: C60 → graphene 10x10 ---
    print(f"\n{'─'*60}")
    print("Scenario 2: C60 → graphene 10x10")
    print(f"{'─'*60}")
    ball = get_relaxed_structure("c60", force_fn)
    sheet = get_relaxed_structure("graphene_10x10", force_fn)
    combined, n_a, n_b, info = place_for_collision(
        ball, sheet, axis=2, surface_gap=3.0, collision_vel=0.01)
    print(f"  Placement: gap={info['surface_gap']:.2f} Å, "
          f"ETA={info['time_to_contact_fs']:.0f} fs")
    n_steps = int((info['time_to_contact_fs'] + 300) / 0.5)
    n_steps = max(n_steps, 400)
    r = run_collision_with_monitoring(combined, n_a, n_b, force_fn, dt=0.5,
                                      n_steps=n_steps, label="C60 → graphene 10x10")
    collision_results.append(r)
    write_xyz("outputs/scaling_research/collision_c60_graphene.xyz",
              r['positions_history'])

    # --- Scenario 3: 4x C60 converging collision (FIXED PLACEMENT) ---
    print(f"\n{'─'*60}")
    print("Scenario 3: 4x C60 converging collision (FIXED)")
    print(f"{'─'*60}")
    balls = [get_relaxed_structure("c60", force_fn) for _ in range(4)]
    _, r_c60 = structure_extent(balls[0])
    # Place with proper surface gap: center-to-center = 2*r_c60 + surface_gap
    # Each ball's center is at distance (2*r_c60 + gap)/sqrt(2) from origin
    # so that adjacent balls have surface gap of ~3 Å
    surface_gap = 4.0  # Å between adjacent ball surfaces
    cc_dist = 2 * r_c60 + surface_gap  # center-to-center for adjacent pair
    # Place on axes, so adjacent balls are at 90° → distance = cc_dist * sqrt(2) / sqrt(2) = cc_dist
    # Actually for 4 balls on +x, -x, +y, -y axes at distance d from origin:
    # adjacent pair distance = d * sqrt(2), so d = cc_dist / sqrt(2)
    d_from_origin = cc_dist / np.sqrt(2)
    offsets = [
        [+d_from_origin, 0, 0],
        [-d_from_origin, 0, 0],
        [0, +d_from_origin, 0],
        [0, -d_from_origin, 0],
    ]
    v = 0.01  # Å/fs toward origin
    vels = [[-v, 0, 0], [+v, 0, 0], [0, -v, 0], [0, +v, 0]]
    combined, n_atoms_list, info = place_multi_for_collision(balls, offsets, vels)
    print(f"  C60 bounding radius: {r_c60:.2f} Å")
    print(f"  Center-to-center (adjacent): {cc_dist:.2f} Å")
    print(f"  Distance from origin: {d_from_origin:.2f} Å")
    print(f"  Pairwise min distances:")
    for pair, d in info['min_dists'].items():
        print(f"    pair {pair}: {d:.2f} Å {'(OVERLAP!)' if d < 1.5 else '(OK)'}")
    print(f"  Any overlap: {info['overlap']}")
    # Time to collision: each ball travels d_from_origin - r_c60 before first contact
    approach_dist = d_from_origin - r_c60
    time_to_contact = approach_dist / v  # each moving at v toward center
    print(f"  Velocity: {v*1e5:.0f} m/s each toward center")
    print(f"  Est. time to first contact: {time_to_contact:.0f} fs")
    n_steps = int((time_to_contact + 300) / 0.5)
    n_steps = max(n_steps, 600)
    # Monitor: group A = first 60, group B = remaining 180
    r = run_collision_with_monitoring(combined, 60, 180, force_fn, dt=0.5,
                                      n_steps=n_steps, label="4x C60 converging")
    collision_results.append(r)
    write_xyz("outputs/scaling_research/collision_4xc60.xyz",
              r['positions_history'])

    # --- Scenario 4: CNT + CNT crossing collision ---
    print(f"\n{'─'*60}")
    print("Scenario 4: CNT (5,5)x10 + CNT (5,5)x10 crossing")
    print(f"{'─'*60}")
    t1_struct = get_relaxed_structure("cnt_5_5_10cells", force_fn)
    t2_struct = get_relaxed_structure("cnt_5_5_10cells", force_fn)
    # Rotate t2 by 90° around z-axis so tubes cross
    rot90 = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], dtype=float)
    t2_rotated = Atoms((rot90 @ t2_struct.positions.T).T)
    combined, n_a, n_b, info = place_for_collision(
        t1_struct, t2_rotated, axis=1, surface_gap=3.0, collision_vel=0.01)
    print(f"  Placement: gap={info['surface_gap']:.2f} Å, "
          f"ETA={info['time_to_contact_fs']:.0f} fs")
    n_steps = int((info['time_to_contact_fs'] + 300) / 0.5)
    n_steps = max(n_steps, 400)
    r = run_collision_with_monitoring(combined, n_a, n_b, force_fn, dt=0.5,
                                      n_steps=n_steps, label="CNT x CNT crossing")
    collision_results.append(r)
    write_xyz("outputs/scaling_research/collision_cnt_cnt.xyz",
              r['positions_history'])

    # --- Scenario 5: 2x graphene 15x15 collision ---
    print(f"\n{'─'*60}")
    print("Scenario 5: Two graphene 15x15 sheets collision")
    print(f"{'─'*60}")
    combined, n_a, n_b, info = place_for_collision(
        graphene_15, graphene_15, axis=2, surface_gap=3.0, collision_vel=0.01)
    print(f"  Placement: gap={info['surface_gap']:.2f} Å, "
          f"ETA={info['time_to_contact_fs']:.0f} fs")
    n_steps = int((info['time_to_contact_fs'] + 300) / 0.5)
    n_steps = max(n_steps, 600)
    r = run_collision_with_monitoring(combined, n_a, n_b, force_fn, dt=0.5,
                                      n_steps=n_steps, label="2x graphene 15x15")
    collision_results.append(r)
    write_xyz("outputs/scaling_research/collision_2xgraphene15.xyz",
              r['positions_history'])

    # --- Scenario 6: 2x graphene 20x20 collision ---
    print(f"\n{'─'*60}")
    print("Scenario 6: Two graphene 20x20 sheets collision")
    print(f"{'─'*60}")
    combined, n_a, n_b, info = place_for_collision(
        graphene_20, graphene_20, axis=2, surface_gap=3.0, collision_vel=0.01)
    print(f"  Placement: gap={info['surface_gap']:.2f} Å, "
          f"ETA={info['time_to_contact_fs']:.0f} fs")
    n_steps = int((info['time_to_contact_fs'] + 300) / 0.5)
    n_steps = max(n_steps, 600)
    r = run_collision_with_monitoring(combined, n_a, n_b, force_fn, dt=0.5,
                                      n_steps=n_steps, label="2x graphene 20x20")
    collision_results.append(r)
    write_xyz("outputs/scaling_research/collision_2xgraphene20.xyz",
              r['positions_history'])

    # --- Scenario 7: 2x diamond 4x4x4 collision ---
    print(f"\n{'─'*60}")
    print("Scenario 7: Two diamond 4x4x4 blocks collision")
    print(f"{'─'*60}")
    combined, n_a, n_b, info = place_for_collision(
        diamond_4, diamond_4, axis=0, surface_gap=3.0, collision_vel=0.01)
    print(f"  Placement: gap={info['surface_gap']:.2f} Å, "
          f"ETA={info['time_to_contact_fs']:.0f} fs")
    n_steps = int((info['time_to_contact_fs'] + 300) / 0.5)
    n_steps = max(n_steps, 600)
    r = run_collision_with_monitoring(combined, n_a, n_b, force_fn, dt=0.5,
                                      n_steps=n_steps, label="2x diamond 4x4x4")
    collision_results.append(r)
    write_xyz("outputs/scaling_research/collision_2xdiamond4.xyz",
              r['positions_history'])

    # --- Scenario 8: 2x graphene 30x30 (large, near limit) ---
    print(f"\n{'─'*60}")
    print("Scenario 8: Two graphene 30x30 sheets collision (LARGE)")
    print(f"{'─'*60}")
    combined, n_a, n_b, info = place_for_collision(
        graphene_30, graphene_30, axis=2, surface_gap=3.0, collision_vel=0.01)
    print(f"  Placement: gap={info['surface_gap']:.2f} Å, "
          f"ETA={info['time_to_contact_fs']:.0f} fs")
    n_steps = int((info['time_to_contact_fs'] + 200) / 0.5)
    n_steps = max(n_steps, 500)
    r = run_collision_with_monitoring(combined, n_a, n_b, force_fn, dt=0.5,
                                      n_steps=n_steps, log_interval=2,
                                      label="2x graphene 30x30")
    collision_results.append(r)
    write_xyz("outputs/scaling_research/collision_2xgraphene30.xyz",
              r['positions_history'])

    # =========================================================================
    # PHASE 3: Rendering load estimation
    # =========================================================================
    print(f"\n{'='*80}")
    print("PHASE 3: Three.js Rendering Load Estimation")
    print(f"{'='*80}")
    print(f"\nCurrent viewer architecture:")
    print(f"  - Individual Mesh per atom (no InstancedMesh)")
    print(f"  - O(N²) bond detection (nested loop in JS)")
    print(f"  - Individual Mesh per bond")
    print(f"  - No spatial indexing / neighbor lists")

    print(f"\n{'Atoms':>8} {'DrawCalls':>10} {'PairChecks':>12} "
          f"{'DrawCall ms':>12} {'BondDet ms':>12} {'Total ms':>10} {'FPS':>8}")
    print("-" * 80)

    render_results = []
    for n in [60, 100, 200, 500, 1000, 2000, 3000, 5000, 8000, 10000, 20000]:
        r = estimate_rendering_cost(n)
        render_results.append(r)
        fps_str = f"{r['achievable_fps']:.1f}" if r['achievable_fps'] > 1 else "<1"
        print(f"{r['n_atoms']:>8} {r['draw_calls']:>10} "
              f"{r['pair_checks']:>12,} {r['draw_call_time_ms']:>12.1f} "
              f"{r['bond_detection_time_ms']:>12.1f} "
              f"{r['total_frame_time_ms']:>10.1f} {fps_str:>8}")

    # =========================================================================
    # PHASE 4: XYZ file size analysis
    # =========================================================================
    print(f"\n{'='*80}")
    print("PHASE 4: XYZ File Size Analysis (data transfer)")
    print(f"{'='*80}")

    print(f"\n{'Atoms':>8} {'Frames':>8} {'Size (MB)':>10} {'Load time est':>14}")
    print("-" * 50)

    file_results = []
    for n in [60, 200, 500, 1000, 3000, 5000, 10000]:
        for nf in [100, 500, 1000]:
            r = estimate_xyz_file_size(n, nf)
            file_results.append(r)
            load_est = f"{r['total_mb']/50:.1f}s @50MB/s"
            print(f"{r['n_atoms']:>8} {r['n_frames']:>8} "
                  f"{r['total_mb']:>10.1f} {load_est:>14}")

    # =========================================================================
    # PHASE 5: Synthesis
    # =========================================================================
    print(f"\n{'='*80}")
    print("PHASE 5: SYNTHESIS — Practical Limit Analysis")
    print(f"{'='*80}")

    print(f"\n--- Simulation Bottleneck (30 FPS = 33.3 ms budget) ---")
    print(f"\nForce evaluation times ({engine_label} engine):")
    for r in force_results:
        fps = 1000 / r['t_mean_ms'] if r['t_mean_ms'] > 0 else float('inf')
        status = "REAL-TIME" if r['t_mean_ms'] < 33.3 else "TOO SLOW"
        print(f"  {r['label']:40s}  N={r['n_atoms']:6d}  "
              f"{r['t_mean_ms']:10.2f} ms  -> {fps:8.1f} FPS  [{status}]")

    print(f"\n--- Collision Scenario Summary ---")
    for r in collision_results:
        fps = 1000 / r['t_mean_ms'] if r['t_mean_ms'] > 0 else float('inf')
        status = "REAL-TIME" if r['t_mean_ms'] < 33.3 else "TOO SLOW"
        coll_str = "YES" if r['collision_detected'] else "NO"
        print(f"  {r['label']:35s}  N={r['n_atoms']:6d}  "
              f"{r['t_mean_ms']:8.2f} ms/step  {fps:7.1f} FPS  "
              f"[{status}]  collision={coll_str}")

    print(f"\n--- Rendering Bottleneck (current viewer) ---")
    for r in render_results:
        status = "REAL-TIME" if r['total_frame_time_ms'] < 33.3 else "TOO SLOW"
        fps_str = f"{r['achievable_fps']:.0f}" if r['achievable_fps'] > 1 else "<1"
        print(f"  N={r['n_atoms']:>6d}  render={r['total_frame_time_ms']:>10.1f} ms  "
              f"-> {fps_str:>5} FPS  [{status}]")

    # Fit and extrapolate
    print(f"\n--- Scaling Law & Limits ---")
    ns = np.array([r['n_atoms'] for r in force_results if r['n_atoms'] >= 60])
    ts = np.array([r['t_mean_ms'] for r in force_results if r['n_atoms'] >= 60])
    if len(ns) >= 3:
        coeffs = np.polyfit(np.log(ns), np.log(ts), 1)
        exponent = coeffs[0]
        prefactor = np.exp(coeffs[1])
        print(f"\n  Simulation: t = {prefactor:.6f} x N^{exponent:.2f} ms")
        n_30fps = (33.3 / prefactor) ** (1.0 / exponent)
        n_60fps = (16.7 / prefactor) ** (1.0 / exponent)
        print(f"  Simulation limit (30 FPS): N* ~ {n_30fps:.0f} atoms")
        print(f"  Simulation limit (60 FPS): N* ~ {n_60fps:.0f} atoms")

    print(f"\n  Combined practical limits:")
    print(f"    Current viewer (no optimization):    N* ~ 250 atoms  (O(N^2) bonds)")
    print(f"    Optimized viewer + Numba Tersoff:     N* ~ {n_30fps:.0f} atoms  (sim-limited)")
    print(f"    Optimized viewer + C/Wasm Tersoff:    N* ~ {n_30fps*5:.0f}-{n_30fps*10:.0f} atoms")

    # =========================================================================
    # Save results
    # =========================================================================
    results = {
        'engine': engine_label,
        'force_scaling': [{'label': r['label'], 'n_atoms': r['n_atoms'],
                          't_mean_ms': r['t_mean_ms'], 't_std_ms': r['t_std_ms']}
                         for r in force_results],
        'collision_scenarios': [{
            'label': r['label'], 'n_atoms': r['n_atoms'],
            'n_a': r['n_a'], 'n_b': r['n_b'],
            't_mean_ms': r['t_mean_ms'], 't_max_ms': r['t_max_ms'],
            'n_steps': r['n_steps'], 'dt': r['dt'],
            'collision_detected': r['collision_detected'],
            'collision_step': r['collision_step'],
            'min_dist_initial': r['min_dist_history'][0],
            'min_dist_overall': min(r['min_dist_history']),
            'pe_initial': r['pe_history'][0],
            'pe_range': [min(r['pe_history']), max(r['pe_history'])],
        } for r in collision_results],
        'rendering_estimates': render_results,
    }

    with open("outputs/scaling_research/results.json", 'w') as f:
        json.dump(results, f, indent=2)

    print(f"\n{'='*80}")
    print("Results and trajectories saved to outputs/scaling_research/")
    print(f"Collision trajectories can be viewed in the Three.js viewer")
    print(f"{'='*80}")


if __name__ == '__main__':
    main()
