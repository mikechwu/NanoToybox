"""
Atom-centered descriptors for ML force prediction.

Uses radial symmetry functions (Behler-Parrinello style) as local
environment descriptors. These are rotation- and translation-invariant
by construction.
"""
import numpy as np

# Descriptor parameters
R_CUT = 2.1  # Å — same as Tersoff cutoff
N_RADIAL = 8  # number of radial basis functions
ETA_VALUES = np.array([0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0])  # Å^-2
RS_VALUES = np.linspace(0.8, 2.0, N_RADIAL)  # center positions in Å

# Angular descriptor parameters
N_ANGULAR = 4
ZETA_VALUES = np.array([1.0, 2.0, 4.0, 8.0])
LAMBDA_VALUES = np.array([1.0, -1.0, 1.0, -1.0])

DESCRIPTOR_DIM = N_RADIAL + N_ANGULAR  # 12 features per atom


def cutoff_fn(r):
    """Smooth cutoff function."""
    if r >= R_CUT:
        return 0.0
    return 0.5 * (1 + np.cos(np.pi * r / R_CUT))


def compute_descriptors(positions, atom_idx):
    """
    Compute local environment descriptor for a single atom.

    Returns array of shape (DESCRIPTOR_DIM,) = (12,)
    """
    n = len(positions)
    ri = positions[atom_idx]
    desc = np.zeros(DESCRIPTOR_DIM)

    # Radial symmetry functions: G2
    neighbors = []
    for j in range(n):
        if j == atom_idx:
            continue
        rij = np.linalg.norm(positions[j] - ri)
        if rij < R_CUT and rij > 0.1:
            neighbors.append((j, rij))

    for j, rij in neighbors:
        fc = cutoff_fn(rij)
        for k in range(N_RADIAL):
            desc[k] += np.exp(-ETA_VALUES[k] * (rij - RS_VALUES[k])**2) * fc

    # Angular symmetry functions: G4 (simplified)
    for idx_a, (ja, rij) in enumerate(neighbors):
        for jb, rik in neighbors[idx_a+1:]:
            rij_vec = positions[ja] - ri
            rik_vec = positions[jb] - ri
            cos_theta = np.dot(rij_vec, rik_vec) / (rij * rik)
            cos_theta = np.clip(cos_theta, -1, 1)
            fc_ij = cutoff_fn(rij)
            fc_ik = cutoff_fn(rik)

            for k in range(N_ANGULAR):
                angular = (1 + LAMBDA_VALUES[k] * cos_theta) ** ZETA_VALUES[k]
                radial = np.exp(-1.0 * (rij**2 + rik**2))
                desc[N_RADIAL + k] += 2**(1 - ZETA_VALUES[k]) * angular * radial * fc_ij * fc_ik

    return desc


def compute_all_descriptors(positions):
    """Compute descriptors for all atoms. Returns (N, DESCRIPTOR_DIM)."""
    n = len(positions)
    descs = np.zeros((n, DESCRIPTOR_DIM))
    for i in range(n):
        descs[i] = compute_descriptors(positions, i)
    return descs
