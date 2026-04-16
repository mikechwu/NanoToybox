/**
 * Pure-module tests for `src/camera/cinematic-camera.ts`.
 *
 * Focus on math + state-machine invariants. No WebGL, no React, no
 * renderer mocks — that belongs in `watch-cinematic-camera.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  cinematicSpeedProfile,
  clamp,
  DEFAULT_CINEMATIC_CONFIG,
  DEFAULT_CINEMATIC_SPEED_TUNING,
  isUserInputCooldownActive,
  normalizeCinematicSpeedTuning,
  resolveCinematicTarget,
  type CinematicClusterCandidate,
} from '../../src/camera/cinematic-camera';

// ── Speed profile ────────────────────────────────────────────────────

describe('cinematicSpeedProfile', () => {
  it('baseline at 1× yields 500ms interval + 2.0 targetSmoothing', () => {
    const p = cinematicSpeedProfile(1);
    expect(p.targetRefreshIntervalMs).toBe(500);
    expect(p.smoothing.targetSmoothing).toBeCloseTo(2.0, 2);
    expect(p.smoothing.distanceGrowSmoothing).toBeCloseTo(1.8, 2);
    expect(p.smoothing.distanceShrinkSmoothing).toBeCloseTo(0.8, 2);
    expect(p.smoothing.allowDistanceShrink).toBe(true);
  });

  it('scales refresh with √speed: 4× → 4 Hz / 250ms', () => {
    expect(cinematicSpeedProfile(4).targetRefreshIntervalMs).toBe(250);
  });

  it('20× engages the 8 Hz ceiling → 125ms interval', () => {
    // √20 ≈ 4.47 capped to 4.0 → 2 × 4 = 8 Hz → 125ms.
    expect(cinematicSpeedProfile(20).targetRefreshIntervalMs).toBe(125);
  });

  it('0.5× engages the 1.7 Hz floor (√0.5 floored to 0.85) → ~588ms', () => {
    // 2 × 0.85 = 1.7 Hz → 1000 / 1.7 ≈ 588.235ms.
    expect(cinematicSpeedProfile(0.5).targetRefreshIntervalMs).toBeCloseTo(588.235, 2);
  });

  it('motion scales with speed^0.35, capped at 2.6× at 20×', () => {
    const p = cinematicSpeedProfile(20);
    // 20^0.35 ≈ 2.85 → capped at 2.6. 2.0 × 2.6 = 5.2.
    expect(p.smoothing.targetSmoothing).toBeCloseTo(5.2, 2);
    expect(p.smoothing.distanceGrowSmoothing).toBeCloseTo(1.8 * 2.6, 2);
    // Shrink capped at min(motionScale, 2.0) = 2.0. 0.8 × 2.0 = 1.6.
    expect(p.smoothing.distanceShrinkSmoothing).toBeCloseTo(1.6, 2);
  });

  it('motion floors at 0.85× at 0.5×', () => {
    // 0.5^0.35 ≈ 0.78 → floored to 0.85.
    const p = cinematicSpeedProfile(0.5);
    expect(p.smoothing.targetSmoothing).toBeCloseTo(2.0 * 0.85, 2);
  });

  it('userIdleResumeMs === 1500 across all supported speeds', () => {
    for (const s of [0.5, 1, 2, 4, 10, 20]) {
      expect(cinematicSpeedProfile(s).userIdleResumeMs).toBe(1500);
    }
  });

  it.each([0, -1, -10, NaN, Infinity, -Infinity])(
    'degenerate input %p defaults to 1× profile',
    (input) => {
      const baseline = cinematicSpeedProfile(1);
      const degenerate = cinematicSpeedProfile(input);
      expect(degenerate.targetRefreshIntervalMs).toBe(baseline.targetRefreshIntervalMs);
      expect(degenerate.smoothing.targetSmoothing).toBeCloseTo(baseline.smoothing.targetSmoothing, 5);
    },
  );

  // ── Custom tuning propagation ──

  it('honors custom baselineRefreshHz + maxRefreshHz', () => {
    const p = cinematicSpeedProfile(4, {
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      baselineRefreshHz: 3,
      maxRefreshHz: 12,
    });
    // √4 = 2 → 3 Hz baseline × 2 = 6 Hz → interval = 1000/6 ≈ 166.67ms.
    expect(p.targetRefreshIntervalMs).toBeCloseTo(1000 / 6, 2);
  });

  it('honors custom targetSmoothingAt1x', () => {
    const p = cinematicSpeedProfile(1, {
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      targetSmoothingAt1x: 4,
    });
    // motionScale at 1× is 1 → smoothing = 4 * 1 = 4.
    expect(p.smoothing.targetSmoothing).toBeCloseTo(4, 5);
  });

  it('honors custom motionScaleExponent (linear curve)', () => {
    const p = cinematicSpeedProfile(4, {
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      motionScaleExponent: 1.0, // pure linear
      minMotionScale: 0.1,
      maxMotionScale: 100,
    });
    // speed^1 = 4 → smoothing = 2.0 * 4 = 8.
    expect(p.smoothing.targetSmoothing).toBeCloseTo(8, 5);
  });

  it('honors custom allowDistanceShrink=false', () => {
    const p = cinematicSpeedProfile(1, {
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      allowDistanceShrink: false,
    });
    expect(p.smoothing.allowDistanceShrink).toBe(false);
  });

  it('honors custom userIdleResumeMs via third argument', () => {
    const p = cinematicSpeedProfile(1, DEFAULT_CINEMATIC_SPEED_TUNING, 5000);
    expect(p.userIdleResumeMs).toBe(5000);
  });

  // ── Invalid tuning → defaults (normalization) ──

  it('invalid baselineRefreshHz (0) falls back to the default', () => {
    const p = cinematicSpeedProfile(1, {
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      baselineRefreshHz: 0,
    });
    // Default baseline = 2 Hz → 500ms at 1×.
    expect(p.targetRefreshIntervalMs).toBe(500);
  });

  it('invalid minRefreshHz > maxRefreshHz is coerced so min ≤ max', () => {
    const p = cinematicSpeedProfile(1, {
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      minRefreshHz: 20,
      maxRefreshHz: 5,
    });
    // After normalization max = max(5, 20) = 20. Baseline 2Hz × scale 0.85 ≈ 1.7Hz
    // → clamped to [20,20] = 20 Hz → 50 ms.
    expect(p.targetRefreshIntervalMs).toBeCloseTo(50, 5);
    expect(Number.isFinite(p.targetRefreshIntervalMs)).toBe(true);
  });

  it('NaN exponent falls back to default', () => {
    const p = cinematicSpeedProfile(4, {
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      motionScaleExponent: NaN,
    });
    // Default motionScaleExponent = 0.35 → 4^0.35 ≈ 1.62 → smoothing = 2.0 * 1.62 ≈ 3.24.
    expect(p.smoothing.targetSmoothing).toBeCloseTo(2.0 * Math.pow(4, 0.35), 2);
    expect(Number.isNaN(p.smoothing.targetSmoothing)).toBe(false);
  });

  it('invalid userIdleResumeMs falls back to default', () => {
    const p = cinematicSpeedProfile(1, DEFAULT_CINEMATIC_SPEED_TUNING, -100);
    expect(p.userIdleResumeMs).toBe(DEFAULT_CINEMATIC_CONFIG.userIdleResumeMs);
  });
});

describe('normalizeCinematicSpeedTuning', () => {
  it('preserves a valid tuning unchanged', () => {
    const result = normalizeCinematicSpeedTuning(DEFAULT_CINEMATIC_SPEED_TUNING);
    expect(result).toEqual(DEFAULT_CINEMATIC_SPEED_TUNING);
  });

  it('replaces non-finite / non-positive positive-only fields with fallback', () => {
    const result = normalizeCinematicSpeedTuning({
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      baselineRefreshHz: NaN,
      targetSmoothingAt1x: -5,
      distanceGrowSmoothingAt1x: Infinity,
    });
    expect(result.baselineRefreshHz).toBe(DEFAULT_CINEMATIC_SPEED_TUNING.baselineRefreshHz);
    expect(result.targetSmoothingAt1x).toBe(DEFAULT_CINEMATIC_SPEED_TUNING.targetSmoothingAt1x);
    expect(result.distanceGrowSmoothingAt1x).toBe(DEFAULT_CINEMATIC_SPEED_TUNING.distanceGrowSmoothingAt1x);
  });

  it('enforces min ≤ max on refresh bounds', () => {
    const result = normalizeCinematicSpeedTuning({
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      minRefreshHz: 10,
      maxRefreshHz: 5,
    });
    expect(result.maxRefreshHz).toBeGreaterThanOrEqual(result.minRefreshHz);
  });

  it('preserves zero/negative exponents (valid signed floats)', () => {
    const result = normalizeCinematicSpeedTuning({
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      refreshScaleExponent: 0,
      motionScaleExponent: -0.5,
    });
    expect(result.refreshScaleExponent).toBe(0);
    expect(result.motionScaleExponent).toBe(-0.5);
  });

  it('enforces min ≤ max on refreshScale bounds', () => {
    const result = normalizeCinematicSpeedTuning({
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      minRefreshScale: 5,
      maxRefreshScale: 1,
    });
    expect(result.maxRefreshScale).toBeGreaterThanOrEqual(result.minRefreshScale);
  });

  it('enforces min ≤ max on motionScale bounds', () => {
    const result = normalizeCinematicSpeedTuning({
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      minMotionScale: 5,
      maxMotionScale: 1,
    });
    expect(result.maxMotionScale).toBeGreaterThanOrEqual(result.minMotionScale);
  });

  it('falls back on non-boolean allowDistanceShrink', () => {
    // Real code should never do this, but untyped JS / JSON can.
    const result = normalizeCinematicSpeedTuning({
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      allowDistanceShrink: undefined as unknown as boolean,
    });
    expect(result.allowDistanceShrink).toBe(DEFAULT_CINEMATIC_SPEED_TUNING.allowDistanceShrink);

    const stringResult = normalizeCinematicSpeedTuning({
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      allowDistanceShrink: 'yes' as unknown as boolean,
    });
    expect(stringResult.allowDistanceShrink).toBe(DEFAULT_CINEMATIC_SPEED_TUNING.allowDistanceShrink);
  });

  it('preserves a valid false allowDistanceShrink (not treated as falsy-then-fallback)', () => {
    const result = normalizeCinematicSpeedTuning({
      ...DEFAULT_CINEMATIC_SPEED_TUNING,
      allowDistanceShrink: false,
    });
    expect(result.allowDistanceShrink).toBe(false);
  });
});

// ── clamp helper ─────────────────────────────────────────────────────

describe('clamp', () => {
  it('returns the value in range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it('clamps below floor', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it('clamps above ceiling', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

// ── Target resolver ──────────────────────────────────────────────────

function makeCandidates(counts: number[]): CinematicClusterCandidate[] {
  return counts.map((atomCount, i) => ({ id: `g${i}`, atomCount }));
}

describe('resolveCinematicTarget', () => {
  it('excludes groups with atomCount <= SMALL_CLUSTER_THRESHOLD (= 3)', () => {
    // Only g0 (atomCount 10) and g3 (atomCount 7) are eligible.
    const candidates = makeCandidates([10, 1, 3, 7]);
    const indicesByGroup: Record<string, number[]> = {
      g0: [0, 1], g1: [2], g2: [3], g3: [4, 5],
    };
    const positions: Record<number, [number, number, number]> = {
      0: [0, 0, 0], 1: [1, 0, 0], 2: [100, 100, 100], 3: [200, 200, 200],
      4: [5, 0, 0], 5: [6, 0, 0],
    };
    const result = resolveCinematicTarget(
      candidates,
      (id) => indicesByGroup[id] ?? null,
      (i) => positions[i] ?? null,
    );
    expect(result.target).not.toBeNull();
    expect(result.eligibleClusterCount).toBe(2); // g0 + g3
    expect(result.target!.atomCount).toBe(4); // 2 from g0 + 2 from g3
    // Center is per-atom weighted: (0+1+5+6)/4 = 3.
    expect(result.target!.center[0]).toBeCloseTo(3, 5);
  });

  it('returns target=null, count=0 when no eligible clusters exist', () => {
    const result = resolveCinematicTarget(
      makeCandidates([1, 2, 3]),
      () => [0],
      () => [0, 0, 0],
    );
    expect(result.target).toBeNull();
    expect(result.eligibleClusterCount).toBe(0);
  });

  it('reports count>0 with target=null when all eligible groups are unreconciled', () => {
    // Distinguishes "unreconciled" from "empty" — UI can show a
    // different message for each.
    const result = resolveCinematicTarget(
      makeCandidates([10, 8]),
      () => null, // all unreconciled
      () => [0, 0, 0],
    );
    expect(result.target).toBeNull();
    expect(result.eligibleClusterCount).toBe(2);
  });

  it('skips groups whose indices are null but keeps resolving others', () => {
    const candidates = makeCandidates([10, 8]);
    const result = resolveCinematicTarget(
      candidates,
      (id) => (id === 'g0' ? null : [0, 1]),
      (i) => (i === 0 ? [2, 0, 0] : [4, 0, 0]),
    );
    expect(result.target).not.toBeNull();
    expect(result.target!.atomCount).toBe(2);
    expect(result.target!.center[0]).toBeCloseTo(3, 5); // (2+4)/2
    // Still reports both as eligible, even though one was unreconciled.
    expect(result.eligibleClusterCount).toBe(2);
  });

  it('skips atoms whose positions are null and sums the resolved subset', () => {
    const result = resolveCinematicTarget(
      makeCandidates([10]),
      () => [0, 1, 2, 3], // 4 expected
      (i) => (i === 2 ? null : [i, 0, 0]), // 3 of 4 resolved
    );
    expect(result.target).not.toBeNull();
    expect(result.target!.atomCount).toBe(3);
    // Stable: 3 ≥ max(2, floor(0.5 × 4)) = 2. Survives.
    expect(result.target!.center[0]).toBeCloseTo((0 + 1 + 3) / 3, 5);
  });

  it('returns target=null (count>0) when resolved subset is below stability gate', () => {
    // Expected 10 atoms, only 3 resolve. floor(0.5 × 10) = 5 → 3 < 5 → null.
    const result = resolveCinematicTarget(
      makeCandidates([10]),
      () => Array.from({ length: 10 }, (_, i) => i),
      (i) => (i < 3 ? [i, 0, 0] : null),
    );
    expect(result.target).toBeNull();
    expect(result.eligibleClusterCount).toBe(1);
  });

  it('computes radius from farthest eligible atom + padding', () => {
    const result = resolveCinematicTarget(
      makeCandidates([10]),
      () => [0, 1],
      (i) => (i === 0 ? [0, 0, 0] : [10, 0, 0]),
    );
    expect(result.target).not.toBeNull();
    // Center at (5,0,0); farthest distance is 5; padded = (5 + 0.4) × 1.25 = 6.75.
    expect(result.target!.radius).toBeCloseTo(6.75, 2);
  });

  it('applies minRadius clamp to tiny molecules', () => {
    const result = resolveCinematicTarget(
      makeCandidates([4]),
      () => [0, 1],
      (i) => [i * 0.001, 0, 0], // near-zero spread
    );
    expect(result.target).not.toBeNull();
    // Padded would be tiny; minRadius = 1.5.
    expect(result.target!.radius).toBe(DEFAULT_CINEMATIC_CONFIG.minRadius);
  });

  it('applies maxRadius clamp when configured', () => {
    const result = resolveCinematicTarget(
      makeCandidates([10]),
      () => [0, 1],
      (i) => (i === 0 ? [0, 0, 0] : [1000, 0, 0]),
      { ...DEFAULT_CINEMATIC_CONFIG, maxRadius: 50 },
    );
    expect(result.target).not.toBeNull();
    expect(result.target!.radius).toBe(50);
  });
});

// ── Cooldown predicate ───────────────────────────────────────────────

describe('isUserInputCooldownActive', () => {
  it('returns false when no user interaction recorded', () => {
    expect(isUserInputCooldownActive(null, 1_000_000)).toBe(false);
  });

  it('returns true within the 1500ms window', () => {
    expect(isUserInputCooldownActive(1_000_000, 1_000_500)).toBe(true);
    expect(isUserInputCooldownActive(1_000_000, 1_001_499)).toBe(true);
  });

  it('returns false exactly at and past the window end', () => {
    expect(isUserInputCooldownActive(1_000_000, 1_001_500)).toBe(false);
    expect(isUserInputCooldownActive(1_000_000, 1_010_000)).toBe(false);
  });

  it('honors a custom userIdleResumeMs', () => {
    const cfg = { ...DEFAULT_CINEMATIC_CONFIG, userIdleResumeMs: 5000 };
    expect(isUserInputCooldownActive(1_000_000, 1_003_000, cfg)).toBe(true);
    expect(isUserInputCooldownActive(1_000_000, 1_006_000, cfg)).toBe(false);
  });

  it('clamps non-monotonic clock (nowMs < lastInteraction) to elapsed=0', () => {
    // If the clock somehow moved backwards (worker drift, system
    // time adjustment), a negative delta must NOT bypass the
    // cooldown in either direction. elapsed is clamped to [0, ∞).
    expect(isUserInputCooldownActive(2_000_000, 1_000_000)).toBe(true);
    // Still inside the window when `now` is equal to last.
    expect(isUserInputCooldownActive(1_000_000, 1_000_000)).toBe(true);
  });
});
