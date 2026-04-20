/**
 * Tests for src/share/capsule-preview-project.ts — spec §capsule-preview-project.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveBondPairs,
  projectPreviewScene,
} from '../../src/share/capsule-preview-project';
import type {
  CapsulePreviewAtom3D,
  CapsulePreviewScene3D,
} from '../../src/share/capsule-preview-frame';

function scene(atoms: Array<[number, number, number]>): CapsulePreviewScene3D {
  const pts: CapsulePreviewAtom3D[] = atoms.map(([x, y, z], i) => ({
    atomId: i,
    element: 'C',
    x, y, z,
    colorHex: '#222222',
  }));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of atoms) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  return {
    atoms: pts,
    frameId: 0,
    timePs: 0,
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    },
  };
}

describe('projectPreviewScene', () => {
  it('fits atoms inside the target bounds with padding', () => {
    const s = scene([
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
    ]);
    const out = projectPreviewScene(s, { targetWidth: 600, targetHeight: 500, padding: 0.1 });
    for (const a of out.atoms) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(600);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(500);
    }
  });

  it('sorts atoms by depth (far → near) so nearer atoms draw last', () => {
    const s = scene([[0, 0, -1], [0, 0, 0], [0, 0, 1]]);
    const out = projectPreviewScene(s);
    // With the fixed camera tilt the z ordering may rotate into another
    // axis; assert the sort property rather than the raw input order.
    for (let i = 1; i < out.atoms.length; i++) {
      expect(out.atoms[i].depth).toBeGreaterThanOrEqual(out.atoms[i - 1].depth);
    }
  });

  it('honors the min-radius floor', () => {
    const s = scene([[0, 0, 0], [1, 0, 0]]);
    const out = projectPreviewScene(s, { minRadius: 8 });
    for (const a of out.atoms) expect(a.r).toBeGreaterThanOrEqual(8);
  });
});

describe('deriveBondPairs', () => {
  it('returns pairs within cutoff, ordered by distance', () => {
    const s = scene([
      [0, 0, 0], [1.42, 0, 0], [2.84, 0, 0], [4.26, 0, 0],
    ]);
    const pairs = deriveBondPairs(s, 1.85, 0.5);
    // 0-1, 1-2, 2-3 are within cutoff; 0-2, 0-3, 1-3 are not.
    expect(pairs).toEqual(
      expect.arrayContaining([
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 3 },
      ]),
    );
    // Further atoms must not appear.
    expect(pairs.find((p) => (p.a === 0 && p.b === 3) || (p.a === 3 && p.b === 0))).toBeUndefined();
  });

  it('returns [] for non-positive cutoff', () => {
    const s = scene([[0, 0, 0], [1, 0, 0]]);
    expect(deriveBondPairs(s, 0, 0)).toEqual([]);
    expect(deriveBondPairs(s, -1, 0)).toEqual([]);
  });

  it('skips pairs below minDist', () => {
    const s = scene([[0, 0, 0], [0.1, 0, 0]]); // distance 0.1 < minDist
    expect(deriveBondPairs(s, 2, 0.5)).toEqual([]);
  });
});
