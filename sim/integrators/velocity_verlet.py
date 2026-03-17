"""Velocity Verlet integrator for molecular dynamics."""
import numpy as np
from ..atoms import Atoms


# Unit conversion: eV/Å force on carbon mass → acceleration in Å/fs²
# a = F / m, where F in eV/Å, m in kg
# eV/Å = 1.602176634e-19 / 1e-10 = 1.602176634e-9 N
# a (m/s²) = F(eV/Å) * 1.602176634e-9 / m(kg)
# a (Å/fs²) = a(m/s²) * 1e-10 / 1e-30 = a(m/s²) * 1e-20... wait
# Let me be precise:
# 1 Å = 1e-10 m, 1 fs = 1e-15 s
# a (Å/fs²) = a(m/s²) * (1e-10 m/Å)^-1 * (1e-15 s/fs)^2
#           = a(m/s²) * 1e10 * 1e-30
#           = a(m/s²) * 1e-20
# So: a(Å/fs²) = F(eV/Å) * 1.602176634e-9 / m(kg) * 1e-20
#              = F(eV/Å) * 1.602176634e-29 / m(kg)

EV_ANGSTROM_TO_ACC = 1.602176634e-29  # eV/Å / kg → Å/fs²


def step(atoms: Atoms, dt: float, compute_forces_fn) -> float:
    """
    Perform one velocity Verlet step.

    Args:
        atoms: Atoms object (modified in place)
        dt: timestep in femtoseconds
        compute_forces_fn: callable(positions) -> (energy, forces, ...)

    Returns:
        potential_energy in eV
    """
    n = atoms.n_atoms

    # Half-step velocity update: v(t + dt/2) = v(t) + (dt/2) * a(t)
    for i in range(n):
        acc = atoms.forces[i] * EV_ANGSTROM_TO_ACC / atoms.masses[i]
        atoms.velocities[i] += 0.5 * dt * acc

    # Full position update: r(t + dt) = r(t) + dt * v(t + dt/2)
    atoms.positions += dt * atoms.velocities

    # Compute new forces
    result = compute_forces_fn(atoms.positions)
    energy = result[0]
    atoms.forces = result[1].copy()

    # Second half-step velocity update: v(t + dt) = v(t + dt/2) + (dt/2) * a(t + dt)
    for i in range(n):
        acc = atoms.forces[i] * EV_ANGSTROM_TO_ACC / atoms.masses[i]
        atoms.velocities[i] += 0.5 * dt * acc

    return energy


def run_nve(atoms: Atoms, dt: float, n_steps: int, compute_forces_fn,
            log_interval: int = 1) -> dict:
    """
    Run NVE molecular dynamics simulation.

    Args:
        atoms: Atoms object
        dt: timestep in fs
        n_steps: number of steps
        compute_forces_fn: callable
        log_interval: how often to log

    Returns:
        dict with 'steps', 'times', 'ke', 'pe', 'te', 'positions_history'
    """
    # Initial force computation
    result = compute_forces_fn(atoms.positions)
    pe = result[0]
    atoms.forces = result[1].copy()

    steps = []
    times = []
    ke_list = []
    pe_list = []
    te_list = []
    positions_history = []

    for s in range(n_steps + 1):
        if s > 0:
            pe = step(atoms, dt, compute_forces_fn)

        if s % log_interval == 0:
            ke = atoms.kinetic_energy()
            te = ke + pe
            steps.append(s)
            times.append(s * dt)
            ke_list.append(ke)
            pe_list.append(pe)
            te_list.append(te)
            positions_history.append(atoms.positions.copy())

    return {
        'steps': np.array(steps),
        'times': np.array(times),
        'ke': np.array(ke_list),
        'pe': np.array(pe_list),
        'te': np.array(te_list),
        'positions_history': positions_history,
    }
