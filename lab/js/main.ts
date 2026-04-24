/**
 * NanoToybox Interactive Page — Entry Point
 *
 * Multi-molecule playground with placement mode.
 * Wires together: loader, physics, state machine, input, renderer, React UI.
 */
// Shared CSS (core tokens first, then component CSS)
import '../../src/ui/core-tokens.css';
import '../../src/ui/bonded-groups-parity.css';
import '../../src/ui/text-size-tokens.css';
import '../../src/ui/dock-tokens.css';
import '../../src/ui/dock-shell.css';
import '../../src/ui/sheet-shell.css';
import '../../src/ui/segmented.css';
import '../../src/ui/timeline-track.css';
import '../../src/ui/timeline-trim-panel.css';
import '../../src/ui/bottom-region.css';
import { loadManifest, loadStructure } from './loader';
import { PhysicsEngine } from './physics';
import { StateMachine, type Command } from './state-machine';
import { Renderer } from './renderer';
import { applyThemeTokens, applyTextSizeTokens } from './themes';
import { CONFIG, DEFAULT_THEME } from './config';
import { StatusController } from './status';
import { PlacementController } from './placement';
import { mountReactUI, unmountReactUI } from './react-root';
import { useAppStore } from './store/app-store';
import { createOverlayLayout, type OverlayLayout } from './runtime/overlay/overlay-layout';
import { getDeviceMode } from '../../src/ui/device-mode';
import { createInteractionDispatch } from './runtime/interaction/interaction-dispatch';
import { createOverlayRuntime, type OverlayRuntime } from './runtime/overlay/overlay-runtime';
import { createInputBindings, type InputBindings } from './runtime/interaction/input-bindings';
import { registerStoreCallbacks } from './runtime/ui-bindings';
import { syncPhysicsConfigToStore } from './runtime/physics-config-store-sync';
import { createAtomSource } from './runtime/interaction/atom-source';
import { createSceneRuntime, type SceneRuntime } from './runtime/scene-runtime';
import { consumeWatchToLabHandoffFromLocation } from './runtime/handoff/watch-handoff';
import { isWatchHandoffBoot } from '../../src/watch-lab-handoff/watch-handoff-url';
import { handleCenterObject as _handleCenterObject, resolveReturnTarget } from './runtime/camera/focus-runtime';
import { createSnapshotReconciler, type SnapshotReconciler } from './runtime/worker/snapshot-reconciler';
import { createWorkerRuntime, type WorkerRuntime } from './runtime/worker/worker-lifecycle';
import { createOnboardingController, subscribeOnboardingReadiness, markOnboardingDismissed } from './runtime/onboarding';
import { createAtomInteractionHint, type AtomInteractionHintRuntime } from './runtime/overlay/atom-interaction-hint';
import { createDragTargetRefresh, dragRefreshAction } from './runtime/interaction/drag-target-refresh';
import { createBondedGroupRuntime, type BondedGroupRuntime } from './runtime/bonded-groups/bonded-group-runtime';
import { resolveBondedGroupDisplaySource } from './runtime/bonded-groups/bonded-group-display-source';
import { createBondedGroupAppearanceRuntime, type BondedGroupAppearanceRuntime } from './runtime/bonded-groups/bonded-group-appearance-runtime';
import { handleBondedGroupFollowToggle } from './runtime/bonded-groups/bonded-group-follow-actions';
import { createBondedGroupHighlightRuntime, type BondedGroupHighlightRuntime } from './runtime/bonded-groups/bonded-group-highlight-runtime';
import { createBondedGroupCoordinator, type BondedGroupCoordinator } from './runtime/bonded-groups/bonded-group-coordinator';
import { createTimelineSubsystem, type TimelineSubsystem } from './runtime/timeline/timeline-subsystem';
import { buildFullHistoryFile, validateFullHistoryFile, buildCapsuleHistoryFile, formatBytes, generateExportFileName, saveHistoryFile, type AtomDojoHistoryFileV1 } from './runtime/timeline/history-export';
import { validateCapsuleFile, type AtomDojoPlaybackCapsuleFileV1 } from '../../src/history/history-file-v1';
import {
  createPreparedCapsulePublisher,
  postCapsuleArtifact,
  type CapsuleArtifact,
} from './runtime/publish-capsule-artifacts';
import { postGuestCapsuleArtifact } from './runtime/publish-guest-artifact';
import { buildCapsuleArtifact as buildCapsuleArtifactImpl } from './runtime/build-capsule-artifact';
import type { CapsuleSelectionRange } from './runtime/timeline/capsule-publish-types';
import { PublishOversizeError } from './runtime/publish-errors';
import { executeFrame, type FrameRuntimeSurface } from './app/frame-runtime';
import { teardownAllSubsystems, resetSchedulerState, resetSessionState, resetEffectsGate, type TeardownSurface } from './app/app-lifecycle';
import { serializeForWorkerRestore } from './runtime/timeline/restart-state-adapter';
import {
  createAuthRuntime,
  consumeResumePublishIntent,
  attachAuthCompleteListener,
} from './runtime/auth-runtime';

// --- Globals ---
let renderer, physics, stateMachine;
let manifest: Record<string, { file: string; description: string; n_atoms: number }> | null = null;
let statusCtrl = null;
let placement = null;

// ── Worker runtime (Milestone C.2) ──
const useWorker = true;
let _workerRuntime: WorkerRuntime | null = null;
let _snapshotReconciler: SnapshotReconciler | null = null;
let _scene: SceneRuntime | null = null;

// Hydrate the initial theme from a previously-persisted choice so the
// theme is consistent across the whole product surface (lab / watch /
// account / privacy / terms / privacy-request). `applyThemeSetting`
// writes back to the same key whenever the user toggles in Settings.
function _initialTheme(): 'dark' | 'light' {
  try {
    const stored = localStorage.getItem('atomdojo.theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch { /* private mode / disabled — fall through */ }
  return DEFAULT_THEME;
}

const session = {
  theme: _initialTheme(),
  textSize: 'normal',
  isLoading: false,
  interactionMode: 'atom',  // 'atom' | 'move' | 'rotate'
  playback: {
    selectedSpeed: CONFIG.playback.defaultSpeed,
    speedMode: 'fixed',      // 'fixed' | 'max'
    effectiveSpeed: 1.0,
    maxSpeed: 1.0,
    paused: false,
  },
  scene: {
    molecules: [],
    nextId: 1,
    totalAtoms: 0,
  },
};

// --- Initial-scene helpers ---
//
// The boot sequence needs two decisions before it touches `_scene`:
//   1. WHICH structure, if any, to load on a fresh boot (`_pickDefaultStructure`).
//   2. WHETHER to skip the default because a Watch→Lab handoff is
//      about to hydrate the scene from a seed (`_hasPendingWatchHandoff`).
//
// These are pure, early-callable, side-effect-free functions so the
// boot flow can ask "should I load C60?" before doing any work. The
// previous hardcoded `await addMoleculeToScene(c60)` in init()
// rendered C60 for ~500 ms during every handoff boot — visible flash
// to the user even though the scene was about to be replaced.

/** Pick the structure Lab loads when no handoff is incoming. Defaults
 *  to C60 (most iconic / smallest buckyball); falls back to the
 *  smallest structure in the manifest if C60 is missing. Returns
 *  null when the manifest is empty — caller decides what that means
 *  (typically: boot with an empty scene). */
function _pickDefaultStructure(
  manifest: Record<string, { file: string; description: string; n_atoms: number }>,
): { file: string; description: string } | null {
  const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);
  if (entries.length === 0) return null;
  const c60 = entries.find(([k]) => k === 'c60');
  const chosen = c60 ?? entries[0];
  return { file: chosen[1].file, description: chosen[1].description };
}

/** URL-only check for an incoming Watch→Lab handoff. Pure — does NOT
 *  read localStorage, does NOT mutate anything. The real consume
 *  (validate + remove storage) happens later via
 *  `consumeWatchToLabHandoffFromLocation`. If this returns true, the
 *  boot MUST skip the default-scene load and let the hydrate populate
 *  the scene from the seed. A later fallback path re-loads the
 *  default when the consume rejects or the hydrate fails.
 *
 *  Thin wrapper over `isWatchHandoffBoot` (the shared URL predicate)
 *  so boot and onboarding consume the same source-of-truth without
 *  duplicating the param-name contract. */
function _hasPendingWatchHandoff(): boolean {
  return isWatchHandoffBoot();
}

// ── Handoff onboarding suppression (eager at module load) ─────────
//
// `consumeWatchToLabHandoffFromLocation` scrubs `?from=watch&handoff=`
// from the URL before hydrate runs. The onboarding overlay's
// readiness gate evaluates AFTER hydrate (when atomCount > 0), by
// which time the URL predicate would read a clean URL and fail to
// recognize the handoff boot. Capture the signal NOW — at module
// load, before any scrub or consume fires — and persist it via the
// existing sessionStorage sentinel so the onboarding gate sees it
// through normal channels. Using `markOnboardingDismissed()` rather
// than a new state slot keeps the suppression source uniform (same
// primitive covers "user dismissed in-session" and "arrived via
// handoff — already introduced to the product on Watch").
//
// Runs at module evaluation time (top-level statement), so it
// executes before any imperative boot code, before React mounts,
// before the consume path's URL scrub.
if (_hasPendingWatchHandoff()) {
  markOnboardingDismissed();
}

// --- Scheduler (accumulator, profiler, render skip) ---
// Timing is derived from the live physics engine to stay consistent if dt changes.
function _getStepTiming() {
  // Before physics is initialized, use config defaults
  const dtFs = physics ? physics.getDtFs() : CONFIG.physics.dt;
  const bsps = CONFIG.playback.baseSimRatePsPerSecond / (dtFs / 1000);
  return { baseStepsPerSecond: bsps, stepWallMs: 1000 / bsps };
}

const scheduler = {
  simBudgetMs: 0,
  lastFrameTs: 0,
  overloadCount: 0,
  mode: 'normal',            // 'normal' | 'overloaded' | 'recovering'
  totalStepsProfiled: 0,
  forceRenderThisTick: false,
  // Warm-up
  stableTicks: 0,
  prevPhysStepMs: 1,
  prevRenderMs: 1,
  warmUpComplete: false,
  // Max speed update cadence
  lastMaxSpeedUpdateTs: 0,
  // Render skip state
  skipPressure: 0,
  comfortTicks: 0,
  renderSkipLevel: 1,
  renderSkipCounter: 0,
  // Actual render measurement
  renderCount: 0,
  lastRenderCountTs: 0,
  hasRenderSample: false,
  // Status display throttle
  lastStatusUpdateTs: 0,
  // Recovery blend for maxSpeed transition
  recoveringStartMax: 0,
  recoveringBlendRemaining: 0,
  // Profiler EMAs
  prof: {
    physStepMs: 1,
    updatePosMs: 0.1,
    renderMs: 1,
    otherMs: 0.1,
    rafIntervalMs: 16.67,
    actualRendersPerSec: 60,
  },
  // Display smoothing
  effectiveSpeedWindow: [],
};

// ── UI effects auto-gate ──
const effectsGate = {
  slowCount: 0,       // consecutive slow frames
  fastCount: 0,       // consecutive fast frames
  reduced: false,     // current state
  mode: 'auto',       // 'auto' | 'forced-reduced' | 'forced-normal'
  SLOW_THRESHOLD: 20, // ms — enter reduced if sustained above this
  FAST_THRESHOLD: 16, // ms — exit reduced if sustained below this
  ENTER_COUNT: 30,    // frames to sustain before entering reduced
  EXIT_COUNT: 60,     // frames to sustain before exiting reduced
};

// Global listener registry for teardown
const _globalListeners = [];
let _rafId = null;
let _appRunning = false;

// Overlay layout runtime (created in init, destroyed in teardown)
let _overlayLayout: OverlayLayout | null = null;

// Overlay runtime (created in init)
let _overlay: OverlayRuntime | null = null;

// Input bindings (created in init)
let _inputBindings: InputBindings | null = null;

// Onboarding controller (created in init, cleared on teardown)
let _onboarding: import('./runtime/onboarding').OnboardingController | null = null;
let _unsubOnboardingOverlay: (() => void) | null = null;
let _atomInteractionHint: AtomInteractionHintRuntime | null = null;
let _unsubAtomHintReadiness: (() => void) | null = null;
let _unsubCameraMode: (() => void) | null = null;

// Bonded group subsystem
let _bondedGroups: BondedGroupRuntime | null = null;
let _bondedGroupHighlight: BondedGroupHighlightRuntime | null = null;
let _bondedGroupCoordinator: BondedGroupCoordinator | null = null;
let _bondedGroupAppearance: BondedGroupAppearanceRuntime | null = null;

// Simulation timeline subsystem
let _timelineSub: TimelineSubsystem | null = null;
let _capsulePublisher: ReturnType<typeof createPreparedCapsulePublisher> | null = null;
/** Track the last reconciled snapshot version to avoid double-counting steps. */
let _lastReconciledSnapshotVersion = -1;
/** Frozen visible-anchor set for placement framing (captured at placement start). */
let _placementFramingAnchor: { x: number; y: number; z: number }[] | null = null;


// Pause sync guard — resolves when syncStateNow completes during pause transition.
// Awaited by scene-runtime commitMolecule to block mutations until local state is fresh.
let _pauseSyncPromise: Promise<void> | null = null;

/** Resolves when the worker's initial `init(C60)` has acked (or immediately
 *  null when worker mode is off). The Watch→Lab handoff consume awaits
 *  this before calling `worker.clearScene` / `worker.appendMolecule` —
 *  otherwise `workerRuntime.isActive()` returns false, the hydrate
 *  silently skips the worker commit, and the worker (once initialized)
 *  emits C60 frameResults that revert the main-thread seed scene. */
let _workerInitPromise: Promise<void> | null = null;

/** Hydration lock — while true, the rAF-driven frame runtime must
 *  skip snapshot reconciliation and local physics stepping so that a
 *  stale pre-restoreState worker snapshot cannot clobber the scene
 *  state the Watch→Lab hydrate transaction is in the middle of
 *  committing. Owned by main.ts (single writer / single reader) and
 *  consumed through `FrameRuntimeSurface.isHydrating()`. Set by the
 *  transactional module via the scene-runtime `setHydrationActive`
 *  dep; released in a finally block so rollback and
 *  rollback-also-failed paths always clear it. */
let _hydrationActive = false;

// Interaction dispatch (created in init)
let _dispatch: ((cmd: import('./state-machine').Command, sx?: number, sy?: number) => { dragTarget?: number[] }) | null = null;

// Per-frame drag target refresh (fixes stale world-space target when atom moves under spring)
let _dragRefresh: import('./runtime/interaction/drag-target-refresh').DragTargetRefresh | null = null;

/** Register a global listener and track it for teardown. Options forwarded to both add/remove. */
function addGlobalListener(target: EventTarget, event: string, handler: EventListener, options?: boolean | AddEventListenerOptions) {
  target.addEventListener(event, handler, options);
  _globalListeners.push([event, handler, target, options]);
}

/**
 * Tear down runtime subsystems (renderer, physics, worker, controllers, listeners).
 * Does NOT unmount React or reset the Zustand store — the UI remains mounted
 * so that any visible status (e.g., statusError) is preserved.
 */
function _teardownRuntime() {
  // Construct narrow teardown surface from module-scoped variables
  const surface: TeardownSurface = {
    stopFrameLoop: () => {
      _appRunning = false;
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    },
    removeAllGlobalListeners: () => {
      for (const [event, handler, target, options] of _globalListeners) {
        target.removeEventListener(event, handler, options);
      }
      _globalListeners.length = 0;
    },
    cleanupDebugHooks: () => {
      delete window._setUiEffectsMode;
      delete (window as unknown as Record<string, unknown>)._getWorkerDebugState;
      delete (window as unknown as Record<string, unknown>)._simulateWorkerStall;
      delete (window as unknown as Record<string, unknown>)._setTestStalledThreshold;
      delete (window as unknown as Record<string, unknown>)._getUIState;
    },
    timelineSub: _timelineSub,
    onboarding: _onboarding,
    unsubOnboardingOverlay: _unsubOnboardingOverlay,
    atomInteractionHint: _atomInteractionHint,
    unsubAtomHintReadiness: _unsubAtomHintReadiness,
    unsubCameraMode: _unsubCameraMode,
    bondedGroupCoordinator: _bondedGroupCoordinator,
    overlayLayout: _overlayLayout,
    placement,
    statusCtrl,
    inputBindings: _inputBindings,
    workerRuntime: _workerRuntime,
    renderer,
    dragRefresh: _dragRefresh,
    snapshotReconciler: _snapshotReconciler,
    resetRuntimeState: () => {
      // Null all refs (main.ts owns these module-scoped variables)
      _timelineSub = null; _lastReconciledSnapshotVersion = -1;
      _onboarding = null; _unsubOnboardingOverlay = null;
      _atomInteractionHint = null; _unsubAtomHintReadiness = null;
      _unsubCameraMode = null;
      _bondedGroupCoordinator = null; _bondedGroupHighlight = null; _bondedGroups = null;
      _overlayLayout = null; placement = null; statusCtrl = null;
      _inputBindings = null; _workerRuntime = null; renderer = null;
      _overlay = null; _dispatch = null; _dragRefresh = null;
      _snapshotReconciler = null; _scene = null; physics = null;
      stateMachine = null; manifest = null;
      // Reset runtime state via lifecycle helpers
      resetSchedulerState(scheduler);
      resetSessionState(session);
      resetEffectsGate(effectsGate); // also clears DOM uiEffects attribute
    },
  };
  teardownAllSubsystems(surface);
}

/** Full app teardown: unmount React, reset store, and tear down runtime. */
function destroyApp() {
  unmountReactUI();
  useAppStore.getState().resetTransientState();
  _teardownRuntime();
}

// --- Initialization ---
async function init() {
  const container = document.getElementById('container');
  renderer = new Renderer(container);
  physics = new PhysicsEngine();
  stateMachine = new StateMachine();

  renderer.applyTheme(session.theme);
  applyThemeTokens(session.theme);
  applyTextSizeTokens(session.textSize);

  // Seed store from authoritative physics/session state (removes implicit coupling
  // between store defaults and engine defaults — physics owns the truth).
  const store = useAppStore.getState();
  store.setBoundaryMode(physics.getWallMode());
  // Mirror the engine's post-boot physics config into the store so the
  // Settings sheet opens with slider positions matching what the engine
  // is actually running. Routes through the shared helper so the cubic
  // scale / slider-range constants live in one place (src/ui/damping-slider).
  syncPhysicsConfigToStore({
    damping: physics.getDamping(),
    kDrag: physics.getDragStrength(),
    kRotate: physics.getRotateStrength(),
  });

  // Status controller (hint-only — status text handled by store/React StatusBar)
  statusCtrl = new StatusController({
    hintEl: document.getElementById('hint'),
  });

  // Device mode detection — sets data-device-mode on <html> for CSS
  function updateDeviceMode() {
    const mode = getDeviceMode();
    const prev = document.documentElement.dataset.deviceMode;
    if (prev && prev !== mode && useAppStore.getState().activeSheet !== null) { _overlay!.close(); }
    document.documentElement.dataset.deviceMode = mode;
  }
  updateDeviceMode();
  // One-shot responsive UI defaults — keyed off the boot device-mode so phone/tablet
  // start with the bonded-groups panel collapsed. The action self-guards, so resize
  // listeners below cannot re-trigger it and overwrite a manual user toggle.
  useAppStore.getState().initializeResponsiveUiDefaults(getDeviceMode());
  addGlobalListener(window, 'resize', updateDeviceMode);
  addGlobalListener(window, 'orientationchange', updateDeviceMode);

  // UI effects mode — 'auto', 'forced-reduced', or 'forced-normal'.
  // Manual override is sticky — auto gate skips when mode is forced.
  // Automatic FPS gate with hysteresis runs in frameLoop when glass surfaces are visible.
  // Dev/testing hook: _setUiEffectsMode('reduced'|'normal'|'auto') in console.
  // Global dev/testing hook for UI effects mode.
  window._setUiEffectsMode = function(mode) {
    if (mode === 'reduced') {
      effectsGate.mode = 'forced-reduced';
      effectsGate.reduced = true;
      document.documentElement.dataset.uiEffects = 'reduced';
    } else if (mode === 'normal') {
      effectsGate.mode = 'forced-normal';
      effectsGate.reduced = false;
      delete document.documentElement.dataset.uiEffects;
    } else {
      effectsGate.mode = 'auto';
      // Let the auto gate take over on next frame
    }
  };
  // Mount React UI early so StatusBar is available for error display
  mountReactUI();

  // Register safe placeholder callbacks immediately so the UI is never in a
  // null-callback state during the async init window. Real callbacks are
  // registered later via registerStoreCallbacks() once all subsystems exist.
  {
    const noop = () => {};
    const store = useAppStore.getState();
    store.setDockCallbacks({
      onAdd: noop, onPause: noop, onSettings: noop, onCancel: noop, onModeChange: noop,
    });
    store.setSettingsCallbacks({
      onSpeedChange: noop, onThemeChange: noop, onBoundaryChange: noop,
      onDragChange: noop, onRotateChange: noop, onDampingChange: noop,
      onTextSizeChange: noop, onAddMolecule: noop, onClear: noop, onResetView: noop,
    });
    store.setChooserCallbacks({ onSelectStructure: noop });
    // Timeline callbacks are NOT pre-installed here — TimelineBar gates on
    // timelineInstalled, which is set by installAndEnable() after the real
    // subsystem is constructed. No noop placeholders needed.
  }

  // Scene runtime — created early so addMoleculeToScene is available during manifest load.
  // Getter deps resolve lazily; subsystems like _dispatch, _inputBindings are null during
  // the initial load but scene-runtime guards them with null checks.
  _scene = createSceneRuntime({
    getPhysics: () => physics,
    getRenderer: () => renderer,
    getStateMachine: () => stateMachine,
    getPlacement: () => placement,
    getStatusCtrl: () => statusCtrl,
    getWorkerRuntime: () => _workerRuntime,
    getInputBindings: () => _inputBindings,
    getSnapshotReconciler: () => _snapshotReconciler,
    getSession: () => session,
    dispatch: (cmd) => { if (_dispatch) _dispatch(cmd); },
    fullSchedulerReset,
    partialProfilerReset,
    recoverFromWorkerFailure: recoverLocalPhysicsAfterWorkerFailure,
    getPauseSyncPromise: () => _pauseSyncPromise,
    setHydrationActive: (active: boolean) => { _hydrationActive = active; },
    onSceneMutated: () => { _bondedGroupCoordinator?.update(); if (physics) _bondedGroupAppearance?.pruneAndSync(physics.n); },
    onMoleculeCommitted: (info) => {
      if (!_timelineSub) return;
      const tracker = _timelineSub.getAtomIdentityTracker();
      const registry = _timelineSub.getAtomMetadataRegistry();
      const assignedIds = tracker.handleAppend(info.atomOffset, info.atomCount);
      registry.registerAppendedAtoms(assignedIds, info.atoms, { file: info.filename, label: info.name });
    },
    // Watch → Lab handoff bindings (plan §7). Deferred getters — the
    // timeline subsystem owns the tracker + registry and is constructed
    // later in init(). The SceneRuntime wrapper returns a classified
    // error if either is still null at call time.
    getAtomIdentityTracker: () => _timelineSub?.getAtomIdentityTracker() ?? null,
    getAtomMetadataRegistry: () => _timelineSub?.getAtomMetadataRegistry() ?? null,
    getAppearanceRuntime: () => _bondedGroupAppearance ?? null,
    getCameraMode: () => useAppStore.getState().cameraMode,
  });

  // Load manifest + choose-and-maybe-load the initial scene.
  //
  // The default scene is the first C60 entry, or the smallest structure
  // if the manifest has no C60. `_pickDefaultStructure` isolates that
  // choice — swapping the boot structure is a one-line change here, not
  // a grep across the file.
  //
  // A Watch→Lab handoff (URL carries `?from=watch&handoff=<token>`)
  // will repopulate the scene from the handed-off seed. In that case
  // we MUST NOT load the default first — doing so would render C60
  // for ~500 ms before the hydrate replaces it, which the user sees
  // as a confusing flash. `_scene` stays empty at boot, the hydrate
  // runs against a clean slate, and if the hydrate fails the fallback
  // branch further down loads the default as a last resort.
  let _defaultStructure: { file: string; description: string } | null = null;
  try {
    manifest = await loadManifest();
    _defaultStructure = _pickDefaultStructure(manifest);

    if (_defaultStructure && !_hasPendingWatchHandoff()) {
      await _scene!.addMoleculeToScene(_defaultStructure.file, _defaultStructure.description, [0, 0, 0]);
    }
  } catch (e) {
    useAppStore.getState().setStatusError('Failed to load structures. Serve from repo root.');
    console.error(e);
    // Tear down runtime only — keep React mounted so StatusBar shows the error
    _teardownRuntime();
    return;
  }

  // ═══════════════════════════════════════════════════════
  // Worker runtime (Milestone C.2)
  // ═══════════════════════════════════════════════════════
  if (useWorker) {
    _workerRuntime = createWorkerRuntime({
      onSchedulerTiming: (msPerStep, stepsCompleted) => {
        const alpha = CONFIG.playback.profilerAlpha;
        scheduler.prof.physStepMs += alpha * (msPerStep - scheduler.prof.physStepMs);
        scheduler.totalStepsProfiled += stepsCompleted;
      },
      onFailure: (reason, lastSnapshot) => recoverLocalPhysicsAfterWorkerFailure(reason, lastSnapshot),
      onWallRemoval: () => { _timelineSub?.markIdentityStale(); },
    });

    // Debug/test hooks — main.ts owns window globals, worker runtime provides data
    (window as unknown as Record<string, unknown>)._getWorkerDebugState = () => ({
      ...(_workerRuntime ? _workerRuntime.getDebugState() : {}),
      physStepMs: scheduler.prof.physStepMs,
      totalStepsProfiled: scheduler.totalStepsProfiled,
    });
    (window as unknown as Record<string, unknown>)._simulateWorkerStall = () => {
      if (_workerRuntime) _workerRuntime.simulateStall();
    };
    (window as unknown as Record<string, unknown>)._setTestStalledThreshold = (ms: number) => {
      if (_workerRuntime) _workerRuntime.setTestStalledThreshold(ms);
    };

    // Initialize unconditionally — even with an EMPTY scene (pending
    // handoff path). The worker needs to be `_initialized = true`
    // before the hydrate runs, so it can accept `clearScene +
    // appendMolecule` to replace the empty state with the seed.
    // Previously this was gated on `physics.n > 0`, which skipped the
    // worker init entirely during the pending-handoff boot and left
    // `isActive() === false` when the hydrate checked. The hydrate
    // would then either silently skip the worker (old bug — scene
    // flashed to C60 later) or roll back (new behavior). Empty init
    // is cheap and keeps the state machine honest.
    const config = _buildWorkerConfig();
    _workerInitPromise = _workerRuntime.init(
      config,
      _scene!.collectSceneAtoms(),
      _scene!.collectSceneBonds(),
    );
  }

  // ═══════════════════════════════════════════════════════
  // UI controller wiring
  // ═══════════════════════════════════════════════════════

  // Populate store with available structures from manifest
  {
    const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);
    useAppStore.getState().setAvailableStructures(entries.map(([key, info]) => ({
      key, description: info.description, atomCount: info.n_atoms, file: info.file,
    })));
  }

  // Escape key: close overlay or cancel placement
  function _onKeydown(e) {
    if (e.key === 'Escape') {
      if (placement && placement.active) {
        placement.exit(false);
        e.preventDefault();
      } else if (placement && placement.loading) {
        placement.invalidatePendingLoads();
        _scene!.updateSceneStatus();
        e.preventDefault();
      } else if (useAppStore.getState().activeSheet !== null) {
        _overlay!.close();
        e.preventDefault();
      } else if (CONFIG.camera.freeLookEnabled && useAppStore.getState().cameraMode === 'freelook') {
        // Esc in Free-Look with nothing else open → return to Orbit
        useAppStore.getState().setCameraMode('orbit');
        e.preventDefault();
      }
    }
    if (e.key === 'Enter' && placement && placement.active) {
      placement.exit(true);
      e.preventDefault();
    }
  }
  addGlobalListener(document, 'keydown', _onKeydown);

  // ── Outside-click closes overlay (unified rule, all devices) ──
  // Capture phase so this fires before bubble-phase interaction handlers.
  addGlobalListener(document, 'pointerdown', (e: Event) => {
    const pe = e as PointerEvent;
    const target = pe.target as Node;
    const _s = useAppStore.getState();
    if (_s.activeSheet === null) return;

    // Only primary pointer — reject second touch in multi-touch, and
    // non-left mouse buttons (right-click, middle, stylus barrel).
    if (!pe.isPrimary) return;
    if (pe.pointerType === 'mouse' && pe.button !== 0) return;

    // Clicks inside any sheet never dismiss (ownership boundary).
    const sheets = document.querySelectorAll('.sheet');
    for (const sheet of sheets) {
      if (sheet.contains(target)) return;
    }

    // Clicks inside the dock region or camera controls never dismiss.
    const dockEl = document.querySelector('[data-dock-root]');
    if (dockEl && dockEl.contains(target)) return;
    const camCtrl = document.querySelector('[data-camera-controls]');
    if (camCtrl && camCtrl.contains(target)) return;

    // Only backdrop and renderer canvas dismiss.
    const backdrop = document.querySelector('.sheet-backdrop');
    const canvas = renderer ? renderer.getCanvas() : null;
    const isBackdrop = backdrop && (target === backdrop || backdrop.contains(target));
    const isCanvas = canvas && (target === canvas || canvas.contains(target));
    if (!isBackdrop && !isCanvas) return;

    // Close + consume so no interaction starts from the same event.
    _overlay!.close();
    e.stopPropagation();
    e.preventDefault();
  }, true);

  // DockController + SettingsSheetController removed — React components are authoritative.
  // Callbacks registered via store.setDockCallbacks() / store.setSettingsCallbacks() below.

  // ── Overlay runtime (open/close policy) ──
  _overlay = createOverlayRuntime({
    getStatusCtrl: () => statusCtrl,
    getOnboarding: () => _onboarding,
  });

  // ── Interaction dispatch (local effects + worker mirroring) ──
  _dispatch = createInteractionDispatch({
    getPhysics: () => physics,
    getRenderer: () => renderer,
    getStateMachine: () => stateMachine,
    getInputManager: () => _inputBindings ? _inputBindings.getManager() : null,
    isWorkerActive: () => !!(_workerRuntime && _workerRuntime.isActive()),
    sendWorkerInteraction: (cmd) => { if (_workerRuntime) _workerRuntime.sendInteraction(cmd); },
    markAtomInteractionStarted: () => {
      _timelineSub?.markAtomInteractionStarted();
      // First atom interaction dismisses the floating "Drag any atom"
      // hint. Idempotent — subsequent interactions are no-ops since
      // the runtime latches on dismissal.
      _atomInteractionHint?.dismiss();
      // Broadcast the signal via the store so unrelated components
      // (e.g., the timed Share & Download nudge in TimelineBar's
      // TransferTrigger) can subscribe without coupling to this
      // module's internals. Setter is idempotent — only the first
      // call mutates state and wakes subscribers.
      useAppStore.getState().markAtomInteraction();
    },
    updateStatus: (text) => _scene!.updateStatus(text),
    updateSceneStatus: () => _scene!.updateSceneStatus(),
  });

  // ── Drag target refresh (per-frame reprojection of pointer intent) ──
  _dragRefresh = createDragTargetRefresh();

  // ── Snapshot reconciler (worker-to-main position sync + reconciliation) ──
  _snapshotReconciler = createSnapshotReconciler({
    physics, renderer, stateMachine,
    dispatch: (cmd) => _dispatch!(cmd),
  });

  // ── Input bindings ──
  _inputBindings = createInputBindings({
    getRenderer: () => renderer,
    getPlacement: () => placement,
    getStateMachine: () => stateMachine,
    getSessionInteractionMode: () => session.interactionMode,
    dispatch: (cmd, sx, sy) => {
      const result = _dispatch!(cmd, sx, sy);
      // Hook drag refresh: track pointer and manage activation
      if (_dragRefresh) {
        const action = dragRefreshAction(cmd.action);
        if (action === 'activate') {
          _dragRefresh.activate();
          if (sx !== undefined && sy !== undefined) _dragRefresh.updatePointer(sx, sy);
        } else if (action === 'update-pointer') {
          if (sx !== undefined && sy !== undefined) _dragRefresh.updatePointer(sx, sy);
        } else if (action === 'deactivate') {
          _dragRefresh.deactivate();
        }
      }
      return result;
    },
    onAchievement: (key) => _onboarding?.recordAchievement(key),
  });

  // Ensure input manager exists before PlacementController (it needs the instance)
  _inputBindings.sync();

  // ── Placement controller ──
  placement = new PlacementController({
    renderer, physics, stateMachine, inputManager: _inputBindings.getManager()!, loadStructure,
    commands: {
      setDockPlacementMode: (active) => _scene!.setDockPlacementMode(active),
      commitToScene: (file, name, atoms, bonds, offset) => _scene!.commitMolecule(file, name, atoms, bonds, offset),
      updateStatus: (text) => _scene!.updateStatus(text),
      updateSceneStatus: () => _scene!.updateSceneStatus(),
      forceIdle: () => _dispatch!(stateMachine.forceIdle()),
      forceRender: () => { scheduler.forceRenderThisTick = true; },
      buildAtomSource: () => createAtomSource(renderer),
      getSceneMolecules: () => session.scene.molecules,
    },
  });

  // ── Overlay layout runtime ──
  _overlayLayout = createOverlayLayout(renderer);
  addGlobalListener(window, 'resize', _overlayLayout.onViewportResize);

  // Tab visibility: prevent catch-up burst
  function _onVisibilityChange() {
    if (!document.hidden) {
      scheduler.lastFrameTs = performance.now();
      scheduler.simBudgetMs = 0;
    }
  }
  addGlobalListener(document, 'visibilitychange', _onVisibilityChange);

  _appRunning = true;
  _rafId = requestAnimationFrame(frameLoop);

  // First layout after React dock mounts (double-RAF + observer wiring)
  _overlayLayout.scheduleFirstLayout();

  // ── Onboarding controller (Phase 4A) ──
  // Owns coachmark scheduling, pacing, and persistence.
  // StatusController remains the rendering surface for #hint.
  _onboarding = createOnboardingController({
    getSurface: () => statusCtrl,
    getRenderer: () => renderer,
    isAppRunning: () => _appRunning,
  });
  _onboarding.scheduleInitialCoachmarks();

  // ── Page-load onboarding overlay (reactive readiness gate) ──
  _unsubOnboardingOverlay = subscribeOnboardingReadiness();

  // ── Atom-interaction hint (the floating "Drag any atom" bubble) ──
  // Follows a boundary atom nearest viewport center. Picked once when
  // the scene first becomes renderable (atomCount > 0 + no blocking
  // overlay). Dismissed on first atom interaction (see the dispatch
  // wiring above — `markAtomInteractionStarted` forwards into the
  // runtime). The readiness subscription mirrors the onboarding gate:
  // both need "scene ready, no overlays" and the same store signals
  // drive both, but the hint has its own lifecycle so they can be
  // tuned independently.
  _atomInteractionHint = createAtomInteractionHint({
    getHostEl: () => document.getElementById('atom-hint'),
    projectToNDC: (world) => renderer.projectToNDC(world),
    getCanvasRect: () => renderer.getCanvas().getBoundingClientRect(),
    getPhysics: () => physics,
    getAtomScreenRadius: (atomIdx) => renderer.getAtomScreenRadius(atomIdx),
  });
  {
    const tryShow = (): void => {
      const s = useAppStore.getState();
      if (s.atomCount > 0 && s.activeSheet === null && !s.placementActive && s.timelineMode !== 'review') {
        _atomInteractionHint?.show();
      }
    };
    tryShow();
    _unsubAtomHintReadiness = useAppStore.subscribe(() => tryShow());
  }

  // ── Bonded group subsystem ──
  _bondedGroups = createBondedGroupRuntime({
    getDisplaySource: () => resolveBondedGroupDisplaySource({
      getPhysics: () => physics,
      getTimelineReviewComponents: () => {
        // Read directly from timeline subsystem internal state, not from store.
        // This avoids stale timelineReviewTimePs when sync runs before store update.
        return _timelineSub?.getCurrentReviewBondedGroupComponents() ?? null;
      },
      getTimelineMode: () => useAppStore.getState().timelineMode,
    }),
  });
  _bondedGroupHighlight = createBondedGroupHighlightRuntime({
    getBondedGroupRuntime: () => _bondedGroups,
    getRenderer: () => renderer,
    getPhysics: () => physics,
  });
  _bondedGroupCoordinator = createBondedGroupCoordinator({
    getBondedGroupRuntime: () => _bondedGroups,
    getBondedGroupHighlightRuntime: () => _bondedGroupHighlight,
  });
  // Bonded-group appearance runtime (annotation-global color overrides)
  _bondedGroupAppearance = createBondedGroupAppearanceRuntime({
    getBondedGroupRuntime: () => _bondedGroups,
    getRenderer: () => renderer,
    getStableAtomIds: () => _timelineSub?.getAtomIdentityTracker().captureForCurrentState(physics?.n ?? 0) ?? [],
    setStatusText: (text) => useAppStore.getState().setStatusText(text),
  });
  // Initial sync (annotation-global colors may already exist in store)
  _bondedGroupAppearance.syncToRenderer();

  // Shared camera-target deps — used by bonded-group callbacks and camera control callbacks
  const _focusTargetDeps = { getBondedGroupAtoms: (gid: string) => _bondedGroups?.getAtomIndicesForGroup(gid) ?? null };

  // Register callbacks via store (same pattern as dock/settings/chooser)
  useAppStore.getState().setBondedGroupCallbacks({
    onToggleSelect: (id) => _bondedGroupHighlight?.toggleSelectedGroup(id),
    onHover: (id) => _bondedGroupHighlight?.setHoveredGroup(id),
    onClearHighlight: () => _bondedGroupHighlight?.clearHighlight(),
    onCenterGroup: (id) => {
      // One-shot: set target and frame. No persistent active state.
      useAppStore.getState().setCameraTargetRef({ kind: 'bonded-group', groupId: id });
      _handleCenterObject(renderer, _focusTargetDeps);
    },
    onFollowGroup: (id) => {
      handleBondedGroupFollowToggle(id, {
        getGroupAtoms: (gid) => _bondedGroups?.getAtomIndicesForGroup(gid) ?? null,
        centerCurrentTarget: () => _handleCenterObject(renderer, _focusTargetDeps),
      });
    },
    onApplyGroupColor: (id, colorHex) => {
      _bondedGroupAppearance?.applyGroupColor(id, colorHex);
    },
    onClearGroupColor: (id) => {
      _bondedGroupAppearance?.clearGroupColor(id);
    },
    onClearColorAssignment: (assignmentId) => {
      _bondedGroupAppearance?.clearColorAssignment(assignmentId);
    },
    getGroupAtoms: (id) => _bondedGroups?.getAtomIndicesForGroup(id) ?? null,
  });

  // ── Export artifact builder ──

  type ExportArtifact =
    | { kind: 'capsule'; file: AtomDojoPlaybackCapsuleFileV1; json: string; blob: Blob; defaultFileName: string }
    | { kind: 'full'; file: AtomDojoHistoryFileV1; json: string; blob: Blob; defaultFileName: string };

  function buildExportArtifact(kind: 'capsule' | 'full'): ExportArtifact | null {
    if (!_timelineSub) return null;
    if (_timelineSub.isIdentityStale()) {
      throw new Error('Export is unavailable because atom identity is stale after worker compaction.');
    }
    if (kind === 'capsule') {
      const file = buildCapsuleHistoryFile({
        getTimelineExportData: () => _timelineSub!.getTimelineExportSnapshot(),
        getAtomTable: () => _timelineSub!.getAtomMetadataRegistry().getAtomTable(),
        getColorAssignments: () => useAppStore.getState().bondedGroupColorAssignments.map(a => ({
          atomIds: a.atomIds,
          colorHex: a.colorHex,
        })),
        appVersion: '0.1.0',
      });
      if (!file) return null;
      const json = JSON.stringify(file);
      return { kind: 'capsule', file, json, blob: new Blob([json], { type: 'application/json' }), defaultFileName: generateExportFileName('atomdojo-capsule') };
    } else {
      const file = buildFullHistoryFile({
        getTimelineExportData: () => _timelineSub!.getTimelineExportSnapshot(),
        getAtomTable: () => _timelineSub!.getAtomMetadataRegistry().getAtomTable(),
        appVersion: '0.1.0',
      });
      if (!file) return null;
      const json = JSON.stringify(file);
      return { kind: 'full', file, json, blob: new Blob([json], { type: 'application/json' }), defaultFileName: generateExportFileName('atomdojo-full') };
    }
  }

  // ── Capsule artifact builder (range-aware) ──
  //
  // Thin wiring adapter. The actual builder lives in
  // `./runtime/build-capsule-artifact.ts` so the critical guards
  // (identity-stale / snapshot-version / empty-frames / validation)
  // can be unit-tested without booting this file. Here we just
  // inject current-subsystem accessors as closures; the builder is
  // pure relative to those deps.
  function buildCapsuleArtifact(range: CapsuleSelectionRange | null): CapsuleArtifact | null {
    if (!_timelineSub) return null;
    return buildCapsuleArtifactImpl({
      isIdentityStale: () => _timelineSub!.isIdentityStale(),
      getCapsuleExportInputVersion: () => _timelineSub!.getCapsuleExportInputVersion(),
      getTimelineExportSnapshot: () => _timelineSub!.getTimelineExportSnapshot(),
      getAtomTable: () => _timelineSub!.getAtomMetadataRegistry().getAtomTable(),
      getColorAssignments: () => useAppStore.getState().bondedGroupColorAssignments.map(a => ({
        atomIds: a.atomIds,
        colorHex: a.colorHex,
      })),
      appVersion: '0.1.0',
    }, range);
  }

  function _buildCapsuleArtifactForPublish(): CapsuleArtifact | null {
    return buildCapsuleArtifact(null);
  }

  // Construct the publisher once the subsystem accessor is available.
  // Deps are lazily read through closures so the publisher can outlive
  // transient subsystem rebuilds (teardown + reinstall happens in a
  // Watch→Lab handoff).
  _capsulePublisher = createPreparedCapsulePublisher({
    buildCapsuleArtifact: (range) => buildCapsuleArtifact(range),
    getCapsuleExportInputVersion: () => _timelineSub!.getCapsuleExportInputVersion(),
    postCapsuleArtifact,
  });

  // ── Simulation timeline subsystem ──
  _timelineSub = createTimelineSubsystem({
    getPhysics: () => physics,
    getRenderer: () => renderer,
    pause: () => { if (!session.playback.paused) togglePlaybackPause(); },
    resume: () => { if (session.playback.paused) togglePlaybackPause(); },
    isPaused: () => session.playback.paused,
    reinitWorker: async () => {
      if (!_workerRuntime || physics.n === 0) return;
      const payload = serializeForWorkerRestore(physics, _buildWorkerConfig);
      const result = await _workerRuntime.restoreState(
        payload.config, payload.atoms, payload.bonds,
        payload.velocities, payload.boundary,
      );
      // On logical failure, `restoreState` already tore down the
      // worker and `onFailure` → `recoverLocalPhysicsAfterWorkerFailure`
      // restored main-thread physics from the last snapshot. Surface
      // a user-facing banner so subsequent scrub / play against the
      // now-sync-mode engine isn't silently wrong.
      if (!result.ok) {
        useAppStore.getState().setStatusError(
          'Simulation worker disconnected during timeline restart. Running locally — performance may be reduced.',
        );
      }
    },
    isWorkerActive: () => !!(_workerRuntime && _workerRuntime.isActive()),
    forceRender: () => { scheduler.forceRenderThisTick = true; },
    clearBondedGroupHighlight: () => { _bondedGroupHighlight?.clearHighlight(); },
    clearRendererFeedback: () => { if (renderer) renderer.clearFeedback(); },
    syncBondedGroupsForDisplayFrame: () => { _bondedGroupCoordinator?.update(); _bondedGroupAppearance?.syncToRenderer(); },
    getSceneMolecules: () => session.scene.molecules,
    syncAppearance: () => _bondedGroupAppearance?.syncToRenderer(),
    exportHistory: async (kind) => {
      const artifact = buildExportArtifact(kind);
      if (!artifact) throw new Error('No recorded history to export.');
      const errors = artifact.kind === 'capsule'
        ? validateCapsuleFile(artifact.file)
        : validateFullHistoryFile(artifact.file);
      if (errors.length > 0) throw new Error(`Export validation failed: ${errors[0]}`);
      return saveHistoryFile(artifact.blob, artifact.defaultFileName);
    },
    getExportEstimates: () => {
      let capsule: string | null = null;
      let full: string | null = null;
      try {
        const a = buildExportArtifact('capsule');
        if (a) capsule = formatBytes(a.json.length);
      } catch (err) { console.warn('[export] capsule estimate failed:', err); }
      try {
        const a = buildExportArtifact('full');
        if (a) full = formatBytes(a.json.length);
      } catch (err) { console.warn('[export] full estimate failed:', err); }
      return { capsule, full };
    },
    exportCapabilities: { full: true, capsule: true },
    publishCapsule: async () => {
      // No-arg publish path (non-trim). Builds a fresh artifact over
      // the full current history and POSTs via the shared
      // postCapsuleArtifact. Trim-mode callers go through the
      // prepared-artifact publisher so measured == POSTed bytes.
      const artifact = _buildCapsuleArtifactForPublish();
      if (!artifact) throw new Error('No recorded history to publish.');
      return postCapsuleArtifact(artifact);
    },
    publishGuestCapsule: async (turnstileToken: string) => {
      // Anonymous Quick Share path. Same artifact construction as the
      // account no-arg publish so oversize preflight, byte accounting,
      // and validation stay aligned. Guest trim mode is out of scope
      // in v1 — the dialog disables Continue as Guest above the size
      // ceiling and surfaces the sign-in-to-trim upsell.
      const artifact = _buildCapsuleArtifactForPublish();
      if (!artifact) throw new Error('No recorded history to publish.');
      return postGuestCapsuleArtifact(artifact, turnstileToken);
    },
    bondedGroupAppearance: _bondedGroupAppearance ?? undefined,
    prepareCapsulePublish: (range) => _capsulePublisher!.prepareCapsulePublish(range),
    publishPreparedCapsule: (prepareId) => _capsulePublisher!.publishPreparedCapsule(prepareId),
    cancelPreparedPublish: (prepareId) => _capsulePublisher!.cancelPreparedPublish(prepareId),
  });
  _timelineSub.installAndEnable(); // Atomic: install callbacks + enter ready state (no transient off flash)

  // ── Watch → Lab handoff consume (plan §7 + §10 surfacing policy) ──
  // Runs AFTER the timeline subsystem is ready (so the tracker +
  // registry are reachable from scene-runtime) but BEFORE auth/input
  // wiring so the hydrated scene is visible the first time the user
  // can interact.
  //
  // Outcome dispatch per plan §10. The rule: user-attempt failures that
  // commonly happen in normal usage (stale TTL, storage already consumed /
  // cleared / private-mode-dropped) are VISIBLE. Tampering or schema-drift
  // signals stay SILENT because a scary toast on a coincidental deploy or
  // a crafted URL is worse than a quiet fallback.
  //
  //   - `none`     → silent normal boot (no `?from=watch` at all).
  //   - `ready`    → hydrate; the wrapper surfaces any classified
  //                  transaction failure via setStatusError on its own.
  //   - `rejected` + 'stale' → user clicked a >10 min old Remix link.
  //                  Tell them it expired so they don't stare at a
  //                  default scene wondering why.
  //   - `rejected` + 'missing-entry' → `?from=watch&handoff=<token>` but
  //                  no matching storage (one-shot already consumed on a
  //                  prior tab, storage cleared, private-mode eviction,
  //                  later reopen of the same URL). Same "I clicked
  //                  Remix and got the default scene" confusion as stale
  //                  — surface it with slightly different copy since
  //                  "expired" would mislead when TTL wasn't the cause.
  //   - `rejected` + any other reason (malformed-seed, wrong-version,
  //                  wrong-source, wrong-mode, missing-token, parse-
  //                  error) → silent (console.warn'd by the consumer).
  //                  These indicate tampering or schema drift, not a
  //                  normal user attempt.
  {
    const outcome = consumeWatchToLabHandoffFromLocation(window.location, window.history);
    if (outcome.status === 'ready') {
      try {
        // Wait for the worker's initial C60 `init` to ack before
        // consuming the handoff. Without this, the hydrate's
        // `workerRuntime.isActive()` check reads false, the worker
        // commit is silently skipped, and the worker (once
        // initialized) starts emitting C60 frameResults that clobber
        // the main-thread seed scene. Failures propagate — the
        // lifecycle's own `onFailure` handler has already run, so
        // the worker is torn down; hydrate then runs in
        // no-worker mode (main-thread only) which is safe.
        if (_workerInitPromise) {
          try {
            await _workerInitPromise;
          } catch (err) {
            console.warn('[lab.boot] worker init failed before hydrate; continuing without worker:', err);
          }
        }
        const result = await _scene!.hydrateFromWatchSeed(outcome.payload.seed, outcome.payload.sourceMeta);
        if (result.status === 'error') {
          console.warn('[lab.boot] watch handoff hydrate failed:', result.reason, result.cause ?? '');
        } else {
          {
            // Legacy tokens may omit the rev-4 refined fields; the
            // normalizer fills defaults at hydrate time, but the raw
            // seed we log here can still be in its pre-normalize shape.
            // Read with ?? fallbacks so the trace stays readable across
            // the deploy window.
            const prov = outcome.payload.seed.provenance as {
              historyKind: 'full' | 'capsule';
              velocitiesAreApproximated: boolean;
              velocitySource?: string;
              unresolvedVelocityFraction?: number;
            };
            console.info('[lab.boot] watch handoff hydrated:', {
              atomCount: result.atomCount,
              historyKind: prov.historyKind,
              velocitiesAreApproximated: prov.velocitiesAreApproximated,
              velocitySource: prov.velocitySource
                ?? (prov.velocitiesAreApproximated ? 'mixed' : 'restart'),
              unresolvedVelocityFraction: prov.unresolvedVelocityFraction ?? 0,
              colorAssignmentCount: outcome.payload.seed.colorAssignments?.length ?? 0,
              hasCamera: outcome.payload.seed.camera != null,
            });
          }
          // Arrival pill removed — the hydrate itself is the
          // acknowledgement (the scene renders from the handoff). The
          // console.info above preserves the provenance trace for
          // debugging (historyKind, velocitiesAreApproximated) without
          // occupying UI real estate.
        }
      } catch (err) {
        console.error('[lab.boot] unexpected error during watch handoff hydrate:', err);
        useAppStore.getState().setStatusError(
          'Something went wrong loading that Watch scene. Please reload the page.',
        );
      }
    } else if (outcome.status === 'rejected' && outcome.reason === 'stale') {
      useAppStore.getState().setStatusError(
        'This link has expired. Open it again from Watch to try once more.',
      );
    } else if (outcome.status === 'rejected' && outcome.reason === 'missing-entry') {
      useAppStore.getState().setStatusError(
        'This link is no longer available. Open it again from Watch to try once more.',
      );
    }
    // All other outcomes (none, rejected+tampering-reason) fall through
    // to the normal Lab boot silently per §10.

    // ── Fallback to the default scene when the pending-handoff boot
    //    path ended without populating the scene. This covers every
    //    branch that left `physics.n === 0`: a stale / missing-entry
    //    / malformed / parse-error consume, a hydrate that rolled
    //    back, or an unexpected throw. Without this, the user would
    //    stare at an empty canvas (or a stale error toast) because
    //    the default-scene load was skipped up front. Loading the
    //    default here (rather than always up-front) keeps the
    //    happy-path flash-free: successful hydrate leaves physics.n
    //    > 0 and the fallback is a no-op. ──
    if (physics && physics.n === 0 && _defaultStructure) {
      try {
        await _scene!.addMoleculeToScene(
          _defaultStructure.file,
          _defaultStructure.description,
          [0, 0, 0],
        );
      } catch (err) {
        // Surface to the user — `console.warn` alone would leave an
        // empty canvas with the handoff-rejected toast auto-dismissing
        // in a few seconds, giving them no affordance for recovery.
        // Prefer this over the rejection-reason toast that may be up:
        // "the default didn't load" is the more actionable state.
        console.error('[lab.boot] default-scene fallback load failed:', err);
        useAppStore.getState().setStatusError(
          'Couldn\u2019t load the default scene. Please reload the page.',
        );
      }
    }
  }

  // ── Auth UX (Phase 6) ──
  // Register sign-in / sign-out callbacks and kick off a session fetch. The
  // Lab stays usable for anonymous users; the Transfer dialog's Share tab
  // and the AccountControl read `auth.session` via the store and gate on it.
  //
  // If the user is returning from an OAuth round-trip and we previously
  // stashed a "resume publish" intent in sessionStorage, set the one-shot
  // shareTabOpenRequested flag after the session hydrates so TimelineBar
  // auto-opens the Transfer dialog on the Share tab. We only honor the
  // intent when the session lands signed-in — a failed callback leaves the
  // user unauthed, and auto-opening the dialog would just re-prompt them
  // confusingly.
  {
    const { callbacks: authCallbacks, hydrate } = createAuthRuntime();
    useAppStore.getState().setAuthCallbacks(authCallbacks);
    // Popup OAuth flow: the popup posts `{type:'atomdojo-auth-complete'}`
    // back to this tab when the provider redirects it to /auth/popup-complete.
    // Attach once; the listener is idempotent and survives the Lab's
    // lifetime. In same-tab fallback (popup blocked), the listener is
    // never triggered — the boot-time resume handshake below handles it.
    attachAuthCompleteListener();
    // Same-tab fallback resume: if we previously redirected away in a
    // popup-blocked browser, the returning page load carries `?authReturn=1`
    // and an un-consumed sessionStorage sentinel. Consume them here.
    const resumeRequested = consumeResumePublishIntent();
    void hydrate().then((state) => {
      if (resumeRequested && state.status === 'signed-in') {
        useAppStore.getState().requestShareTabOpen();
      }
    });
  }

  // E2E-only hook — exposes the app store for tests that need to drive
  // timeline state directly (e.g. layout regression tests for restart/action
  // overlap, which would otherwise require a real recording setup).
  // Gated behind ?e2e=1 so it is never part of the production runtime surface.
  if (new URLSearchParams(window.location.search).get('e2e') === '1') {
    (window as unknown as Record<string, unknown>).__useAppStore = useAppStore;
    // Trim-mode E2E needs to simulate the PublishOversizeError path
    // without running a real server 413. Exposing the class under the
    // same e2e gate lets the spec construct a real instance (the
    // `isPublishOversizeError` guard uses `instanceof`). Synchronous
    // assignment — an `await import(...)` would race the E2E helper's
    // `waitForUIState` poll.
    (window as unknown as Record<string, unknown>).__PublishOversizeError = PublishOversizeError;
  }

  // Plan §"Test observability seams": pure pass-through to the same
  // camera apply seam the hydrate path writes through. Installed
  // unconditionally like `_getUIState` below — Lab tabs opened from
  // Watch's `?e2e=1` session do NOT carry `?e2e=1` in their URL (the
  // handoff link template adds only `?from=watch&handoff=...`), so a
  // gate-check here would prevent E2E camera assertions on the Lab
  // tab that actually matters. Production impact is negligible: a
  // single read-only getter added to `window`.
  //
  // ── Public diagnostic surface — stability expectations ──
  //
  // `_getLabCameraSnapshot` and `_getUIState` (just below) are
  // INTENTIONALLY exposed unconditionally, NOT gated by `?e2e=1`.
  // Justification:
  //   · cross-tab E2E handoff: Watch → Lab tab doesn't carry the
  //     `?e2e=1` query (URL template is `?from=watch&handoff=...`)
  //     so a gate-check blocks the assertions from the Lab side.
  //   · they are READ-ONLY and do not expose credentials or session
  //     tokens — only renderer + non-sensitive store state.
  //   · they are WIDTHLESS: adding a new field requires review here,
  //     so the surface cannot grow silently.
  //
  // Stability contract for external callers:
  //   · _getLabCameraSnapshot(): null | { position, target, up }
  //     — additive fields OK; removing/renaming counts as a break.
  //   · _getUIState(): a flat record with named primitives. Fields
  //     listed below are considered stable; additions are non-
  //     breaking; removals/renames require a review cycle.
  //
  // Prefer `?e2e=1`-gated hooks (like `__useAppStore` and
  // `__PublishOversizeError`) for anything that mutates state or
  // exposes internals. The two unconditional getters here remain
  // acceptable because they satisfy a narrow cross-tab E2E need
  // without a mutable surface.
  (window as unknown as Record<string, unknown>)._getLabCameraSnapshot = () => renderer?.getOrbitCameraSnapshot?.() ?? null;

  // Narrow test hook — returns only the specific observable E2E tests need.
  (window as unknown as Record<string, unknown>)._getUIState = () => {
    const s = useAppStore.getState();
    return {
      recentStructure: s.recentStructure,
      activeSheet: s.activeSheet,
      helpPageActive: s.helpPageActive,
      placementActive: s.placementActive,
      targetSpeed: s.targetSpeed,
      boundaryMode: s.boundaryMode,
      interactionMode: s.interactionMode,
      theme: s.theme,
      atomCount: s.atomCount,
      activeBonds: renderer.getActiveBondCount(),
      orbitFollowEnabled: s.orbitFollowEnabled,
      onboardingVisible: s.onboardingVisible,
      onboardingPhase: s.onboardingPhase,
    };
  };

  // ── Named playback/settings commands for store callback registration ──
  function togglePlaybackPause() {
    session.playback.paused = !session.playback.paused;
    if (useAppStore.getState().paused !== session.playback.paused) {
      useAppStore.getState().togglePause();
    }
    if (session.playback.paused) {
      // On pause: flush authoritative pos+vel from worker to local physics.
      // _pauseSyncPromise is awaited by commitMolecule to block mutations until fresh.
      if (_workerRuntime && _workerRuntime.isActive()) {
        _pauseSyncPromise = _workerRuntime.syncStateNow().then(() => {
          const snap = _workerRuntime?.getLatestSnapshot?.();
          if (snap && snap.n === physics.n) {
            if (physics.pos && snap.positions) {
              const len = Math.min(snap.positions.length, physics.pos.length);
              physics.pos.set(snap.positions.subarray(0, len));
            }
            if (physics.vel && snap.velocities) {
              const len = Math.min(snap.velocities.length, physics.vel.length);
              physics.vel.set(snap.velocities.subarray(0, len));
            }
          }
        }).catch(() => {
          // syncStateNow failure triggers worker teardown + recovery via onFailure
        }).finally(() => {
          _pauseSyncPromise = null;
        });
      }
    } else {
      scheduler.lastFrameTs = performance.now();
      scheduler.simBudgetMs = 0;
    }
  }

  function changePlaybackSpeed(val: '0.5' | '1' | '2' | '4' | 'max') {
    if (val === 'max') {
      session.playback.speedMode = 'max';
    } else {
      session.playback.speedMode = 'fixed';
      session.playback.selectedSpeed = parseFloat(val);
    }
    useAppStore.getState().setTargetSpeed(val === 'max' ? Infinity : parseFloat(val));
  }

  function applyThemeSetting(theme: 'dark' | 'light') {
    session.theme = theme;
    renderer.applyTheme(session.theme);
    applyThemeTokens(session.theme);
    useAppStore.getState().setTheme(theme);
    // Persist so other product surfaces (account, privacy, terms,
    // privacy-request) can inherit the same theme without a per-page
    // toggle. Wrapped in try/catch because Safari ITP / private mode
    // can throw on localStorage writes — the theme just won't carry.
    try { localStorage.setItem('atomdojo.theme', theme); } catch { /* noop */ }
  }

  function applyTextSizeSetting(size: 'normal' | 'large') {
    session.textSize = size;
    applyTextSizeTokens(size);
    useAppStore.getState().setTextSize(size);
  }

  function setInteractionModeSetting(mode: 'atom' | 'move' | 'rotate') {
    session.interactionMode = mode;
    useAppStore.getState().setInteractionMode(mode);
  }

  // Register store callbacks — React components invoke these via the Zustand store
  registerStoreCallbacks({
    overlayRuntime: _overlay!,
    togglePause: togglePlaybackPause,
    changeSpeed: changePlaybackSpeed,
    setInteractionMode: setInteractionModeSetting,
    forceRenderThisTick: () => { scheduler.forceRenderThisTick = true; },
    clearPlayground: async () => { await _scene!.clearPlayground(); _timelineSub?.resetToPassiveReady(); },
    resetView: () => renderer.resetView(),
    updateChooserRecentRow: () => _scene!.updateChooserRecentRow(),
    setPhysicsWallMode: (mode) => { physics.setWallMode(mode); },
    setPhysicsDragStrength: (v) => { physics.setDragStrength(v); },
    setPhysicsRotateStrength: (v) => { physics.setRotateStrength(v); },
    setPhysicsDamping: (d) => { physics.setDamping(d); },
    applyTheme: applyThemeSetting,
    applyTextSize: applyTextSizeSetting,
    isWorkerActive: () => !!(_workerRuntime && _workerRuntime.isActive()),
    sendWorkerInteraction: (cmd) => { if (_workerRuntime) _workerRuntime.sendInteraction(cmd); },
    isPlacementActive: () => !!(placement && placement.active),
    exitPlacement: (commit) => { if (placement) placement.exit(commit); },
    startPlacement: (file, desc) => { if (placement) placement.start(file, desc); },
  });

  // Camera target deps already hoisted as _focusTargetDeps above bonded-group callbacks

  // Register camera control callbacks via store (Free-Look only after Phase 10 legacy cleanup)
  // Center/Follow moved to BondedGroupCallbacks
  useAppStore.getState().setCameraCallbacks({
    onReturnToObject: () => {
      renderer.animateToFocusedObject({
        levelUp: true,
        onComplete: () => useAppStore.getState().setCameraMode('orbit'),
      });
    },
    onFreeze: () => { renderer.freezeFlight(); useAppStore.getState().setFlightActive(false); },
  });

  // Wire return-target callback through generic camera-target resolution
  renderer.setReturnTargetResolver(() => {
    const target = resolveReturnTarget(renderer, renderer.getSceneRadius(), _focusTargetDeps);
    return target;
  });

  // Subscribe to camera mode changes → configure OrbitControls + achievement
  let _prevCameraMode = useAppStore.getState().cameraMode;
  _unsubCameraMode = useAppStore.subscribe((s) => {
    if (s.cameraMode !== _prevCameraMode) {
      _prevCameraMode = s.cameraMode;
      // Normalize: if Free-Look disabled, treat any freelook state as orbit
      const effectiveMode = (CONFIG.camera.freeLookEnabled && s.cameraMode === 'freelook')
        ? 'freelook' : 'orbit';
      renderer.setOrbitControlsForMode(effectiveMode);
      if (effectiveMode === 'freelook') {
        _onboarding?.recordAchievement('mode-entry');
      } else if (s.cameraMode === 'orbit') {
        // Only run orbit-entry cleanup when actually transitioning to orbit
        renderer.returnToOrbitFromFreeLook();
        useAppStore.getState().setFlightActive(false);
        useAppStore.getState().setFarDrift(false);
      }
    }
  });

  // Normalize: if Free-Look is disabled, force Orbit-safe state
  if (!CONFIG.camera.freeLookEnabled) {
    const s = useAppStore.getState();
    if (s.cameraMode !== 'orbit') s.setCameraMode('orbit');
    if (s.flightActive) s.setFlightActive(false);
    if (s.farDrift) s.setFarDrift(false);
  }

} // end init()

// --- Composition-root helpers (not extracted — see plan v6 refinement #1, #2) ---

/** Build PhysicsConfig from current physics engine state (single authority). */
function _buildWorkerConfig(): import('../../src/types/worker-protocol').PhysicsConfig {
  return {
    dt: physics.dtFs,
    dampingReferenceSteps: physics.dampingRefSteps,
    damping: physics.getDamping(),
    kDrag: physics.getDragStrength(),
    kRotate: physics.getRotateStrength(),
    wallMode: physics.getWallMode() as 'contain' | 'remove',
    useWasm: true,
  };
}

/** Recover local physics after worker failure. Called via workerRuntime.onFailure.
 *  Seeds local state from the snapshot captured before teardown if available,
 *  including atom-count reconciliation if the worker's authoritative count differs.
 *  Otherwise preserves existing local momentum. Never blanket-zeroes velocity.
 *
 *  CRITICAL: early-returns when a Watch→Lab hydrate transaction is in
 *  flight (`_hydrationActive === true`). The hydrate's own rollback
 *  path is the authority over physics state during that window; if
 *  this recovery ran anyway it would overwrite the just-restored
 *  checkpoint with the worker's stale last-snapshot, and the user
 *  would see the wrong scene alongside the hydrate's "couldn't
 *  remix" banner. The hydrate classifies the failure itself and
 *  surfaces the appropriate copy. Logged so ops can correlate. */
function recoverLocalPhysicsAfterWorkerFailure(reason: string, lastSnapshot?: import('./runtime/worker/worker-lifecycle').RecoverySnapshot) {
  if (_hydrationActive) {
    console.warn(
      '[worker] failure during hydrate transaction — deferring to hydrate rollback:',
      reason,
    );
    return;
  }
  console.warn('[worker] failure:', reason, '— rebuilding local physics for sync fallback');
  if (physics) {
    const snap = lastSnapshot;
    if (snap) {
      // Reconcile atom count — worker may have removed atoms (wall removal) since
      // the last main-thread sync. Same pattern as snapshot-reconciler.ts:40.
      if (snap.n !== physics.n) {
        physics.n = snap.n;
        if (renderer) {
          renderer.setAtomCount(snap.n);
          renderer.setPhysicsRef(physics);
        }
      }
      // Copy authoritative positions
      if (physics.pos && snap.positions) {
        const len = Math.min(snap.positions.length, physics.pos.length);
        physics.pos.set(snap.positions.subarray(0, len));
      }
      // Copy authoritative velocities (preserves COM momentum)
      if (physics.vel && snap.velocities) {
        const len = Math.min(snap.velocities.length, physics.vel.length);
        physics.vel.set(snap.velocities.subarray(0, len));
      }
    }
    // No snapshot: preserve existing local state — imperfect but better than zero
    if (physics.n > 0) {
      physics.computeForces();
      physics.refreshTopology();
      physics.updateWallRadius();
    }
  }
  fullSchedulerReset();
  // Surface transient status so user/developer knows worker mode was lost
  useAppStore.getState().setStatusText('Worker sync lost — running locally');
  setTimeout(() => {
    if (useAppStore.getState().statusText === 'Worker sync lost — running locally') {
      useAppStore.getState().setStatusText(null);
    }
  }, 5000);
}

// --- Profiler reset helpers ---
function fullSchedulerReset() {
  scheduler.simBudgetMs = 0;
  scheduler.overloadCount = 0;
  scheduler.mode = 'normal';
  scheduler.totalStepsProfiled = 0;
  scheduler.forceRenderThisTick = false;
  scheduler.stableTicks = 0;
  scheduler.prevPhysStepMs = 1;
  scheduler.prevRenderMs = 1;
  scheduler.warmUpComplete = false;
  scheduler.lastMaxSpeedUpdateTs = 0;
  scheduler.skipPressure = 0;
  scheduler.comfortTicks = 0;
  scheduler.renderSkipLevel = 1;
  scheduler.renderSkipCounter = 0;
  scheduler.renderCount = 0;
  scheduler.lastRenderCountTs = performance.now();
  scheduler.hasRenderSample = false;
  scheduler.effectiveSpeedWindow = [];
  // Reset profiler EMAs to neutral defaults
  scheduler.prof.physStepMs = 1;
  scheduler.prof.updatePosMs = 0.1;
  scheduler.prof.renderMs = 1;
  scheduler.prof.otherMs = 0.1;
  scheduler.prof.rafIntervalMs = 16.67;
  scheduler.prof.actualRendersPerSec = 60;
  // Reset recovery blend state
  scheduler.recoveringStartMax = 0;
  scheduler.recoveringBlendRemaining = 0;
}

function partialProfilerReset() {
  // Reduce EMA magnitudes so fresh samples dominate faster via the normal
  // alpha blending. This biases estimates low temporarily — maxSpeed may
  // briefly overstate until new samples arrive. Acceptable because warm-up
  // re-entry (below) caps target speed at 1.0 during that window.
  scheduler.prof.physStepMs *= 0.5;
  scheduler.prof.renderMs *= 0.5;
  scheduler.prof.updatePosMs *= 0.5;
  scheduler.prof.otherMs *= 0.5;
  // Re-enter warm-up with a fresh stability window
  scheduler.warmUpComplete = false;
  scheduler.stableTicks = 0;
  // Reset comparison baselines to post-reset values so stability compares against new state
  scheduler.prevPhysStepMs = scheduler.prof.physStepMs;
  scheduler.prevRenderMs = scheduler.prof.renderMs;
  scheduler.hasRenderSample = false;
  // Reset render-cadence state so maxSpeed doesn't use stale render-rate history
  scheduler.prof.actualRendersPerSec *= 0.5; // down-weight like other profiler fields
  scheduler.renderCount = 0;
  scheduler.lastRenderCountTs = performance.now();
  // Force re-warm by capping the step count below the exit threshold
  scheduler.totalStepsProfiled = Math.min(scheduler.totalStepsProfiled, CONFIG.playback.partialResetStepsCap);
  scheduler.lastMaxSpeedUpdateTs = 0;
}


// --- Frame Loop (thin wrapper — delegates to frame-runtime.ts) ---
// main.ts owns RAF lifecycle; frame-runtime.ts owns the sequenced update pipeline.
function frameLoop(timestamp: number) {
  // Construct the narrow surface for frame-runtime (reads module-scoped variables)
  const surface: FrameRuntimeSurface = {
    physics, renderer, stateMachine, session, scheduler,
    workerRuntime: _workerRuntime,
    snapshotReconciler: _snapshotReconciler,
    timelineSub: _timelineSub,
    dragRefresh: _dragRefresh,
    inputBindings: _inputBindings,
    bondedGroupCoordinator: _bondedGroupCoordinator,
    overlayLayout: _overlayLayout,
    placement,
    placementFramingAnchor: _placementFramingAnchor,
    setPlacementFramingAnchor: (a: any) => { _placementFramingAnchor = a; },
    getBondedGroupAtoms: (groupId: string) => _bondedGroups?.getAtomIndicesForGroup(groupId) ?? null,
    scene: _scene,
    effectsGate,
    lastReconciledSnapshotVersion: _lastReconciledSnapshotVersion,
    setLastReconciledSnapshotVersion: (v: number) => { _lastReconciledSnapshotVersion = v; },
    appRunning: _appRunning,
    getStepTiming: _getStepTiming,
    isHydrating: () => _hydrationActive,
  };
  executeFrame(timestamp, surface);
  if (_appRunning) _rafId = requestAnimationFrame(frameLoop);
}

// ── Frame loop body extracted to lab/js/app/frame-runtime.ts ──
// (~350 lines of sequenced update pipeline moved to executeFrame())

// Frame loop body (~350 lines) extracted to lab/js/app/frame-runtime.ts.
// main.ts retains only RAF lifecycle (start/stop/teardown).

// --- Start ---
init();
