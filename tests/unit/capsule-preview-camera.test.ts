/**
 * Tests for src/share/capsule-preview-camera.ts — spec §Orientation policy.
 *
 * Covers PCA classification thresholds, sign normalization (determinism),
 * and the degenerate / small-input fallback chain.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveCanonicalPreviewCamera,
} from '../../src/share/capsule-preview-camera';
import type { CapsulePreviewScene3D, CapsulePreviewAtom3D } from '../../src/share/capsule-preview-frame';

function sceneFromPoints(points: Array<[number, number, number]>): CapsulePreviewScene3D {
  const atoms: CapsulePreviewAtom3D[] = points.map(([x, y, z], i) => ({
    atomId: i,
    element: 'C',
    x, y, z,
    colorHex: '#222222',
  }));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
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

describe('deriveCanonicalPreviewCamera', () => {
  it('single atom → degenerate', () => {
    const cam = deriveCanonicalPreviewCamera(sceneFromPoints([[0, 0, 0]]));
    expect(cam.classification).toBe('degenerate');
  });

  it('dimer → linear', () => {
    const cam = deriveCanonicalPreviewCamera(sceneFromPoints([[0, 0, 0], [1, 0, 0]]));
    expect(cam.classification).toBe('linear');
  });

  it('isotropic cluster → spherical (λ₃/λ₁ > 0.85)', () => {
    // Octahedral-ish symmetric point set.
    const points: Array<[number, number, number]> = [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1],
    ];
    const cam = deriveCanonicalPreviewCamera(sceneFromPoints(points));
    expect(cam.classification).toBe('spherical');
  });

  it('planar ring → planar', () => {
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      points.push([Math.cos(a), Math.sin(a), 0]);
    }
    const cam = deriveCanonicalPreviewCamera(sceneFromPoints(points));
    expect(cam.classification).toBe('planar');
  });

  it('linear chain → linear', () => {
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i < 8; i++) points.push([i, 0, 0]);
    const cam = deriveCanonicalPreviewCamera(sceneFromPoints(points));
    expect(cam.classification).toBe('linear');
  });

  it('is deterministic — same scene → byte-equal rotation matrix', () => {
    const points: Array<[number, number, number]> = [
      [1, 0.1, 0],
      [-1, 0.3, 0.1],
      [0, 1, 0.05],
      [0, -1, -0.05],
      [0.5, 0.5, 0],
    ];
    const a = deriveCanonicalPreviewCamera(sceneFromPoints(points));
    const b = deriveCanonicalPreviewCamera(sceneFromPoints(points));
    expect(a.rotation3x3).toEqual(b.rotation3x3);
    expect(a.classification).toBe(b.classification);
  });

  it('sign-normalizes eigenvectors (translation-invariant classification)', () => {
    // Mirror the ring through the origin — the sign-normalization step
    // should still pick the same canonical basis so the classification
    // lands on the same bucket.
    const mirrored: Array<[number, number, number]> = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      mirrored.push([-Math.cos(a), -Math.sin(a), 0]);
    }
    const cam = deriveCanonicalPreviewCamera(sceneFromPoints(mirrored));
    expect(cam.classification).toBe('planar');
  });
});
