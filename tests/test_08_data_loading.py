"""
TEST 8 — End-to-end dataset loading test.

Verifies that exported datasets can be loaded, shapes are correct,
metadata is usable, and the ML target can be cleanly extracted.
No ML framework required — pure numpy verification.
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np

DATA_DIR = "data"

def test_loading():
    print("=" * 60)
    print("TEST 8: END-TO-END DATASET LOADING")
    print("=" * 60)

    all_pass = True
    datasets = []

    for name in sorted(os.listdir(DATA_DIR)):
        meta_path = os.path.join(DATA_DIR, name, "metadata.json")
        if not os.path.exists(meta_path): continue

        print(f"\n  --- {name} ---")
        d = os.path.join(DATA_DIR, name)

        # 1. Load metadata
        with open(meta_path) as f:
            meta = json.load(f)
        n_frames = meta['n_frames']
        n_atoms = meta['n_atoms']
        print(f"  Metadata: {n_frames} frames, {n_atoms} atoms, case={meta.get('case','?')}")

        # 2. Load arrays and check shapes
        pos = np.load(os.path.join(d, "positions.npy"))
        ft = np.load(os.path.join(d, "forces_total.npy"))
        f2 = np.load(os.path.join(d, "forces_2body.npy"))
        fr = np.load(os.path.join(d, "forces_residual.npy"))
        en = np.load(os.path.join(d, "energies.npy"))

        shape_ok = (pos.shape == (n_frames, n_atoms, 3) and
                    ft.shape == (n_frames, n_atoms, 3) and
                    f2.shape == (n_frames, n_atoms, 3) and
                    fr.shape == (n_frames, n_atoms, 3) and
                    en.shape == (n_frames,))
        print(f"  Shapes correct: {'YES' if shape_ok else 'NO'}")
        if not shape_ok:
            print(f"    pos: {pos.shape}, ft: {ft.shape}, f2: {f2.shape}, fr: {fr.shape}, en: {en.shape}")
            all_pass = False

        # 3. Verify types
        types_ok = (pos.dtype == np.float64 and ft.dtype == np.float64)
        print(f"  Types float64: {'YES' if types_ok else 'NO'}")

        # 4. Verify decomposition: F_total ≈ F_2body + F_residual
        recon_err = np.max(np.abs(ft - (f2 + fr)))
        decomp_ok = recon_err < 1e-10
        print(f"  Decomposition verified: {'YES' if decomp_ok else 'NO'} (max err: {recon_err:.2e})")
        if not decomp_ok: all_pass = False

        # 5. No NaN/Inf
        no_nan = not (np.any(np.isnan(pos)) or np.any(np.isnan(ft)) or np.any(np.isnan(en)))
        no_inf = not (np.any(np.isinf(pos)) or np.any(np.isinf(ft)) or np.any(np.isinf(en)))
        print(f"  No NaN/Inf: {'YES' if (no_nan and no_inf) else 'NO'}")
        if not (no_nan and no_inf): all_pass = False

        # 6. Physical sanity: energies are negative (bonded carbon)
        en_ok = np.all(en < 0)
        print(f"  Energies negative: {'YES' if en_ok else 'NO'}")

        # 7. ML target extractable: residual forces are the target
        target = fr  # Shape: (n_frames, n_atoms, 3) — ready for regression
        target_rms = np.sqrt(np.mean(target**2))
        print(f"  ML target (F_residual) RMS: {target_rms:.4f} eV/Å")

        datasets.append({'name': name, 'n_frames': n_frames, 'n_atoms': n_atoms,
                        'shape_ok': shape_ok, 'decomp_ok': decomp_ok})

    # 8. Train/val/test split logic
    print(f"\n  --- Train/Val/Test Split ---")
    pilot_cases = [d for d in datasets if not d['name'].startswith('train_')]
    train_cases = [d for d in datasets if d['name'].startswith('train_')]
    pilot_frames = sum(d['n_frames'] for d in pilot_cases)
    train_frames = sum(d['n_frames'] for d in train_cases)
    total_frames = pilot_frames + train_frames

    print(f"  Pilot datasets: {len(pilot_cases)} cases, {pilot_frames} frames")
    print(f"  Training datasets: {len(train_cases)} cases, {train_frames} frames")
    print(f"  Total: {total_frames} frames")

    # Split strategy: pilot → test, train → 80% train / 20% val
    if train_cases:
        n_train = int(0.8 * train_frames)
        n_val = train_frames - n_train
        print(f"  Proposed split: train={n_train}, val={n_val}, test={pilot_frames}")
        split_ok = n_train > 0 and n_val > 0 and pilot_frames > 0
        print(f"  Split valid: {'YES' if split_ok else 'NO'}")
    else:
        split_ok = False
        print(f"  No training datasets found — generate training data first")

    print(f"\n{'='*60}")
    print(f"TEST 8 OVERALL: {'PASS' if all_pass else 'FAIL'}")
    return all_pass

if __name__ == '__main__':
    passed = test_loading()
    sys.exit(0 if passed else 1)
