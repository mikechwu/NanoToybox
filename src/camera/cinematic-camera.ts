/**
 * Cinematic Camera — shared pure math + state helpers for the Watch
 * default-on automatic framing mode.
 *
 * Framework-free / WebGL-free by design. Watch's
 * `watch/js/view/watch-cinematic-camera.ts` adapter plugs this into its
 * renderer + bonded-groups services; Lab reuse works the same way.
 *
 * Owns:
 *   - `cinematicSpeedProfile(playbackSpeed)` — decoupled motion vs.
 *     refresh scaling.
 *   - `resolveCinematicTarget(candidates, resolveAtomPosition, cfg)`
 *     — aggregate center/radius for the eligible-large-cluster set,
 *     with null-handling per the Selection Rule (skip null groups +
 *     null atoms; return null when the resolved subset is too small).
 *   - `isUserInputCooldownActive(lastInteractionAtMs, nowMs, cfg)` —
 *     wall-clock cooldown predicate.
 *
 * Does NOT own renderer state, RAF timing, or React.
 */

import { SMALL_CLUSTER_THRESHOLD } from '../history/bonded-group-utils';
import { VIEWER_DEFAULTS } from '../config/viewer-defaults';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Per-speed tuning coefficients. Factored out so Watch and Lab can
 * reuse the same profile math with different motion/refresh curves
 * (e.g. Lab's interactive scene wants faster refresh; Watch's
 * playback wants smoother, more cinematic motion).
 */
export interface CinematicSpeedTuning {
  /** Target-refresh rate at playback speed = 1×. 2 Hz by default. */
  baselineRefreshHz: number;
  /** Hard floor on the refresh rate (guards ultra-slow playback). */
  minRefreshHz: number;
  /** Hard ceiling on the refresh rate (guards ultra-fast playback). */
  maxRefreshHz: number;

  /** Exponent on playback speed for the refresh scaling factor
   *  (0.5 = √speed). Controls how aggressively the sampler speeds
   *  up vs. playback. */
  refreshScaleExponent: number;
  /** Lower clamp on the refreshScale factor before applying it. */
  minRefreshScale: number;
  /** Upper clamp on the refreshScale factor before applying it. */
  maxRefreshScale: number;

  /** Exponent on playback speed for motion scaling (smoothing).
   *  Lower than refresh so motion stays calm at high speeds. */
  motionScaleExponent: number;
  /** Lower clamp on the motionScale factor. */
  minMotionScale: number;
  /** Upper clamp on the motionScale factor — prevents frantic
   *  smoothing at 20× playback. */
  maxMotionScale: number;

  /** Target-lerp smoothing at 1× (seconds^-1 feeding the exponential
   *  ease). Scaled by motionScale at other speeds. */
  targetSmoothingAt1x: number;
  /** Camera-distance GROW smoothing at 1× (camera pulling back). */
  distanceGrowSmoothingAt1x: number;
  /** Camera-distance SHRINK smoothing at 1× (camera dolly-in). */
  distanceShrinkSmoothingAt1x: number;
  /** Cap on the motion-scale factor used for dolly-in specifically.
   *  Shrink should never feel frantic, even at 20× playback. */
  maxShrinkMotionScale: number;

  /** If false, the camera will never dolly closer — only pull back. */
  allowDistanceShrink: boolean;
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize a `CinematicSpeedTuning` — every numeric coefficient is
 * snapped to a usable value (falling back to the matching field in
 * `fallback`). Prevents typos / API misuse / config import bugs from
 * producing Infinity refresh intervals, negative smoothing, or NaN
 * exponents. Also enforces `minRefreshHz <= maxRefreshHz` so the
 * subsequent clamp cannot invert the bounds.
 *
 * Exported for callers that want to validate user-supplied tuning
 * once up-front instead of on every call (e.g. a UI that accepts
 * JSON).
 */
export function normalizeCinematicSpeedTuning(
  tuning: CinematicSpeedTuning,
  fallback: CinematicSpeedTuning = DEFAULT_CINEMATIC_SPEED_TUNING,
): CinematicSpeedTuning {
  const baselineRefreshHz = positiveFinite(tuning.baselineRefreshHz, fallback.baselineRefreshHz);
  const minRefreshHz = positiveFinite(tuning.minRefreshHz, fallback.minRefreshHz);
  const maxRefreshHz = Math.max(
    positiveFinite(tuning.maxRefreshHz, fallback.maxRefreshHz),
    minRefreshHz,
  );

  // Each min/max pair must satisfy min ≤ max or `clamp()` silently
  // inverts its bounds and produces nonsensical output. Coerce after
  // validating each bound individually.
  const minRefreshScale = positiveFinite(tuning.minRefreshScale, fallback.minRefreshScale);
  const maxRefreshScale = Math.max(
    positiveFinite(tuning.maxRefreshScale, fallback.maxRefreshScale),
    minRefreshScale,
  );
  const minMotionScale = positiveFinite(tuning.minMotionScale, fallback.minMotionScale);
  const maxMotionScale = Math.max(
    positiveFinite(tuning.maxMotionScale, fallback.maxMotionScale),
    minMotionScale,
  );

  return {
    baselineRefreshHz,
    minRefreshHz,
    maxRefreshHz,
    refreshScaleExponent: finiteOr(tuning.refreshScaleExponent, fallback.refreshScaleExponent),
    minRefreshScale,
    maxRefreshScale,
    motionScaleExponent: finiteOr(tuning.motionScaleExponent, fallback.motionScaleExponent),
    minMotionScale,
    maxMotionScale,
    targetSmoothingAt1x: positiveFinite(tuning.targetSmoothingAt1x, fallback.targetSmoothingAt1x),
    distanceGrowSmoothingAt1x: positiveFinite(
      tuning.distanceGrowSmoothingAt1x,
      fallback.distanceGrowSmoothingAt1x,
    ),
    distanceShrinkSmoothingAt1x: positiveFinite(
      tuning.distanceShrinkSmoothingAt1x,
      fallback.distanceShrinkSmoothingAt1x,
    ),
    maxShrinkMotionScale: positiveFinite(tuning.maxShrinkMotionScale, fallback.maxShrinkMotionScale),
    // `allowDistanceShrink` is typed as boolean, but if tuning comes
    // from JSON / untyped config the runtime value might be
    // undefined / null / string. Fall back when it's not a real
    // boolean so the normalized tuning strictly satisfies its
    // interface.
    allowDistanceShrink:
      typeof tuning.allowDistanceShrink === 'boolean'
        ? tuning.allowDistanceShrink
        : fallback.allowDistanceShrink,
  };
}

export const DEFAULT_CINEMATIC_SPEED_TUNING: CinematicSpeedTuning = Object.freeze({
  baselineRefreshHz: 2,
  minRefreshHz: 1.5,
  maxRefreshHz: 8,

  refreshScaleExponent: 0.5,
  minRefreshScale: 0.85,
  maxRefreshScale: 4.0,

  motionScaleExponent: 0.35,
  minMotionScale: 0.85,
  maxMotionScale: 2.6,

  targetSmoothingAt1x: 2.0,
  distanceGrowSmoothingAt1x: 1.8,
  distanceShrinkSmoothingAt1x: 0.8,
  maxShrinkMotionScale: 2.0,

  allowDistanceShrink: true,
});

// ── Center-refresh tuning (fast cadence) ────────────────────────────

export interface CinematicCenterRefreshTuning {
  baselineCenterRefreshHz: number;
  minCenterRefreshHz: number;
  maxCenterRefreshHz: number;
  centerRefreshScaleExponent: number;
  minCenterRefreshScale: number;
  maxCenterRefreshScale: number;
}

export const DEFAULT_CINEMATIC_CENTER_REFRESH_TUNING: CinematicCenterRefreshTuning = Object.freeze({
  baselineCenterRefreshHz: 10,
  minCenterRefreshHz: 8,
  maxCenterRefreshHz: 16,
  centerRefreshScaleExponent: 0.3,
  minCenterRefreshScale: 0.85,
  maxCenterRefreshScale: 2.0,
});

export function normalizeCinematicCenterRefreshTuning(
  tuning: CinematicCenterRefreshTuning,
  fallback: CinematicCenterRefreshTuning = DEFAULT_CINEMATIC_CENTER_REFRESH_TUNING,
): CinematicCenterRefreshTuning {
  const baselineCenterRefreshHz = positiveFinite(tuning.baselineCenterRefreshHz, fallback.baselineCenterRefreshHz);
  const minCenterRefreshHz = positiveFinite(tuning.minCenterRefreshHz, fallback.minCenterRefreshHz);
  const maxCenterRefreshHz = Math.max(
    positiveFinite(tuning.maxCenterRefreshHz, fallback.maxCenterRefreshHz),
    minCenterRefreshHz,
  );
  const minCenterRefreshScale = positiveFinite(tuning.minCenterRefreshScale, fallback.minCenterRefreshScale);
  const maxCenterRefreshScale = Math.max(
    positiveFinite(tuning.maxCenterRefreshScale, fallback.maxCenterRefreshScale),
    minCenterRefreshScale,
  );
  return {
    baselineCenterRefreshHz,
    minCenterRefreshHz,
    maxCenterRefreshHz,
    centerRefreshScaleExponent: finiteOr(tuning.centerRefreshScaleExponent, fallback.centerRefreshScaleExponent),
    minCenterRefreshScale,
    maxCenterRefreshScale,
  };
}

export interface CinematicCenterRefreshProfile {
  centerRefreshIntervalMs: number;
}

export function cinematicCenterRefreshProfile(
  playbackSpeed: number,
  tuning: CinematicCenterRefreshTuning = DEFAULT_CINEMATIC_CENTER_REFRESH_TUNING,
): CinematicCenterRefreshProfile {
  const t = normalizeCinematicCenterRefreshTuning(tuning);
  const s = Number.isFinite(playbackSpeed) && playbackSpeed > 0 && playbackSpeed !== Infinity
    ? playbackSpeed : 1;
  const scale = clamp(
    Math.pow(s, t.centerRefreshScaleExponent),
    t.minCenterRefreshScale,
    t.maxCenterRefreshScale,
  );
  const hz = clamp(
    t.baselineCenterRefreshHz * scale,
    t.minCenterRefreshHz,
    t.maxCenterRefreshHz,
  );
  return { centerRefreshIntervalMs: 1000 / hz };
}

// ── Config ──────────────────────────────────────────────────────────

export interface CinematicCameraConfig {
  enabledByDefault: boolean;
  smallClusterThreshold: number;
  userIdleResumeMs: number;
  radiusPaddingFactor: number;
  minRadius: number;
  maxRadius?: number;
  speedTuning: CinematicSpeedTuning;
  centerRefreshTuning: CinematicCenterRefreshTuning;
}

export const DEFAULT_CINEMATIC_CONFIG: CinematicCameraConfig = Object.freeze({
  enabledByDefault: true,
  smallClusterThreshold: SMALL_CLUSTER_THRESHOLD,
  userIdleResumeMs: 1500,
  radiusPaddingFactor: 1.25,
  minRadius: 1.5,
  maxRadius: undefined,
  speedTuning: DEFAULT_CINEMATIC_SPEED_TUNING,
  centerRefreshTuning: DEFAULT_CINEMATIC_CENTER_REFRESH_TUNING,
});

/** Minimal shape the resolver needs from a bonded cluster. */
export interface CinematicClusterCandidate {
  id: string;
  atomCount: number;
}

/** Aggregate framing target produced by the resolver. */
export interface CinematicFramingTarget {
  center: readonly [number, number, number];
  radius: number;
  /** Resolved atom count across all eligible clusters. */
  atomCount: number;
}

/**
 * Result of `resolveCinematicTarget`. `target` is null when either
 * there are no eligible clusters at all OR the resolved atom subset
 * is below the stability gate (caller must idle-hold this tick).
 *
 * `eligibleClusterCount` is reported unconditionally so the caller
 * can distinguish "no major clusters yet" (count === 0) from
 * "major clusters exist but aren't reconciled yet" (count > 0 &&
 * target === null) without a second call.
 */
export interface CinematicResolveResult {
  target: CinematicFramingTarget | null;
  eligibleClusterCount: number;
}

/** Smoothing opts matching `Renderer.updateOrientationPreservingFraming`'s
 *  `opts` parameter — passed through unchanged. */
export interface CinematicSmoothingOpts {
  targetSmoothing: number;
  distanceGrowSmoothing: number;
  distanceShrinkSmoothing: number;
  allowDistanceShrink: boolean;
}

export interface CinematicSpeedProfile {
  /** Inter-refresh interval for target selection (ms). Derived from
   *  `tuning.baselineRefreshHz × refreshScale(playbackSpeed)` and
   *  clamped to `[minRefreshHz, maxRefreshHz]`. */
  targetRefreshIntervalMs: number;
  /** Smoothing constants fed straight into the renderer. */
  smoothing: CinematicSmoothingOpts;
  /** Wall-clock cooldown window (ms). Not scaled by playback speed
   *  — human interaction recovery is the same regardless of how
   *  fast playback runs. */
  userIdleResumeMs: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// ── Speed profile ────────────────────────────────────────────────────

/**
 * Decoupled motion/refresh scaling against playback speed.
 *
 * Shape of the curve (coefficients in `tuning`; see
 * `CinematicSpeedTuning` for authoritative defaults):
 *   motionScale  = clamp(speed^motionScaleExponent, minMotionScale, maxMotionScale)
 *                  — conservative curve so smoothing never feels
 *                  frantic at high playback speeds.
 *   refreshScale = clamp(speed^refreshScaleExponent, minRefreshScale, maxRefreshScale)
 *                  — steeper curve so the target-refresh ceiling
 *                  engages at high speeds without under-sampling
 *                  at low speeds.
 *   refreshHz    = clamp(baselineRefreshHz × refreshScale,
 *                        minRefreshHz, maxRefreshHz)
 *
 * All coefficients are injected via `tuning` so Watch and Lab can
 * ship distinct curves without forking the math. Input tuning is
 * fed through `normalizeCinematicSpeedTuning()` so invalid values
 * fall back to defaults rather than producing Infinity / inverted
 * clamps.
 *
 * Degenerate `playbackSpeed` inputs (0, NaN, Infinity, negative)
 * default to 1×.
 */
export function cinematicSpeedProfile(
  playbackSpeed: number,
  tuning: CinematicSpeedTuning = DEFAULT_CINEMATIC_CONFIG.speedTuning,
  userIdleResumeMs: number = DEFAULT_CINEMATIC_CONFIG.userIdleResumeMs,
): CinematicSpeedProfile {
  const t = normalizeCinematicSpeedTuning(tuning);
  const cooldownMs = positiveFinite(userIdleResumeMs, DEFAULT_CINEMATIC_CONFIG.userIdleResumeMs);

  const s =
    Number.isFinite(playbackSpeed) && playbackSpeed > 0 && playbackSpeed !== Infinity
      ? playbackSpeed
      : 1;

  const motionScale = clamp(
    Math.pow(s, t.motionScaleExponent),
    t.minMotionScale,
    t.maxMotionScale,
  );
  const refreshScale = clamp(
    Math.pow(s, t.refreshScaleExponent),
    t.minRefreshScale,
    t.maxRefreshScale,
  );
  const refreshHz = clamp(
    t.baselineRefreshHz * refreshScale,
    t.minRefreshHz,
    t.maxRefreshHz,
  );

  return {
    targetRefreshIntervalMs: 1000 / refreshHz,
    smoothing: {
      targetSmoothing: t.targetSmoothingAt1x * motionScale,
      distanceGrowSmoothing: t.distanceGrowSmoothingAt1x * motionScale,
      // Shrink stays deliberately slower than grow; cap at
      // `maxShrinkMotionScale` so the dolly-in doesn't become
      // frantic even at high playback speeds.
      distanceShrinkSmoothing:
        t.distanceShrinkSmoothingAt1x * Math.min(motionScale, t.maxShrinkMotionScale),
      allowDistanceShrink: t.allowDistanceShrink,
    },
    userIdleResumeMs: cooldownMs,
  };
}

// ── Target resolver ──────────────────────────────────────────────────

/** Function that returns an atom's displayed world position, or
 *  `null` if the atom is unresolved (interpolation transition,
 *  out-of-subset, or just missing). */
export type AtomPositionResolver = (
  atomIndex: number,
) => readonly [number, number, number] | null;

/** Function that returns the atom-index list for a bonded-group id,
 *  or `null` if the id is currently unreconciled. */
export type GroupAtomIndicesResolver = (
  groupId: string,
) => readonly number[] | null;

// ── Selection snapshot (two-cadence support) ────────────────────────

export interface CinematicSelectionSnapshot {
  atomIndices: readonly number[];
  expectedAtomCount: number;
  minFastStableResolvedCount: number;
  center: readonly [number, number, number];
  radius: number;
}

export interface CinematicSelectionResult {
  snapshot: CinematicSelectionSnapshot | null;
  eligibleClusterCount: number;
}

/**
 * Fast-path center recompute from a previously-selected atom set.
 * Resolves positions, skips nulls, returns the per-atom-weighted
 * centroid. Returns null if fewer than `minStableResolvedCount` atoms
 * resolve — the caller then coasts on the prior live target.
 */
export function computeCinematicCenterFromAtomIndices(
  atomIndices: readonly number[],
  resolveAtomPosition: AtomPositionResolver,
  minStableResolvedCount: number,
): readonly [number, number, number] | null {
  let sumX = 0, sumY = 0, sumZ = 0;
  let resolvedCount = 0;
  for (const i of atomIndices) {
    const p = resolveAtomPosition(i);
    if (p === null) continue;
    sumX += p[0];
    sumY += p[1];
    sumZ += p[2];
    resolvedCount++;
  }
  if (resolvedCount === 0 || resolvedCount < minStableResolvedCount) return null;
  return [sumX / resolvedCount, sumY / resolvedCount, sumZ / resolvedCount];
}

/**
 * Full slow-cadence selection: eligible-cluster filter + atom resolve
 * + aggregate center/radius + collected atomIndices. Returns the
 * snapshot needed by the fast center-refresh path.
 *
 * Same null-handling as `resolveCinematicTarget` — the function is
 * factored so `resolveCinematicTarget` is a thin backward-compatible
 * wrapper that drops `atomIndices`.
 */
export function resolveCinematicSelectionSnapshot(
  candidates: readonly CinematicClusterCandidate[],
  getAtomIndices: GroupAtomIndicesResolver,
  resolveAtomPosition: AtomPositionResolver,
  config: CinematicCameraConfig = DEFAULT_CINEMATIC_CONFIG,
): CinematicSelectionResult {
  const eligible: CinematicClusterCandidate[] = [];
  for (const c of candidates) {
    if (c.atomCount > config.smallClusterThreshold) eligible.push(c);
  }
  const eligibleClusterCount = eligible.length;
  if (eligibleClusterCount === 0) {
    return { snapshot: null, eligibleClusterCount: 0 };
  }

  let sumX = 0, sumY = 0, sumZ = 0;
  let resolvedCount = 0;
  let expectedCount = 0;
  const resolvedPositions: Array<readonly [number, number, number]> = [];
  const resolvedIndices: number[] = [];

  for (const g of eligible) {
    const indices = getAtomIndices(g.id);
    if (indices === null) continue;
    expectedCount += indices.length;
    for (const i of indices) {
      const p = resolveAtomPosition(i);
      if (p === null) continue;
      sumX += p[0];
      sumY += p[1];
      sumZ += p[2];
      resolvedCount++;
      resolvedPositions.push(p);
      resolvedIndices.push(i);
    }
  }

  if (resolvedCount === 0) {
    return { snapshot: null, eligibleClusterCount };
  }
  const minStable = Math.max(2, Math.floor(0.5 * expectedCount));
  if (resolvedCount < minStable) {
    return { snapshot: null, eligibleClusterCount };
  }

  const cx = sumX / resolvedCount;
  const cy = sumY / resolvedCount;
  const cz = sumZ / resolvedCount;

  let maxDistSq = 0;
  for (const p of resolvedPositions) {
    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > maxDistSq) maxDistSq = d2;
  }
  const farthest = Math.sqrt(maxDistSq);
  const padded = (farthest + VIEWER_DEFAULTS.atomVisualRadius) * config.radiusPaddingFactor;
  let radius = Math.max(padded, config.minRadius);
  if (config.maxRadius !== undefined) {
    radius = Math.min(radius, config.maxRadius);
  }

  return {
    snapshot: {
      atomIndices: resolvedIndices,
      expectedAtomCount: expectedCount,
      minFastStableResolvedCount: Math.max(1, Math.floor(0.5 * expectedCount)),
      center: [cx, cy, cz],
      radius,
    },
    eligibleClusterCount,
  };
}

/**
 * Backward-compatible aggregate framing target resolver. Thin wrapper
 * around `resolveCinematicSelectionSnapshot()` that drops the atom
 * indices (callers that don't need the fast center-refresh path use
 * this simpler return shape).
 */
export function resolveCinematicTarget(
  candidates: readonly CinematicClusterCandidate[],
  getAtomIndices: GroupAtomIndicesResolver,
  resolveAtomPosition: AtomPositionResolver,
  config: CinematicCameraConfig = DEFAULT_CINEMATIC_CONFIG,
): CinematicResolveResult {
  const result = resolveCinematicSelectionSnapshot(candidates, getAtomIndices, resolveAtomPosition, config);
  return {
    target: result.snapshot
      ? { center: result.snapshot.center, radius: result.snapshot.radius, atomCount: result.snapshot.atomIndices.length }
      : null,
    eligibleClusterCount: result.eligibleClusterCount,
  };
}

// ── Cooldown predicate ───────────────────────────────────────────────

/**
 * Returns true if the wall-clock cooldown window is still active.
 *
 * A `null` `lastInteractionAtMs` means the user has not interacted
 * with the camera since the service started — cooldown is inactive.
 *
 * The elapsed delta is clamped to `[0, ∞)` so a non-monotonic clock
 * (worker vs. main-thread clock drift, system-clock adjustment)
 * cannot flip the predicate permanently-inside or permanently-
 * outside cooldown via a negative subtraction. Callers SHOULD still
 * pass a monotonic time source (`performance.now()` or the
 * rAF-provided `DOMHighResTimeStamp`).
 */
export function isUserInputCooldownActive(
  lastInteractionAtMs: number | null,
  nowMs: number,
  config: CinematicCameraConfig = DEFAULT_CINEMATIC_CONFIG,
): boolean {
  if (lastInteractionAtMs === null) return false;
  const elapsed = Math.max(0, nowMs - lastInteractionAtMs);
  return elapsed < config.userIdleResumeMs;
}
