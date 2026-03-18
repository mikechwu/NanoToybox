# Structure Library

## Overview

The canonical structure library lives at `structures/library/`. Every XYZ file is a **relaxed 0K equilibrium structure** with Fmax < 1×10⁻³ eV/Å. Metadata is tracked in `manifest.json`.

## Current Library (15 structures)

| Name | Atoms | Type | Description |
|------|-------|------|-------------|
| c60 | 60 | Fullerene | Buckminsterfullerene (truncated icosahedron) |
| c180 | 180 | Fullerene | Fullerene |
| c540 | 540 | Fullerene | Fullerene |
| c720 | 720 | Fullerene | Fullerene |
| cnt_5_5_5cells | 100 | Armchair CNT | (5,5) armchair, 5 unit cells |
| cnt_5_5_10cells | 200 | Armchair CNT | (5,5) armchair, 10 unit cells |
| cnt_10_0_5cells | 200 | Zigzag CNT | (10,0) zigzag, 5 unit cells |
| cnt_6_2_1cells | 104 | Chiral CNT | (6,2) chiral |
| cnt_6_3_2cells | 168 | Chiral CNT | (6,3) chiral |
| cnt_7_4_1cells | 124 | Chiral CNT | (7,4) chiral |
| cnt_8_4_2cells | 224 | Chiral CNT | (8,4) chiral |
| cnt_9_3_1cells | 156 | Chiral CNT | (9,3) chiral |
| graphene_6x6 | 72 | Graphene | 6×6 unit cells |
| graphene_10x10 | 200 | Graphene | 10×10 unit cells |
| diamond_2x2x2 | 64 | Diamond | 2×2×2 unit cells (sp3 carbon) |

## Library CLI

The CLI at `scripts/library_cli.py` handles the full generate → relax → save pipeline.

### Commands

```bash
# Generate specific structures
python3 scripts/library_cli.py c60
python3 scripts/library_cli.py cnt 5 5 --cells 5       # Armchair (5,5)
python3 scripts/library_cli.py cnt 10 0 --cells 3       # Zigzag (10,0)
python3 scripts/library_cli.py cnt 8 4 --cells 2        # Chiral (8,4)
python3 scripts/library_cli.py graphene 6 6
python3 scripts/library_cli.py diamond 2 2 2

# Import from external sources
python3 scripts/library_cli.py import-xyz path/to/file.xyz --name my_structure

# Manage library
python3 scripts/library_cli.py list                      # Show all structures
python3 scripts/library_cli.py rebuild-all               # Rebuild standard set from scratch
```

### Pipeline Details

For each structure, the CLI:

1. **Generates** initial geometry using `sim/structures/generate.py`
2. **Relaxes** with ALL three minimizers in parallel:
   - Steepest descent (adaptive step)
   - FIRE
   - SD + FIRE hybrid (coarse SD then fine FIRE polish)
3. **Picks the best** result: lowest energy among converged solutions
4. **Saves** to `structures/library/{name}.xyz` with metadata
5. **Updates** `manifest.json` with energy, Fmax, method, convergence status

### Performance

With Numba (`tersoff_fast.py`): full rebuild of 7 standard structures takes **~4 seconds**.

Without Numba: same rebuild takes ~10 minutes. Numba is auto-detected.

## Geometry Generation

### CNT Generation (`sim/structures/generate.py`)

Uses the graphene-sheet-rolling algorithm:

1. Build flat hexagonal graphene lattice (lattice constant a = 2.4612 Å)
2. Rotate sheet so chiral vector C = n·a₁ + m·a₂ aligns with x-axis
3. Extract atoms within one translational period
4. Roll into cylinder: x → θ = x/r, where r = |C|/(2π)
5. Stack unit cells along tube axis
6. Remove duplicate atoms at periodic boundaries

Supports any chirality (n,m): armchair (n,n), zigzag (n,0), and chiral.

**Note:** Large chiral CNTs can have many atoms per unit cell. For example, (7,3) has 283 atoms/cell, (9,2) has 361. Use 1 cell for these.

### Graphene Generation

Hexagonal lattice with basis vectors:
```
a1 = [a, 0, 0]
a2 = [a/2, a√3/2, 0]
```
Two atoms per unit cell. C-C bond length = 1.421 Å.

### Fullerenes

C60 is generated algorithmically (truncated icosahedron). C180, C540, C720 coordinates are stored as pre-relaxed structures in the library.

### Diamond

FCC lattice with 8-atom basis, lattice constant 3.567 Å.

## File Format

### XYZ (Extended)

```
60
C60 Buckminsterfullerene | 60 atoms | PE=-403.8149 eV | Fmax=6.91e-04 eV/A | method=steepest_descent
C  0.00000000  0.70000000  3.39787138
C  3.39787138  0.00000000  0.70000000
...
```

Line 1: atom count. Line 2: comment with metadata. Lines 3+: element x y z.

### manifest.json

```json
{
  "c60": {
    "file": "c60.xyz",
    "n_atoms": 60,
    "energy_eV": -403.8149,
    "fmax_eV_A": 0.000691,
    "converged": true,
    "method": "steepest_descent",
    "description": "C60 Buckminsterfullerene"
  }
}
```

## Usage in Simulations

Library structures are the **only validated starting point** for dynamics and collision simulations. The geometry generators produce unrelaxed coordinates with residual forces 3,000–5,000x larger than library structures:

| Source | C60 Fmax (eV/Å) | C60 Energy (eV) |
|--------|----------------:|----------------:|
| `c60()` generator | 3.29 | -388.95 |
| `structures/library/c60.xyz` | 0.0007 | -403.81 |

For structures not in the library, relax with `simple_minimize()` or `minimize()` to Fmax < 10⁻³ eV/Å before use. See `scripts/scaling_research.py` for examples of loading library structures and relaxing larger ones on-the-fly.

## Adding New Structures

To add a new structure type to the CLI:

1. Add a generator function to `sim/structures/generate.py`
2. Add a `cmd_xxx` function and subparser in `scripts/library_cli.py`
3. Run `python3 scripts/library_cli.py xxx <args>`
4. Verify with `python3 scripts/library_cli.py list`
