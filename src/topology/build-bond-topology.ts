/**
 * Shared bond-topology builders — naive (loader) and accelerated (physics).
 *
 * Pure module: depends only on src/types/interfaces (BondTuple) and ./bond-rules.
 * No lab/, watch/, or CONFIG dependencies.
 *
 * Owns:        buildBondTopologyFromAtoms, buildBondTopologyAccelerated,
 *              BondTopologyWorkspace, createBondTopologyWorkspace
 * Depends on:  BondTuple from src/types/interfaces, BondRuleSet from ./bond-rules
 */

import type { BondTuple } from '../types/interfaces';
import type { BondRuleSet } from './bond-rules';

// ── Naive builder (loader path) ──

/** Naive O(n²) pair-scan. Returns a fresh array. Used by loader.ts for
 *  one-time structure loading — not hot-path.
 *  Genuinely pair-aware: uses rules.maxPairDistance(elementA, elementB) per
 *  pair, so future heterogeneous bond rules work correctly on the loader path
 *  without further changes. Current carbon-only rules return the global cutoff
 *  for every pair, so this matches the old behavior exactly. */
export function buildBondTopologyFromAtoms(
  atoms: readonly { element: string; x: number; y: number; z: number }[],
  rules: BondRuleSet,
): BondTuple[] {
  const bonds: BondTuple[] = [];
  const n = atoms.length;
  const minDist2 = rules.minDist2;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = atoms[j].x - atoms[i].x;
      const dy = atoms[j].y - atoms[i].y;
      const dz = atoms[j].z - atoms[i].z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const pairCutoff = rules.maxPairDistance(atoms[i].element, atoms[j].element);
      const pairCutoff2 = pairCutoff * pairCutoff;
      if (d2 < pairCutoff2 && d2 > minDist2) {
        bonds.push([i, j, Math.sqrt(d2)]);
      }
    }
  }
  return bonds;
}

// ── Spatial hash helpers ──
// NOTE: hashCell + buildSpatialHash are structurally similar to
// PhysicsEngine._buildCellGrid() in lab/js/physics.ts. That method serves the
// neighbor-list path. A future round should extract a shared low-level spatial-hash
// helper to eliminate the near-duplication. For this round, the two evolve
// independently — the bond path uses the workspace here, the neighbor-list path
// uses the engine's _hashBuffers.

function hashCell(cx: number, cy: number, cz: number, tableSize: number): number {
  return (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) & 0x7FFFFFFF) % tableSize;
}

// ── Workspace ──

/** Reusable buffers for the accelerated builder's spatial hash. Grow-only:
 *  buffers expand when n exceeds current capacity but never shrink. */
export interface BondTopologyWorkspace {
  _tableSize: number;
  _counts: Int32Array;
  _offsets: Int32Array;
  _running: Int32Array;
  _atoms: Int32Array;
  _cells: Int32Array;
}

export function createBondTopologyWorkspace(initialMaxAtoms: number): BondTopologyWorkspace {
  const n = Math.max(initialMaxAtoms, 1);
  const tableSize = Math.max(n * 2, 64);
  return {
    _tableSize: tableSize,
    _counts: new Int32Array(tableSize),
    _offsets: new Int32Array(tableSize),
    _running: new Int32Array(tableSize),
    _atoms: new Int32Array(Math.max(n, 64)),
    _cells: new Int32Array(Math.max(n * 3, 192)),
  };
}

function ensureWorkspaceCapacity(ws: BondTopologyWorkspace, n: number): void {
  const tableSize = Math.max(n * 2, 64);
  if (tableSize > ws._tableSize) {
    ws._tableSize = tableSize;
    ws._counts = new Int32Array(tableSize);
    ws._offsets = new Int32Array(tableSize);
    ws._running = new Int32Array(tableSize);
  }
  if (n > ws._atoms.length) {
    ws._atoms = new Int32Array(Math.max(n, 64));
    ws._cells = new Int32Array(Math.max(n * 3, 192));
  }
}

/** Build the spatial hash grid. Returns null if n === 0. */
function buildSpatialHash(
  n: number,
  positions: Float64Array,
  cellSide: number,
  ws: BondTopologyWorkspace,
): { counts: Int32Array; offsets: Int32Array; atoms: Int32Array; cells: Int32Array; tableSize: number } | null {
  if (n === 0) return null;

  ensureWorkspaceCapacity(ws, n);
  const { _counts: counts, _offsets: offsets, _running: running, _atoms: atoms, _cells: cells, _tableSize: tableSize } = ws;

  // Pass 1: cell coords + per-bucket count
  counts.fill(0, 0, tableSize);
  const invCS = 1.0 / cellSide;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const cx = Math.floor(positions[i3] * invCS);
    const cy = Math.floor(positions[i3 + 1] * invCS);
    const cz = Math.floor(positions[i3 + 2] * invCS);
    cells[i3] = cx; cells[i3 + 1] = cy; cells[i3 + 2] = cz;
    counts[hashCell(cx, cy, cz, tableSize)]++;
  }

  // Pass 2: prefix sum → offsets
  offsets[0] = 0;
  for (let h = 1; h < tableSize; h++) {
    offsets[h] = offsets[h - 1] + counts[h - 1];
  }

  // Pass 3: scatter atoms into sorted order
  running.fill(0, 0, tableSize);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const h = hashCell(cells[i3], cells[i3 + 1], cells[i3 + 2], tableSize);
    atoms[offsets[h] + running[h]] = i;
    running[h]++;
  }

  return { counts, offsets, atoms, cells, tableSize };
}

// ── Accelerated builder (physics path) ──

/** Spatial-hash accelerated bond topology. Writes into caller-owned outBonds
 *  with in-place reuse. Returns the logical bond count; caller trims
 *  outBonds.length = count.
 *
 *  Global-rule-only in this round: `elements` must be `null`. Element-aware
 *  support requires engine-owned per-atom element data that does not exist yet.
 *  Type narrowing rejects non-null at compile time; the runtime guard catches
 *  JS callers and any-typed paths. */
export function buildBondTopologyAccelerated(
  n: number,
  positions: Float64Array,
  elements: null,
  rules: BondRuleSet,
  workspace: BondTopologyWorkspace,
  outBonds: BondTuple[],
): number {
  if (elements !== null) {
    throw new Error(
      'Element-aware accelerated bond topology is not implemented yet. ' +
      'Pass elements = null to use the global-rule fast path.',
    );
  }
  if (n === 0) return 0;

  const bondCutoff2 = rules.globalMaxDist2;
  const minDist2 = rules.minDist2;
  const cellSide = rules.globalMaxDist;

  const hash = buildSpatialHash(n, positions, cellSide, workspace);
  if (!hash) return 0;
  const { counts: hCounts, offsets, atoms: hAtoms, cells, tableSize } = hash;

  let count = 0;
  const p = positions;

  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const px = p[i3], py = p[i3 + 1], pz = p[i3 + 2];
    const cx = cells[i3], cy = cells[i3 + 1], cz = cells[i3 + 2];

    for (let ddz = -1; ddz <= 1; ddz++) {
      const ncz = cz + ddz;
      for (let ddy = -1; ddy <= 1; ddy++) {
        const ncy = cy + ddy;
        for (let ddx = -1; ddx <= 1; ddx++) {
          const ncx = cx + ddx;
          const h = hashCell(ncx, ncy, ncz, tableSize);
          const start = offsets[h];
          const end = start + hCounts[h];
          for (let k = start; k < end; k++) {
            const j = hAtoms[k];
            if (cells[j * 3] !== ncx || cells[j * 3 + 1] !== ncy || cells[j * 3 + 2] !== ncz) continue;
            if (j <= i) continue;
            const j3 = j * 3;
            const dx = p[j3] - px, dy = p[j3 + 1] - py, dz = p[j3 + 2] - pz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bondCutoff2 && d2 > minDist2) {
              const d = Math.sqrt(d2);
              if (count < outBonds.length) {
                outBonds[count][0] = i;
                outBonds[count][1] = j;
                outBonds[count][2] = d;
              } else {
                outBonds.push([i, j, d]);
              }
              count++;
            }
          }
        }
      }
    }
  }
  return count;
}
