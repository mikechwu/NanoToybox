"""Atom container for molecular dynamics simulation."""
import numpy as np


class Atoms:
    """Container for atomic positions, velocities, forces, and metadata."""

    def __init__(self, positions: np.ndarray, masses: np.ndarray = None):
        self.positions = np.asarray(positions, dtype=np.float64)
        self.n_atoms = len(self.positions)
        self.velocities = np.zeros_like(self.positions)
        self.forces = np.zeros_like(self.positions)
        if masses is None:
            # Default: carbon mass in kg
            self.masses = np.full(self.n_atoms, 1.9944235e-26)
        else:
            self.masses = np.asarray(masses, dtype=np.float64)

    def kinetic_energy(self) -> float:
        """Compute total kinetic energy in eV."""
        # KE = 0.5 * m * v^2, with v in Å/fs and m in kg
        # Convert: 1 kg * (1 Å/fs)^2 = 1e-20 / 1e-30 = 1e10 J
        # 1 eV = 1.602176634e-19 J
        # So KE (eV) = 0.5 * m(kg) * v^2(Å²/fs²) * 1e10 / 1.602176634e-19
        EV = 1.602176634e-19
        ke = 0.0
        for i in range(self.n_atoms):
            v2 = np.dot(self.velocities[i], self.velocities[i])
            ke += 0.5 * self.masses[i] * v2 * 1e10 / EV
        return ke

    def temperature(self) -> float:
        """Compute instantaneous temperature in K from kinetic energy."""
        if self.n_atoms == 0:
            return 0.0
        KB_EV = 8.617333262e-5  # Boltzmann constant in eV/K
        dof = 3 * self.n_atoms  # degrees of freedom
        ke = self.kinetic_energy()
        return 2.0 * ke / (dof * KB_EV)

    def set_velocities_temperature(self, temperature_k: float, seed: int = 42):
        """Initialize velocities from Maxwell-Boltzmann distribution at given T."""
        rng = np.random.default_rng(seed)
        KB_EV = 8.617333262e-5
        EV = 1.602176634e-19

        for i in range(self.n_atoms):
            # sigma_v in m/s: sqrt(kB*T / m)
            sigma_v = np.sqrt(KB_EV * temperature_k * EV / self.masses[i])
            # Convert m/s to Å/fs: 1 m/s = 1e-5 Å/fs
            sigma_v_afs = sigma_v * 1e-5
            self.velocities[i] = rng.normal(0, sigma_v_afs, 3)

        # Remove center-of-mass velocity
        total_mass = np.sum(self.masses)
        vcm = np.zeros(3)
        for i in range(self.n_atoms):
            vcm += self.masses[i] * self.velocities[i]
        vcm /= total_mass
        for i in range(self.n_atoms):
            self.velocities[i] -= vcm

        # Rescale to exact target temperature
        current_t = self.temperature()
        if current_t > 0:
            scale = np.sqrt(temperature_k / current_t)
            self.velocities *= scale

    def remove_angular_momentum(self):
        """Remove net angular momentum around center of mass.

        For isolated systems (C60, clusters), this prevents rigid-body rotation
        which is not a physical vibration mode.
        """
        # Center of mass
        total_mass = np.sum(self.masses)
        com = np.zeros(3)
        for i in range(self.n_atoms):
            com += self.masses[i] * self.positions[i]
        com /= total_mass

        # Angular momentum L = sum(m_i * r_i x v_i)
        L = np.zeros(3)
        for i in range(self.n_atoms):
            r = self.positions[i] - com
            L += self.masses[i] * np.cross(r, self.velocities[i])

        # Inertia tensor I
        I = np.zeros((3, 3))
        for i in range(self.n_atoms):
            r = self.positions[i] - com
            r2 = np.dot(r, r)
            I += self.masses[i] * (r2 * np.eye(3) - np.outer(r, r))

        # Angular velocity omega = I^-1 * L
        try:
            omega = np.linalg.solve(I, L)
        except np.linalg.LinAlgError:
            return  # Degenerate (e.g., collinear atoms)

        # Remove rotational velocity: v_rot = omega x r
        for i in range(self.n_atoms):
            r = self.positions[i] - com
            self.velocities[i] -= np.cross(omega, r)

    def copy(self):
        """Return a deep copy."""
        atoms = Atoms(self.positions.copy(), self.masses.copy())
        atoms.velocities = self.velocities.copy()
        atoms.forces = self.forces.copy()
        return atoms
