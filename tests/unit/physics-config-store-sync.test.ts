/**
 * Regression tests for the restore-path store sync.
 *
 * Motivation: before this helper landed, both the timeline restart-from-
 * here flow and the Watch→Lab hydrate flow wrote restored physics
 * config into the engine but never into the Zustand store the Settings
 * sheet reads from. Users saw atoms damping visibly while the slider
 * still reported 0. These tests lock the fix: restoring physics config
 * MUST push the same values into the store, via the shared helper in
 * `lab/js/runtime/physics-config-store-sync`.
 *
 * Two surfaces:
 *  1. The helper itself — given a config object, it updates the three
 *     store fields (dampingSliderValue, dragStrength, rotateStrength)
 *     using the canonical damping→slider math from `src/ui/damping-slider`.
 *  2. The TimelineCoordinator — restartFromHere must invoke the
 *     injected `syncPhysicsConfigToStore` with the restart frame's
 *     config, in addition to applying it to physics.
 */

import { describe, it, expect, vi } from 'vitest';
import { syncPhysicsConfigToStore } from '../../lab/js/runtime/physics-config-store-sync';
import { useAppStore } from '../../lab/js/store/app-store';
import { dampingToSliderValue } from '../../src/ui/damping-slider';
import { createTimelineCoordinator } from '../../lab/js/runtime/timeline/simulation-timeline-coordinator';

describe('syncPhysicsConfigToStore', () => {
  it('pushes damping (via cubic slider math) + drag + rotate into the store', () => {
    const store = useAppStore.getState();
    // Reset to known defaults.
    store.setDampingSliderValue(0);
    store.setDragStrength(0);
    store.setRotateStrength(0);

    const config = { damping: 0.125, kDrag: 2.5, kRotate: 4.0 };
    syncPhysicsConfigToStore(config);

    const after = useAppStore.getState();
    expect(after.dampingSliderValue).toBe(dampingToSliderValue(config.damping));
    expect(after.dragStrength).toBe(config.kDrag);
    expect(after.rotateStrength).toBe(config.kRotate);
  });

  it('is idempotent (two back-to-back calls leave the store in the same state)', () => {
    const config = { damping: 0.3, kDrag: 1.1, kRotate: 2.2 };
    syncPhysicsConfigToStore(config);
    const snap1 = { ...useAppStore.getState() };
    syncPhysicsConfigToStore(config);
    const snap2 = useAppStore.getState();
    expect(snap2.dampingSliderValue).toBe(snap1.dampingSliderValue);
    expect(snap2.dragStrength).toBe(snap1.dragStrength);
    expect(snap2.rotateStrength).toBe(snap1.rotateStrength);
  });

  it('reflects a zero damping config as slider 0 (no NaN, no negative)', () => {
    syncPhysicsConfigToStore({ damping: 0, kDrag: 0, kRotate: 0 });
    const after = useAppStore.getState();
    expect(after.dampingSliderValue).toBe(0);
    expect(after.dragStrength).toBe(0);
    expect(after.rotateStrength).toBe(0);
  });
});

describe('TimelineCoordinator.restartFromHere → syncPhysicsConfigToStore', () => {
  /**
   * Minimal physics stub sufficient for `applyRestartState` — the
   * coordinator only reaches the sync call after the adapter runs,
   * so we model a shape that `applyRestartState` can walk without
   * touching force math.
   */
  function makePhysicsStub() {
    const pos = new Float64Array(9);
    const vel = new Float64Array(9);
    return {
      n: 3,
      pos,
      vel,
      dragAtom: -1,
      setDamping: vi.fn(),
      setDragStrength: vi.fn(),
      setRotateStrength: vi.fn(),
      endDrag: vi.fn(),
      restoreCheckpoint: vi.fn(),
      restoreBoundarySnapshot: vi.fn(),
    };
  }

  it('invokes the injected sync with the restart frame config', async () => {
    const restartConfig = { damping: 0.05, kDrag: 3.0, kRotate: 5.5 };
    const physics = makePhysicsStub();
    const renderer = {
      getAtomCount: () => 3,
      setAtomCount: vi.fn(),
      updateReviewFrame: vi.fn(),
      setPhysicsRef: vi.fn(),
      updateFromSnapshot: vi.fn(),
    };
    const rs = {
      timePs: 1.23,
      n: 3,
      positions: new Float64Array(9),
      velocities: new Float64Array(9),
      bonds: [],
      config: {
        ...restartConfig,
        dtFs: 0.5,
        dampingRefDurationFs: 2.0,
      },
      interaction: {},
      boundary: {},
    };
    const timeline = {
      getState: () => ({ reviewTimePs: rs.timePs }),
      getRestartState: () => rs,
      truncateAfter: vi.fn(),
      returnToLive: vi.fn(),
    };
    const syncPhysicsConfigToStore = vi.fn();

    const coord = createTimelineCoordinator({
      timeline: timeline as any,
      getPhysics: () => physics as any,
      getRenderer: () => renderer as any,
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: () => true,
      reinitWorker: vi.fn(async () => {}),
      isWorkerActive: () => false,
      forceRender: vi.fn(),
      syncStoreState: vi.fn(),
      setSimTimePs: vi.fn(),
      clearBondedGroupHighlight: vi.fn(),
      clearRendererFeedback: vi.fn(),
      syncBondedGroupsForDisplayFrame: vi.fn(),
      syncPhysicsConfigToStore,
    });

    await coord.restartFromHere();

    expect(syncPhysicsConfigToStore).toHaveBeenCalledTimes(1);
    expect(syncPhysicsConfigToStore).toHaveBeenCalledWith(rs.config);
  });
});
