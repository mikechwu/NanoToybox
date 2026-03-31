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
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    const state = useAppStore.getState();
    expect(state.timelineRangePs).not.toBeNull();
  });

  it('clearAndDisarm resets and disarms', () => {
    const sub = createSub();
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();

    sub.clearAndDisarm();
    expect(useAppStore.getState().timelineRangePs).toBeNull();

    // Further recording does nothing (disarmed)
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('resetToPassiveReady clears history but enters ready', () => {
    const sub = createSub();
    sub.installAndEnable();
    sub.markAtomInteractionStarted(); // ready → active
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();

    sub.resetToPassiveReady();
    expect(useAppStore.getState().timelineRecordingMode).toBe('ready');
    expect(useAppStore.getState().timelineRangePs).toBeNull();
    expect(useAppStore.getState().timelineCurrentTimePs).toBe(0);
  });

  it('turnRecordingOff still enters off', () => {
    const sub = createSub();
    sub.installAndEnable();
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);

    sub.turnRecordingOff();
    expect(useAppStore.getState().timelineRecordingMode).toBe('off');
  });

  it('resetToPassiveReady after review exits review and enters ready', () => {
    const sub = createSub();
    sub.installAndEnable();
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);
    sub.handleScrub(0); // enters review
    expect(sub.isInReview()).toBe(true);

    sub.resetToPassiveReady();
    expect(sub.isInReview()).toBe(false);
    expect(useAppStore.getState().timelineRecordingMode).toBe('ready');
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('resetToPassiveReady allows re-arming on next atom interaction', () => {
    const sub = createSub();
    sub.installAndEnable();
    sub.markAtomInteractionStarted();
    sub.recordAfterReconciliation(4);

    sub.resetToPassiveReady();
    expect(useAppStore.getState().timelineRecordingMode).toBe('ready');

    // Atom interaction should arm recording again
    sub.markAtomInteractionStarted();
    expect(useAppStore.getState().timelineRecordingMode).toBe('active');
  });

  it('teardown clears store state', () => {
    const sub = createSub();
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    sub.teardown();
    expect(useAppStore.getState().timelineMode).toBe('live');
    expect(useAppStore.getState().timelineRangePs).toBeNull();
    expect(useAppStore.getState().timelineCallbacks).toBeNull();
  });

  it('isInReview reflects review mode', () => {
    const sub = createSub();
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    expect(sub.isInReview()).toBe(false);

    sub.handleScrub(0); // enters review
    expect(sub.isInReview()).toBe(true);

    sub.returnToLive();
    expect(sub.isInReview()).toBe(false);
  });

  it('does not record when stepsReconciled is 0', () => {
    const sub = createSub();
    sub.startRecordingNow();
    // Seed frame at time 0
    const afterSeed = useAppStore.getState().timelineCurrentTimePs;

    // Zero-step calls should NOT change stored time
    sub.recordAfterReconciliation(0);
    sub.recordAfterReconciliation(0);
    expect(useAppStore.getState().timelineCurrentTimePs).toBe(afterSeed);
  });

  it('installAndEnable registers callbacks and enters ready atomically', () => {
    const sub = createSub();
    expect(useAppStore.getState().timelineCallbacks).toBeNull();
    expect(useAppStore.getState().timelineInstalled).toBe(false);
    sub.installAndEnable();
    const cbs = useAppStore.getState().timelineCallbacks;
    expect(cbs).not.toBeNull();
    expect(cbs!.onScrub).toBeTypeOf('function');
    expect(cbs!.onReturnToLive).toBeTypeOf('function');
    expect(cbs!.onRestartFromHere).toBeTypeOf('function');
    expect(cbs!.onStartRecordingNow).toBeTypeOf('function');
    expect(cbs!.onTurnRecordingOff).toBeTypeOf('function');
    expect(useAppStore.getState().timelineInstalled).toBe(true);
    expect(useAppStore.getState().timelineRecordingMode).toBe('ready');
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
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();
  });

  it('timeline history begins at atom interaction time, not earlier sim time', () => {
    const sub = createSub();
    // 100 ticks of physics without arming (simulates idle + placements)
    for (let i = 0; i < 100; i++) sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();

    // Now user interacts → arm and record
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    const range = useAppStore.getState().timelineRangePs;
    expect(range).not.toBeNull();
    // The first recorded frame time should reflect only the steps after arming,
    // not the 100 ticks worth of sim time that elapsed before arming.
    // 4 steps × 0.5 fs / 1000 = 0.002 ps (only the post-arming tick)
    expect(range!.start).toBeCloseTo(0.002);
  });

  // ── Recording lifecycle: off/on cycles ──

  it('turnRecordingOff from review exits review, clears history, goes to off', () => {
    const sub = createSub();
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();

    // Enter review
    sub.handleScrub(0);
    expect(sub.isInReview()).toBe(true);

    // Turn off while in review
    sub.turnRecordingOff();
    expect(useAppStore.getState().timelineRecordingMode).toBe('off');
    expect(sub.isInReview()).toBe(false);
    expect(useAppStore.getState().timelineMode).toBe('live');
    expect(useAppStore.getState().timelineRangePs).toBeNull();
    expect(useAppStore.getState().timelineCurrentTimePs).toBe(0);
    expect(useAppStore.getState().timelineRestartTargetPs).toBeNull();
  });

  it('turnRecordingOn after off returns to ready with empty history', () => {
    const sub = createSub();
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();

    // Turn off
    sub.turnRecordingOff();
    expect(useAppStore.getState().timelineRecordingMode).toBe('off');
    expect(useAppStore.getState().timelineRangePs).toBeNull();

    // Start recording again — immediate active with seed frame
    sub.startRecordingNow();
    expect(useAppStore.getState().timelineRecordingMode).toBe('active');
    const newRange = useAppStore.getState().timelineRangePs;
    expect(newRange).not.toBeNull();
    expect(newRange!.start).toBe(0); // fresh history from 0
  });

  it('multiple off/on cycles produce clean state each time', () => {
    const sub = createSub();

    for (let cycle = 0; cycle < 3; cycle++) {
      sub.startRecordingNow();
      expect(sub.getRecordingMode()).toBe('active');

      sub.recordAfterReconciliation(4);
      expect(useAppStore.getState().timelineRangePs).not.toBeNull();

      sub.turnRecordingOff();
      expect(sub.getRecordingMode()).toBe('off');
      expect(useAppStore.getState().timelineRangePs).toBeNull();
    }
  });

  it('atom interaction after re-enabling starts fresh history', () => {
    const sub = createSub();
    // First cycle
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    const firstRange = useAppStore.getState().timelineRangePs;
    expect(firstRange).not.toBeNull();

    // Off + restart recording
    sub.turnRecordingOff();
    sub.startRecordingNow();

    // Second cycle — immediate seed frame at time 0
    const secondRange = useAppStore.getState().timelineRangePs;
    expect(secondRange).not.toBeNull();
    expect(secondRange!.start).toBe(0);
  });

  // ── startRecordingNow (explicit enable with immediate seed frame) ──

  it('startRecordingNow transitions off → active and seeds first frame', () => {
    const sub = createSub();
    expect(sub.getRecordingMode()).toBe('off');
    sub.startRecordingNow();
    expect(sub.getRecordingMode()).toBe('active');
    // Should have seeded an immediate frame at time 0
    expect(useAppStore.getState().timelineRecordingMode).toBe('active');
    const range = useAppStore.getState().timelineRangePs;
    expect(range).not.toBeNull();
    expect(range!.start).toBe(0);
  });

  it('startRecordingNow is no-op when already in ready (via installAndEnable)', () => {
    const sub = createSub();
    sub.installAndEnable();
    expect(sub.getRecordingMode()).toBe('ready');
    sub.startRecordingNow();
    expect(sub.getRecordingMode()).toBe('ready'); // unchanged — startNow only works from off
  });

  it('startRecordingNow followed by ticks continues recording', () => {
    const sub = createSub();
    sub.startRecordingNow();
    // Seed frame at time 0
    const rangeAfterSeed = useAppStore.getState().timelineRangePs;
    expect(rangeAfterSeed).not.toBeNull();
    expect(rangeAfterSeed!.start).toBe(0);
    // Subsequent ticks advance time (recording is active)
    sub.recordAfterReconciliation(4);
    expect(sub.getRecordingMode()).toBe('active');
  });
});
