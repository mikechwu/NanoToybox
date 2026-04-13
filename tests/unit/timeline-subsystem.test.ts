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
import { createTimelineSubsystem, type TimelineSubsystem } from '../../lab/js/runtime/timeline-subsystem';
import { useAppStore } from '../../lab/js/store/app-store';

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

function makeSceneMolecules(n = 10) {
  return [{
    atomOffset: 0,
    atomCount: n,
    localAtoms: Array.from({ length: n }, () => ({ element: 'C' })),
    structureFile: 'c60.xyz',
    name: 'C60',
  }];
}

function createSub(physics = makePhysics(), renderer = makeRenderer(), molecules = makeSceneMolecules(physics.n)): TimelineSubsystem {
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
    syncBondedGroupsForDisplayFrame: vi.fn(),
    getSceneMolecules: () => molecules,
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

  // ── Export capability lifecycle ──

  describe('export capability lifecycle', () => {
    const exportCaps = { full: true, capsule: true };

    function createSubWithExport(physics = makePhysics(), renderer = makeRenderer(), molecules = makeSceneMolecules(physics.n)): TimelineSubsystem {
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
        syncBondedGroupsForDisplayFrame: vi.fn(),
        getSceneMolecules: () => molecules,
        exportHistory: vi.fn(async () => 'saved' as const),
        exportCapabilities: exportCaps,
      });
    }

    it('installAndEnable sets export capability in store', () => {
      const sub = createSubWithExport();
      sub.installAndEnable();
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);
    });

    it('startRecordingNow restores export capability after turnRecordingOff', () => {
      const sub = createSubWithExport();
      sub.installAndEnable();
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);

      // Turn off clears capability
      sub.turnRecordingOff();
      expect(useAppStore.getState().timelineExportCapabilities).toBeNull();

      // Start recording again — capability must be restored
      sub.startRecordingNow();
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);
    });

    it('resetToPassiveReady restores export capability', () => {
      const sub = createSubWithExport();
      sub.installAndEnable();
      sub.markAtomInteractionStarted();
      sub.recordAfterReconciliation(4);

      sub.resetToPassiveReady();
      expect(useAppStore.getState().timelineRecordingMode).toBe('ready');
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);
    });

    it('multiple off/on cycles preserve export capability each time', () => {
      const sub = createSubWithExport();
      sub.installAndEnable();

      for (let cycle = 0; cycle < 3; cycle++) {
        sub.turnRecordingOff();
        expect(useAppStore.getState().timelineExportCapabilities).toBeNull();

        sub.startRecordingNow();
        expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);
      }
    });

    it('subsystem without export deps has null capability throughout', () => {
      const sub = createSub(); // no export deps
      sub.installAndEnable();
      expect(useAppStore.getState().timelineExportCapabilities).toBeNull();

      sub.startRecordingNow();
      expect(useAppStore.getState().timelineExportCapabilities).toBeNull();
    });

    it('identity staleness clears export capability', () => {
      const sub = createSubWithExport();
      sub.installAndEnable();
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);

      sub.markIdentityStale();
      expect(useAppStore.getState().timelineExportCapabilities).toBeNull();
    });

    it('resetToPassiveReady clears staleness and restores capability', () => {
      const sub = createSubWithExport();
      sub.installAndEnable();
      sub.markIdentityStale();
      expect(useAppStore.getState().timelineExportCapabilities).toBeNull();
      expect(sub.isIdentityStale()).toBe(true);

      sub.resetToPassiveReady();
      expect(sub.isIdentityStale()).toBe(false);
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);
    });

    it('publishTimelineReadyState does not clear export capability (subsystem owns it)', () => {
      // Pin the ownership contract: the store's ready-state publisher must not
      // touch timelineExportCapabilities — the subsystem is the sole owner.
      useAppStore.getState().setTimelineExportCapabilities(exportCaps);
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);

      useAppStore.getState().publishTimelineReadyState();
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);
    });
  });

  // ── Export atom state rehydration ──

  describe('export atom state rehydration after restart', () => {
    it('atom table is non-empty after stop → startRecordingNow', () => {
      const sub = createSub();
      sub.startRecordingNow();
      sub.recordAfterReconciliation(4);

      // Stop recording — clears tracker + registry
      sub.turnRecordingOff();
      expect(sub.getAtomMetadataRegistry().getAtomTable()).toHaveLength(0);

      // Start again — should rebuild from scene
      sub.startRecordingNow();
      expect(sub.getAtomMetadataRegistry().getAtomTable()).toHaveLength(10);
    });

    it('atom table is non-empty after resetToPassiveReady → arm via interaction', () => {
      const sub = createSub();
      sub.installAndEnable();
      sub.markAtomInteractionStarted();
      sub.recordAfterReconciliation(4);

      // Reset to passive — clears then eagerly rebuilds from scene
      sub.resetToPassiveReady();
      expect(sub.getAtomMetadataRegistry().getAtomTable()).toHaveLength(10);

      // Atom interaction re-arms — tracker already valid from eager rebuild
      sub.markAtomInteractionStarted();
      expect(sub.getAtomMetadataRegistry().getAtomTable()).toHaveLength(10);
    });

    it('tracker and registry stay in sync after restart', () => {
      const sub = createSub();
      sub.startRecordingNow();
      sub.turnRecordingOff();
      sub.startRecordingNow();

      const table = sub.getAtomMetadataRegistry().getAtomTable();
      const tracker = sub.getAtomIdentityTracker();
      expect(table).toHaveLength(10);
      expect(tracker.getTotalAssigned()).toBe(10);
      // Every atom in the table should have a valid id matching the tracker
      for (const entry of table) {
        expect(entry.id).toBeGreaterThanOrEqual(0);
        expect(entry.id).toBeLessThan(10);
      }
    });

    it('export snapshot has matching atomIds and atom table after restart', () => {
      const sub = createSub();
      sub.startRecordingNow();
      sub.recordAfterReconciliation(4);
      sub.turnRecordingOff();

      sub.startRecordingNow();
      sub.recordAfterReconciliation(4);

      const snapshot = sub.getTimelineExportSnapshot();
      const table = sub.getAtomMetadataRegistry().getAtomTable();
      const tableIdSet = new Set(table.map(e => e.id));

      // Every frame's atomIds should be in the atom table
      for (const frame of snapshot.denseFrames) {
        for (const id of frame.atomIds) {
          expect(tableIdSet.has(id)).toBe(true);
        }
      }
    });

    it('rebuildExportAtomState is graceful on bad scene data (disables export, does not crash)', () => {
      const badMolecules = [{
        atomOffset: 0, atomCount: 5,
        localAtoms: [{ element: 'C' }, { element: 'C' }], // mismatch: 2 !== 5
        structureFile: 'bad.xyz', name: 'Bad',
      }];
      const sub = createSub(makePhysics(5), makeRenderer(), badMolecules);

      // Should not throw — error is caught at the recording-entry boundary
      sub.startRecordingNow();
      expect(sub.getRecordingMode()).toBe('active');
      // Export capability should be durably disabled since rebuild failed
      expect(useAppStore.getState().timelineExportCapabilities).toBeNull();
      expect(sub.isIdentityStale()).toBe(true);
    });
  });

  // ── Worker staleness → export disabled (integration) ──

  describe('worker staleness disables export end-to-end', () => {
    const exportCaps = { full: true, capsule: true };

    it('markIdentityStale disables capability, export callback throws', async () => {
      let exportError: Error | null = null;
      const exportHistory = vi.fn(async (_kind: 'full' | 'capsule'): Promise<'saved' | 'picker-cancelled'> => {
        // Simulate the real main.ts export callback pattern
        if (sub.isIdentityStale()) {
          throw new Error('Export is unavailable because atom identity is stale after worker compaction.');
        }
        return 'saved';
      });

      const sub = createTimelineSubsystem({
        getPhysics: () => makePhysics(),
        getRenderer: () => makeRenderer(),
        pause: vi.fn(), resume: vi.fn(), isPaused: () => false,
        reinitWorker: vi.fn(async () => {}), isWorkerActive: () => false,
        forceRender: vi.fn(),
        clearBondedGroupHighlight: vi.fn(), clearRendererFeedback: vi.fn(),
        syncBondedGroupsForDisplayFrame: vi.fn(),
        getSceneMolecules: () => makeSceneMolecules(),
        exportHistory,
        exportCapabilities: exportCaps,
      });

      sub.installAndEnable();
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);

      // Start recording so there's something to export
      sub.startRecordingNow();
      sub.recordAfterReconciliation(4);
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);

      // Simulate worker wallRemoval → markIdentityStale
      sub.markIdentityStale();
      expect(sub.isIdentityStale()).toBe(true);
      expect(useAppStore.getState().timelineExportCapabilities).toBeNull();

      // Export callback should throw stale-identity error
      try {
        await exportHistory('full');
      } catch (err) {
        exportError = err as Error;
      }
      expect(exportError).not.toBeNull();
      expect(exportError!.message).toContain('stale');
    });

    it('resetToPassiveReady clears staleness and re-enables export after worker staleness', () => {
      const sub = createTimelineSubsystem({
        getPhysics: () => makePhysics(),
        getRenderer: () => makeRenderer(),
        pause: vi.fn(), resume: vi.fn(), isPaused: () => false,
        reinitWorker: vi.fn(async () => {}), isWorkerActive: () => false,
        forceRender: vi.fn(),
        clearBondedGroupHighlight: vi.fn(), clearRendererFeedback: vi.fn(),
        syncBondedGroupsForDisplayFrame: vi.fn(),
        getSceneMolecules: () => makeSceneMolecules(),
        exportHistory: vi.fn(async () => 'saved' as const),
        exportCapabilities: exportCaps,
      });

      sub.installAndEnable();
      sub.markAtomInteractionStarted();
      sub.recordAfterReconciliation(4);

      // Worker staleness disables export
      sub.markIdentityStale();
      expect(useAppStore.getState().timelineExportCapabilities).toBeNull();

      // Scene clear → resetToPassiveReady should recover
      sub.resetToPassiveReady();
      expect(sub.isIdentityStale()).toBe(false);
      expect(useAppStore.getState().timelineExportCapabilities).toEqual(exportCaps);
    });

    it('installAndEnable starts with valid (non-stale) tracker', () => {
      const sub = createTimelineSubsystem({
        getPhysics: () => makePhysics(),
        getRenderer: () => makeRenderer(),
        pause: vi.fn(), resume: vi.fn(), isPaused: () => false,
        reinitWorker: vi.fn(async () => {}), isWorkerActive: () => false,
        forceRender: vi.fn(),
        clearBondedGroupHighlight: vi.fn(), clearRendererFeedback: vi.fn(),
        syncBondedGroupsForDisplayFrame: vi.fn(),
        getSceneMolecules: () => makeSceneMolecules(),
        exportHistory: vi.fn(async () => 'saved' as const),
        exportCapabilities: exportCaps,
      });
      sub.installAndEnable();
      expect(sub.isIdentityStale()).toBe(false);
      expect(sub.getAtomIdentityTracker().getTotalAssigned()).toBe(10);
      sub.teardown();
    });

    it('tryRebuild cleans corrupted color assignments with negative atomIds', () => {
      const exportCaps = { full: true, capsule: true };
      const sub = createSub(exportCaps);
      sub.installAndEnable();

      // Seed a corrupted assignment with negative atomIds
      useAppStore.setState({
        bondedGroupColorAssignments: [
          { id: 'bad1', atomIndices: [0, 1], atomIds: [-1, -1], colorHex: '#ff0000', sourceGroupId: 'g1' },
          { id: 'good1', atomIndices: [2, 3], atomIds: [2, 3], colorHex: '#00ff00', sourceGroupId: 'g2' },
        ],
      });

      // Rebuild should clean out the bad assignment
      sub.resetToPassiveReady();
      const remaining = useAppStore.getState().bondedGroupColorAssignments;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('good1');
      sub.teardown();
    });

    it('corrupted-assignment cleanup syncs appearance and clears stale overrides', () => {
      const syncAppearance = vi.fn(() => {
        // Simulate what the real syncToRenderer does: recompute overrides from cleaned assignments
        const cleaned = useAppStore.getState().bondedGroupColorAssignments;
        const hasOverrides = cleaned.some(a => a.atomIds.length > 0);
        useAppStore.setState({ bondedGroupColorOverrides: hasOverrides ? { 0: { hex: '#00ff00' } } : {} });
      });
      const sub = createTimelineSubsystem({
        getPhysics: () => makePhysics(),
        getRenderer: () => makeRenderer(),
        pause: vi.fn(), resume: vi.fn(), isPaused: () => false,
        reinitWorker: vi.fn(async () => {}), isWorkerActive: () => false,
        forceRender: vi.fn(),
        clearBondedGroupHighlight: vi.fn(), clearRendererFeedback: vi.fn(),
        syncBondedGroupsForDisplayFrame: vi.fn(),
        getSceneMolecules: () => makeSceneMolecules(),
        syncAppearance,
        exportHistory: vi.fn(async () => 'saved' as const),
        exportCapabilities: exportCaps,
      });
      sub.installAndEnable();

      // Seed corrupted assignment + stale override derived from it
      useAppStore.setState({
        bondedGroupColorAssignments: [
          { id: 'bad', atomIndices: [0], atomIds: [-1], colorHex: '#ff0000', sourceGroupId: 'g1' },
        ],
        bondedGroupColorOverrides: { 0: { hex: '#ff0000' } },
      });

      syncAppearance.mockClear();
      sub.resetToPassiveReady();

      // Bad assignment removed
      expect(useAppStore.getState().bondedGroupColorAssignments).toHaveLength(0);
      // syncAppearance called, which recomputed overrides from empty assignments
      expect(syncAppearance).toHaveBeenCalledTimes(1);
      // Stale override is gone (syncAppearance recomputed to empty)
      expect(useAppStore.getState().bondedGroupColorOverrides).toEqual({});
      sub.teardown();
    });

    it('stale export status message is cleared on successful rebuild', () => {
      const sub = createTimelineSubsystem({
        getPhysics: () => makePhysics(),
        getRenderer: () => makeRenderer(),
        pause: vi.fn(), resume: vi.fn(), isPaused: () => false,
        reinitWorker: vi.fn(async () => {}), isWorkerActive: () => false,
        forceRender: vi.fn(),
        clearBondedGroupHighlight: vi.fn(), clearRendererFeedback: vi.fn(),
        syncBondedGroupsForDisplayFrame: vi.fn(),
        getSceneMolecules: () => makeSceneMolecules(),
        exportHistory: vi.fn(async () => 'saved' as const),
        exportCapabilities: exportCaps,
      });
      sub.installAndEnable();

      useAppStore.getState().setStatusText('Export disabled: scene atom metadata is inconsistent.');
      sub.resetToPassiveReady();
      expect(useAppStore.getState().statusText).toBeNull();
      sub.teardown();
    });

    it('unrelated status text is preserved on successful rebuild', () => {
      const sub = createTimelineSubsystem({
        getPhysics: () => makePhysics(),
        getRenderer: () => makeRenderer(),
        pause: vi.fn(), resume: vi.fn(), isPaused: () => false,
        reinitWorker: vi.fn(async () => {}), isWorkerActive: () => false,
        forceRender: vi.fn(),
        clearBondedGroupHighlight: vi.fn(), clearRendererFeedback: vi.fn(),
        syncBondedGroupsForDisplayFrame: vi.fn(),
        getSceneMolecules: () => makeSceneMolecules(),
        exportHistory: vi.fn(async () => 'saved' as const),
        exportCapabilities: exportCaps,
      });
      sub.installAndEnable();

      useAppStore.getState().setStatusText('Some other message');
      sub.resetToPassiveReady();
      expect(useAppStore.getState().statusText).toBe('Some other message');
      sub.teardown();
    });
  });
});
