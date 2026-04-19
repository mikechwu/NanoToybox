/**
 * Placement camera framing — pure math tests.
 *
 * Covers the mandatory test contract from the plan:
 *   A1. No adjustment when content already fits
 *   A2. Target shifts toward preview edge pressure
 *   A3. Distance increases when shift alone insufficient
 *   A4. Asymmetric margins are respected
 *   A5. Near-plane safety is enforced
 *   A6. Orientation independence
 */
import { describe, it, expect } from 'vitest';
import {
  projectPointsToTargetCameraSpace,
  computePlacementFitDistance,
  measurePlacementOverflow,
  computePlacementFramingGoal,
  filterVisiblePoints,
  type PlacementFramingInput,
  type PlacementFramingPoint,
  type PlacementCameraBasis,
  type PlacementFramingSafeRegion,
} from '../../lab/js/runtime/placement/placement-camera-framing';

// ── Helpers ──

/** Standard camera-aligned basis: right=+X, up=+Y, forward=-Z → but we define
 *  forward as the camera look direction. With a standard Three.js camera at
 *  origin looking along -Z: forward = (0,0,-1). But the solver defines
 *  forward as camera→target direction. If target is at (0,0,0) and camera
 *  at (0,0,10), forward = (0,0,-1). */
const STANDARD_BASIS: PlacementCameraBasis = {
  right:   { x: 1, y: 0, z: 0 },
  up:      { x: 0, y: 1, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
};

const STANDARD_SAFE: PlacementFramingSafeRegion = {
  left: 0.88, right: 0.88, top: 0.90, bottom: 0.82,
};

/** FOV 50° vertical, 16:9 aspect */
const FOV_DEG = 50;
const ASPECT = 16 / 9;
const TAN_Y = Math.tan((FOV_DEG / 2) * Math.PI / 180);
const TAN_X = TAN_Y * ASPECT;

function makeInput(overrides: Partial<PlacementFramingInput> = {}): PlacementFramingInput {
  return {
    points: [],
    target: { x: 0, y: 0, z: 0 },
    cameraPosition: { x: 0, y: 0, z: 20 },
    basis: STANDARD_BASIS,
    tanX: TAN_X,
    tanY: TAN_Y,
    near: 0.1,
    nearMargin: 0.5,
    safe: STANDARD_SAFE,
    lambda: 0.15,
    ...overrides,
  };
}

// ── A. Pure math tests ──

describe('placement-camera-framing: projectPointsToTargetCameraSpace', () => {
  it('projects points relative to target in camera basis', () => {
    const points: PlacementFramingPoint[] = [
      { x: 5, y: 3, z: -2 },
    ];
    const target: PlacementFramingPoint = { x: 0, y: 0, z: 0 };
    const result = projectPointsToTargetCameraSpace(points, target, STANDARD_BASIS);

    // With standard basis: x→right, y→up, z*forward where forward=(0,0,-1)
    expect(result).toHaveLength(1);
    expect(result[0].x).toBeCloseTo(5);   // dot((5,3,-2), (1,0,0)) = 5
    expect(result[0].y).toBeCloseTo(3);   // dot((5,3,-2), (0,1,0)) = 3
    expect(result[0].z).toBeCloseTo(2);   // dot((5,3,-2), (0,0,-1)) = 2
  });
});

describe('placement-camera-framing: A1 — no adjustment when content fits', () => {
  it('returns needsAdjustment=false when scene+preview inside safe region', () => {
    // Small cluster centered near target, well within view at distance 20
    const points: PlacementFramingPoint[] = [
      { x: 1, y: 1, z: 0 },
      { x: -1, y: -1, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: -2, y: 0, z: 0 },
    ];

    const input = makeInput({ points });
    const goal = computePlacementFramingGoal(input);

    expect(goal).not.toBeNull();
    expect(goal!.needsAdjustment).toBe(false);
  });

  it('returns null for empty points', () => {
    const goal = computePlacementFramingGoal(makeInput({ points: [] }));
    expect(goal).toBeNull();
  });
});

describe('placement-camera-framing: A2 — target shifts toward edge pressure', () => {
  it('shifts target right when preview is displaced right', () => {
    // Scene atoms centered, preview far to the right
    const scenePoints: PlacementFramingPoint[] = [
      { x: 0, y: 0, z: 0 },
    ];
    // Preview far right — will push beyond safe.right at distance 20
    const previewPoints: PlacementFramingPoint[] = [
      { x: 15, y: 0, z: 0 },
    ];
    const points = [...scenePoints, ...previewPoints];

    const input = makeInput({ points });
    const goal = computePlacementFramingGoal(input);

    expect(goal).not.toBeNull();
    expect(goal!.needsAdjustment).toBe(true);
    // desiredTarget should shift right (positive X) relative to original (0,0,0)
    expect(goal!.desiredTarget.x).toBeGreaterThan(0);
    // No world-axis assumption in the test — we only check camera-plane direction
  });
});

describe('placement-camera-framing: A3 — distance increases when shift insufficient', () => {
  it('increases distance for very wide scene+preview union', () => {
    // Points spanning very wide — no target shift can fit them without zoom-out
    const points: PlacementFramingPoint[] = [
      { x: -20, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
      { x: 0, y: -15, z: 0 },
      { x: 0, y: 15, z: 0 },
    ];

    const input = makeInput({ points });
    const goal = computePlacementFramingGoal(input);

    expect(goal).not.toBeNull();
    expect(goal!.needsAdjustment).toBe(true);
    // Camera distance from target along forward is 20 (camera at z=20, target at z=0, forward=(0,0,-1))
    // desiredDistance should be larger than 20 to fit the wide spread
    expect(goal!.desiredDistance).toBeGreaterThan(20);
  });
});

describe('placement-camera-framing: A4 — asymmetric margins respected', () => {
  it('handles larger bottom inset by increasing distance or shifting', () => {
    const asymmetricSafe: PlacementFramingSafeRegion = {
      left: 0.88, right: 0.88, top: 0.90,
      bottom: 0.50,  // much smaller bottom allowance
    };

    // Point that is at the bottom edge — should overflow with tight bottom margin
    // At distance 20, the bottom limit is: 20 * tanY * 0.50
    const bottomLimit = 20 * TAN_Y * 0.50;
    const points: PlacementFramingPoint[] = [
      { x: 0, y: -(bottomLimit + 2), z: 0 }, // slightly beyond bottom margin
    ];

    const input = makeInput({ points, safe: asymmetricSafe });
    const goal = computePlacementFramingGoal(input);

    expect(goal).not.toBeNull();
    expect(goal!.needsAdjustment).toBe(true);

    // The solver should accommodate the tight bottom either by shifting target down
    // or by increasing distance
    const dFitSymmetric = computePlacementFitDistance(
      projectPointsToTargetCameraSpace(points, { x: 0, y: 0, z: 0 }, STANDARD_BASIS),
      0, 0, TAN_X, TAN_Y, 0.1, 0.5, STANDARD_SAFE,
    );
    const dFitAsymmetric = computePlacementFitDistance(
      projectPointsToTargetCameraSpace(points, { x: 0, y: 0, z: 0 }, STANDARD_BASIS),
      0, 0, TAN_X, TAN_Y, 0.1, 0.5, asymmetricSafe,
    );
    // Asymmetric bottom requires more distance at zero shift
    expect(dFitAsymmetric).toBeGreaterThan(dFitSymmetric);
  });
});

describe('placement-camera-framing: A5 — near-plane safety enforced', () => {
  it('ensures minimum distance respects near plane + margin', () => {
    // Point very close to camera along forward axis
    // Camera at z=20, target at z=0, forward=(0,0,-1)
    // Point at z=19 → camera-space z = dot((0,0,19)-(0,0,0), (0,0,-1)) = -19
    // depth = d + z. If d=20, depth=20+(-19)=1. Near+margin=0.6.
    // But what if the point is at z=19.8? depth=20+(-19.8)=0.2 < 0.6
    const points: PlacementFramingPoint[] = [
      { x: 0, y: 0, z: 19.8 }, // very close to camera
    ];

    const input = makeInput({ points, near: 0.1, nearMargin: 0.5 });
    const projected = projectPointsToTargetCameraSpace(points, { x: 0, y: 0, z: 0 }, STANDARD_BASIS);
    // projected z = dot((0,0,19.8), (0,0,-1)) = -19.8

    const dFit = computePlacementFitDistance(projected, 0, 0, TAN_X, TAN_Y, 0.1, 0.5, STANDARD_SAFE);
    // d >= near + nearMargin - z = 0.1 + 0.5 - (-19.8) = 20.4
    expect(dFit).toBeGreaterThanOrEqual(20.4 - 0.001);

    const goal = computePlacementFramingGoal(input);
    expect(goal).not.toBeNull();
    expect(goal!.needsAdjustment).toBe(true);
    expect(goal!.desiredDistance).toBeGreaterThanOrEqual(20.4 - 0.001);
  });
});

describe('placement-camera-framing: A6 — orientation independence', () => {
  it('produces equivalent framing for rotated camera basis with same logical layout', () => {
    // Standard: right=X, up=Y, forward=-Z → camera at (0,0,20), target at origin
    const standardPoints: PlacementFramingPoint[] = [
      { x: 5, y: 3, z: 0 },
      { x: -4, y: -2, z: 0 },
    ];
    const standardInput = makeInput({ points: standardPoints });
    const standardGoal = computePlacementFramingGoal(standardInput);

    // 90° rotation about Y: right=Z, up=Y, forward=X
    // Camera at (-20, 0, 0), target at origin, looking along +X
    const rotatedBasis: PlacementCameraBasis = {
      right:   { x: 0, y: 0, z: 1 },
      up:      { x: 0, y: 1, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
    };
    // Same logical layout in camera space: 5 right, 3 up → world Z=5, Y=3
    const rotatedPoints: PlacementFramingPoint[] = [
      { x: 0, y: 3, z: 5 },
      { x: 0, y: -2, z: -4 },
    ];
    const rotatedInput = makeInput({
      points: rotatedPoints,
      cameraPosition: { x: -20, y: 0, z: 0 },
      basis: rotatedBasis,
    });
    const rotatedGoal = computePlacementFramingGoal(rotatedInput);

    expect(standardGoal).not.toBeNull();
    expect(rotatedGoal).not.toBeNull();

    // Same logical layout → same needsAdjustment decision
    expect(rotatedGoal!.needsAdjustment).toBe(standardGoal!.needsAdjustment);

    // Same desired distance (within tolerance)
    expect(rotatedGoal!.desiredDistance).toBeCloseTo(standardGoal!.desiredDistance, 4);

    // Same overflow
    expect(rotatedGoal!.overflow.left).toBeCloseTo(standardGoal!.overflow.left, 4);
    expect(rotatedGoal!.overflow.right).toBeCloseTo(standardGoal!.overflow.right, 4);
    expect(rotatedGoal!.overflow.top).toBeCloseTo(standardGoal!.overflow.top, 4);
    expect(rotatedGoal!.overflow.bottom).toBeCloseTo(standardGoal!.overflow.bottom, 4);
  });
});

// ── B. Overflow measurement ──

describe('placement-camera-framing: measurePlacementOverflow', () => {
  it('returns zero overflow when all points inside safe region', () => {
    const projected: PlacementFramingPoint[] = [
      { x: 1, y: 1, z: 0 },
      { x: -1, y: -1, z: 0 },
    ];
    const overflow = measurePlacementOverflow(projected, 0, 0, 20, TAN_X, TAN_Y, STANDARD_SAFE);
    expect(overflow.left).toBe(0);
    expect(overflow.right).toBe(0);
    expect(overflow.top).toBe(0);
    expect(overflow.bottom).toBe(0);
  });

  it('detects right overflow', () => {
    // At distance 20, right limit = 20 * TAN_X * 0.88
    const rightLimit = 20 * TAN_X * STANDARD_SAFE.right;
    const projected: PlacementFramingPoint[] = [
      { x: rightLimit + 1, y: 0, z: 0 },
    ];
    const overflow = measurePlacementOverflow(projected, 0, 0, 20, TAN_X, TAN_Y, STANDARD_SAFE);
    expect(overflow.right).toBeGreaterThan(0);
    expect(overflow.left).toBe(0);
  });
});

// ── C. computePlacementFitDistance ──

describe('placement-camera-framing: computePlacementFitDistance', () => {
  it('returns near+margin for points at target with no offset', () => {
    const projected: PlacementFramingPoint[] = [
      { x: 0, y: 0, z: 0 },
    ];
    const dFit = computePlacementFitDistance(projected, 0, 0, TAN_X, TAN_Y, 0.1, 0.5, STANDARD_SAFE);
    // Point at target center → only near-plane constraint applies
    expect(dFit).toBeCloseTo(0.6);
  });

  it('increases with lateral offset', () => {
    const projected: PlacementFramingPoint[] = [
      { x: 10, y: 0, z: 0 },
    ];
    const dFit = computePlacementFitDistance(projected, 0, 0, TAN_X, TAN_Y, 0.1, 0.5, STANDARD_SAFE);
    // d >= 10 / (0.88 * TAN_X) - 0 = ...
    const expected = 10 / (STANDARD_SAFE.right * TAN_X);
    expect(dFit).toBeCloseTo(expected, 4);
  });

  it('target shift reduces required distance', () => {
    const projected: PlacementFramingPoint[] = [
      { x: 10, y: 0, z: 0 },
    ];
    const dNoShift = computePlacementFitDistance(projected, 0, 0, TAN_X, TAN_Y, 0.1, 0.5, STANDARD_SAFE);
    const dWithShift = computePlacementFitDistance(projected, 5, 0, TAN_X, TAN_Y, 0.1, 0.5, STANDARD_SAFE);
    expect(dWithShift).toBeLessThan(dNoShift);
  });
});

// ── D. Visible-anchor filter ──

describe('placement-camera-framing: filterVisiblePoints', () => {
  it('keeps visible points and rejects offscreen ones', () => {
    // Camera at (0,0,20), target at origin, looking along -Z
    const visible: PlacementFramingPoint[] = [
      { x: 1, y: 1, z: 0 },   // near center — visible
      { x: -2, y: 0, z: 0 },  // near center — visible
    ];
    const offscreen: PlacementFramingPoint[] = [
      { x: 100, y: 0, z: 0 },  // way off to the right
      { x: 0, y: 80, z: 0 },   // way above
    ];
    const all = [...visible, ...offscreen];

    const result = filterVisiblePoints(
      all,
      { x: 0, y: 0, z: 0 },     // target
      { x: 0, y: 0, z: 20 },     // cameraPosition
      STANDARD_BASIS,
      TAN_X, TAN_Y,
      0.15,                        // margin
    );

    // Only the 2 visible points should pass
    expect(result).toHaveLength(2);
    expect(result[0].x).toBeCloseTo(1);
    expect(result[1].x).toBeCloseTo(-2);
  });
});

// ── E. Targeted regression tests ──

describe('placement-camera-framing: R1 — visible-anchor vs offscreen atoms', () => {
  it('offscreen atoms must not inflate framing distance', () => {
    // Scene has visible atoms near center + far offscreen atoms
    const visibleAnchor: PlacementFramingPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 1, z: 0 },
    ];
    const preview: PlacementFramingPoint[] = [
      { x: 8, y: 0, z: 0 },
    ];

    // Solve with visible anchor only (correct behavior)
    const inputAnchor = makeInput({ points: [...visibleAnchor, ...preview] });
    const goalAnchor = computePlacementFramingGoal(inputAnchor);

    // Solve with full scene including far offscreen atoms (wrong behavior)
    const offscreenAtoms: PlacementFramingPoint[] = [
      { x: 80, y: 0, z: 0 },
      { x: -60, y: 40, z: 0 },
    ];
    const inputFull = makeInput({ points: [...visibleAnchor, ...offscreenAtoms, ...preview] });
    const goalFull = computePlacementFramingGoal(inputFull);

    expect(goalAnchor).not.toBeNull();
    expect(goalFull).not.toBeNull();

    // The visible-anchor solve should need significantly less distance
    expect(goalAnchor!.desiredDistance).toBeLessThan(goalFull!.desiredDistance * 0.8);
  });
});

describe('placement-camera-framing: R2 — edge-drag target-shift preference', () => {
  it('solver should shift target materially before large distance growth', () => {
    // Preview dragged past the right safe boundary — triggers overflow
    // At distance 20: right limit = 20 * TAN_X * 0.88 ≈ 14.6 Å
    const anchor: PlacementFramingPoint[] = [
      { x: 0, y: 0, z: 0 },
    ];
    const preview: PlacementFramingPoint[] = [
      { x: 18, y: 0, z: 0 },  // clearly past the safe right boundary
    ];

    const input = makeInput({ points: [...anchor, ...preview] });
    const goal = computePlacementFramingGoal(input);

    expect(goal).not.toBeNull();
    expect(goal!.needsAdjustment).toBe(true);

    // desiredTarget should shift right (positive X) materially
    expect(goal!.desiredTarget.x).toBeGreaterThan(1.0);

    // desiredDistance should not be excessive — the shift should absorb most pressure
    expect(goal!.desiredDistance).toBeLessThan(28);
  });
});

describe('placement-camera-framing: R3 — no over-depth on moderate lateral drag', () => {
  it('moderate lateral drag should not cause excessive distance increase', () => {
    // Anchor centered, preview at moderate right offset
    const anchor: PlacementFramingPoint[] = [
      { x: -3, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
    ];
    const preview: PlacementFramingPoint[] = [
      { x: 10, y: 0, z: 0 },
    ];

    const input = makeInput({ points: [...anchor, ...preview] });
    const goal = computePlacementFramingGoal(input);

    expect(goal).not.toBeNull();

    // Distance increase should stay within 1.5× of current (20)
    // The solver should prefer shifting target right rather than backing away
    expect(goal!.desiredDistance).toBeLessThan(20 * 1.5);
  });
});

// ── F. Cursor-lock drag geometry regression tests ──

describe('placement drag cursor-lock: grabbed-point plane geometry', () => {
  /**
   * Simulate the full drag math as implemented in PlacementController:
   *
   * At pointerdown:
   *   grabVectorWorld = hitPoint - currentPreviewCenter
   *     (where currentPreviewCenter = basePreviewCenter + currentOffset)
   *   basePreviewCenter is frozen at placement start (atoms' world centroid before drag)
   *
   * On every move (and per-frame reprojection):
   *   1. grabbedPoint = baseCenter + currentOffset + grabVector
   *   2. plane through grabbedPoint with current camera normal
   *   3. intersect cursor ray with that plane
   *   4. newOffset = (rayPlaneHit - grabVector) - basePreviewCenter
   *
   * previewOffset is a GROUP DISPLACEMENT added to world-positioned atoms,
   * not an absolute world center.
   */
  function simulateDragOffset(opts: {
    basePreviewCenter: [number, number, number];
    currentOffset: [number, number, number];
    hitPoint: [number, number, number];
    cameraNormal: [number, number, number];
    rayOrigin: [number, number, number];
    rayDir: [number, number, number];
  }): [number, number, number] {
    const { basePreviewCenter, currentOffset, hitPoint, cameraNormal, rayOrigin, rayDir } = opts;
    const base = basePreviewCenter;
    // grabVectorWorld = hitPoint - currentPreviewCenter (as controller computes it)
    const currentCenter = [base[0] + currentOffset[0], base[1] + currentOffset[1], base[2] + currentOffset[2]];
    const gv = [hitPoint[0] - currentCenter[0], hitPoint[1] - currentCenter[1], hitPoint[2] - currentCenter[2]];
    // Plane through current grabbed point = base + offset + grabVector
    const planePoint = [
      base[0] + currentOffset[0] + gv[0],
      base[1] + currentOffset[1] + gv[1],
      base[2] + currentOffset[2] + gv[2],
    ];
    const n = cameraNormal;
    const denom = rayDir[0] * n[0] + rayDir[1] * n[1] + rayDir[2] * n[2];
    if (Math.abs(denom) < 1e-10) return currentOffset;
    const diff = [planePoint[0] - rayOrigin[0], planePoint[1] - rayOrigin[1], planePoint[2] - rayOrigin[2]];
    const t = (diff[0] * n[0] + diff[1] * n[1] + diff[2] * n[2]) / denom;
    const worldPos = [rayOrigin[0] + rayDir[0] * t, rayOrigin[1] + rayDir[1] * t, rayOrigin[2] + rayDir[2] * t];
    // newOffset = (rayPlaneHit - grabVector) - basePreviewCenter
    return [
      worldPos[0] - gv[0] - base[0],
      worldPos[1] - gv[1] - base[1],
      worldPos[2] - gv[2] - base[2],
    ];
  }

  it('off-center hit + same-cursor move produces zero offset (origin-centered preview)', () => {
    const base: [number, number, number] = [0, 0, 0];
    const hitPoint: [number, number, number] = [3, 2, 0];
    const cameraPos: [number, number, number] = [0, 0, 20];
    const toHit = [hitPoint[0] - cameraPos[0], hitPoint[1] - cameraPos[1], hitPoint[2] - cameraPos[2]];
    const len = Math.sqrt(toHit[0] ** 2 + toHit[1] ** 2 + toHit[2] ** 2);
    const rayDir: [number, number, number] = [toHit[0] / len, toHit[1] / len, toHit[2] / len];

    const newOffset = simulateDragOffset({
      basePreviewCenter: base,
      currentOffset: [0, 0, 0],
      hitPoint,
      cameraNormal: [0, 0, -1],
      rayOrigin: cameraPos,
      rayDir,
    });

    expect(newOffset[0]).toBeCloseTo(0, 6);
    expect(newOffset[1]).toBeCloseTo(0, 6);
    expect(newOffset[2]).toBeCloseTo(0, 6);
  });

  it('off-center hit + same-cursor move produces zero offset (non-origin preview at [12,5,0])', () => {
    // THIS is the key regression: base center away from origin must not cause a jump
    const base: [number, number, number] = [12, 5, 0];
    const hitPoint: [number, number, number] = [15, 7, 0]; // atom 3Å right, 2Å up from center
    const cameraPos: [number, number, number] = [12, 5, 20]; // camera looking at base center
    const toHit = [hitPoint[0] - cameraPos[0], hitPoint[1] - cameraPos[1], hitPoint[2] - cameraPos[2]];
    const len = Math.sqrt(toHit[0] ** 2 + toHit[1] ** 2 + toHit[2] ** 2);
    const rayDir: [number, number, number] = [toHit[0] / len, toHit[1] / len, toHit[2] / len];

    const newOffset = simulateDragOffset({
      basePreviewCenter: base,
      currentOffset: [0, 0, 0],
      hitPoint,
      cameraNormal: [0, 0, -1],
      rayOrigin: cameraPos,
      rayDir,
    });

    // Offset must be zero — the preview group should not jump
    expect(newOffset[0]).toBeCloseTo(0, 6);
    expect(newOffset[1]).toBeCloseTo(0, 6);
    expect(newOffset[2]).toBeCloseTo(0, 6);
  });

  it('small cursor move produces proportional small offset (non-origin preview)', () => {
    const base: [number, number, number] = [12, 5, 0];
    const hitPoint: [number, number, number] = [15, 7, 0];
    const cameraPos: [number, number, number] = [12, 5, 20];
    const smallShift = 20 * Math.tan(25 * Math.PI / 180) / 500; // ~0.019 Å per px
    const target: [number, number, number] = [hitPoint[0] + smallShift, hitPoint[1], hitPoint[2]];
    const toTarget = [target[0] - cameraPos[0], target[1] - cameraPos[1], target[2] - cameraPos[2]];
    const len = Math.sqrt(toTarget[0] ** 2 + toTarget[1] ** 2 + toTarget[2] ** 2);
    const rayDir: [number, number, number] = [toTarget[0] / len, toTarget[1] / len, toTarget[2] / len];

    const newOffset = simulateDragOffset({
      basePreviewCenter: base,
      currentOffset: [0, 0, 0],
      hitPoint,
      cameraNormal: [0, 0, -1],
      rayOrigin: cameraPos,
      rayDir,
    });

    expect(Math.abs(newOffset[0])).toBeLessThan(0.05);
    expect(Math.abs(newOffset[1])).toBeLessThan(0.01);
    expect(Math.abs(newOffset[2])).toBeLessThan(0.01);
  });

  it('camera rotation between down and move does not cause jump (non-origin preview)', () => {
    const base: [number, number, number] = [12, 5, 0];
    const hitPoint: [number, number, number] = [15, 7, 0];
    const angle = 5 * Math.PI / 180;
    const newNormal: [number, number, number] = [-Math.sin(angle), 0, -Math.cos(angle)];
    const newCamPos: [number, number, number] = [12 + 20 * Math.sin(angle), 5, 20 * Math.cos(angle)];
    const toHit = [hitPoint[0] - newCamPos[0], hitPoint[1] - newCamPos[1], hitPoint[2] - newCamPos[2]];
    const len = Math.sqrt(toHit[0] ** 2 + toHit[1] ** 2 + toHit[2] ** 2);
    const rayDir: [number, number, number] = [toHit[0] / len, toHit[1] / len, toHit[2] / len];

    const newOffset = simulateDragOffset({
      basePreviewCenter: base,
      currentOffset: [0, 0, 0],
      hitPoint,
      cameraNormal: newNormal,
      rayOrigin: newCamPos,
      rayDir,
    });

    expect(Math.abs(newOffset[0])).toBeLessThan(0.5);
    expect(Math.abs(newOffset[1])).toBeLessThan(0.5);
    expect(Math.abs(newOffset[2])).toBeLessThan(0.5);
  });
});

// Pointer-capture lifecycle tests live in tests/unit/placement-drag-lifecycle.test.ts
// (controller-path regressions that exercise real PlacementController handlers).
