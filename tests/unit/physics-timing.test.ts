/**
 * Timing consistency tests — verifies that dt, scheduler rate, timeline time,
 * and damping are derived from one authoritative timing model.
 */

import { describe, it, expect } from 'vitest';
import { getPhysicsTiming, CONFIG } from '../../page/js/config';
import { PhysicsEngine } from '../../page/js/physics';

describe('getPhysicsTiming — derived scheduler rate', () => {
  it('derives 240 steps/s from dt=0.5fs and rate=0.12 ps/s', () => {
    const t = getPhysicsTiming();
    expect(t.dtFs).toBe(0.5);
    expect(t.stepPs).toBeCloseTo(0.0005);
    expect(t.baseStepsPerSecond).toBeCloseTo(240);
  });

  it('derivation formula: baseStepsPerSecond = rate / (dt/1000)', () => {
    const t = getPhysicsTiming();
    expect(t.baseStepsPerSecond).toBeCloseTo(
      CONFIG.playback.baseSimRatePsPerSecond / (CONFIG.physics.dt / 1000)
    );
  });

  it('rate scales inversely with dt', () => {
    const rate = CONFIG.playback.baseSimRatePsPerSecond;
    const stepsAt05 = rate / (0.5 / 1000);
    const stepsAt10 = rate / (1.0 / 1000);
    expect(stepsAt10).toBeCloseTo(stepsAt05 / 2);
  });
});

describe('Timeline time accumulation at different dt', () => {
  it('4 steps at 0.5 fs = 0.002 ps', () => {
    expect(4 * 0.5 / 1000).toBeCloseTo(0.002);
  });

  it('4 steps at 1.0 fs = 0.004 ps', () => {
    expect(4 * 1.0 / 1000).toBeCloseTo(0.004);
  });
});

describe('Damping physical time invariance', () => {
  it('same velocity decay over equal physical time at different dt', () => {
    const d = 0.1;
    const refBatchFs = 0.5 * 4; // 2 fs
    const gamma = -Math.log(1 - d) / refBatchFs;

    const factor05 = Math.exp(-gamma * 0.5);
    const totalDecay05 = Math.pow(factor05, 4); // 4 steps × 0.5 fs = 2 fs

    const factor10 = Math.exp(-gamma * 1.0);
    const totalDecay10 = Math.pow(factor10, 2); // 2 steps × 1.0 fs = 2 fs

    expect(totalDecay05).toBeCloseTo(totalDecay10, 10);
    expect(totalDecay05).toBeCloseTo(0.9, 10);
  });
});

describe('PhysicsEngine timing parameterization', () => {
  it('setTimeConfig changes stepOnce timestep', () => {
    const eng = new PhysicsEngine({ skipWasmInit: true });
    expect(eng.getDtFs()).toBe(CONFIG.physics.dt);
    eng.setTimeConfig(1.0, 4);
    expect(eng.getDtFs()).toBe(1.0);
  });

  it('damping factor recomputes when dt changes', () => {
    const eng = new PhysicsEngine({ skipWasmInit: true });
    eng.setDamping(0.1);
    const factor1 = eng._dampingFactor;

    eng.setTimeConfig(1.0, 4); // double dt
    const factor2 = eng._dampingFactor;

    // Factor should be different (more decay per step at larger dt)
    expect(factor2).toBeLessThan(factor1);
    // But physical decay per fs should be the same
    const decayPerFs1 = -Math.log(factor1) / 0.5;
    const decayPerFs2 = -Math.log(factor2) / 1.0;
    expect(decayPerFs1).toBeCloseTo(decayPerFs2, 5);
  });

  it('dampingRefDurationFs is pinned at boot value', () => {
    const eng = new PhysicsEngine({ skipWasmInit: true });
    const bootDuration = eng.dampingRefDurationFs;
    eng.setTimeConfig(1.0, 8);
    // Reference duration should NOT change — pinned at boot
    expect(eng.dampingRefDurationFs).toBe(bootDuration);
  });

  it('two engines with different dt have same decay per physical time', () => {
    const eng1 = new PhysicsEngine({ skipWasmInit: true });
    eng1.setDamping(0.2);

    const eng2 = new PhysicsEngine({ skipWasmInit: true });
    eng2.setTimeConfig(1.0, 4);
    eng2.setDamping(0.2);

    // Decay per fs should match
    const gamma1 = -Math.log(eng1._dampingFactor) / eng1.dtFs;
    const gamma2 = -Math.log(eng2._dampingFactor) / eng2.dtFs;
    expect(gamma1).toBeCloseTo(gamma2, 5);
  });
});
