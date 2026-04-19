/**
 * Regression test for the reconciled-step deduplication helper.
 *
 * Prevents the exact bug where the same worker snapshot was counted
 * multiple times, causing sim time to advance faster than positions.
 */

import { describe, it, expect } from 'vitest';
import { resolveReconciledSteps } from '../../lab/js/runtime/worker/reconciled-steps';

describe('resolveReconciledSteps', () => {
  it('returns stepsCompleted for a new snapshot version', () => {
    const result = resolveReconciledSteps(1, -1, 4);
    expect(result.steps).toBe(4);
    expect(result.newLastVersion).toBe(1);
  });

  it('returns 0 for the same snapshot version (duplicate)', () => {
    const result = resolveReconciledSteps(1, 1, 4);
    expect(result.steps).toBe(0);
    expect(result.newLastVersion).toBe(1);
  });

  it('tracks version correctly across multiple snapshots', () => {
    let lastVersion = -1;

    // First snapshot
    const r1 = resolveReconciledSteps(1, lastVersion, 4);
    expect(r1.steps).toBe(4);
    lastVersion = r1.newLastVersion;

    // Same snapshot again (no new worker response)
    const r2 = resolveReconciledSteps(1, lastVersion, 4);
    expect(r2.steps).toBe(0);
    lastVersion = r2.newLastVersion;

    // Still same
    const r3 = resolveReconciledSteps(1, lastVersion, 4);
    expect(r3.steps).toBe(0);

    // New snapshot arrives
    const r4 = resolveReconciledSteps(2, lastVersion, 6);
    expect(r4.steps).toBe(6);
    lastVersion = r4.newLastVersion;
    expect(lastVersion).toBe(2);
  });

  it('handles version jump (missed intermediate snapshots)', () => {
    const result = resolveReconciledSteps(5, 2, 10);
    expect(result.steps).toBe(10);
    expect(result.newLastVersion).toBe(5);
  });
});
