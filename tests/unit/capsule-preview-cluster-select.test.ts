/**
 * Tests for the preview cluster-selection helper (ADR D138).
 *
 * Covers dominance-pass, guard-rejection (balanced + water-style),
 * tie-break, duplicate-atomId defence, zero-bond short-circuit,
 * mode override, bounds recompute, index remap, per-atom field
 * preservation, and the close-approach proximity-fusion contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  selectPreviewSubjectCluster,
  MIN_MEANINGFUL_CLUSTER_SIZE,
  DOMINANCE_BY_RATIO,
  DOMINANCE_BY_FRACTION,
  type PreviewBondPair,
} from '../../src/share/capsule-preview-cluster-select';
import type { CapsulePreviewScene3D, CapsulePreviewAtom3D } from '../../src/share/capsule-preview-frame';
import { deriveBondPairs } from '../../src/share/capsule-preview-project';
import { makeCloseApproachCapsule } from '../../src/share/__fixtures__/capsule-preview-structures';
import { buildPreviewSceneFromCapsule } from '../../src/share/capsule-preview-frame';
import * as cc from '../../src/history/connected-components';

function atom(
  atomId: number,
  x: number,
  y: number,
  z: number,
  element = 'C',
  colorHex = '#222222',
): CapsulePreviewAtom3D {
  return { atomId, element, x, y, z, colorHex };
}

function sceneFromAtoms(atoms: CapsulePreviewAtom3D[]): CapsulePreviewScene3D {
  if (atoms.length === 0) {
    return {
      atoms,
      frameId: 0,
      timePs: 0,
      bounds: { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0] },
    };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const a of atoms) {
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.z < minZ) minZ = a.z;
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
    if (a.z > maxZ) maxZ = a.z;
  }
  return {
    atoms,
    frameId: 0,
    timePs: 0,
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    },
  };
}

/** Build a chain as atoms indexed 0..n-1 with consecutive bond pairs. */
function chain(start: number, n: number, opts: { atomIdStart?: number; dy?: number; z?: number } = {}): {
  atoms: CapsulePreviewAtom3D[];
  bonds: PreviewBondPair[];
} {
  const atomIdStart = opts.atomIdStart ?? start;
  const atoms: CapsulePreviewAtom3D[] = [];
  for (let i = 0; i < n; i++) {
    atoms.push(atom(atomIdStart + i, i * 1.4, opts.dy ?? 0, opts.z ?? 0));
  }
  const bonds: PreviewBondPair[] = [];
  for (let i = 0; i < n - 1; i++) {
    bonds.push({ a: start + i, b: start + i + 1 });
  }
  return { atoms, bonds };
}

describe('selectPreviewSubjectCluster', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('picks the single dominant cluster when guard passes', () => {
    const big = chain(0, 10);
    const noise: CapsulePreviewAtom3D[] = [
      atom(100, 0, 10, 0),
      atom(101, 20, 10, 0),
      atom(102, 10, 20, 10),
    ];
    const atoms = [...big.atoms, ...noise];
    const scene = sceneFromAtoms(atoms);
    const res = selectPreviewSubjectCluster(scene, big.bonds, { mode: 'largest-bonded-cluster' });

    expect(res.diagnostics.fallbackReason).toBe('none');
    expect(res.diagnostics.fellBackToFullFrame).toBe(false);
    expect(res.diagnostics.selectedComponentSize).toBe(10);
    expect(res.scene.atoms.length).toBe(10);
    expect(res.bondPairs.length).toBe(9);
    // All bond endpoints must be within the new (remapped) range.
    for (const b of res.bondPairs) {
      expect(b.a).toBeGreaterThanOrEqual(0);
      expect(b.a).toBeLessThan(10);
      expect(b.b).toBeGreaterThanOrEqual(0);
      expect(b.b).toBeLessThan(10);
    }
  });

  it('falls back to full frame on equal-size fragments (dominance-failed)', () => {
    const a = chain(0, 10, { atomIdStart: 0 });
    const b = chain(10, 10, { atomIdStart: 100, dy: 100 });
    const scene = sceneFromAtoms([...a.atoms, ...b.atoms]);
    const bonds = [...a.bonds, ...b.bonds];
    const res = selectPreviewSubjectCluster(scene, bonds, { mode: 'largest-bonded-cluster' });
    expect(res.diagnostics.fallbackReason).toBe('dominance-failed');
    expect(res.diagnostics.fellBackToFullFrame).toBe(true);
    expect(res.scene.atoms.length).toBe(20);
    expect(res.bondPairs.length).toBe(bonds.length);
    expect(res.diagnostics.dominanceByRatio).toBeCloseTo(1.0, 6);
  });

  it('falls back to full frame on water-style fragmentation (8 size-3)', () => {
    // 8 components of size 3; ratio = 1.0, fraction = 3/24 = 0.125.
    const atoms: CapsulePreviewAtom3D[] = [];
    const bonds: PreviewBondPair[] = [];
    for (let i = 0; i < 8; i++) {
      const base = atoms.length;
      atoms.push(atom(atoms.length, i * 100, 0, 0));
      atoms.push(atom(atoms.length, i * 100 + 0.96, 0.5, 0));
      atoms.push(atom(atoms.length, i * 100 - 0.96, 0.5, 0));
      bonds.push({ a: base, b: base + 1 }, { a: base, b: base + 2 });
    }
    const scene = sceneFromAtoms(atoms);
    const res = selectPreviewSubjectCluster(scene, bonds, { mode: 'largest-bonded-cluster' });
    expect(res.diagnostics.fallbackReason).toBe('dominance-failed');
    expect(res.diagnostics.fellBackToFullFrame).toBe(true);
    expect(res.diagnostics.componentCount).toBe(8);
    expect(res.diagnostics.meaningfulComponentCount).toBe(8);
    expect(res.diagnostics.dominanceByFraction).toBeCloseTo(3 / 24, 6);
  });

  it('tie-breaks by minAtomId when dominance guard does not reject', () => {
    // Engineer: two components of size 4 — but we lower thresholds so
    // the dominance guard accepts despite equal sizes.
    const a = chain(0, 4, { atomIdStart: 50 });
    const b = chain(4, 4, { atomIdStart: 10, dy: 100 });
    const atoms = [...a.atoms, ...b.atoms];
    const scene = sceneFromAtoms(atoms);
    const res = selectPreviewSubjectCluster(scene, [...a.bonds, ...b.bonds], {
      mode: 'largest-bonded-cluster',
      dominanceByRatio: 1.0,   // allow ties
      dominanceByFraction: 0.5, // allow 50%
    });
    expect(res.diagnostics.fallbackReason).toBe('none');
    // Component b has minAtomId=10, a has 50 → b must be selected.
    expect(res.diagnostics.selectedMinAtomId).toBe(10);
    expect(res.scene.atoms.map((x) => x.atomId)).toEqual([10, 11, 12, 13]);
  });

  it('falls back to minSourceIndex when atomIds are duplicated', () => {
    // Two components of size 3, but atomId 99 appears in BOTH.
    const atoms: CapsulePreviewAtom3D[] = [
      atom(99, 0, 0, 0), atom(1, 1.4, 0, 0), atom(2, 2.8, 0, 0),
      atom(99, 0, 100, 0), atom(4, 1.4, 100, 0), atom(5, 2.8, 100, 0),
    ];
    const bonds: PreviewBondPair[] = [
      { a: 0, b: 1 }, { a: 1, b: 2 },
      { a: 3, b: 4 }, { a: 4, b: 5 },
    ];
    const scene = sceneFromAtoms(atoms);
    const warnSpy = vi.spyOn(console, 'warn');
    const res = selectPreviewSubjectCluster(scene, bonds, {
      mode: 'largest-bonded-cluster',
      dominanceByRatio: 1.0,
      dominanceByFraction: 0.5,
    });
    // First component (minSourceIndex=0) wins.
    expect(res.diagnostics.fallbackReason).toBe('none');
    expect(res.scene.atoms[0].atomId).toBe(99);
    expect(res.scene.atoms[1].atomId).toBe(1);
    expect(res.scene.atoms[2].atomId).toBe(2);
    // Warn must have been emitted once.
    expect(warnSpy).toHaveBeenCalled();
    const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('duplicate-atomIds'))).toBe(true);
  });

  it('short-circuits on zero bonds WITHOUT calling computeConnectedComponents', () => {
    const atoms = [atom(0, 0, 0, 0), atom(1, 10, 0, 0)];
    const scene = sceneFromAtoms(atoms);
    const spy = vi.spyOn(cc, 'computeConnectedComponents');
    const res = selectPreviewSubjectCluster(scene, [], { mode: 'largest-bonded-cluster' });
    expect(res.diagnostics.fallbackReason).toBe('no-bonds');
    expect(res.diagnostics.fellBackToFullFrame).toBe(true);
    expect(res.scene.atoms.length).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns full scene unchanged when mode is full-frame', () => {
    const big = chain(0, 10);
    const scene = sceneFromAtoms(big.atoms);
    const res = selectPreviewSubjectCluster(scene, big.bonds, { mode: 'full-frame' });
    expect(res.diagnostics.fallbackReason).toBe('mode-full-frame');
    expect(res.diagnostics.fellBackToFullFrame).toBe(true);
    expect(res.scene.atoms.length).toBe(10);
    expect(res.bondPairs.length).toBe(9);
  });

  it('recomputes bounds for the filtered atom set', () => {
    const big = chain(0, 10);
    const noise: CapsulePreviewAtom3D[] = [
      atom(100, 0, 100, 0),
      atom(101, 0, -100, 0),
    ];
    const atoms = [...big.atoms, ...noise];
    const scene = sceneFromAtoms(atoms);
    const res = selectPreviewSubjectCluster(scene, big.bonds, { mode: 'largest-bonded-cluster' });
    // New bounds should reflect only the chain: y=0 everywhere, x from 0 to 12.6.
    expect(res.scene.bounds.min[1]).toBe(0);
    expect(res.scene.bounds.max[1]).toBe(0);
    expect(res.scene.bounds.min[0]).toBe(0);
    expect(res.scene.bounds.max[0]).toBeCloseTo(9 * 1.4, 6);
    // Center should be ~ (6.3, 0, 0), not shifted by the noise atoms.
    expect(res.scene.bounds.center[1]).toBe(0);
  });

  it('remaps bond pairs to the filtered atom indices (not original indices)', () => {
    // Chain of 5 atoms (indices 0..4) + 2 isolated atoms at indices 5, 6.
    const c = chain(0, 5);
    const atoms = [...c.atoms, atom(200, 0, 100, 0), atom(201, 0, -100, 0)];
    const scene = sceneFromAtoms(atoms);
    const res = selectPreviewSubjectCluster(scene, c.bonds, { mode: 'largest-bonded-cluster' });
    expect(res.scene.atoms.length).toBe(5);
    // Bonds should point into [0..4], not the original mixed range.
    for (const b of res.bondPairs) {
      expect(b.a).toBeLessThan(5);
      expect(b.b).toBeLessThan(5);
    }
    // The chain kept its consecutive structure.
    expect(res.bondPairs).toEqual([
      { a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 4 },
    ]);
  });

  it('preserves per-atom fields (atomId, element, x, y, z, colorHex) byte-for-byte', () => {
    const src: CapsulePreviewAtom3D[] = [
      { atomId: 7, element: 'O', x: 0.1, y: 0.2, z: 0.3, colorHex: '#ff0d0d' },
      { atomId: 8, element: 'H', x: 1.5, y: 0.2, z: 0.3, colorHex: '#ffffff' },
      { atomId: 9, element: 'H', x: -1.5, y: 0.2, z: 0.3, colorHex: '#ffffff' },
      { atomId: 500, element: 'C', x: 1000, y: 1000, z: 1000, colorHex: '#222222' },
    ];
    const bonds: PreviewBondPair[] = [{ a: 0, b: 1 }, { a: 0, b: 2 }];
    const scene = sceneFromAtoms(src);
    const res = selectPreviewSubjectCluster(scene, bonds, { mode: 'largest-bonded-cluster' });
    expect(res.diagnostics.fallbackReason).toBe('none');
    expect(res.scene.atoms.length).toBe(3);
    // Each surviving atom should be byte-equal to the source record.
    expect(res.scene.atoms[0]).toEqual(src[0]);
    expect(res.scene.atoms[1]).toEqual(src[1]);
    expect(res.scene.atoms[2]).toEqual(src[2]);
  });

  it('locks in close-approach proximity-fusion behavior at two cutoffs', () => {
    const capsule = makeCloseApproachCapsule();
    const scene3D = buildPreviewSceneFromCapsule(capsule);

    // Run 1: default cutoff (1.85 Å). The 1.80 Å inter-fragment pair
    // fuses both fragments into one 6-atom cluster.
    const bonds1 = deriveBondPairs(scene3D, 1.85, 0.5);
    expect(bonds1.length).toBe(5); // 2 intra-A + 2 intra-B + 1 inter
    const r1 = selectPreviewSubjectCluster(scene3D, bonds1, { mode: 'largest-bonded-cluster' });
    expect(r1.diagnostics.componentCount).toBe(1);
    expect(r1.diagnostics.meaningfulComponentCount).toBe(1);
    expect(r1.diagnostics.selectedComponentSize).toBe(6);
    expect(r1.diagnostics.selectedAtomCount).toBe(6);
    expect(r1.diagnostics.fallbackReason).toBe('none');
    expect(r1.diagnostics.fellBackToFullFrame).toBe(false);

    // Run 2: tightened cutoff (1.60 Å). The 1.80 Å inter-fragment pair
    // drops → 2 size-3 components → dominance guard fails.
    const bonds2 = deriveBondPairs(scene3D, 1.60, 0.5);
    expect(bonds2.length).toBe(4);
    const r2 = selectPreviewSubjectCluster(scene3D, bonds2, { mode: 'largest-bonded-cluster' });
    expect(r2.diagnostics.componentCount).toBe(2);
    expect(r2.diagnostics.meaningfulComponentCount).toBe(2);
    expect(r2.diagnostics.selectedComponentSize).toBe(null);
    expect(r2.diagnostics.selectedAtomCount).toBe(6);
    expect(r2.diagnostics.fallbackReason).toBe('dominance-failed');
    expect(r2.diagnostics.fellBackToFullFrame).toBe(true);
  });

  it('exposes policy constants at their documented default values', () => {
    expect(MIN_MEANINGFUL_CLUSTER_SIZE).toBe(2);
    expect(DOMINANCE_BY_RATIO).toBe(2.0);
    expect(DOMINANCE_BY_FRACTION).toBe(0.6);
  });
});
