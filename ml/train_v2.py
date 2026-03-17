"""Pilot ML v2: richer descriptors + larger MLP."""
import sys, os, json, time, pickle
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler
from ml.descriptors_v2 import compute_all_descriptors, DESCRIPTOR_DIM

DATA_DIR = "data"
MODEL_DIR = "ml/models"
OUTPUT_DIR = "outputs/ml_v2"
os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)


def load_dataset(case_names):
    all_X, all_y, all_ft, all_f2 = [], [], [], []
    for name in case_names:
        d = os.path.join(DATA_DIR, name)
        if not os.path.exists(d): continue
        pos = np.load(os.path.join(d, "positions.npy"))
        fr = np.load(os.path.join(d, "forces_residual.npy"))
        ft = np.load(os.path.join(d, "forces_total.npy"))
        f2 = np.load(os.path.join(d, "forces_2body.npy"))
        for frame in range(pos.shape[0]):
            descs = compute_all_descriptors(pos[frame])
            all_X.append(descs); all_y.append(fr[frame])
            all_ft.append(ft[frame]); all_f2.append(f2[frame])
    return np.vstack(all_X), np.vstack(all_y), np.vstack(all_ft), np.vstack(all_f2)


def evaluate(model, scaler_X, scaler_y, X, y, ft, f2, name):
    y_pred = scaler_y.inverse_transform(model.predict(scaler_X.transform(X)))
    ft_pred = f2 + y_pred

    res_mae = np.mean(np.abs(y_pred - y))
    total_mae = np.mean(np.abs(ft_pred - ft))

    ft_mag = np.linalg.norm(ft, axis=1)
    near_eq = ft_mag < 0.5
    eq_mae = np.mean(np.abs((ft_pred - ft)[near_eq])) if np.sum(near_eq) > 0 else float('nan')

    print(f"  {name}: res_MAE={res_mae:.4f}, total_MAE={total_mae:.4f}, eq_MAE={eq_mae:.4f} eV/Å")
    return {'res_mae': res_mae, 'total_mae': total_mae, 'eq_mae': eq_mae}


def main():
    print("=" * 60)
    print("ML V2 TRAINING (richer descriptors)")
    print(f"Descriptor dim: {DESCRIPTOR_DIM}")
    print("=" * 60)

    train_cases = sorted([d for d in os.listdir(DATA_DIR) if d.startswith("train_") and os.path.isdir(os.path.join(DATA_DIR, d))])
    test_cases = sorted([d for d in os.listdir(DATA_DIR) if not d.startswith("train_") and os.path.isdir(os.path.join(DATA_DIR, d)) and os.path.exists(os.path.join(DATA_DIR, d, "metadata.json"))])

    print(f"\nFeaturizing ({DESCRIPTOR_DIM} features)...")
    t0 = time.time()
    X_train, y_train, ft_train, f2_train = load_dataset(train_cases)
    print(f"  Train: {X_train.shape[0]} atoms in {time.time()-t0:.1f}s")
    X_test, y_test, ft_test, f2_test = load_dataset(test_cases)
    print(f"  Test: {X_test.shape[0]} atoms")

    # Split
    n = X_train.shape[0]
    idx = np.random.default_rng(42).permutation(n)
    n_val = int(0.2 * n)
    X_val, y_val, ft_val, f2_val = X_train[idx[:n_val]], y_train[idx[:n_val]], ft_train[idx[:n_val]], f2_train[idx[:n_val]]
    X_tr, y_tr = X_train[idx[n_val:]], y_train[idx[n_val:]]

    scaler_X = StandardScaler(); X_tr_s = scaler_X.fit_transform(X_tr)
    scaler_y = StandardScaler(); y_tr_s = scaler_y.fit_transform(y_tr)

    # Larger MLP
    print(f"\nTraining MLP (128, 128, 64)...")
    t0 = time.time()
    model = MLPRegressor(hidden_layer_sizes=(128, 128, 64), activation='relu',
                         max_iter=1000, early_stopping=True, validation_fraction=0.1,
                         random_state=42, verbose=False, learning_rate_init=0.001)
    model.fit(X_tr_s, y_tr_s)
    print(f"  Time: {time.time()-t0:.1f}s, iters: {model.n_iter_}")

    with open(os.path.join(MODEL_DIR, "v2_mlp.pkl"), 'wb') as f:
        pickle.dump({'model': model, 'scaler_X': scaler_X, 'scaler_y': scaler_y, 'version': 'v2'}, f)

    print("\nEVALUATION:")
    r_val = evaluate(model, scaler_X, scaler_y, X_val, y_val, ft_val, f2_val, "Val")
    r_test = evaluate(model, scaler_X, scaler_y, X_test, y_test, ft_test, f2_test, "Test")

    # C60-only evaluation
    X_c60, y_c60, ft_c60, f2_c60 = load_dataset([d for d in test_cases if 'c60' in d])
    if X_c60 is not None and len(X_c60) > 0:
        r_c60 = evaluate(model, scaler_X, scaler_y, X_c60, y_c60, ft_c60, f2_c60, "C60-only")

    # Runtime
    from sim.potentials.tersoff import compute_energy_and_forces, compute_2body_forces
    from sim.structures.generators import c60_fullerene
    from sim.minimizer import simple_minimize
    atoms = c60_fullerene()
    simple_minimize(atoms, lambda p: compute_energy_and_forces(p), max_steps=100, f_tol=1e-2)
    pos = atoms.positions

    n_bench = 10
    t0 = time.time()
    for _ in range(n_bench): compute_energy_and_forces(pos)
    t_anal = (time.time() - t0) / n_bench

    t0 = time.time()
    for _ in range(n_bench):
        _, f2 = compute_2body_forces(pos)
        desc = compute_all_descriptors(pos)
        fr = scaler_y.inverse_transform(model.predict(scaler_X.transform(desc)))
    t_ml = (time.time() - t0) / n_bench

    # Breakdown
    t0 = time.time()
    for _ in range(n_bench): compute_2body_forces(pos)
    t_2b = (time.time() - t0) / n_bench
    t0 = time.time()
    for _ in range(n_bench): compute_all_descriptors(pos)
    t_desc = (time.time() - t0) / n_bench

    print(f"\nRUNTIME (C60):")
    print(f"  Analytical: {t_anal*1000:.1f} ms")
    print(f"  ML total:   {t_ml*1000:.1f} ms (2-body: {t_2b*1000:.1f}, desc: {t_desc*1000:.1f}, MLP: {(t_ml-t_2b-t_desc)*1000:.1f})")
    print(f"  Speedup: {t_anal/t_ml:.2f}x")

    # Rollout
    print(f"\nSHORT ROLLOUT:")
    from sim.integrators.velocity_verlet import run_nve

    atoms = c60_fullerene()
    simple_minimize(atoms, lambda p: compute_energy_and_forces(p), max_steps=1000, f_tol=1e-3)
    relaxed = atoms.positions.copy()
    atoms.set_velocities_temperature(50, seed=42)  # Lower T for stability
    atoms.remove_angular_momentum()
    if atoms.temperature() > 0:
        atoms.velocities *= np.sqrt(50 / atoms.temperature())

    def ml_fn(pos):
        _, f2 = compute_2body_forces(pos)
        desc = compute_all_descriptors(pos)
        fr = scaler_y.inverse_transform(model.predict(scaler_X.transform(desc)))
        return 0.0, f2 + fr, None

    atoms_ml = atoms.copy()
    atoms_ref = atoms.copy()

    ref_res = run_nve(atoms_ref, dt=0.2, n_steps=100, compute_forces_fn=lambda p: compute_energy_and_forces(p), log_interval=10)
    ml_res = run_nve(atoms_ml, dt=0.2, n_steps=100, compute_forces_fn=ml_fn, log_interval=10)

    ref_f = ref_res['positions_history'][-1]
    ml_f = ml_res['positions_history'][-1]
    pos_diff = np.linalg.norm(ml_f - ref_f, axis=1)
    ml_bonds = sum(1 for i in range(60) for j in range(i+1,60) if np.linalg.norm(ml_f[i]-ml_f[j]) < 1.8)
    ref_bonds = sum(1 for i in range(60) for j in range(i+1,60) if np.linalg.norm(ref_f[i]-ref_f[j]) < 1.8)

    print(f"  C60 50K, 100 steps:")
    print(f"  Pos diff: mean={np.mean(pos_diff):.4f}, max={np.max(pos_diff):.4f} Å")
    print(f"  ML bonds: {ml_bonds}, Ref bonds: {ref_bonds}")
    stable = np.max(pos_diff) < 5.0 and ml_bonds >= ref_bonds * 0.8
    print(f"  Stable: {'YES' if stable else 'NO'}")

    results = {
        'model': 'MLPRegressor(128,128,64)', 'descriptor_dim': DESCRIPTOR_DIM,
        'val': {k: float(v) for k, v in r_val.items()},
        'test': {k: float(v) for k, v in r_test.items()},
        'runtime_analytical_ms': t_anal * 1000, 'runtime_ml_ms': t_ml * 1000,
        'speedup': t_anal / t_ml, 'c60_rollout_stable': stable,
    }
    with open(os.path.join(OUTPUT_DIR, "results.json"), 'w') as f:
        json.dump(results, f, indent=2)


if __name__ == '__main__':
    main()
