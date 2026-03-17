"""Benchmark product-relevant scenes for website feasibility."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces
from sim.structures.library import CATALOG

# Target: 60 FPS = 16.7 ms/frame. Force eval must be < ~10 ms to leave room for rendering.
TARGET_MS = 10.0
# Wasm speedup estimate (conservative: 50x over Python)
WASM_FACTOR = 50


def benchmark_scene(name, info):
    atoms = info['fn']()
    n = atoms.n_atoms
    pos = atoms.positions

    # Quick sanity — check bonds exist
    bonds = 0
    for i in range(min(n, 100)):
        for j in range(i+1, min(n, 100)):
            if np.linalg.norm(pos[i] - pos[j]) < 1.8:
                bonds += 1

    n_reps = max(1, min(5, int(500 / max(n, 1))))  # fewer reps for larger systems
    t0 = time.time()
    for _ in range(n_reps):
        compute_energy_and_forces(pos)
    t_python = (time.time() - t0) / n_reps
    t_wasm_est = t_python / WASM_FACTOR

    fps_python = 1000 / (t_python * 1000) if t_python > 0 else float('inf')
    fps_wasm = 1000 / (t_wasm_est * 1000) if t_wasm_est > 0 else float('inf')

    feasible = t_wasm_est * 1000 < TARGET_MS

    print(f"  {name:<25} {n:>5} atoms  Python: {t_python*1000:>8.1f} ms  "
          f"Wasm est: {t_wasm_est*1000:>6.2f} ms  "
          f"FPS(Wasm): {fps_wasm:>6.0f}  {'OK' if feasible else 'SLOW'}")

    return {
        'name': name, 'n_atoms': n, 'phase': info['phase'],
        'description': info['description'],
        't_python_ms': t_python * 1000,
        't_wasm_est_ms': t_wasm_est * 1000,
        'fps_wasm': fps_wasm,
        'feasible_60fps': feasible,
    }


def main():
    print("=" * 100)
    print("PRODUCT-RELEVANT SCALING BENCHMARKS")
    print(f"Target: <{TARGET_MS} ms/step in Wasm (est. {WASM_FACTOR}x Python speedup)")
    print("=" * 100)

    results = []
    for name, info in sorted(CATALOG.items(), key=lambda x: x[1]['atoms']):
        try:
            r = benchmark_scene(name, info)
            results.append(r)
        except Exception as e:
            print(f"  {name}: ERROR — {e}")

    # Summary by phase
    print(f"\n{'='*80}")
    print("PHASE 1 SCENES (first website version)")
    print(f"{'='*80}")
    for r in results:
        if r['phase'] == 1:
            status = "FEASIBLE" if r['feasible_60fps'] else "NEEDS ML OR OPTIMIZATION"
            print(f"  {r['description']:<35} {r['n_atoms']:>4} atoms  "
                  f"Wasm: {r['t_wasm_est_ms']:.2f} ms  {status}")

    print(f"\n{'='*80}")
    print("PHASE 2 SCENES (expansion)")
    print(f"{'='*80}")
    for r in results:
        if r['phase'] == 2:
            status = "FEASIBLE" if r['feasible_60fps'] else "NEEDS ML OR OPTIMIZATION"
            print(f"  {r['description']:<35} {r['n_atoms']:>4} atoms  "
                  f"Wasm: {r['t_wasm_est_ms']:.2f} ms  {status}")

    # Crossover analysis
    print(f"\n{'='*80}")
    print("ANALYTICAL WASM FEASIBILITY LIMIT")
    print(f"{'='*80}")
    max_feasible = max((r['n_atoms'] for r in results if r['feasible_60fps']), default=0)
    min_infeasible = min((r['n_atoms'] for r in results if not r['feasible_60fps']), default=float('inf'))
    print(f"  Largest feasible scene: {max_feasible} atoms")
    print(f"  Smallest infeasible scene: {min_infeasible} atoms")
    if max_feasible > 0 and min_infeasible < float('inf'):
        print(f"  Approximate limit: ~{(max_feasible + min_infeasible)//2} atoms at 60 FPS in Wasm")
    elif max_feasible > 0:
        print(f"  All tested scenes are feasible up to {max_feasible} atoms")

    return results


if __name__ == '__main__':
    main()
