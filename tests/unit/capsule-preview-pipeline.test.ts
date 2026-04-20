/**
 * Pipeline-path tests — run real dense-structure fixtures through the
 * entire publish pipeline (buildPreviewSceneFromCapsule → publish-time
 * projection/thumb-bake → derivePreviewThumbV1) and assert the thumb
 * payload reaches the account client with visible bonds.
 *
 * These are outcome-oriented tests: the synthetic `capsule-preview-dense-
 * outcomes.test.ts` suite bypasses `buildPreviewSceneFromCapsule` and
 * `deriveCanonicalPreviewCamera`, so it cannot catch regressions in
 * those upstream stages. This file closes that gap.
 */

import { describe, it, expect } from 'vitest';
import {
  projectCapsuleToSceneJson,
} from '../../src/share/publish-core';
import {
  derivePreviewThumbV1,
  CURRENT_THUMB_REV,
} from '../../src/share/capsule-preview-scene-store';
import type {
  AtomDojoPlaybackCapsuleFileV1,
} from '../../src/history/history-file-v1';

/** Build a C60 fullerene capsule (60-atom truncated icosahedron) from
 *  an approximate icosphere placement. Bonds included as nearest-
 *  neighbor pairs, mirroring what the publish pipeline computes from
 *  `bondPolicy = default-carbon-v1`. */
function makeC60Capsule(): AtomDojoPlaybackCapsuleFileV1 {
  // Sphere parameters chosen so nearest-neighbor distances fall near
  // the 1.45 Å target of real C60.
  const N = 60;
  const R = 3.5;
  const atoms = [];
  const positions: number[] = [];
  for (let i = 0; i < N; i++) {
    const phi = Math.acos(1 - 2 * (i + 0.5) / N);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const x = R * Math.sin(phi) * Math.cos(theta);
    const y = R * Math.sin(phi) * Math.sin(theta);
    const z = R * Math.cos(phi);
    atoms.push({ id: i, element: 'C' });
    positions.push(x, y, z);
  }
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-19T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: N,
      durationPs: 0,
      frameCount: 1,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.85, minDist: 0.5 },
    timeline: {
      denseFrames: [
        {
          frameId: 0,
          timePs: 0,
          n: N,
          atomIds: Array.from({ length: N }, (_, i) => i),
          positions,
        },
      ],
    },
  };
}

/** Build a graphene-like flat sheet. */
function makeGrapheneCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const rows = 5;
  const cols = 7;
  const dx = 1.42;
  const dy = 1.42 * Math.sqrt(3) / 2;
  const atoms = [];
  const positions: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const offset = r % 2 === 0 ? 0 : dx / 2;
      atoms.push({ id: atoms.length, element: 'C' });
      positions.push(c * dx + offset, r * dy, 0);
    }
  }
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-19T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: atoms.length,
      durationPs: 0,
      frameCount: 1,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.85, minDist: 0.5 },
    timeline: {
      denseFrames: [
        {
          frameId: 0,
          timePs: 0,
          n: atoms.length,
          atomIds: atoms.map((_, i) => i),
          positions,
        },
      ],
    },
  };
}

/** Build a CNT-like tubular structure. */
function makeCntCapsule(): AtomDojoPlaybackCapsuleFileV1 {
  const rings = 6;
  const perRing = 8;
  const R = 2.0;
  const atoms = [];
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < perRing; k++) {
      const theta = (k / perRing) * Math.PI * 2 + (r % 2) * (Math.PI / perRing);
      atoms.push({ id: atoms.length, element: 'C' });
      positions.push(R * Math.cos(theta), R * Math.sin(theta), r * 1.42);
    }
  }
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-19T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: atoms.length,
      durationPs: 0,
      frameCount: 1,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.85, minDist: 0.5 },
    timeline: {
      denseFrames: [
        {
          frameId: 0,
          timePs: 0,
          n: atoms.length,
          atomIds: atoms.map((_, i) => i),
          positions,
        },
      ],
    },
  };
}

describe('full publish → thumb derivation pipeline for dense structures', () => {
  const fixtures: Array<{ name: string; capsule: AtomDojoPlaybackCapsuleFileV1 }> = [
    { name: 'C60 fullerene', capsule: makeC60Capsule() },
    { name: 'graphene sheet', capsule: makeGrapheneCapsule() },
    { name: 'CNT', capsule: makeCntCapsule() },
  ];

  it('every dense fixture gets a pre-baked thumb at the current rev', () => {
    for (const fx of fixtures) {
      const sceneJson = projectCapsuleToSceneJson(fx.capsule);
      expect(sceneJson, `projection failed for ${fx.name}`).not.toBeNull();
      const scene = JSON.parse(sceneJson!);
      expect(scene.thumb, `no stored thumb for ${fx.name}`).toBeDefined();
      expect(scene.thumb.rev).toBe(CURRENT_THUMB_REV);
    }
  });

  it('derived thumbs for dense fixtures carry bonds with visible segments', () => {
    for (const fx of fixtures) {
      const sceneJson = projectCapsuleToSceneJson(fx.capsule);
      expect(sceneJson).not.toBeNull();
      const thumb = derivePreviewThumbV1(sceneJson!);
      expect(thumb, `thumb derivation failed for ${fx.name}`).not.toBeNull();
      expect(thumb!.bonds, `${fx.name}: no bonds rendered`).toBeDefined();
      expect(thumb!.bonds!.length).toBeGreaterThanOrEqual(2);

      const atomRadius = 2.8;
      let anyVisible = 0;
      for (const b of thumb!.bonds!) {
        const pa = thumb!.atoms[b.a];
        const pb = thumb!.atoms[b.b];
        const len = Math.hypot((pb.x - pa.x) * 100, (pb.y - pa.y) * 100);
        const visible = len - 2 * atomRadius;
        if (visible >= 2) anyVisible++;
      }
      expect(anyVisible).toBeGreaterThanOrEqual(2);
    }
  });

  it('stored thumb survives parse → derivePreviewThumbV1 round trip', () => {
    const sceneJson = projectCapsuleToSceneJson(makeC60Capsule())!;
    const thumb = derivePreviewThumbV1(sceneJson);
    expect(thumb!.atoms.length).toBeLessThanOrEqual(12);
    expect(thumb!.bonds!.length).toBeLessThanOrEqual(6);
    // All atoms are inside the 0..1 refit box.
    for (const a of thumb!.atoms) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(1);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(1);
    }
  });

  it('different dense fixtures produce different thumb geometry', () => {
    const signatures = fixtures.map((fx) => {
      const sceneJson = projectCapsuleToSceneJson(fx.capsule);
      const thumb = derivePreviewThumbV1(sceneJson!);
      return thumb!.atoms.map((a) => `${a.x.toFixed(2)},${a.y.toFixed(2)}`).join('|');
    });
    expect(new Set(signatures).size).toBe(fixtures.length);
  });
});
