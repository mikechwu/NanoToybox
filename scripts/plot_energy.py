"""Plot energy curves from simulation output."""
import csv
import sys
import numpy as np
from pathlib import Path

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    HAS_MPL = True
except ImportError:
    HAS_MPL = False


def load_energy_csv(path):
    steps, times, ke, pe, te = [], [], [], [], []
    with open(path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            steps.append(int(row['step']))
            times.append(float(row['time_fs']))
            ke.append(float(row['kinetic_eV']))
            pe.append(float(row['potential_eV']))
            te.append(float(row['total_eV']))
    return np.array(steps), np.array(times), np.array(ke), np.array(pe), np.array(te)


def plot_energies(csv_path, output_dir):
    if not HAS_MPL:
        print("matplotlib not available, skipping plots")
        return

    steps, times, ke, pe, te = load_energy_csv(csv_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # Energy components
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.plot(times, ke, label='Kinetic', alpha=0.8)
    ax.plot(times, pe, label='Potential', alpha=0.8)
    ax.plot(times, te, label='Total', linewidth=2, color='black')
    ax.set_xlabel('Time (fs)')
    ax.set_ylabel('Energy (eV)')
    ax.set_title('Energy vs Time')
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.savefig(out / 'energy_components.png', dpi=150, bbox_inches='tight')
    plt.close(fig)

    # Energy drift
    if len(te) > 1 and abs(te[0]) > 1e-20:
        drift = (te - te[0]) / abs(te[0])
        fig, ax = plt.subplots(figsize=(10, 6))
        ax.plot(times, drift)
        ax.set_xlabel('Time (fs)')
        ax.set_ylabel('ΔE/E₀')
        ax.set_title('Relative Energy Drift')
        ax.grid(True, alpha=0.3)
        fig.savefig(out / 'energy_drift.png', dpi=150, bbox_inches='tight')
        plt.close(fig)

    print(f"Plots saved to {out}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python plot_energy.py <energy.csv> <output_dir>")
        sys.exit(1)
    plot_energies(sys.argv[1], sys.argv[2])
