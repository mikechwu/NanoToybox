"""
TEST 7 — Multi-atom finite-difference force validation

Validates force correctness on REALISTIC multi-atom structures:
- Relaxed C60 (60 atoms, 3 neighbors each, complex angular environment)
- Relaxed graphene (18 atoms, mixed interior/edge environments)

This goes beyond the 2-atom and 3-atom tests to confirm the 3-body force
calculation is correct in asymmetric, many-neighbor environments.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces, compute_energy_only
from sim.structures.generators import c60_fullerene, graphene_patch
from sim.minimizer import simple_minimize

OUTPUT_DIR = "outputs/test7_multiatom_forces"


def force_fn(pos):
    return compute_energy_and_forces(pos)


def finite_diff_force_check(name, atoms, eps=1e-5):
    """
    Compare analytical forces against finite-difference on every atom, every component.
    """
    print(f"\n  --- {name} ({atoms.n_atoms} atoms) ---")

    # Relax first
    simple_minimize(atoms, force_fn, max_steps=3000, f_tol=1e-3)

    # Get analytical forces
    e_ref, forces_anal, _ = force_fn(atoms.positions)
    print(f"  Relaxed PE: {e_ref:.6f} eV")

    errors = []
    max_error = 0.0
    max_error_atom = -1
    max_error_comp = -1

    for i in range(atoms.n_atoms):
        for c in range(3):
            pos_p = atoms.positions.copy()
            pos_p[i, c] += eps
            e_p = compute_energy_only(pos_p)

            pos_m = atoms.positions.copy()
            pos_m[i, c] -= eps
            e_m = compute_energy_only(pos_m)

            f_num = -(e_p - e_m) / (2 * eps)
            f_ana = forces_anal[i, c]

            if abs(f_ana) > 1e-6:
                rel_err = abs(f_ana - f_num) / abs(f_ana)
            else:
                rel_err = abs(f_ana - f_num)

            errors.append(rel_err)
            if rel_err > max_error:
                max_error = rel_err
                max_error_atom = i
                max_error_comp = c

    errors = np.array(errors)
    avg_error = np.mean(errors)
    p95_error = np.percentile(errors, 95)

    print(f"  Max relative error: {max_error:.6e} (atom {max_error_atom}, comp {'xyz'[max_error_comp]})")
    print(f"  Average relative error: {avg_error:.6e}")
    print(f"  95th percentile error: {p95_error:.6e}")
    print(f"  Components checked: {len(errors)}")

    passed = max_error < 1e-3
    print(f"  RESULT: {'PASS' if passed else 'FAIL'}")

    return {
        'name': name,
        'n_atoms': atoms.n_atoms,
        'max_error': float(max_error),
        'avg_error': float(avg_error),
        'p95_error': float(p95_error),
        'max_error_atom': int(max_error_atom),
        'passed': passed,
    }


if __name__ == '__main__':
    print("=" * 60)
    print("TEST 7: MULTI-ATOM FINITE-DIFFERENCE FORCE VALIDATION")
    print("=" * 60)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    r_c60 = finite_diff_force_check("C60", c60_fullerene())
    r_graphene = finite_diff_force_check("Graphene", graphene_patch(nx=3, ny=3))

    print("\n" + "=" * 60)
    print("TEST 7 SUMMARY")
    print("=" * 60)
    print(f"  C60:      {'PASS' if r_c60['passed'] else 'FAIL'} (max err: {r_c60['max_error']:.2e})")
    print(f"  Graphene: {'PASS' if r_graphene['passed'] else 'FAIL'} (max err: {r_graphene['max_error']:.2e})")

    all_pass = r_c60['passed'] and r_graphene['passed']
    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")

    # Save results
    import json
    def sanitize(d):
        return {k: (bool(v) if isinstance(v, np.bool_) else v) for k, v in d.items()}
    with open(f"{OUTPUT_DIR}/results.json", 'w') as f:
        json.dump({'c60': sanitize(r_c60), 'graphene': sanitize(r_graphene)}, f, indent=2)

    sys.exit(0 if all_pass else 1)
