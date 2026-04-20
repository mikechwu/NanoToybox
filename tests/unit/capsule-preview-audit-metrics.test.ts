/**
 * Programmatic acceptance metrics for the capsule preview renderer.
 * Each metric turns a previously-subjective review gate ("C60 looks
 * like a cage") into a deterministic numerical check CI can enforce.
 *
 * Metrics:
 *   1. C60 cage coherence — convex-hull coverage + centroid distance stddev.
 *   2. Graphene planar spread — 2D covariance ratio + bond-length uniformity.
 *   3. CNT tube aspect ratio — elongated covariance + connectivity density.
 *   4. Thumb scale-down retention — visible-bond count survives the THUMB preset.
 *   5. Dense-noisy fallback guard — bonded mode survives on the dense fixture.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPreviewSketchPrimitives,
  toSketchSceneFromProjectedScene,
  AUDIT_LARGE_PRESET,
  THUMB_PRESET,
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
  makeDenseNoisyCapsule,
} from '../../src/share/__fixtures__/capsule-preview-structures';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../../src/history/history-file-v1';

// ── Shared helpers ────────────────────────────────────────────────────

function primitivesFor(
  capsule: AtomDojoPlaybackCapsuleFileV1,
  preset = AUDIT_LARGE_PRESET,
): PreviewSketchPrimitives {
  const scene3D = buildPreviewSceneFromCapsule(capsule);
  // padding:0 enforces the single-fit contract — preset owns all
  // outer framing. Must match the audit page (preview-audit/main.tsx)
  // so CI measures the geometry the audit workbench actually shows.
  const projected = projectPreviewScene(scene3D, {
    targetWidth: preset.width,
    targetHeight: preset.height,
    padding: 0,
  });
  const bonds = deriveBondPairsForProjectedScene(scene3D, projected, 1.85, 0.5);
  return buildPreviewSketchPrimitives(
    toSketchSceneFromProjectedScene(projected, bonds),
    preset,
  );
}

function boundingBox(p: PreviewSketchPrimitives): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of p.circles) {
    if (c.cx < minX) minX = c.cx;
    if (c.cy < minY) minY = c.cy;
    if (c.cx > maxX) maxX = c.cx;
    if (c.cy > maxY) maxY = c.cy;
  }
  return { minX, minY, maxX, maxY };
}

/** 2D covariance eigenvalues (λ₁ ≥ λ₂) from a 2D point cloud. */
function covarianceEigenvalues(points: Array<{ x: number; y: number }>): {
  l1: number; l2: number;
} {
  const n = points.length;
  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (const p of points) {
    const dx = p.x - mx, dy = p.y - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  cxx /= n; cyy /= n; cxy /= n;
  const tr = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  return { l1, l2: Math.max(0, l2) };
}

/** Graham-scan convex hull area of 2D points. Not perf-critical. */
function convexHullArea(points: Array<{ x: number; y: number }>): number {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return 0;
  const cross = (o: typeof pts[0], a: typeof pts[0], b: typeof pts[0]) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof pts = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: typeof pts = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  const hull = lower.concat(upper.slice(1, -1));
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

// ── Metrics ───────────────────────────────────────────────────────────

describe('metric 1 — C60 cage coherence', () => {
  it('convex-hull area fills ≥ 55% of bounding-box AND centroid-distance stddev ≤ 35% of mean', () => {
    // Thresholds tuned to match the deterministic C60 fixture + canonical
    // PCA camera produce: convex hull ≈ 72%, stddev/mean ≈ 0.28. The
    // 35% ceiling gives ~25% regression headroom — still catches the
    // failure mode of an elongated cluster (ratio would be well above
    // 0.5) without tripping on legitimate sphere-projection variance.
    const prim = primitivesFor(makeC60Capsule(), AUDIT_LARGE_PRESET);
    const atoms = prim.circles.map((c) => ({ x: c.cx, y: c.cy }));
    const { minX, minY, maxX, maxY } = boundingBox(prim);
    const bbArea = Math.max(1, (maxX - minX) * (maxY - minY));
    const hull = convexHullArea(atoms);
    expect(hull / bbArea).toBeGreaterThanOrEqual(0.55);

    let cx = 0, cy = 0;
    for (const a of atoms) { cx += a.x; cy += a.y; }
    cx /= atoms.length; cy /= atoms.length;
    const dists = atoms.map((a) => Math.hypot(a.x - cx, a.y - cy));
    const mean = dists.reduce((s, d) => s + d, 0) / dists.length;
    const variance =
      dists.reduce((s, d) => s + (d - mean) * (d - mean), 0) / dists.length;
    const stddev = Math.sqrt(variance);
    expect(stddev / mean).toBeLessThanOrEqual(0.35);
  });
});

describe('metric 2 — graphene planar spread', () => {
  it('covariance λ₂/λ₁ ≥ 0.35 (not linear collapsed); ≥ 80% of bonds within ±15% of median length', () => {
    const prim = primitivesFor(makeGrapheneCapsule(), AUDIT_LARGE_PRESET);
    const atoms = prim.circles.map((c) => ({ x: c.cx, y: c.cy }));
    const { l1, l2 } = covarianceEigenvalues(atoms);
    expect(l2 / Math.max(1e-9, l1)).toBeGreaterThanOrEqual(0.35);

    const bondLengths = prim.lines.map((l) =>
      Math.hypot(l.x2 - l.x1, l.y2 - l.y1),
    );
    expect(bondLengths.length).toBeGreaterThan(0);
    const sorted = bondLengths.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const within = bondLengths.filter(
      (d) => d >= median * 0.85 && d <= median * 1.15,
    ).length;
    expect(within / bondLengths.length).toBeGreaterThanOrEqual(0.8);
  });
});

describe('metric 3 — CNT tube aspect ratio', () => {
  it('projected covariance λ₁/λ₂ ≥ 1.8 (visibly elongated) AND visible-bond count ≥ 1.2 × atom count', () => {
    // The 6-ring × 8-atom deterministic CNT fixture + canonical PCA
    // camera projects to an aspect ratio ≈ 2.0. A sphere (C60) hits
    // ≈ 1.0; graphene hits ≈ 1.3. The 1.8 threshold cleanly separates
    // "visibly elongated tube" from "blob" and "sheet" without
    // tripping on legitimate camera variation across CNT chiralities.
    const prim = primitivesFor(makeCntCapsule(), AUDIT_LARGE_PRESET);
    const atoms = prim.circles.map((c) => ({ x: c.cx, y: c.cy }));
    const { l1, l2 } = covarianceEigenvalues(atoms);
    expect(l1 / Math.max(1e-9, l2)).toBeGreaterThanOrEqual(1.8);
    const bondCount = prim.lines.length;
    expect(bondCount).toBeGreaterThanOrEqual(atoms.length * 1.2);
  });
});

describe('metric 4 — thumb scale-down retention', () => {
  it('thumb visible-bond count ≥ 40% of large-figure count for C60 / graphene / CNT', () => {
    for (const build of [makeC60Capsule, makeGrapheneCapsule, makeCntCapsule]) {
      const large = primitivesFor(build(), AUDIT_LARGE_PRESET);
      const thumb = primitivesFor(build(), THUMB_PRESET);
      const largeBonds = large.lines.length;
      const thumbBonds = thumb.lines.length;
      expect(largeBonds).toBeGreaterThan(0);
      expect(thumbBonds / largeBonds).toBeGreaterThanOrEqual(0.4);
    }
  });
});

describe('metric 5 — dense-noisy fallback guard', () => {
  it('dense-noisy fixture renders with ≥ 2 bonds at POSTER preset', () => {
    const prim = primitivesFor(makeDenseNoisyCapsule(), AUDIT_LARGE_PRESET);
    const bondCount = prim.lines.length;
    expect(bondCount).toBeGreaterThanOrEqual(2);
  });
});
