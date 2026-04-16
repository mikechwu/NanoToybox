/**
 * Frame runtime — owns per-frame update pipeline orchestration.
 *
 * Owns: the sequenced per-frame update (physics → reconciliation → feedback →
 *   highlight → recording → render → status). Ordering invariants are enforced
 *   here, not in main.ts.
 * Depends on: FrameRuntimeSurface (narrow interface injected by main.ts).
 * Called by: main.ts via requestAnimationFrame.
 * Teardown: stateless — caller owns RAF lifecycle.
 *
 * Extracted from main.ts to give the frame loop a single owner outside the
 * composition root. main.ts still owns bootstrap, RAF start/stop, and teardown.
 */

import { CONFIG } from '../config';
import { computeTargetSpeed, computeSubstepCount, updateOverloadState, computeEffectiveSpeed, updateMaxSpeedEstimate, shouldSkipRender } from '../scheduler-pure';
import { resolveInteractionHighlight } from '../runtime/interaction-highlight-runtime';
import { resolveReconciledSteps } from '../runtime/reconciled-steps';
import { updateOrbitFollowFromStore, type OrbitFollowRendererSurface } from '../runtime/orbit-follow-update';
import { resolveReturnTarget, type FocusRendererSurface } from '../runtime/focus-runtime';
import { computePlacementFramingGoal, filterVisiblePoints, type PlacementFramingPoint } from '../runtime/placement-camera-framing';
import { useAppStore } from '../store/app-store';

// ── Narrow dependency interface ──

/** Surface that main.ts provides to the frame runtime. All external state
 *  is accessed through this interface — frame-runtime never reaches into
 *  module-scoped variables in main.ts. */
/** Narrow renderer surface used by the frame loop.
 *  Extends OrbitFollowRendererSurface and FocusRendererSurface for compatibility
 *  with updateOrbitFollowFromStore and resolveReturnTarget. */
export interface FrameRendererSurface extends OrbitFollowRendererSurface, FocusRendererSurface {
  getAtomCount(): number;
  setAtomCount(n: number): void;
  updatePositions(physics: any): void;
  updateFeedback(feedback: any, mode: 'atom' | 'move' | 'rotate'): void;
  setInteractionHighlightedAtoms(indices: number[], intensity: 'hover' | 'active'): void;
  clearInteractionHighlight(): void;
  setHighlight(index: number): void;
  updateFlight(dtSec: number, x: number, z: number): void;
  render(): void;
  getSceneRadius(): number;
  _flightVelocity: { length(): number };

  // Placement camera framing support (optional — only present when renderer is real)
  getCameraBasis?(): { right: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number } };
  getPlacementPreviewWorldPoints?(): { x: number; y: number; z: number }[] | null;
  getDisplayedSceneWorldPoints?(): { x: number; y: number; z: number }[];
  getPlacementFramingCameraParams?(): { tanX: number; tanY: number; near: number; position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } };
  updateOrientationPreservingFraming?(
    dtMs: number,
    desiredTarget: { x: number; y: number; z: number },
    desiredDistance: number,
    opts?: { targetSmoothing?: number; distanceGrowSmoothing?: number; distanceShrinkSmoothing?: number; allowDistanceShrink?: boolean },
  ): void;
}

/** Narrow scheduler surface used by the frame loop. */
export interface FrameSchedulerSurface {
  lastFrameTs: number;
  simBudgetMs: number;
  mode: string;
  overloadCount: number;
  warmUpComplete: boolean;
  totalStepsProfiled: number;
  stableTicks: number;
  prevPhysStepMs: number;
  prevRenderMs: number;
  hasRenderSample: boolean;
  effectiveSpeedWindow: any;
  lastMaxSpeedUpdateTs: number;
  recoveringStartMax: number;
  recoveringBlendRemaining: number;
  skipPressure: number;
  comfortTicks: number;
  renderSkipLevel: number;
  renderSkipCounter: number;
  forceRenderThisTick: boolean;
  renderCount: number;
  lastRenderCountTs: number;
  lastStatusUpdateTs: number;
  prof: {
    rafIntervalMs: number;
    physStepMs: number;
    updatePosMs: number;
    renderMs: number;
    otherMs: number;
    actualRendersPerSec: number;
  };
}

export interface FrameRuntimeSurface {
  // Core subsystems
  physics: { n: number; pos: Float64Array; stepOnce(): void; applySafetyControls(): void; updateBondList(): void; rebuildComponents(): void; componentId: Int32Array | null; components: { atoms: number[]; size: number }[] | null };
  renderer: FrameRendererSurface;
  stateMachine: { getFeedbackState(): any };
  session: { playback: any; interactionMode: string };
  scheduler: FrameSchedulerSurface;

  // Optional subsystems (may not be initialized)
  workerRuntime: { isActive(): boolean; canSendRequest(): boolean; sendRequestFrame(n: number): void; sendInteraction(msg: any): void; getLatestSnapshot(): any; checkStalled(paused: boolean): void; isStalled(): boolean; getSnapshotAge(): number } | null;
  snapshotReconciler: { apply(snapshot: any): void } | null;
  timelineSub: { isInReview(): boolean; recordAfterReconciliation(steps: number): void } | null;
  dragRefresh: { isActive(): boolean; refresh(...args: any[]): void } | null;
  inputBindings: { getManager(): any } | null;
  bondedGroupCoordinator: { update(): void } | null;
  overlayLayout: { isGlassActive(): boolean } | null;
  placement: { active: boolean; isDraggingPreview?: boolean; updateDragFromLatestPointer?: () => void } | null;
  /** Bonded-group atom lookup for camera target resolution (orbit-follow). */
  getBondedGroupAtoms?: (groupId: string) => number[] | null;
  /** Frozen scene anchor captured at placement start. Owned by frame-runtime. */
  placementFramingAnchor: PlacementFramingPoint[] | null;
  setPlacementFramingAnchor(anchor: PlacementFramingPoint[] | null): void;
  scene: { updateActiveCountRow(): void } | null;
  effectsGate: { mode: string; reduced: boolean; slowCount: number; fastCount: number; SLOW_THRESHOLD: number; FAST_THRESHOLD: number; ENTER_COUNT: number; EXIT_COUNT: number };

  // Mutable shared state
  lastReconciledSnapshotVersion: number;
  setLastReconciledSnapshotVersion(v: number): void;
  appRunning: boolean;
  getStepTiming(): { stepWallMs: number; baseStepsPerSecond: number };
}

/**
 * Execute one frame of the update pipeline.
 *
 * Sequence (order matters):
 *   1. Physics stepping (accumulator-driven, substep budgeting)
 *   2. Worker snapshot reconciliation OR local physics fallback
 *   3. Position/feedback updates (skipped during timeline review)
 *   4. Drag-target refresh (continuous pointer-intent reprojection)
 *   5. Interaction highlight resolution (mode-aware group highlighting)
 *   6. Timeline recording (MUST be after reconciliation)
 *   7. Render budgeting (skip-level hysteresis)
 *   8. Status updates + RAF scheduling
 */
export function executeFrame(timestamp: number, s: FrameRuntimeSurface): void {
  const alpha = CONFIG.playback.profilerAlpha;
  const tickStart = performance.now();
  const { stepWallMs, baseStepsPerSecond: _bsps } = s.getStepTiming();

  // RAF interval
  const frameDtMs = s.scheduler.lastFrameTs > 0
    ? Math.min(timestamp - s.scheduler.lastFrameTs, CONFIG.playback.gapThreshold)
    : 16.67;
  s.scheduler.lastFrameTs = timestamp;
  s.scheduler.prof.rafIntervalMs += alpha * (frameDtMs - s.scheduler.prof.rafIntervalMs);

  try {
    let substepsThisFrame = 0;
    let stepsReconciled = 0;

    // ── 1. Physics stepping ──
    const shouldStep = !s.session.playback.paused && !(s.placement && s.placement.active) && s.physics.n > 0;
    if (shouldStep) {
      const pb = s.session.playback;

      // Warm-up
      if (!s.scheduler.warmUpComplete) {
        const physDelta = Math.abs(s.scheduler.prof.physStepMs - s.scheduler.prevPhysStepMs);
        const physStable = s.scheduler.prevPhysStepMs > 0 && physDelta / s.scheduler.prevPhysStepMs < CONFIG.playback.stabilityThreshold;
        const renderDelta = Math.abs(s.scheduler.prof.renderMs - s.scheduler.prevRenderMs);
        const renderStable = !s.scheduler.hasRenderSample ||
          (s.scheduler.prevRenderMs > 0 && renderDelta / s.scheduler.prevRenderMs < CONFIG.playback.stabilityThreshold);
        s.scheduler.prevPhysStepMs = s.scheduler.prof.physStepMs;
        s.scheduler.prevRenderMs = s.scheduler.prof.renderMs;
        if (physStable && renderStable) s.scheduler.stableTicks++; else s.scheduler.stableTicks = 0;
        if (s.scheduler.totalStepsProfiled >= CONFIG.playback.warmUpSteps || s.scheduler.stableTicks >= CONFIG.playback.warmUpStableTicks) {
          s.scheduler.warmUpComplete = true;
        }
      }

      const targetSpeed = computeTargetSpeed(pb.speedMode, pb.selectedSpeed, pb.maxSpeed, s.scheduler.warmUpComplete);
      s.scheduler.simBudgetMs += frameDtMs * targetSpeed;

      const hardCap = CONFIG.playback.maxSubstepsPerTick * stepWallMs;
      if (s.scheduler.mode === 'overloaded') {
        s.scheduler.simBudgetMs = Math.min(s.scheduler.simBudgetMs, hardCap);
      } else {
        s.scheduler.simBudgetMs = Math.min(s.scheduler.simBudgetMs, hardCap * 1.5);
      }

      substepsThisFrame = computeSubstepCount(s.scheduler.simBudgetMs, stepWallMs, CONFIG.playback.maxSubstepsPerTick);

      if (s.workerRuntime && s.workerRuntime.isActive()) {
        s.scheduler.simBudgetMs -= substepsThisFrame * stepWallMs;
        if (substepsThisFrame > 0 && s.workerRuntime.canSendRequest()) {
          s.workerRuntime.sendRequestFrame(substepsThisFrame);
        }
      } else {
        const physStart = performance.now();
        for (let i = 0; i < substepsThisFrame; i++) {
          s.physics.stepOnce();
          s.scheduler.simBudgetMs -= stepWallMs;
        }
        const physEnd = performance.now();
        if (substepsThisFrame > 0) {
          s.physics.applySafetyControls();
          stepsReconciled = substepsThisFrame;
          const msPerStep = (physEnd - physStart) / substepsThisFrame;
          s.scheduler.prof.physStepMs += alpha * (msPerStep - s.scheduler.prof.physStepMs);
          s.scheduler.totalStepsProfiled += substepsThisFrame;
        }
      }

      if (s.scheduler.mode === 'overloaded') {
        s.scheduler.simBudgetMs = Math.min(s.scheduler.simBudgetMs, 0);
      }

      const prevMode = s.scheduler.mode;
      const overloadResult = updateOverloadState({
        mode: s.scheduler.mode,
        overloadCount: s.scheduler.overloadCount,
        substepsThisFrame,
        maxSubsteps: CONFIG.playback.maxSubstepsPerTick,
        entryTicks: CONFIG.playback.overloadEntryTicks,
        exitTicks: CONFIG.playback.overloadExitTicks,
      });
      s.scheduler.mode = overloadResult.mode;
      s.scheduler.overloadCount = overloadResult.overloadCount;
      if (prevMode !== 'overloaded' && s.scheduler.mode === 'overloaded') {
        s.scheduler.simBudgetMs = 0;
      }
      if (prevMode === 'overloaded' && s.scheduler.mode === 'recovering') {
        s.scheduler.recoveringStartMax = pb.maxSpeed;
        s.scheduler.recoveringBlendRemaining = 2;
      }

      if (frameDtMs > 0) {
        const instantSpeed = (substepsThisFrame * 1000 / frameDtMs) / _bsps;
        const speedResult = computeEffectiveSpeed(s.scheduler.effectiveSpeedWindow, instantSpeed, frameDtMs, 10);
        s.scheduler.effectiveSpeedWindow = speedResult.window;
        pb.effectiveSpeed = speedResult.effectiveSpeed;
      }

      const maxResult = updateMaxSpeedEstimate({
        now: performance.now(),
        mode: s.scheduler.mode as 'normal' | 'overloaded' | 'recovering',
        warmUpComplete: s.scheduler.warmUpComplete,
        maxSpeed: pb.maxSpeed,
        effectiveSpeed: pb.effectiveSpeed,
        lastMaxSpeedUpdateTs: s.scheduler.lastMaxSpeedUpdateTs,
        recoveringStartMax: s.scheduler.recoveringStartMax,
        recoveringBlendRemaining: s.scheduler.recoveringBlendRemaining,
        profilerAlpha: alpha,
        prof: s.scheduler.prof,
        config: { ...CONFIG.playback, baseStepsPerSecond: _bsps },
      });
      if (maxResult) {
        pb.maxSpeed = maxResult.maxSpeed;
        s.scheduler.lastMaxSpeedUpdateTs = maxResult.lastMaxSpeedUpdateTs;
        s.scheduler.recoveringStartMax = maxResult.recoveringStartMax;
        s.scheduler.recoveringBlendRemaining = maxResult.recoveringBlendRemaining;
      }
    }

    // ── Stalled-worker detection ──
    if (s.workerRuntime) s.workerRuntime.checkStalled(s.session.playback.paused);

    // ── 2-5. Position sync + feedback + highlights ──
    const inReview = s.timelineSub?.isInReview();
    const updateStart = performance.now();
    if (!inReview) {
      if (s.workerRuntime && s.workerRuntime.isActive()) {
        const snapshot = s.workerRuntime.getLatestSnapshot();
        if (snapshot && snapshot.n > 0 && s.snapshotReconciler) {
          s.snapshotReconciler.apply(snapshot);
          const resolved = resolveReconciledSteps(snapshot.snapshotVersion, s.lastReconciledSnapshotVersion, snapshot.stepsCompleted);
          stepsReconciled = resolved.steps;
          s.setLastReconciledSnapshotVersion(resolved.newLastVersion);
        }
      } else {
        if (s.physics.n !== s.renderer.getAtomCount()) {
          s.renderer.setAtomCount(s.physics.n);
          s.physics.updateBondList();
          s.physics.rebuildComponents();
        }
        if (s.renderer.getAtomCount() > 0 && s.physics.n > 0) {
          s.renderer.updatePositions(s.physics);
        }
      }
    }

    // Drag-target refresh
    if (!inReview && s.dragRefresh?.isActive() && s.inputBindings) {
      const im = s.inputBindings.getManager();
      if (im) {
        s.dragRefresh.refresh(
          s.physics, s.renderer, im,
          (s.workerRuntime && s.workerRuntime.isActive())
            ? (wx: number, wy: number, wz: number) => s.workerRuntime!.sendInteraction({ type: 'updateDrag', worldX: wx, worldY: wy, worldZ: wz })
            : undefined,
        );
      }
    }

    // Interaction highlights
    if (!inReview) {
      const feedback = s.stateMachine.getFeedbackState();
      s.renderer.updateFeedback(feedback, s.session.interactionMode as 'atom' | 'move' | 'rotate');
      const highlight = resolveInteractionHighlight(feedback, s.session.interactionMode as 'atom' | 'move' | 'rotate', s.physics);
      if (highlight && highlight.groupAtomIndices) {
        s.renderer.setInteractionHighlightedAtoms(highlight.groupAtomIndices, highlight.intensity);
      } else {
        s.renderer.clearInteractionHighlight();
      }
    } else {
      s.renderer.clearInteractionHighlight();
      s.renderer.setHighlight(-1);
    }
    const updateEnd = performance.now();
    s.scheduler.prof.updatePosMs += alpha * ((updateEnd - updateStart) - s.scheduler.prof.updatePosMs);

    // ── 6. Timeline recording ──
    s.timelineSub?.recordAfterReconciliation(stepsReconciled);

    // ── 7. Render budgeting ──
    const usedMs = (substepsThisFrame * s.scheduler.prof.physStepMs) + s.scheduler.prof.updatePosMs + s.scheduler.prof.otherMs;
    const canRender = !shouldSkipRender(usedMs, s.scheduler.prof.renderMs, s.scheduler.prof.rafIntervalMs);

    if (canRender) {
      s.scheduler.skipPressure = 0;
      s.scheduler.comfortTicks++;
      if (s.scheduler.comfortTicks > 10 && s.scheduler.renderSkipLevel > 1) {
        s.scheduler.renderSkipLevel--;
        s.scheduler.comfortTicks = 0;
      }
    } else {
      s.scheduler.comfortTicks = 0;
      s.scheduler.skipPressure++;
      if (s.scheduler.skipPressure > 5 && s.scheduler.renderSkipLevel < 4) {
        s.scheduler.renderSkipLevel++;
        s.scheduler.skipPressure = 0;
      }
    }

    s.scheduler.renderSkipCounter++;
    const wasForced = s.scheduler.forceRenderThisTick;
    s.scheduler.forceRenderThisTick = false;
    const shouldRender = wasForced || s.scheduler.renderSkipCounter >= s.scheduler.renderSkipLevel;

    // Orbit follow — suppressed during placement (placement framing is sole camera owner)
    const placementActive = !!(s.placement && s.placement.active);
    if (!placementActive) {
      updateOrbitFollowFromStore(s.renderer, frameDtMs,
        s.getBondedGroupAtoms ? { getBondedGroupAtoms: s.getBondedGroupAtoms } : undefined);
    }

    // Placement camera framing — runs during both idle placement and active drag.
    // Sequence: compute framing goal → apply camera assist → reproject drag preview.
    if (placementActive &&
        s.renderer.getCameraBasis && s.renderer.getDisplayedSceneWorldPoints &&
        s.renderer.getPlacementPreviewWorldPoints && s.renderer.getPlacementFramingCameraParams &&
        s.renderer.updateOrientationPreservingFraming) {
      const previewPoints = s.renderer.getPlacementPreviewWorldPoints();
      if (previewPoints) {
        const cam = s.renderer.getPlacementFramingCameraParams();
        const basis = s.renderer.getCameraBasis();

        // Use frozen visible-anchor; capture on first frame of placement session
        let anchor = s.placementFramingAnchor;
        if (!anchor) {
          const allScene = s.renderer.getDisplayedSceneWorldPoints!();
          anchor = filterVisiblePoints(
            allScene, cam.target, cam.position, basis,
            cam.tanX, cam.tanY, CONFIG.placementFraming.visibleAnchorMargin,
          );
          s.setPlacementFramingAnchor(anchor);
        }

        const allPoints = [...anchor, ...previewPoints];

        const goal = computePlacementFramingGoal({
          points: allPoints,
          target: cam.target,
          cameraPosition: cam.position,
          basis,
          tanX: cam.tanX,
          tanY: cam.tanY,
          near: cam.near,
          nearMargin: CONFIG.camera.nearPlaneMargin,
          safe: CONFIG.placementFraming,
          lambda: CONFIG.placementFraming.targetShiftLambda,
        });

        // Apply smoothing toward goal (continuous convergence, no hard stop)
        const isDragging = !!(s.placement!.isDraggingPreview);
        if (goal) {
          s.renderer.updateOrientationPreservingFraming(frameDtMs, goal.desiredTarget, goal.desiredDistance, {
            targetSmoothing: CONFIG.placementFraming.targetSmoothing,
            distanceGrowSmoothing: CONFIG.placementFraming.distanceGrowSmoothing,
            distanceShrinkSmoothing: CONFIG.placementFraming.distanceShrinkSmoothing,
            allowDistanceShrink: !isDragging,
          });
        }

        // After camera assist, reproject the dragged preview using updated camera state
        // so the grabbed atom stays under the cursor continuously.
        if (isDragging && s.placement!.updateDragFromLatestPointer) {
          s.placement!.updateDragFromLatestPointer!();
        }
      }
    } else if (!placementActive && s.placementFramingAnchor) {
      // Clear frozen anchor when placement ends
      s.setPlacementFramingAnchor(null);
    }

    // Free-Look flight
    if (CONFIG.camera.freeLookEnabled && useAppStore.getState().cameraMode === 'freelook' && s.inputBindings) {
      const dtSec = frameDtMs / 1000;
      const axes = s.inputBindings.getManager()?.getFlightInput();
      if (axes) s.renderer.updateFlight(dtSec, axes.x, axes.z);
      const speed = s.renderer._flightVelocity.length();
      const maxSpd = s.renderer.getSceneRadius() * CONFIG.freeLook.maxSpeedScale;
      const showT = Math.min(Math.max(maxSpd * CONFIG.freeLook.freezeShowScale, CONFIG.freeLook.freezeShowMin), CONFIG.freeLook.freezeShowMax);
      const hideT = showT * CONFIG.freeLook.freezeHideRatio;
      const store = useAppStore.getState();
      if (!store.flightActive && speed > showT) useAppStore.getState().setFlightActive(true);
      else if (store.flightActive && speed < hideT) useAppStore.getState().setFlightActive(false);

      const rt = resolveReturnTarget(s.renderer, s.renderer.getSceneRadius());
      if (rt.guardrailEligible) {
        const distToTarget = s.renderer.camera.position.distanceTo(rt.position);
        const threshold = Math.min(Math.max(rt.radius * CONFIG.freeLook.farDriftTargetMult, CONFIG.freeLook.farDriftMinDistance), s.renderer.getSceneRadius() * CONFIG.freeLook.farDriftSceneMult);
        if (!store.farDrift && distToTarget > threshold) useAppStore.getState().setFarDrift(true);
        else if (store.farDrift && distToTarget < threshold * 0.8) useAppStore.getState().setFarDrift(false);
      } else if (store.farDrift) {
        useAppStore.getState().setFarDrift(false);
      }
    }

    // ── 8. Render ──
    if (shouldRender) {
      s.scheduler.renderSkipCounter = 0;
      const renderStart = performance.now();
      s.renderer.render();
      const renderEnd = performance.now();
      if (!wasForced) {
        s.scheduler.prof.renderMs += alpha * ((renderEnd - renderStart) - s.scheduler.prof.renderMs);
        s.scheduler.hasRenderSample = true;
        s.scheduler.renderCount++;
      }
      const renderElapsed = performance.now() - s.scheduler.lastRenderCountTs;
      if (renderElapsed > 1000) {
        s.scheduler.prof.actualRendersPerSec = s.scheduler.renderCount * 1000 / renderElapsed;
        s.scheduler.renderCount = 0;
        s.scheduler.lastRenderCountTs = performance.now();
      }
    }

    // Other overhead
    const tickEnd = performance.now();
    s.scheduler.prof.otherMs += alpha * (Math.max(0, (tickEnd - tickStart) - (substepsThisFrame * s.scheduler.prof.physStepMs) - s.scheduler.prof.updatePosMs - (shouldRender ? s.scheduler.prof.renderMs : 0)) - s.scheduler.prof.otherMs);

    // Status updates (throttled)
    const statusIntervalMs = 1000 / CONFIG.playback.statusUpdateHz;
    const statusNow = performance.now();
    if (wasForced || (statusNow - s.scheduler.lastStatusUpdateTs) >= statusIntervalMs) {
      s.scheduler.lastStatusUpdateTs = statusNow;
      const pb = s.session.playback;
      const isIdle = pb.paused || (s.placement && s.placement.active) || s.physics.n === 0;
      const displaySpeed = isIdle ? 0 : pb.effectiveSpeed;
      const fps = Math.round(1000 / s.scheduler.prof.rafIntervalMs);
      const isPlacementActive = !!(s.placement && s.placement.active);
      const isPlacementStale = isPlacementActive && s.workerRuntime != null && s.workerRuntime.isActive() && s.workerRuntime.getSnapshotAge() > 500;
      const isOverloaded = s.scheduler.mode === 'overloaded' || pb.maxSpeed < CONFIG.playback.minSpeed;

      useAppStore.getState().updatePlaybackMetrics({
        maxSpeed: pb.maxSpeed,
        effectiveSpeed: displaySpeed,
        fps,
        placementStale: isPlacementStale,
        warmUpComplete: s.scheduler.warmUpComplete,
        overloaded: isOverloaded,
        workerStalled: s.workerRuntime ? s.workerRuntime.isStalled() : false,
        rafIntervalMs: s.scheduler.prof.rafIntervalMs,
      });

      s.bondedGroupCoordinator?.update();

      // Auto FPS gate for UI effects
      const frameMs = s.scheduler.prof.rafIntervalMs;
      const glassVisible = s.overlayLayout ? s.overlayLayout.isGlassActive() : false;
      if (glassVisible && s.effectsGate.mode === 'auto' && !s.effectsGate.reduced) {
        if (frameMs > s.effectsGate.SLOW_THRESHOLD) {
          s.effectsGate.slowCount++;
          s.effectsGate.fastCount = 0;
          if (s.effectsGate.slowCount >= s.effectsGate.ENTER_COUNT) {
            s.effectsGate.reduced = true;
            document.documentElement.dataset.uiEffects = 'reduced';
          }
        } else {
          s.effectsGate.slowCount = 0;
        }
      } else if (glassVisible && s.effectsGate.mode === 'auto') {
        if (frameMs < s.effectsGate.FAST_THRESHOLD) {
          s.effectsGate.fastCount++;
          if (s.effectsGate.fastCount >= s.effectsGate.EXIT_COUNT) {
            s.effectsGate.reduced = false;
            delete document.documentElement.dataset.uiEffects;
            s.effectsGate.slowCount = 0;
          }
        } else {
          s.effectsGate.fastCount = 0;
        }
      }

      s.scene!.updateActiveCountRow();
    }

  } catch (e) {
    console.error('[frameLoop] ERROR:', e);
  }
}
