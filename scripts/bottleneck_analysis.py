"""
Deep bottleneck analysis of the relaxation pipeline.

Profiles: force evaluation, minimizer overhead, descriptor cost,
and identifies where time is spent per atom count.
"""
import sys, os, time, cProfile, pstats, io
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces, compute_energy_only
from sim.structures.generate import c60, cnt_armchair, cnt_zigzag, graphene, diamond
from sim.minimizer import simple_minimize, minimize as fire_minimize
from sim.atoms import Atoms


def force_fn(pos):
    return compute_energy_and_forces(pos)


def time_force_eval(positions, n_reps=3):
    """Time a single force evaluation."""
    t0 = time.perf_counter()
    for _ in range(n_reps):
        compute_energy_and_forces(positions)
    return (time.perf_counter() - t0) / n_reps


def time_minimization(atoms, method='sd', f_tol=1e-3, max_steps=500):
    """Time a full minimization run, return (total_time, n_steps, n_force_evals)."""
    a = atoms.copy()
    t0 = time.perf_counter()
    if method == 'sd':
        r = simple_minimize(a, force_fn, max_steps=max_steps, f_tol=f_tol)
    else:
        r = fire_minimize(a, force_fn, max_steps=max_steps, f_tol=f_tol)
    total = time.perf_counter() - t0
    # Each step does ~1-2 force evals (backtracking adds extra)
    return total, r['steps'], r['converged']


def profile_force_eval(positions):
    """Use cProfile to find hotspots within force evaluation."""
    pr = cProfile.Profile()
    pr.enable()
    compute_energy_and_forces(positions)
    pr.disable()

    s = io.StringIO()
    ps = pstats.Stats(pr, stream=s).sort_stats('cumulative')
    ps.print_stats(15)
    return s.getvalue()


def analyze_scaling():
    """Measure how force eval scales with atom count."""
    print("=" * 70)
    print("FORCE EVALUATION SCALING")
    print("=" * 70)

    systems = [
        ("C60", c60(), 60),
        ("graphene 4x4", graphene(4, 4), None),
        ("CNT (5,5) x1", cnt_armchair(5, 1), None),
        ("graphene 6x6", graphene(6, 6), None),
        ("CNT (5,5) x3", cnt_armchair(5, 3), None),
        ("C60 (from lib)", c60(), 60),
        ("graphene 8x8", graphene(8, 8), None),
        ("CNT (5,5) x5", cnt_armchair(5, 5), None),
        ("graphene 10x10", graphene(10, 10), None),
        ("CNT (5,5) x10", cnt_armchair(5, 10), None),
    ]

    results = []
    for name, atoms, _ in systems:
        n = atoms.n_atoms
        # Quick relax to get reasonable geometry
        simple_minimize(atoms, force_fn, max_steps=50, f_tol=0.1)
        t = time_force_eval(atoms.positions, n_reps=max(1, min(5, 300 // n)))
        per_atom = t / n * 1000  # ms per atom
        results.append((name, n, t))
        print(f"  {name:<25} {n:>5} atoms  {t*1000:>10.1f} ms  {per_atom:>6.3f} ms/atom")

    # Fit scaling
    ns = np.array([r[1] for r in results])
    ts = np.array([r[2] for r in results])
    mask = ns > 30  # skip tiny systems
    if np.sum(mask) >= 3:
        coeffs = np.polyfit(np.log(ns[mask]), np.log(ts[mask]), 1)
        print(f"\n  Scaling: t ∝ N^{coeffs[0]:.2f}")
        print(f"  This means: doubling atoms → {2**coeffs[0]:.1f}x slower")

    return results


def analyze_force_hotspots():
    """Profile where time is spent inside force evaluation."""
    print("\n" + "=" * 70)
    print("FORCE EVALUATION HOTSPOTS (C60, 60 atoms)")
    print("=" * 70)

    atoms = c60()
    simple_minimize(atoms, force_fn, max_steps=50, f_tol=0.1)
    profile = profile_force_eval(atoms.positions)
    print(profile)

    print("\n" + "=" * 70)
    print("FORCE EVALUATION HOTSPOTS (CNT 5,5 x5, 100 atoms)")
    print("=" * 70)
    atoms2 = cnt_armchair(5, 5)
    simple_minimize(atoms2, force_fn, max_steps=50, f_tol=0.1)
    profile2 = profile_force_eval(atoms2.positions)
    print(profile2)


def analyze_minimizer_overhead():
    """Compare time in force eval vs minimizer overhead."""
    print("\n" + "=" * 70)
    print("MINIMIZER OVERHEAD ANALYSIS")
    print("=" * 70)

    for name, atoms in [("C60", c60()), ("CNT(5,5)x5", cnt_armchair(5, 5))]:
        n = atoms.n_atoms
        t_force = time_force_eval(atoms.positions)
        t_min, steps, conv = time_minimization(atoms, 'sd', max_steps=200)
        force_evals_est = steps * 2  # ~2 evals per step (with backtracking)
        t_forces_total = t_force * force_evals_est
        overhead = t_min - t_forces_total

        print(f"\n  {name} ({n} atoms):")
        print(f"    Single force eval:  {t_force*1000:.1f} ms")
        print(f"    Minimization:       {t_min*1000:.0f} ms ({steps} steps)")
        print(f"    Est. force time:    {t_forces_total*1000:.0f} ms ({force_evals_est} evals)")
        print(f"    Minimizer overhead: {overhead*1000:.0f} ms ({overhead/t_min*100:.0f}%)")
        print(f"    Force eval fraction: {t_forces_total/t_min*100:.0f}%")


def analyze_inner_loops():
    """Measure time in specific inner loop components."""
    print("\n" + "=" * 70)
    print("INNER LOOP BREAKDOWN (C60)")
    print("=" * 70)

    atoms = c60()
    simple_minimize(atoms, force_fn, max_steps=50, f_tol=0.1)
    pos = atoms.positions
    n = len(pos)

    # Time neighbor list construction
    from sim.potentials.tersoff import R_CUT, D_CUT
    r_max = R_CUT + D_CUT

    t0 = time.perf_counter()
    for _ in range(10):
        nl = [[] for _ in range(n)]
        for i in range(n):
            for j in range(i + 1, n):
                rij = pos[j] - pos[i]
                dist = np.linalg.norm(rij)
                if dist < r_max:
                    nl[i].append(j)
                    nl[j].append(i)
    t_nl = (time.perf_counter() - t0) / 10

    # Time distance/rhat cache
    t0 = time.perf_counter()
    for _ in range(10):
        dist_cache = {}
        rhat_cache = {}
        for i in range(n):
            for j in nl[i]:
                if (i, j) not in dist_cache:
                    rij = pos[j] - pos[i]
                    d = np.linalg.norm(rij)
                    dist_cache[(i, j)] = d
                    dist_cache[(j, i)] = d
                    rhat_cache[(i, j)] = rij / d
                    rhat_cache[(j, i)] = -rhat_cache[(i, j)]
    t_cache = (time.perf_counter() - t0) / 10

    # Full force eval for reference
    t_total = time_force_eval(pos, 10)

    print(f"  Neighbor list:     {t_nl*1000:>8.2f} ms ({t_nl/t_total*100:.0f}%)")
    print(f"  Distance cache:    {t_cache*1000:>8.2f} ms ({t_cache/t_total*100:.0f}%)")
    print(f"  Force computation: {(t_total-t_nl-t_cache)*1000:>8.2f} ms ({(t_total-t_nl-t_cache)/t_total*100:.0f}%)")
    print(f"  Total:             {t_total*1000:>8.2f} ms")
    print(f"\n  Neighbor pairs: {sum(len(x) for x in nl)//2}")
    print(f"  Python loop iterations (neighbor pairs): {sum(len(x) for x in nl)//2}")
    print(f"  Python loop iterations (triplets): ~{sum(len(x)*(len(x)-1)//2 for x in nl)}")


def estimate_speedups():
    """Estimate speedups from various optimization strategies."""
    print("\n" + "=" * 70)
    print("OPTIMIZATION SPEEDUP ESTIMATES")
    print("=" * 70)

    atoms = c60()
    simple_minimize(atoms, force_fn, max_steps=50, f_tol=0.1)
    t_python = time_force_eval(atoms.positions, 5)

    print(f"\n  Current Python force eval (C60): {t_python*1000:.1f} ms")
    print()

    strategies = [
        ("NumPy vectorization (eliminate Python loops)",
         "Replace per-atom Python loops with vectorized NumPy operations",
         10, 50),
        ("Numba JIT compilation",
         "JIT-compile the force loop with @numba.njit",
         50, 200),
        ("C extension (via ctypes or cffi)",
         "Rewrite inner loops in C, call from Python",
         50, 200),
        ("Full C/C++ implementation",
         "Port entire force engine to C++",
         100, 500),
        ("C++ with OpenMP",
         "C++ with shared-memory parallelism",
         200, 1000),
        ("WebAssembly (Emscripten)",
         "C++ compiled to Wasm for browser",
         50, 200),
        ("ML surrogate (for relaxation only)",
         "Use ML to predict approximate forces for initial relaxation, then polish with analytical",
         2, 5),
    ]

    print(f"  {'Strategy':<45} {'Est. speedup':>15} {'Est. C60 time':>15}")
    print(f"  {'-'*45} {'-'*15} {'-'*15}")
    for name, desc, low, high in strategies:
        t_low = t_python / high * 1000
        t_high = t_python / low * 1000
        print(f"  {name:<45} {low:>5}–{high:<5}x    {t_low:>5.2f}–{t_high:.2f} ms")

    print(f"\n  Most impactful for relaxation pipeline:")
    print(f"  1. NumPy vectorization: eliminates Python for-loops in force calc (~10-50x)")
    print(f"  2. Numba JIT: near-C speed with minimal code changes (~50-200x)")
    print(f"  3. C extension: maximum speed, more effort (~100-500x)")


if __name__ == '__main__':
    analyze_scaling()
    analyze_force_hotspots()
    analyze_minimizer_overhead()
    analyze_inner_loops()
    estimate_speedups()
