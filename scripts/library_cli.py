#!/usr/bin/env python3
"""
Structure Library CLI — generate, relax, and save canonical structures.

Usage:
  python3 scripts/library_cli.py c60
  python3 scripts/library_cli.py cnt 5 5 --cells 5
  python3 scripts/library_cli.py cnt 10 0 --cells 3
  python3 scripts/library_cli.py graphene 6 6
  python3 scripts/library_cli.py diamond 2 2 2
  python3 scripts/library_cli.py list
  python3 scripts/library_cli.py rebuild-all

Workflow:
  1. Generate initial geometry
  2. Relax with ALL available minimizers (steepest descent + FIRE)
  3. Pick the result with lowest energy and smallest Fmax
  4. Save to structures/library/ as extended XYZ
"""
import sys
import os
import argparse
import json
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

try:
    from sim.potentials.tersoff_fast import compute_energy_and_forces
    print("  [Using Numba-accelerated Tersoff]")
except ImportError:
    from sim.potentials.tersoff import compute_energy_and_forces
    print("  [Using pure Python Tersoff — install numba for 200x speedup]")
from sim.minimizer import simple_minimize, minimize as fire_minimize
from sim.io.output import write_xyz
from sim.structures.generate import (
    graphene, cnt, cnt_armchair, cnt_zigzag, c60, diamond
)

LIBRARY_DIR = os.path.join(os.path.dirname(__file__), '..', 'structures', 'library')
MANIFEST_PATH = os.path.join(LIBRARY_DIR, 'manifest.json')


def force_fn(pos):
    return compute_energy_and_forces(pos)


def relax_best(atoms, f_tol=1e-3, verbose=True):
    """
    Relax using ALL minimizers, return the best result.

    Runs steepest descent and FIRE in sequence (both are fast enough
    that parallelism isn't needed — each takes <1s for <300 atoms).
    Picks the result with lowest energy among those that converged.
    """
    results = []

    # Method 1: Steepest descent
    atoms_sd = atoms.copy()
    r_sd = simple_minimize(atoms_sd, force_fn, max_steps=10000, f_tol=f_tol)
    results.append(('steepest_descent', atoms_sd, r_sd))

    # Method 2: FIRE
    atoms_fire = atoms.copy()
    r_fire = fire_minimize(atoms_fire, force_fn, max_steps=10000, f_tol=f_tol)
    results.append(('fire', atoms_fire, r_fire))

    # Method 3: Steepest descent with tighter tolerance then FIRE polish
    atoms_combo = atoms.copy()
    r_combo1 = simple_minimize(atoms_combo, force_fn, max_steps=5000, f_tol=f_tol * 10)
    r_combo2 = fire_minimize(atoms_combo, force_fn, max_steps=5000, f_tol=f_tol)
    r_combo = {
        'converged': r_combo2['converged'],
        'steps': r_combo1['steps'] + r_combo2['steps'],
        'final_energy': r_combo2['final_energy'],
        'final_fmax': r_combo2['final_fmax'],
    }
    results.append(('sd+fire', atoms_combo, r_combo))

    # Pick best: lowest energy among converged, or lowest fmax if none converged
    converged = [(name, a, r) for name, a, r in results if r['converged']]
    if converged:
        best_name, best_atoms, best_result = min(converged, key=lambda x: x[2]['final_energy'])
    else:
        best_name, best_atoms, best_result = min(results, key=lambda x: x[2]['final_fmax'])

    if verbose:
        for name, a, r in results:
            marker = ' <<<' if name == best_name else ''
            print(f"  {name:20s}: E={r['final_energy']:.6f} eV, "
                  f"Fmax={r['final_fmax']:.2e} eV/Å, "
                  f"conv={r['converged']}, steps={r['steps']}{marker}")

    return best_atoms, best_result, best_name


def save_to_library(name, atoms, result, method, description=''):
    """Save a relaxed structure to the library with metadata."""
    os.makedirs(LIBRARY_DIR, exist_ok=True)

    xyz_path = os.path.join(LIBRARY_DIR, f'{name}.xyz')
    comment = (f"{description} | {atoms.n_atoms} atoms | "
               f"PE={result['final_energy']:.6f} eV | "
               f"Fmax={result['final_fmax']:.2e} eV/A | "
               f"method={method}")
    write_xyz(xyz_path, [atoms.positions], comment=comment)

    # Update manifest
    manifest = load_manifest()
    manifest[name] = {
        'file': f'{name}.xyz',
        'n_atoms': atoms.n_atoms,
        'energy_eV': float(result['final_energy']),
        'fmax_eV_A': float(result['final_fmax']),
        'converged': bool(result['converged']),
        'method': method,
        'description': description,
    }
    with open(MANIFEST_PATH, 'w') as f:
        json.dump(manifest, f, indent=2, sort_keys=True)

    print(f"  Saved: {xyz_path} ({atoms.n_atoms} atoms, E={result['final_energy']:.4f} eV)")


def load_manifest():
    if os.path.exists(MANIFEST_PATH):
        with open(MANIFEST_PATH) as f:
            return json.load(f)
    return {}


def generate_and_save(name, atoms, description, f_tol=1e-3):
    """Full pipeline: generate -> relax -> save."""
    print(f"\n{'='*60}")
    print(f"  {name}: {description} ({atoms.n_atoms} atoms)")
    print(f"{'='*60}")

    e0, f0, _ = force_fn(atoms.positions)
    fmax0 = np.max(np.linalg.norm(f0, axis=1))
    print(f"  Initial: PE={e0:.4f} eV, Fmax={fmax0:.4f} eV/Å")

    print(f"  Relaxing with all methods (f_tol={f_tol})...")
    best_atoms, best_result, best_method = relax_best(atoms, f_tol=f_tol)

    save_to_library(name, best_atoms, best_result, best_method, description)


def cmd_c60(args):
    atoms = c60()
    generate_and_save('c60', atoms, 'C60 Buckminsterfullerene')


def cmd_cnt(args):
    n, m = args.n, args.m
    cells = args.cells
    atoms = cnt(n, m, cells)
    if n == m:
        chirality = 'armchair'
    elif m == 0:
        chirality = 'zigzag'
    else:
        chirality = 'chiral'
    name = f'cnt_{n}_{m}_{cells}cells'
    desc = f'({n},{m}) {chirality} CNT, {cells} cells'
    generate_and_save(name, atoms, desc)


def cmd_graphene(args):
    nx, ny = args.nx, args.ny
    atoms = graphene(nx, ny)
    name = f'graphene_{nx}x{ny}'
    desc = f'{nx}x{ny} graphene sheet'
    generate_and_save(name, atoms, desc)


def cmd_diamond(args):
    nx, ny, nz = args.nx, args.ny, args.nz
    atoms = diamond(nx, ny, nz)
    name = f'diamond_{nx}x{ny}x{nz}'
    desc = f'{nx}x{ny}x{nz} diamond cubic'
    generate_and_save(name, atoms, desc)


def cmd_fullerene(args):
    """Import a fullerene from .mat coordinate files."""
    import scipy.io
    name = args.name.upper()  # e.g., C180
    mat_path = args.path if hasattr(args, 'path') and args.path else f'{name}.mat'

    if not os.path.exists(mat_path):
        print(f"Error: {mat_path} not found")
        return

    mat = scipy.io.loadmat(mat_path)
    # Find the coordinate array (key matching the filename)
    coords = None
    for key in mat:
        if not key.startswith('_'):
            val = mat[key]
            if val.ndim == 2 and val.shape[1] == 3:
                coords = val
                break

    if coords is None:
        print(f"Error: no (N,3) coordinate array found in {mat_path}")
        return

    from sim.atoms import Atoms
    atoms = Atoms(coords.astype(np.float64))
    atoms.positions -= atoms.positions.mean(axis=0)

    lib_name = name.lower()
    desc = f'{name} fullerene'
    generate_and_save(lib_name, atoms, desc)


def cmd_import_xyz(args):
    """Import any .xyz file, relax, and save to library."""
    xyz_path = args.path
    if not os.path.exists(xyz_path):
        print(f"Error: {xyz_path} not found")
        return

    # Parse XYZ
    with open(xyz_path) as f:
        lines = f.readlines()
    n_atoms = int(lines[0].strip())
    positions = []
    for i in range(2, 2 + n_atoms):
        parts = lines[i].strip().split()
        positions.append([float(parts[1]), float(parts[2]), float(parts[3])])

    from sim.atoms import Atoms
    atoms = Atoms(np.array(positions))
    atoms.positions -= atoms.positions.mean(axis=0)

    name = args.name or os.path.splitext(os.path.basename(xyz_path))[0]
    desc = args.desc or f'Imported from {os.path.basename(xyz_path)} ({atoms.n_atoms} atoms)'
    generate_and_save(name, atoms, desc)


def cmd_list(args):
    manifest = load_manifest()
    if not manifest:
        print("Library is empty.")
        return
    print(f"\n{'Name':<30} {'Atoms':>6} {'Energy (eV)':>12} {'Fmax':>10} {'Method':>15}")
    print('-' * 80)
    for name, info in sorted(manifest.items()):
        print(f"{name:<30} {info['n_atoms']:>6} {info['energy_eV']:>12.4f} "
              f"{info['fmax_eV_A']:>10.2e} {info['method']:>15}")


def cmd_rebuild_all(args):
    """Rebuild all standard library structures from scratch."""
    # Clear library
    if os.path.exists(LIBRARY_DIR):
        for f in os.listdir(LIBRARY_DIR):
            os.remove(os.path.join(LIBRARY_DIR, f))

    structures = [
        ('c60', c60(), 'C60 Buckminsterfullerene'),
        ('cnt_5_5_5cells', cnt_armchair(5, 5), '(5,5) armchair CNT, 5 cells'),
        ('cnt_5_5_10cells', cnt_armchair(5, 10), '(5,5) armchair CNT, 10 cells'),
        ('cnt_10_0_5cells', cnt_zigzag(10, 5), '(10,0) zigzag CNT, 5 cells'),
        ('graphene_6x6', graphene(6, 6), '6x6 graphene sheet'),
        ('graphene_10x10', graphene(10, 10), '10x10 graphene sheet'),
        ('diamond_2x2x2', diamond(2, 2, 2), '2x2x2 diamond cubic'),
    ]

    for name, atoms, desc in structures:
        generate_and_save(name, atoms, desc)

    print(f"\n{'='*60}")
    print(f"Library rebuilt: {len(structures)} structures")
    cmd_list(args)


def main():
    parser = argparse.ArgumentParser(
        description='NanoToybox Structure Library CLI',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s c60                        # Generate relaxed C60
  %(prog)s cnt 5 5 --cells 5          # (5,5) armchair CNT
  %(prog)s cnt 10 0 --cells 3         # (10,0) zigzag CNT
  %(prog)s cnt 8 4 --cells 2          # (8,4) chiral CNT
  %(prog)s graphene 6 6               # 6x6 graphene sheet
  %(prog)s diamond 2 2 2              # 2x2x2 diamond
  %(prog)s list                       # Show library contents
  %(prog)s rebuild-all                # Rebuild all standard structures
        """)

    sub = parser.add_subparsers(dest='command')

    sub.add_parser('c60', help='Generate relaxed C60')

    p_cnt = sub.add_parser('cnt', help='Generate relaxed CNT')
    p_cnt.add_argument('n', type=int, help='First chiral index')
    p_cnt.add_argument('m', type=int, help='Second chiral index')
    p_cnt.add_argument('--cells', type=int, default=1, help='Unit cells along axis')

    p_gr = sub.add_parser('graphene', help='Generate relaxed graphene')
    p_gr.add_argument('nx', type=int, help='Cells in x')
    p_gr.add_argument('ny', type=int, help='Cells in y')

    p_dia = sub.add_parser('diamond', help='Generate relaxed diamond')
    p_dia.add_argument('nx', type=int)
    p_dia.add_argument('ny', type=int)
    p_dia.add_argument('nz', type=int)

    p_full = sub.add_parser('fullerene', help='Import fullerene from .mat coordinate file')
    p_full.add_argument('name', help='Fullerene name (e.g., C180, C540, C720)')

    p_imp = sub.add_parser('import-xyz', help='Import and relax any .xyz file')
    p_imp.add_argument('path', help='Path to .xyz file')
    p_imp.add_argument('--name', help='Library name (default: filename)')
    p_imp.add_argument('--desc', help='Description')

    sub.add_parser('list', help='List library contents')
    sub.add_parser('rebuild-all', help='Rebuild all standard structures')

    args = parser.parse_args()

    if args.command == 'c60':
        cmd_c60(args)
    elif args.command == 'cnt':
        cmd_cnt(args)
    elif args.command == 'graphene':
        cmd_graphene(args)
    elif args.command == 'diamond':
        cmd_diamond(args)
    elif args.command == 'fullerene':
        cmd_fullerene(args)
    elif args.command == 'import-xyz':
        cmd_import_xyz(args)
    elif args.command == 'list':
        cmd_list(args)
    elif args.command == 'rebuild-all':
        cmd_rebuild_all(args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
