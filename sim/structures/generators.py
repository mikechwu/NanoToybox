"""Structure generators for carbon nanostructures."""
import numpy as np
from ..atoms import Atoms


def carbon_dimer(distance: float = 1.5) -> Atoms:
    """Create a carbon dimer (2 atoms) at given distance."""
    positions = np.array([
        [0.0, 0.0, 0.0],
        [distance, 0.0, 0.0],
    ])
    return Atoms(positions)


def carbon_triangle(distance: float = 1.42, angle_deg: float = 60.0) -> Atoms:
    """Create 3 carbon atoms: A at origin, B along x, C at given angle."""
    angle_rad = np.radians(angle_deg)
    positions = np.array([
        [0.0, 0.0, 0.0],                                          # A
        [distance, 0.0, 0.0],                                      # B
        [distance * np.cos(angle_rad), distance * np.sin(angle_rad), 0.0],  # C
    ])
    return Atoms(positions)


def graphene_patch(nx: int = 4, ny: int = 4, bond_length: float = 1.42) -> Atoms:
    """
    Create a small graphene patch (honeycomb lattice).

    Args:
        nx, ny: number of unit cells in x and y
        bond_length: C-C bond length in Å

    Returns:
        Atoms with graphene positions
    """
    a = bond_length * np.sqrt(3)  # lattice constant
    # Unit cell has 2 atoms
    a1 = np.array([a, 0, 0])
    a2 = np.array([a / 2, a * np.sqrt(3) / 2, 0])

    # Basis atoms within unit cell
    basis = np.array([
        [0, 0, 0],
        [bond_length * np.cos(np.pi / 6), bond_length * np.sin(np.pi / 6), 0],
    ])

    positions = []
    for ix in range(nx):
        for iy in range(ny):
            origin = ix * a1 + iy * a2
            for b in basis:
                positions.append(origin + b)

    return Atoms(np.array(positions))


def c60_fullerene() -> Atoms:
    """
    Create C60 Buckminsterfullerene (truncated icosahedron).

    Uses the standard Cartesian coordinates scaled to give
    average C-C bond length of ~1.42 Å.
    """
    # Golden ratio
    phi = (1 + np.sqrt(5)) / 2

    # The 60 vertices of a truncated icosahedron (before scaling)
    # Generated from permutations and sign changes of:
    # (0, ±1, ±3φ), (±2, ±(1+2φ), ±φ), (±1, ±(2+φ), ±2φ)
    coords = []

    # Type 1: (0, ±1, ±3φ) and cyclic permutations
    for s1 in [1, -1]:
        for s2 in [1, -1]:
            coords.append([0, s1 * 1, s2 * 3 * phi])
            coords.append([s2 * 3 * phi, 0, s1 * 1])
            coords.append([s1 * 1, s2 * 3 * phi, 0])

    # Type 2: (±2, ±(1+2φ), ±φ) and cyclic permutations
    val_a = 2.0
    val_b = 1 + 2 * phi
    val_c = phi
    for s1 in [1, -1]:
        for s2 in [1, -1]:
            for s3 in [1, -1]:
                coords.append([s1 * val_a, s2 * val_b, s3 * val_c])
                coords.append([s3 * val_c, s1 * val_a, s2 * val_b])
                coords.append([s2 * val_b, s3 * val_c, s1 * val_a])

    # Type 3: (±1, ±(2+φ), ±2φ) and cyclic permutations
    val_d = 1.0
    val_e = 2 + phi
    val_f = 2 * phi
    for s1 in [1, -1]:
        for s2 in [1, -1]:
            for s3 in [1, -1]:
                coords.append([s1 * val_d, s2 * val_e, s3 * val_f])
                coords.append([s3 * val_f, s1 * val_d, s2 * val_e])
                coords.append([s2 * val_e, s3 * val_f, s1 * val_d])

    positions = np.array(coords)

    # Remove duplicates (within tolerance)
    unique = [positions[0]]
    for p in positions[1:]:
        is_dup = False
        for u in unique:
            if np.linalg.norm(p - u) < 0.01:
                is_dup = True
                break
        if not is_dup:
            unique.append(p)

    positions = np.array(unique[:60])  # Should be exactly 60

    if len(positions) != 60:
        raise ValueError(f"C60 generation produced {len(positions)} atoms, expected 60")

    # Scale to get correct bond lengths
    # Find minimum distance in current coordinates
    min_dist = float('inf')
    for i in range(len(positions)):
        for j in range(i + 1, len(positions)):
            d = np.linalg.norm(positions[i] - positions[j])
            if d < min_dist:
                min_dist = d

    # Scale so minimum distance ≈ 1.40 Å (shorter C60 bond)
    target_bond = 1.40
    scale = target_bond / min_dist
    positions *= scale

    # Center at origin
    positions -= positions.mean(axis=0)

    return Atoms(positions)
