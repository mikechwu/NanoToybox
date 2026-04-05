/**
 * Tests for the simulation timeline subsystem:
 * - Dense frame recording cadence and retention
 * - Checkpoint cadence and retention
 * - Review mode entry and exit
 * - Scrub across frames with different n
 * - Restart from checkpoint
 * - Interaction-state capture and restore
 * - Boundary-state capture and restore
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSimulationTimeline,
  type SimulationTimeline,
} from '../../lab/js/runtime/simulation-timeline';
import {
  captureInteractionState,
  captureBoundaryState,
  restoreInteractionState,
  restoreBoundaryState,
  type TimelineInteractionState,
  type TimelineBoundaryState,
} from '../../lab/js/runtime/timeline-context-capture';

// ── Helpers ──

function makeConfig() { return { damping: 0, kDrag: 2, kRotate: 5 }; }

function makePositions(n: number, seed = 0): Float64Array {
  const p = new Float64Array(n * 3);
  for (let i = 0; i < p.length; i++) p[i] = seed + i * 0.1;
  return p;
}

function makeBoundary(mode: 'contain' | 'remove' = 'contain'): TimelineBoundaryState {
  return { mode, wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 };
}

/** Minimal mock physics engine for context capture/restore tests. */
function mockPhysics(overrides: Record<string, unknown> = {}) {
  return {
    n: 60,
    dragAtom: -1,
    isRotateMode: false,
    isTranslateMode: false,
    activeComponent: -1,
    dragTarget: [0, 0, 0],
    _wallRadius: 50,
    _wallCenter: [0, 0, 0],
    _wallCenterSet: true,
    _wallMode: 'contain',
    _wallRemovedCount: 0,
    pos: makePositions(60),
    vel: new Float64Array(60 * 3),
    getWallMode: function () { return this._wallMode; },
    getWallRadius: function () { return this._wallRadius; },
    getDamping: () => 0,
    setWallMode: vi.fn(function (this: any, m: string) { this._wallMode = m; }),
    setDamping: vi.fn(),
    getBoundarySnapshot: function () {
      return {
        mode: this._wallMode as 'contain' | 'remove',
        wallRadius: this._wallRadius,
        wallCenter: [this._wallCenter[0], this._wallCenter[1], this._wallCenter[2]] as [number, number, number],
        wallCenterSet: this._wallCenterSet,
        removedCount: this._wallRemovedCount,
        damping: 0,
      };
    },
    restoreBoundarySnapshot: vi.fn(function (this: any, snap: any) {
      this._wallMode = snap.mode;
      this._wallRadius = snap.wallRadius;
      this._wallCenter = [...snap.wallCenter];
      this._wallCenterSet = snap.wallCenterSet;
      this._wallRemovedCount = snap.removedCount;
    }),
    startDrag: vi.fn(function (this: any, idx: number) { this.dragAtom = idx; }),
    startTranslate: vi.fn(function (this: any, idx: number) { this.dragAtom = idx; this.isTranslateMode = true; }),
    startRotateDrag: vi.fn(function (this: any, idx: number) { this.dragAtom = idx; this.isRotateMode = true; }),
    updateDrag: vi.fn(),
    endDrag: vi.fn(function (this: any) { this.dragAtom = -1; this.isRotateMode = false; this.isTranslateMode = false; }),
    createCheckpoint: function () {
      return { n: this.n, pos: new Float64Array(this.pos), vel: new Float64Array(this.vel), bonds: [] };
    },
    ...overrides,
  } as any;
}

// ── Tests ──

describe('SimulationTimeline', () => {
  let timeline: SimulationTimeline;

  beforeEach(() => {
    // Use very short intervals for testing
    timeline = createSimulationTimeline({
      denseIntervalMs: 0,       // no throttle in tests
      checkpointIntervalMs: 0,
      maxDenseFrames: 10,
      maxCheckpoints: 5,
    });
  });

  describe('dense frame recording', () => {
    it('records and retrieves frames', () => {
      timeline.recordFrame({ timePs: 100, n: 60, positions: makePositions(60), interaction: null, boundary: makeBoundary() });
      timeline.recordFrame({ timePs: 200, n: 60, positions: makePositions(60, 1), interaction: null, boundary: makeBoundary() });
      expect(timeline.getFrameCount()).toBe(2);
    });

    it('deep-copies positions', () => {
      const pos = makePositions(10);
      timeline.recordFrame({ timePs: 100, n: 10, positions: pos, interaction: null, boundary: makeBoundary() });
      pos[0] = 999; // mutate original
      const frame = timeline.enterReview(100);
      expect(frame).not.toBeNull();
      expect(frame!.positions[0]).not.toBe(999);
    });

    it('enforces retention limit', () => {
      for (let i = 0; i < 15; i++) {
        timeline.recordFrame({ timePs: i * 100, n: 10, positions: makePositions(10, i), interaction: null, boundary: makeBoundary() });
      }
      expect(timeline.getFrameCount()).toBe(10); // max
      // Oldest frames evicted
      const state = timeline.getState();
      expect(state.rangePs!.start).toBe(500); // frames 5-14
    });
  });

  describe('sparse checkpoint recording', () => {
    it('records checkpoints', () => {
      const physics = mockPhysics();
      timeline.recordCheckpoint({
        timePs: 1000,
        physics: physics.createCheckpoint(),
        config: makeConfig(),
        interaction: captureInteractionState(physics),
        boundary: captureBoundaryState(physics),
      });
      expect(timeline.getCheckpointCount()).toBe(1);
    });

    it('enforces retention limit', () => {
      const physics = mockPhysics();
      for (let i = 0; i < 8; i++) {
        timeline.recordCheckpoint({
          timePs: i * 1000,
          physics: physics.createCheckpoint(),
          config: makeConfig(),
          interaction: captureInteractionState(physics),
          boundary: captureBoundaryState(physics),
        });
      }
      expect(timeline.getCheckpointCount()).toBe(5); // max
    });

    it('deep-copies checkpoint physics', () => {
      const physics = mockPhysics();
      const cp = physics.createCheckpoint();
      timeline.recordCheckpoint({ timePs: 1000, physics: cp, config: makeConfig(), interaction: null, boundary: makeBoundary() });
      cp.pos[0] = 999; // mutate original
      const found = timeline.findCheckpointAtOrBefore(1000);
      expect(found).not.toBeNull();
      expect(found!.physics.pos[0]).not.toBe(999);
    });
  });

  describe('review mode', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        timeline.recordFrame({ timePs: i * 100, n: 60, positions: makePositions(60, i), interaction: null, boundary: makeBoundary() });
      }
    });

    it('starts in live mode', () => {
      expect(timeline.getState().mode).toBe('live');
    });

    it('enters review and returns correct frame', () => {
      const frame = timeline.enterReview(250);
      expect(timeline.getState().mode).toBe('review');
      expect(frame).not.toBeNull();
      expect(frame!.timePs).toBe(200); // nearest at-or-before
    });

    it('scrubs to different times', () => {
      timeline.enterReview(100);
      const frame = timeline.scrubTo(350);
      expect(frame).not.toBeNull();
      expect(frame!.timePs).toBe(300);
    });

    it('returns to live', () => {
      timeline.enterReview(200);
      timeline.returnToLive();
      expect(timeline.getState().mode).toBe('live');
      expect(timeline.getState().reviewTimePs).toBeNull();
    });

    it('scrub returns null when not in review', () => {
      expect(timeline.scrubTo(100)).toBeNull();
    });

    it('reports canReturnToLive correctly', () => {
      expect(timeline.getState().canReturnToLive).toBe(false);
      timeline.enterReview(100);
      expect(timeline.getState().canReturnToLive).toBe(true);
    });
  });

  describe('scrub across variable atom counts', () => {
    it('returns frames with different n values', () => {
      timeline.recordFrame({ timePs: 100, n: 100, positions: makePositions(100), interaction: null, boundary: makeBoundary() });
      timeline.recordFrame({ timePs: 200, n: 80, positions: makePositions(80), interaction: null, boundary: makeBoundary() });
      timeline.recordFrame({ timePs: 300, n: 120, positions: makePositions(120), interaction: null, boundary: makeBoundary() });

      const f1 = timeline.enterReview(100);
      expect(f1!.n).toBe(100);

      const f2 = timeline.scrubTo(200);
      expect(f2!.n).toBe(80);

      const f3 = timeline.scrubTo(300);
      expect(f3!.n).toBe(120);
    });
  });

  describe('restart from checkpoint', () => {
    it('finds nearest checkpoint at or before target', () => {
      const physics = mockPhysics();
      for (let i = 0; i < 3; i++) {
        timeline.recordCheckpoint({
          timePs: i * 1000,
          physics: physics.createCheckpoint(),
          config: makeConfig(),
          interaction: null,
          boundary: makeBoundary(),
        });
      }
      const cp = timeline.findCheckpointAtOrBefore(1500);
      expect(cp).not.toBeNull();
      expect(cp!.timePs).toBe(1000);
    });

    it('returns null when no checkpoints exist', () => {
      expect(timeline.findCheckpointAtOrBefore(500)).toBeNull();
    });

    it('canRestart is true only in review with checkpoints', () => {
      const physics = mockPhysics();
      timeline.recordFrame({ timePs: 100, n: 60, positions: makePositions(60), interaction: null, boundary: makeBoundary() });
      timeline.recordCheckpoint({ timePs: 100, physics: physics.createCheckpoint(), config: makeConfig(), interaction: null, boundary: makeBoundary() });

      expect(timeline.getState().canRestart).toBe(false); // live
      timeline.enterReview(100);
      expect(timeline.getState().canRestart).toBe(true); // review + checkpoints
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      timeline.recordFrame({ timePs: 100, n: 10, positions: makePositions(10), interaction: null, boundary: makeBoundary() });
      timeline.enterReview(100);
      timeline.clear();
      expect(timeline.getFrameCount()).toBe(0);
      expect(timeline.getCheckpointCount()).toBe(0);
      expect(timeline.getState().mode).toBe('live');
    });
  });
});

describe('TimelineContextCapture', () => {
  describe('captureInteractionState', () => {
    it('captures none when no drag', () => {
      const physics = mockPhysics();
      const state = captureInteractionState(physics);
      expect(state.kind).toBe('none');
    });

    it('captures atom drag', () => {
      const physics = mockPhysics({ dragAtom: 5, dragTarget: [1, 2, 3] });
      const state = captureInteractionState(physics);
      expect(state.kind).toBe('atom_drag');
      if (state.kind === 'atom_drag') {
        expect(state.atomIndex).toBe(5);
        expect(state.target).toEqual([1, 2, 3]);
      }
    });

    it('captures move group', () => {
      const physics = mockPhysics({ dragAtom: 10, isTranslateMode: true, activeComponent: 2, dragTarget: [4, 5, 6] });
      const state = captureInteractionState(physics);
      expect(state.kind).toBe('move_group');
      if (state.kind === 'move_group') {
        expect(state.componentId).toBe(2);
      }
    });

    it('captures rotate group', () => {
      const physics = mockPhysics({ dragAtom: 10, isRotateMode: true, activeComponent: 1, dragTarget: [7, 8, 9] });
      const state = captureInteractionState(physics);
      expect(state.kind).toBe('rotate_group');
    });
  });

  describe('restoreInteractionState', () => {
    it('restores atom drag', () => {
      const physics = mockPhysics();
      restoreInteractionState(physics, { kind: 'atom_drag', atomIndex: 5, target: [1, 2, 3] });
      expect(physics.startDrag).toHaveBeenCalledWith(5);
      expect(physics.updateDrag).toHaveBeenCalledWith(1, 2, 3);
    });

    it('restores move group', () => {
      const physics = mockPhysics();
      restoreInteractionState(physics, { kind: 'move_group', atomIndex: 10, componentId: 2, target: [4, 5, 6] });
      expect(physics.startTranslate).toHaveBeenCalledWith(10);
      expect(physics.updateDrag).toHaveBeenCalledWith(4, 5, 6);
    });

    it('restores rotate group', () => {
      const physics = mockPhysics();
      restoreInteractionState(physics, { kind: 'rotate_group', atomIndex: 3, componentId: 1, target: [7, 8, 9] });
      expect(physics.startRotateDrag).toHaveBeenCalledWith(3);
    });

    it('skips restore when atom index out of range', () => {
      const physics = mockPhysics({ n: 5 });
      restoreInteractionState(physics, { kind: 'atom_drag', atomIndex: 10, target: [0, 0, 0] });
      expect(physics.startDrag).not.toHaveBeenCalled();
    });

    it('clears existing drag before restoring', () => {
      const physics = mockPhysics({ dragAtom: 3 });
      restoreInteractionState(physics, { kind: 'none' });
      expect(physics.endDrag).toHaveBeenCalled();
    });
  });

  describe('captureBoundaryState', () => {
    it('captures wall state', () => {
      const physics = mockPhysics();
      const state = captureBoundaryState(physics);
      expect(state.mode).toBe('contain');
      expect(state.wallRadius).toBe(50);
      expect(state.wallCenter).toEqual([0, 0, 0]);
      expect(state.wallCenterSet).toBe(true);
    });
  });

  describe('restoreBoundaryState', () => {
    it('delegates to physics.restoreBoundarySnapshot', () => {
      const physics = mockPhysics();
      const snap = {
        mode: 'remove' as const,
        wallRadius: 100,
        wallCenter: [1, 2, 3] as [number, number, number],
        wallCenterSet: true,
        removedCount: 5,
        damping: 0.1,
      };
      restoreBoundaryState(physics, snap);
      expect(physics.restoreBoundarySnapshot).toHaveBeenCalledWith(snap);
    });
  });
});

describe('SimulationTimeline — review range freeze', () => {
  it('freezes range on enterReview so scrubber is stable', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxCheckpoints: 10 });
    for (let i = 0; i < 10; i++) {
      timeline.recordFrame({ timePs: i * 100, n: 10, positions: makePositions(10, i), interaction: null, boundary: makeBoundary() });
    }
    // Enter review at t=500
    timeline.enterReview(500);
    const reviewState = timeline.getState();
    expect(reviewState.rangePs).toEqual({ start: 0, end: 900 });

    // Record more frames while in review (live recording continues in background)
    timeline.recordFrame({ timePs: 1000, n: 10, positions: makePositions(10, 10), interaction: null, boundary: makeBoundary() });
    timeline.recordFrame({ timePs: 1100, n: 10, positions: makePositions(10, 11), interaction: null, boundary: makeBoundary() });

    // Range should still be frozen at the entry snapshot
    const stillReview = timeline.getState();
    expect(stillReview.rangePs).toEqual({ start: 0, end: 900 });

    // After returning to live, range reflects all frames
    timeline.returnToLive();
    const liveState = timeline.getState();
    expect(liveState.rangePs!.end).toBe(1100);
  });
});

describe('SimulationTimeline — review non-interactivity at data layer', () => {
  it('getState().mode is review after enterReview', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 10, maxCheckpoints: 5 });
    timeline.recordFrame({ timePs: 100, n: 10, positions: makePositions(10), interaction: null, boundary: makeBoundary() });
    timeline.enterReview(100);
    expect(timeline.getState().mode).toBe('review');
    // Code at input-bindings and bonded-group-highlight-runtime checks this
    // to block all scene interaction during review.
  });
});

describe('SimulationTimeline — restart contract', () => {
  it('prefers restart frame (pos + vel) over earlier checkpoint', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxRestartFrames: 100, maxCheckpoints: 10 });
    const physics = mockPhysics();
    timeline.recordCheckpoint({ timePs: 0, physics: physics.createCheckpoint(), config: makeConfig(), interaction: null, boundary: makeBoundary() });
    // Restart frames at 100..500
    for (let i = 1; i <= 5; i++) {
      timeline.recordRestartFrame({ timePs: i * 100, n: 60, positions: makePositions(60, i), velocities: makePositions(60, i + 10), bonds: [], config: makeConfig(), interaction: null, boundary: makeBoundary() });
    }

    // At t=350: restart frame at t=300 is closer than checkpoint at t=0
    const src = timeline.findRestartSource(350);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('restartFrame');
    if (src!.kind === 'restartFrame') {
      expect(src!.frame.timePs).toBe(300);
      // Has velocities — physically consistent
      expect(src!.frame.velocities.length).toBeGreaterThan(0);
    }
  });

  it('falls back to checkpoint when no restart frame exists', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxRestartFrames: 100, maxCheckpoints: 10 });
    const physics = mockPhysics();
    timeline.recordCheckpoint({ timePs: 0, physics: physics.createCheckpoint(), config: makeConfig(), interaction: null, boundary: makeBoundary() });

    const src = timeline.findRestartSource(500);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('checkpoint');
    if (src!.kind === 'checkpoint') {
      expect(src!.checkpoint.timePs).toBe(0);
    }
  });

  it('restartTargetPs in state reflects the nearest restart source time', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxRestartFrames: 100, maxCheckpoints: 10 });
    const physics = mockPhysics();
    timeline.recordCheckpoint({ timePs: 0, physics: physics.createCheckpoint(), config: makeConfig(), interaction: null, boundary: makeBoundary() });
    timeline.recordRestartFrame({ timePs: 400, n: 60, positions: makePositions(60), velocities: makePositions(60), bonds: [], config: makeConfig(), interaction: null, boundary: makeBoundary() });
    timeline.recordFrame({ timePs: 400, n: 60, positions: makePositions(60), interaction: null, boundary: makeBoundary() });

    timeline.enterReview(400);
    const state = timeline.getState();
    // Restart target should be t=400 (restart frame), not t=0 (checkpoint)
    expect(state.restartTargetPs).toBe(400);
    expect(state.canRestart).toBe(true);
  });

  it('restartTargetPs is null when no restart source available', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxRestartFrames: 100, maxCheckpoints: 10 });
    timeline.recordFrame({ timePs: 100, n: 10, positions: makePositions(10), interaction: null, boundary: makeBoundary() });
    timeline.enterReview(100);
    expect(timeline.getState().restartTargetPs).toBeNull();
    expect(timeline.getState().canRestart).toBe(false);
  });
});

describe('SimulationTimeline — restart frame preserves motion state', () => {
  it('restart frame stores nonzero velocities for motion preservation', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxRestartFrames: 100, maxCheckpoints: 10 });
    // Simulate a moving molecule: nonzero velocities
    const vel = new Float64Array(60 * 3);
    for (let i = 0; i < vel.length; i++) vel[i] = 0.01 * (i + 1); // nonzero
    timeline.recordRestartFrame({
      timePs: 500, n: 60,
      positions: makePositions(60, 5),
      velocities: vel,
      bonds: [[0, 1, 1.42], [1, 2, 1.42]],
      config: { damping: 0.1, kDrag: 3, kRotate: 7 },
      interaction: { kind: 'move_group', atomIndex: 0, componentId: 0, target: [1, 2, 3] },
      boundary: makeBoundary(),
    });

    const src = timeline.findRestartSource(500);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('restartFrame');
    if (src!.kind === 'restartFrame') {
      // Velocities preserved — not zeroed
      const v = src!.frame.velocities;
      expect(v.length).toBe(60 * 3);
      expect(v[0]).toBeCloseTo(0.01);
      expect(v[1]).toBeCloseTo(0.02);
      // Bonds preserved
      expect(src!.frame.bonds.length).toBe(2);
      expect(src!.frame.bonds[0]).toEqual([0, 1, 1.42]);
      // Interaction preserved
      expect(src!.frame.interaction).not.toBeNull();
      expect(src!.frame.interaction!.kind).toBe('move_group');
      // Physics coefficients preserved
      expect(src!.frame.config.damping).toBe(0.1);
      expect(src!.frame.config.kDrag).toBe(3);
      expect(src!.frame.config.kRotate).toBe(7);
    }
  });
});

describe('SimulationTimeline — truncation on restart', () => {
  it('truncateAfter removes frames/restartFrames/checkpoints after cutoff', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxRestartFrames: 100, maxCheckpoints: 10 });
    const physics = mockPhysics();
    for (let i = 0; i <= 10; i++) {
      timeline.recordFrame({ timePs: i * 100, n: 10, positions: makePositions(10, i), interaction: null, boundary: makeBoundary() });
      timeline.recordRestartFrame({ timePs: i * 100, n: 10, positions: makePositions(10, i), velocities: makePositions(10, i), bonds: [], config: makeConfig(), interaction: null, boundary: makeBoundary() });
    }
    timeline.recordCheckpoint({ timePs: 0, physics: physics.createCheckpoint(), config: makeConfig(), interaction: null, boundary: makeBoundary() });
    timeline.recordCheckpoint({ timePs: 500, physics: physics.createCheckpoint(), config: makeConfig(), interaction: null, boundary: makeBoundary() });
    timeline.recordCheckpoint({ timePs: 1000, physics: physics.createCheckpoint(), config: makeConfig(), interaction: null, boundary: makeBoundary() });

    // Truncate at t=500: frames at 600..1000 should be removed
    timeline.truncateAfter(500);
    expect(timeline.getFrameCount()).toBe(6); // 0,100,200,300,400,500
    expect(timeline.getRestartFrameCount()).toBe(6);
    expect(timeline.getCheckpointCount()).toBe(2); // 0, 500 (1000 removed)

    // Range should now end at 500
    const range = timeline.getState().rangePs;
    expect(range).not.toBeNull();
    expect(range!.end).toBe(500);
  });

  it('new frames after truncation maintain monotonic time', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 100, maxRestartFrames: 100, maxCheckpoints: 10 });
    // Record 0..500
    for (let i = 0; i <= 5; i++) {
      timeline.recordFrame({ timePs: i * 100, n: 10, positions: makePositions(10, i), interaction: null, boundary: makeBoundary() });
    }
    // Truncate at 300 (removes 400, 500)
    timeline.truncateAfter(300);
    expect(timeline.getFrameCount()).toBe(4); // 0,100,200,300

    // Record new frames starting from 300 (simulating restart)
    timeline.recordFrame({ timePs: 310, n: 10, positions: makePositions(10, 99), interaction: null, boundary: makeBoundary() });
    timeline.recordFrame({ timePs: 320, n: 10, positions: makePositions(10, 99), interaction: null, boundary: makeBoundary() });

    // All frames should be monotonic
    expect(timeline.getFrameCount()).toBe(6);
    const range = timeline.getState().rangePs;
    expect(range!.start).toBe(0);
    expect(range!.end).toBe(320);

    // Scrub should still work correctly across the restart boundary
    const frame = timeline.findFrameAtOrBefore(305);
    expect(frame).not.toBeNull();
    expect(frame!.timePs).toBe(300);
  });
});

describe('SimulationTimeline — arming policy (verified at integration level)', () => {
  it('timeline is empty when no frames have been recorded', () => {
    // This verifies the baseline: an idle timeline has no history.
    // In the real app, the recording gate (_timelineArmed) in main.ts
    // prevents recordFrame/recordRestartFrame/recordCheckpoint from being
    // called until first meaningful user interaction.
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 10, maxRestartFrames: 10, maxCheckpoints: 5 });
    expect(timeline.getFrameCount()).toBe(0);
    expect(timeline.getRestartFrameCount()).toBe(0);
    expect(timeline.getCheckpointCount()).toBe(0);
    expect(timeline.getState().rangePs).toBeNull();
  });

  it('clear resets to empty (simulates playground clear disarming)', () => {
    const timeline = createSimulationTimeline({ denseIntervalMs: 0, checkpointIntervalMs: 0, maxDenseFrames: 10, maxRestartFrames: 10, maxCheckpoints: 5 });
    timeline.recordFrame({ timePs: 100, n: 10, positions: makePositions(10), interaction: null, boundary: makeBoundary() });
    expect(timeline.getFrameCount()).toBe(1);
    timeline.clear();
    expect(timeline.getFrameCount()).toBe(0);
    expect(timeline.getState().rangePs).toBeNull();
  });
});
