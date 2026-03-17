"""Plot bond length histogram."""
import sys
import csv
import numpy as np
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def plot_bond_histogram(csv_path, output_dir):
    bonds = []
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            bonds.append(float(row['bond_length_A']))

    out = Path(output_dir)
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.hist(bonds, bins=30, edgecolor='black', alpha=0.7)
    ax.set_xlabel('Bond Length (Å)')
    ax.set_ylabel('Count')
    ax.set_title('C-C Bond Length Distribution')
    ax.axvline(1.40, color='red', linestyle='--', label='1.40 Å')
    ax.axvline(1.45, color='blue', linestyle='--', label='1.45 Å')
    ax.legend()
    fig.savefig(out / 'bond_histogram.png', dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f"Bond histogram saved to {out}")


if __name__ == '__main__':
    plot_bond_histogram(sys.argv[1], sys.argv[2])
