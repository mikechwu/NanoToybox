"""
Canonical structure library for NanoToybox website.

Provides relaxed reference structures for:
- C60 fullerene
- Carbon nanotubes (armchair and zigzag)
- Graphene patches (various sizes)
- Diamond cubic
- Multi-structure scenes
"""
import numpy as np
from ..atoms import Atoms


def c60_fullerene():
    """Standard C60 — see generators.py."""
    from .generators import c60_fullerene as _c60
    return _c60()


def cnt_armchair(n=5, length_cells=5):
    """
    Armchair (n,n) carbon nanotube.

    Args:
        n: chiral index (n,n)
        length_cells: number of unit cells along tube axis
    """
    a_cc = 1.42  # C-C bond length
    a = a_cc * np.sqrt(3)  # graphene lattice constant

    # Armchair tube radius
    radius = n * a / (2 * np.pi)

    # Unit cell height along z
    cell_z = a_cc * 3  # Two rings per unit cell

    positions = []
    for iz in range(length_cells):
        for i_ring in range(2):  # Two rings per cell
            z_base = iz * cell_z + i_ring * a_cc * 1.5
            for ia in range(2 * n):
                theta = 2 * np.pi * ia / (2 * n)
                if i_ring == 0:
                    z = z_base
                else:
                    z = z_base + (a_cc * 0.5 if ia % 2 == 0 else -a_cc * 0.5)
                x = radius * np.cos(theta)
                y = radius * np.sin(theta)
                positions.append([x, y, z])

    positions = np.array(positions)
    # Center
    positions -= positions.mean(axis=0)
    return Atoms(positions)


def cnt_zigzag(n=10, length_cells=5):
    """
    Zigzag (n,0) carbon nanotube.

    Args:
        n: chiral index (n,0)
        length_cells: number of unit cells along tube axis
    """
    a_cc = 1.42
    radius = n * a_cc * np.sqrt(3) / (2 * np.pi)
    cell_z = a_cc * np.sqrt(3)

    positions = []
    for iz in range(length_cells):
        for i_sub in range(2):
            z_offset = iz * cell_z + i_sub * a_cc * np.sqrt(3) / 2
            for ia in range(n):
                theta = 2 * np.pi * ia / n
                if i_sub == 1:
                    theta += np.pi / n
                x = radius * np.cos(theta)
                y = radius * np.sin(theta)
                positions.append([x, y, z_offset])

    positions = np.array(positions)
    positions -= positions.mean(axis=0)
    return Atoms(positions)


def graphene_sheet(nx=10, ny=10, bond_length=1.42):
    """Graphene sheet — see generators.py."""
    from .generators import graphene_patch
    return graphene_patch(nx, ny, bond_length)


def diamond_cubic(nx=2, ny=2, nz=2, a=3.567):
    """
    Diamond cubic carbon.

    Args:
        nx, ny, nz: number of unit cells
        a: lattice constant (3.567 Å for diamond)
    """
    # Diamond has 8 atoms per unit cell
    basis = np.array([
        [0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5],
        [0.25, 0.25, 0.25], [0.75, 0.75, 0.25], [0.75, 0.25, 0.75], [0.25, 0.75, 0.75],
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


def multi_c60(n_molecules=3, spacing=12.0):
    """Multiple C60 molecules arranged in a line."""
    from .generators import c60_fullerene as _c60
    all_pos = []
    single = _c60()
    for i in range(n_molecules):
        shifted = single.positions.copy()
        shifted[:, 0] += i * spacing
        all_pos.append(shifted)
    positions = np.vstack(all_pos)
    positions -= positions.mean(axis=0)
    return Atoms(positions)


def c60_on_graphene(graphene_nx=6, graphene_ny=6, height=6.0):
    """C60 sitting above a graphene sheet."""
    from .generators import c60_fullerene as _c60, graphene_patch
    graphene = graphene_patch(graphene_nx, graphene_ny)
    c60 = _c60()
    # Place C60 above graphene center
    gr_center = graphene.positions.mean(axis=0)
    c60_shifted = c60.positions.copy()
    c60_shifted += gr_center + np.array([0, 0, height])
    positions = np.vstack([graphene.positions, c60_shifted])
    positions -= positions.mean(axis=0)
    return Atoms(positions)


# Structure catalog
CATALOG = {
    'c60': {'fn': c60_fullerene, 'atoms': 60, 'description': 'Buckminsterfullerene', 'phase': 1},
    'cnt_5_5_5': {'fn': lambda: cnt_armchair(5, 5), 'atoms': 100, 'description': '(5,5) armchair CNT, 5 cells', 'phase': 1},
    'cnt_5_5_10': {'fn': lambda: cnt_armchair(5, 10), 'atoms': 200, 'description': '(5,5) armchair CNT, 10 cells', 'phase': 1},
    'cnt_10_0_5': {'fn': lambda: cnt_zigzag(10, 5), 'atoms': 100, 'description': '(10,0) zigzag CNT, 5 cells', 'phase': 2},
    'graphene_6x6': {'fn': lambda: graphene_sheet(6, 6), 'atoms': 72, 'description': '6x6 graphene patch', 'phase': 1},
    'graphene_10x10': {'fn': lambda: graphene_sheet(10, 10), 'atoms': 200, 'description': '10x10 graphene sheet', 'phase': 2},
    'diamond_2x2x2': {'fn': lambda: diamond_cubic(2, 2, 2), 'atoms': 64, 'description': 'Diamond 2x2x2', 'phase': 2},
    'multi_c60_3': {'fn': lambda: multi_c60(3, 12), 'atoms': 180, 'description': '3x C60 molecules', 'phase': 1},
    'multi_c60_5': {'fn': lambda: multi_c60(5, 12), 'atoms': 300, 'description': '5x C60 molecules', 'phase': 2},
    'c60_on_graphene': {'fn': lambda: c60_on_graphene(6, 6, 6), 'atoms': 132, 'description': 'C60 on graphene sheet', 'phase': 1},
}
