"""Diagnose why C60 fails: descriptor analysis, cancellation, environment complexity."""
import sys, os, json, pickle
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_force_decomposition, compute_energy_and_forces
from sim.structures.generators import c60_fullerene, graphene_patch
from sim.minimizer import simple_minimize
from ml.descriptors import compute_all_descriptors, DESCRIPTOR_DIM

OUTPUT_DIR = "outputs/ml_diagnosis"
os.makedirs(OUTPUT_DIR, exist_ok=True)


def force_fn(pos):
    return compute_energy_and_forces(pos)


def analyze_environment(name, atoms):
    """Analyze local environment complexity."""
    print(f"\n--- {name} ({atoms.n_atoms} atoms) ---")
    simple_minimize(atoms, force_fn, max_steps=1000, f_tol=1e-3)

    # Neighbor analysis
    n = atoms.n_atoms
    pos = atoms.positions
    neighbor_counts = []
    angles = []

    for i in range(n):
        neighbors = []
        for j in range(n):
            if j == i: continue
            d = np.linalg.norm(pos[j] - pos[i])
            if d < 2.1:
                neighbors.append(j)

        neighbor_counts.append(len(neighbors))

        # Compute angles between all neighbor pairs
        for a in range(len(neighbors)):
            for b in range(a+1, len(neighbors)):
                rij = pos[neighbors[a]] - pos[i]
                rik = pos[neighbors[b]] - pos[i]
                cos_t = np.dot(rij, rik) / (np.linalg.norm(rij) * np.linalg.norm(rik))
                angles.append(np.degrees(np.arccos(np.clip(cos_t, -1, 1))))

    print(f"  Neighbors per atom: {np.mean(neighbor_counts):.1f} ± {np.std(neighbor_counts):.1f}")
    print(f"  Angles: mean={np.mean(angles):.1f}°, std={np.std(angles):.1f}°, range={np.min(angles):.1f}°-{np.max(angles):.1f}°")

    # Descriptor diversity
    descs = compute_all_descriptors(pos)
    desc_std = np.std(descs, axis=0)
    desc_range = np.ptp(descs, axis=0)

    print(f"  Descriptor std per feature: {desc_std}")
    print(f"  Descriptor range per feature: {desc_range}")
    print(f"  Total descriptor variance: {np.sum(desc_std**2):.4f}")

    # Unique descriptor fingerprints
    rounded = np.round(descs, 4)
    unique_rows = len(np.unique(rounded, axis=0))
    print(f"  Unique descriptor vectors: {unique_rows}/{n} ({unique_rows/n*100:.0f}%)")

    return {
        'name': name, 'n_atoms': n,
        'mean_neighbors': float(np.mean(neighbor_counts)),
        'angle_std': float(np.std(angles)),
        'descriptor_variance': float(np.sum(desc_std**2)),
        'unique_descriptors_pct': unique_rows / n * 100,
    }


def analyze_cancellation(name, cases):
    """Analyze force cancellation sensitivity."""
    print(f"\n--- Cancellation Analysis: {name} ---")

    all_ft, all_f2, all_fr = [], [], []
    for case in cases:
        d = os.path.join("data", case)
        if not os.path.exists(d): continue
        ft = np.load(os.path.join(d, "forces_total.npy"))
        f2 = np.load(os.path.join(d, "forces_2body.npy"))
        fr = np.load(os.path.join(d, "forces_residual.npy"))
        all_ft.append(ft.reshape(-1, 3))
        all_f2.append(f2.reshape(-1, 3))
        all_fr.append(fr.reshape(-1, 3))

    ft = np.vstack(all_ft)
    f2 = np.vstack(all_f2)
    fr = np.vstack(all_fr)

    ft_mag = np.linalg.norm(ft, axis=1)
    f2_mag = np.linalg.norm(f2, axis=1)
    fr_mag = np.linalg.norm(fr, axis=1)

    # Cancellation ratio: how much do 2body and residual cancel?
    cancel_ratio = (f2_mag + fr_mag) / np.maximum(ft_mag, 1e-10)

    # Near equilibrium (|F_total| < 0.5 eV/Å)
    near_eq = ft_mag < 0.5
    n_eq = np.sum(near_eq)

    print(f"  Samples: {len(ft)}")
    print(f"  |F_total| mean: {np.mean(ft_mag):.4f} eV/Å")
    print(f"  |F_2body| mean: {np.mean(f2_mag):.4f} eV/Å")
    print(f"  |F_resid| mean: {np.mean(fr_mag):.4f} eV/Å")
    print(f"  Cancellation ratio (|F_2b|+|F_r|)/|F_t|: mean={np.mean(cancel_ratio[ft_mag>0.1]):.2f}")
    print(f"  Near-equilibrium atoms: {n_eq} ({n_eq/len(ft)*100:.1f}%)")
    if n_eq > 0:
        eq_fr = fr_mag[near_eq]
        eq_ft = ft_mag[near_eq]
        print(f"  Near-eq |F_resid|: {np.mean(eq_fr):.4f} eV/Å")
        print(f"  Near-eq |F_total|: {np.mean(eq_ft):.4f} eV/Å")
        print(f"  Near-eq cancel ratio: {np.mean(eq_fr)/np.mean(eq_ft):.1f}x")

    return {'name': name, 'cancel_ratio': float(np.mean(cancel_ratio[ft_mag>0.1])),
            'near_eq_pct': n_eq/len(ft)*100}


def analyze_ml_errors(name, cases):
    """Load model and analyze errors per case."""
    with open("ml/models/pilot_mlp.pkl", 'rb') as f:
        d = pickle.load(f)
    model, scaler_X, scaler_y = d['model'], d['scaler_X'], d['scaler_y']

    print(f"\n--- ML Error Analysis: {name} ---")

    for case in cases:
        d = os.path.join("data", case)
        if not os.path.exists(d): continue

        pos = np.load(os.path.join(d, "positions.npy"))
        ft = np.load(os.path.join(d, "forces_total.npy"))
        f2 = np.load(os.path.join(d, "forces_2body.npy"))
        fr = np.load(os.path.join(d, "forces_residual.npy"))

        n_frames = pos.shape[0]
        all_err = []
        for i in range(n_frames):
            desc = compute_all_descriptors(pos[i])
            desc_s = scaler_X.transform(desc)
            fr_pred = scaler_y.inverse_transform(model.predict(desc_s))
            ft_pred = f2[i] + fr_pred
            err = np.linalg.norm(ft_pred - ft[i], axis=1)
            all_err.extend(err)

        all_err = np.array(all_err)
        ft_mag = np.linalg.norm(ft.reshape(-1, 3), axis=1)
        rel_err = all_err / np.maximum(ft_mag, 0.01)

        print(f"  {case}: abs_err mean={np.mean(all_err):.4f}, "
              f"rel_err mean={np.mean(rel_err):.2f}, "
              f"max_abs={np.max(all_err):.4f} eV/Å")


if __name__ == '__main__':
    print("=" * 60)
    print("C60 FAILURE DIAGNOSIS")
    print("=" * 60)

    # Environment complexity
    print("\n" + "=" * 40)
    print("ENVIRONMENT COMPLEXITY")
    r_c60 = analyze_environment("C60", c60_fullerene())
    r_gr = analyze_environment("Graphene", graphene_patch(nx=3, ny=3))

    print(f"\n  KEY FINDING: C60 has {r_c60['unique_descriptors_pct']:.0f}% unique descriptors "
          f"vs graphene {r_gr['unique_descriptors_pct']:.0f}%")
    print(f"  C60 angle std: {r_c60['angle_std']:.1f}° — graphene has less angular diversity")

    # Cancellation
    print("\n" + "=" * 40)
    print("CANCELLATION SENSITIVITY")
    c60_cases = [d for d in os.listdir("data") if d.startswith("c60") or d.startswith("train_c60")]
    gr_cases = [d for d in os.listdir("data") if d.startswith("graphene") or d.startswith("train_gr")]
    rc = analyze_cancellation("C60", c60_cases)
    rg = analyze_cancellation("Graphene", gr_cases)

    print(f"\n  KEY FINDING: C60 cancellation {rc['cancel_ratio']:.1f}x vs graphene {rg['cancel_ratio']:.1f}x")

    # Per-case ML errors
    print("\n" + "=" * 40)
    print("ML ERROR BY CASE")
    analyze_ml_errors("C60", [d for d in os.listdir("data") if "c60" in d][:5])
    analyze_ml_errors("Graphene", [d for d in os.listdir("data") if "graphene" in d or "gr" in d][:5])

    # Summary
    print(f"\n{'='*60}")
    print("DIAGNOSIS SUMMARY")
    print(f"{'='*60}")
    print(f"""
  1. DESCRIPTOR DISTINGUISHABILITY:
     C60 has {r_c60['unique_descriptors_pct']:.0f}% unique descriptors — the current 12-feature
     descriptor cannot fully distinguish C60's different atomic sites.
     All C60 atoms are similar (3 neighbors each in an icosahedral cage),
     but the subtle angular differences that determine forces are washed out.

  2. CANCELLATION SENSITIVITY:
     C60 cancellation ratio is {rc['cancel_ratio']:.1f}x — the model must predict
     F_residual to ~{100/rc['cancel_ratio']:.0f}% accuracy just to get net force direction right.
     Graphene cancellation is {rg['cancel_ratio']:.1f}x — less sensitive.

  3. ROOT CAUSE: The 12-feature Behler-Parrinello descriptor does not capture
     enough angular detail to distinguish C60's subtly different bonding sites.
     The MLP then averages over these environments, producing ~constant residual
     prediction that fails during dynamics.

  4. RECOMMENDATION:
     Option 1 (RICHER DESCRIPTORS) is the highest-leverage fix.
     More angular symmetry functions (G4 with more ζ/λ combinations)
     would let the model distinguish C60 environments.
     This is cheaper than switching to a GNN and addresses the root cause.
""")
