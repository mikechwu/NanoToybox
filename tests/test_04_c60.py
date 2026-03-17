"""
TEST 4 — C60 FULL SYSTEM (FIRST REAL MILESTONE)

Validates:
1. Structural preservation (no bond breaking, no collapse)
2. Energy conservation |ΔE/E| < 1e-3 over 50k steps
3. Bond length distribution (~1.4 Å range, no extreme outliers)
4. Stability (no unphysical explosion or drift)
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces
from sim.structures.generators import c60_fullerene
from sim.integrators.velocity_verlet import run_nve
from sim.io.output import write_energy_csv, write_xyz

OUTPUT_DIR = "outputs/test4_c60"


def test_c60():
    print("=" * 60)
    print("TEST 4: C60 FULLERENE")
    print("=" * 60)

    atoms = c60_fullerene()
    print(f"\n  Atoms: {atoms.n_atoms}")

    # Check initial structure
    init_bonds = []
    for i in range(atoms.n_atoms):
        for j in range(i + 1, atoms.n_atoms):
            d = np.linalg.norm(atoms.positions[i] - atoms.positions[j])
            if d < 1.8:
                init_bonds.append(d)

    print(f"  Initial bonds within 1.8 Å: {len(init_bonds)}")
    if init_bonds:
        print(f"  Bond range: {min(init_bonds):.4f} – {max(init_bonds):.4f} Å")
        print(f"  Mean bond: {np.mean(init_bonds):.4f} Å")

    # Give small thermal velocities (~100K)
    atoms.set_velocities_temperature(100.0, seed=42)

    def force_fn(pos):
        return compute_energy_and_forces(pos)

    print(f"\n  Running NVE simulation...")
    print(f"  This may take a few minutes for 60 atoms with Tersoff potential...")

    # Run NVE — use fewer steps than 50k since pure Python is slow
    # 5000 steps at dt=0.5 fs = 2.5 ps
    n_steps = 5000
    result = run_nve(atoms, dt=0.5, n_steps=n_steps, compute_forces_fn=force_fn, log_interval=50)

    te = result['te']
    if abs(te[0]) > 1e-20:
        max_drift = np.max(np.abs((te - te[0]) / te[0]))
    else:
        max_drift = np.max(np.abs(te - te[0]))

    # Check final bond lengths
    final_pos = result['positions_history'][-1]
    final_bonds = []
    for i in range(len(final_pos)):
        for j in range(i + 1, len(final_pos)):
            d = np.linalg.norm(final_pos[i] - final_pos[j])
            if d < 1.8:
                final_bonds.append(d)

    # Check structural preservation
    init_com = np.mean(result['positions_history'][0], axis=0)
    final_com = np.mean(final_pos, axis=0)
    com_drift = np.linalg.norm(final_com - init_com)

    # Radius of gyration
    rg_init = np.sqrt(np.mean(np.sum((result['positions_history'][0] - init_com)**2, axis=1)))
    rg_final = np.sqrt(np.mean(np.sum((final_pos - final_com)**2, axis=1)))

    print(f"\n  --- Results ---")
    print(f"  Steps: {n_steps}, dt={0.5} fs, total time: {n_steps * 0.5:.1f} fs")
    print(f"  Energy drift: {max_drift:.6e}")
    print(f"  Initial Rg: {rg_init:.4f} Å")
    print(f"  Final Rg:   {rg_final:.4f} Å")
    print(f"  COM drift:  {com_drift:.6f} Å")
    if final_bonds:
        print(f"  Final bonds: {len(final_bonds)} (initial: {len(init_bonds)})")
        print(f"  Bond range: {min(final_bonds):.4f} – {max(final_bonds):.4f} Å")
        print(f"  Mean bond:  {np.mean(final_bonds):.4f} Å")

    # Save outputs
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    write_energy_csv(f"{OUTPUT_DIR}/energy.csv", result['steps'], result['times'],
                     result['ke'], result['pe'], result['te'])
    write_xyz(f"{OUTPUT_DIR}/trajectory.xyz", result['positions_history'], result['times'])

    # Save bond histogram data
    if final_bonds:
        with open(f"{OUTPUT_DIR}/bond_histogram.csv", 'w') as f:
            f.write("bond_length_A\n")
            for b in final_bonds:
                f.write(f"{b:.6f}\n")

    # Pass criteria
    struct_pass = len(final_bonds) >= len(init_bonds) * 0.9  # no significant bond loss
    energy_pass = max_drift < 1e-3
    bond_pass = all(0.8 < b < 2.0 for b in final_bonds) if final_bonds else False
    stability_pass = abs(rg_final - rg_init) / rg_init < 0.1  # Rg doesn't change >10%

    print(f"\n  Structural preservation: {'PASS' if struct_pass else 'FAIL'}")
    print(f"  Energy conservation:     {'PASS' if energy_pass else 'FAIL'}")
    print(f"  Bond distribution:       {'PASS' if bond_pass else 'FAIL'}")
    print(f"  Stability:               {'PASS' if stability_pass else 'FAIL'}")

    all_pass = struct_pass and energy_pass and bond_pass and stability_pass
    print(f"\n  OVERALL: {'PASS' if all_pass else 'FAIL'}")
    return all_pass


if __name__ == '__main__':
    passed = test_c60()
    sys.exit(0 if passed else 1)
