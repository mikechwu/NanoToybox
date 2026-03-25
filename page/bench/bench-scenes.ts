/**
 * Benchmark scene generator.
 * Builds scenes from real library structures at exact template multiples.
 */
import { loadStructure } from '../js/loader';

// From page/bench/, library is at ../../structures/library
const BENCH_LIBRARY_PATH = '../../structures/library';
const _cache = {};

/**
 * Compute bounding radius of an atom set around its COM.
 */
function boundingRadius(atoms) {
  let cx = 0, cy = 0, cz = 0;
  for (const a of atoms) { cx += a.x; cy += a.y; cz += a.z; }
  cx /= atoms.length; cy /= atoms.length; cz /= atoms.length;
  let maxR = 0;
  for (const a of atoms) {
    const d = Math.sqrt((a.x-cx)**2 + (a.y-cy)**2 + (a.z-cz)**2);
    if (d > maxR) maxR = d;
  }
  return { cx, cy, cz, radius: maxR };
}

/**
 * Compute a 3D grid offset for replica index c within a fixed grid.
 * gridSize is computed once from total copies, ensuring no overlaps
 * within a single buildScene() call (gridSize³ >= copies).
 */
function gridOffset(c, spacing, gridSize) {
  const ix = c % gridSize;
  const iy = Math.floor(c / gridSize) % gridSize;
  const iz = Math.floor(c / (gridSize * gridSize));
  return [ix * spacing, iy * spacing, iz * spacing];
}

const SCENE_DEFS = {
  compact:  { template: 'c60.xyz', spacing: 'tangent+1A' },
  sparse:   { template: 'c60.xyz', spacing: '10x_radius' },
  sheet:    { template: 'graphene_6x6.xyz', spacing: 'tangent+1A' },
  c720:     { template: 'c720.xyz', spacing: 'tangent+1A' },
  diamond:  { template: 'diamond_2x2x2.xyz', spacing: 'tangent+1A' },
  c720_single: { template: 'c720.xyz', spacing: '10x_radius' },
};

/**
 * Build a benchmark scene at the given target atom count.
 * Returns exact template multiples — no partial molecules.
 * @param {number} targetAtoms - requested atom count (actual may differ)
 * @param {string} variant - 'compact' | 'sparse' | 'sheet'
 * @returns {Promise<{atoms: Array, bonds: Array, actualAtoms: number, templateSize: number, copies: number, variant: string}>}
 */
export async function buildScene(targetAtoms, variant = 'compact') {
  const def = SCENE_DEFS[variant];
  if (!def) throw new Error(`Unknown variant: ${variant}`);

  const key = def.template;
  if (!_cache[key]) {
    _cache[key] = await loadStructure(key, BENCH_LIBRARY_PATH);
  }
  const template = _cache[key];
  const tAtoms = template.atoms;
  const tBonds = template.bonds;
  const tSize = tAtoms.length;

  const copies = Math.max(1, Math.ceil(targetAtoms / tSize));
  const { radius } = boundingRadius(tAtoms);

  // Compute spacing between replica centers
  let spacingDist;
  if (def.spacing === 'tangent+1A') {
    spacingDist = 2 * radius + 1.0; // surface gap ~1Å, inside Tersoff cutoff
  } else if (def.spacing === '10x_radius') {
    spacingDist = 10 * radius; // minimal cross-interaction
  } else {
    spacingDist = 2 * radius + 3.0;
  }

  const gridSize = Math.ceil(Math.cbrt(copies));
  const allAtoms = [];
  const allBonds = [];

  for (let c = 0; c < copies; c++) {
    const [ox, oy, oz] = gridOffset(c, spacingDist, gridSize);
    const offset = allAtoms.length;
    for (const a of tAtoms) {
      allAtoms.push({ x: a.x + ox, y: a.y + oy, z: a.z + oz });
    }
    for (const [i, j, d] of tBonds) {
      allBonds.push([i + offset, j + offset, d]);
    }
  }

  return {
    atoms: allAtoms,
    bonds: allBonds,
    actualAtoms: allAtoms.length,
    templateSize: tSize,
    copies,
    variant,
  };
}

/** Standard C60 sweep points (exact multiples of 60). */
export const C60_SWEEP = [60, 120, 240, 480, 720, 1020, 1560, 2040, 2520, 3060, 4020];

/** Sparse C60 sweep (subset for sparse variant). */
export const SPARSE_SWEEP = [240, 480, 1020, 2040, 3060];

/** Renderer sweep (extends further, includes 5040). */
export const RENDER_SWEEP = [60, 120, 240, 480, 720, 1020, 2040, 3000, 4020, 5040];

/** Graphene 6x6 sweep points (exact multiples of 72). */
export const GRAPHENE_SWEEP = [72, 216, 504, 1008, 1512, 2016, 2520];

/** C720 sweep points (exact multiples of 720). Single large fullerene. */
export const C720_SWEEP = [720, 1440, 2160, 2880, 3600];

/** Diamond 2x2x2 sweep points (exact multiples of 64). High bond density, sp3 topology. */
export const DIAMOND_SWEEP = [64, 192, 448, 896, 1344, 1792, 2560];
