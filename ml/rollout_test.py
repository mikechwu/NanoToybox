"""Short rollout test: run MD using ML-predicted forces and compare to analytical."""
import sys, os, json, time, pickle
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces, compute_2body_forces
from sim.structures.generators import c60_fullerene, graphene_patch
from sim.minimizer import simple_minimize
from sim.integrators.velocity_verlet import run_nve
from sim.io.output import write_energy_csv
from ml.descriptors import compute_all_descriptors

OUTPUT_DIR = "outputs/ml_pilot"


def load_model():
    with open("ml/models/pilot_mlp.pkl", 'rb') as f:
        d = pickle.load(f)
    return d['model'], d['scaler_X'], d['scaler_y']


def ml_force_fn(positions, model, scaler_X, scaler_y):
    """Compute forces using ML: F = F_2body + ML_residual."""
    e_2body, f_2body = compute_2body_forces(positions)
    desc = compute_all_descriptors(positions)
    desc_s = scaler_X.transform(desc)
    fr_pred_s = model.predict(desc_s)
    fr_pred = scaler_y.inverse_transform(fr_pred_s)
    f_total = f_2body + fr_pred
    # Estimate energy (use 2-body energy + rough correction)
    e_total = e_2body  # Approximate — ML doesn't predict energy
    return e_total, f_total, None


def rollout_test(name, atoms, n_steps=200, dt=0.3, temperature_k=100):
    print(f"\n--- {name} ({atoms.n_atoms} atoms, {temperature_k}K, {n_steps} steps) ---")

    model, scaler_X, scaler_y = load_model()

    # Relax
    simple_minimize(atoms, lambda p: compute_energy_and_forces(p), max_steps=1000, f_tol=1e-3)
    relaxed_pos = atoms.positions.copy()

    # Initialize velocities
    atoms.set_velocities_temperature(temperature_k, seed=42)
    atoms.remove_angular_momentum()
    if atoms.temperature() > 0:
        atoms.velocities *= np.sqrt(temperature_k / atoms.temperature())

    # Run analytical reference
    atoms_ref = atoms.copy()
    ref_result = run_nve(atoms_ref, dt=dt, n_steps=n_steps,
                         compute_forces_fn=lambda p: compute_energy_and_forces(p),
                         log_interval=10)

    # Run ML
    atoms_ml = atoms.copy()
    ml_result = run_nve(atoms_ml, dt=dt, n_steps=n_steps,
                        compute_forces_fn=lambda p: ml_force_fn(p, model, scaler_X, scaler_y),
                        log_interval=10)

    # Compare trajectories
    ref_final = ref_result['positions_history'][-1]
    ml_final = ml_result['positions_history'][-1]
    pos_diff = np.linalg.norm(ml_final - ref_final, axis=1)

    # Structural check: are bonds still intact?
    ml_bonds = []
    for i in range(len(ml_final)):
        for j in range(i+1, len(ml_final)):
            d = np.linalg.norm(ml_final[i] - ml_final[j])
            if d < 1.8: ml_bonds.append(d)

    ref_bonds = []
    for i in range(len(ref_final)):
        for j in range(i+1, len(ref_final)):
            d = np.linalg.norm(ref_final[i] - ref_final[j])
            if d < 1.8: ref_bonds.append(d)

    # Rg comparison
    ml_com = np.mean(ml_final, axis=0)
    ref_com = np.mean(ref_final, axis=0)
    ml_rg = np.sqrt(np.mean(np.sum((ml_final - ml_com)**2, axis=1)))
    ref_rg = np.sqrt(np.mean(np.sum((ref_final - ref_com)**2, axis=1)))

    print(f"  Position diff (ML vs analytical): mean={np.mean(pos_diff):.4f}, max={np.max(pos_diff):.4f} Å")
    print(f"  ML bonds: {len(ml_bonds)}, Ref bonds: {len(ref_bonds)}")
    if ml_bonds:
        print(f"  ML bond range: {min(ml_bonds):.4f}-{max(ml_bonds):.4f} Å")
    print(f"  ML Rg: {ml_rg:.4f}, Ref Rg: {ref_rg:.4f} Å")

    # Physical stability check
    no_explosion = np.max(pos_diff) < 5.0  # atoms don't fly away
    bonds_preserved = len(ml_bonds) >= len(ref_bonds) * 0.8
    rg_stable = abs(ml_rg - ref_rg) / ref_rg < 0.2

    print(f"  No explosion: {'YES' if no_explosion else 'NO'}")
    print(f"  Bonds preserved: {'YES' if bonds_preserved else 'NO'}")
    print(f"  Rg stable: {'YES' if rg_stable else 'NO'}")

    stable = no_explosion and bonds_preserved and rg_stable
    print(f"  PHYSICALLY SENSIBLE: {'YES' if stable else 'NO'}")

    # Save energy traces
    write_energy_csv(f"{OUTPUT_DIR}/{name}_analytical_energy.csv",
                     ref_result['steps'], ref_result['times'],
                     ref_result['ke'], ref_result['pe'], ref_result['te'])
    write_energy_csv(f"{OUTPUT_DIR}/{name}_ml_energy.csv",
                     ml_result['steps'], ml_result['times'],
                     ml_result['ke'], ml_result['pe'], ml_result['te'])

    return stable


if __name__ == '__main__':
    print("=" * 60)
    print("ML ROLLOUT TEST")
    print("=" * 60)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    r1 = rollout_test("c60", c60_fullerene(), n_steps=200, dt=0.3, temperature_k=100)
    r2 = rollout_test("graphene", graphene_patch(nx=3, ny=3), n_steps=200, dt=0.2, temperature_k=50)

    print(f"\n{'='*60}")
    print("ROLLOUT SUMMARY")
    print(f"{'='*60}")
    print(f"  C60:      {'STABLE' if r1 else 'UNSTABLE'}")
    print(f"  Graphene: {'STABLE' if r2 else 'UNSTABLE'}")
