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
import {
  makeC60Capsule,
  makeGrapheneCapsule,
  makeCntCapsule,
  makeFragmentedCapsule,
  makeTwoEqualFragmentsCapsule,
} from '../../src/share/__fixtures__/capsule-preview-structures';

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
    // Caps raised to 5000 in the D138 follow-up 4 (effectively
    // unbounded for realistic capsules).
    expect(thumb!.atoms.length).toBeLessThanOrEqual(5000);
    expect(thumb!.bonds!.length).toBeLessThanOrEqual(5000);
    // Atoms are finite. They MAY land slightly outside the 0..1
    // cell under two policies that both entered the pipeline in the
    // D138 follow-up series:
    //   - fill-shorter refit with overflow-crop (banded subjects)
    //   - pinhole perspective bake (even for spheres, the near-face
    //     atoms can land a few % past the cell; the outer <svg>
    //     crops at viewBox).
    // Use a loose bound that catches "atoms flew to infinity"
    // without falsely rejecting legitimate overflow.
    for (const a of thumb!.atoms) {
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.y)).toBe(true);
      expect(a.x).toBeGreaterThan(-1);
      expect(a.x).toBeLessThan(3);
      expect(a.y).toBeGreaterThan(-1);
      expect(a.y).toBeLessThan(3);
    }
  });

  it('guard passes → poster-scene atom count is strictly less than full-frame', () => {
    // Fragmented fixture: 10-atom chain + 3 noise atoms. Cluster
    // selection keeps only the chain, so the projected poster scene
    // represents 10 atoms (minus any downsampling below the 32 cap).
    const capsule = makeFragmentedCapsule();
    const fullAtomCount = capsule.atoms.atoms.length;
    const sceneJson = projectCapsuleToSceneJson(capsule)!;
    const scene = JSON.parse(sceneJson);
    expect(scene.atoms.length).toBeLessThan(fullAtomCount);
    expect(scene.atoms.length).toBe(10);
  });

  it('guard fails → poster-scene atom count equals full-frame', () => {
    // Balanced fixture: two 5-atom fragments. Guard rejects, full
    // frame survives.
    const capsule = makeTwoEqualFragmentsCapsule();
    const fullAtomCount = capsule.atoms.atoms.length;
    const sceneJson = projectCapsuleToSceneJson(capsule)!;
    const scene = JSON.parse(sceneJson);
    expect(scene.atoms.length).toBe(fullAtomCount);
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
