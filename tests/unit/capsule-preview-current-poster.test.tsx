/**
 * @vitest-environment jsdom
 *
 * Regression tests for the shipped OG poster SVG body
 * (`CurrentPosterSceneSvg`). Historically the only poster-geometry
 * coverage lived against `buildPreviewSketchPrimitives` (the audit
 * workbench's experimental renderer), so the production component
 * could drift without a test ever flipping red — which is exactly
 * what happened under the thumb-source regression fixed on
 * 2026-04-21 (D135 follow-up 2).
 *
 * This suite mounts `CurrentPosterSceneSvg` with real published-
 * scene JSON produced by `projectCapsuleToSceneJson` (same path a
 * Cloudflare Function hits on publish), and asserts:
 *
 *   1. **Source split** — when the scene carries bonds, the renderer
 *      consumes `scene.atoms` / `scene.bonds` (not `scene.thumb`).
 *      A fixture with conflicting thumb vs. scene lengths is the
 *      discriminator.
 *   2. **Dense-cage bond legibility** — C60 (60 atoms, 90 edges)
 *      renders at least the full cage topology; multi-component
 *      fixtures render every connected-subgraph's wiring.
 *   3. **Legacy bondless fallback** — when the scene has no bonds
 *      but the thumb does, the renderer falls back to the thumb
 *      bake rather than emitting an atoms-only poster.
 *   4. **No ghost bonds** — every bond line pair resolves to two
 *      existing atom circles at matching coordinates.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  CurrentPosterSceneSvg,
} from '../../src/share/capsule-preview-current-poster';
import {
  CURRENT_SCENE_REV,
  CURRENT_THUMB_REV,
  type PreviewSceneV1,
} from '../../src/share/capsule-preview-scene-store';
import { projectCapsuleToSceneJson } from '../../src/share/publish-core';
import {
  makeC60Capsule,
  makeCntCapsule,
  makeGrapheneCapsule,
  makeTwoEqualFragmentsCapsule,
} from '../../src/share/__fixtures__/capsule-preview-structures';

function mountScene(scene: PreviewSceneV1): SVGSVGElement {
  const { container } = render(<CurrentPosterSceneSvg scene={scene} />);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('CurrentPosterSceneSvg failed to mount');
  return svg;
}

function sceneFromCapsule(
  capsule: ReturnType<typeof makeC60Capsule>,
): PreviewSceneV1 {
  const json = projectCapsuleToSceneJson(capsule);
  if (!json) throw new Error('projectCapsuleToSceneJson returned null');
  return JSON.parse(json) as PreviewSceneV1;
}

function countAtoms(svg: Element): number {
  // Exclude <circle> inside <defs> (gradient fxs etc.) — those are
  // decorative. Every actual atom is a top-level <circle> under the
  // root SVG (siblings to the <defs> and <rect> backdrop).
  return Array.from(svg.children).filter((el) => el.tagName.toLowerCase() === 'circle').length;
}

/** All `<g>` direct children that wrap the three cylinder `<line>`
 *  elements produced per bond (edge / body / highlight). Shared
 *  between bond-count assertions and ghost-bond assertions. */
function bondGroups(svg: Element): Element[] {
  return Array.from(svg.children).filter((el) => {
    if (el.tagName.toLowerCase() !== 'g') return false;
    return el.querySelectorAll(':scope > line').length === 3;
  });
}

function countBonds(svg: Element): number {
  return bondGroups(svg).length;
}

describe('CurrentPosterSceneSvg — C60 cage wiring', () => {
  it('renders all 60 atoms and the full bond set', () => {
    const scene = sceneFromCapsule(makeC60Capsule());
    expect(scene.atoms.length).toBe(60);
    expect(scene.bonds?.length ?? 0).toBeGreaterThanOrEqual(80);
    const svg = mountScene(scene);
    expect(countAtoms(svg)).toBe(scene.atoms.length);
    expect(countBonds(svg)).toBe(scene.bonds!.length);
  });
});

describe('CurrentPosterSceneSvg — CNT wiring', () => {
  it('renders every atom and every bond from the scene', () => {
    const scene = sceneFromCapsule(makeCntCapsule());
    expect(scene.atoms.length).toBeGreaterThanOrEqual(40);
    expect(scene.bonds?.length ?? 0).toBeGreaterThanOrEqual(40);
    const svg = mountScene(scene);
    expect(countAtoms(svg)).toBe(scene.atoms.length);
    expect(countBonds(svg)).toBe(scene.bonds!.length);
  });
});

describe('CurrentPosterSceneSvg — graphene lattice', () => {
  it('renders the planar hexagonal wiring', () => {
    const scene = sceneFromCapsule(makeGrapheneCapsule());
    expect(scene.atoms.length).toBeGreaterThanOrEqual(20);
    expect(scene.bonds?.length ?? 0).toBeGreaterThanOrEqual(20);
    const svg = mountScene(scene);
    expect(countAtoms(svg)).toBe(scene.atoms.length);
    expect(countBonds(svg)).toBe(scene.bonds!.length);
  });
});

describe('CurrentPosterSceneSvg — multi-component scene', () => {
  it('renders wiring for each component (D138 dominance-failed path)', () => {
    // Two-equal-fragments fixture fails the dominance guard, so
    // publish preserves the full multi-component frame. The poster
    // must render BOTH components' wiring — the pre-fix regression
    // was that one component's bonds got filtered at thumb scale
    // and vanished from the poster.
    const scene = sceneFromCapsule(makeTwoEqualFragmentsCapsule());
    const svg = mountScene(scene);
    // Every stored bond should render — no visibility-filter drops
    // at poster scale.
    expect(countBonds(svg)).toBe(scene.bonds!.length);
    // Each of the two fragments contributes bonds; total should
    // equal the sum across both components.
    expect(scene.bonds!.length).toBeGreaterThanOrEqual(2);
  });

  it('stores more than 32 atoms on scenes that previously hit the old cap', () => {
    // Before 2026-04-21 the stored poster scene was capped at
    // SCENE_ATOM_CAP=32, so any capsule with >32 atoms was
    // silhouette-sampled. C60 has exactly 60 atoms — a published
    // scene must now carry all 60 (cap is 5000).
    const scene = sceneFromCapsule(makeC60Capsule());
    expect(scene.atoms.length).toBe(60);
    expect(scene.atoms.length).toBeGreaterThan(32);
  });
});

describe('CurrentPosterSceneSvg — geometry invariance through rebake', () => {
  it('stored scene.rev stamp equals the exported CURRENT_SCENE_REV constant', () => {
    // Intentionally imports the constant rather than hard-coding
    // the literal. Any regression that drops the `rev` stamp from
    // freshly-baked scenes would silently re-introduce the "public
    // share posters never self-heal" bug. Binding to the constant
    // means a legitimate rev bump flows through without a drive-by
    // literal edit hunt; a literal would turn into a maintenance
    // trap.
    const scene = sceneFromCapsule(makeC60Capsule());
    expect(scene.rev).toBe(CURRENT_SCENE_REV);
  });

  it('spherical subject stays round through the full bake pipeline', () => {
    // Regression guard for "every structure becomes taller and
    // thinner". A physically-spherical C60 projected through
    // `projectCapsuleToSceneJson` must land with a near-1:1 stored
    // x/y aspect. Anything >1.05 or <0.95 means the anisotropic
    // normalization re-crept in somewhere upstream.
    const scene = sceneFromCapsule(makeC60Capsule());
    let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
    for (const a of scene.atoms) {
      if (a.x < sx0) sx0 = a.x;
      if (a.x > sx1) sx1 = a.x;
      if (a.y < sy0) sy0 = a.y;
      if (a.y > sy1) sy1 = a.y;
    }
    const aspect = (sx1 - sx0) / (sy1 - sy0);
    expect(aspect).toBeGreaterThan(0.95);
    expect(aspect).toBeLessThan(1.05);
  });

  it('poster bake is PERSPECTIVE — per-atom stored r varies across depth', () => {
    // Post-D135 follow-up 4 contract: the poster scene bake uses
    // pinhole perspective, so stored `a.r` must vary across the
    // cage (near-face atoms larger, far-face atoms smaller). A C60
    // cage spans its diameter in z — the depth range is maximal,
    // so the stored radii must span a non-trivial range. If this
    // test flips to "all equal" it means publish-core accidentally
    // reverted to `projectPreviewScene` (orthographic) and the
    // renderer's `perspectiveMultiplier` silently became a no-op
    // again. That was the exact bug follow-up 4 fixed.
    const scene = sceneFromCapsule(makeC60Capsule());
    const rs = scene.atoms.map((a) => a.r);
    const minR = Math.min(...rs);
    const maxR = Math.max(...rs);
    expect(maxR).toBeGreaterThan(minR);
    // The ratio maxR / minR should exceed 1.10 for a cage with
    // significant depth under `PERSPECTIVE_K_DEFAULT = 3.17` — the
    // orthographic bake would give ratio = 1.0 exactly.
    expect(maxR / minR).toBeGreaterThan(1.10);
  });

  it('renders near atoms larger than far atoms (perspective cue survives)', () => {
    // End-to-end check that the perspective bake reaches the
    // rendered output. Extract rendered circle radii alongside
    // stored radii; since `CurrentPosterSceneSvg` passes stored
    // `r` through `perspectiveMultiplier`, the rendered radius
    // should be a monotone function of stored `r`. If the renderer
    // ever stops consulting stored `r` (e.g., someone deletes the
    // perspective-multiplier call), this test catches it.
    const scene = sceneFromCapsule(makeC60Capsule());
    const svg = mountScene(scene);
    const circles = Array.from(svg.children).filter(
      (el) => el.tagName.toLowerCase() === 'circle',
    );
    // Build (stored r, rendered r) pairs by atom index — atoms are
    // emitted in scene.atoms order, circles likewise.
    const pairs = circles.map((c, i) => ({
      stored: scene.atoms[i].r,
      rendered: Number(c.getAttribute('r')),
    }));
    const renderedMin = Math.min(...pairs.map((p) => p.rendered));
    const renderedMax = Math.max(...pairs.map((p) => p.rendered));
    expect(renderedMax).toBeGreaterThan(renderedMin);
  });
});

describe('CurrentPosterSceneSvg — source split (scene vs. thumb)', () => {
  it('uses scene.atoms/scene.bonds when the scene carries bonds — ignores thumb', () => {
    // Craft a scene where thumb and scene lengths are obviously
    // different. The renderer must match `scene.atoms.length`, proving
    // it's NOT reading from the thumb (which would otherwise be the
    // pre-fix behavior under the D138 thumb-is-fresh gate).
    const scene: PreviewSceneV1 = {
      v: 1,
      hash: 'abcd1234',
      atoms: Array.from({ length: 8 }, (_, i) => ({
        x: 0.1 + (i / 7) * 0.8,
        y: 0.5,
        r: 0.04,
        c: '#222222',
      })),
      bonds: Array.from({ length: 7 }, (_, i) => ({ a: i, b: i + 1 })),
      thumb: {
        rev: CURRENT_THUMB_REV,
        atoms: Array.from({ length: 3 }, (_, i) => ({
          x: 0.1 + i * 0.4,
          y: 0.5,
          r: 0.04,
          c: '#ff0000',
        })),
        bonds: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
      },
    };
    const svg = mountScene(scene);
    // If the renderer used scene: 8 atoms, 7 bonds.
    // If the renderer used thumb: 3 atoms, 2 bonds.
    expect(countAtoms(svg)).toBe(8);
    expect(countBonds(svg)).toBe(7);
  });

  it('falls back to thumb when scene has no bonds (legacy bondless row)', () => {
    // Legacy row: scene.bonds === undefined / []. Atoms-only poster
    // would look sparse; the thumb bake is preferable as a
    // transitional fallback until the account-page lazy heal
    // refreshes the row.
    const scene: PreviewSceneV1 = {
      v: 1,
      hash: 'abcd1234',
      atoms: Array.from({ length: 4 }, (_, i) => ({
        x: 0.1 + (i / 3) * 0.8,
        y: 0.5,
        r: 0.04,
        c: '#222222',
      })),
      // No bonds field.
      thumb: {
        rev: CURRENT_THUMB_REV,
        atoms: Array.from({ length: 6 }, (_, i) => ({
          x: 0.15 + (i / 5) * 0.7,
          y: 0.5,
          r: 0.04,
          c: '#3050f8',
        })),
        bonds: Array.from({ length: 5 }, (_, i) => ({ a: i, b: i + 1 })),
      },
    };
    const svg = mountScene(scene);
    // Thumb-fallback signature: 6 atoms, 5 bonds.
    expect(countAtoms(svg)).toBe(6);
    expect(countBonds(svg)).toBe(5);
  });

  it('renders atoms-only poster when neither scene nor thumb has bonds', () => {
    const scene: PreviewSceneV1 = {
      v: 1,
      hash: 'abcd1234',
      atoms: Array.from({ length: 5 }, (_, i) => ({
        x: 0.1 + (i / 4) * 0.8,
        y: 0.5,
        r: 0.04,
        c: '#222222',
      })),
    };
    const svg = mountScene(scene);
    expect(countAtoms(svg)).toBe(5);
    expect(countBonds(svg)).toBe(0);
  });
});

describe('CurrentPosterSceneSvg — aspect ratio preservation', () => {
  function atomBounds(svg: Element): { spanX: number; spanY: number } {
    const circles = Array.from(svg.children).filter(
      (el) => el.tagName.toLowerCase() === 'circle',
    );
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of circles) {
      const cx = Number(c.getAttribute('cx'));
      const cy = Number(c.getAttribute('cy'));
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
    return { spanX: maxX - minX, spanY: maxY - minY };
  }

  it('C60 cage renders approximately round (aspect ratio ≈ 1:1)', () => {
    // Regression guard for the 2026-04-21 "everything taller and
    // thinner" bug. Before the fix, `publish-core.ts` projected the
    // poster at 600×500, then `buildPreviewSceneV1` normalized via
    // `x/600, y/500` — an anisotropic division that made every
    // rendered scene 1.2× taller than wide. Square projection target
    // restores correct aspect.
    const scene = sceneFromCapsule(makeC60Capsule());
    const svg = mountScene(scene);
    const { spanX, spanY } = atomBounds(svg);
    const aspect = spanX / spanY;
    // C60 is spherical → rendered aspect must be near 1:1. Allow a
    // generous band (0.9..1.1) for sampling / camera canonical
    // orientation effects.
    expect(aspect).toBeGreaterThan(0.9);
    expect(aspect).toBeLessThan(1.1);
  });

  it('CNT renders with longitudinal aspect preserved (wider than tall OR taller than wide)', () => {
    // CNT is an elongated tube — it projects to a rectangle.
    // Crucially, the rendered aspect must match the STORED aspect
    // in stored coords (1:1 isotropic pixel space). If the poster
    // is still anisotropic, CNTs will be uniformly compressed
    // horizontally regardless of camera orientation.
    const scene = sceneFromCapsule(makeCntCapsule());
    const svg = mountScene(scene);
    const { spanX, spanY } = atomBounds(svg);
    // Compute the STORED aspect from scene.atoms. Rendered aspect
    // (cx=x*100, cy=y*100) preserves stored aspect exactly — the
    // two must be equal within float noise.
    let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
    for (const a of scene.atoms) {
      if (a.x < sx0) sx0 = a.x;
      if (a.x > sx1) sx1 = a.x;
      if (a.y < sy0) sy0 = a.y;
      if (a.y > sy1) sy1 = a.y;
    }
    const storedAspect = (sx1 - sx0) / (sy1 - sy0);
    const renderedAspect = spanX / spanY;
    expect(renderedAspect).toBeCloseTo(storedAspect, 4);
  });

  it('stored atom coordinates land in an isotropic unit box (aspect check)', () => {
    // Invariant we now rely on: `x/width` and `y/height` must use
    // the SAME divisor — enforced by the square-target projection
    // in publish-core. A spherical subject projected through a
    // square target should produce equal-span stored coords on
    // both axes (± padding).
    const scene = sceneFromCapsule(makeC60Capsule());
    let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
    for (const a of scene.atoms) {
      if (a.x < sx0) sx0 = a.x;
      if (a.x > sx1) sx1 = a.x;
      if (a.y < sy0) sy0 = a.y;
      if (a.y > sy1) sy1 = a.y;
    }
    const spanX = sx1 - sx0;
    const spanY = sy1 - sy0;
    // For a spherical C60 with canonical PCA camera, stored span
    // aspect must be close to 1:1.
    expect(spanX / spanY).toBeGreaterThan(0.9);
    expect(spanX / spanY).toBeLessThan(1.1);
  });
});

describe('CurrentPosterSceneSvg — no ghost bonds', () => {
  it('every bond endpoint maps to an existing atom circle', () => {
    const scene = sceneFromCapsule(makeC60Capsule());
    const svg = mountScene(scene);
    const atomCircles = Array.from(svg.children).filter(
      (el) => el.tagName.toLowerCase() === 'circle',
    );
    const atomPositions = new Set(
      atomCircles.map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`),
    );
    for (const g of bondGroups(svg)) {
      const edgeLine = g.querySelector(':scope > line');
      if (!edgeLine) continue;
      const x1 = edgeLine.getAttribute('x1');
      const y1 = edgeLine.getAttribute('y1');
      const x2 = edgeLine.getAttribute('x2');
      const y2 = edgeLine.getAttribute('y2');
      expect(atomPositions.has(`${x1},${y1}`)).toBe(true);
      expect(atomPositions.has(`${x2},${y2}`)).toBe(true);
    }
  });
});
