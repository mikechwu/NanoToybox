/**
 * Hint-target geometry — pure helpers for picking the atom that the
 * floating atom-interaction hint should follow.
 *
 * Selection rule (per spec):
 *   1. Project every atom to the user's 2D viewport plane (NDC).
 *   2. Compute the 2D convex hull of the projected on-screen points;
 *      the hull vertices are the "cluster boundary" atoms.
 *   3. Pick the hull vertex closest to the viewport center (NDC origin).
 *   4. Tie-break on smaller atom index so the choice is deterministic
 *      across re-renders — two exactly-equidistant atoms would otherwise
 *      cause the hint to flip-flop on floating-point noise.
 *
 * The rule is deliberately geometric — no magic per-scene constants, no
 * heuristics tuned to one dataset. It adapts to rotation, zoom, and
 * atom motion without any extra configuration. Placing the hint on a
 * boundary atom keeps the bubble off the crowded interior of the scene;
 * picking the one nearest center keeps it in the user's natural gaze
 * path (the center of the 2D view plane).
 *
 * Everything in this file is pure: no DOM access, no module-level
 * state, no dependency on Three.js. The projection function is
 * injected so tests can drive deterministic inputs without a renderer.
 *
 * Owns:       Convex-hull math, centermost-pick selection.
 * Called by:  lab/js/runtime/overlay/atom-interaction-hint.ts (the runtime
 *             that binds these helpers to the live renderer + DOM).
 * Tested by:  tests/unit/hint-target.test.ts.
 */

/** A single atom projected onto the 2D view plane. */
export interface ProjectedAtom {
  /** Dense atom index (0..n-1). */
  idx: number;
  /** Normalized Device Coordinate x — viewport left=-1, right=+1. */
  ndcX: number;
  /** Normalized Device Coordinate y — viewport bottom=-1, top=+1. */
  ndcY: number;
  /** True iff atom is in front of the camera AND inside the [-1,1]
   *  NDC square. Atoms offscreen are kept in the output (with `false`)
   *  so downstream stages can reason about them uniformly, but the
   *  hint-pick stage filters them out. */
  onScreen: boolean;
}

/**
 * Project every atom from a flat positions buffer into 2D NDC via the
 * provided projector function (typically `renderer.projectToNDC`).
 *
 * Positions buffer layout: interleaved x,y,z per atom, length `n*3`.
 */
export function projectAtomsToNDC(
  positions: Float64Array | number[],
  n: number,
  projector: (world: [number, number, number]) => [number, number, number],
): ProjectedAtom[] {
  const out: ProjectedAtom[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const ndc = projector([positions[i3], positions[i3 + 1], positions[i3 + 2]]);
    const ndcX = ndc[0];
    const ndcY = ndc[1];
    const ndcZ = ndc[2];
    // Three.js project() maps the near/far range to z ∈ [-1, 1] in NDC.
    // Atoms behind the near plane project with z > 1 (or NaN). An atom
    // is "on screen" iff its NDC lies in the clip cube.
    const onScreen =
      Number.isFinite(ndcX) && Number.isFinite(ndcY) && Number.isFinite(ndcZ) &&
      ndcX >= -1 && ndcX <= 1 &&
      ndcY >= -1 && ndcY <= 1 &&
      ndcZ >= -1 && ndcZ <= 1;
    out[i] = { idx: i, ndcX, ndcY, onScreen };
  }
  return out;
}

/**
 * Andrew's monotone-chain convex hull over 2D points.
 *
 * Input: array of `{ x, y }` points.
 * Output: indices (into the input array) of hull vertices in
 *         counter-clockwise order, starting from the lowest-leftmost point.
 *
 * Properties:
 *   · O(n log n) time, O(n) space.
 *   · Collinear points on the hull are dropped — only true vertices
 *     are returned, which is what the centermost-pick stage wants.
 *   · Degenerate cases return a compact hull:
 *       n === 0 → []
 *       n === 1 → [0]
 *       n === 2 → [0, 1] (or [0] if coincident)
 *   · Stable sort — ties on x are broken on y, then on original index,
 *     so repeated calls with the same input produce identical output.
 *
 * Exported independently of `projectAtomsToNDC` so it's reusable
 * (e.g., for a future "scene footprint" overlay) and testable as a
 * pure math primitive.
 */
export function convexHull2D(points: Array<{ x: number; y: number }>): number[] {
  const n = points.length;
  if (n <= 1) return n === 0 ? [] : [0];

  // Sort original indices by (x, y, idx) — idx tiebreak keeps the
  // hull deterministic when two atoms project to the same point.
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => {
    const pa = points[a];
    const pb = points[b];
    if (pa.x !== pb.x) return pa.x - pb.x;
    if (pa.y !== pb.y) return pa.y - pb.y;
    return a - b;
  });

  // Cross product of OA × OB. Positive → counter-clockwise turn.
  const cross = (o: number, a: number, b: number): number => {
    const po = points[o];
    const pa = points[a];
    const pb = points[b];
    return (pa.x - po.x) * (pb.y - po.y) - (pa.y - po.y) * (pb.x - po.x);
  };

  // Deduplicate coincident points in sorted order — keeps the hull
  // clean when multiple atoms overlap in projection.
  const sorted: number[] = [];
  for (const idx of order) {
    const last = sorted[sorted.length - 1];
    if (last !== undefined && points[last].x === points[idx].x && points[last].y === points[idx].y) {
      continue;
    }
    sorted.push(idx);
  }
  if (sorted.length <= 2) return sorted;

  // Build lower hull.
  const lower: number[] = [];
  for (const idx of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], idx) <= 0) {
      lower.pop();
    }
    lower.push(idx);
  }

  // Build upper hull.
  const upper: number[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const idx = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], idx) <= 0) {
      upper.pop();
    }
    upper.push(idx);
  }

  // Concatenate (drop the last point of each half — they're the
  // first points of the other half).
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Pick the atom whose projection is on the on-screen hull AND closest
 * to the viewport center (NDC origin). Returns the atom's dense index
 * or `null` when the scene has no on-screen atoms.
 *
 * Uniqueness: when two hull atoms tie on squared-distance to center,
 * the smaller dense index wins. Two distinct atoms cannot tie on
 * (distance, idx) — the pick is always a single atom.
 *
 * Stability note: the hint-runtime caller should lock the returned
 * index across frames (the brief says the hint "follows a specific
 * atom"). Re-invoking this function each frame would cause the hint
 * to teleport as atoms jitter across the hull boundary.
 */
export function pickCentermostHullAtom(projected: ProjectedAtom[]): number | null {
  const onScreen = projected.filter((p) => p.onScreen);
  if (onScreen.length === 0) return null;
  if (onScreen.length === 1) return onScreen[0].idx;

  // Feed on-screen projections to the hull routine. Map hull output
  // (indices into `onScreen`) back to atom dense indices.
  const hullOrder = convexHull2D(
    onScreen.map((p) => ({ x: p.ndcX, y: p.ndcY })),
  );
  if (hullOrder.length === 0) return null;

  // Fewer than 3 unique points → everything we have IS the hull.
  // Fall back to "pick closest-to-center among all on-screen atoms"
  // rather than returning an arbitrary edge point.
  const candidatesLocal = hullOrder.length >= 3
    ? hullOrder.map((i) => onScreen[i])
    : onScreen;

  let bestIdx = -1;
  let bestDist = Infinity;
  for (const p of candidatesLocal) {
    const d = p.ndcX * p.ndcX + p.ndcY * p.ndcY;
    // Deterministic tiebreak: smaller atom index wins on ties.
    if (d < bestDist || (d === bestDist && p.idx < bestIdx)) {
      bestDist = d;
      bestIdx = p.idx;
    }
  }
  return bestIdx === -1 ? null : bestIdx;
}

/**
 * One-shot target picker — the typical entrypoint for consumers.
 * Composes the three stages above. Returns `null` when the scene has
 * no renderable atoms yet (caller should simply retry on the next
 * scene-ready tick).
 */
export function pickHintTargetAtom(
  positions: Float64Array | number[],
  n: number,
  projector: (world: [number, number, number]) => [number, number, number],
): number | null {
  if (n <= 0) return null;
  const projected = projectAtomsToNDC(positions, n, projector);
  return pickCentermostHullAtom(projected);
}

// ─────────────────────────────────────────────────────────────────────
// Outside-the-hull placement helpers
//
// The hint must sit OUTSIDE the 2D convex hull of projected atoms so
// the bubble never overlaps a cluster. The runtime reasons about this
// in screen pixels: it computes the cluster centroid, takes the
// outward direction from centroid to the target atom (which is on the
// hull boundary by construction of `pickCentermostHullAtom`), and
// pushes the hint along that direction by a distance that includes
// the atom's own screen radius, a user gap, the half-extent of the
// bubble in that direction, and a small hull safety pad. All of that
// math is pure geometry; the two helpers below are the shared
// primitives so the runtime and tests use identical formulas.
// ─────────────────────────────────────────────────────────────────────

/**
 * Average NDC position of on-screen atoms — the "cluster centroid"
 * in screen space. Returns `null` when no atom is on-screen. Not the
 * hull centroid — using all on-screen atoms rather than hull vertices
 * biases the centroid toward denser regions, which gives a more
 * perceptually-central "inward" reference for outward placement.
 */
export function computeOnScreenCentroid(
  projected: ProjectedAtom[],
): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const p of projected) {
    if (!p.onScreen) continue;
    sx += p.ndcX;
    sy += p.ndcY;
    count++;
  }
  if (count === 0) return null;
  return { x: sx / count, y: sy / count };
}

/**
 * Ray from the center of an axis-aligned box to the box boundary along
 * a given direction. Returns the parametric distance `t` (in the same
 * units as the half-extents) where the ray exits the box; useful for
 * positioning the tail of a bubble so its base sits flush with the
 * bubble edge in an arbitrary direction.
 *
 * Inputs
 *   halfW, halfH : box half-extents (positive). Box spans
 *                  `[-halfW, halfW] × [-halfH, halfH]`.
 *   dx, dy       : ray direction. Need not be normalized.
 *
 * Output
 *   Distance `t >= 0` along `(dx, dy)` to reach the boundary. For a
 *   zero-length direction (dx=dy=0), returns 0 (degenerate).
 *
 * Numerical note
 *   When `dx` or `dy` is zero the corresponding slab contributes no
 *   constraint — treat as `+Infinity` so the other axis dominates.
 */
export function rayBoxExit(
  halfW: number,
  halfH: number,
  dx: number,
  dy: number,
): number {
  if (dx === 0 && dy === 0) return 0;
  const tx = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const ty = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const t = Math.min(tx, ty);
  return Number.isFinite(t) ? t : 0;
}
