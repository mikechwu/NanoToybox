"""
Generate the first real training dataset (broader than pilot).

Adds diversity: multiple perturbation amplitudes, more temperatures,
strain cases, and more frames per case.
"""
import sys, os, json
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
    out_dir = os.path.join(DATA_DIR, name)
    os.makedirs(out_dir, exist_ok=True)
    n_frames = len(positions_list)
    n_atoms = len(positions_list[0])
    all_pos = np.zeros((n_frames, n_atoms, 3))
    all_ft = np.zeros((n_frames, n_atoms, 3))
    all_f2 = np.zeros((n_frames, n_atoms, 3))
    all_fr = np.zeros((n_frames, n_atoms, 3))
    all_en = np.zeros(n_frames)

    for i, pos in enumerate(positions_list):
        d = compute_force_decomposition(pos)
        all_pos[i] = pos
        all_ft[i] = d['forces_total']
        all_f2[i] = d['forces_2body']
        all_fr[i] = d['forces_residual']
        all_en[i] = d['energy_total']

    np.save(os.path.join(out_dir, "positions.npy"), all_pos)
    np.save(os.path.join(out_dir, "forces_total.npy"), all_ft)
    np.save(os.path.join(out_dir, "forces_2body.npy"), all_f2)
    np.save(os.path.join(out_dir, "forces_residual.npy"), all_fr)
    np.save(os.path.join(out_dir, "energies.npy"), all_en)
    write_xyz(os.path.join(out_dir, "trajectory.xyz"), positions_list)

    metadata['n_frames'] = n_frames
    metadata['n_atoms'] = n_atoms
    metadata['units'] = {'positions': 'angstrom', 'forces': 'eV/angstrom', 'energy': 'eV'}
    with open(os.path.join(out_dir, "metadata.json"), 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"  {name}: {n_frames} frames")

def make_perturbed(atoms, n, magnitude, seed=42):
    simple_minimize(atoms, force_fn, max_steps=3000, f_tol=1e-3)
    relaxed = atoms.positions.copy()
    rng = np.random.default_rng(seed)
    frames = [relaxed.copy()]
    for _ in range(n):
        frames.append(relaxed + rng.uniform(-magnitude, magnitude, relaxed.shape))
    return frames

def make_thermal(atoms, T, n_steps, dt=0.3, log_interval=5, seed=42):
    simple_minimize(atoms, force_fn, max_steps=3000, f_tol=1e-3)
    atoms.set_velocities_temperature(T, seed=seed)
    atoms.remove_angular_momentum()
    if atoms.temperature() > 0:
        atoms.velocities *= np.sqrt(T / atoms.temperature())
    result = run_nve(atoms, dt=dt, n_steps=n_steps, compute_forces_fn=force_fn, log_interval=log_interval)
    return result['positions_history']

def make_strained_graphene(strain_pct):
    atoms = graphene_patch(nx=3, ny=3)
    simple_minimize(atoms, force_fn, max_steps=3000, f_tol=1e-3)
    scale = 1 + strain_pct / 100.0
    atoms.positions[:, 0] *= scale  # strain in x
    return [atoms.positions.copy()]

if __name__ == '__main__':
    print("=" * 60)
    print("TRAINING DATASET GENERATION")
    print("=" * 60)

    # C60 cases
    print("\n--- C60 ---")
    save_dataset("train_c60_pert_small", make_perturbed(c60_fullerene(), 30, 0.02),
                 {'system': 'c60', 'case': 'perturbed', 'perturbation': 0.02})
    save_dataset("train_c60_pert_medium", make_perturbed(c60_fullerene(), 30, 0.05, seed=123),
                 {'system': 'c60', 'case': 'perturbed', 'perturbation': 0.05})
    save_dataset("train_c60_pert_large", make_perturbed(c60_fullerene(), 20, 0.10, seed=456),
                 {'system': 'c60', 'case': 'perturbed', 'perturbation': 0.10})
    save_dataset("train_c60_50K", make_thermal(c60_fullerene(), 50, 500, dt=0.3),
                 {'system': 'c60', 'case': 'thermal', 'temperature_K': 50})
    save_dataset("train_c60_200K", make_thermal(c60_fullerene(), 200, 500, dt=0.3, seed=77),
                 {'system': 'c60', 'case': 'thermal', 'temperature_K': 200})
    save_dataset("train_c60_500K", make_thermal(c60_fullerene(), 500, 500, dt=0.3, seed=88),
                 {'system': 'c60', 'case': 'thermal', 'temperature_K': 500})

    # Graphene cases
    print("\n--- Graphene ---")
    save_dataset("train_gr_pert_small", make_perturbed(graphene_patch(nx=3, ny=3), 30, 0.02, seed=200),
                 {'system': 'graphene', 'case': 'perturbed', 'perturbation': 0.02})
    save_dataset("train_gr_pert_medium", make_perturbed(graphene_patch(nx=3, ny=3), 30, 0.05, seed=201),
                 {'system': 'graphene', 'case': 'perturbed', 'perturbation': 0.05})
    save_dataset("train_gr_50K", make_thermal(graphene_patch(nx=3, ny=3), 50, 500, dt=0.2, seed=300),
                 {'system': 'graphene', 'case': 'thermal', 'temperature_K': 50})
    save_dataset("train_gr_200K", make_thermal(graphene_patch(nx=3, ny=3), 200, 500, dt=0.2, seed=301),
                 {'system': 'graphene', 'case': 'thermal', 'temperature_K': 200})

    # Strain cases
    print("\n--- Graphene strain ---")
    for s in [-2, -1, 1, 2, 3]:
        save_dataset(f"train_gr_strain_{'+' if s > 0 else ''}{s}pct",
                     make_strained_graphene(s),
                     {'system': 'graphene', 'case': 'strain', 'strain_pct': s})

    # Count total
    total = 0
    for d in sorted(os.listdir(DATA_DIR)):
        mp = os.path.join(DATA_DIR, d, "metadata.json")
        if os.path.exists(mp):
            with open(mp) as f:
                m = json.load(f)
                if d.startswith("train_"):
                    total += m.get('n_frames', 0)
    print(f"\nTotal training frames: {total}")
