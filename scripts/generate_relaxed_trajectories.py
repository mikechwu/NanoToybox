"""
Generate relaxed reference structures and finite-temperature trajectories.

Workflow:
1. Start from designed geometry
2. Relax to 0 K minimum energy
3. Save canonical relaxed structure
4. Initialize thermal velocities from relaxed geometry
5. Run NVE and save trajectory

This produces trajectories that start from validated equilibrium,
not from potentially incorrect designed coordinates.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces
from sim.structures.generators import c60_fullerene, graphene_patch
from sim.minimizer import simple_minimize
from sim.integrators.velocity_verlet import run_nve
from sim.io.output import write_xyz, write_energy_csv

STRUCT_DIR = "structures"
OUTPUT_DIR = "outputs"


def force_fn(pos):
    return compute_energy_and_forces(pos)


def workflow(name, atoms, temperature_k=300, n_steps=2000, dt=0.5):
    """Full workflow: relax → save → thermalize → simulate → save."""
    print(f"\n{'='*60}")
    print(f"  {name}: {atoms.n_atoms} atoms")
    print(f"{'='*60}")

    # 1. Record original geometry
    orig_pos = atoms.positions.copy()
    e_orig, f_orig, _ = force_fn(orig_pos)
    fmax_orig = np.max(np.linalg.norm(f_orig, axis=1))
    print(f"\n  Original: PE={e_orig:.4f} eV, Fmax={fmax_orig:.4f} eV/Å")

    # Save original structure
    os.makedirs(STRUCT_DIR, exist_ok=True)
    write_xyz(f"{STRUCT_DIR}/{name}_original.xyz", [orig_pos],
              comment=f"original PE={e_orig:.4f}eV")

    # 2. Relax to 0 K
    print(f"  Relaxing to 0 K...")
    result = simple_minimize(atoms, force_fn, max_steps=5000, f_tol=1e-3)
    e_relaxed = result['final_energy']
    _, f_relaxed, _ = force_fn(atoms.positions)
    fmax_relaxed = np.max(np.linalg.norm(f_relaxed, axis=1))
    favg_relaxed = np.mean(np.linalg.norm(f_relaxed, axis=1))

    # Geometry comparison
    disp = np.linalg.norm(atoms.positions - orig_pos, axis=1)
    max_disp = np.max(disp)
    mean_disp = np.mean(disp)

    print(f"  Relaxed:  PE={e_relaxed:.4f} eV, Fmax={fmax_relaxed:.6f} eV/Å")
    print(f"  ΔE = {e_orig - e_relaxed:.4f} eV (lowered)")
    print(f"  Max displacement from original: {max_disp:.4f} Å")
    print(f"  Mean displacement: {mean_disp:.4f} Å")

    # 3. Save relaxed structure
    write_xyz(f"{STRUCT_DIR}/{name}_relaxed.xyz", [atoms.positions],
              comment=f"relaxed PE={e_relaxed:.4f}eV fmax={fmax_relaxed:.2e}eV/A")
    print(f"  Saved: {STRUCT_DIR}/{name}_relaxed.xyz")

    # 4. Initialize thermal velocities
    print(f"\n  Initializing velocities at {temperature_k} K...")
    atoms.set_velocities_temperature(temperature_k, seed=42)
    atoms.remove_angular_momentum()
    # Re-rescale after angular momentum removal
    current_t = atoms.temperature()
    if current_t > 0:
        scale = np.sqrt(temperature_k / current_t)
        atoms.velocities *= scale

    print(f"  Temperature after init: {atoms.temperature():.1f} K")
    print(f"  COM velocity: {np.linalg.norm(np.mean(atoms.velocities * atoms.masses[:, None], axis=0) / np.mean(atoms.masses)):.2e} Å/fs")

    # 5. Run NVE
    print(f"  Running NVE ({n_steps} steps, dt={dt} fs)...")
    out_dir = f"{OUTPUT_DIR}/{name}_from_relaxed"
    os.makedirs(out_dir, exist_ok=True)

    sim_result = run_nve(atoms, dt=dt, n_steps=n_steps, compute_forces_fn=force_fn, log_interval=20)

    te = sim_result['te']
    drift = np.max(np.abs((te - te[0]) / te[0])) if abs(te[0]) > 1e-20 else 0

    write_energy_csv(f"{out_dir}/energy.csv", sim_result['steps'], sim_result['times'],
                     sim_result['ke'], sim_result['pe'], sim_result['te'])
    write_xyz(f"{out_dir}/trajectory.xyz", sim_result['positions_history'], sim_result['times'],
              comment=f"{name} T={temperature_k}K from relaxed")

    print(f"  NVE drift: {drift:.2e}")
    print(f"  Saved: {out_dir}/trajectory.xyz, {out_dir}/energy.csv")

    return {
        'name': name,
        'e_original': e_orig,
        'fmax_original': fmax_orig,
        'e_relaxed': e_relaxed,
        'fmax_relaxed': fmax_relaxed,
        'favg_relaxed': favg_relaxed,
        'max_displacement': max_disp,
        'mean_displacement': mean_disp,
        'nve_drift': drift,
        'temperature': temperature_k,
    }


if __name__ == '__main__':
    results = []
    results.append(workflow("c60", c60_fullerene(), temperature_k=300, n_steps=2000, dt=0.5))
    results.append(workflow("graphene", graphene_patch(nx=3, ny=3), temperature_k=100, n_steps=2000, dt=0.3))

    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    for r in results:
        print(f"\n  {r['name']}:")
        print(f"    Original PE: {r['e_original']:.4f} eV, Fmax: {r['fmax_original']:.4f} eV/Å")
        print(f"    Relaxed PE:  {r['e_relaxed']:.4f} eV, Fmax: {r['fmax_relaxed']:.6f} eV/Å")
        print(f"    Geometry change: max {r['max_displacement']:.4f} Å, mean {r['mean_displacement']:.4f} Å")
        print(f"    NVE drift from relaxed: {r['nve_drift']:.2e}")
