"""
Pilot ML training: descriptor-based MLP for 3-body force residual.

Model: sklearn MLPRegressor
Input: atom-centered symmetry functions (12 features per atom)
Output: 3-body force residual (3 components per atom)
Target: F_residual = F_total - F_2body
"""
import sys, os, json, time, pickle
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler
from ml.descriptors import compute_all_descriptors, DESCRIPTOR_DIM

DATA_DIR = "data"
MODEL_DIR = "ml/models"
OUTPUT_DIR = "outputs/ml_pilot"


def load_dataset(case_names):
    """Load and featurize a set of dataset cases."""
    all_X, all_y, all_ft, all_f2 = [], [], [], []
    for name in case_names:
        d = os.path.join(DATA_DIR, name)
        if not os.path.exists(d): continue
        pos = np.load(os.path.join(d, "positions.npy"))
        fr = np.load(os.path.join(d, "forces_residual.npy"))
        ft = np.load(os.path.join(d, "forces_total.npy"))
        f2 = np.load(os.path.join(d, "forces_2body.npy"))

        n_frames, n_atoms, _ = pos.shape
        for frame in range(n_frames):
            descs = compute_all_descriptors(pos[frame])
            all_X.append(descs)
            all_y.append(fr[frame])
            all_ft.append(ft[frame])
            all_f2.append(f2[frame])

    if not all_X:
        return None, None, None, None
    X = np.vstack(all_X)  # (total_atoms, DESCRIPTOR_DIM)
    y = np.vstack(all_y)  # (total_atoms, 3)
    ft = np.vstack(all_ft)
    f2 = np.vstack(all_f2)
    return X, y, ft, f2


def main():
    print("=" * 60)
    print("PILOT ML TRAINING")
    print("=" * 60)

    os.makedirs(MODEL_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Define splits
    train_cases = [d for d in sorted(os.listdir(DATA_DIR))
                   if d.startswith("train_") and os.path.exists(os.path.join(DATA_DIR, d, "metadata.json"))]
    test_cases = [d for d in sorted(os.listdir(DATA_DIR))
                  if not d.startswith("train_") and os.path.exists(os.path.join(DATA_DIR, d, "metadata.json"))]

    print(f"\nTrain cases: {len(train_cases)}")
    print(f"Test cases: {len(test_cases)}")

    # Load and featurize
    print("\nFeaturizing training data...")
    t0 = time.time()
    X_train, y_train, ft_train, f2_train = load_dataset(train_cases)
    feat_time = time.time() - t0
    print(f"  {X_train.shape[0]} atoms, {DESCRIPTOR_DIM} features/atom, {feat_time:.1f}s")

    print("Featurizing test data...")
    X_test, y_test, ft_test, f2_test = load_dataset(test_cases)
    print(f"  {X_test.shape[0]} atoms")

    # Use 20% of training as validation
    n = X_train.shape[0]
    idx = np.random.default_rng(42).permutation(n)
    n_val = int(0.2 * n)
    val_idx, tr_idx = idx[:n_val], idx[n_val:]

    X_val, y_val = X_train[val_idx], y_train[val_idx]
    ft_val, f2_val = ft_train[val_idx], f2_train[val_idx]
    X_tr, y_tr = X_train[tr_idx], y_train[tr_idx]

    # Normalize features
    scaler_X = StandardScaler()
    X_tr_s = scaler_X.fit_transform(X_tr)
    X_val_s = scaler_X.transform(X_val)
    X_test_s = scaler_X.transform(X_test)

    # Normalize targets
    scaler_y = StandardScaler()
    y_tr_s = scaler_y.fit_transform(y_tr)

    # Train
    print(f"\nTraining MLP ({X_tr_s.shape[0]} samples, {DESCRIPTOR_DIM} features → 3 outputs)...")
    t0 = time.time()
    model = MLPRegressor(
        hidden_layer_sizes=(64, 64),
        activation='relu',
        max_iter=500,
        early_stopping=True,
        validation_fraction=0.1,
        random_state=42,
        verbose=False,
        learning_rate_init=0.001,
    )
    model.fit(X_tr_s, y_tr_s)
    train_time = time.time() - t0
    print(f"  Training time: {train_time:.1f}s, iterations: {model.n_iter_}")

    # Save model
    with open(os.path.join(MODEL_DIR, "pilot_mlp.pkl"), 'wb') as f:
        pickle.dump({'model': model, 'scaler_X': scaler_X, 'scaler_y': scaler_y}, f)

    # Evaluate
    def evaluate(name, X_s, y_true, ft_true, f2_true):
        y_pred_s = model.predict(X_s)
        y_pred = scaler_y.inverse_transform(y_pred_s)

        # Residual error
        res_err = y_pred - y_true
        res_mae = np.mean(np.abs(res_err))
        res_rmse = np.sqrt(np.mean(res_err**2))

        # Total force error (the physics-relevant metric)
        f_total_pred = f2_true + y_pred
        total_err = f_total_pred - ft_true
        total_mae = np.mean(np.abs(total_err))
        total_rmse = np.sqrt(np.mean(total_err**2))

        # Force magnitude errors
        ft_mag = np.linalg.norm(ft_true, axis=1)
        fp_mag = np.linalg.norm(f_total_pred, axis=1)
        mag_err = np.abs(fp_mag - ft_mag)

        # Near-equilibrium analysis (small total force = near equilibrium)
        near_eq = ft_mag < 0.5
        if np.sum(near_eq) > 0:
            eq_total_mae = np.mean(np.abs(total_err[near_eq]))
        else:
            eq_total_mae = float('nan')

        print(f"\n  --- {name} ({len(y_true)} atoms) ---")
        print(f"  Residual MAE:     {res_mae:.4f} eV/Å")
        print(f"  Residual RMSE:    {res_rmse:.4f} eV/Å")
        print(f"  Total force MAE:  {total_mae:.4f} eV/Å")
        print(f"  Total force RMSE: {total_rmse:.4f} eV/Å")
        print(f"  Force mag error:  mean={np.mean(mag_err):.4f}, max={np.max(mag_err):.4f} eV/Å")
        print(f"  Near-eq MAE:      {eq_total_mae:.4f} eV/Å")

        return {'res_mae': res_mae, 'res_rmse': res_rmse,
                'total_mae': total_mae, 'total_rmse': total_rmse,
                'near_eq_mae': eq_total_mae, 'n_samples': len(y_true)}

    print("\n" + "=" * 60)
    print("EVALUATION")
    print("=" * 60)
    r_val = evaluate("Validation", X_val_s, y_val, ft_val, f2_val)
    r_test = evaluate("Test", X_test_s, y_test, ft_test, f2_test)

    # Runtime benchmark
    print("\n" + "=" * 60)
    print("RUNTIME BENCHMARK")
    print("=" * 60)

    from sim.potentials.tersoff import compute_energy_and_forces, compute_2body_forces
    from sim.structures.generators import c60_fullerene
    from sim.minimizer import simple_minimize

    atoms = c60_fullerene()
    simple_minimize(atoms, lambda p: compute_energy_and_forces(p), max_steps=100, f_tol=1e-2)
    pos = atoms.positions

    # Analytical full force
    n_bench = 10
    t0 = time.time()
    for _ in range(n_bench):
        compute_energy_and_forces(pos)
    t_analytical = (time.time() - t0) / n_bench

    # ML: 2-body + descriptor + predict
    t0 = time.time()
    for _ in range(n_bench):
        _, f2 = compute_2body_forces(pos)
        desc = compute_all_descriptors(pos)
        desc_s = scaler_X.transform(desc)
        fr_pred_s = model.predict(desc_s)
        fr_pred = scaler_y.inverse_transform(fr_pred_s)
        f_total = f2 + fr_pred
    t_ml = (time.time() - t0) / n_bench

    # 2-body only timing
    t0 = time.time()
    for _ in range(n_bench):
        compute_2body_forces(pos)
    t_2body = (time.time() - t0) / n_bench

    # Descriptor timing
    t0 = time.time()
    for _ in range(n_bench):
        compute_all_descriptors(pos)
    t_desc = (time.time() - t0) / n_bench

    speedup = t_analytical / t_ml if t_ml > 0 else float('inf')

    print(f"\n  C60 (60 atoms) per-step timing:")
    print(f"  Analytical (full Tersoff):  {t_analytical*1000:.1f} ms")
    print(f"  ML (2-body + desc + MLP):   {t_ml*1000:.1f} ms")
    print(f"    2-body only:              {t_2body*1000:.1f} ms")
    print(f"    Descriptors only:         {t_desc*1000:.1f} ms")
    print(f"    MLP inference:            {(t_ml - t_2body - t_desc)*1000:.1f} ms")
    print(f"  Speedup: {speedup:.2f}x")

    if speedup > 1:
        print(f"  → ML is {speedup:.1f}x FASTER than analytical")
    else:
        print(f"  → ML is {1/speedup:.1f}x SLOWER than analytical")

    # Browser feasibility
    print(f"\n  Browser feasibility:")
    if t_ml < 0.05:
        print(f"  → ML step < 50ms → 20+ FPS possible → FEASIBLE for real-time")
    elif t_ml < 0.1:
        print(f"  → ML step < 100ms → 10+ FPS possible → MARGINAL for real-time")
    else:
        print(f"  → ML step > 100ms → Too slow for real-time browser animation")
    print(f"  (Note: browser Wasm/WebGL inference will differ from Python timings)")

    # Save results
    results = {
        'model': 'MLPRegressor(64,64)',
        'descriptor_dim': DESCRIPTOR_DIM,
        'train_samples': len(X_tr),
        'val_samples': len(X_val),
        'test_samples': len(X_test),
        'train_time_s': train_time,
        'iterations': model.n_iter_,
        'validation': {k: float(v) for k, v in r_val.items()},
        'test': {k: float(v) for k, v in r_test.items()},
        'runtime': {
            'analytical_ms': t_analytical * 1000,
            'ml_ms': t_ml * 1000,
            'speedup': speedup,
        }
    }
    with open(os.path.join(OUTPUT_DIR, "results.json"), 'w') as f:
        json.dump(results, f, indent=2)

    print(f"\n{'='*60}")
    print("PILOT ML TRAINING COMPLETE")
    print(f"{'='*60}")


if __name__ == '__main__':
    main()
