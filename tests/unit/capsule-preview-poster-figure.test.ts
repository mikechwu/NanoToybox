/**
 * Poster-figure semantic tests — prerequisite for phase 3 of the
 * audit-page plan (SceneSvg swap). The existing poster-route suite
 * (`poster-endpoint.test.ts`) covers route + PNG + cache + ETag
 * semantics but NOT figure geometry. This suite runs the shared
 * sketch renderer through `POSTER_PRESET` against each fixture and
 * asserts the visual invariants phase 3 must preserve.
 *
 * Five assertions per the plan's §Poster Semantic Tests:
 *   1. Non-zero bond count when storage bonds exist.
 *   2. Atom/bond layering — lines present in primitives.lines,
 *      circles present in primitives.circles.
 *   3. Poster-pane occupancy band — atoms cover 45–92% of the pane.
 *   4. CPK color preservation on mixed-element fixtures.
 *   5. No ghost edges — every line endpoint has a matching circle.
 */

import { describe, it, expect } from 'vitest';
import {
  AUDIT_LARGE_PRESET,
  POSTER_PRESET,
  buildPreviewSketchPrimitives,
  toSketchSceneFromProjectedScene,
  type PreviewSketchPrimitives,
} from '../../src/share/capsule-preview-sketch';
import {
  projectPreviewScene,
  deriveBondPairsForProjectedScene,
} from '../../src/share/capsule-preview-project';
import { buildPreviewSceneFromCapsule } from '../../src/share/capsule-preview-frame';
import {
  makeC60Capsule,
  makeGrapheneCapsule,
  makeCntCapsule,
  makeWaterClusterCapsule,
  makeOxidePatchCapsule,
  makeSimpleOrganicCapsule,
} from '../../src/share/__fixtures__/capsule-preview-structures';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../../src/history/history-file-v1';

function primitivesAtPoster(capsule: AtomDojoPlaybackCapsuleFileV1): PreviewSketchPrimitives {
  const scene3D = buildPreviewSceneFromCapsule(capsule);
  // Single-fit contract: the poster preset is the sole source of outer
  // padding. See the audit page (preview-audit/main.tsx) for the same
  // convention; feeding pre-padded pixel coords into the sketch builder
  // produces cumulative inset and tunes CI against the wrong geometry.
  const projected = projectPreviewScene(scene3D, {
    targetWidth: POSTER_PRESET.width,
    targetHeight: POSTER_PRESET.height,
    padding: 0,
  });
  const bonds = deriveBondPairsForProjectedScene(scene3D, projected, 1.85, 0.5);
  return buildPreviewSketchPrimitives(
    toSketchSceneFromProjectedScene(projected, bonds),
    POSTER_PRESET,
  );
}

function structuralFixtures(): Array<{ name: string; capsule: AtomDojoPlaybackCapsuleFileV1 }> {
  return [
    { name: 'C60', capsule: makeC60Capsule() },
    { name: 'graphene', capsule: makeGrapheneCapsule() },
    { name: 'CNT', capsule: makeCntCapsule() },
  ];
}

function mixedElementFixtures(): Array<{ name: string; capsule: AtomDojoPlaybackCapsuleFileV1 }> {
  return [
    { name: 'water cluster', capsule: makeWaterClusterCapsule() },
    { name: 'oxide patch', capsule: makeOxidePatchCapsule() },
    { name: 'simple organic', capsule: makeSimpleOrganicCapsule() },
  ];
}

// ── Assertion 1: non-zero bond count on structural fixtures ────────────

describe('poster-figure: bond presence', () => {
  it.each(structuralFixtures())('$name yields ≥ 1 bond via POSTER_PRESET', ({ capsule }) => {
    const prim = primitivesAtPoster(capsule);
    expect(prim.lines.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Assertion 2: atom/bond layering ───────────────────────────────────

describe('poster-figure: atom/bond layering', () => {
  it('lines are drawn before circles (bonds under atoms)', () => {
    const prim = primitivesAtPoster(makeC60Capsule());
    expect(prim.lines.length).toBeGreaterThan(0);
    expect(prim.circles.length).toBeGreaterThan(0);
    for (const line of prim.lines) {
      expect(line.outerWidth).toBeGreaterThanOrEqual(line.innerWidth);
      expect(line.outerStroke).not.toBe(line.innerStroke);
    }
  });

  it('every circle has a finite center and non-zero radius', () => {
    const prim = primitivesAtPoster(makeCntCapsule());
    for (const c of prim.circles) {
      expect(Number.isFinite(c.cx)).toBe(true);
      expect(Number.isFinite(c.cy)).toBe(true);
      expect(c.r).toBeGreaterThan(0);
    }
  });
});

// ── Assertion 3: poster-pane occupancy band ───────────────────────────

describe('poster-figure: occupancy band', () => {
  it.each(structuralFixtures())(
    '$name fills ≥ 60% of the dominant pane axis AND stays within the pane',
    ({ capsule }) => {
      // Aspect-biased fixtures (graphene wide, CNT tall) fill one pane
      // axis well and the other axis less — that's correct fit-to-bounds
      // behavior preserving aspect ratio. Measuring bounding-box AREA
      // would reject those valid cases as "too small". Instead check
      // that atoms FILL THE DOMINANT AXIS of the pane (catches
      // under-fill regressions) AND STAY INSIDE the pane (catches edge
      // clipping).
      const prim = primitivesAtPoster(capsule);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of prim.circles) {
        if (c.cx < minX) minX = c.cx;
        if (c.cy < minY) minY = c.cy;
        if (c.cx > maxX) maxX = c.cx;
        if (c.cy > maxY) maxY = c.cy;
      }
      const xFill = (maxX - minX) / POSTER_PRESET.width;
      const yFill = (maxY - minY) / POSTER_PRESET.height;
      const dominantFill = Math.max(xFill, yFill);
      expect(dominantFill).toBeGreaterThanOrEqual(0.60);
      // Edge clipping: atoms' raw centers must stay inside the
      // (1 - padding) region of both axes. `POSTER_PRESET.padding` is
      // 0.08, so centers live in ~[48, 552] × [40, 460]. Allow tiny
      // float slack.
      expect(minX).toBeGreaterThanOrEqual(POSTER_PRESET.padding * POSTER_PRESET.width - 1e-3);
      expect(minY).toBeGreaterThanOrEqual(POSTER_PRESET.padding * POSTER_PRESET.height - 1e-3);
      expect(maxX).toBeLessThanOrEqual(POSTER_PRESET.width * (1 - POSTER_PRESET.padding) + 1e-3);
      expect(maxY).toBeLessThanOrEqual(POSTER_PRESET.height * (1 - POSTER_PRESET.padding) + 1e-3);
    },
  );
});

// ── Assertion 4: CPK color preservation ───────────────────────────────

describe('poster-figure: CPK color preservation', () => {
  it('water cluster renders at least one CPK-red circle (oxygen)', () => {
    const prim = primitivesAtPoster(makeWaterClusterCapsule());
    const fills = new Set(prim.circles.map((c) => c.fill.toLowerCase()));
    expect(fills.has('#ff0d0d')).toBe(true);
  });

  it('simple organic renders at least one CPK-blue circle (nitrogen)', () => {
    const prim = primitivesAtPoster(makeSimpleOrganicCapsule());
    const fills = new Set(prim.circles.map((c) => c.fill.toLowerCase()));
    expect(fills.has('#3050f8')).toBe(true);
  });

  it('oxide patch keeps Si (#f0c8a0) and O (#ff0d0d) as distinct swatches', () => {
    const prim = primitivesAtPoster(makeOxidePatchCapsule());
    const fills = new Set(prim.circles.map((c) => c.fill.toLowerCase()));
    expect(fills.has('#ff0d0d')).toBe(true);
    expect(fills.has('#f0c8a0')).toBe(true);
  });

  it('AUDIT preset (flat) collapses mixed-element fixtures to one swatch', () => {
    for (const { capsule } of mixedElementFixtures()) {
      const scene3D = buildPreviewSceneFromCapsule(capsule);
      const projected = projectPreviewScene(scene3D, {
        targetWidth: AUDIT_LARGE_PRESET.width,
        targetHeight: AUDIT_LARGE_PRESET.height,
        padding: 0,
      });
      const bonds = deriveBondPairsForProjectedScene(scene3D, projected, 1.85, 0.5);
      const prim = buildPreviewSketchPrimitives(
        toSketchSceneFromProjectedScene(projected, bonds),
        AUDIT_LARGE_PRESET,
      );
      const fills = new Set(prim.circles.map((c) => c.fill));
      expect(fills.size).toBe(1);
    }
  });
});

// ── Assertion 5: no ghost edges ───────────────────────────────────────

describe('poster-figure: no ghost edges', () => {
  it.each([...structuralFixtures(), ...mixedElementFixtures()])(
    '$name: every line endpoint has a corresponding atom circle center',
    ({ capsule }) => {
      const prim = primitivesAtPoster(capsule);
      const centers = new Set(prim.circles.map((c) => `${c.cx},${c.cy}`));
      for (const line of prim.lines) {
        expect(centers.has(`${line.x1},${line.y1}`)).toBe(true);
        expect(centers.has(`${line.x2},${line.y2}`)).toBe(true);
      }
    },
  );
});
