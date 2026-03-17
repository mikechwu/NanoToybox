"""
Generate pilot ML dataset with force decomposition.

Produces NPY arrays + metadata.json per dataset case.
Verifies F_total ≈ F_2body + F_residual numerically.
"""
import sys
import os
import json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_force_decomposition, compute_energy_and_forces
from sim.structures.generators import c60_fullerene, graphene_patch
from sim.minimizer import simple_minimize
from sim.integrators.velocity_verlet import run_nve
from sim.io.output import write_xyz

DATA_DIR = "data"


def force_fn(pos):
    return compute_energy_and_forces(pos)


def save_dataset(name, positions_list, metadata):
    """Save a dataset case as NPY + metadata."""
    out_dir = os.path.join(DATA_DIR, name)
    os.makedirs(out_dir, exist_ok=True)

    n_frames = len(positions_list)
    n_atoms = len(positions_list[0])

    all_pos = np.zeros((n_frames, n_atoms, 3))
    all_f_total = np.zeros((n_frames, n_atoms, 3))
    all_f_2body = np.zeros((n_frames, n_atoms, 3))
    all_f_residual = np.zeros((n_frames, n_atoms, 3))
    all_energy = np.zeros(n_frames)
    all_e_2body = np.zeros(n_frames)

    max_decomp_error = 0.0

    for i, pos in enumerate(positions_list):
        decomp = compute_force_decomposition(pos)

        all_pos[i] = pos
        all_f_total[i] = decomp['forces_total']
        all_f_2body[i] = decomp['forces_2body']
        all_f_residual[i] = decomp['forces_residual']
        all_energy[i] = decomp['energy_total']
        all_e_2body[i] = decomp['energy_2body']

        # Verify decomposition: F_total = F_2body + F_residual
        recon = decomp['forces_2body'] + decomp['forces_residual']
        err = np.max(np.abs(decomp['forces_total'] - recon))
        max_decomp_error = max(max_decomp_error, err)

    np.save(os.path.join(out_dir, "positions.npy"), all_pos)
    np.save(os.path.join(out_dir, "forces_total.npy"), all_f_total)
    np.save(os.path.join(out_dir, "forces_2body.npy"), all_f_2body)
    np.save(os.path.join(out_dir, "forces_residual.npy"), all_f_residual)
    np.save(os.path.join(out_dir, "energies.npy"), all_energy)
    np.save(os.path.join(out_dir, "energies_2body.npy"), all_e_2body)

    # Save trajectory for viewer
    write_xyz(os.path.join(out_dir, "trajectory.xyz"), positions_list)

    metadata['n_frames'] = n_frames
    metadata['n_atoms'] = n_atoms
    metadata['max_decomposition_error'] = float(max_decomp_error)
    metadata['force_decomposition'] = True
    metadata['units'] = {'positions': 'angstrom', 'forces': 'eV/angstrom', 'energy': 'eV'}

    with open(os.path.join(out_dir, "metadata.json"), 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"  Saved {n_frames} frames to {out_dir}/")
    print(f"  Decomposition error: {max_decomp_error:.2e}")
    return max_decomp_error


def generate_relaxed(name, atoms):
    """Generate single relaxed frame."""
    print(f"\n--- {name} (relaxed) ---")
    simple_minimize(atoms, force_fn, max_steps=3000, f_tol=1e-3)
    return save_dataset(f"{name}_relaxed", [atoms.positions.copy()], {
        'system': name, 'case': 'relaxed', 'temperature_K': 0,
        'potential': 'tersoff_1988_carbon', 'started_from': 'designed_geometry',
    })


def generate_perturbed(name, atoms, n_perturbations=20, magnitude=0.03):
    """Generate perturbed frames around equilibrium."""
    print(f"\n--- {name} (perturbed ±{magnitude} Å) ---")
    simple_minimize(atoms, force_fn, max_steps=3000, f_tol=1e-3)
    relaxed = atoms.positions.copy()

    frames = [relaxed.copy()]  # Include relaxed frame
    rng = np.random.default_rng(42)
    for _ in range(n_perturbations):
        pert = rng.uniform(-magnitude, magnitude, relaxed.shape)
        frames.append(relaxed + pert)

    return save_dataset(f"{name}_perturbed", frames, {
        'system': name, 'case': 'perturbed', 'temperature_K': 0,
        'perturbation_magnitude_A': magnitude, 'n_perturbations': n_perturbations,
        'potential': 'tersoff_1988_carbon', 'started_from': 'relaxed_geometry',
    })


def generate_thermal(name, atoms, temperature_k, n_steps=500, dt=0.3, log_interval=10):
    """Generate thermal trajectory from relaxed structure."""
    print(f"\n--- {name} ({temperature_k} K, {n_steps} steps) ---")
    simple_minimize(atoms, force_fn, max_steps=3000, f_tol=1e-3)
    atoms.set_velocities_temperature(temperature_k, seed=42)
    atoms.remove_angular_momentum()
    scale = np.sqrt(temperature_k / atoms.temperature()) if atoms.temperature() > 0 else 1
    atoms.velocities *= scale

    result = run_nve(atoms, dt=dt, n_steps=n_steps, compute_forces_fn=force_fn, log_interval=log_interval)

    return save_dataset(f"{name}_{temperature_k}K", result['positions_history'], {
        'system': name, 'case': 'thermal', 'temperature_K': temperature_k,
        'timestep_fs': dt, 'n_steps': n_steps, 'log_interval': log_interval,
        'potential': 'tersoff_1988_carbon', 'started_from': 'relaxed_geometry',
    })


if __name__ == '__main__':
    print("=" * 60)
    print("PILOT DATASET GENERATION")
    print("=" * 60)

    errors = []

    # C60 cases
    errors.append(generate_relaxed("c60", c60_fullerene()))
    errors.append(generate_perturbed("c60", c60_fullerene(), n_perturbations=20))
    errors.append(generate_thermal("c60", c60_fullerene(), 100, n_steps=300, dt=0.3))
    errors.append(generate_thermal("c60", c60_fullerene(), 300, n_steps=300, dt=0.3))

    # Graphene cases
    errors.append(generate_relaxed("graphene", graphene_patch(nx=3, ny=3)))
    errors.append(generate_perturbed("graphene", graphene_patch(nx=3, ny=3), n_perturbations=20))
    errors.append(generate_thermal("graphene", graphene_patch(nx=3, ny=3), 100, n_steps=300, dt=0.2))

    max_err = max(errors)
    print(f"\n{'='*60}")
    print(f"PILOT DATASET COMPLETE")
    print(f"Max decomposition error across all cases: {max_err:.2e}")
    print(f"Decomposition verified: F_total = F_2body + F_residual ({'PASS' if max_err < 1e-10 else 'CHECK'})")
    print(f"{'='*60}")

    # Summary
    total_frames = 0
    for d in os.listdir(DATA_DIR):
        meta_path = os.path.join(DATA_DIR, d, "metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                meta = json.load(f)
                total_frames += meta.get('n_frames', 0)
                print(f"  {d}: {meta.get('n_frames', 0)} frames, {meta.get('n_atoms', 0)} atoms")

    print(f"\nTotal frames: {total_frames}")
