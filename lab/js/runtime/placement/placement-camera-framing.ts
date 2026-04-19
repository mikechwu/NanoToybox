/**
 * Placement camera framing — pure solver for placement preview camera assist.
 *
 * Owns: placement framing policy, camera-space framing math, safe-margin
 *   contract, desired target/distance calculation.
 * Does not: mutate renderer, read global world axes, own focus or follow state.
 * Called by: app/frame-runtime.ts during placement.
 * Teardown: stateless — no teardown needed.
 */

// ── Types (plain objects — no THREE dependency) ──

export interface PlacementFramingPoint {
  x: number;
  y: number;
  z: number;
}

export interface PlacementFramingSafeRegion {
  left: number;   // normalized half-space allowance, e.g. 0.88
  right: number;
  top: number;
  bottom: number;
}

export interface PlacementCameraBasis {
  right: PlacementFramingPoint;
  up: PlacementFramingPoint;
  forward: PlacementFramingPoint;
}

export interface PlacementFramingInput {
  points: readonly PlacementFramingPoint[];
  target: PlacementFramingPoint;
  cameraPosition: PlacementFramingPoint;
  basis: PlacementCameraBasis;
  tanX: number;
  tanY: number;
  near: number;
  nearMargin: number;
  safe: PlacementFramingSafeRegion;
  lambda: number;
  /** Overflow values below this threshold are treated as "fits". Default 0.02. */
  overflowDeadband?: number;
}

export interface PlacementFramingOverflow {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PlacementFramingGoal {
  needsAdjustment: boolean;
  desiredTarget: PlacementFramingPoint;
  desiredDistance: number;
  overflow: PlacementFramingOverflow;
}

// ── Helpers ──

function dot3(a: PlacementFramingPoint, b: PlacementFramingPoint): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// ── Public API ──

/**
 * Project world-space points into target-relative camera space.
 *
 * For each point p, returns:
 *   x = dot(p - target, right)
 *   y = dot(p - target, up)
 *   z = dot(p - target, forward)
 */
export function projectPointsToTargetCameraSpace(
  points: readonly PlacementFramingPoint[],
  target: PlacementFramingPoint,
  basis: PlacementCameraBasis,
): PlacementFramingPoint[] {
  const result: PlacementFramingPoint[] = [];
  for (const p of points) {
    const q: PlacementFramingPoint = {
      x: p.x - target.x,
      y: p.y - target.y,
      z: p.z - target.z,
    };
    result.push({
      x: dot3(q, basis.right),
      y: dot3(q, basis.up),
      z: dot3(q, basis.forward),
    });
  }
  return result;
}

/**
 * Compute the minimum camera-to-target distance that frames all projected
 * points inside the safe region after a target shift of (tx, ty) in camera plane.
 *
 * Depth of point i from camera = d + z_i.
 * Projection constraint per axis: |offset| / (depth × tan) ≤ safeLimit.
 */
export function computePlacementFitDistance(
  points: readonly PlacementFramingPoint[],
  tx: number,
  ty: number,
  tanX: number,
  tanY: number,
  near: number,
  nearMargin: number,
  safe: PlacementFramingSafeRegion,
): number {
  let dMin = near + nearMargin;

  for (const p of points) {
    const px = p.x - tx;
    const py = p.y - ty;
    const z = p.z;

    // Near-plane safety: d + z ≥ near + nearMargin
    const dNear = near + nearMargin - z;
    if (dNear > dMin) dMin = dNear;

    // Horizontal constraints
    if (px > 0) {
      const d = px / (safe.right * tanX) - z;
      if (d > dMin) dMin = d;
    } else if (px < 0) {
      const d = -px / (safe.left * tanX) - z;
      if (d > dMin) dMin = d;
    }

    // Vertical constraints
    if (py > 0) {
      const d = py / (safe.top * tanY) - z;
      if (d > dMin) dMin = d;
    } else if (py < 0) {
      const d = -py / (safe.bottom * tanY) - z;
      if (d > dMin) dMin = d;
    }
  }

  return dMin;
}

/**
 * Measure how far each projected point exceeds the safe region.
 * Returns the maximum overflow in each direction (0 = no overflow).
 */
export function measurePlacementOverflow(
  points: readonly PlacementFramingPoint[],
  tx: number,
  ty: number,
  distance: number,
  tanX: number,
  tanY: number,
  safe: PlacementFramingSafeRegion,
): PlacementFramingOverflow {
  let left = 0, right = 0, top = 0, bottom = 0;

  for (const p of points) {
    const px = p.x - tx;
    const py = p.y - ty;
    const depth = distance + p.z;
    if (depth <= 0) continue;

    const nx = px / (depth * tanX);
    const ny = py / (depth * tanY);

    if (nx > safe.right) {
      const o = nx - safe.right;
      if (o > right) right = o;
    }
    if (-nx > safe.left) {
      const o = -nx - safe.left;
      if (o > left) left = o;
    }
    if (ny > safe.top) {
      const o = ny - safe.top;
      if (o > top) top = o;
    }
    if (-ny > safe.bottom) {
      const o = -ny - safe.bottom;
      if (o > bottom) bottom = o;
    }
  }

  return { left, right, top, bottom };
}

/**
 * Compute the desired camera target and distance that keeps the full point
 * set inside the safe viewport region with minimal disruption.
 *
 * Uses an adaptive deterministic search over (tx, ty) target shifts in the
 * camera plane, with search radius derived from the actual overflow magnitude.
 * The search is centered on a first estimate from the projected bbox center
 * error, and selects the combination that minimises:
 *   cost = dFit(tx, ty) + λ √(tx² + ty²)
 *
 * Always returns a goal (even when content fits) so the caller can smoothly
 * converge. Uses an overflow deadband (default 0.02 NDC) to avoid threshold
 * jitter at the fits/doesn't-fit boundary.
 *
 * Returns null when points is empty.
 */
export function computePlacementFramingGoal(
  input: PlacementFramingInput,
): PlacementFramingGoal | null {
  const { points, target, cameraPosition, basis, tanX, tanY, near, nearMargin, safe, lambda } = input;
  const deadband = input.overflowDeadband ?? 0.02;

  if (points.length === 0) return null;

  const projected = projectPointsToTargetCameraSpace(points, target, basis);

  // Current distance from camera to target along forward axis
  const camToTarget: PlacementFramingPoint = {
    x: target.x - cameraPosition.x,
    y: target.y - cameraPosition.y,
    z: target.z - cameraPosition.z,
  };
  const currentDistance = dot3(camToTarget, basis.forward);

  // Measure current overflow at zero shift
  const currentOverflow = measurePlacementOverflow(projected, 0, 0, currentDistance, tanX, tanY, safe);

  // Fast path: everything fits within deadband — no adjustment needed
  if (currentOverflow.left <= deadband && currentOverflow.right <= deadband &&
      currentOverflow.top <= deadband && currentOverflow.bottom <= deadband) {
    const dFit0 = computePlacementFitDistance(projected, 0, 0, tanX, tanY, near, nearMargin, safe);
    if (dFit0 <= currentDistance) {
      return {
        needsAdjustment: false,
        desiredTarget: { x: target.x, y: target.y, z: target.z },
        desiredDistance: currentDistance,
        overflow: currentOverflow,
      };
    }
  }

  // ── Adaptive search ──

  // Derive search radius from overflow magnitude (not fixed tiny neighborhood)
  const overflowX = currentOverflow.right + currentOverflow.left;
  const overflowY = currentOverflow.top + currentOverflow.bottom;
  const rangeX = currentDistance * tanX * Math.max(0.12, overflowX);
  const rangeY = currentDistance * tanY * Math.max(0.12, overflowY);

  // Compute initial estimate from projected bbox center error
  // (asymmetric: positive overflow on right means target should shift right)
  const bboxShiftX = (currentOverflow.right - currentOverflow.left) * 0.5 * currentDistance * tanX;
  const bboxShiftY = (currentOverflow.top - currentOverflow.bottom) * 0.5 * currentDistance * tanY;

  let bestCost = Infinity;
  let bestTx = 0;
  let bestTy = 0;
  let bestDist = currentDistance;

  // Coarse 5×5 grid centered on bbox-derived initial estimate
  const stepX = rangeX / 2;
  const stepY = rangeY / 2;
  for (let ix = -2; ix <= 2; ix++) {
    for (let iy = -2; iy <= 2; iy++) {
      const tx = bboxShiftX + ix * stepX;
      const ty = bboxShiftY + iy * stepY;
      const dFit = computePlacementFitDistance(projected, tx, ty, tanX, tanY, near, nearMargin, safe);
      const cost = dFit + lambda * Math.sqrt(tx * tx + ty * ty);
      if (cost < bestCost) {
        bestCost = cost;
        bestTx = tx;
        bestTy = ty;
        bestDist = dFit;
      }
    }
  }

  // Refine: 3×3 around winner with quarter-range step
  const halfX = stepX / 2;
  const halfY = stepY / 2;
  const ctrTx = bestTx;
  const ctrTy = bestTy;
  for (let ix = -1; ix <= 1; ix++) {
    for (let iy = -1; iy <= 1; iy++) {
      const tx = ctrTx + ix * halfX;
      const ty = ctrTy + iy * halfY;
      const dFit = computePlacementFitDistance(projected, tx, ty, tanX, tanY, near, nearMargin, safe);
      const cost = dFit + lambda * Math.sqrt(tx * tx + ty * ty);
      if (cost < bestCost) {
        bestCost = cost;
        bestTx = tx;
        bestTy = ty;
        bestDist = dFit;
      }
    }
  }

  const r = basis.right;
  const u = basis.up;
  const desiredTarget: PlacementFramingPoint = {
    x: target.x + bestTx * r.x + bestTy * u.x,
    y: target.y + bestTx * r.y + bestTy * u.y,
    z: target.z + bestTx * r.z + bestTy * u.z,
  };

  const finalOverflow = measurePlacementOverflow(projected, bestTx, bestTy, bestDist, tanX, tanY, safe);

  return {
    needsAdjustment: true,
    desiredTarget,
    desiredDistance: bestDist,
    overflow: finalOverflow,
  };
}

// ── Visible-anchor capture ──

/**
 * Filter world-space points to only those currently visible within the
 * camera frustum's safe region. Used to capture a frozen scene anchor at
 * placement start so offscreen atoms don't inflate the framing distance.
 */
export function filterVisiblePoints(
  points: readonly PlacementFramingPoint[],
  target: PlacementFramingPoint,
  cameraPosition: PlacementFramingPoint,
  basis: PlacementCameraBasis,
  tanX: number,
  tanY: number,
  margin: number,
): PlacementFramingPoint[] {
  const d = dot3(
    { x: target.x - cameraPosition.x, y: target.y - cameraPosition.y, z: target.z - cameraPosition.z },
    basis.forward,
  );
  const visible: PlacementFramingPoint[] = [];
  for (const p of points) {
    const q = { x: p.x - target.x, y: p.y - target.y, z: p.z - target.z };
    const z = dot3(q, basis.forward);
    const depth = d + z;
    if (depth <= 0) continue;
    const nx = Math.abs(dot3(q, basis.right)) / (depth * tanX);
    const ny = Math.abs(dot3(q, basis.up)) / (depth * tanY);
    if (nx <= 1.0 + margin && ny <= 1.0 + margin) {
      visible.push({ x: p.x, y: p.y, z: p.z });
    }
  }
  return visible;
}
