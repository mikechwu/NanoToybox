"""Compare steepest descent vs FIRE minimizer on C60 and graphene."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np
from sim.potentials.tersoff import compute_energy_and_forces
from sim.structures.generators import c60_fullerene, graphene_patch
from sim.minimizer import simple_minimize, minimize as fire_minimize

def force_fn(pos):
    return compute_energy_and_forces(pos)

def compare(name, gen_fn):
    print(f"\n--- {name} ---")

    # Steepest descent
    atoms_sd = gen_fn()
    r_sd = simple_minimize(atoms_sd, force_fn, max_steps=5000, f_tol=1e-4)
    e_sd = r_sd['final_energy']
    f_sd = r_sd['final_fmax']
    s_sd = r_sd['steps']

    # FIRE
    atoms_fire = gen_fn()
    r_fire = fire_minimize(atoms_fire, force_fn, max_steps=5000, f_tol=1e-4)
    e_fire = r_fire['final_energy']
    f_fire = r_fire['final_fmax']
    s_fire = r_fire['steps']

    # Compare final positions
    disp = np.max(np.linalg.norm(atoms_sd.positions - atoms_fire.positions, axis=1))

    print(f"  Steepest Descent: E={e_sd:.6f} eV, Fmax={f_sd:.2e}, steps={s_sd}")
    print(f"  FIRE:             E={e_fire:.6f} eV, Fmax={f_fire:.2e}, steps={s_fire}")
    print(f"  ΔE = {abs(e_sd - e_fire):.6e} eV")
    print(f"  Max position difference: {disp:.6e} Å")
    print(f"  Same minimum? {'YES' if disp < 0.01 and abs(e_sd - e_fire) < 0.001 else 'CHECK'}")

if __name__ == '__main__':
    print("=" * 60)
    print("MINIMIZER COMPARISON: Steepest Descent vs FIRE")
    print("=" * 60)
    compare("C60", c60_fullerene)
    compare("Graphene", lambda: graphene_patch(nx=3, ny=3))
