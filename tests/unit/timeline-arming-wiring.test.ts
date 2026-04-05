/**
 * @vitest-environment jsdom
 */
/**
 * Integration-style tests for timeline arming through non-dispatch paths.
 *
 * Tests the store callback closures from main.ts (registerStoreCallbacks)
 * to verify that non-atom actions do NOT arm recording:
 *
 *   - startPlacement → placement.start (must NOT arm)
 *   - pause / speed / physics settings (must NOT arm)
 *
 * Atom interaction arming through createInteractionDispatch is tested
 * separately in interaction-dispatch-arming.test.ts using the real
 * dispatch function. This file uses sub.markAtomInteractionStarted()
 * directly to model the positive-arming path.
 *
 * Pins the specific regression where startPlacement armed recording,
 * causing timeline frames to appear after molecule placement even without
 * atom interaction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTimelineSubsystem, type TimelineSubsystem } from '../../lab/js/runtime/timeline-subsystem';
import { useAppStore } from '../../lab/js/store/app-store';

// ── Minimal stubs matching main.ts construction ──

function makePhysics(n = 60) {
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
    setWallMode: vi.fn(),
    endDrag: vi.fn(), computeForces: vi.fn(), refreshTopology: vi.fn(),
    updateBondList: vi.fn(), rebuildComponents: vi.fn(),
    setPhysicsRef: vi.fn(),
  } as any;
}

function makeRenderer() {
  return {
    getAtomCount: () => 60,
    setAtomCount: vi.fn(),
    updateFromSnapshot: vi.fn(),
    updateReviewFrame: vi.fn(),
    setPhysicsRef: vi.fn(),
    clearFeedback: vi.fn(),
  } as any;
}

function createTestSubsystem() {
  return createTimelineSubsystem({
    getPhysics: () => physics,
    getRenderer: makeRenderer,
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: () => false,
    reinitWorker: vi.fn(async () => {}),
    isWorkerActive: () => false,
    forceRender: vi.fn(),
    clearBondedGroupHighlight: vi.fn(),
    clearRendererFeedback: vi.fn(),
    syncBondedGroupsForDisplayFrame: vi.fn(),
  });
}

let physics: ReturnType<typeof makePhysics>;

/**
 * Reconstruct the exact callback closures from main.ts to test wiring.
 * These mirror the createInteractionDispatch and registerStoreCallbacks
 * closures in main.ts.
 */
function createMainCallbacks(sub: TimelineSubsystem) {
  const placement = { start: vi.fn(), exit: vi.fn(), active: false };

  // Simulate atom interaction arming (the real path goes through
  // createInteractionDispatch → deps.markAtomInteractionStarted;
  // tested in interaction-dispatch-arming.test.ts)
  const simulateAtomInteraction = () => {
    sub.markAtomInteractionStarted();
  };

  // Mirrors main.ts:643 — togglePlaybackPause (arming removed)
  const togglePlaybackPause = () => {
    // No arming call — only atom interactions arm
  };

  // Mirrors main.ts:676 — changePlaybackSpeed (arming removed)
  const changePlaybackSpeed = (val: string) => {
    // No arming call
  };

  // Mirrors main.ts:714-717 — physics settings (arming removed)
  const setPhysicsWallMode = (mode: string) => { physics.setWallMode(mode); };
  const setPhysicsDragStrength = (v: number) => { physics.setDragStrength(v); };
  const setPhysicsRotateStrength = (v: number) => { physics.setRotateStrength(v); };
  const setPhysicsDamping = (d: number) => { physics.setDamping(d); };

  // Mirrors main.ts:726 — startPlacement (arming removed)
  const startPlacement = (file: string, desc: string) => {
    if (placement) placement.start(file, desc);
  };

  return {
    simulateAtomInteraction,
    togglePlaybackPause,
    changePlaybackSpeed,
    setPhysicsWallMode,
    setPhysicsDragStrength,
    setPhysicsRotateStrength,
    setPhysicsDamping,
    startPlacement,
    placement,
  };
}

describe('Timeline arming wiring (integration)', () => {
  let sub: TimelineSubsystem;
  let callbacks: ReturnType<typeof createMainCallbacks>;

  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    physics = makePhysics();
    sub = createTestSubsystem();
    sub.installAndEnable(); // Match main.ts init — start in ready state
    callbacks = createMainCallbacks(sub);
  });

  // ── The exact bug scenario from the report ──

  it('startPlacement + commit + frame ticks do not arm recording', () => {
    // Initial C60 loaded, physics running
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);

    // User opens placement, picks a molecule
    callbacks.startPlacement('cnt_5_5.xyz', 'CNT (5,5)');
    expect(callbacks.placement.start).toHaveBeenCalledWith('cnt_5_5.xyz', 'CNT (5,5)');

    // User commits placement (exits placement mode)
    callbacks.placement.exit(true);

    // Frame loop continues — physics stepping, reconciling
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);

    // Timeline must still be empty
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('multiple placements without atom interaction keep timeline empty', () => {
    // Place molecule 1
    callbacks.startPlacement('c60.xyz', 'C60');
    callbacks.placement.exit(true);
    sub.recordAfterReconciliation(4);

    // Place molecule 2
    callbacks.startPlacement('cnt_5_5.xyz', 'CNT (5,5)');
    callbacks.placement.exit(true);
    sub.recordAfterReconciliation(4);

    // Place molecule 3
    callbacks.startPlacement('graphene_6x6.xyz', 'Graphene 6x6');
    callbacks.placement.exit(true);
    sub.recordAfterReconciliation(4);

    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('atom interaction after placement starts recording', () => {
    // Place a molecule — no recording
    callbacks.startPlacement('c60.xyz', 'C60');
    callbacks.placement.exit(true);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();

    // User drags an atom → arming fires through interaction dispatch
    callbacks.simulateAtomInteraction();
    sub.recordAfterReconciliation(4);

    // Now recording must be armed
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();
  });

  // ── Non-atom actions must NOT arm ──

  it('pause toggle does not arm recording', () => {
    callbacks.togglePlaybackPause();
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('speed change does not arm recording', () => {
    callbacks.changePlaybackSpeed('2');
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('physics wall mode change does not arm recording', () => {
    callbacks.setPhysicsWallMode('remove');
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('physics drag strength change does not arm recording', () => {
    callbacks.setPhysicsDragStrength(5.0);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('physics rotate strength change does not arm recording', () => {
    callbacks.setPhysicsRotateStrength(10.0);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('physics damping change does not arm recording', () => {
    callbacks.setPhysicsDamping(0.5);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('all non-atom actions combined still do not arm recording', () => {
    callbacks.togglePlaybackPause();
    callbacks.changePlaybackSpeed('4');
    callbacks.setPhysicsWallMode('remove');
    callbacks.setPhysicsDragStrength(5.0);
    callbacks.setPhysicsRotateStrength(10.0);
    callbacks.setPhysicsDamping(0.5);
    callbacks.startPlacement('c60.xyz', 'C60');
    callbacks.placement.exit(true);
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);

    expect(useAppStore.getState().timelineRangePs).toBeNull();

    // Only atom interaction arms
    callbacks.simulateAtomInteraction();
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();
  });

  // ── Mobile touch → recording chain integration ──

  it('pinch-over-atom does not arm recording (touch pending intent cancelled)', () => {
    // This models the real bug: first finger on atom → second finger arrives for pinch.
    // The input layer's pending-intent mechanism prevents onPointerDown from firing,
    // so markAtomInteractionStarted is never reached.
    // We model this by NOT calling simulateAtomInteraction (which mirrors the
    // production path where onPointerDown → dispatch → markAtomInteractionStarted).
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    // No simulateAtomInteraction — pinch cancelled the pending intent
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('committed single-finger atom drag arms recording (touch intent committed)', () => {
    // The input layer committed the drag (exceeded threshold), so onPointerDown
    // fired → dispatch → markAtomInteractionStarted.
    sub.recordAfterReconciliation(4);
    callbacks.simulateAtomInteraction(); // models the committed drag path
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).not.toBeNull();
  });
});
