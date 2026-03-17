"""
Energy minimizer for finding ground-state structures.

Uses steepest descent with adaptive step size (FIRE-like damping).
Converges when max force < tolerance.
"""
import numpy as np
from .atoms import Atoms


def minimize(atoms: Atoms, compute_forces_fn, max_steps=10000, f_tol=1e-6,
             dt_start=0.5, dt_max=2.0, alpha_start=0.1) -> dict:
    """
    Minimize energy using FIRE-like steepest descent.

    Args:
        atoms: Atoms object (modified in place)
        compute_forces_fn: callable(positions) -> (energy, forces, ...)
        max_steps: maximum optimization steps
        f_tol: force tolerance (eV/Å) for convergence
        dt_start: initial timestep for velocity Verlet in minimizer
        dt_max: maximum timestep
        alpha_start: initial mixing parameter

    Returns:
        dict with convergence info
    """
    dt = dt_start
    alpha = alpha_start
    n_pos = 0  # steps since last negative power
    velocities = np.zeros_like(atoms.positions)

    # Initial forces
    result = compute_forces_fn(atoms.positions)
    energy = result[0]
    atoms.forces = result[1].copy()

    energies = [energy]
    max_forces = [np.max(np.linalg.norm(atoms.forces, axis=1))]

    for step in range(max_steps):
        # Check convergence
        fmax = np.max(np.linalg.norm(atoms.forces, axis=1))
        if fmax < f_tol:
            return {
                'converged': True,
                'steps': step,
                'final_energy': energy,
                'final_fmax': fmax,
                'energies': energies,
                'max_forces': max_forces,
            }

        # FIRE algorithm
        power = np.sum(velocities * atoms.forces)

        if power > 0:
            n_pos += 1
            if n_pos > 5:
                dt = min(dt * 1.1, dt_max)
                alpha *= 0.99
            # Mix velocity with force direction
            f_norm = np.linalg.norm(atoms.forces)
            v_norm = np.linalg.norm(velocities)
            if f_norm > 0:
                velocities = (1 - alpha) * velocities + alpha * (v_norm / f_norm) * atoms.forces
        else:
            # Reset
            n_pos = 0
            velocities *= 0.0
            dt = dt_start * 0.5
            alpha = alpha_start

        # Velocity Verlet step (with unit conversion for minimizer)
        # Use simplified units: treat force as acceleration directly
        # Scale forces by a small factor to act as gradient descent
        step_size = 0.01  # Å per (eV/Å) — controls descent rate
        velocities += 0.5 * step_size * atoms.forces
        atoms.positions += dt * velocities
        velocities += 0.5 * step_size * atoms.forces  # will be updated with new forces

        # New forces
        result = compute_forces_fn(atoms.positions)
        energy = result[0]
        atoms.forces = result[1].copy()

        # Second half of velocity update with new forces
        # (already done implicitly since we use new forces next iteration)

        energies.append(energy)
        max_forces.append(np.max(np.linalg.norm(atoms.forces, axis=1)))

    fmax = np.max(np.linalg.norm(atoms.forces, axis=1))
    return {
        'converged': fmax < f_tol,
        'steps': max_steps,
        'final_energy': energy,
        'final_fmax': fmax,
        'energies': energies,
        'max_forces': max_forces,
    }


def simple_minimize(atoms: Atoms, compute_forces_fn, max_steps=5000,
                    f_tol=1e-4, step_size=0.005) -> dict:
    """
    Steepest descent minimizer with adaptive step size.

    Moves atoms along force direction. Increases step on success,
    backtracks and reduces on failure.
    """
    result = compute_forces_fn(atoms.positions)
    energy = result[0]
    atoms.forces = result[1].copy()

    energies = [energy]
    max_forces = [np.max(np.linalg.norm(atoms.forces, axis=1))]
    saved_pos = atoms.positions.copy()

    for s in range(max_steps):
        fmax = np.max(np.linalg.norm(atoms.forces, axis=1))
        if fmax < f_tol:
            return {
                'converged': True,
                'steps': s,
                'final_energy': energy,
                'final_fmax': fmax,
                'energies': energies,
                'max_forces': max_forces,
            }

        # Save position before step
        saved_pos = atoms.positions.copy()

        # Normalize force direction to avoid overshooting
        force_norms = np.linalg.norm(atoms.forces, axis=1, keepdims=True)
        force_norms = np.maximum(force_norms, 1e-20)
        # Scale step by force magnitude but cap individual atom displacement
        displacement = step_size * atoms.forces
        disp_norms = np.linalg.norm(displacement, axis=1)
        max_disp = 0.1  # Max 0.1 Å per step per atom
        scale = np.minimum(1.0, max_disp / np.maximum(disp_norms, 1e-20))
        displacement *= scale[:, np.newaxis]

        atoms.positions += displacement

        result = compute_forces_fn(atoms.positions)
        new_energy = result[0]
        atoms.forces = result[1].copy()

        if new_energy < energy:
            energy = new_energy
            step_size = min(step_size * 1.2, 0.1)  # grow step on success
        else:
            # Backtrack
            atoms.positions = saved_pos
            step_size *= 0.5
            # Re-evaluate at old position
            result = compute_forces_fn(atoms.positions)
            energy = result[0]
            atoms.forces = result[1].copy()
            if step_size < 1e-10:
                break

        energies.append(energy)
        max_forces.append(np.max(np.linalg.norm(atoms.forces, axis=1)))

    fmax = np.max(np.linalg.norm(atoms.forces, axis=1))
    return {
        'converged': fmax < f_tol,
        'steps': min(s + 1, max_steps),
        'final_energy': energy,
        'final_fmax': fmax,
        'energies': energies,
        'max_forces': max_forces,
    }
