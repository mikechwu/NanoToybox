/**
 * Tests for the timeline recording orchestrator.
 *
 * Verifies:
 *  - No recording when disarmed
 *  - No recording in review mode
 *  - Sim time advancement
 *  - Dense/restart/checkpoint capture cadence
 *  - Reset clearing time and disarming policy
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRecordingOrchestrator } from '../../lab/js/runtime/timeline-recording-orchestrator';
import { createSimulationTimeline } from '../../lab/js/runtime/simulation-timeline';
import { createTimelineRecordingPolicy } from '../../lab/js/runtime/timeline-recording-policy';

function makePhysics(n = 60) {
  const pos = new Float64Array(n * 3);
  const vel = new Float64Array(n * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = i * 0.1;
  return {
    n,
    pos,
    vel,
    dragAtom: -1,
    isRotateMode: false,
    isTranslateMode: false,
    activeComponent: -1,
    dragTarget: [0, 0, 0],
    getBonds: () => [[0, 1, 1.42]],
    getDamping: () => 0,
    getDragStrength: () => 2,
    getRotateStrength: () => 5,
    getDtFs: () => 0.5,
    getBoundarySnapshot: () => ({
      mode: 'contain' as const, wallRadius: 50,
      wallCenter: [0, 0, 0] as [number, number, number],
      wallCenterSet: true, removedCount: 0, damping: 0,
    }),
    createCheckpoint: function () {
      return { n: this.n, pos: new Float64Array(this.pos), vel: new Float64Array(this.vel), bonds: [] };
    },
  } as any;
}

describe('TimelineRecordingOrchestrator', () => {
  let timeline: ReturnType<typeof createSimulationTimeline>;
  let policy: ReturnType<typeof createTimelineRecordingPolicy>;
  let physics: ReturnType<typeof makePhysics>;
  let syncCalls: number;

  function createOrch() {
    return createRecordingOrchestrator({
      timeline,
      policy,
      getPhysics: () => physics,
      syncStoreState: () => { syncCalls++; },
      getDtFs: () => 0.5,
    });
  }

  beforeEach(() => {
    timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxRestartFrames: 100, maxCheckpoints: 10 });
    policy = createTimelineRecordingPolicy();
    physics = makePhysics();
    syncCalls = 0;
  });

  it('does not record when disarmed', () => {
    const orch = createOrch();
    orch.tick(4);
    expect(timeline.getFrameCount()).toBe(0);
    expect(timeline.getRestartFrameCount()).toBe(0);
    expect(timeline.getCheckpointCount()).toBe(0);
  });

  it('records after arming', () => {
    const orch = createOrch();
    policy.turnOn(); policy.markAtomInteractionStarted();
    orch.tick(4);
    expect(timeline.getFrameCount()).toBe(1);
    expect(timeline.getRestartFrameCount()).toBe(1);
    expect(timeline.getCheckpointCount()).toBe(1);
  });

  it('does not record in review mode', () => {
    const orch = createOrch();
    policy.turnOn(); policy.markAtomInteractionStarted();
    orch.tick(4); // record one frame first
    timeline.enterReview(0); // enter review
    orch.tick(4); // should not record
    expect(timeline.getFrameCount()).toBe(1); // still 1
  });

  it('advances sim time on tick', () => {
    const orch = createOrch();
    policy.turnOn(); policy.markAtomInteractionStarted();
    expect(orch.getSimTimePs()).toBe(0);
    orch.tick(4); // 4 steps × 0.5 fs / 1000 = 0.002 ps
    expect(orch.getSimTimePs()).toBeCloseTo(0.002);
    orch.tick(2); // 2 × 0.5 / 1000 = 0.001 more = 0.003 total
    expect(orch.getSimTimePs()).toBeCloseTo(0.003);
  });

  it('does not advance time when substeps = 0', () => {
    const orch = createOrch();
    policy.turnOn(); policy.markAtomInteractionStarted();
    orch.tick(0);
    expect(orch.getSimTimePs()).toBe(0);
    expect(timeline.getFrameCount()).toBe(0);
  });

  it('does not record when physics.n = 0', () => {
    physics.n = 0;
    const orch = createOrch();
    policy.turnOn(); policy.markAtomInteractionStarted();
    orch.tick(4);
    expect(timeline.getFrameCount()).toBe(0);
  });

  it('syncs store state at recording cadence', () => {
    const orch = createOrch();
    policy.turnOn(); policy.markAtomInteractionStarted();
    orch.tick(4);
    expect(syncCalls).toBe(1);
  });

  it('reset clears time and disarms', () => {
    const orch = createOrch();
    policy.turnOn(); policy.markAtomInteractionStarted();
    orch.tick(4);
    expect(orch.getSimTimePs()).toBeGreaterThan(0);
    expect(policy.isArmed()).toBe(true);
    orch.reset();
    expect(orch.getSimTimePs()).toBe(0);
    expect(policy.isArmed()).toBe(false);
  });

  it('setSimTimePs overrides the clock', () => {
    const orch = createOrch();
    orch.setSimTimePs(1000);
    expect(orch.getSimTimePs()).toBe(1000);
  });

  it('records from reconciled physics (single authority)', () => {
    // The orchestrator always captures from physics.pos/vel directly.
    // No worker snapshot is consulted — recording runs after reconciliation.
    physics.pos[0] = 42.0;
    physics.vel[0] = 7.7;
    const orch = createOrch();
    policy.turnOn(); policy.markAtomInteractionStarted();
    orch.tick(4);
    const src = timeline.findRestartSource(100);
    expect(src).not.toBeNull();
    if (src?.kind === 'restartFrame') {
      expect(src.frame.positions[0]).toBe(42.0);
      expect(src.frame.velocities[0]).toBe(7.7);
    }
  });
});
