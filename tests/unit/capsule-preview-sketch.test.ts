/**
 * @vitest-environment jsdom
 *
 * Tests for `src/share/capsule-preview-sketch.ts`:
 * - `deriveBondPairsForProjectedScene` (index-drift regression)
 * - three adapters (projected / stored poster / stored thumb)
 * - `buildPreviewSketchPrimitives` (both color modes, depth + depth-free)
 * - `renderPreviewSketchSvgString`
 * - `renderPreviewSketchSvgNode`
 */

import { describe, it, expect } from 'vitest';
import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AUDIT_LARGE_PRESET,
  POSTER_PRESET,
  THUMB_PRESET,
  buildPreviewSketchPrimitives,
  renderPreviewSketchSvgNode,
  renderPreviewSketchSvgString,
  toSketchSceneFromProjectedScene,
  toSketchSceneFromStoredPoster,
  toSketchSceneFromThumb,
} from '../../src/share/capsule-preview-sketch';
import {
  buildPreviewSceneV1,
  serializePreviewSceneV1,
  parsePreviewSceneV1,
  type PreviewSceneV1,
  type PreviewThumbV1,
} from '../../src/share/capsule-preview-scene-store';
import {
  projectPreviewScene,
  deriveBondPairsForProjectedScene,
  type CapsulePreviewRenderScene,
} from '../../src/share/capsule-preview-project';
import { buildPreviewSceneFromCapsule } from '../../src/share/capsule-preview-frame';
import { makeC60Capsule } from '../../src/share/__fixtures__/capsule-preview-structures';

function fakeProjectedScene(): CapsulePreviewRenderScene {
  return {
    atoms: [
      { atomId: 0, x: 100, y: 100, r: 10, colorHex: '#222222', depth: -1 },
      { atomId: 1, x: 500, y: 100, r: 10, colorHex: '#3050f8', depth: 0 },
      { atomId: 2, x: 300, y: 400, r: 10, colorHex: '#ff0d0d', depth: 1 },
    ],
    bounds: { width: 600, height: 500 },
    classification: 'general',
  };
}

// ── deriveBondPairsForProjectedScene — index-drift guard ──────────────

describe('deriveBondPairsForProjectedScene', () => {
  it('translates bond pairs through the post-projection depth sort', () => {
    const capsule = makeC60Capsule();
    const scene3D = buildPreviewSceneFromCapsule(capsule);
    const projected = projectPreviewScene(scene3D);
    const bonds = deriveBondPairsForProjectedScene(scene3D, projected, 1.85, 0.5);
    expect(bonds.length).toBeGreaterThan(0);
    for (const b of bonds) {
      expect(b.a).toBeGreaterThanOrEqual(0);
      expect(b.a).toBeLessThan(projected.atoms.length);
      expect(b.b).toBeGreaterThanOrEqual(0);
      expect(b.b).toBeLessThan(projected.atoms.length);
      expect(b.a).not.toBe(b.b);
      // Midpoint depth matches the averaged endpoint depths.
      const expected =
        (projected.atoms[b.a].depth + projected.atoms[b.b].depth) / 2;
      expect(b.depth).toBeCloseTo(expected, 6);
    }
  });

  it('returns [] when no bonds pass the cutoff', () => {
    const capsule = makeC60Capsule();
    const scene3D = buildPreviewSceneFromCapsule(capsule);
    const projected = projectPreviewScene(scene3D);
    expect(deriveBondPairsForProjectedScene(scene3D, projected, 0.1, 0)).toEqual([]);
  });

  it('maps pre-sort source indices to post-sort projected indices (adversarial 3-atom case)', () => {
    // Adversarial fixture: three collinear atoms whose source order is
    // exactly inverted by the post-projection depth sort. The helper
    // must re-address every bond from source-space to projected-space
    // indices or it would emit ghost bonds between the wrong atoms.
    //
    //   source order : atomId 10 (z=0.9) → 20 (z=0.0) → 30 (z=-0.9)
    //   depth sort   : atomId 30 → 20 → 10         (farthest first)
    //   projected ix :          0       1        2
    //
    // `deriveBondPairs` returns pairs in {0,1}, {1,2} source indices;
    // the helper must rewrite those to {2,1}, {1,0} so they point at
    // the correct projected atoms. If someone rewrites the mapping
    // logic to assume identity, this test fails loudly.
    const scene3D = {
      atoms: [
        { atomId: 10, element: 'C', x: 0, y: 0, z:  0.9, colorHex: '#222222' },
        { atomId: 20, element: 'C', x: 0, y: 0, z:  0.0, colorHex: '#222222' },
        { atomId: 30, element: 'C', x: 0, y: 0, z: -0.9, colorHex: '#222222' },
      ],
      frameId: 0,
      timePs: 0,
      bounds: {
        min: [0, 0, -0.9] as [number, number, number],
        max: [0, 0,  0.9] as [number, number, number],
        center: [0, 0, 0] as [number, number, number],
      },
    };
    const identityCamera = {
      scale: 1,
      tx: 0,
      ty: 0,
      rotation3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [
        number, number, number,
        number, number, number,
        number, number, number,
      ],
      classification: 'linear' as const,
    };
    const projected = projectPreviewScene(scene3D, {
      targetWidth: 100,
      targetHeight: 100,
      padding: 0,
      camera: identityCamera,
    });
    // Precondition: the sort put atomId 30 first, 10 last.
    expect(projected.atoms.map((a) => a.atomId)).toEqual([30, 20, 10]);

    const bonds = deriveBondPairsForProjectedScene(scene3D, projected, 1.0, 0);
    // Exact translated bonds, not just shape — {0,1}→{2,1}, {1,2}→{1,0}.
    expect(bonds).toEqual([
      { a: 2, b: 1, depth: 0.45 },
      { a: 1, b: 0, depth: -0.45 },
    ]);
  });
});

// ── Adapters ──────────────────────────────────────────────────────────

describe('toSketchSceneFromProjectedScene', () => {
  it('normalizes pixel coords to 0..1 and preserves colorHex + depth', () => {
    const scene = fakeProjectedScene();
    const sketch = toSketchSceneFromProjectedScene(scene, [
      { a: 0, b: 1, depth: -0.5 },
      { a: 1, b: 2, depth: 0.5 },
    ]);
    expect(sketch.atoms).toHaveLength(3);
    expect(sketch.atoms[0].x).toBeCloseTo(100 / 600);
    expect(sketch.atoms[0].y).toBeCloseTo(100 / 500);
    expect(sketch.atoms[0].r).toBeCloseTo(10 / 500);
    expect(sketch.atoms[0].colorHex).toBe('#222222');
    expect(sketch.atoms[0].depth).toBe(-1);
    expect(sketch.atoms[2].colorHex).toBe('#ff0d0d');
    expect(sketch.bonds).toHaveLength(2);
    expect(sketch.bonds![0]).toEqual({ a: 0, b: 1, depth: -0.5 });
  });

  it('omits bonds when the caller passes none', () => {
    const sketch = toSketchSceneFromProjectedScene(fakeProjectedScene());
    expect(sketch.bonds).toBeUndefined();
  });
});

describe('toSketchSceneFromStoredPoster', () => {
  it('renames c → colorHex, passes 0..1 coords through, omits depth', () => {
    const stored: PreviewSceneV1 = {
      v: 1,
      atoms: [
        { x: 0.1, y: 0.5, r: 0.02, c: '#222222' },
        { x: 0.9, y: 0.5, r: 0.02, c: '#3050f8' },
      ],
      bonds: [{ a: 0, b: 1 }],
      hash: 'deadbeef',
    };
    const sketch = toSketchSceneFromStoredPoster(stored);
    expect(sketch.atoms[0]).toEqual({
      x: 0.1, y: 0.5, r: 0.02, colorHex: '#222222',
    });
    expect(sketch.atoms[0].depth).toBeUndefined();
    expect(sketch.bonds).toEqual([{ a: 0, b: 1 }]);
  });

  it('drops undefined bonds when the storage payload omits them', () => {
    const stored: PreviewSceneV1 = {
      v: 1,
      atoms: [{ x: 0.5, y: 0.5, r: 0.02, c: '#222' }],
      hash: '00000000',
    };
    expect(toSketchSceneFromStoredPoster(stored).bonds).toBeUndefined();
  });
});

describe('toSketchSceneFromThumb', () => {
  it('renames c → colorHex and carries bonds', () => {
    const thumb: PreviewThumbV1 = {
      v: 1,
      atoms: [
        { x: 0.2, y: 0.4, r: 0.03, c: '#ff0d0d' },
        { x: 0.8, y: 0.6, r: 0.03, c: '#3050f8' },
      ],
      bonds: [{ a: 0, b: 1 }],
    };
    const sketch = toSketchSceneFromThumb(thumb);
    expect(sketch.atoms[0].colorHex).toBe('#ff0d0d');
    expect(sketch.atoms[0].depth).toBeUndefined();
    expect(sketch.bonds).toEqual([{ a: 0, b: 1 }]);
  });
});

// ── buildPreviewSketchPrimitives ──────────────────────────────────────

describe('buildPreviewSketchPrimitives', () => {
  it('emits circles in depth-ascending order when depth is present', () => {
    const sketch = toSketchSceneFromProjectedScene(fakeProjectedScene());
    const prim = buildPreviewSketchPrimitives(sketch, AUDIT_LARGE_PRESET);
    expect(prim.circles).toHaveLength(3);
    for (let i = 1; i < prim.circles.length; i++) {
      expect(prim.circles[i].z).toBeGreaterThanOrEqual(prim.circles[i - 1].z);
    }
  });

  it('maps atoms into the preset width×height with padding', () => {
    const sketch = toSketchSceneFromProjectedScene(fakeProjectedScene());
    const prim = buildPreviewSketchPrimitives(sketch, AUDIT_LARGE_PRESET);
    for (const c of prim.circles) {
      const minX = AUDIT_LARGE_PRESET.padding * AUDIT_LARGE_PRESET.width;
      const maxX = AUDIT_LARGE_PRESET.width - minX;
      expect(c.cx).toBeGreaterThanOrEqual(minX - 1e-6);
      expect(c.cx).toBeLessThanOrEqual(maxX + 1e-6);
    }
  });

  it('flat colorMode overrides per-atom colorHex', () => {
    const sketch = toSketchSceneFromProjectedScene(fakeProjectedScene());
    const prim = buildPreviewSketchPrimitives(sketch, AUDIT_LARGE_PRESET);
    for (const c of prim.circles) {
      expect(c.fill).toBe('#111111');
    }
  });

  it('cpk colorMode preserves per-atom colorHex', () => {
    const sketch = toSketchSceneFromProjectedScene(fakeProjectedScene());
    const prim = buildPreviewSketchPrimitives(sketch, POSTER_PRESET);
    const fills = prim.circles.map((c) => c.fill).sort();
    expect(fills).toEqual(['#222222', '#3050f8', '#ff0d0d'].sort());
  });

  it('depth-free input still produces valid primitives (no depth scaling)', () => {
    const stored: PreviewSceneV1 = {
      v: 1,
      atoms: [
        { x: 0.2, y: 0.5, r: 0.02, c: '#222' },
        { x: 0.5, y: 0.5, r: 0.02, c: '#3050f8' },
        { x: 0.8, y: 0.5, r: 0.02, c: '#ff0d0d' },
      ],
      bonds: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
      hash: 'deadbeef',
    };
    const prim = buildPreviewSketchPrimitives(
      toSketchSceneFromStoredPoster(stored),
      POSTER_PRESET,
    );
    for (const c of prim.circles) expect(c.z).toBe(0);
    expect(prim.lines).toHaveLength(2);
    for (const line of prim.lines) expect(line.z).toBe(0);
  });

  it('every bond line endpoint matches an atom circle center (no ghost edges)', () => {
    const sketch = toSketchSceneFromProjectedScene(
      fakeProjectedScene(),
      [{ a: 0, b: 2, depth: 0 }, { a: 1, b: 2, depth: 0.5 }],
    );
    const prim = buildPreviewSketchPrimitives(sketch, AUDIT_LARGE_PRESET);
    const centers = new Set(prim.circles.map((c) => `${c.cx},${c.cy}`));
    for (const line of prim.lines) {
      expect(centers.has(`${line.x1},${line.y1}`)).toBe(true);
      expect(centers.has(`${line.x2},${line.y2}`)).toBe(true);
    }
  });

  it('atom radius stays within the preset min/max band', () => {
    const sketch = toSketchSceneFromProjectedScene(fakeProjectedScene());
    const prim = buildPreviewSketchPrimitives(sketch, THUMB_PRESET);
    for (const c of prim.circles) {
      expect(c.r).toBeGreaterThanOrEqual(THUMB_PRESET.atomRadiusMin);
      expect(c.r).toBeLessThanOrEqual(THUMB_PRESET.atomRadiusMax);
    }
  });
});

// ── renderPreviewSketchSvgString ──────────────────────────────────────

describe('renderPreviewSketchSvgString', () => {
  it('produces a well-formed <svg> with bonds drawn before atoms', () => {
    const sketch = toSketchSceneFromProjectedScene(
      fakeProjectedScene(),
      [{ a: 0, b: 1, depth: 0 }],
    );
    const prim = buildPreviewSketchPrimitives(sketch, AUDIT_LARGE_PRESET);
    const svg = renderPreviewSketchSvgString(prim);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    const firstLine = svg.indexOf('<line');
    const firstCircle = svg.indexOf('<circle');
    expect(firstLine).toBeGreaterThan(-1);
    expect(firstCircle).toBeGreaterThan(firstLine);
  });

  it('emits two <line> elements per bond (outer + inner halo)', () => {
    const sketch = toSketchSceneFromProjectedScene(
      fakeProjectedScene(),
      [{ a: 0, b: 1, depth: 0 }],
    );
    const prim = buildPreviewSketchPrimitives(sketch, AUDIT_LARGE_PRESET);
    const svg = renderPreviewSketchSvgString(prim);
    const count = (svg.match(/<line /g) ?? []).length;
    expect(count).toBe(2);
  });

  it('omits <line> elements for depth-free sparse scenes without bonds', () => {
    const stored: PreviewSceneV1 = {
      v: 1,
      atoms: [{ x: 0.5, y: 0.5, r: 0.02, c: '#222' }],
      hash: '00000000',
    };
    const prim = buildPreviewSketchPrimitives(
      toSketchSceneFromStoredPoster(stored),
      POSTER_PRESET,
    );
    const svg = renderPreviewSketchSvgString(prim);
    expect(svg.includes('<line')).toBe(false);
    expect(svg.includes('<circle')).toBe(true);
  });
});

// ── renderPreviewSketchSvgNode ────────────────────────────────────────

describe('renderPreviewSketchSvgNode', () => {
  it('returns a VALID React element of type "svg" with the preset dimensions', () => {
    const sketch = toSketchSceneFromProjectedScene(fakeProjectedScene());
    const prim = buildPreviewSketchPrimitives(sketch, POSTER_PRESET);
    const node = renderPreviewSketchSvgNode(prim);
    // Core regression guard — object literals with { type, props }
    // satisfy shape tests but fail `isValidElement` because they lack
    // the `$typeof` Symbol that Satori and React's runtime check before
    // walking children. Without this assertion the exact bug that
    // prompted extracting `createElement` can regress silently.
    expect(isValidElement(node)).toBe(true);
    expect(node.type).toBe('svg');
    const svgProps = node.props as { width: number; height: number };
    expect(svgProps.width).toBe(POSTER_PRESET.width);
    expect(svgProps.height).toBe(POSTER_PRESET.height);
  });

  it('renders bonds before atoms, and every child is a valid element', () => {
    const sketch = toSketchSceneFromProjectedScene(
      fakeProjectedScene(),
      [{ a: 0, b: 1, depth: 0 }],
    );
    const prim = buildPreviewSketchPrimitives(sketch, POSTER_PRESET);
    const node = renderPreviewSketchSvgNode(prim);
    const children = Children.toArray(
      (node.props as { children?: React.ReactNode }).children,
    );
    // Every child must be a valid element, not just a POJO that
    // happens to carry a `.type` string. Regression guard against a
    // renderer rewrite that accidentally emits plain objects again.
    for (const child of children) {
      expect(isValidElement(child)).toBe(true);
    }
    const types = children.map((c) =>
      isValidElement(c) ? (c.type as string) : '',
    );
    const firstLine = types.indexOf('line');
    const firstCircle = types.indexOf('circle');
    expect(firstLine).toBeGreaterThan(-1);
    expect(firstCircle).toBeGreaterThan(firstLine);
  });

  it('renders end-to-end through React (renderToStaticMarkup) to SVG markup', () => {
    // End-to-end guard: if the renderer regresses to plain object
    // literals, React throws instead of emitting markup. Catching a
    // known atom element in the output proves we produced a real SVG
    // tree, not just something that passed a shape check.
    const sketch = toSketchSceneFromProjectedScene(
      fakeProjectedScene(),
      [{ a: 0, b: 1, depth: 0 }],
    );
    const prim = buildPreviewSketchPrimitives(sketch, POSTER_PRESET);
    const node = renderPreviewSketchSvgNode(prim);
    const markup = renderToStaticMarkup(node);
    expect(markup.startsWith('<svg')).toBe(true);
    expect(markup.includes('<line')).toBe(true);
    expect(markup.includes('<circle')).toBe(true);
  });
});

// ── Round-trip: storage → adapter → primitives ────────────────────────

describe('stored-scene round-trip', () => {
  it('parsed PreviewSceneV1 renders via the poster adapter without depth', () => {
    // Use the round-trip to catch any field-rename regression.
    const c60 = makeC60Capsule();
    const scene3D = buildPreviewSceneFromCapsule(c60);
    const projected = projectPreviewScene(scene3D);
    const storedJson = serializePreviewSceneV1(buildPreviewSceneV1(projected));
    const parsed = parsePreviewSceneV1(storedJson);
    expect(parsed).not.toBeNull();
    const sketch = toSketchSceneFromStoredPoster(parsed!);
    for (const a of sketch.atoms) expect(a.depth).toBeUndefined();
    const prim = buildPreviewSketchPrimitives(sketch, POSTER_PRESET);
    expect(prim.circles.length).toBe(sketch.atoms.length);
  });
});
