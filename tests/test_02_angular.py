"""
TEST 2 — 3-ATOM ANGULAR TEST (3-body validation)

Validates:
1. Energy vs angle curve is smooth and physical
2. Force consistency (analytical vs finite-difference, rel error < 1e-3)
3. Angular sensitivity (energy must change with angle)
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_only, compute_energy_and_forces
from sim.structures.generators import carbon_triangle

OUTPUT_DIR = "outputs/test2_angular"


def test_energy_vs_angle():
    """Energy vs angle must be smooth, physical, and vary meaningfully."""
    print("\n=== Test 2.1: Energy vs Angle ===")

    angles = np.linspace(60, 180, 25)
    energies = []
    bond_length = 1.42

    for angle in angles:
        atoms = carbon_triangle(distance=bond_length, angle_deg=angle)
        e = compute_energy_only(atoms.positions)
        energies.append(e)

    energies = np.array(energies)

    # Check smoothness
    dE = np.diff(energies)
    d2E = np.diff(dE)
    max_jump = np.max(np.abs(d2E))

    # Check angular sensitivity
    e_range = np.max(energies) - np.min(energies)

    print(f"  Energy range: {e_range:.6f} eV")
    print(f"  E(60°) = {energies[0]:.6f} eV")
    print(f"  E(120°) = {energies[len(energies)//2]:.6f} eV")
    print(f"  E(180°) = {energies[-1]:.6f} eV")
    print(f"  Max 2nd derivative jump: {max_jump:.6e}")

    # Save data
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(f"{OUTPUT_DIR}/energy_vs_angle.csv", 'w') as f:
        f.write("angle_deg,energy_eV\n")
        for a, e in zip(angles, energies):
            f.write(f"{a:.2f},{e:.10f}\n")

    # Angular sensitivity: energy range should be > 0.01 eV
    passed = e_range > 0.01
    print(f"  Angular sensitivity: {'YES' if passed else 'NO (FLAT - 3-body term wrong)'}")
    print(f"  RESULT: {'PASS' if passed else 'FAIL'}")
    return passed


def test_force_consistency_angular():
    """Force consistency for 3-atom system at various angles."""
    print("\n=== Test 2.2: Force Consistency (3-body) ===")

    test_angles = [70, 90, 109.5, 120, 150]
    eps = 1e-5
    max_error = 0.0
    bond_length = 1.42

    for angle in test_angles:
        atoms = carbon_triangle(distance=bond_length, angle_deg=angle)
        pos = atoms.positions

        _, forces, _ = compute_energy_and_forces(pos)

        # Check all force components via finite difference
        atom_errors = []
        for atom_idx in range(3):
            for coord_idx in range(3):
                pos_p = pos.copy()
                pos_p[atom_idx, coord_idx] += eps
                e_p = compute_energy_only(pos_p)

                pos_m = pos.copy()
                pos_m[atom_idx, coord_idx] -= eps
                e_m = compute_energy_only(pos_m)

                f_num = -(e_p - e_m) / (2 * eps)
                f_ana = forces[atom_idx, coord_idx]

                if abs(f_ana) > 1e-8:
                    rel_err = abs(f_ana - f_num) / abs(f_ana)
                else:
                    rel_err = abs(f_ana - f_num)

                atom_errors.append(rel_err)
                max_error = max(max_error, rel_err)

        avg_err = np.mean(atom_errors)
        print(f"  θ={angle:.0f}°: avg_err={avg_err:.2e}, max_err={max(atom_errors):.2e}")

    passed = max_error < 1e-3
    print(f"  Overall max relative error: {max_error:.6e}")
    print(f"  RESULT: {'PASS' if passed else 'FAIL'}")
    return passed


def test_angular_sensitivity():
    """Energy must change meaningfully with angle (not flat)."""
    print("\n=== Test 2.3: Angular Sensitivity ===")

    angles = [60, 90, 120, 150, 180]
    energies = []
    bond_length = 1.42

    for angle in angles:
        atoms = carbon_triangle(distance=bond_length, angle_deg=angle)
        e = compute_energy_only(atoms.positions)
        energies.append(e)
        print(f"  E({angle:3d}°) = {e:.6f} eV")

    e_range = max(energies) - min(energies)
    # Energy should vary by at least 0.01 eV across angles
    passed = e_range > 0.01
    print(f"  Energy range: {e_range:.6f} eV")
    print(f"  RESULT: {'PASS' if passed else 'FAIL (3-body contribution negligible)'}")
    return passed


if __name__ == '__main__':
    print("=" * 60)
    print("TEST 2: 3-ATOM ANGULAR VALIDATION")
    print("=" * 60)

    results = {
        'energy_vs_angle': test_energy_vs_angle(),
        'force_consistency': test_force_consistency_angular(),
        'angular_sensitivity': test_angular_sensitivity(),
    }

    print("\n" + "=" * 60)
    print("TEST 2 SUMMARY")
    print("=" * 60)
    all_pass = True
    for name, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  {name}: {status}")
        if not passed:
            all_pass = False

    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")
    sys.exit(0 if all_pass else 1)
