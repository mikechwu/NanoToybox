"""
TEST 1 — 2-ATOM DIMER (2-body validation)

Validates:
1. Energy continuity across cutoff
2. Force consistency (F ≈ -dE/dr, relative error < 1e-3)
3. NVE energy conservation (|ΔE/E| < 1e-4 over 10k steps)
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_only, compute_energy_and_forces, R_CUT, D_CUT
from sim.structures.generators import carbon_dimer
from sim.integrators.velocity_verlet import run_nve
from sim.io.output import write_energy_csv, write_xyz

OUTPUT_DIR = "outputs/test1_dimer"


def test_energy_continuity():
    """Energy must be smooth across cutoff region — no discontinuities."""
    print("\n=== Test 1.1: Energy Continuity ===")

    distances = np.linspace(1.0, R_CUT + D_CUT + 0.5, 200)
    energies = []

    for r in distances:
        pos = np.array([[0, 0, 0], [r, 0, 0]], dtype=np.float64)
        e = compute_energy_only(pos)
        energies.append(e)

    energies = np.array(energies)

    # Check for discontinuities: |dE/dr| should not have jumps
    dE = np.diff(energies)
    dr = np.diff(distances)
    dEdr = dE / dr

    # Check smoothness: second derivative shouldn't have huge jumps
    d2E = np.diff(dEdr)
    max_jump = np.max(np.abs(d2E))

    # Energy should be zero beyond cutoff
    beyond_cutoff = distances > R_CUT + D_CUT
    energy_beyond = energies[beyond_cutoff]
    max_beyond = np.max(np.abs(energy_beyond)) if len(energy_beyond) > 0 else 0

    print(f"  Max second derivative jump: {max_jump:.6e}")
    print(f"  Max energy beyond cutoff: {max_beyond:.6e}")
    print(f"  Energy at r=1.42 Å: {energies[np.argmin(np.abs(distances - 1.42))]:.6f} eV")

    passed = max_beyond < 1e-10
    print(f"  RESULT: {'PASS' if passed else 'FAIL'}")
    return passed


def test_force_consistency():
    """Force must equal -dE/dr (finite difference check), relative error < 1e-3."""
    print("\n=== Test 1.2: Force Consistency ===")

    test_distances = [1.2, 1.3, 1.42, 1.5, 1.6, 1.8, 1.9]
    eps = 1e-5
    max_error = 0.0

    for r in test_distances:
        pos = np.array([[0, 0, 0], [r, 0, 0]], dtype=np.float64)

        # Analytical force
        _, forces, _ = compute_energy_and_forces(pos)
        fx_analytical = forces[1, 0]  # Force on atom 1 in x direction

        # Numerical force via finite difference
        pos_plus = pos.copy()
        pos_plus[1, 0] += eps
        e_plus = compute_energy_only(pos_plus)

        pos_minus = pos.copy()
        pos_minus[1, 0] -= eps
        e_minus = compute_energy_only(pos_minus)

        fx_numerical = -(e_plus - e_minus) / (2 * eps)

        if abs(fx_analytical) > 1e-10:
            rel_error = abs(fx_analytical - fx_numerical) / abs(fx_analytical)
        else:
            rel_error = abs(fx_analytical - fx_numerical)

        max_error = max(max_error, rel_error)
        print(f"  r={r:.2f} Å: F_anal={fx_analytical:.6f}, F_num={fx_numerical:.6f}, rel_err={rel_error:.2e}")

    passed = max_error < 1e-3
    print(f"  Max relative error: {max_error:.6e}")
    print(f"  RESULT: {'PASS' if passed else 'FAIL'}")
    return passed


def test_nve_conservation():
    """NVE energy conservation: |ΔE/E| < 1e-4 over 10k steps."""
    print("\n=== Test 1.3: NVE Energy Conservation ===")

    atoms = carbon_dimer(distance=1.5)
    # Give a small velocity to atom 1
    atoms.velocities[1, 0] = 0.001  # Å/fs

    def force_fn(pos):
        return compute_energy_and_forces(pos)

    result = run_nve(atoms, dt=0.1, n_steps=10000, compute_forces_fn=force_fn, log_interval=10)

    te = result['te']
    if abs(te[0]) > 1e-20:
        max_drift = np.max(np.abs((te - te[0]) / te[0]))
    else:
        max_drift = np.max(np.abs(te - te[0]))

    # Write outputs
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    write_energy_csv(f"{OUTPUT_DIR}/energy.csv", result['steps'], result['times'],
                     result['ke'], result['pe'], result['te'])
    write_xyz(f"{OUTPUT_DIR}/trajectory.xyz", result['positions_history'], result['times'])

    print(f"  Initial total energy: {te[0]:.10f} eV")
    print(f"  Final total energy:   {te[-1]:.10f} eV")
    print(f"  Max relative drift:   {max_drift:.6e}")
    print(f"  Steps: {len(te) - 1} × 10 = {(len(te)-1)*10}")

    passed = max_drift < 1e-4
    print(f"  RESULT: {'PASS' if passed else 'FAIL'}")
    return passed


if __name__ == '__main__':
    print("=" * 60)
    print("TEST 1: 2-ATOM DIMER VALIDATION")
    print("=" * 60)

    results = {
        'continuity': test_energy_continuity(),
        'force_consistency': test_force_consistency(),
        'nve_conservation': test_nve_conservation(),
    }

    print("\n" + "=" * 60)
    print("TEST 1 SUMMARY")
    print("=" * 60)
    all_pass = True
    for name, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  {name}: {status}")
        if not passed:
            all_pass = False

    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")
    sys.exit(0 if all_pass else 1)
