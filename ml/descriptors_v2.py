"""
Enhanced descriptors v2: more angular resolution for curved structures.

Key change: many more angular symmetry functions with fine-grained ζ/λ/η
parameters to distinguish C60's subtle angular differences.
"""
import numpy as np

R_CUT = 2.1

# Radial: 12 functions (was 8)
N_RADIAL = 12
ETA_RAD = np.array([0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 0.1, 0.05])
RS_RAD = np.concatenate([np.linspace(0.8, 2.0, 10), [1.4, 1.5]])[:N_RADIAL]

# Angular: 24 functions (was 4) — key improvement
ANGULAR_PARAMS = []
for zeta in [1, 2, 4, 8, 16]:
    for lam in [1.0, -1.0]:
        for eta in [0.5, 2.0]:
            ANGULAR_PARAMS.append((zeta, lam, eta))
# Also add narrow angular bins
for zeta in [32, 64]:
    ANGULAR_PARAMS.append((zeta, 1.0, 1.0))
    ANGULAR_PARAMS.append((zeta, -1.0, 1.0))

N_ANGULAR = len(ANGULAR_PARAMS)  # 24
DESCRIPTOR_DIM = N_RADIAL + N_ANGULAR  # 36


def cutoff_fn(r):
    if r >= R_CUT: return 0.0
    return 0.5 * (1 + np.cos(np.pi * r / R_CUT))


def compute_descriptors(positions, atom_idx):
    n = len(positions)
    ri = positions[atom_idx]
    desc = np.zeros(DESCRIPTOR_DIM)

    neighbors = []
    for j in range(n):
        if j == atom_idx: continue
        rij = np.linalg.norm(positions[j] - ri)
        if 0.1 < rij < R_CUT:
            neighbors.append((j, rij))

    # Radial G2
    for j, rij in neighbors:
        fc = cutoff_fn(rij)
        for k in range(N_RADIAL):
            desc[k] += np.exp(-ETA_RAD[k] * (rij - RS_RAD[k])**2) * fc

    # Angular G4 with many more parameters
    for ia, (ja, rij) in enumerate(neighbors):
        for jb, rik in neighbors[ia+1:]:
            rij_vec = positions[ja] - ri
            rik_vec = positions[jb] - ri
            cos_theta = np.dot(rij_vec, rik_vec) / (rij * rik)
            cos_theta = np.clip(cos_theta, -1, 1)
            fc_ij = cutoff_fn(rij)
            fc_ik = cutoff_fn(rik)

            for k, (zeta, lam, eta) in enumerate(ANGULAR_PARAMS):
                angular = (1 + lam * cos_theta) ** zeta
                radial = np.exp(-eta * (rij**2 + rik**2))
                desc[N_RADIAL + k] += 2**(1 - zeta) * angular * radial * fc_ij * fc_ik

    return desc


def compute_all_descriptors(positions):
    n = len(positions)
    descs = np.zeros((n, DESCRIPTOR_DIM))
    for i in range(n):
        descs[i] = compute_descriptors(positions, i)
    return descs
