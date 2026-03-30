/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the timeline subsystem integration layer.
 *
 * Verifies the high-level lifecycle contract:
 *  - Recording only after arming
 *  - clearAndDisarm resets state
 *  - teardown clears store
 *  - isInReview reflects coordinator mode
 *  - recordAfterReconciliation tracks actual steps, not duplicate snapshots
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTimelineSubsystem, type TimelineSubsystem } from '../../page/js/runtime/timeline-subsystem';
import { useAppStore } from '../../page/js/store/app-store';

function makePhysics(n = 10) {
  const pos = new Float64Array(n * 3);
  const vel = new Float64Array(n * 3);
  for (let i = 0; i < pos.length; i++) { pos[i] = i * 0.1; vel[i] = i * 0.01; }
  return {
    n, pos, vel,
    dragAtom: -1, isRotateMode: false, isTranslateMode: false,
    activeComponent: -1, dragTarget: [0, 0, 0],
    getBonds: () => [] as number[][],
    getDamping: () => 0, getDragStrength: () => 2, getRotateStrength: () => 5,
    getWallMode: () => 'contain',
    getDtFs: () => 0.5,
    getBoundarySnapshot: () => ({
      mode: 'contain' as const, wallRadius: 50,
      wallCenter: [0, 0, 0] as [number, number, number],
      wallCenterSet: true, removedCount: 0, damping: 0,
    }),
    restoreBoundarySnapshot: vi.fn(),
    createCheckpoint: function () { return { n: this.n, pos: new Float64Array(this.pos), vel: new Float64Array(this.vel), bonds: [] }; },
    restoreCheckpoint: vi.fn(),
    setDamping: vi.fn(), setDragStrength: vi.fn(), setRotateStrength: vi.fn(),
    endDrag: vi.fn(), computeForces: vi.fn(), refreshTopology: vi.fn(),
    updateBondList: vi.fn(), rebuildComponents: vi.fn(),
    setPhysicsRef: vi.fn(),
  } as any;
}

function makeRenderer() {
  return {
    getAtomCount: () => 10,
    setAtomCount: vi.fn(),
    updateFromSnapshot: vi.fn(),
    updateReviewFrame: vi.fn(),
    setPhysicsRef: vi.fn(),
    clearFeedback: vi.fn(),
  } as any;
}

function createSub(physics = makePhysics(), renderer = makeRenderer()): TimelineSubsystem {
  return createTimelineSubsystem({
    getPhysics: () => physics,
    getRenderer: () => renderer,
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: () => false,
    reinitWorker: vi.fn(async () => {}),
    isWorkerActive: () => false,
    forceRender: vi.fn(),
    clearBondedGroupHighlight: vi.fn(),
    clearRendererFeedback: vi.fn(),
  });
}

describe('TimelineSubsystem', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('does not record before arming', () => {
    const sub = createSub();
    sub.recordAfterReconciliation(4);
    const state = useAppStore.getState();
    expect(state.timelineRangePs).toBeNull();
  });

  it('records after arming', () => {
    const sub = createSub();
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);
    const state = useAppStore.getState();
    expect(state.timelineRangePs).not.toBeNull();
  });

  it('clearAndDisarm resets and disarms', () => {
    const sub = createSub();
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();

    sub.clearAndDisarm();
    expect(useAppStore.getState().timelineRangePs).toBeNull();

    // Further recording does nothing (disarmed)
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('teardown clears store state', () => {
    const sub = createSub();
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);
    sub.teardown();
    expect(useAppStore.getState().timelineMode).toBe('live');
    expect(useAppStore.getState().timelineRangePs).toBeNull();
    expect(useAppStore.getState().timelineCallbacks).toBeNull();
  });

  it('isInReview reflects review mode', () => {
    const sub = createSub();
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);
    expect(sub.isInReview()).toBe(false);

    sub.handleScrub(0); // enters review
    expect(sub.isInReview()).toBe(true);

    sub.returnToLive();
    expect(sub.isInReview()).toBe(false);
  });

  it('does not record when stepsReconciled is 0', () => {
    const sub = createSub();
    sub.markAtomInteractionStarted();

    // First reconciliation records
    sub.recordAfterReconciliation(4);
    const afterFirst = useAppStore.getState().timelineCurrentTimePs;
    expect(afterFirst).toBeGreaterThan(0);

    // Zero-step calls should NOT change stored time or frame count
    sub.recordAfterReconciliation(0);
    sub.recordAfterReconciliation(0);
    expect(useAppStore.getState().timelineCurrentTimePs).toBe(afterFirst);
  });

  it('installStoreCallbacks registers callbacks in store', () => {
    const sub = createSub();
    expect(useAppStore.getState().timelineCallbacks).toBeNull();
    sub.installStoreCallbacks();
    const cbs = useAppStore.getState().timelineCallbacks;
    expect(cbs).not.toBeNull();
    expect(cbs!.onScrub).toBeTypeOf('function');
    expect(cbs!.onReturnToLive).toBeTypeOf('function');
    expect(cbs!.onRestartFromHere).toBeTypeOf('function');
  });

  // ── Regression: only atom interaction arms recording ──
  // These tests pin the product rule that molecule placement, playback
  // controls, and physics settings must never start timeline recording.
  // Only direct atom interactions (drag, move, rotate, flick) arm the
  // timeline. See timeline-arming-wiring.test.ts for full wiring coverage.

  it('recording stays disarmed when only reconciliation ticks occur (simulates placement-only flow)', () => {
    const sub = createSub();
    // Simulate: initial C60 loaded, physics running, user has not interacted with atoms.
    // Frame loop calls recordAfterReconciliation each tick — should produce no frames.
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('multiple molecule additions without atom interaction keep timeline empty', () => {
    const sub = createSub();
    // Simulate: user adds molecule 1 (placement only, no markAtomInteractionStarted call)
    sub.recordAfterReconciliation(4);
    // user adds molecule 2
    sub.recordAfterReconciliation(4);
    // user adds molecule 3
    sub.recordAfterReconciliation(4);
    // Still disarmed — no atom interaction has occurred
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('first atom interaction arms recording after prior placements', () => {
    const sub = createSub();
    // Phase 1: placement-only ticks — no recording
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();

    // Phase 2: user drags an atom → markAtomInteractionStarted
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();
  });

  it('timeline history begins at atom interaction time, not earlier sim time', () => {
    const sub = createSub();
    // 100 ticks of physics without arming (simulates idle + placements)
    for (let i = 0; i < 100; i++) sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();

    // Now user interacts → arm and record
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);
    const range = useAppStore.getState().timelineRangePs;
    expect(range).not.toBeNull();
    // The first recorded frame time should reflect only the steps after arming,
    // not the 100 ticks worth of sim time that elapsed before arming.
    // 4 steps × 0.5 fs / 1000 = 0.002 ps (only the post-arming tick)
    expect(range!.start).toBeCloseTo(0.002);
  });
});
