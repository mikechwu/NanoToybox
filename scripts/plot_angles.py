"""Plot energy vs angle for 3-atom test."""
import sys
import csv
import numpy as np
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def plot_energy_vs_angle(csv_path, output_dir):
    angles, energies = [], []
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            angles.append(float(row['angle_deg']))
            energies.append(float(row['energy_eV']))

    out = Path(output_dir)
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.plot(angles, energies, 'b-o', markersize=4)
    ax.set_xlabel('Bond Angle (degrees)')
    ax.set_ylabel('Energy (eV)')
    ax.set_title('3-Atom Energy vs. Bond Angle (Tersoff)')
    ax.grid(True, alpha=0.3)
    fig.savefig(out / 'energy_vs_angle.png', dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f"Angle plot saved to {out}")


if __name__ == '__main__':
    plot_energy_vs_angle(sys.argv[1], sys.argv[2])
