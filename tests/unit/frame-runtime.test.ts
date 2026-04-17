/**
 * Frame runtime tests — guards the extracted per-frame update pipeline.
 *
 * Covers ordering invariants and mode-gating behavior:
 * - review mode skips live feedback/highlight and clears stale interaction
 * - recording happens after reconciliation with reconciled step count
 * - drag refresh runs only when active and not in review
 * - sync-mode fallback updates positions when atom counts diverge
 */
import { describe, it, expect, vi } from 'vitest';
import { executeFrame, type FrameRuntimeSurface } from '../../lab/js/app/frame-runtime';

/** Build a minimal FrameRuntimeSurface stub for testing. */
function makeStub(overrides: Partial<FrameRuntimeSurface> = {}): FrameRuntimeSurface {
  return {
    physics: {
      n: 10, pos: new Float64Array(30),
      stepOnce: vi.fn(), applySafetyControls: vi.fn(),
      updateBondList: vi.fn(), rebuildComponents: vi.fn(),
      componentId: null, components: null,
    },
    renderer: {
      getAtomCount: vi.fn(() => 10),
      setAtomCount: vi.fn(),
      updatePositions: vi.fn(),
      updateFeedback: vi.fn(),
      setInteractionHighlightedAtoms: vi.fn(),
      clearInteractionHighlight: vi.fn(),
      setHighlight: vi.fn(),
      updateFlight: vi.fn(),
      render: vi.fn(),
      getSceneRadius: vi.fn(() => 10),
      camera: { position: { x: 0, y: 0, z: 15, distanceTo: vi.fn(() => 15), clone: vi.fn(), set: vi.fn(), isVector3: true } },
      _flightVelocity: { length: vi.fn(() => 0) },
      getDisplayedMoleculeBounds: vi.fn(() => null),
      getDisplayedMoleculeCentroid: vi.fn(() => null),
      updateOrbitFollow: vi.fn(),
      setCameraFocusTarget: vi.fn(),
      animateToFocusedObject: vi.fn(),
    } as any,
    stateMachine: { getFeedbackState: vi.fn(() => ({ hoverAtom: -1, activeAtom: -1, isDragging: false, isMoving: false, isRotating: false })) },
    session: { playback: { paused: true, speedMode: 'auto', selectedSpeed: 1, maxSpeed: 1, effectiveSpeed: 0 }, interactionMode: 'atom' },
    scheduler: {
      lastFrameTs: 0, simBudgetMs: 0, mode: 'normal', overloadCount: 0,
      warmUpComplete: true, totalStepsProfiled: 100, stableTicks: 10,
      prevPhysStepMs: 1, prevRenderMs: 1, hasRenderSample: true,
      effectiveSpeedWindow: [], lastMaxSpeedUpdateTs: 0,
      recoveringStartMax: 1, recoveringBlendRemaining: 0,
      skipPressure: 0, comfortTicks: 0, renderSkipLevel: 1, renderSkipCounter: 0,
      forceRenderThisTick: false, renderCount: 0, lastRenderCountTs: 0,
      lastStatusUpdateTs: 0,
      prof: { rafIntervalMs: 16, physStepMs: 1, updatePosMs: 0.5, renderMs: 2, otherMs: 0.1, actualRendersPerSec: 60 },
    },
    workerRuntime: null,
    snapshotReconciler: null,
    timelineSub: null,
    dragRefresh: null,
    inputBindings: null,
    bondedGroupCoordinator: null,
    overlayLayout: null,
    placement: null,
    placementFramingAnchor: null,
    setPlacementFramingAnchor: vi.fn(),
    scene: { updateActiveCountRow: vi.fn() },
    effectsGate: { mode: 'auto', reduced: false, slowCount: 0, fastCount: 0, SLOW_THRESHOLD: 33, FAST_THRESHOLD: 20, ENTER_COUNT: 5, EXIT_COUNT: 10 },
    lastReconciledSnapshotVersion: 0,
    setLastReconciledSnapshotVersion: vi.fn(),
    appRunning: true,
    getStepTiming: vi.fn(() => ({ stepWallMs: 1, baseStepsPerSecond: 1000 })),
    isHydrating: () => false,
    ...overrides,
  };
}

describe('frame-runtime: executeFrame', () => {
  it('review mode skips live feedback and clears interaction highlight', () => {
    const s = makeStub({
      timelineSub: { isInReview: vi.fn(() => true), recordAfterReconciliation: vi.fn() },
    });

    executeFrame(1000, s);

    // Should NOT call live feedback during review
    expect(s.renderer.updateFeedback).not.toHaveBeenCalled();
    // Should clear stale interaction highlight
    expect(s.renderer.clearInteractionHighlight).toHaveBeenCalled();
    expect(s.renderer.setHighlight).toHaveBeenCalledWith(-1);
  });

  it('worker mode: reconciliation → version update → recording in order', () => {
    const order: any[] = [];
    const snapshot = { n: 10, snapshotVersion: 5, stepsCompleted: 42, pos: new Float64Array(30), vel: new Float64Array(30) };

    const s = makeStub({
      session: { playback: { paused: false, speedMode: 'auto', selectedSpeed: 1, maxSpeed: 10, effectiveSpeed: 1 }, interactionMode: 'atom' },
      workerRuntime: {
        isActive: vi.fn(() => true),
        canSendRequest: vi.fn(() => true),
        sendRequestFrame: vi.fn(),
        sendInteraction: vi.fn(),
        getLatestSnapshot: vi.fn(() => snapshot),
        checkStalled: vi.fn(),
        isStalled: vi.fn(() => false),
        getSnapshotAge: vi.fn(() => 0),
      },
      snapshotReconciler: {
        apply: vi.fn(() => order.push('apply')),
      },
      setLastReconciledSnapshotVersion: vi.fn((v: number) => order.push(['setVersion', v])),
      timelineSub: {
        isInReview: vi.fn(() => false),
        recordAfterReconciliation: vi.fn((steps: number) => order.push(['record', steps])),
      },
      lastReconciledSnapshotVersion: 0, // first snapshot → resolves to 42 steps
    });

    executeFrame(1000, s);

    // 1. Reconciler must apply the snapshot first
    expect(order[0]).toBe('apply');
    // 2. Version updated with resolved version
    expect(order[1]).toEqual(['setVersion', 5]);
    // 3. Recording called AFTER reconciliation with the reconciled step count
    const recordEntry = order.find((e: any) => Array.isArray(e) && e[0] === 'record');
    expect(recordEntry).toBeTruthy();
    expect(recordEntry[1]).toBe(42); // stepsCompleted from snapshot
  });

  it('hydration lock: snapshot reconciler is NOT applied and local physics is NOT stepped while `isHydrating()` returns true', () => {
    // This regression-locks the fix for the 2026-04-16 bug where a
    // stale pre-restoreState worker snapshot arrived during the
    // hydrate transaction's `await worker.restoreState(...)` and
    // clobbered physics via the reconciler, surfacing the pre-hydrate
    // default scene with the post-hydrate provenance pill.
    const snapshot = { n: 60, snapshotVersion: 7, stepsCompleted: 1, pos: new Float64Array(180), vel: new Float64Array(180) };
    const stepOnceSpy = vi.fn();
    const applySpy = vi.fn();
    const s = makeStub({
      physics: {
        n: 10, pos: new Float64Array(30),
        stepOnce: stepOnceSpy, applySafetyControls: vi.fn(),
        updateBondList: vi.fn(), rebuildComponents: vi.fn(),
        componentId: null, components: null,
      },
      session: { playback: { paused: false, speedMode: 'auto', selectedSpeed: 1, maxSpeed: 10, effectiveSpeed: 1 }, interactionMode: 'atom' },
      workerRuntime: {
        isActive: vi.fn(() => true),
        canSendRequest: vi.fn(() => true),
        sendRequestFrame: vi.fn(),
        sendInteraction: vi.fn(),
        getLatestSnapshot: vi.fn(() => snapshot),
        checkStalled: vi.fn(),
        isStalled: vi.fn(() => false),
        getSnapshotAge: vi.fn(() => 0),
      },
      snapshotReconciler: { apply: applySpy },
      timelineSub: { isInReview: vi.fn(() => false), recordAfterReconciliation: vi.fn() },
      isHydrating: () => true,
    });

    executeFrame(1000, s);

    // The hydrate transaction is the authoritative writer during its
    // window. Any mutation here would race the commit.
    expect(applySpy).not.toHaveBeenCalled();
    expect(stepOnceSpy).not.toHaveBeenCalled();
  });

  it('drag refresh runs only when active and not in review', () => {
    const refreshFn = vi.fn();
    const s = makeStub({
      dragRefresh: { isActive: vi.fn(() => true), refresh: refreshFn },
      inputBindings: { getManager: vi.fn(() => ({})) },
    });

    executeFrame(1000, s);

    expect(refreshFn).toHaveBeenCalled();
  });

  it('drag refresh skipped during review', () => {
    const refreshFn = vi.fn();
    const s = makeStub({
      timelineSub: { isInReview: vi.fn(() => true), recordAfterReconciliation: vi.fn() },
      dragRefresh: { isActive: vi.fn(() => true), refresh: refreshFn },
      inputBindings: { getManager: vi.fn(() => ({})) },
    });

    executeFrame(1000, s);

    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('sync-mode fallback rebuilds bonds when atom count diverges', () => {
    const s = makeStub({
      session: { playback: { paused: false, speedMode: 'auto', selectedSpeed: 1, maxSpeed: 10, effectiveSpeed: 1 }, interactionMode: 'atom' },
    });
    // Simulate atom count divergence: physics has 8, renderer thinks 10
    s.physics.n = 8;
    (s.renderer.getAtomCount as any).mockReturnValue(10);

    executeFrame(1000, s);

    // Should sync renderer count and rebuild bonds
    expect(s.renderer.setAtomCount).toHaveBeenCalledWith(8);
    expect(s.physics.updateBondList).toHaveBeenCalled();
    expect(s.physics.rebuildComponents).toHaveBeenCalled();
  });

  it('does not crash with minimal surface (all optionals null)', () => {
    const s = makeStub();
    expect(() => executeFrame(1000, s)).not.toThrow();
  });

  // ── C. Placement camera framing integration tests ──

  it('C1: placement framing runs during placement', () => {
    const updateOrientationPreservingFraming = vi.fn();
    const setAnchor = vi.fn();
    const s = makeStub({
      placement: { active: true, isDraggingPreview: false },
      placementFramingAnchor: null,
      setPlacementFramingAnchor: setAnchor,
      renderer: {
        ...makeStub().renderer,
        getCameraBasis: vi.fn(() => ({
          right: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
          forward: { x: 0, y: 0, z: -1 },
        })),
        getPlacementPreviewWorldPoints: vi.fn(() => [
          { x: 30, y: 0, z: 0 },  // far right — triggers framing
        ]),
        getDisplayedSceneWorldPoints: vi.fn(() => [
          { x: 0, y: 0, z: 0 },
        ]),
        getPlacementFramingCameraParams: vi.fn(() => ({
          tanX: 0.83, tanY: 0.47, near: 0.1,
          position: { x: 0, y: 0, z: 20 },
          target: { x: 0, y: 0, z: 0 },
        })),
        updateOrientationPreservingFraming,
      } as any,
    });

    executeFrame(1000, s);

    // Anchor must be captured on first frame
    expect(setAnchor).toHaveBeenCalled();
    expect(updateOrientationPreservingFraming).toHaveBeenCalled();
  });

  it('C2: orbit-follow suppressed during placement', () => {
    const s = makeStub({
      placement: { active: true, isDraggingPreview: false },
      placementFramingAnchor: null,
      setPlacementFramingAnchor: vi.fn(),
      renderer: {
        ...makeStub().renderer,
        updateOrbitFollow: vi.fn(),
        getCameraBasis: vi.fn(() => ({
          right: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
          forward: { x: 0, y: 0, z: -1 },
        })),
        getPlacementPreviewWorldPoints: vi.fn(() => [{ x: 0, y: 0, z: 0 }]),
        getDisplayedSceneWorldPoints: vi.fn(() => []),
        getPlacementFramingCameraParams: vi.fn(() => ({
          tanX: 0.83, tanY: 0.47, near: 0.1,
          position: { x: 0, y: 0, z: 20 },
          target: { x: 0, y: 0, z: 0 },
        })),
        updateOrientationPreservingFraming: vi.fn(),
      } as any,
    });

    executeFrame(1000, s);

    // orbit-follow must NOT run during placement
    expect(s.renderer.updateOrbitFollow).not.toHaveBeenCalled();
  });

  it('C3: idle placement allows distance shrink', () => {
    const updateOrientationPreservingFraming = vi.fn();
    // Pre-set anchor so we skip capture (simulates second+ frame)
    const s = makeStub({
      placement: { active: true, isDraggingPreview: false },
      placementFramingAnchor: [{ x: 0, y: 0, z: 0 }],
      setPlacementFramingAnchor: vi.fn(),
      renderer: {
        ...makeStub().renderer,
        getCameraBasis: vi.fn(() => ({
          right: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
          forward: { x: 0, y: 0, z: -1 },
        })),
        getPlacementPreviewWorldPoints: vi.fn(() => [
          { x: 30, y: 0, z: 0 },
        ]),
        getDisplayedSceneWorldPoints: vi.fn(() => [
          { x: 0, y: 0, z: 0 },
        ]),
        getPlacementFramingCameraParams: vi.fn(() => ({
          tanX: 0.83, tanY: 0.47, near: 0.1,
          position: { x: 0, y: 0, z: 20 },
          target: { x: 0, y: 0, z: 0 },
        })),
        updateOrientationPreservingFraming,
      } as any,
    });

    executeFrame(1000, s);

    // Unconditional: framing MUST be called, and shrink MUST be allowed when not dragging
    expect(updateOrientationPreservingFraming).toHaveBeenCalled();
    const opts = updateOrientationPreservingFraming.mock.calls[0][3];
    expect(opts.allowDistanceShrink).toBe(true);
  });

  it('C4: framing runs during active drag + reprojection called after camera assist', () => {
    const updateOrientationPreservingFraming = vi.fn();
    const updateDragFromLatestPointer = vi.fn();
    const s = makeStub({
      placement: { active: true, isDraggingPreview: true, updateDragFromLatestPointer },
      placementFramingAnchor: [{ x: 0, y: 0, z: 0 }],
      setPlacementFramingAnchor: vi.fn(),
      renderer: {
        ...makeStub().renderer,
        getCameraBasis: vi.fn(() => ({
          right: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
          forward: { x: 0, y: 0, z: -1 },
        })),
        getPlacementPreviewWorldPoints: vi.fn(() => [
          { x: 30, y: 0, z: 0 },
        ]),
        getDisplayedSceneWorldPoints: vi.fn(() => [
          { x: 0, y: 0, z: 0 },
        ]),
        getPlacementFramingCameraParams: vi.fn(() => ({
          tanX: 0.83, tanY: 0.47, near: 0.1,
          position: { x: 0, y: 0, z: 20 },
          target: { x: 0, y: 0, z: 0 },
        })),
        updateOrientationPreservingFraming,
      } as any,
    });

    executeFrame(1000, s);

    // Framing MUST run during drag (camera assist continues)
    expect(updateOrientationPreservingFraming).toHaveBeenCalled();
    // Drag reprojection MUST be called after camera assist
    expect(updateDragFromLatestPointer).toHaveBeenCalled();
    // Distance shrink suppressed during drag
    const opts = updateOrientationPreservingFraming.mock.calls[0][3];
    expect(opts.allowDistanceShrink).toBe(false);
  });

  it('C4b: drag reprojection NOT called when not dragging', () => {
    const updateDragFromLatestPointer = vi.fn();
    const s = makeStub({
      placement: { active: true, isDraggingPreview: false, updateDragFromLatestPointer },
      placementFramingAnchor: [{ x: 0, y: 0, z: 0 }],
      setPlacementFramingAnchor: vi.fn(),
      renderer: {
        ...makeStub().renderer,
        getCameraBasis: vi.fn(() => ({
          right: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
          forward: { x: 0, y: 0, z: -1 },
        })),
        getPlacementPreviewWorldPoints: vi.fn(() => [
          { x: 30, y: 0, z: 0 },
        ]),
        getDisplayedSceneWorldPoints: vi.fn(() => [
          { x: 0, y: 0, z: 0 },
        ]),
        getPlacementFramingCameraParams: vi.fn(() => ({
          tanX: 0.83, tanY: 0.47, near: 0.1,
          position: { x: 0, y: 0, z: 20 },
          target: { x: 0, y: 0, z: 0 },
        })),
        updateOrientationPreservingFraming: vi.fn(),
      } as any,
    });

    executeFrame(1000, s);
    expect(updateDragFromLatestPointer).not.toHaveBeenCalled();
  });
});
