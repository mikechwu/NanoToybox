"""
TEST 5 — STATIC / GROUND-STATE VALIDATION

For each system (dimer, triangle, graphene, C60):
1. Relax to minimum energy (0 K)
2. Verify near-zero forces
3. Record equilibrium bond lengths / angles / energy
4. Save canonical relaxed structures

This validates that the simulator finds CORRECT equilibria,
not just dynamically stable trajectories.
"""
import sys
import os
import json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces
from sim.structures.generators import carbon_dimer, carbon_triangle, graphene_patch, c60_fullerene
from sim.minimizer import simple_minimize
from sim.io.output import write_xyz

STRUCT_DIR = "structures"
OUTPUT_DIR = "outputs/test5_static"


def force_fn(pos):
    return compute_energy_and_forces(pos)


def analyze_bonds(positions, cutoff=1.8):
    """Return list of bond lengths < cutoff."""
    bonds = []
    n = len(positions)
    for i in range(n):
        for j in range(i + 1, n):
            d = np.linalg.norm(positions[i] - positions[j])
            if d < cutoff:
                bonds.append(d)
    return bonds


def relax_and_report(name, atoms, f_tol=1e-4):
    """Relax a structure and report results."""
    print(f"\n  --- {name} ({atoms.n_atoms} atoms) ---")

    # Initial state
    e0, f0, _ = force_fn(atoms.positions)
    fmax0 = np.max(np.linalg.norm(f0, axis=1))
    print(f"  Initial PE: {e0:.6f} eV, Fmax: {fmax0:.6f} eV/Å")

    # Relax
    result = simple_minimize(atoms, force_fn, max_steps=5000, f_tol=f_tol)

    e_final = result['final_energy']
    fmax_final = result['final_fmax']
    converged = result['converged']

    # Force analysis
    _, forces_final, _ = force_fn(atoms.positions)
    force_mags = np.linalg.norm(forces_final, axis=1)
    fmax = np.max(force_mags)
    favg = np.mean(force_mags)

    print(f"  Converged: {converged} in {result['steps']} steps")
    print(f"  Final PE: {e_final:.6f} eV")
    print(f"  Max force: {fmax:.6e} eV/Å")
    print(f"  Avg force: {favg:.6e} eV/Å")

    # Bond analysis
    bonds = analyze_bonds(atoms.positions)
    if bonds:
        print(f"  Bonds: {len(bonds)}, range: {min(bonds):.4f} – {max(bonds):.4f} Å, mean: {np.mean(bonds):.4f} Å")

    # Save relaxed structure
    os.makedirs(STRUCT_DIR, exist_ok=True)
    xyz_path = f"{STRUCT_DIR}/{name}_relaxed.xyz"
    write_xyz(xyz_path, [atoms.positions], comment=f"relaxed PE={e_final:.6f}eV fmax={fmax:.2e}eV/A")
    print(f"  Saved to: {xyz_path}")

    return {
        'name': name,
        'n_atoms': atoms.n_atoms,
        'converged': converged,
        'steps': result['steps'],
        'energy_eV': e_final,
        'fmax_eV_A': fmax,
        'favg_eV_A': favg,
        'bonds': bonds,
        'mean_bond': np.mean(bonds) if bonds else None,
        'structure_path': xyz_path,
    }


def test_static_dimer():
    atoms = carbon_dimer(distance=1.5)
    return relax_and_report("dimer", atoms, f_tol=1e-5)


def test_static_triangle():
    # Start near expected equilibrium angle (~120° for sp2 carbon)
    atoms = carbon_triangle(distance=1.42, angle_deg=120)
    return relax_and_report("triangle", atoms, f_tol=1e-2)


def test_static_graphene():
    atoms = graphene_patch(nx=3, ny=3)
    return relax_and_report("graphene", atoms, f_tol=1e-3)


def test_static_c60():
    atoms = c60_fullerene()
    return relax_and_report("c60", atoms, f_tol=1e-3)


def test_zero_k_stability(name, atoms):
    """Verify relaxed structure is stationary at 0K (no drift)."""
    print(f"\n  --- 0K Stability: {name} ---")

    # Run 100 steps at 0K (no initial velocity)
    from sim.integrators.velocity_verlet import run_nve
    atoms.velocities *= 0  # ensure zero velocity

    result = run_nve(atoms, dt=0.5, n_steps=100, compute_forces_fn=force_fn, log_interval=10)

    init_pos = result['positions_history'][0]
    final_pos = result['positions_history'][-1]
    max_displacement = np.max(np.linalg.norm(final_pos - init_pos, axis=1))

    te = result['te']
    drift = abs(te[-1] - te[0]) / abs(te[0]) if abs(te[0]) > 1e-20 else abs(te[-1] - te[0])

    print(f"  Max displacement after 100 steps: {max_displacement:.2e} Å")
    print(f"  Energy drift: {drift:.2e}")

    passed = max_displacement < 0.01 and drift < 1e-6
    print(f"  RESULT: {'PASS' if passed else 'FAIL'}")
    return passed


if __name__ == '__main__':
    print("=" * 60)
    print("TEST 5: STATIC / GROUND-STATE VALIDATION")
    print("=" * 60)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    results.append(test_static_dimer())
    results.append(test_static_triangle())
    results.append(test_static_graphene())
    results.append(test_static_c60())

    # Save summary
    summary_path = f"{OUTPUT_DIR}/static_validation_summary.json"
    summary = []
    for r in results:
        s = {}
        for k, v in r.items():
            if k == 'bonds':
                continue
            if isinstance(v, (np.bool_, np.integer)):
                s[k] = int(v)
            elif isinstance(v, np.floating):
                s[k] = float(v)
            else:
                s[k] = v
        if r['bonds']:
            s['n_bonds'] = len(r['bonds'])
            s['bond_range'] = [float(min(r['bonds'])), float(max(r['bonds']))]
        summary.append(s)

    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)

    # 0K stability tests on relaxed dimer and C60
    print("\n" + "=" * 60)
    print("0K STABILITY CHECKS")
    print("=" * 60)

    dimer = carbon_dimer(distance=results[0]['mean_bond'] if results[0]['mean_bond'] else 1.5)
    simple_minimize(dimer, force_fn, f_tol=1e-5)
    dimer_stable = test_zero_k_stability("dimer", dimer)

    # For C60, use the already-relaxed structure
    c60 = c60_fullerene()
    simple_minimize(c60, force_fn, f_tol=1e-3)
    c60_stable = test_zero_k_stability("c60", c60)

    # Summary
    print("\n" + "=" * 60)
    print("TEST 5 SUMMARY")
    print("=" * 60)

    all_pass = True
    for r in results:
        status = "PASS" if r['converged'] else "FAIL"
        print(f"  {r['name']}: {status} (PE={r['energy_eV']:.4f} eV, Fmax={r['fmax_eV_A']:.2e} eV/Å)")
        if not r['converged']:
            all_pass = False

    print(f"  0K dimer stability: {'PASS' if dimer_stable else 'FAIL'}")
    print(f"  0K C60 stability:   {'PASS' if c60_stable else 'FAIL'}")
    if not (dimer_stable and c60_stable):
        all_pass = False

    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")
    sys.exit(0 if all_pass else 1)
