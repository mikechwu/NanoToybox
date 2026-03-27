/**
 * NanoToybox Interactive Page — Entry Point
 *
 * Multi-molecule playground with placement mode.
 * Wires together: loader, physics, state machine, input, renderer, React UI.
 */
import * as THREE from 'three';
import { loadManifest, loadStructure } from './loader';
import { PhysicsEngine } from './physics';
import { StateMachine, type Command } from './state-machine';
import { Renderer } from './renderer';
import { applyThemeTokens, applyTextSizeTokens } from './themes';
import { CONFIG } from './config';
import { StatusController } from './status';
import { PlacementController } from './placement';
import { computeTargetSpeed, computeSubstepCount, updateOverloadState, computeEffectiveSpeed, shouldSkipRender, updateMaxSpeedEstimate } from './scheduler-pure';
import { mountReactUI, unmountReactUI } from './react-root';
import { useAppStore } from './store/app-store';
import { createOverlayLayout, type OverlayLayout } from './runtime/overlay-layout';
import { createInteractionDispatch } from './runtime/interaction-dispatch';
import { createOverlayRuntime, type OverlayRuntime } from './runtime/overlay-runtime';
import { createInputBindings, type InputBindings } from './runtime/input-bindings';
import { registerStoreCallbacks } from './runtime/ui-bindings';
import { createAtomSource } from './runtime/atom-source';
import { createSceneRuntime, type SceneRuntime } from './runtime/scene-runtime';
import { handleCenterObject as _handleCenterObject, resolveReturnTarget } from './runtime/focus-runtime';
import { createSnapshotReconciler, type SnapshotReconciler } from './runtime/snapshot-reconciler';
import { createWorkerRuntime, type WorkerRuntime } from './runtime/worker-lifecycle';
import { createOnboardingController } from './runtime/onboarding';

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
  theme: 'dark',
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
const stepWallMs = 1000 / CONFIG.playback.baseStepsPerSecond;

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

// Interaction dispatch (created in init)
let _dispatch: ((cmd: import('./state-machine').Command, sx?: number, sy?: number) => { dragTarget?: number[] }) | null = null;

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
  // Stop frame loop
  _appRunning = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  // Remove global listeners
  for (const [event, handler, target, options] of _globalListeners) {
    target.removeEventListener(event, handler, options);
  }
  _globalListeners.length = 0;
  // Clean up debug hooks
  delete window._setUiEffectsMode;
  delete (window as unknown as Record<string, unknown>)._getWorkerDebugState;
  delete (window as unknown as Record<string, unknown>)._simulateWorkerStall;
  delete (window as unknown as Record<string, unknown>)._setTestStalledThreshold;
  delete (window as unknown as Record<string, unknown>)._getUIState;
  // Destroy onboarding controller (clears coachmark timers + listeners)
  if (_onboarding) { _onboarding.destroy(); _onboarding = null; }
  // Destroy overlay layout runtime (observer, pending RAF)
  if (_overlayLayout) { _overlayLayout.destroy(); _overlayLayout = null; }
  // Tear down controllers (consumers) before input bindings (provider)
  if (placement) { placement.destroy(); placement = null; }
  if (statusCtrl) { statusCtrl.destroy(); statusCtrl = null; }
  // Destroy input bindings after controllers
  if (_inputBindings) { _inputBindings.destroy(); _inputBindings = null; }
  // Tear down worker transport before renderer (worker callbacks may read renderer state)
  if (_workerRuntime) { _workerRuntime.destroy(); _workerRuntime = null; }
  // Tear down subsystems
  if (renderer) { renderer.destroy(); renderer = null; }
  // Null remaining refs
  _overlay = null;
  _dispatch = null;
  _snapshotReconciler = null;
  _scene = null;
  physics = null;
  stateMachine = null;
  manifest = null;
  // Reset runtime state for potential re-init
  effectsGate.slowCount = 0;
  effectsGate.fastCount = 0;
  effectsGate.reduced = false;
  effectsGate.mode = 'auto';
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
  // Reset session state (theme + textSize preserved intentionally for re-init continuity)
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
  // Clear root UI effect state
  delete document.documentElement.dataset.uiEffects;
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
    const w = window.innerWidth;
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const canHover = window.matchMedia('(hover: hover)').matches;
    let mode;
    if (w < 768) mode = 'phone';
    else if (w < 1024 || (coarsePointer && !canHover)) mode = 'tablet';
    else mode = 'desktop';
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
      onFailure: (reason) => recoverLocalPhysicsAfterWorkerFailure(reason),
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
      } else if (
        useAppStore.getState().activeSheet !== null ||
        useAppStore.getState().cameraHelpOpen ||
        useAppStore.getState().pickFocusActive
      ) {
        _overlay!.close();
        e.preventDefault();
      } else if (useAppStore.getState().cameraMode === 'freelook') {
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
    if (_s.activeSheet === null && !_s.cameraHelpOpen && !_s.pickFocusActive) return;

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
    updateStatus: (text) => _scene!.updateStatus(text),
    updateSceneStatus: () => _scene!.updateSceneStatus(),
  });

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
    dispatch: (cmd, sx, sy) => _dispatch!(cmd, sx, sy),
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
      syncInput: () => { if (_inputBindings) _inputBindings.sync(); },
      forceRender: () => { scheduler.forceRenderThisTick = true; },
      buildAtomSource: () => createAtomSource(renderer),
      getSceneMolecules: () => session.scene.molecules,
      isSnapshotFresh: () => !(_workerRuntime && _workerRuntime.isActive()) || _workerRuntime!.getSnapshotAge() < 500,
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
    };
  };

  // ── Named playback/settings commands for store callback registration ──
  function togglePlaybackPause() {
    session.playback.paused = !session.playback.paused;
    if (useAppStore.getState().paused !== session.playback.paused) {
      useAppStore.getState().togglePause();
    }
    if (!session.playback.paused) {
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
    clearPlayground: () => _scene!.clearPlayground(),
    resetView: () => renderer.resetView(),
    updateChooserRecentRow: () => _scene!.updateChooserRecentRow(),
    setPhysicsWallMode: (mode) => physics.setWallMode(mode),
    setPhysicsDragStrength: (v) => physics.setDragStrength(v),
    setPhysicsRotateStrength: (v) => physics.setRotateStrength(v),
    setPhysicsDamping: (d) => physics.setDamping(d),
    applyTheme: applyThemeSetting,
    applyTextSize: applyTextSizeSetting,
    isWorkerActive: () => !!(_workerRuntime && _workerRuntime.isActive()),
    sendWorkerInteraction: (cmd) => { if (_workerRuntime) _workerRuntime.sendInteraction(cmd); },
    isPlacementActive: () => !!(placement && placement.active),
    exitPlacement: (commit) => { if (placement) placement.exit(commit); },
    startPlacement: (file, desc) => { if (placement) placement.start(file, desc); },
  });

  // Register camera control callbacks via store (consumed by CameraControls.tsx)
  // Center Object logic lives in focus-runtime.ts (shared with tests)
  useAppStore.getState().setCameraCallbacks({
    onCenterObject: () => { _handleCenterObject(renderer); },
    onReturnToObject: () => {
      renderer.animateToFocusedObject({
        levelUp: true,
        onComplete: () => useAppStore.getState().setCameraMode('orbit'),
      });
    },
    onFreeze: () => { renderer.freezeFlight(); useAppStore.getState().setFlightActive(false); },
  });

  // Wire return-target callback via shared resolveReturnTarget descriptor
  // Wire return-target callback directly from shared resolveReturnTarget
  renderer._returnToObjectCallback = () => {
    const target = resolveReturnTarget(renderer, renderer._sceneRadius);
    return target; // ReturnTarget has position + radius (+ kind, guardrailEligible)
  };

  // Subscribe to camera mode changes → configure OrbitControls + achievement
  let _prevCameraMode = useAppStore.getState().cameraMode;
  useAppStore.subscribe((s) => {
    if (s.cameraMode !== _prevCameraMode) {
      _prevCameraMode = s.cameraMode;
      renderer.setOrbitControlsForMode(s.cameraMode);
      if (s.cameraMode === 'freelook') {
        _onboarding?.recordAchievement('mode-entry');
      } else if (s.cameraMode === 'orbit') {
        renderer.returnToOrbitFromFreeLook();
        useAppStore.getState().setFlightActive(false);
        useAppStore.getState().setFarDrift(false);
      }
    }
  });

} // end init()

// --- Composition-root helpers (not extracted — see plan v6 refinement #1, #2) ---

/** Build PhysicsConfig from current physics engine state + CONFIG. */
function _buildWorkerConfig(): import('../../src/types/worker-protocol').PhysicsConfig {
  return {
    dt: CONFIG.physics.dt,
    stepsPerFrame: CONFIG.physics.stepsPerFrame,
    damping: physics.getDamping(),
    kDrag: physics.getDragStrength(),
    kRotate: physics.getRotateStrength(),
    wallMode: physics.getWallMode() as 'contain' | 'remove',
    useWasm: true,
  };
}

/** Recover local physics after worker failure. Called via workerRuntime.onFailure. */
function recoverLocalPhysicsAfterWorkerFailure(reason: string) {
  console.warn('[worker] failure:', reason, '— rebuilding local physics for sync fallback');
  if (physics && physics.n > 0) {
    if (physics.vel) physics.vel.fill(0);
    physics.computeForces();
    physics.updateBondList();
    physics.rebuildComponents();
    physics.updateWallRadius();
  }
  fullSchedulerReset();
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


// --- Frame Loop (accumulator-driven) ---
function frameLoop(timestamp) {
  const alpha = CONFIG.playback.profilerAlpha;
  const tickStart = performance.now();

  // RAF interval
  const frameDtMs = scheduler.lastFrameTs > 0
    ? Math.min(timestamp - scheduler.lastFrameTs, CONFIG.playback.gapThreshold)
    : 16.67;
  scheduler.lastFrameTs = timestamp;
  scheduler.prof.rafIntervalMs += alpha * (frameDtMs - scheduler.prof.rafIntervalMs);

  try {
    let substepsThisFrame = 0;

    // Physics: accumulator-driven stepping
    const shouldStep = !session.playback.paused && !(placement && placement.active) && physics.n > 0;
    if (shouldStep) {
      // Compute target speed (delegates clamping to pure function)
      const pb = session.playback;

      // Warm-up: adaptive — 30 steps OR 10 stable ticks
      if (!scheduler.warmUpComplete) {
        const physDelta = Math.abs(scheduler.prof.physStepMs - scheduler.prevPhysStepMs);
        const physStable = scheduler.prevPhysStepMs > 0 && physDelta / scheduler.prevPhysStepMs < CONFIG.playback.stabilityThreshold;
        // Include renderMs stability only when we've seen a real render sample
        const renderDelta = Math.abs(scheduler.prof.renderMs - scheduler.prevRenderMs);
        const renderStable = !scheduler.hasRenderSample || // no valid sample yet — suspend
          (scheduler.prevRenderMs > 0 && renderDelta / scheduler.prevRenderMs < CONFIG.playback.stabilityThreshold);
        scheduler.prevPhysStepMs = scheduler.prof.physStepMs;
        scheduler.prevRenderMs = scheduler.prof.renderMs;
        if (physStable && renderStable) scheduler.stableTicks++; else scheduler.stableTicks = 0;
        if (scheduler.totalStepsProfiled >= CONFIG.playback.warmUpSteps || scheduler.stableTicks >= CONFIG.playback.warmUpStableTicks) {
          scheduler.warmUpComplete = true;
                }
      }

      const targetSpeed = computeTargetSpeed(pb.speedMode, pb.selectedSpeed, pb.maxSpeed, scheduler.warmUpComplete);

      // Accumulate
      scheduler.simBudgetMs += frameDtMs * targetSpeed;

      // Budget cap based on overload mode
      const hardCap = CONFIG.playback.maxSubstepsPerTick * stepWallMs;
      if (scheduler.mode === 'overloaded') {
        scheduler.simBudgetMs = Math.min(scheduler.simBudgetMs, hardCap);
      } else {
        scheduler.simBudgetMs = Math.min(scheduler.simBudgetMs, hardCap * 1.5);
      }

      // Run substeps (count determined by pure function)
      substepsThisFrame = computeSubstepCount(scheduler.simBudgetMs, stepWallMs, CONFIG.playback.maxSubstepsPerTick);

      if (_workerRuntime && _workerRuntime.isActive()) {
        // C.2 Phase 2 — Worker mode: don't step locally; send request to worker
        // One-in-flight: only send if no outstanding request
        scheduler.simBudgetMs -= substepsThisFrame * stepWallMs;
        if (substepsThisFrame > 0 && _workerRuntime!.canSendRequest()) {
          _workerRuntime!.sendRequestFrame(substepsThisFrame);
        }
      } else {
        // Sync mode: step locally
        const physStart = performance.now();
        for (let i = 0; i < substepsThisFrame; i++) {
          physics.stepOnce();
          scheduler.simBudgetMs -= stepWallMs;
        }
        const physEnd = performance.now();

        if (substepsThisFrame > 0) {
          physics.applySafetyControls();
          const msPerStep = (physEnd - physStart) / substepsThisFrame;
          scheduler.prof.physStepMs += alpha * (msPerStep - scheduler.prof.physStepMs);
          scheduler.totalStepsProfiled += substepsThisFrame;
        }
      }

      // Overloaded in overloaded mode: discard residual budget
      if (scheduler.mode === 'overloaded') {
        scheduler.simBudgetMs = Math.min(scheduler.simBudgetMs, 0);
      }

      // Overload FSM (pure function computes new state)
      const prevMode = scheduler.mode;
      const overloadResult = updateOverloadState({
        mode: scheduler.mode,
        overloadCount: scheduler.overloadCount,
        substepsThisFrame,
        maxSubsteps: CONFIG.playback.maxSubstepsPerTick,
        entryTicks: CONFIG.playback.overloadEntryTicks,
        exitTicks: CONFIG.playback.overloadExitTicks,
      });
      scheduler.mode = overloadResult.mode;
      scheduler.overloadCount = overloadResult.overloadCount;
      // Side effects that depend on transitions
      if (prevMode !== 'overloaded' && scheduler.mode === 'overloaded') {
        scheduler.simBudgetMs = 0;
      }
      if (prevMode === 'overloaded' && scheduler.mode === 'recovering') {
        scheduler.recoveringStartMax = pb.maxSpeed; // capture for blend
        scheduler.recoveringBlendRemaining = 2;     // two update windows
      }

      // Effective speed (pure sliding-window computation)
      if (frameDtMs > 0) {
        const instantSpeed = (substepsThisFrame * 1000 / frameDtMs) / CONFIG.playback.baseStepsPerSecond;
        const speedResult = computeEffectiveSpeed(scheduler.effectiveSpeedWindow, instantSpeed, frameDtMs, 10);
        scheduler.effectiveSpeedWindow = speedResult.window;
        pb.effectiveSpeed = speedResult.effectiveSpeed;
      }

      // Max speed estimation (pure function in scheduler-pure.ts)
      const maxResult = updateMaxSpeedEstimate({
        now: performance.now(),
        mode: scheduler.mode as 'normal' | 'overloaded' | 'recovering',
        warmUpComplete: scheduler.warmUpComplete,
        maxSpeed: pb.maxSpeed,
        effectiveSpeed: pb.effectiveSpeed,
        lastMaxSpeedUpdateTs: scheduler.lastMaxSpeedUpdateTs,
        recoveringStartMax: scheduler.recoveringStartMax,
        recoveringBlendRemaining: scheduler.recoveringBlendRemaining,
        profilerAlpha: alpha,
        prof: scheduler.prof,
        config: CONFIG.playback,
      });
      if (maxResult) {
        pb.maxSpeed = maxResult.maxSpeed;
        scheduler.lastMaxSpeedUpdateTs = maxResult.lastMaxSpeedUpdateTs;
        scheduler.recoveringStartMax = maxResult.recoveringStartMax;
        scheduler.recoveringBlendRemaining = maxResult.recoveringBlendRemaining;
      }
    }

    // ── Stalled-worker detection (per-frame, not throttled) ──
    if (_workerRuntime) _workerRuntime.checkStalled(session.playback.paused);

    // Update positions + feedback (every tick)
    const updateStart = performance.now();
    if (_workerRuntime && _workerRuntime.isActive()) {
      // Worker mode: reconcile snapshot (position sync, remap, bond refresh)
      const snapshot = _workerRuntime.getLatestSnapshot();
      if (snapshot && snapshot.n > 0 && _snapshotReconciler) {
        _snapshotReconciler.apply(snapshot);
      }
    } else {
      // Sync mode: render from local physics
      // Sync renderer if atoms were removed by containment wall
      if (physics.n !== renderer.getAtomCount()) {
        renderer.setAtomCount(physics.n);
        // Force full visual sync after boundary removal: update bonds immediately
        // so atom and bond visuals are consistent even if rendering is delayed.
        physics.updateBondList();
        physics.rebuildComponents();
      }
      if (renderer.getAtomCount() > 0 && physics.n > 0) {
        renderer.updatePositions(physics);
      }
    }
    renderer.updateFeedback(stateMachine.getFeedbackState());
    const updateEnd = performance.now();
    scheduler.prof.updatePosMs += alpha * ((updateEnd - updateStart) - scheduler.prof.updatePosMs);

    // Render decision: budget-driven with hysteresis (pure function)
    const usedMs = (substepsThisFrame * scheduler.prof.physStepMs) + scheduler.prof.updatePosMs + scheduler.prof.otherMs;
    const canRender = !shouldSkipRender(usedMs, scheduler.prof.renderMs, scheduler.prof.rafIntervalMs);

    if (canRender) {
      scheduler.skipPressure = 0;
      scheduler.comfortTicks++;
      if (scheduler.comfortTicks > 10 && scheduler.renderSkipLevel > 1) {
        scheduler.renderSkipLevel--;
        scheduler.comfortTicks = 0;
      }
    } else {
      scheduler.comfortTicks = 0;
      scheduler.skipPressure++;
      if (scheduler.skipPressure > 5 && scheduler.renderSkipLevel < 4) {
        scheduler.renderSkipLevel++;
        scheduler.skipPressure = 0;
      }
    }

    scheduler.renderSkipCounter++;
    const wasForced = scheduler.forceRenderThisTick;
    scheduler.forceRenderThisTick = false; // always consumed
    const shouldRender = wasForced || scheduler.renderSkipCounter >= scheduler.renderSkipLevel;

    // Free-Look flight update (before render, after physics)
    if (useAppStore.getState().cameraMode === 'freelook' && _inputBindings) {
      const dtSec = frameDtMs / 1000;
      const axes = _inputBindings.getManager()?.getFlightInput();
      if (axes) renderer.updateFlight(dtSec, axes.x, axes.z);
      // Update flightActive store flag (transition-gated)
      const speed = renderer._flightVelocity.length();
      const maxSpd = renderer._sceneRadius * CONFIG.freeLook.maxSpeedScale;
      const showT = Math.min(Math.max(maxSpd * CONFIG.freeLook.freezeShowScale, CONFIG.freeLook.freezeShowMin), CONFIG.freeLook.freezeShowMax);
      const hideT = showT * CONFIG.freeLook.freezeHideRatio;
      const store = useAppStore.getState();
      if (!store.flightActive && speed > showT) useAppStore.getState().setFlightActive(true);
      else if (store.flightActive && speed < hideT) useAppStore.getState().setFlightActive(false);

      // Far-drift guardrail via shared resolveReturnTarget (transition-gated)
      const rt = resolveReturnTarget(renderer, renderer._sceneRadius);
      if (rt.guardrailEligible) {
        const distToTarget = renderer.camera.position.distanceTo(rt.position);
        const threshold = Math.min(Math.max(rt.radius * CONFIG.freeLook.farDriftTargetMult, CONFIG.freeLook.farDriftMinDistance), renderer._sceneRadius * CONFIG.freeLook.farDriftSceneMult);
        if (!store.farDrift && distToTarget > threshold) useAppStore.getState().setFarDrift(true);
        else if (store.farDrift && distToTarget < threshold * 0.8) useAppStore.getState().setFarDrift(false);
      } else if (store.farDrift) {
        useAppStore.getState().setFarDrift(false);
      }
    }

    if (shouldRender) {
      scheduler.renderSkipCounter = 0;
      const renderStart = performance.now();
      renderer.render();
      const renderEnd = performance.now();
      // Exclude forced renders from both renderMs EMA and cadence counter
      // so render-budget estimation (actualRendersPerSec * renderMs) stays coherent
      if (!wasForced) {
        scheduler.prof.renderMs += alpha * ((renderEnd - renderStart) - scheduler.prof.renderMs);
        scheduler.hasRenderSample = true;
        scheduler.renderCount++;
      }
      // Update actual render rate every ~1s from real counter
      const renderElapsed = performance.now() - scheduler.lastRenderCountTs;
      if (renderElapsed > 1000) {
        scheduler.prof.actualRendersPerSec = scheduler.renderCount * 1000 / renderElapsed;
        scheduler.renderCount = 0;
        scheduler.lastRenderCountTs = performance.now();
      }
    }

    // Other overhead
    const tickEnd = performance.now();
    scheduler.prof.otherMs += alpha * (Math.max(0, (tickEnd - tickStart) - (substepsThisFrame * scheduler.prof.physStepMs) - scheduler.prof.updatePosMs - (shouldRender ? scheduler.prof.renderMs : 0)) - scheduler.prof.otherMs);

    // Update status display — throttled to statusUpdateHz (default 5 Hz)
    const statusIntervalMs = 1000 / CONFIG.playback.statusUpdateHz;
    const statusNow = performance.now();
    if (wasForced || (statusNow - scheduler.lastStatusUpdateTs) >= statusIntervalMs) {
      scheduler.lastStatusUpdateTs = statusNow;
      const pb = session.playback;
      const isIdle = pb.paused || (placement && placement.active) || physics.n === 0;
      const displaySpeed = isIdle ? 0 : pb.effectiveSpeed;
      const fps = Math.round(1000 / scheduler.prof.rafIntervalMs);
      const isPlacementActive = !!(placement && placement.active);
      const isPlacementStale = isPlacementActive && _workerRuntime != null && _workerRuntime.isActive() && _workerRuntime.getSnapshotAge() > 500;
      const isOverloaded = scheduler.mode === 'overloaded' || pb.maxSpeed < CONFIG.playback.minSpeed;

      // Feed Zustand store — coalesced at 5 Hz; React FPSDisplay renders via formatStatusText()
      // placementActive and paused are event-driven, not throttled here
      useAppStore.getState().updatePlaybackMetrics({
        maxSpeed: pb.maxSpeed,
        effectiveSpeed: displaySpeed,
        fps,
        placementStale: isPlacementStale,
        warmUpComplete: scheduler.warmUpComplete,
        overloaded: isOverloaded,
        workerStalled: _workerRuntime ? _workerRuntime.isStalled() : false,
        rafIntervalMs: scheduler.prof.rafIntervalMs,
      });

    // ── Auto FPS gate for UI effects ──
    // Only runs when glass UI is visible AND mode is 'auto' (not forced by developer).
    const frameMs = scheduler.prof.rafIntervalMs;
    const glassVisible = _overlayLayout ? _overlayLayout.isGlassActive() : false;
    if (glassVisible && effectsGate.mode === 'auto' && !effectsGate.reduced) {
      if (frameMs > effectsGate.SLOW_THRESHOLD) {
        effectsGate.slowCount++;
        effectsGate.fastCount = 0;
        if (effectsGate.slowCount >= effectsGate.ENTER_COUNT) {
          effectsGate.reduced = true;
          document.documentElement.dataset.uiEffects = 'reduced';
        }
      } else {
        effectsGate.slowCount = 0;
      }
    } else if (glassVisible && effectsGate.mode === 'auto') {
      if (frameMs < effectsGate.FAST_THRESHOLD) {
        effectsGate.fastCount++;
        if (effectsGate.fastCount >= effectsGate.EXIT_COUNT) {
          effectsGate.reduced = false;
          delete document.documentElement.dataset.uiEffects;
          effectsGate.slowCount = 0;
        }
      } else {
        effectsGate.fastCount = 0;
      }
    }

      // Update Active row in settings sheet (live boundary removal tracking)
      _scene!.updateActiveCountRow();
    }

  } catch (e) {
    console.error('[frameLoop] ERROR:', e);
  }
  if (_appRunning) _rafId = requestAnimationFrame(frameLoop);
}

// --- Start ---
init();
