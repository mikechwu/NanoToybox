/**
 * Shared bond-scale sizing rule — single source of truth for the
 * poster and profile-thumb renderers.
 *
 * ## Model
 *
 * Per-atom and per-bond sizes are ruled by two inputs only:
 *   1. The projected cluster height (max − min atom coord, in
 *      viewBox units).
 *   2. The figure's pixel height (applied at the outer SVG, not
 *      here — this module speaks viewBox units).
 *
 * Physical cluster height isn't stored, but can be inferred from
 * the projected bond length (C-C ≈ 1.44 Å → px/Å = pxPerVb ·
 * bondVb / 1.44). The algebra collapses so every absolute size in
 * viewBox units is a fixed fraction of `bondVb` — the median
 * projected bond length when bonds are available, falling back to
 * the median nearest-neighbor atom distance otherwise. C60 is the
 * calibration benchmark (`K_ATOM`, `K_BOND_FILL`,
 * `K_BOND_BORDER_DELTA` chosen so C60 renders as a
 * chemistry-diagram wireframe at any surface size).
 *
 * ## Bounds (by design)
 *
 *   - `bondVb ≥ 0` → all sizes ≥ 0.
 *   - `bondVb → 0` as atoms pack tighter (infinite-atoms limit).
 *   - `bondVb ≤ cluster_height_vb` with k < 1 → sizes stay within
 *     the figure.
 *
 * ## Per-atom perspective cue
 *
 * Stored `a.r` carries the publish-time `s(z)` depth scaling.
 * Used ONLY as a ±15% relative multiplier around the median — the
 * near/far brightness cue is preserved without letting the bake's
 * absolute base-radius drive rendered size. This is what makes the
 * renderer rev-stable: legacy rows baked at any past `baseRadius`
 * render correctly.
 *
 * Pure module; no JSX, no side effects.
 */

import type {
  PreviewSceneAtomV1,
  PreviewSceneBondV1,
} from './capsule-preview-scene-store';

// ── Sizing ratios (C60-calibrated) ──

/** Atom radius as fraction of projected bond length. With C60's
 *  bondVb ≈ 20 vb, this lands atom radius ≈ 4.4 vb — chemistry-
 *  diagram weight (atom diameter / bond ≈ 0.44). */
export const K_ATOM = 0.22;

/** Bond fill (inner stroke) width as fraction of projected bond
 *  length. Doubled from the original 0.075 per the current visual
 *  direction — C60 lands at ~3 vb bond fill. */
export const K_BOND_FILL = 0.15;

/** Delta added to bond fill to form the outer cylinder border.
 *  Doubled alongside K_BOND_FILL. */
export const K_BOND_BORDER_DELTA = 0.05;

// ── Per-atom perspective clamp ──

/** Stored `a.r` → relative multiplier `clamp(a.r/median, MIN,
 *  MAX)`. Tight ±15% range matches the K=3.17 perspective span and
 *  prevents outlier stored values from dominating the render. */
export const PERSPECTIVE_MULT_MIN = 0.85;
export const PERSPECTIVE_MULT_MAX = 1.15;

// ── Cylinder-bond palette (very light gray) ──

/** Three stacked strokes simulate a lit cylinder — edge (shadow)
 *  → body (ambient) → highlight (specular). Same semantics as the
 *  atom's radial gradient, applied as concentric strokes instead. */
export const BOND_CYL_EDGE = '#8a8a8a';
export const BOND_CYL_BODY = '#c8c8c8';
export const BOND_CYL_HIGHLIGHT = '#f2f2f2';

/** Stroke-width multipliers relative to the cylinder's total width
 *  (the "bondBorderWidth" in consumers). Edge is the silhouette
 *  (100%), body is the ambient fill (75%), highlight is a thin
 *  spec line (25%). */
export const BOND_CYL_EDGE_MULT = 1.0;
export const BOND_CYL_BODY_MULT = 0.75;
export const BOND_CYL_HIGHLIGHT_MULT = 0.25;

// ── Scale helpers ──

/** Median projected bond length (viewBox units). Atom positions
 *  render at `x * 100, y * 100`, so Euclidean distance × 100 is
 *  the projected bond length in vb.
 *
 *  Returns 0 when no valid bonds exist — caller falls back to
 *  atom nearest-neighbor distance. */
export function medianBondLengthVb(
  atoms: ReadonlyArray<PreviewSceneAtomV1>,
  bonds: ReadonlyArray<PreviewSceneBondV1>,
): number {
  if (bonds.length === 0) return 0;
  const lens: number[] = [];
  for (const b of bonds) {
    const A = atoms[b.a];
    const B = atoms[b.b];
    if (!A || !B) continue;
    const dx = (A.x - B.x) * 100;
    const dy = (A.y - B.y) * 100;
    const L = Math.hypot(dx, dy);
    if (L > 0) lens.push(L);
  }
  if (lens.length === 0) return 0;
  lens.sort((a, b) => a - b);
  return lens[Math.floor(lens.length / 2)];
}

/** Median nearest-neighbor atom distance in viewBox units —
 *  fallback bond-length proxy for scenes that carry atoms but no
 *  bond list. For a bonded structure this approximates bond
 *  length; 3D→2D projection bias scales it slightly low on dense
 *  clusters, which matches the "scale → 0 as atoms → infinity"
 *  requirement. O(N²) — acceptable for realistic capsule atom
 *  counts (< 5000). */
export function medianNearestNeighborVb(
  atoms: ReadonlyArray<PreviewSceneAtomV1>,
): number {
  const n = atoms.length;
  if (n < 2) return 0;
  const mins: number[] = [];
  for (let i = 0; i < n; i++) {
    let mi = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = (atoms[i].x - atoms[j].x) * 100;
      const dy = (atoms[i].y - atoms[j].y) * 100;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6 && d < mi) mi = d;
    }
    if (Number.isFinite(mi)) mins.push(mi);
  }
  if (mins.length === 0) return 0;
  mins.sort((a, b) => a - b);
  return mins[Math.floor(mins.length / 2)];
}

/** Median of stored `a.r` — denominator for the per-atom
 *  perspective multiplier. Zero when no atom carries a finite
 *  positive radius, which the caller reads as "no perspective
 *  cue available; paint at base radius". */
export function medianStoredR(
  atoms: ReadonlyArray<PreviewSceneAtomV1>,
): number {
  const rs: number[] = [];
  for (const a of atoms) {
    if (Number.isFinite(a.r) && a.r > 0) rs.push(a.r);
  }
  if (rs.length === 0) return 0;
  rs.sort((a, b) => a - b);
  return rs[Math.floor(rs.length / 2)];
}

/** Compute the per-atom perspective multiplier — `a.r / rMedian`
 *  clamped into `[PERSPECTIVE_MULT_MIN, PERSPECTIVE_MULT_MAX]`.
 *  Returns 1 when the multiplier isn't meaningful (atom lacks a
 *  finite positive `r`, or the scene has no median signal). */
export function perspectiveMultiplier(
  storedR: number,
  rMedian: number,
): number {
  if (rMedian <= 0 || !Number.isFinite(storedR) || storedR <= 0) return 1;
  const raw = storedR / rMedian;
  return Math.max(
    PERSPECTIVE_MULT_MIN,
    Math.min(PERSPECTIVE_MULT_MAX, raw),
  );
}
