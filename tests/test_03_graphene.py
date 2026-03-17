"""
TEST 3 — SMALL GRAPHENE PATCH

Validates:
1. Bond length ~1.42 Å ± 5%
2. Structural stability (no collapse/explosion)
3. NVE energy conservation |ΔE/E| < 1e-3
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces
from sim.structures.generators import graphene_patch
from sim.integrators.velocity_verlet import run_nve
from sim.io.output import write_energy_csv, write_xyz

OUTPUT_DIR = "outputs/test3_graphene"


def test_graphene():
    print("=" * 60)
    print("TEST 3: SMALL GRAPHENE PATCH")
    print("=" * 60)

    atoms = graphene_patch(nx=3, ny=3)
    print(f"\n  Atoms: {atoms.n_atoms}")

    # Give small thermal velocities (~50K to keep it gentle)
    atoms.set_velocities_temperature(50.0, seed=42)

    def force_fn(pos):
        return compute_energy_and_forces(pos)

    # Initial force computation
    e0, f0, _ = force_fn(atoms.positions)
    print(f"  Initial PE: {e0:.6f} eV")

    # Run short NVE (fewer steps for graphene since it's bigger)
    result = run_nve(atoms, dt=0.2, n_steps=5000, compute_forces_fn=force_fn, log_interval=50)

    te = result['te']
    if abs(te[0]) > 1e-20:
        max_drift = np.max(np.abs((te - te[0]) / te[0]))
    else:
        max_drift = np.max(np.abs(te - te[0]))

    # Check bond lengths
    final_pos = result['positions_history'][-1]
    r_max = 1.8  # only count bonded neighbors
    bond_lengths = []
    for i in range(len(final_pos)):
        for j in range(i + 1, len(final_pos)):
            d = np.linalg.norm(final_pos[i] - final_pos[j])
            if d < r_max:
                bond_lengths.append(d)

    avg_bond = np.mean(bond_lengths) if bond_lengths else 0
    bond_error = abs(avg_bond - 1.42) / 1.42

    # Check structural stability (no atom moved more than 2 Å from initial)
    init_pos = result['positions_history'][0]
    max_displacement = np.max(np.linalg.norm(final_pos - init_pos, axis=1))

    print(f"\n  --- Results ---")
    print(f"  Bond lengths: avg={avg_bond:.4f} Å (target: 1.42 Å, error: {bond_error*100:.1f}%)")
    print(f"  Max displacement: {max_displacement:.4f} Å")
    print(f"  Energy drift: {max_drift:.6e}")
    print(f"  Final KE: {result['ke'][-1]:.6f} eV")
    print(f"  Final PE: {result['pe'][-1]:.6f} eV")

    # Save outputs
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    write_energy_csv(f"{OUTPUT_DIR}/energy.csv", result['steps'], result['times'],
                     result['ke'], result['pe'], result['te'])
    write_xyz(f"{OUTPUT_DIR}/trajectory.xyz", result['positions_history'], result['times'])

    # Pass criteria
    bond_pass = bond_error < 0.05  # ±5%
    stability_pass = max_displacement < 2.0  # no explosion
    energy_pass = max_drift < 1e-3

    print(f"\n  Bond length: {'PASS' if bond_pass else 'FAIL'}")
    print(f"  Stability:   {'PASS' if stability_pass else 'FAIL'}")
    print(f"  Energy cons: {'PASS' if energy_pass else 'FAIL'}")

    all_pass = bond_pass and stability_pass and energy_pass
    print(f"\n  OVERALL: {'PASS' if all_pass else 'FAIL'}")
    return all_pass


if __name__ == '__main__':
    passed = test_graphene()
    sys.exit(0 if passed else 1)
