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
import '../../src/ui/bottom-region.css';
import * as THREE from 'three';
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
import { createOverlayLayout, type OverlayLayout } from './runtime/overlay-layout';
import { getDeviceMode } from '../../src/ui/device-mode';
import { createInteractionDispatch } from './runtime/interaction-dispatch';
import { createOverlayRuntime, type OverlayRuntime } from './runtime/overlay-runtime';
import { createInputBindings, type InputBindings } from './runtime/input-bindings';
import { registerStoreCallbacks } from './runtime/ui-bindings';
import { createAtomSource } from './runtime/atom-source';
import { createSceneRuntime, type SceneRuntime } from './runtime/scene-runtime';
import { handleCenterObject as _handleCenterObject, resolveReturnTarget } from './runtime/focus-runtime';
import { createSnapshotReconciler, type SnapshotReconciler } from './runtime/snapshot-reconciler';
import { createWorkerRuntime, type WorkerRuntime } from './runtime/worker-lifecycle';
import { createOnboardingController, subscribeOnboardingReadiness } from './runtime/onboarding';
import { createDragTargetRefresh, dragRefreshAction } from './runtime/drag-target-refresh';
import { createBondedGroupRuntime, type BondedGroupRuntime } from './runtime/bonded-group-runtime';
import { resolveBondedGroupDisplaySource } from './runtime/bonded-group-display-source';
import { createBondedGroupAppearanceRuntime, type BondedGroupAppearanceRuntime } from './runtime/bonded-group-appearance-runtime';
import { handleBondedGroupFollowToggle } from './runtime/bonded-group-follow-actions';
import { createBondedGroupHighlightRuntime, type BondedGroupHighlightRuntime } from './runtime/bonded-group-highlight-runtime';
import { createBondedGroupCoordinator, type BondedGroupCoordinator } from './runtime/bonded-group-coordinator';
import { createTimelineSubsystem, type TimelineSubsystem } from './runtime/timeline-subsystem';
import { executeFrame, type FrameRuntimeSurface } from './app/frame-runtime';
import { teardownAllSubsystems, resetSchedulerState, resetSessionState, resetEffectsGate, type TeardownSurface } from './app/app-lifecycle';
import { serializeForWorkerRestore } from './runtime/restart-state-adapter';

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

const session = {
  theme: DEFAULT_THEME,
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
let _unsubCameraMode: (() => void) | null = null;

// Bonded group subsystem
let _bondedGroups: BondedGroupRuntime | null = null;
let _bondedGroupHighlight: BondedGroupHighlightRuntime | null = null;
let _bondedGroupCoordinator: BondedGroupCoordinator | null = null;
let _bondedGroupAppearance: BondedGroupAppearanceRuntime | null = null;

// Simulation timeline subsystem
let _timelineSub: TimelineSubsystem | null = null;
/** Track the last reconciled snapshot version to avoid double-counting steps. */
let _lastReconciledSnapshotVersion = -1;
/** Frozen visible-anchor set for placement framing (captured at placement start). */
let _placementFramingAnchor: { x: number; y: number; z: number }[] | null = null;


// Pause sync guard — resolves when syncStateNow completes during pause transition.
// Awaited by scene-runtime commitMolecule to block mutations until local state is fresh.
let _pauseSyncPromise: Promise<void> | null = null;

// Interaction dispatch (created in init)
let _dispatch: ((cmd: import('./state-machine').Command, sx?: number, sy?: number) => { dragTarget?: number[] }) | null = null;

// Per-frame drag target refresh (fixes stale world-space target when atom moves under spring)
let _dragRefresh: import('./runtime/drag-target-refresh').DragTargetRefresh | null = null;

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
      _onboarding = null; _unsubOnboardingOverlay = null; _unsubCameraMode = null;
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
  store.setDragStrength(physics.getDragStrength());
  store.setRotateStrength(physics.getRotateStrength());
  // Reverse damping→slider: d = 0.5 * t³, t = cbrt(2d), slider = t * 100
  const initDamping = physics.getDamping();
  store.setDampingSliderValue(initDamping === 0 ? 0 : Math.round(Math.cbrt(2 * initDamping) * 100));

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
    onSceneMutated: () => { _bondedGroupCoordinator?.update(); if (physics) _bondedGroupAppearance?.pruneAndSync(physics.n); },
    onMoleculeCommitted: (info) => {
      if (!_timelineSub) return;
      const tracker = _timelineSub.getAtomIdentityTracker();
      const registry = _timelineSub.getAtomMetadataRegistry();
      const assignedIds = tracker.handleAppend(info.atomOffset, info.atomCount);
      registry.registerAppendedAtoms(assignedIds, info.atoms, { file: info.filename, label: info.name });
    },
  });

  // Load manifest
  try {
    manifest = await loadManifest();

    // Auto-load C60 as first molecule
    const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);
    if (entries.length > 0) {
      const c60 = entries.find(([k]) => k === 'c60');
      const [key, info] = c60 || entries[0];
      await _scene!.addMoleculeToScene(info.file, info.description, [0, 0, 0]);
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

    // Initialize with current scene state
    if (physics.n > 0) {
      const config = _buildWorkerConfig();
      _workerRuntime.init(config, _scene!.collectSceneAtoms(), _scene!.collectSceneBonds());
    }
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
    getStatusCtrl: () => statusCtrl,
    isWorkerActive: () => !!(_workerRuntime && _workerRuntime.isActive()),
    sendWorkerInteraction: (cmd) => { if (_workerRuntime) _workerRuntime.sendInteraction(cmd); },
    markAtomInteractionStarted: () => { _timelineSub?.markAtomInteractionStarted(); },
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
      await _workerRuntime.restoreState(
        payload.config, payload.atoms, payload.bonds,
        payload.velocities, payload.boundary,
      );
    },
    isWorkerActive: () => !!(_workerRuntime && _workerRuntime.isActive()),
    forceRender: () => { scheduler.forceRenderThisTick = true; },
    clearBondedGroupHighlight: () => { _bondedGroupHighlight?.clearHighlight(); },
    clearRendererFeedback: () => { if (renderer) renderer.clearFeedback(); },
    syncBondedGroupsForDisplayFrame: () => { _bondedGroupCoordinator?.update(); },
    getSceneMolecules: () => session.scene.molecules,
    exportHistory: async (kind) => {
      if (kind !== 'full' || !_timelineSub) return;
      // Defensive runtime gate — identity may be stale after worker compaction
      if (_timelineSub.isIdentityStale()) {
        throw new Error('Export is unavailable because atom identity is stale after worker compaction.');
      }
      const { buildFullHistoryFile, downloadHistoryFile, validateFullHistoryFile } = await import('./runtime/history-export');
      const file = buildFullHistoryFile({
        getTimelineExportData: () => _timelineSub!.getTimelineExportSnapshot(),
        getAtomTable: () => _timelineSub!.getAtomMetadataRegistry().getAtomTable(),
        appVersion: '0.1.0',
      });
      if (!file) throw new Error('No recorded history to export.');
      const errors = validateFullHistoryFile(file);
      if (errors.length > 0) throw new Error(`Export validation failed: ${errors[0]}`);
      downloadHistoryFile(file);
    },
    exportCapabilities: { replay: false, full: true },
  });
  _timelineSub.installAndEnable(); // Atomic: install callbacks + enter ready state (no transient off flash)

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
 *  Otherwise preserves existing local momentum. Never blanket-zeroes velocity. */
function recoverLocalPhysicsAfterWorkerFailure(reason: string, lastSnapshot?: import('./runtime/worker-lifecycle').RecoverySnapshot) {
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
