/**
 * Unit tests for the pure scheduler/frame-loop functions.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSubstepCount,
  computeTargetSpeed,
  updateOverloadState,
  computeEffectiveSpeed,
  shouldSkipRender,
  computeMaxSpeed,
  computeWallRadius,
} from '../../page/js/scheduler-pure';

// ── computeSubstepCount ─────────────────────────────────────────────

describe('computeSubstepCount', () => {
  it('returns 0 when budget is below one step', () => {
    expect(computeSubstepCount(0.5, 1.0, 64)).toBe(0);
  });

  it('returns 0 when budget is 0', () => {
    expect(computeSubstepCount(0, 1.0, 64)).toBe(0);
  });

  it('returns correct count when budget allows multiple steps', () => {
    expect(computeSubstepCount(10.0, 2.0, 64)).toBe(5);
  });

  it('caps at maxSubsteps', () => {
    expect(computeSubstepCount(1000, 1.0, 8)).toBe(8);
  });

  it('returns 0 when stepWallMs is 0 (guard against division)', () => {
    expect(computeSubstepCount(10.0, 0, 64)).toBe(0);
  });

  it('returns 0 when stepWallMs is negative', () => {
    expect(computeSubstepCount(10.0, -1, 64)).toBe(0);
  });

  it('handles fractional budget correctly', () => {
    // 3.5 / 1.0 = 3 full steps
    expect(computeSubstepCount(3.5, 1.0, 64)).toBe(3);
  });
});

// ── computeTargetSpeed ──────────────────────────────────────────────

describe('computeTargetSpeed', () => {
  it('returns maxSpeed in max mode', () => {
    expect(computeTargetSpeed('max', 2.0, 8.0, true)).toBe(8.0);
  });

  it('clamps selectedSpeed to maxSpeed in fixed mode', () => {
    expect(computeTargetSpeed('fixed', 10.0, 4.0, true)).toBe(4.0);
  });

  it('returns selectedSpeed when below maxSpeed', () => {
    expect(computeTargetSpeed('fixed', 2.0, 8.0, true)).toBe(2.0);
  });

  it('caps at 1.0 during warm-up', () => {
    expect(computeTargetSpeed('max', 2.0, 8.0, false)).toBe(1.0);
  });

  it('caps at 1.0 during warm-up even for fixed mode', () => {
    expect(computeTargetSpeed('fixed', 3.0, 8.0, false)).toBe(1.0);
  });

  it('allows < 1.0 during warm-up if selected is lower', () => {
    expect(computeTargetSpeed('fixed', 0.5, 8.0, false)).toBe(0.5);
  });
});

// ── updateOverloadState ─────────────────────────────────────────────

describe('updateOverloadState', () => {
  it('increments overloadCount when at max substeps', () => {
    const result = updateOverloadState({
      mode: 'normal', overloadCount: 0,
      substepsThisFrame: 64, maxSubsteps: 64,
      entryTicks: 10, exitTicks: 5,
    });
    expect(result.overloadCount).toBe(1);
    expect(result.mode).toBe('normal');
  });

  it('decrements overloadCount when below max substeps', () => {
    const result = updateOverloadState({
      mode: 'normal', overloadCount: 3,
      substepsThisFrame: 10, maxSubsteps: 64,
      entryTicks: 10, exitTicks: 5,
    });
    expect(result.overloadCount).toBe(2);
  });

  it('overloadCount does not go below 0', () => {
    const result = updateOverloadState({
      mode: 'normal', overloadCount: 0,
      substepsThisFrame: 10, maxSubsteps: 64,
      entryTicks: 10, exitTicks: 5,
    });
    expect(result.overloadCount).toBe(0);
  });

  it('transitions normal -> overloaded at entry threshold', () => {
    const result = updateOverloadState({
      mode: 'normal', overloadCount: 9,
      substepsThisFrame: 64, maxSubsteps: 64,
      entryTicks: 10, exitTicks: 5,
    });
    expect(result.overloadCount).toBe(10);
    expect(result.mode).toBe('overloaded');
  });

  it('transitions overloaded -> recovering when count drops below exit threshold', () => {
    const result = updateOverloadState({
      mode: 'overloaded', overloadCount: 5,
      substepsThisFrame: 10, maxSubsteps: 64,
      entryTicks: 10, exitTicks: 5,
    });
    expect(result.overloadCount).toBe(4);
    expect(result.mode).toBe('recovering');
  });

  it('transitions recovering -> normal when count reaches 0', () => {
    const result = updateOverloadState({
      mode: 'recovering', overloadCount: 1,
      substepsThisFrame: 10, maxSubsteps: 64,
      entryTicks: 10, exitTicks: 5,
    });
    expect(result.overloadCount).toBe(0);
    expect(result.mode).toBe('normal');
  });

  it('transitions recovering -> overloaded if count spikes', () => {
    const result = updateOverloadState({
      mode: 'recovering', overloadCount: 9,
      substepsThisFrame: 64, maxSubsteps: 64,
      entryTicks: 10, exitTicks: 5,
    });
    expect(result.overloadCount).toBe(10);
    expect(result.mode).toBe('overloaded');
  });

  it('full cycle: normal -> overloaded -> recovering -> normal', () => {
    // Build up to overloaded
    let state = { mode: 'normal', overloadCount: 0 };
    for (let i = 0; i < 10; i++) {
      state = updateOverloadState({
        ...state, substepsThisFrame: 64, maxSubsteps: 64,
        entryTicks: 10, exitTicks: 5,
      });
    }
    expect(state.mode).toBe('overloaded');

    // Cool down to recovering
    for (let i = 0; i < 6; i++) {
      state = updateOverloadState({
        ...state, substepsThisFrame: 10, maxSubsteps: 64,
        entryTicks: 10, exitTicks: 5,
      });
    }
    expect(state.mode).toBe('recovering');

    // Cool down to normal
    while (state.overloadCount > 0) {
      state = updateOverloadState({
        ...state, substepsThisFrame: 10, maxSubsteps: 64,
        entryTicks: 10, exitTicks: 5,
      });
    }
    expect(state.mode).toBe('normal');
    expect(state.overloadCount).toBe(0);
  });

  it('caps overloadCount at 30', () => {
    const result = updateOverloadState({
      mode: 'overloaded', overloadCount: 30,
      substepsThisFrame: 64, maxSubsteps: 64,
      entryTicks: 10, exitTicks: 5,
    });
    expect(result.overloadCount).toBe(30);
  });
});

// ── computeEffectiveSpeed ───────────────────────────────────────────

describe('computeEffectiveSpeed', () => {
  it('returns 0 for empty window with 0 dt', () => {
    const result = computeEffectiveSpeed([], 0, 0, 10);
    // dt=0 means wTotal=0 after push
    // Actually pushes {speed:0, dt:0}, wTotal=0 -> effectiveSpeed=0
    expect(result.effectiveSpeed).toBe(0);
  });

  it('returns the single sample speed for a single entry', () => {
    const result = computeEffectiveSpeed([], 5.0, 16.67, 10);
    expect(result.effectiveSpeed).toBeCloseTo(5.0);
    expect(result.window).toHaveLength(1);
  });

  it('time-weights heavier frames more', () => {
    // Existing window: speed=2 for 10ms, now adding speed=4 for 30ms
    const result = computeEffectiveSpeed(
      [{ speed: 2.0, dt: 10 }],
      4.0, 30.0, 10,
    );
    // weighted = (2*10 + 4*30) / (10+30) = 140/40 = 3.5
    expect(result.effectiveSpeed).toBeCloseTo(3.5);
  });

  it('evicts oldest entries beyond maxWindowSize', () => {
    const window = Array.from({ length: 10 }, () => ({ speed: 1.0, dt: 16 }));
    const result = computeEffectiveSpeed(window, 2.0, 16, 10);
    expect(result.window).toHaveLength(10);
    // Oldest (speed=1) evicted, 9 remain at speed=1 + 1 at speed=2
    // weighted = (9*1*16 + 2*16) / (10*16) = (144+32)/160 = 1.1
    expect(result.effectiveSpeed).toBeCloseTo(1.1);
  });

  it('handles empty window gracefully', () => {
    const result = computeEffectiveSpeed([], 3.0, 16.67, 10);
    expect(result.effectiveSpeed).toBeCloseTo(3.0);
  });
});

// ── shouldSkipRender ────────────────────────────────────────────────

describe('shouldSkipRender', () => {
  it('returns false when there is plenty of headroom', () => {
    // 16.67ms budget, 5ms physics, 4ms render -> headroom 11.67 > 3.2
    expect(shouldSkipRender(5.0, 4.0, 16.67)).toBe(false);
  });

  it('returns true when physics consumes the budget', () => {
    // 16.67ms budget, 15ms physics, 4ms render -> headroom 1.67 < 3.2
    expect(shouldSkipRender(15.0, 4.0, 16.67)).toBe(true);
  });

  it('returns true when budget is 0', () => {
    expect(shouldSkipRender(5.0, 4.0, 0)).toBe(true);
  });

  it('returns false when renderMs is 0 (nothing to skip)', () => {
    expect(shouldSkipRender(10.0, 0, 16.67)).toBe(false);
  });

  it('handles exact boundary (headroom == renderMs * 0.8)', () => {
    // headroom = budget - phys = 3.2, renderMs*0.8 = 3.2 -> NOT less than, so false
    expect(shouldSkipRender(13.47, 4.0, 16.67)).toBe(false);
  });
});

// ── computeMaxSpeed ─────────────────────────────────────────────────

describe('computeMaxSpeed', () => {
  it('returns a positive speed for typical values', () => {
    // physStep=0.5ms, render=2ms, rafInterval=16.67ms, stepsPerFrame=4
    const speed = computeMaxSpeed(0.5, 2.0, 16.67, 4);
    expect(speed).toBeGreaterThan(0);
  });

  it('returns 0 when rafIntervalMs is 0', () => {
    expect(computeMaxSpeed(0.5, 2.0, 0, 4)).toBe(0);
  });

  it('returns 0 when physStepMs is 0', () => {
    expect(computeMaxSpeed(0, 2.0, 16.67, 4)).toBe(0);
  });

  it('returns 0 when render cost exceeds frame budget', () => {
    expect(computeMaxSpeed(0.5, 20.0, 16.67, 4)).toBe(0);
  });

  it('higher physStepMs reduces max speed', () => {
    const fast = computeMaxSpeed(0.2, 2.0, 16.67, 4);
    const slow = computeMaxSpeed(2.0, 2.0, 16.67, 4);
    expect(fast).toBeGreaterThan(slow);
  });

  it('lower render cost increases max speed', () => {
    const cheap = computeMaxSpeed(0.5, 1.0, 16.67, 4);
    const expensive = computeMaxSpeed(0.5, 5.0, 16.67, 4);
    expect(cheap).toBeGreaterThan(expensive);
  });
});

// ── computeWallRadius ───────────────────────────────────────────────

describe('computeWallRadius', () => {
  it('returns 0 for 0 atoms', () => {
    expect(computeWallRadius(0, 0.00005, 50)).toBe(0);
  });

  it('returns 0 for negative atom count', () => {
    expect(computeWallRadius(-1, 0.00005, 50)).toBe(0);
  });

  it('returns 0 for 0 density', () => {
    expect(computeWallRadius(60, 0, 50)).toBe(0);
  });

  it('computes correct radius for C60 with default config', () => {
    // density=0.00005, padding=50
    const r = computeWallRadius(60, 0.00005, 50);
    const expected = Math.cbrt((3 * 60) / (4 * Math.PI * 0.00005)) + 50;
    expect(r).toBeCloseTo(expected, 6);
  });

  it('radius increases with more atoms', () => {
    const r60 = computeWallRadius(60, 0.00005, 50);
    const r600 = computeWallRadius(600, 0.00005, 50);
    expect(r600).toBeGreaterThan(r60);
  });

  it('padding is additive', () => {
    const r0 = computeWallRadius(60, 0.00005, 0);
    const r50 = computeWallRadius(60, 0.00005, 50);
    expect(r50 - r0).toBeCloseTo(50, 6);
  });
});
