"""
Carbon nanostructure geometry generators.

Ported from ~/NCKU/Generate_CNT/ MATLAB code.
Uses the graphene-sheet-rolling method for CNTs.

Supports:
- Graphene sheets (any size)
- CNTs: armchair (n,n), zigzag (n,0), and arbitrary chiral (n,m)
- C60 fullerene
- Diamond cubic
"""
import numpy as np
from math import gcd
from ..atoms import Atoms


# Graphene lattice constant (Å) — distance between equivalent atoms
LATTICE_CONST = 2.4612  # = sqrt(3) * 1.421 Å (C-C bond)
CC_BOND = 1.421  # Å


def graphene(nx: int, ny: int) -> Atoms:
    """
    Generate a graphene sheet with nx x ny unit cells.

    Uses proper hexagonal lattice vectors:
      a1 = a * [1, 0]
      a2 = a * [1/2, sqrt(3)/2]
    Each unit cell has 2 atoms.

    Returns centered Atoms object.
    """
    a = LATTICE_CONST
    a1 = np.array([a, 0.0, 0.0])
    a2 = np.array([a / 2, a * np.sqrt(3) / 2, 0.0])

    # Two atoms per unit cell
    basis = np.array([
        [0.0, 0.0, 0.0],
        [a / 2, a * np.sqrt(3) / 6, 0.0],  # = (1/3)*a1 + (1/3)*a2 offset
    ])

    positions = []
    for ix in range(nx):
        for iy in range(ny):
            origin = ix * a1 + iy * a2
            for b in basis:
                positions.append(origin + b)

    positions = np.array(positions)
    positions -= positions.mean(axis=0)
    return Atoms(positions)


def cnt(n: int, m: int, n_cells: int = 1) -> Atoms:
    """
    Generate a carbon nanotube with chiral indices (n, m).

    Algorithm (from NCKU Generate_CNT):
    1. Build flat graphene sheet large enough for one unit cell
    2. Rotate so chiral vector aligns with x-axis
    3. Extract atoms within one translational period
    4. Roll into cylinder: x -> angle, (x,y) -> cylinder surface

    Args:
        n, m: chiral indices (n >= m >= 0)
        n_cells: number of unit cells along tube axis

    Special cases:
        (n, n) = armchair
        (n, 0) = zigzag
    """
    if n < m:
        n, m = m, n

    a = LATTICE_CONST

    # Chiral vector magnitude (= circumference)
    C_mag = a * np.sqrt(n * n + n * m + m * m)
    radius = C_mag / (2 * np.pi)

    # Translation vector magnitude (one unit cell length along axis)
    d_gcd = gcd(2 * n + m, n + 2 * m)
    T_mag = a * np.sqrt(3 * (n * n + n * m + m * m)) / d_gcd

    # Number of atoms per unit cell: 2 * (n^2 + nm + m^2) / gcd(2n+m, n+2m)
    # But we generate by construction and count

    # Rotation angle to align chiral vector with x-axis
    cos_theta = (n + m / 2.0) / np.sqrt(n * n + n * m + m * m)
    sin_theta = np.sqrt(max(0, 1 - cos_theta * cos_theta))

    rot = np.array([
        [cos_theta,  sin_theta, 0],
        [-sin_theta, cos_theta, 0],
        [0,          0,         1],
    ])

    # Generate large enough graphene sheet
    # Lattice vectors (unit)
    a1 = np.array([1.0, 0.0])
    a2 = np.array([0.5, np.sqrt(3) / 2])

    # Determine bounds
    x_max = n + m + 5
    x_min = -m - 5
    y_max_lattice = int(np.ceil(T_mag / (a * np.sqrt(3) / 2))) + m + 5

    # Generate flat graphene points (2 atoms per hexagonal cell)
    flat_points = []
    for ix in range(x_min, x_max + 1):
        for iy in range(-2, y_max_lattice + 2):
            p1 = ix * a1 + iy * a2
            p2 = p1 + np.array([0.0, 1.0 / np.sqrt(3)])

            flat_points.append([p1[0], p1[1], 0.0])
            flat_points.append([p2[0], p2[1], 0.0])

    flat_points = np.array(flat_points) * a  # Scale to Angstroms

    # Rotate to align chiral vector with x-axis
    rotated = (rot @ flat_points.T).T

    # Extract unit cell: 0 <= x < C_mag AND 0 < y < T_mag
    eps = 0.1  # Å tolerance
    mask = (
        (rotated[:, 0] >= -eps) &
        (rotated[:, 0] < C_mag - eps) &
        (rotated[:, 1] > eps) &
        (rotated[:, 1] < T_mag + eps)
    )
    unit_cell = rotated[mask].copy()

    # Center y in unit cell
    unit_cell[:, 1] -= T_mag / 2

    # Roll into cylinder: x -> theta
    theta = unit_cell[:, 0] / radius
    tube_x = radius * np.cos(theta)
    tube_y = radius * np.sin(theta)
    tube_z = unit_cell[:, 1]

    tube_unit = np.column_stack([tube_x, tube_y, tube_z])

    # Stack unit cells along z-axis
    n_atoms_unit = len(tube_unit)
    all_positions = []
    for i_cell in range(n_cells):
        shifted = tube_unit.copy()
        shifted[:, 2] += i_cell * T_mag
        all_positions.append(shifted)

    positions = np.vstack(all_positions)

    # Remove duplicate atoms (at periodic boundary)
    to_remove = set()
    for i in range(len(positions)):
        if i in to_remove:
            continue
        for j in range(i + 1, len(positions)):
            if j in to_remove:
                continue
            if np.linalg.norm(positions[i] - positions[j]) < 0.1:
                to_remove.add(j)

    if to_remove:
        positions = np.delete(positions, list(to_remove), axis=0)

    positions -= positions.mean(axis=0)
    return Atoms(positions)


def cnt_armchair(n: int, n_cells: int = 1) -> Atoms:
    """Armchair (n,n) carbon nanotube."""
    return cnt(n, n, n_cells)


def cnt_zigzag(n: int, n_cells: int = 1) -> Atoms:
    """Zigzag (n,0) carbon nanotube."""
    return cnt(n, 0, n_cells)


def c60() -> Atoms:
    """C60 Buckminsterfullerene (truncated icosahedron)."""
    from .generators import c60_fullerene
    return c60_fullerene()


def diamond(nx: int = 2, ny: int = 2, nz: int = 2, a: float = 3.567) -> Atoms:
    """
    Diamond cubic carbon.

    Args:
        nx, ny, nz: unit cell repetitions
        a: lattice constant (3.567 Å for diamond)
    """
    basis = np.array([
        [0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5],
        [0.25, 0.25, 0.25], [0.75, 0.75, 0.25],
        [0.75, 0.25, 0.75], [0.25, 0.75, 0.75],
    ]) * a

    positions = []
    for ix in range(nx):
        for iy in range(ny):
            for iz in range(nz):
                origin = np.array([ix, iy, iz]) * a
                for b in basis:
                    positions.append(origin + b)

    positions = np.array(positions)
    positions -= positions.mean(axis=0)
    return Atoms(positions)
