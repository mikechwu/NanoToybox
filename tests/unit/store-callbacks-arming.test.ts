/**
 * @vitest-environment jsdom
 */
/**
 * Integration test for the real store callback registration path.
 *
 * Exercises registerStoreCallbacks() from ui-bindings.ts with a real
 * timeline subsystem, then invokes the installed store callbacks to
 * verify that non-atom actions do not arm recording through the actual
 * registered callback surface — not reconstructed closures.
 *
 * This closes the gap between "the mirrored closures are correct" and
 * "the real app wiring stays correct."
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerStoreCallbacks } from '../../lab/js/runtime/ui-bindings';
import { createTimelineSubsystem, type TimelineSubsystem } from '../../lab/js/runtime/timeline-subsystem';
import { useAppStore } from '../../lab/js/store/app-store';

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
    createCheckpoint: function () {
      return { n: this.n, pos: new Float64Array(this.pos), vel: new Float64Array(this.vel), bonds: [] };
    },
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

describe('Store callbacks do not arm timeline (real registerStoreCallbacks)', () => {
  let physics: ReturnType<typeof makePhysics>;
  let sub: TimelineSubsystem;

  beforeEach(() => {
    physics = makePhysics();
    useAppStore.getState().resetTransientState();

    sub = createTimelineSubsystem({
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
      getSceneMolecules: () => [],
    });

    sub.installAndEnable(); // Match main.ts init — start in ready state

    // Wire the real registerStoreCallbacks with deps matching main.ts
    // construction — no arming in any callback.
    registerStoreCallbacks({
      overlayRuntime: { open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false) } as any,
      togglePause: vi.fn(),
      changeSpeed: vi.fn(),
      setInteractionMode: vi.fn(),
      forceRenderThisTick: vi.fn(),
      clearPlayground: vi.fn(),
      resetView: vi.fn(),
      updateChooserRecentRow: vi.fn(),
      setPhysicsWallMode: (mode) => { physics.setWallMode(mode); },
      setPhysicsDragStrength: (v) => { physics.setDragStrength(v); },
      setPhysicsRotateStrength: (v) => { physics.setRotateStrength(v); },
      setPhysicsDamping: (d) => { physics.setDamping(d); },
      applyTheme: vi.fn(),
      applyTextSize: vi.fn(),
      isWorkerActive: () => false,
      sendWorkerInteraction: vi.fn(),
      isPlacementActive: () => false,
      exitPlacement: vi.fn(),
      startPlacement: vi.fn(),
    });
  });

  it('chooser onSelectStructure (startPlacement) does not arm', () => {
    const cbs = useAppStore.getState().chooserCallbacks!;
    cbs.onSelectStructure('c60.xyz', 'C60');
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('dock onPause does not arm', () => {
    const cbs = useAppStore.getState().dockCallbacks!;
    cbs.onPause();
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('settings onDampingChange does not arm', () => {
    const cbs = useAppStore.getState().settingsCallbacks!;
    cbs.onDampingChange(0.5);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('settings onBoundaryChange does not arm', () => {
    const cbs = useAppStore.getState().settingsCallbacks!;
    cbs.onBoundaryChange('remove');
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('settings onSpeedChange does not arm', () => {
    const cbs = useAppStore.getState().settingsCallbacks!;
    cbs.onSpeedChange('4');
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('settings onDragChange does not arm', () => {
    const cbs = useAppStore.getState().settingsCallbacks!;
    cbs.onDragChange(5.0);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });

  it('all store callbacks combined do not arm', () => {
    const dock = useAppStore.getState().dockCallbacks!;
    const settings = useAppStore.getState().settingsCallbacks!;
    const chooser = useAppStore.getState().chooserCallbacks!;

    dock.onPause();
    settings.onSpeedChange('2');
    settings.onBoundaryChange('remove');
    settings.onDragChange(5.0);
    settings.onRotateChange(10.0);
    settings.onDampingChange(0.5);
    chooser.onSelectStructure('c60.xyz', 'C60');

    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    expect(useAppStore.getState().timelineRangePs).toBeNull();
  });
});
