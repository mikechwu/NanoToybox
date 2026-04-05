/**
 * App lifecycle — owns teardown sequencing for all runtime subsystems.
 *
 * Owns: the ordered teardown sequence. Subsystem-specific cleanup stays
 *   inside each subsystem's own destroy/teardown; this module only
 *   orchestrates the order and nulling.
 * Depends on: TeardownSurface (narrow interface injected by main.ts).
 * Called by: main.ts (_teardownRuntime → teardownAllSubsystems).
 * Teardown: this IS the teardown owner.
 *
 * Teardown order (dependencies flow downward):
 *   1. Frame loop stop
 *   2. Global listeners
 *   3. Debug hooks
 *   4. Timeline subsystem
 *   5. Onboarding + subscriptions
 *   6. Bonded group coordinator
 *   7. Overlay layout
 *   8. Controllers (placement, status) — consumers before providers
 *   9. Input bindings
 *  10. Worker runtime — before renderer (callbacks may read renderer)
 *  11. Renderer — last (all subsystems may hold renderer refs)
 *  12. Stateless helpers (drag refresh, snapshot reconciler)
 */

import { CONFIG } from '../config';

/** Reset scheduler state to defaults for potential re-init. */
export function resetSchedulerState(scheduler: any): void {
  Object.assign(scheduler, {
    lastFrameTs: 0, simBudgetMs: 0, mode: 'normal', overloadCount: 0,
    totalStepsProfiled: 0, forceRenderThisTick: false,
    stableTicks: 0, prevPhysStepMs: 1, prevRenderMs: 1, warmUpComplete: false,
    lastMaxSpeedUpdateTs: 0, skipPressure: 0, comfortTicks: 0,
    renderSkipLevel: 1, renderSkipCounter: 0, renderCount: 0,
    lastRenderCountTs: 0, hasRenderSample: false, lastStatusUpdateTs: 0,
    recoveringStartMax: 0, recoveringBlendRemaining: 0,
    effectiveSpeedWindow: [],
  });
  Object.assign(scheduler.prof, {
    physStepMs: 1, updatePosMs: 0.1, renderMs: 1, otherMs: 0.1,
    rafIntervalMs: 16.67, actualRendersPerSec: 60,
  });
}

/** Reset session state to defaults for potential re-init.
 *  Theme and textSize are preserved intentionally for re-init continuity. */
export function resetSessionState(session: any): void {
  session.isLoading = false;
  session.interactionMode = 'atom';
  session.scene.molecules = [];
  session.scene.nextId = 1;
  session.scene.totalAtoms = 0;
  Object.assign(session.playback, {
    selectedSpeed: CONFIG.playback.defaultSpeed,
    speedMode: 'fixed',
    effectiveSpeed: 1.0,
    maxSpeed: 1.0,
    paused: false,
  });
}

/** Reset effects gate state and clear DOM-side UI-effects attribute. */
export function resetEffectsGate(effectsGate: any): void {
  effectsGate.slowCount = 0;
  effectsGate.fastCount = 0;
  effectsGate.reduced = false;
  effectsGate.mode = 'auto';
  delete document.documentElement.dataset.uiEffects;
}

// ── Narrow teardown surface ──

/** Each subsystem exposes at most a destroy/teardown/deactivate/reset method.
 *  main.ts constructs this surface from its module-scoped variables. */
export interface TeardownSurface {
  // Frame loop
  stopFrameLoop(): void;

  // Global listeners
  removeAllGlobalListeners(): void;

  // Debug hooks
  cleanupDebugHooks(): void;

  // Subsystems with explicit teardown (called in order)
  timelineSub: { teardown(): void } | null;
  onboarding: { destroy(): void } | null;
  unsubOnboardingOverlay: (() => void) | null;
  unsubCameraMode: (() => void) | null;
  bondedGroupCoordinator: { teardown(): void } | null;
  overlayLayout: { destroy(): void } | null;
  placement: { destroy(): void } | null;
  statusCtrl: { destroy(): void } | null;
  inputBindings: { destroy(): void } | null;
  workerRuntime: { destroy(): void } | null;
  renderer: { destroy(): void } | null;

  // Stateless helpers (symmetric cleanup, then null)
  dragRefresh: { deactivate(): void } | null;
  snapshotReconciler: { reset(): void } | null;

  // Post-teardown reset
  resetRuntimeState(): void;
}

/**
 * Execute the full teardown sequence. Each subsystem is torn down in
 * dependency order, then nulled. Subsystem-specific cleanup logic stays
 * inside each subsystem — this function only orchestrates the sequence.
 */
export function teardownAllSubsystems(s: TeardownSurface): void {
  // 1. Stop frame loop
  s.stopFrameLoop();

  // 2-3. Global listeners + debug hooks
  s.removeAllGlobalListeners();
  s.cleanupDebugHooks();

  // 4. Timeline subsystem (may update bonded group state)
  if (s.timelineSub) s.timelineSub.teardown();

  // 5. Onboarding + subscriptions (may cancel via input interactions)
  if (s.onboarding) s.onboarding.destroy();
  if (s.unsubOnboardingOverlay) s.unsubOnboardingOverlay();
  if (s.unsubCameraMode) s.unsubCameraMode();

  // 6. Bonded group coordinator (coordinates 3 subsystems)
  if (s.bondedGroupCoordinator) s.bondedGroupCoordinator.teardown();

  // 7. Overlay layout (observer, pending RAF)
  if (s.overlayLayout) s.overlayLayout.destroy();

  // 8. Controllers (consumers) before input bindings (provider)
  if (s.placement) s.placement.destroy();
  if (s.statusCtrl) s.statusCtrl.destroy();

  // 9. Input bindings
  if (s.inputBindings) s.inputBindings.destroy();

  // 10. Worker runtime (before renderer — callbacks may read renderer state)
  if (s.workerRuntime) s.workerRuntime.destroy();

  // 11. Renderer (last — all subsystems may hold renderer refs)
  if (s.renderer) s.renderer.destroy();

  // 12. Stateless helpers (symmetric cleanup)
  if (s.dragRefresh) s.dragRefresh.deactivate();
  if (s.snapshotReconciler) s.snapshotReconciler.reset();

  // 13. Post-teardown state reset
  s.resetRuntimeState();
}
