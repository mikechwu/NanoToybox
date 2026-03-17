"""Output writers for simulation data."""
import numpy as np
import csv
from pathlib import Path


def write_xyz(filename: str, positions_list: list, times: np.ndarray = None, comment: str = ""):
    """Write trajectory in extended XYZ format."""
    path = Path(filename)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, 'w') as f:
        for frame_idx, pos in enumerate(positions_list):
            n = len(pos)
            f.write(f"{n}\n")
            t_str = f"time={times[frame_idx]:.4f}" if times is not None else ""
            f.write(f"frame={frame_idx} {t_str} {comment}\n")
            for i in range(n):
                f.write(f"C {pos[i][0]:.8f} {pos[i][1]:.8f} {pos[i][2]:.8f}\n")


def write_energy_csv(filename: str, steps, times, ke, pe, te):
    """Write energy time series to CSV."""
    path = Path(filename)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['step', 'time_fs', 'kinetic_eV', 'potential_eV', 'total_eV'])
        for i in range(len(steps)):
            writer.writerow([int(steps[i]), f"{times[i]:.4f}",
                           f"{ke[i]:.10f}", f"{pe[i]:.10f}", f"{te[i]:.10f}"])
