/**
 * @vitest-environment jsdom
 *
 * Tests for the pure geometry helpers that drive the floating
 * atom-interaction hint's target selection. Everything here runs
 * against injected projectors — no Three.js, no DOM reliance beyond
 * what vitest's jsdom env provides for free.
 */
import { describe, it, expect } from 'vitest';
import {
  projectAtomsToNDC,
  convexHull2D,
  pickCentermostHullAtom,
  pickHintTargetAtom,
  computeOnScreenCentroid,
  rayBoxExit,
  type ProjectedAtom,
} from '../../lab/js/runtime/hint-target';

// ─────────────────────────────────────────────────────────────────────
// convexHull2D
// ─────────────────────────────────────────────────────────────────────

describe('convexHull2D', () => {
  it('returns [] for empty input', () => {
    expect(convexHull2D([])).toEqual([]);
  });

  it('returns [0] for a single point', () => {
    expect(convexHull2D([{ x: 1, y: 1 }])).toEqual([0]);
  });

  it('returns both indices for two distinct points', () => {
    const hull = convexHull2D([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(hull.sort()).toEqual([0, 1]);
  });

  it('collapses coincident points to a single hull vertex', () => {
    expect(convexHull2D([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toEqual([0]);
  });

  it('returns the four corners of a unit square (interior point skipped)', () => {
    const pts = [
      { x: 0, y: 0 }, // 0 — corner
      { x: 1, y: 0 }, // 1 — corner
      { x: 1, y: 1 }, // 2 — corner
      { x: 0, y: 1 }, // 3 — corner
      { x: 0.5, y: 0.5 }, // 4 — interior, must be dropped
    ];
    const hull = convexHull2D(pts);
    expect(hull).toHaveLength(4);
    expect(new Set(hull)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('drops collinear points on a hull edge', () => {
    // Triangle with a point exactly on the bottom edge — the collinear
    // point is NOT a real vertex and must be excluded.
    const pts = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 2 },
      { x: 1, y: 0 }, // collinear — on the bottom edge
    ];
    const hull = convexHull2D(pts);
    expect(hull).toHaveLength(3);
    expect(new Set(hull)).toEqual(new Set([0, 1, 2]));
  });

  it('is deterministic for identical inputs', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0.3, y: 0.4 },
    ];
    const a = convexHull2D(pts);
    const b = convexHull2D(pts);
    expect(a).toEqual(b);
  });
});

// ─────────────────────────────────────────────────────────────────────
// projectAtomsToNDC
// ─────────────────────────────────────────────────────────────────────

describe('projectAtomsToNDC', () => {
  it('marks points inside [-1,1]³ as onScreen and those outside as off-screen', () => {
    // Projector: identity (world coords already in NDC for test purposes).
    const positions = new Float64Array([
      0, 0, 0,         // 0 — center, on-screen
      0.9, 0.9, 0,     // 1 — near corner, on-screen
      2, 0, 0,         // 2 — right of viewport, off-screen
      0, 0, 3,         // 3 — behind far plane, off-screen
    ]);
    const projected = projectAtomsToNDC(
      positions,
      4,
      (w) => [w[0], w[1], w[2]],
    );
    expect(projected[0].onScreen).toBe(true);
    expect(projected[1].onScreen).toBe(true);
    expect(projected[2].onScreen).toBe(false);
    expect(projected[3].onScreen).toBe(false);
  });

  it('treats NaN/Infinity projections as off-screen', () => {
    const positions = new Float64Array([0, 0, 0]);
    const projected = projectAtomsToNDC(positions, 1, () => [NaN, 0, 0]);
    expect(projected[0].onScreen).toBe(false);
  });

  it('preserves atom index ordering', () => {
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const projected = projectAtomsToNDC(positions, 3, (w) => [w[0], w[1], w[2]]);
    expect(projected.map((p) => p.idx)).toEqual([0, 1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// pickCentermostHullAtom
// ─────────────────────────────────────────────────────────────────────

function fakeProjected(entries: Array<{ idx: number; x: number; y: number; onScreen?: boolean }>): ProjectedAtom[] {
  return entries.map((e) => ({ idx: e.idx, ndcX: e.x, ndcY: e.y, onScreen: e.onScreen ?? true }));
}

describe('pickCentermostHullAtom', () => {
  it('returns null when no atoms are on-screen', () => {
    const atoms = fakeProjected([
      { idx: 0, x: 2, y: 2, onScreen: false },
      { idx: 1, x: -2, y: -2, onScreen: false },
    ]);
    expect(pickCentermostHullAtom(atoms)).toBeNull();
  });

  it('returns the only atom when exactly one is on-screen', () => {
    const atoms = fakeProjected([
      { idx: 0, x: 5, y: 5, onScreen: false },
      { idx: 1, x: 0.5, y: 0, onScreen: true },
    ]);
    expect(pickCentermostHullAtom(atoms)).toBe(1);
  });

  it('picks the hull vertex closest to center on a square cluster', () => {
    // Corners at ±0.5, plus one boundary atom on the top edge at (0, 0.5)
    // which is closer to center than the corners (dist 0.25 vs 0.5).
    // But (0, 0.5) is collinear with (-0.5, 0.5) and (0.5, 0.5) so it's
    // NOT a hull vertex — the hull is {corners}. The closest corner to
    // center is equidistant across all four → tiebreak picks smallest idx.
    const atoms = fakeProjected([
      { idx: 0, x: -0.5, y: -0.5 },
      { idx: 1, x: 0.5, y: -0.5 },
      { idx: 2, x: 0.5, y: 0.5 },
      { idx: 3, x: -0.5, y: 0.5 },
      { idx: 4, x: 0, y: 0.5 }, // collinear, interior to hull
    ]);
    // All four corners tie on distance; tiebreak → smallest idx = 0.
    expect(pickCentermostHullAtom(atoms)).toBe(0);
  });

  it('picks the asymmetric hull vertex closest to center', () => {
    // One corner is pushed far from center; the others sit tight.
    // The nearest-to-center corner is the unique answer.
    const atoms = fakeProjected([
      { idx: 0, x: -0.9, y: -0.9 },   // far
      { idx: 1, x: 0.1, y: -0.1 },    // very close to center
      { idx: 2, x: 0.9, y: 0.9 },     // far
      { idx: 3, x: -0.9, y: 0.9 },    // far
      { idx: 4, x: 0, y: 0 },         // interior — NOT a hull vertex
    ]);
    expect(pickCentermostHullAtom(atoms)).toBe(1);
  });

  it('is deterministic on ties — smaller idx wins', () => {
    // Two atoms at identical distance from center on the hull.
    const atoms = fakeProjected([
      { idx: 7, x: 0.3, y: 0.0 },
      { idx: 2, x: -0.3, y: 0.0 },
      { idx: 9, x: 0.0, y: 0.3 },
      { idx: 11, x: 0.0, y: -0.3 },
    ]);
    // All four tie on distance 0.09. Smallest idx = 2.
    expect(pickCentermostHullAtom(atoms)).toBe(2);
  });

  it('falls back to closest-among-all when fewer than 3 on-screen atoms', () => {
    // Two on-screen atoms, no real hull to speak of — just pick the
    // one closer to center.
    const atoms = fakeProjected([
      { idx: 0, x: 0.8, y: 0 },
      { idx: 1, x: 0.2, y: 0 },
    ]);
    expect(pickCentermostHullAtom(atoms)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// pickHintTargetAtom — composed entrypoint
// ─────────────────────────────────────────────────────────────────────

describe('pickHintTargetAtom', () => {
  it('returns null on an empty scene', () => {
    expect(pickHintTargetAtom(new Float64Array(0), 0, () => [0, 0, 0])).toBeNull();
  });

  it('picks a single-atom scene', () => {
    const positions = new Float64Array([0.2, 0.2, 0]);
    expect(pickHintTargetAtom(positions, 1, (w) => [w[0], w[1], w[2]])).toBe(0);
  });

  it('picks the centermost boundary atom on a real-ish scene', () => {
    // A 7-atom "C"-shape: one interior atom near origin (index 3) and
    // six boundary atoms. The hint must land on a BOUNDARY atom (NOT
    // the interior one) that is closest to center.
    const positions = new Float64Array([
      -0.6, -0.6, 0,  // 0 — boundary, far
       0.6, -0.6, 0,  // 1 — boundary, far
       0.6,  0.6, 0,  // 2 — boundary, far
      -0.6,  0.6, 0,  // 3 — boundary, far
       0.1,  0.0, 0,  // 4 — INTERIOR, closest to center but should NOT win
      -0.5,  0.0, 0,  // 5 — boundary edge, moderate distance
       0.0,  0.5, 0,  // 6 — boundary edge, moderate distance
    ]);
    const target = pickHintTargetAtom(positions, 7, (w) => [w[0], w[1], w[2]]);
    expect(target).not.toBe(4); // interior atom must be excluded
    expect(target).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// computeOnScreenCentroid — cluster-center primitive
// ─────────────────────────────────────────────────────────────────────

function fp(entries: Array<{ idx: number; x: number; y: number; onScreen?: boolean }>): ProjectedAtom[] {
  return entries.map((e) => ({ idx: e.idx, ndcX: e.x, ndcY: e.y, onScreen: e.onScreen ?? true }));
}

describe('computeOnScreenCentroid', () => {
  it('returns null when no atom is on-screen', () => {
    expect(computeOnScreenCentroid(fp([
      { idx: 0, x: 2, y: 2, onScreen: false },
    ]))).toBeNull();
  });

  it('ignores off-screen atoms', () => {
    const c = computeOnScreenCentroid(fp([
      { idx: 0, x: 1, y: 1, onScreen: false },  // off-screen; excluded
      { idx: 1, x: 0, y: 0 },
      { idx: 2, x: 0.2, y: 0 },
    ]));
    expect(c).toEqual({ x: 0.1, y: 0 });
  });

  it('is the arithmetic mean of on-screen NDC positions', () => {
    const c = computeOnScreenCentroid(fp([
      { idx: 0, x: -0.5, y: -0.5 },
      { idx: 1, x: 0.5, y: -0.5 },
      { idx: 2, x: 0.5, y: 0.5 },
      { idx: 3, x: -0.5, y: 0.5 },
    ]));
    expect(c).toEqual({ x: 0, y: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// rayBoxExit — ray-to-box-boundary distance
// ─────────────────────────────────────────────────────────────────────

describe('rayBoxExit', () => {
  it('horizontal ray → exits at the right edge', () => {
    // Box 100×60, ray to the right → exits at x = halfW = 50.
    expect(rayBoxExit(50, 30, 1, 0)).toBe(50);
  });

  it('vertical ray → exits at the top/bottom edge', () => {
    expect(rayBoxExit(50, 30, 0, 1)).toBe(30);
    expect(rayBoxExit(50, 30, 0, -1)).toBe(30);
  });

  it('45° diagonal in a tall box → hits the short edge first', () => {
    // Box 100×30 (taller horizontally), diagonal (1,1) unnormalized.
    // halfW/|dx| = 50, halfH/|dy| = 15 → 15 wins.
    expect(rayBoxExit(50, 15, 1, 1)).toBe(15);
  });

  it('respects direction magnitude (not just sign)', () => {
    // Longer dx means smaller t (ray exits sooner in parametric units).
    expect(rayBoxExit(50, 30, 2, 0)).toBe(25);
    expect(rayBoxExit(50, 30, 0.5, 0)).toBe(100);
  });

  it('zero direction returns 0 (degenerate)', () => {
    expect(rayBoxExit(50, 30, 0, 0)).toBe(0);
  });

  it('ray along exact edge axis returns that axis half-extent', () => {
    // Ensure a zero x-component does not cause NaN propagation.
    expect(rayBoxExit(50, 30, 0, 1)).toBe(30);
    expect(rayBoxExit(50, 30, -1, 0)).toBe(50);
  });
});

