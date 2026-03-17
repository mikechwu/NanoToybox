"""
Tersoff potential for carbon.

Implements the Tersoff (1988) potential with carbon parameters.
Reference: J. Tersoff, Phys. Rev. B 39, 5566 (1989).

The total energy is:
    E = sum_{i} sum_{j>i} f_c(r_ij) * [f_R(r_ij) + b_ij * f_A(r_ij)]

where:
    f_R(r) = A * exp(-lambda1 * r)        (repulsive)
    f_A(r) = -B * exp(-lambda2 * r)       (attractive)
    f_c(r) = cutoff function              (smooth)
    b_ij = bond-order term                (3-body angular)
"""
import numpy as np
from typing import Tuple


# Tersoff parameters for carbon (1988)
LAMBDA1 = 3.4879    # Å^-1
LAMBDA2 = 2.2119    # Å^-1
A = 1393.6          # eV
B = 346.74          # eV
N = 0.72751         # dimensionless
BETA = 1.5724e-7    # dimensionless
C = 38049.0         # dimensionless
D = 4.3484          # dimensionless
H = -0.57058        # dimensionless
R_CUT = 1.95        # Å (cutoff center)
D_CUT = 0.15        # Å (cutoff width)


def cutoff(r: float) -> float:
    """Smooth cutoff function f_c(r)."""
    if r < R_CUT - D_CUT:
        return 1.0
    elif r > R_CUT + D_CUT:
        return 0.0
    else:
        return 0.5 - 0.5 * np.sin(np.pi / 2 * (r - R_CUT) / D_CUT)


def cutoff_deriv(r: float) -> float:
    """Derivative of cutoff function df_c/dr."""
    if r < R_CUT - D_CUT or r > R_CUT + D_CUT:
        return 0.0
    else:
        return -0.5 * np.cos(np.pi / 2 * (r - R_CUT) / D_CUT) * (np.pi / (2 * D_CUT))


def f_R(r: float) -> float:
    """Repulsive pair function."""
    return A * np.exp(-LAMBDA1 * r)


def f_R_deriv(r: float) -> float:
    """Derivative of repulsive function."""
    return -LAMBDA1 * A * np.exp(-LAMBDA1 * r)


def f_A(r: float) -> float:
    """Attractive pair function (negative by convention)."""
    return -B * np.exp(-LAMBDA2 * r)


def f_A_deriv(r: float) -> float:
    """Derivative of attractive function."""
    return LAMBDA2 * B * np.exp(-LAMBDA2 * r)


def g_angle(cos_theta: float) -> float:
    """Angular function g(theta)."""
    return 1.0 + C * C / (D * D) - C * C / (D * D + (H - cos_theta) ** 2)


def g_angle_deriv(cos_theta: float) -> float:
    """Derivative of angular function dg/d(cos_theta)."""
    denom = D * D + (H - cos_theta) ** 2
    return -2.0 * C * C * (H - cos_theta) / (denom * denom)


def compute_energy_and_forces(
    positions: np.ndarray,
    neighbor_list: list = None,
) -> Tuple[float, np.ndarray, float]:
    """
    Compute Tersoff potential energy and forces.

    Args:
        positions: (N, 3) array of atomic positions in Å
        neighbor_list: Optional precomputed neighbor list. If None, uses brute force.

    Returns:
        (total_energy_eV, forces_array, two_body_energy_eV)
        forces in eV/Å
    """
    n = len(positions)
    forces = np.zeros((n, 3), dtype=np.float64)
    total_energy = 0.0
    two_body_energy = 0.0

    r_max = R_CUT + D_CUT  # Maximum interaction distance

    # Build neighbor list if not provided
    if neighbor_list is None:
        neighbor_list = [[] for _ in range(n)]
        for i in range(n):
            for j in range(i + 1, n):
                rij = positions[j] - positions[i]
                dist = np.linalg.norm(rij)
                if dist < r_max:
                    neighbor_list[i].append(j)
                    neighbor_list[j].append(i)

    # Precompute distances and unit vectors
    dist_cache = {}
    rhat_cache = {}
    for i in range(n):
        for j in neighbor_list[i]:
            if (i, j) not in dist_cache:
                rij = positions[j] - positions[i]
                d = np.linalg.norm(rij)
                dist_cache[(i, j)] = d
                dist_cache[(j, i)] = d
                rhat_cache[(i, j)] = rij / d if d > 0 else np.zeros(3)
                rhat_cache[(j, i)] = -rhat_cache[(i, j)]

    # Compute energy and forces
    for i in range(n):
        for j in neighbor_list[i]:
            if j <= i:
                continue  # Count each pair once

            r_ij = dist_cache[(i, j)]
            if r_ij >= r_max or r_ij < 1e-10:
                continue

            fc_ij = cutoff(r_ij)
            dfc_ij = cutoff_deriv(r_ij)
            fR_ij = f_R(r_ij)
            dfR_ij = f_R_deriv(r_ij)
            fA_ij = f_A(r_ij)
            dfA_ij = f_A_deriv(r_ij)

            rhat_ij = rhat_cache[(i, j)]

            # --- Compute zeta_ij (bond environment of i looking at j) ---
            zeta_ij = 0.0
            dzeta_ij_dri = np.zeros(3)  # derivative w.r.t. position of i
            # Store per-k derivatives for force on k
            dzeta_ij_drk = {}

            for k in neighbor_list[i]:
                if k == j:
                    continue
                r_ik = dist_cache.get((i, k))
                if r_ik is None or r_ik >= r_max or r_ik < 1e-10:
                    continue

                fc_ik = cutoff(r_ik)
                dfc_ik = cutoff_deriv(r_ik)
                rhat_ik = rhat_cache[(i, k)]

                # cos(theta_ijk) = rhat_ij . rhat_ik
                cos_theta = np.dot(rhat_ij, rhat_ik)
                cos_theta = np.clip(cos_theta, -1.0, 1.0)

                g_val = g_angle(cos_theta)
                dg_val = g_angle_deriv(cos_theta)

                zeta_ij += fc_ik * g_val

                # Derivatives of cos_theta w.r.t. positions
                # cos_theta = (r_ij . r_ik) / (|r_ij| * |r_ik|)
                r_ij_vec = positions[j] - positions[i]
                r_ik_vec = positions[k] - positions[i]

                # d(cos_theta)/d(r_j) = (r_ik / (|r_ij|*|r_ik|)) - cos_theta * rhat_ij / |r_ij|
                dcos_drj = (rhat_ik - cos_theta * rhat_ij) / r_ij
                # d(cos_theta)/d(r_k) = (r_ij / (|r_ij|*|r_ik|)) - cos_theta * rhat_ik / |r_ik|
                dcos_drk = (rhat_ij - cos_theta * rhat_ik) / r_ik
                # d(cos_theta)/d(r_i) = -(dcos_drj + dcos_drk)
                dcos_dri = -(dcos_drj + dcos_drk)

                # d(zeta)/d(r_i) from this k contribution
                # zeta contribution = fc_ik * g(cos_theta)
                # d/dr_i = dfc_ik/dr_ik * (-rhat_ik) * g + fc_ik * dg * dcos/dr_i
                dzeta_dri_k = dfc_ik * (-rhat_ik) * g_val + fc_ik * dg_val * dcos_dri
                dzeta_ij_dri += dzeta_dri_k

                # d(zeta)/d(r_k) from this k contribution
                dzeta_drk_k = dfc_ik * rhat_ik * g_val + fc_ik * dg_val * dcos_drk
                dzeta_ij_drk[k] = dzeta_drk_k

                # d(zeta)/d(r_j) from this k contribution (through cos_theta)
                # This is accumulated in the j force below

            # --- Compute zeta_ji (bond environment of j looking at i) ---
            zeta_ji = 0.0
            dzeta_ji_drj = np.zeros(3)
            dzeta_ji_drk = {}

            for k in neighbor_list[j]:
                if k == i:
                    continue
                r_jk = dist_cache.get((j, k))
                if r_jk is None or r_jk >= r_max or r_jk < 1e-10:
                    continue

                fc_jk = cutoff(r_jk)
                dfc_jk = cutoff_deriv(r_jk)
                rhat_jk = rhat_cache[(j, k)]
                rhat_ji = rhat_cache[(j, i)]

                cos_theta = np.dot(rhat_ji, rhat_jk)
                cos_theta = np.clip(cos_theta, -1.0, 1.0)

                g_val = g_angle(cos_theta)
                dg_val = g_angle_deriv(cos_theta)

                zeta_ji += fc_jk * g_val

                r_ji = dist_cache[(j, i)]
                dcos_dri2 = (rhat_jk - cos_theta * rhat_ji) / r_ji
                dcos_drk2 = (rhat_ji - cos_theta * rhat_jk) / r_jk
                dcos_drj2 = -(dcos_dri2 + dcos_drk2)

                dzeta_ji_drj += dfc_jk * (-rhat_jk) * g_val + fc_jk * dg_val * dcos_drj2
                dzeta_ji_drk[k] = dfc_jk * rhat_jk * g_val + fc_jk * dg_val * dcos_drk2

            # --- Bond-order terms ---
            bz_ij = BETA * zeta_ij
            if bz_ij > 0:
                bij = (1.0 + bz_ij ** N) ** (-1.0 / (2.0 * N))
            else:
                bij = 1.0

            bz_ji = BETA * zeta_ji
            if bz_ji > 0:
                bji = (1.0 + bz_ji ** N) ** (-1.0 / (2.0 * N))
            else:
                bji = 1.0

            # --- Energy ---
            # E_ij = fc * [fR + bij * fA]  (counted from i's perspective)
            # E_ji = fc * [fR + bji * fA]  (counted from j's perspective)
            # Total for pair (i,j): 0.5 * (E_ij + E_ji)
            E_pair = 0.5 * fc_ij * (fR_ij + bij * fA_ij + fR_ij + bji * fA_ij)
            total_energy += E_pair
            two_body_energy += 0.5 * fc_ij * (fR_ij + fA_ij + fR_ij + fA_ij)

            # --- db/dzeta derivatives ---
            if bz_ij > 0 and zeta_ij > 0:
                dbij_dzeta = -0.5 * BETA * (bz_ij ** (N - 1)) * (1.0 + bz_ij ** N) ** (-1.0 / (2.0 * N) - 1.0)
            else:
                dbij_dzeta = 0.0

            if bz_ji > 0 and zeta_ji > 0:
                dbji_dzeta = -0.5 * BETA * (bz_ji ** (N - 1)) * (1.0 + bz_ji ** N) ** (-1.0 / (2.0 * N) - 1.0)
            else:
                dbji_dzeta = 0.0

            # --- Forces (negative gradient of energy) ---
            # Pair force along ij direction
            # dE/dr_ij from the pair part (fc * [fR + b*fA])
            pair_force_mag_ij = 0.5 * (dfc_ij * (fR_ij + bij * fA_ij) + fc_ij * (dfR_ij + bij * dfA_ij))
            pair_force_mag_ji = 0.5 * (dfc_ij * (fR_ij + bji * fA_ij) + fc_ij * (dfR_ij + bji * dfA_ij))
            pair_force_scalar = pair_force_mag_ij + pair_force_mag_ji

            # Force on i from pair term: -dE/dr_i = -dE/dr_ij * d(r_ij)/d(r_i) = dE/dr_ij * rhat_ij
            # (since r_ij increases when r_i moves opposite to rhat_ij)
            forces[i] += pair_force_scalar * rhat_ij   # This is -dE/dri from pair
            forces[j] -= pair_force_scalar * rhat_ij

            # Forces from bond-order (3-body) terms
            # dE/d(zeta_ij) = 0.5 * fc_ij * fA_ij * dbij/dzeta_ij
            dE_dzeta_ij = 0.5 * fc_ij * fA_ij * dbij_dzeta
            dE_dzeta_ji = 0.5 * fc_ij * fA_ij * dbji_dzeta

            # Force on i from zeta_ij
            forces[i] -= dE_dzeta_ij * dzeta_ij_dri
            # Force on j from zeta_ij (through cos_theta_ijk dependence on r_j)
            for k in neighbor_list[i]:
                if k == j:
                    continue
                r_ik = dist_cache.get((i, k))
                if r_ik is None or r_ik >= r_max or r_ik < 1e-10:
                    continue
                fc_ik = cutoff(r_ik)
                dg_val = g_angle_deriv(np.clip(np.dot(rhat_cache[(i, j)], rhat_cache[(i, k)]), -1, 1))
                dcos_drj = (rhat_cache[(i, k)] - np.clip(np.dot(rhat_cache[(i, j)], rhat_cache[(i, k)]), -1, 1) * rhat_cache[(i, j)]) / r_ij
                forces[j] -= dE_dzeta_ij * fc_ik * dg_val * dcos_drj
            # Force on k from zeta_ij
            for k, dzeta_k in dzeta_ij_drk.items():
                forces[k] -= dE_dzeta_ij * dzeta_k

            # Force on j from zeta_ji
            forces[j] -= dE_dzeta_ji * dzeta_ji_drj
            # Force on i from zeta_ji (through cos_theta_jik dependence on r_i)
            for k in neighbor_list[j]:
                if k == i:
                    continue
                r_jk = dist_cache.get((j, k))
                if r_jk is None or r_jk >= r_max or r_jk < 1e-10:
                    continue
                fc_jk = cutoff(r_jk)
                r_ji = dist_cache[(j, i)]
                rhat_ji = rhat_cache[(j, i)]
                rhat_jk = rhat_cache[(j, k)]
                cos_t = np.clip(np.dot(rhat_ji, rhat_jk), -1, 1)
                dg_val = g_angle_deriv(cos_t)
                dcos_dri2 = (rhat_jk - cos_t * rhat_ji) / r_ji
                forces[i] -= dE_dzeta_ji * fc_jk * dg_val * dcos_dri2
            # Force on k from zeta_ji
            for k, dzeta_k in dzeta_ji_drk.items():
                forces[k] -= dE_dzeta_ji * dzeta_k

    # Sign convention: all force accumulations above already compute F = -∇E:
    # - Pair forces: F_i = dE/dr_ij * rhat_ij = -∇_i(E) ✓
    # - 3-body forces: F_i -= dE/dzeta * dzeta/dr_i = -∇_i(E) ✓
    # No final negation needed.

    return total_energy, forces, two_body_energy


def compute_energy_only(positions: np.ndarray) -> float:
    """Compute only the total potential energy (no forces)."""
    n = len(positions)
    r_max = R_CUT + D_CUT
    total_energy = 0.0

    for i in range(n):
        for j in range(i + 1, n):
            rij_vec = positions[j] - positions[i]
            r_ij = np.linalg.norm(rij_vec)
            if r_ij >= r_max or r_ij < 1e-10:
                continue

            fc_ij = cutoff(r_ij)
            rhat_ij = rij_vec / r_ij

            # Compute zeta_ij
            zeta_ij = 0.0
            for k in range(n):
                if k == i or k == j:
                    continue
                rik_vec = positions[k] - positions[i]
                r_ik = np.linalg.norm(rik_vec)
                if r_ik >= r_max or r_ik < 1e-10:
                    continue
                rhat_ik = rik_vec / r_ik
                cos_theta = np.clip(np.dot(rhat_ij, rhat_ik), -1, 1)
                zeta_ij += cutoff(r_ik) * g_angle(cos_theta)

            # Compute zeta_ji
            zeta_ji = 0.0
            rhat_ji = -rhat_ij
            for k in range(n):
                if k == i or k == j:
                    continue
                rjk_vec = positions[k] - positions[j]
                r_jk = np.linalg.norm(rjk_vec)
                if r_jk >= r_max or r_jk < 1e-10:
                    continue
                rhat_jk = rjk_vec / r_jk
                cos_theta = np.clip(np.dot(rhat_ji, rhat_jk), -1, 1)
                zeta_ji += cutoff(r_jk) * g_angle(cos_theta)

            # Bond orders
            bz_ij = BETA * zeta_ij
            bij = (1.0 + bz_ij ** N) ** (-1.0 / (2.0 * N)) if bz_ij > 0 else 1.0
            bz_ji = BETA * zeta_ji
            bji = (1.0 + bz_ji ** N) ** (-1.0 / (2.0 * N)) if bz_ji > 0 else 1.0

            fR_val = f_R(r_ij)
            fA_val = f_A(r_ij)

            total_energy += 0.5 * fc_ij * (fR_val + bij * fA_val + fR_val + bji * fA_val)

    return total_energy


def compute_2body_forces(positions: np.ndarray) -> Tuple[float, np.ndarray]:
    """
    Compute ONLY the 2-body (pair) contribution with bond-order set to 1.

    This is the analytical baseline: f_c(r) * [f_R(r) + f_A(r)]
    with no angular/bond-order modulation.

    Returns (energy_2body, forces_2body).
    """
    n = len(positions)
    forces = np.zeros((n, 3), dtype=np.float64)
    energy = 0.0
    r_max = R_CUT + D_CUT

    for i in range(n):
        for j in range(i + 1, n):
            rij = positions[j] - positions[i]
            r = np.linalg.norm(rij)
            if r >= r_max or r < 1e-10:
                continue

            rhat = rij / r
            fc = cutoff(r)
            dfc = cutoff_deriv(r)
            fR_val = f_R(r)
            dfR_val = f_R_deriv(r)
            fA_val = f_A(r)
            dfA_val = f_A_deriv(r)

            # Energy: f_c * (f_R + f_A) with b=1
            energy += fc * (fR_val + fA_val)

            # Force: d/dr [fc * (fR + fA)]
            dEdr = dfc * (fR_val + fA_val) + fc * (dfR_val + dfA_val)

            # F_i = dEdr * rhat (consistent with main force computation sign convention)
            forces[i] += dEdr * rhat
            forces[j] -= dEdr * rhat

    return energy, forces


def compute_force_decomposition(positions: np.ndarray) -> dict:
    """
    Compute full force decomposition: total, 2-body, and residual (3-body).

    Returns dict with:
        'energy_total', 'forces_total',
        'energy_2body', 'forces_2body',
        'forces_residual' (= forces_total - forces_2body)
    """
    e_total, f_total, _ = compute_energy_and_forces(positions)
    e_2body, f_2body = compute_2body_forces(positions)

    f_residual = f_total - f_2body

    return {
        'energy_total': e_total,
        'forces_total': f_total,
        'energy_2body': e_2body,
        'forces_2body': f_2body,
        'forces_residual': f_residual,
        'energy_residual': e_total - e_2body,
    }
