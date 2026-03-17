"""
TEST 6 — PERTURBATION AROUND EQUILIBRIUM

For graphene and C60:
1. Start from relaxed structure
2. Apply small random perturbation
3. Run short NVE
4. Verify system responds sensibly (no immediate instability)
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces
from sim.structures.generators import graphene_patch, c60_fullerene
from sim.minimizer import simple_minimize
from sim.integrators.velocity_verlet import run_nve
from sim.io.output import write_energy_csv

OUTPUT_DIR = "outputs/test6_perturbation"


def force_fn(pos):
    return compute_energy_and_forces(pos)


def test_perturbation(name, atoms, perturb_magnitude=0.05):
    """
    Perturb a relaxed structure and verify sensible response.

    Args:
        name: test name
        atoms: Atoms object (will be relaxed first)
        perturb_magnitude: max displacement in Å
    """
    print(f"\n  --- {name} ({atoms.n_atoms} atoms) ---")

    # Relax first
    print(f"  Relaxing...")
    simple_minimize(atoms, force_fn, max_steps=3000, f_tol=1e-3)
    e_relaxed, _, _ = force_fn(atoms.positions)
    relaxed_pos = atoms.positions.copy()
    print(f"  Relaxed PE: {e_relaxed:.6f} eV")

    # Apply small perturbation
    rng = np.random.default_rng(42)
    perturbation = rng.uniform(-perturb_magnitude, perturb_magnitude, atoms.positions.shape)
    atoms.positions = relaxed_pos + perturbation

    e_perturbed, _, _ = force_fn(atoms.positions)
    print(f"  Perturbed PE: {e_perturbed:.6f} eV (ΔE = {e_perturbed - e_relaxed:.6f} eV)")

    # Perturbed energy should be higher (we moved away from minimum)
    energy_increased = e_perturbed > e_relaxed - 0.01

    # Run short NVE from perturbed state
    atoms.velocities *= 0  # start from rest
    result = run_nve(atoms, dt=0.2, n_steps=500, compute_forces_fn=force_fn, log_interval=5)

    te = result['te']
    pe = result['pe']
    ke = result['ke']

    # Energy conservation during perturbed dynamics
    if abs(te[0]) > 1e-20:
        max_drift = np.max(np.abs((te - te[0]) / te[0]))
    else:
        max_drift = np.max(np.abs(te - te[0]))

    # Structure didn't explode
    final_pos = result['positions_history'][-1]
    max_displacement = np.max(np.linalg.norm(final_pos - relaxed_pos, axis=1))

    # System should oscillate around equilibrium, not fly apart
    no_explosion = max_displacement < 2.0

    # Energy should be bounded (oscillating, not growing)
    e_range = np.max(te) - np.min(te)
    bounded = e_range < abs(e_relaxed) * 0.1  # Energy oscillations < 10% of total

    print(f"  NVE drift: {max_drift:.2e}")
    print(f"  Max displacement from equilibrium: {max_displacement:.4f} Å")
    print(f"  Energy range during dynamics: {e_range:.6f} eV")
    print(f"  Energy increased on perturbation: {'YES' if energy_increased else 'NO'}")

    # Save energy data
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    write_energy_csv(f"{OUTPUT_DIR}/{name}_energy.csv", result['steps'], result['times'],
                     result['ke'], result['pe'], result['te'])

    passed = energy_increased and no_explosion and bounded and max_drift < 1e-3
    print(f"  RESULT: {'PASS' if passed else 'FAIL'}")

    return {
        'name': name,
        'energy_increased': energy_increased,
        'no_explosion': no_explosion,
        'bounded': bounded,
        'drift': max_drift,
        'passed': passed,
    }


if __name__ == '__main__':
    print("=" * 60)
    print("TEST 6: PERTURBATION AROUND EQUILIBRIUM")
    print("=" * 60)

    r1 = test_perturbation("graphene", graphene_patch(nx=3, ny=3))
    r2 = test_perturbation("c60", c60_fullerene())

    print("\n" + "=" * 60)
    print("TEST 6 SUMMARY")
    print("=" * 60)
    print(f"  Graphene perturbation: {'PASS' if r1['passed'] else 'FAIL'}")
    print(f"  C60 perturbation:      {'PASS' if r2['passed'] else 'FAIL'}")

    all_pass = r1['passed'] and r2['passed']
    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")
    sys.exit(0 if all_pass else 1)
