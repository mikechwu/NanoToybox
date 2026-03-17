"""Scaling analysis: how analytical vs ML costs grow with system size."""
import sys, os, time, pickle
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces, compute_2body_forces
from sim.structures.generators import c60_fullerene, graphene_patch
from sim.minimizer import simple_minimize
from ml.descriptors_v2 import compute_all_descriptors

def force_fn(pos):
    return compute_energy_and_forces(pos)

def benchmark(name, positions, n_reps=5):
    """Benchmark analytical, 2-body, and descriptor costs."""
    n = len(positions)

    # Analytical full
    t0 = time.time()
    for _ in range(n_reps): compute_energy_and_forces(positions)
    t_anal = (time.time() - t0) / n_reps

    # 2-body only
    t0 = time.time()
    for _ in range(n_reps): compute_2body_forces(positions)
    t_2body = (time.time() - t0) / n_reps

    # Descriptors
    t0 = time.time()
    for _ in range(n_reps): compute_all_descriptors(positions)
    t_desc = (time.time() - t0) / n_reps

    # MLP inference (if model available)
    t_mlp = 0.0
    try:
        with open("ml/models/v2_mlp.pkl", 'rb') as f:
            d = pickle.load(f)
        model, scaler_X, scaler_y = d['model'], d['scaler_X'], d['scaler_y']
        desc = compute_all_descriptors(positions)
        t0 = time.time()
        for _ in range(n_reps):
            scaler_y.inverse_transform(model.predict(scaler_X.transform(desc)))
        t_mlp = (time.time() - t0) / n_reps
    except: pass

    t_ml_total = t_2body + t_desc + t_mlp

    print(f"  {name} ({n} atoms):")
    print(f"    Analytical:   {t_anal*1000:8.1f} ms")
    print(f"    2-body:       {t_2body*1000:8.1f} ms")
    print(f"    Descriptors:  {t_desc*1000:8.1f} ms")
    print(f"    MLP:          {t_mlp*1000:8.1f} ms")
    print(f"    ML total:     {t_ml_total*1000:8.1f} ms")
    print(f"    Speedup:      {t_anal/t_ml_total:.2f}x")

    return {
        'name': name, 'n_atoms': n,
        't_analytical_ms': t_anal * 1000,
        't_2body_ms': t_2body * 1000,
        't_desc_ms': t_desc * 1000,
        't_mlp_ms': t_mlp * 1000,
        't_ml_total_ms': t_ml_total * 1000,
        'speedup': t_anal / t_ml_total,
    }


def main():
    print("=" * 60)
    print("SCALING ANALYSIS")
    print("=" * 60)

    results = []

    # 2 atoms
    from sim.structures.generators import carbon_dimer
    atoms = carbon_dimer(1.45)
    results.append(benchmark("Dimer", atoms.positions))

    # 3 atoms
    from sim.structures.generators import carbon_triangle
    atoms = carbon_triangle(1.42, 120)
    results.append(benchmark("Triangle", atoms.positions))

    # 18 atoms (graphene 3x3)
    atoms = graphene_patch(nx=3, ny=3)
    simple_minimize(atoms, force_fn, max_steps=500, f_tol=1e-2)
    results.append(benchmark("Graphene 3x3", atoms.positions))

    # 32 atoms (graphene 4x4)
    atoms = graphene_patch(nx=4, ny=4)
    simple_minimize(atoms, force_fn, max_steps=500, f_tol=1e-2)
    results.append(benchmark("Graphene 4x4", atoms.positions))

    # 60 atoms (C60)
    atoms = c60_fullerene()
    simple_minimize(atoms, force_fn, max_steps=500, f_tol=1e-2)
    results.append(benchmark("C60", atoms.positions, n_reps=3))

    # 72 atoms (graphene 6x6)
    atoms = graphene_patch(nx=6, ny=6)
    simple_minimize(atoms, force_fn, max_steps=200, f_tol=1e-1)
    results.append(benchmark("Graphene 6x6", atoms.positions, n_reps=2))

    # Scaling analysis
    print(f"\n{'='*60}")
    print("SCALING SUMMARY")
    print(f"{'='*60}")
    print(f"\n{'Name':<20} {'N':>5} {'Anal ms':>10} {'ML ms':>10} {'Speedup':>8}")
    print("-" * 55)
    for r in results:
        print(f"{r['name']:<20} {r['n_atoms']:>5} {r['t_analytical_ms']:>10.1f} {r['t_ml_total_ms']:>10.1f} {r['speedup']:>8.2f}x")

    # Extrapolation
    print(f"\n{'='*60}")
    print("EXTRAPOLATION")
    print(f"{'='*60}")

    # Fit power laws
    ns = np.array([r['n_atoms'] for r in results if r['n_atoms'] > 5])
    t_anal = np.array([r['t_analytical_ms'] for r in results if r['n_atoms'] > 5])
    t_ml = np.array([r['t_ml_total_ms'] for r in results if r['n_atoms'] > 5])

    # log-log fit
    if len(ns) >= 3:
        coeffs_anal = np.polyfit(np.log(ns), np.log(t_anal), 1)
        coeffs_ml = np.polyfit(np.log(ns), np.log(t_ml), 1)
        print(f"\n  Analytical scaling: t ∝ N^{coeffs_anal[0]:.2f}")
        print(f"  ML scaling: t ∝ N^{coeffs_ml[0]:.2f}")

        # Predict crossover
        for n_test in [100, 200, 500, 1000]:
            t_a = np.exp(coeffs_anal[1]) * n_test ** coeffs_anal[0]
            t_m = np.exp(coeffs_ml[1]) * n_test ** coeffs_ml[0]
            print(f"  N={n_test}: analytical ~{t_a:.0f} ms, ML ~{t_m:.0f} ms, speedup ~{t_a/t_m:.1f}x")

    # Descriptor cost analysis
    print(f"\n{'='*60}")
    print("DESCRIPTOR COST ANALYSIS")
    print(f"{'='*60}")
    for r in results:
        desc_pct = r['t_desc_ms'] / r['t_ml_total_ms'] * 100 if r['t_ml_total_ms'] > 0 else 0
        print(f"  {r['name']:<20}: desc = {r['t_desc_ms']:.1f} ms ({desc_pct:.0f}% of ML)")

    print(f"\n  Python descriptor cost per atom: {np.mean([r['t_desc_ms']/r['n_atoms'] for r in results if r['n_atoms'] > 5]):.3f} ms/atom")
    print(f"  C++ estimate (~100x speedup): {np.mean([r['t_desc_ms']/r['n_atoms'] for r in results if r['n_atoms'] > 5])/100:.5f} ms/atom")


if __name__ == '__main__':
    main()
