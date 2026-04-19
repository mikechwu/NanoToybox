/**
 * Standalone round-trip tests for TimelineAtomIdentityTracker.snapshot
 * and restore. Locks the API contract in isolation from the hydrate
 * integration tests.
 */
import { describe, it, expect } from 'vitest';
import { createTimelineAtomIdentityTracker } from '../../lab/js/runtime/timeline/timeline-atom-identity';

describe('TimelineAtomIdentityTracker snapshot + restore', () => {
  it('snapshot of an empty tracker has zero ids + zero counter', () => {
    const t = createTimelineAtomIdentityTracker();
    const snap = t.snapshot();
    expect(snap.slotToAtomId).toEqual([]);
    expect(snap.nextAtomId).toBe(0);
  });

  it('snapshot captures assigned ids + counter after handleAppend', () => {
    const t = createTimelineAtomIdentityTracker();
    t.handleAppend(0, 3);
    const snap = t.snapshot();
    expect(snap.slotToAtomId).toEqual([0, 1, 2]);
    expect(snap.nextAtomId).toBe(3);
  });

  it('restore() reverts later appends to the snapshotted state', () => {
    const t = createTimelineAtomIdentityTracker();
    t.handleAppend(0, 2);
    const snap = t.snapshot();
    t.handleAppend(2, 3);
    expect(t.getTotalAssigned()).toBe(5);
    t.restore(snap);
    expect(t.getTotalAssigned()).toBe(2);
    // After restore, the next handleAppend starts at offset 2 (the
    // tracker's current slot count) and continues the id counter
    // from the snapshotted value.
    const ids = t.handleAppend(2, 2);
    expect(ids).toEqual([2, 3]);
  });

  it('snapshot is a deep copy — later mutation of the tracker does not leak into the snapshot', () => {
    const t = createTimelineAtomIdentityTracker();
    t.handleAppend(0, 2);
    const snap = t.snapshot();
    t.handleAppend(2, 1);
    // Captured slotToAtomId stays at length 2.
    expect(snap.slotToAtomId).toHaveLength(2);
    expect(snap.slotToAtomId).toEqual([0, 1]);
  });

  it('restore after reset() repopulates the tracker to the snapshot state', () => {
    const t = createTimelineAtomIdentityTracker();
    t.handleAppend(0, 4);
    const snap = t.snapshot();
    t.reset();
    expect(t.getTotalAssigned()).toBe(0);
    t.restore(snap);
    expect(t.getTotalAssigned()).toBe(4);
    expect(t.captureForCurrentState(4)).toEqual([0, 1, 2, 3]);
  });

  it('round-trip preserves post-compaction mapping', () => {
    const t = createTimelineAtomIdentityTracker();
    t.handleAppend(0, 5);
    // Compaction: keep old indices 1, 3 → new indices 0, 1.
    t.handleCompaction([1, 3]);
    // Now slotToAtomId = [1, 3], nextAtomId = 5.
    const snap = t.snapshot();
    expect(snap.slotToAtomId).toEqual([1, 3]);
    expect(snap.nextAtomId).toBe(5);
    t.reset();
    t.restore(snap);
    expect(t.captureForCurrentState(2)).toEqual([1, 3]);
    expect(t.getTotalAssigned()).toBe(5);
  });

  it('restore accepts a readonly snapshot (returned by snapshot()) without error', () => {
    const t = createTimelineAtomIdentityTracker();
    t.handleAppend(0, 1);
    const snap: Readonly<ReturnType<typeof t.snapshot>> = t.snapshot();
    // Reset + restore from the readonly handle — should type-check
    // and not mutate the snapshot object.
    const beforeSlots = snap.slotToAtomId;
    const beforeNext = snap.nextAtomId;
    t.reset();
    t.restore(snap);
    expect(snap.slotToAtomId).toBe(beforeSlots);
    expect(snap.nextAtomId).toBe(beforeNext);
  });
});
