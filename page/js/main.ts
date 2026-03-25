/**
 * NanoToybox Interactive Page — Entry Point
 *
 * Multi-molecule playground with placement mode.
 * Wires together: loader, physics, state machine, input, renderer, FPS monitor.
 */
import { loadManifest, loadStructure } from './loader';
import { PhysicsEngine } from './physics';
import { StateMachine, State, type Command } from './state-machine';
import { InputManager } from './input';
import { Renderer } from './renderer';
import { THEMES, applyThemeTokens, applyTextSizeTokens } from './themes';
import { CONFIG } from './config';
import { commitMolecule, clearPlayground, addMoleculeToScene } from './scene';
import { OverlayController } from './ui/overlay';
import { DockController } from './ui/dock';
import { SettingsSheetController } from './ui/settings-sheet';
import { handleCommand as dispatchInteraction } from './interaction';
import { StatusController } from './status';
import { PlacementController } from './placement';
import { COACHMARKS } from './ui/coachmarks';
import { computeTargetSpeed, computeSubstepCount, updateOverloadState, computeEffectiveSpeed, shouldSkipRender } from './scheduler-pure';
import { WorkerBridge } from './worker-bridge';
import type { PhysicsConfig } from '../../src/types/worker-protocol';
import { mountReactUI, unmountReactUI } from './react-root';
import { useAppStore } from './store/app-store';

const DEBUG_LOAD = CONFIG.debug.load;

// --- Globals ---
let renderer, physics, stateMachine, inputManager;
let manifest: Record<string, { file: string; description: string; n_atoms: number }> | null = null;
let overlay = null;
let dock = null;
let settingsSheet = null;
let statusCtrl = null;
let placement = null;

// ── Worker bridge (Milestone C.2) ──
// Set useWorker = false to disable the worker path for debugging.
const useWorker = true;
let workerBridge: WorkerBridge | null = null;
let workerInitialized = false;
let workerProgressTs = 0;   // last time the worker showed signs of life (init ack, frame, etc.)
let workerStalled = false;   // latched stalled flag — checked by status renderer
let _testFreezeProgress = false; // test-only: prevents frameResult from resetting workerProgressTs
let _testStalledThresholdMs = 0; // test-only: overrides the 5s stalled threshold (0 = use default)
let _workerBondRefreshCounter = 0; // frame counter for periodic bond refresh in worker mode

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

// Glass UI visibility — true once dock is initialized (dock is always visible with glass surface).
// Decoupled from DockController: React Dock is always visible after mount.
let _glassUiActive = false;
function isGlassUiVisible() { return _glassUiActive; }

// Global listener registry for teardown
const _globalListeners = [];
let _rafId = null;
let _appRunning = false;
let _dockResizeObserver = null;
let _layoutPending = false;
let _layoutRafId = null;

/** Register a global listener and track it for teardown. Options forwarded to both add/remove. */
function addGlobalListener(target: EventTarget, event: string, handler: EventListener, options?: boolean | AddEventListenerOptions) {
  target.addEventListener(event, handler, options);
  _globalListeners.push([event, handler, target, options]);
}

/**
 * Compute and apply overlay layout (hint clearance + triad sizing/position).
 * v1: dock-only — reads dock geometry directly. If a second persistent bottom
 * surface is added, formalize a registry ({ id, getTopEdge(), isActive() }).
 */
function _doOverlayLayout() {
  _layoutRafId = null;
  _layoutPending = false;
  if (!dock || !renderer) return;
  // Find the visible dock (React or imperative)
  const dockEl = (document.querySelector('.dock:not(.react-replaced)') || document.getElementById('dock')) as HTMLElement;
  if (!dockEl) return;
  const dockRect = dockEl.getBoundingClientRect();
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const dockTopFromBottom = viewportH - dockRect.top;
  const mode = document.documentElement.dataset.deviceMode;

  // Hint clearance — always dock-relative (hint is centered like dock)
  const hintGap = 12;
  document.documentElement.style.setProperty(
    '--hint-bottom', (dockTopFromBottom + hintGap) + 'px'
  );

  // Triad sizing — larger on tablet/desktop
  let triadSize;
  if (mode === 'phone') {
    triadSize = Math.min(140, Math.max(80, Math.floor(viewportW * 0.12)));
  } else {
    triadSize = Math.min(200, Math.max(120, Math.floor(viewportW * 0.10)));
  }

  // Triad positioning — phone: clear full-width dock; tablet/desktop: safe-area corner
  let triadBottom;
  if (mode === 'phone') {
    triadBottom = dockTopFromBottom + 8;
  } else {
    triadBottom = 12;
  }

  // Triad left offset — safe-area inset + margin
  const safeLeft = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-left')) || 0;
  const triadLeft = safeLeft + 6;

  renderer.setOverlayLayout({ triadSize, triadLeft, triadBottom });
}

/** Request a layout update. Coalesces multiple calls into one RAF. */
function _requestOverlayLayout() {
  if (_layoutPending) return;
  _layoutPending = true;
  _layoutRafId = requestAnimationFrame(_doOverlayLayout);
}

/** Tear down all controllers, subsystems, and global listeners. Resets runtime state. */
function destroyApp() {
  // Unmount React UI (Milestone D)
  unmountReactUI();
  // Stop frame loop
  _appRunning = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  // Remove global listeners
  for (const [event, handler, target, options] of _globalListeners) {
    target.removeEventListener(event, handler, options);
  }
  _globalListeners.length = 0;
  // Clear chooser list (removes owned-node listeners via DOM removal)
  const chooserList = document.getElementById('structure-list');
  if (chooserList) chooserList.innerHTML = '';
  // Clean up debug hooks
  delete window._setUiEffectsMode;
  // Disconnect dock ResizeObserver and cancel pending layout RAF
  if (_dockResizeObserver) { _dockResizeObserver.disconnect(); _dockResizeObserver = null; }
  if (_layoutRafId) { cancelAnimationFrame(_layoutRafId); _layoutRafId = null; }
  _layoutPending = false;
  // Tear down controllers
  if (placement) placement.destroy();
  if (statusCtrl) statusCtrl.destroy();
  if (overlay) overlay.destroy();
  if (dock) dock.destroy();
  if (settingsSheet) settingsSheet.destroy();
  // Tear down subsystems
  if (inputManager) inputManager.destroy();
  if (renderer) renderer.destroy();
  // Tear down worker bridge (Milestone C.2)
  _teardownWorker();
  // Null destroyed refs to prevent accidental reuse
  placement = null;
  statusCtrl = null;
  overlay = null;
  dock = null;
  settingsSheet = null;
  inputManager = null;
  renderer = null;
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

  // Status controller
  statusCtrl = new StatusController({
    statusEl: document.getElementById('status'),
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
    if (prev && prev !== mode && overlay) { _closeOverlay(); }
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

  // Load manifest
  try {
    manifest = await loadManifest();

    // Auto-load C60 as first molecule
    const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);
    if (entries.length > 0) {
      const c60 = entries.find(([k]) => k === 'c60');
      const [key, info] = c60 || entries[0];
      await _addMoleculeToScene(info.file, info.description, [0, 0, 0]);
    }
  } catch (e) {
    updateStatus('Failed to load structures. Serve from repo root.');
    console.error(e);
    destroyApp();
    return;
  }

  // ═══════════════════════════════════════════════════════
  // Worker bridge (Milestone C.2) — create alongside physics
  // ═══════════════════════════════════════════════════════
  if (useWorker) {
    try {
      workerBridge = new WorkerBridge();

      // Debug + test hooks — registered unconditionally at bridge creation (before init)
      (window as unknown as Record<string, unknown>)._getWorkerDebugState = () => ({
        workerActive: !!(workerBridge && workerInitialized),
        workerState: workerBridge ? workerBridge.getWorkerState() : null,
        workerStalled,
        outstandingRequests: workerBridge ? workerBridge.getOutstandingRequestCount() : -1,
        physStepMs: scheduler.prof.physStepMs,
        totalStepsProfiled: scheduler.totalStepsProfiled,
        hasSnapshot: workerBridge ? workerBridge.getLatestSnapshot() !== null : false,
        roundTripMs: workerBridge ? workerBridge.getRoundTripMs() : -1,
        snapshotAgeMs: workerBridge ? workerBridge.getSnapshotAge() : -1,
        timeSinceProgress: workerProgressTs > 0 ? performance.now() - workerProgressTs : -1,
      });
      (window as unknown as Record<string, unknown>)._simulateWorkerStall = () => {
        _testFreezeProgress = true;
        workerProgressTs = performance.now();
      };
      (window as unknown as Record<string, unknown>)._setTestStalledThreshold = (ms: number) => {
        _testStalledThresholdMs = ms;
      };

      workerBridge.setOnFrameResult((snapshot) => {
        // Worker showed progress — update stalled tracking
        if (!_testFreezeProgress) {
          workerProgressTs = performance.now();
          if (workerStalled) workerStalled = false;
        }

        // Position sync to physics.pos is handled canonically by
        // updateFromSnapshot → _physicsRef.pos.set() in the frame loop.
        // physics.n is updated there too (on atom count change).
        // No duplicate write here — single ownership in the frame loop.

        // Feed worker timing into scheduler (replaces local profiler in worker mode)
        if (snapshot.stepsCompleted > 0) {
          const alpha = CONFIG.playback.profilerAlpha;
          const msPerStep = snapshot.physStepMs / snapshot.stepsCompleted;
          scheduler.prof.physStepMs += alpha * (msPerStep - scheduler.prof.physStepMs);
          scheduler.totalStepsProfiled += snapshot.stepsCompleted;
        }
      });
      workerBridge.setOnFrameSkipped((info) => {
        if (!_testFreezeProgress) workerProgressTs = performance.now();
        // No snapshot update, but feed timing into scheduler (same as frameResult
        // except without touching render state). This keeps overload/backpressure
        // estimates aligned with worker reality during skipped periods.
        if (info.stepsCompleted > 0) {
          const alpha = CONFIG.playback.profilerAlpha;
          const msPerStep = info.physStepMs / info.stepsCompleted;
          scheduler.prof.physStepMs += alpha * (msPerStep - scheduler.prof.physStepMs);
          scheduler.totalStepsProfiled += info.stepsCompleted;
        }
      });
      workerBridge.setOnCrash((reason) => {
        _handleWorkerFailure(reason);
      });

      // Initialize worker with current scene state (matches first molecule load above)
      if (physics.n > 0) {
        const allAtoms = _collectSceneAtoms();
        const allBonds = _collectSceneBonds();
        const config = _buildWorkerConfig();
        // Start the progress clock NOW so the stalled watchdog covers init hangs
        workerProgressTs = performance.now();
        workerBridge.init(config, allAtoms, allBonds).then((result) => {
          if (result.ok) {
            workerInitialized = true;
            workerProgressTs = performance.now();
            workerStalled = false;
            if (CONFIG.debug.load) console.log('[worker] initialized:', result.kernel, result.atomCount, 'atoms');
            // (debug + test hooks registered unconditionally at bridge creation)
          } else {
            console.warn('[worker] init failed:', result.error);
            _teardownWorker();
          }
        }).catch((e) => {
          console.warn('[worker] init error:', e);
          _teardownWorker();
        });
      }
    } catch (e) {
      console.warn('[worker] failed to create WorkerBridge, falling back to sync physics:', e);
      _teardownWorker();
    }
  }

  // ═══════════════════════════════════════════════════════
  // UI controller wiring
  // ═══════════════════════════════════════════════════════

  // ── Overlay controller ──
  overlay = new OverlayController({
    settingsSheet: document.getElementById('settings-sheet'),
    chooserSheet: document.getElementById('chooser-sheet'),
    backdrop: document.getElementById('sheet-backdrop'),
    sheetMain: document.getElementById('sheet-main'),
    sheetHelp: document.getElementById('sheet-help'),
  });

  // Populate structure chooser now that overlay is defined
  populateStructureDrawer(manifest);

  // Escape key: close overlay or cancel placement
  function _onKeydown(e) {
    if (e.key === 'Escape') {
      if (placement.active) {
        placement.exit(false);
        e.preventDefault();
      } else if (placement.loading) {
        placement.invalidatePendingLoads();
        updateSceneStatus();
        e.preventDefault();
      } else if (overlay.current !== 'none') {
        _closeOverlay();
        e.preventDefault();
      }
    }
    if (e.key === 'Enter' && placement.active) {
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
    if (overlay.current === 'none') return;

    // Only primary pointer — reject second touch in multi-touch, and
    // non-left mouse buttons (right-click, middle, stylus barrel).
    if (!pe.isPrimary) return;
    if (pe.pointerType === 'mouse' && pe.button !== 0) return;

    // Clicks inside any sheet never dismiss (ownership boundary).
    // Query visible sheets (React or imperative fallback).
    const sheets = document.querySelectorAll('.sheet:not(.react-replaced)');
    for (const sheet of sheets) {
      if (sheet.contains(target)) return;
    }

    // Clicks inside the dock never dismiss (visible React dock or fallback imperative).
    const dockEl = document.querySelector('.dock:not(.react-replaced)') || document.getElementById('dock');
    if (dockEl && dockEl.contains(target)) return;

    // Only backdrop and renderer canvas dismiss.
    const backdrop = document.querySelector('.sheet-backdrop:not(.react-replaced)') || document.getElementById('sheet-backdrop');
    const canvas = renderer ? renderer.getCanvas() : null;
    const isBackdrop = backdrop && (target === backdrop || backdrop.contains(target));
    const isCanvas = canvas && (target === canvas || canvas.contains(target));
    if (!isBackdrop && !isCanvas) return;

    // Close + consume so no interaction starts from the same event.
    _closeOverlay();
    e.stopPropagation();
    e.preventDefault();
  }, true);

  // ── Dock controller ──
  const dockAddBtn = document.getElementById('dock-add');
  dock = new DockController({
    dockEl: document.getElementById('dock'),
    addBtn: dockAddBtn,
    addIcon: dockAddBtn.querySelector('.dock-icon'),
    addLabel: document.getElementById('dock-add-label'),
    modeSeg: document.getElementById('mode-seg'),
    pauseBtn: document.getElementById('dock-pause'),
    settingsBtn: document.getElementById('dock-settings'),
    cancelBtn: document.getElementById('dock-cancel'),
  });


  // Wire dock action callbacks (intents → main.js applies state)
  dock.onAdd(() => {
    if (placement.active) {
      placement.exit(true);
      return;
    }
    _updateChooserRecentRow();
    _openOverlay('chooser');
  });
  dock.onModeChange((mode) => {
    session.interactionMode = mode;
    if (mode) useAppStore.getState().setInteractionMode(mode as 'atom' | 'move' | 'rotate');
  });
  dock.onPause(() => {
    if (placement.active) return;
    session.playback.paused = !session.playback.paused;
    dock.setPauseLabel(session.playback.paused);
    // Set store to match imperative state (not togglePause — that would double-toggle)
    if (useAppStore.getState().paused !== session.playback.paused) {
      useAppStore.getState().togglePause();
    }
    if (!session.playback.paused) {
      scheduler.lastFrameTs = performance.now();
      scheduler.simBudgetMs = 0;
    }
    scheduler.forceRenderThisTick = true;
  });
  dock.onSettings(() => {
    if (placement.active) return;
    _openOverlay('settings');
  });
  dock.onCancel(() => placement.exit(false));

  // ── Settings sheet controller ──
  settingsSheet = new SettingsSheetController({
    speedSeg: document.getElementById('speed-seg'),
    themeSeg: document.getElementById('theme-seg'),
    boundarySeg: document.getElementById('boundary-seg'),
    textSizeSeg: document.getElementById('text-size-seg'),
    dragSlider: document.getElementById('drag-strength'),
    dragVal: document.getElementById('drag-val'),
    rotateSlider: document.getElementById('rotate-strength'),
    rotateVal: document.getElementById('rotate-val'),
    dampingSlider: document.getElementById('damping-slider'),
    dampingVal: document.getElementById('damping-val'),
    placedCountEl: document.getElementById('sheet-placed-count'),
    activeRowEl: document.getElementById('sheet-active-row'),
    activeCountEl: document.getElementById('sheet-active-count'),
    addMoleculeBtn: document.getElementById('sheet-add-molecule'),
    clearBtn: document.getElementById('sheet-clear'),
    resetViewBtn: document.getElementById('sheet-reset-view'),
    helpLink: document.getElementById('sheet-help-link'),
    helpBackBtn: document.getElementById('help-back'),
  });

  // Wire settings sheet callbacks (intents → main.js applies state)
  settingsSheet.onSpeedChange((val) => {
    if (val === 'max') {
      session.playback.speedMode = 'max';
    } else {
      session.playback.speedMode = 'fixed';
      session.playback.selectedSpeed = parseFloat(val);
    }
    scheduler.forceRenderThisTick = true;
    settingsSheet.updateSpeedButtons(session.playback.maxSpeed, scheduler.warmUpComplete);
    // Mirror user intent to Zustand store (Milestone D)
    // Store the user's selection (0.5, 1, 2, 4, or Infinity for Max),
    // NOT the runtime maxSpeed estimate.
    useAppStore.getState().setTargetSpeed(val === 'max' ? Infinity : parseFloat(val));
  });
  settingsSheet.onThemeChange((theme) => {
    session.theme = theme;
    renderer.applyTheme(session.theme);
    applyThemeTokens(session.theme);
    useAppStore.getState().setTheme(theme);
  });
  settingsSheet.onBoundaryChange((mode) => {
    physics.setWallMode(mode);
    if (workerBridge && workerInitialized) {
      workerBridge.sendInteraction({ type: 'setWallMode', mode });
    }
  });
  settingsSheet.onDragChange((v) => {
    physics.setDragStrength(v);
    if (workerBridge && workerInitialized) {
      workerBridge.sendInteraction({ type: 'setDragStrength', value: v });
    }
  });
  settingsSheet.onRotateChange((v) => {
    physics.setRotateStrength(v);
    if (workerBridge && workerInitialized) {
      workerBridge.sendInteraction({ type: 'setRotateStrength', value: v });
    }
  });
  settingsSheet.onDampingChange((d) => {
    physics.setDamping(d);
    if (workerBridge && workerInitialized) {
      workerBridge.sendInteraction({ type: 'setDamping', value: d });
    }
  });
  settingsSheet.onTextSizeChange((size) => {
    session.textSize = size;
    applyTextSizeTokens(size);
    useAppStore.getState().setTextSize(size);
  });
  settingsSheet.onAddMolecule(() => { _updateChooserRecentRow(); _openOverlay('chooser'); });
  settingsSheet.onClear(() => { _closeOverlay(); _clearPlayground(); });
  settingsSheet.onResetView(() => { renderer.resetView(); });
  settingsSheet.onHelpOpen(() => { overlay.showHelpPage(); });
  settingsSheet.onHelpBack(() => { overlay.showMainPage(); });

  // Initial speed button state + text-size selection
  settingsSheet.updateSpeedButtons(session.playback.maxSpeed, scheduler.warmUpComplete);
  settingsSheet.setTextSizeSelection(session.textSize);

  // ── Placement controller ──
  placement = new PlacementController({
    renderer, physics, stateMachine, inputManager, loadStructure,
    commands: {
      setDockPlacementMode: (active) => setDockPlacementMode(active),
      commitToScene: (file, name, atoms, bonds, offset) => _commitMolecule(file, name, atoms, bonds, offset),
      updateStatus,
      updateSceneStatus,
      updateDockAddLabel,
      forceIdle: () => dispatchToInteraction(stateMachine.forceIdle()),
      syncInput: syncInputManager,
      forceRender: () => { scheduler.forceRenderThisTick = true; },
      buildAtomSource,
      getSceneMolecules: () => session.scene.molecules,
      isSnapshotFresh: () => !(workerBridge && workerInitialized) || workerBridge.getSnapshotAge() < 500,
    },
  });

  // ── Overlay layout: hint clearance + triad sizing/positioning ──
  // Initial synchronous pass for first-paint correctness (dock/renderer exist).
  _doOverlayLayout();
  addGlobalListener(window, 'resize', _requestOverlayLayout);
  _dockResizeObserver = new ResizeObserver(() => _requestOverlayLayout());
  _dockResizeObserver.observe(document.getElementById('dock'));

  // Mobile tap-to-expand for FPS area is now handled by React FPSDisplay component.

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

  // Mount React UI (Milestone D)
  mountReactUI();

  // Narrow test hook — returns only the specific observable E2E tests need.
  // Follows the same unconditional pattern as _getWorkerDebugState above.
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

  // Hide imperative elements now replaced by React-authoritative components
  document.getElementById('info')?.classList.add('react-replaced');
  document.getElementById('fps')?.classList.add('react-replaced');
  document.getElementById('dock')?.classList.add('react-replaced');

  // Re-wire ResizeObserver to the visible React dock (imperative dock is now hidden)
  if (_dockResizeObserver) {
    _dockResizeObserver.disconnect();
    const reactDock = document.querySelector('.dock:not(.react-replaced)') as HTMLElement;
    if (reactDock) _dockResizeObserver.observe(reactDock);
  }
  // Layout recalculation is handled by the ResizeObserver on the React dock.
  // It fires once the dock has its final layout dimensions.
  _glassUiActive = true; // React dock is now visible with glass surface

  // Register synchronized close gateway — React components use this instead of closeSheet
  useAppStore.getState().setCloseOverlay(() => _closeOverlay());

  // Register dock callbacks — React Dock reads these from the store
  useAppStore.getState().setDockCallbacks({
    onAdd: () => {
      if (placement.active) { placement.exit(true); return; }
      _updateChooserRecentRow();
      _openOverlay('chooser');
    },
    onPause: () => {
      if (placement.active) return;
      session.playback.paused = !session.playback.paused;
      if (useAppStore.getState().paused !== session.playback.paused) {
        useAppStore.getState().togglePause();
      }
      if (!session.playback.paused) {
        scheduler.lastFrameTs = performance.now();
        scheduler.simBudgetMs = 0;
      }
      scheduler.forceRenderThisTick = true;
    },
    onSettings: () => {
      if (placement.active) return;
      _openOverlay('settings');
    },
    onCancel: () => placement.exit(false),
    onModeChange: (mode: string) => {
      session.interactionMode = mode;
      if (mode) useAppStore.getState().setInteractionMode(mode as 'atom' | 'move' | 'rotate');
    },
  });

  // Register settings callbacks — React SettingsSheet reads these from the store
  useAppStore.getState().setSettingsCallbacks({
    onSpeedChange: (val: string) => {
      if (val === 'max') {
        session.playback.speedMode = 'max';
      } else {
        session.playback.speedMode = 'fixed';
        session.playback.selectedSpeed = parseFloat(val);
      }
      useAppStore.getState().setTargetSpeed(val === 'max' ? Infinity : parseFloat(val));
    },
    onThemeChange: (theme: string) => {
      session.theme = theme;
      renderer.applyTheme(session.theme);
      applyThemeTokens(session.theme);
      useAppStore.getState().setTheme(theme as 'dark' | 'light');
    },
    onBoundaryChange: (mode: string) => {
      physics.setWallMode(mode);
      useAppStore.getState().setBoundaryMode(mode as 'contain' | 'remove');
      if (workerBridge && workerInitialized) {
        workerBridge.sendInteraction({ type: 'setWallMode', mode: mode as 'contain' | 'remove' });
      }
    },
    onDragChange: (v: number) => {
      physics.setDragStrength(v);
      useAppStore.getState().setDragStrength(v);
      if (workerBridge && workerInitialized) {
        workerBridge.sendInteraction({ type: 'setDragStrength', value: v });
      }
    },
    onRotateChange: (v: number) => {
      physics.setRotateStrength(v);
      useAppStore.getState().setRotateStrength(v);
      if (workerBridge && workerInitialized) {
        workerBridge.sendInteraction({ type: 'setRotateStrength', value: v });
      }
    },
    onDampingChange: (d: number) => {
      physics.setDamping(d);
      // Store the slider position (0-100), not the computed damping
      // Reverse: d = 0.5 * t^3, t = (2d)^(1/3), slider = t * 100
      const sliderVal = d === 0 ? 0 : Math.round(Math.cbrt(2 * d) * 100);
      useAppStore.getState().setDampingSliderValue(sliderVal);
      if (workerBridge && workerInitialized) {
        workerBridge.sendInteraction({ type: 'setDamping', value: d });
      }
    },
    onTextSizeChange: (size: string) => {
      session.textSize = size;
      applyTextSizeTokens(size);
      useAppStore.getState().setTextSize(size as 'normal' | 'large');
    },
    onAddMolecule: () => {
      _updateChooserRecentRow();
      _openOverlay('chooser');
    },
    onClear: () => {
      _closeOverlay();
      _clearPlayground();
    },
    onResetView: () => { renderer.resetView(); },
  });

  // Register chooser callbacks — React StructureChooser reads these from the store
  useAppStore.getState().setChooserCallbacks({
    onSelectStructure: (file: string, description: string) => {
      // Record selection before placement.start() — observable by tests without WebGL
      useAppStore.getState().setRecentStructure({ file, name: description });
      placement.start(file, description);
    },
  });

  // Hide imperative sheet elements now replaced by React-authoritative components
  document.getElementById('sheet-backdrop')?.classList.add('react-replaced');
  document.getElementById('settings-sheet')?.classList.add('react-replaced');
  document.getElementById('chooser-sheet')?.classList.add('react-replaced');
}

/** Single entry point for all overlay openings — clears transient state first.
 *  Currently dismisses placement coachmark only. When dock Clear lands,
 *  add dock.disarmClear() here. */
/** Synchronized close — single gateway for all overlay close paths.
 *  Always updates both store and imperative overlay. */
function _closeOverlay() {
  const store = useAppStore.getState();
  // Reset help drill-in when closing settings (avoids stale helpPageActive in store)
  if (store.activeSheet === 'settings' && store.helpPageActive) {
    store.setHelpPageActive(false);
  }
  store.closeSheet();
  overlay.close();
}

function _openOverlay(name: 'settings' | 'chooser') {
  // Dismiss (not restore) — don't show generic hint underneath a sheet
  if (statusCtrl) statusCtrl.dismissCoachmark('placement');

  // Toggle behavior: same sheet → close, different sheet → switch
  const store = useAppStore.getState();
  if (store.activeSheet === name) {
    _closeOverlay();
  } else {
    // Reset help drill-in when opening settings
    if (name === 'settings') store.setHelpPageActive(false);
    store.openSheet(name);
    // Keep imperative overlay in sync
    overlay.open(name);
  }
}

// --- Structure drawer ---
function populateStructureDrawer(manifest: Record<string, { file: string; description: string; n_atoms: number }>) {
  const list = document.getElementById('structure-list');
  const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);
  // Feed Zustand store with available structures from manifest
  useAppStore.getState().setAvailableStructures(entries.map(([key, info]) => ({
    key, description: info.description, atomCount: info.n_atoms, file: info.file,
  })));

  for (const [key, info] of entries) {
    const item = document.createElement('div');
    item.className = 'drawer-item';
    item.textContent = `${info.description} (${info.n_atoms} atoms)`;
    // Listener on owned DOM node — GC'd when list is cleared. Not in _globalListeners.
    item.addEventListener('click', () => {
      _closeOverlay();
      placement.start(info.file, info.description);
    });
    list.appendChild(item);
  }
}

// --- Scene management ---

// ── Dock helpers (delegate to dock controller) ──
function setDockPlacementMode(active) {
  // Immediately update store — React Dock reads this for Add/Place/Cancel swap
  useAppStore.getState().setPlacementActive(active);

  // Legacy imperative dock (hidden, will be removed when DockController is deleted)
  if (dock) dock.setPlacementMode(active);

  // Coachmark policy: main.js owns the hint lifecycle, not placement.js
  if (active) {
    if (statusCtrl) statusCtrl.showCoachmark(COACHMARKS.placement);
  } else {
    if (statusCtrl) statusCtrl.hideCoachmark('placement');
    updateDockAddLabel();
  }
}

function updateDockAddLabel() {
  if (!dock) return;
  dock.updateAddLabel();
}

/** Update the recent structure in the store for the React chooser. */
function _updateChooserRecentRow() {
  if (placement && placement.hasLastStructure()) {
    useAppStore.getState().setRecentStructure({
      file: placement.getLastStructureFile(),
      name: placement.getLastStructureName(),
    });
  } else {
    useAppStore.getState().setRecentStructure(null);
  }
}


function updateSceneStatus() {
  if (statusCtrl) statusCtrl.updateSceneStatus(session.scene.molecules.length, session.scene.totalAtoms);
  updatePlacedCount();
  updateActiveCountRow();
  // Feed Zustand store (Milestone D)
  const store = useAppStore.getState();
  store.updateAtomCount(session.scene.totalAtoms);
  store.setMolecules(session.scene.molecules.map(m => ({
    id: m.id,
    name: m.name,
    structureFile: m.structureFile,
    atomCount: m.atomCount,
    atomOffset: m.atomOffset,
  })));
}

// Placed/Active count helpers — delegate to settingsSheet controller
function updatePlacedCount() {
  if (settingsSheet) settingsSheet.updatePlacedCount(session.scene.totalAtoms);
}

function updateActiveCountRow() {
  let active: number, removed: number;
  if (workerBridge && workerInitialized) {
    // Worker mode: derive from snapshot atom count vs total placed.
    // Local physics._wallRemovedCount is always 0 in worker mode (never steps locally).
    active = physics.n;
    removed = Math.max(0, session.scene.totalAtoms - active);
  } else {
    // Sync mode: local physics tracks removal directly.
    active = physics.getActiveAtomCount();
    removed = physics.getWallRemovedCount();
  }
  if (settingsSheet) settingsSheet.updateActiveCount(active, removed);
  useAppStore.getState().updateActiveCount(active, removed);
}

// ── Scene wrappers (delegate to scene.js with dependencies) ──
function _commitMolecule(filename, name, atoms, bonds, offset) {
  commitMolecule(physics, renderer, filename, name, atoms, bonds, offset, session.scene, {
    syncInput: syncInputManager,
    resetProfiler: partialProfilerReset,
    fitCamera: () => renderer.fitCamera(),
    updateSceneStatus,
  });
  // Keep renderer's physics reference current (bonds available for worker-mode rendering)
  renderer.setPhysicsRef(physics);

  // C.2: mirror molecule append to worker + sync wall state
  if (workerBridge && workerInitialized) {
    workerBridge.appendMolecule(atoms, bonds, offset as [number, number, number]).then((result) => {
      if (!result.ok) {
        console.warn('[worker] appendMolecule failed:', result);
        return;
      }
      // Sync wall center + radius to worker after append (worker needs these for contain/remove)
      workerBridge.sendInteraction({
        type: 'updateWallCenter',
        atoms: atoms.map(a => ({ x: a.x, y: a.y, z: a.z })),
        offset: offset as [number, number, number],
      });
    }).catch((e) => {
      console.warn('[worker] appendMolecule error:', e);
      _teardownWorker();
    });
  }
}

function _clearPlayground() {
  clearPlayground(physics, renderer, stateMachine, session.scene, {
    invalidatePlacement: () => placement.invalidatePendingLoads(),
    exitPlacement: () => placement.exit(false),
    forceIdle: () => dispatchToInteraction(stateMachine.forceIdle()),
    syncInput: syncInputManager,
    resetScheduler: fullSchedulerReset,
    updateSceneStatus,
    updateDockLabel: updateDockAddLabel,
  });

  // Reset diagnostics in store (ke, wallRadius, etc. are stale after clear)
  useAppStore.getState().resetDiagnostics();
  _workerBondRefreshCounter = 0;

  // C.2: mirror scene clear to worker and bump generation
  if (workerBridge && workerInitialized) {
    workerBridge.bumpGeneration();
    workerBridge.clearScene().then((result) => {
      if (!result.ok) {
        console.warn('[worker] clearScene failed:', result);
      }
    }).catch((e) => {
      console.warn('[worker] clearScene error:', e);
      _teardownWorker();
    });
  }
}

async function _addMoleculeToScene(filename, name, offset) {
  await addMoleculeToScene(filename, name, offset, {
    loadStructure, physics, renderer,
    sceneState: session.scene,
    commitCallbacks: {
      syncInput: syncInputManager,
      resetProfiler: partialProfilerReset,
      fitCamera: () => renderer.fitCamera(),
      updateSceneStatus,
    },
    updateStatus,
    setLoading: (v) => { session.isLoading = v; },
  });
}

// --- Input manager ---
function syncInputManager() {
  if (!inputManager) createInputManager();
  inputManager.updateAtomSource(buildAtomSource());
}

function updateStatus(text) {
  if (statusCtrl) statusCtrl.update(text);
}

function buildAtomSource() {
  return {
    get count() { return renderer.getAtomCount(); },
    getWorldPosition(i, out) { return renderer.getAtomWorldPosition(i, out); },
    get raycastTarget() { return renderer.instancedAtoms; },
  };
}

// ── Worker bridge helpers (Milestone C.2) ──

/** Build PhysicsConfig from current physics engine state + CONFIG. */
function _buildWorkerConfig(): PhysicsConfig {
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

/** Collect all atoms from the current scene molecules (with offsets applied). */
function _collectSceneAtoms(): import('../../src/types/domain').AtomXYZ[] {
  const atoms: import('../../src/types/domain').AtomXYZ[] = [];
  for (const mol of session.scene.molecules) {
    atoms.push(...mol.localAtoms);
  }
  return atoms;
}

/** Collect all bonds from the current scene molecules. */
function _collectSceneBonds(): import('../../src/types/interfaces').BondTuple[] {
  const bonds: import('../../src/types/interfaces').BondTuple[] = [];
  let atomOffset = 0;
  for (const mol of session.scene.molecules) {
    for (const b of mol.localBonds) {
      bonds.push([b[0] + atomOffset, b[1] + atomOffset, b[2]]);
    }
    atomOffset += mol.atomCount;
  }
  return bonds;
}

/** Tear down the worker bridge gracefully — fall back to sync physics. */
function _teardownWorker() {
  if (workerBridge) {
    try { workerBridge.destroy(); } catch (_) { /* ignore */ }
  }
  workerBridge = null;
  workerInitialized = false;
  workerStalled = false;
  workerProgressTs = 0;
}

/** Handle worker failure — tear down and rebuild local physics for sync resumption.
 *
 * Local physics has positions synced from the worker (via onFrameResult), but
 * velocities are stale (from before worker took over). To resume coherently:
 * 1. Zero all velocities (equivalent to "atoms at rest" — no explosive artifacts)
 * 2. Recompute forces from current positions
 * 3. Rebuild bond topology and components
 *
 * This produces a momentary visual "freeze" but avoids unphysical jumps.
 */
function _handleWorkerFailure(reason: string) {
  console.warn('[worker] failure:', reason, '— rebuilding local physics for sync fallback');
  _teardownWorker();

  if (physics.n > 0) {
    // Zero stale velocities — prevents unphysical drift from pre-worker state
    if (physics.vel) physics.vel.fill(0);
    // Recompute forces, bonds, and components from current positions
    physics.computeForces();
    physics.updateBondList();
    physics.rebuildComponents();
    physics.updateWallRadius();
  }

  // Reset scheduler to re-warm from the new sync state
  fullSchedulerReset();
}

function createInputManager() {
  // Acknowledged dependency: InputManager receives the live camera reference
  // for real-time raycasting and projection. This cannot be replaced by
  // getCameraState() snapshots — InputManager needs the live THREE.Camera
  // for Raycaster.setFromCamera() and Vector3.project()/unproject().
  inputManager = new InputManager(
    renderer.getCanvas(),
    renderer.camera,
    renderer.controls,
    buildAtomSource(),
    {
      onHover: (atomIdx) => {
        if (placement && placement.active) return;
        const cmd = atomIdx >= 0
          ? stateMachine.onPointerOverAtom(atomIdx)
          : stateMachine.onPointerOutAtom();
        if (cmd) dispatchToInteraction(cmd);
      },
      onPointerDown: (atomIdx, sx, sy, isRotate) => {
        if (placement && placement.active) return;
        const mode = isRotate ? 'rotate' : session.interactionMode;
        const cmd = stateMachine.onPointerDown(atomIdx, sx, sy, mode);
        if (cmd) dispatchToInteraction(cmd, sx, sy);
      },
      onPointerMove: (sx, sy) => {
        if (placement && placement.active) return;
        const cmd = stateMachine.onPointerMove(sx, sy);
        if (cmd) dispatchToInteraction(cmd, sx, sy);
      },
      onPointerUp: () => {
        if (placement && placement.active) return;
        const cmd = stateMachine.onPointerUp();
        if (cmd) dispatchToInteraction(cmd);
      },
    }
  );
}

// screenToPhysics and fadeHint are now in interaction.js and status.js respectively

function dispatchToInteraction(cmd: Command, screenX?: number, screenY?: number) {
  const result = dispatchInteraction(cmd, screenX, screenY, {
    physics, renderer, stateMachine, inputManager,
    fadeHint: () => statusCtrl.fadeHint(),
    updateStatus,
    updateSceneStatus,
  });

  // Forward interaction commands to worker to keep worker scene in sync
  if (workerBridge && workerInitialized) {
    switch (cmd.action) {
      case 'startDrag':
      case 'startMove':
      case 'startRotate':
        workerBridge.sendInteraction({
          type: 'startDrag',
          atomIndex: cmd.atom,
          mode: cmd.action === 'startDrag' ? 'atom' : cmd.action === 'startMove' ? 'move' : 'rotate',
        });
        break;
      case 'updateDrag':
      case 'updateMove':
      case 'updateRotate': {
        // Use the resolved world coords returned by interaction dispatch —
        // no dependency on concrete physics.dragTarget field.
        const dt = result.dragTarget;
        if (dt) {
          workerBridge.sendInteraction({ type: 'updateDrag', worldX: dt[0], worldY: dt[1], worldZ: dt[2] });
        }
        break;
      }
      case 'endDrag':
      case 'endMove':
      case 'endRotate':
        workerBridge.sendInteraction({ type: 'endDrag' });
        break;
      case 'flick':
        workerBridge.sendInteraction({ type: 'applyImpulse', atomIndex: cmd.atom, vx: cmd.vx, vy: cmd.vy });
        break;
    }
  }
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
  updateSpeedControls();
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
  updateSpeedControls();
}

// --- Speed button state sync ---
function updateSpeedControls() {
  if (settingsSheet) settingsSheet.updateSpeedButtons(session.playback.maxSpeed, scheduler.warmUpComplete);
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
          updateSpeedControls();
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

      if (workerBridge && workerInitialized) {
        // C.2 Phase 2 — Worker mode: don't step locally; send request to worker
        // One-in-flight: only send if no outstanding request
        scheduler.simBudgetMs -= substepsThisFrame * stepWallMs;
        if (substepsThisFrame > 0 && workerBridge.canSendRequest()) {
          try {
            workerBridge.sendRequestFrame(substepsThisFrame);
          } catch (_) {
            _handleWorkerFailure('sendRequestFrame failed');
          }
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

      // Max speed estimation — mode-specific source and cadence
      // TODO(Milestone C): decide whether to unify this with scheduler-pure.computeMaxSpeed()
      // or keep it inline. The pure version uses a simpler budget model; this version uses
      // actualRendersPerSec, updatePosMs, otherMs, and budgetSafety for higher accuracy.
      // Same applies to wall radius (physics.updateWallRadius vs scheduler-pure.computeWallRadius).
      const now = performance.now();
      const maxUpdateInterval = scheduler.mode === 'overloaded'
        ? CONFIG.playback.maxSpeedUpdateOverloadMs
        : CONFIG.playback.maxSpeedUpdateNormalMs;
      if (scheduler.warmUpComplete && (now - scheduler.lastMaxSpeedUpdateTs) > maxUpdateInterval) {
        scheduler.lastMaxSpeedUpdateTs = now;
        let rawMax;
        if (scheduler.mode === 'overloaded') {
          // In overloaded mode: derive from achieved throughput, not budget estimator
          rawMax = Math.min(pb.effectiveSpeed, CONFIG.playback.maxSpeedCap);
        } else {
          // Normal/recovering: use budget-based estimator
          const budgetPerSec = 1000 * CONFIG.playback.budgetSafety;
          const renderBudget = scheduler.prof.actualRendersPerSec * scheduler.prof.renderMs;
          const updateBudget = (1000 / scheduler.prof.rafIntervalMs) * scheduler.prof.updatePosMs;
          const otherBudget = (1000 / scheduler.prof.rafIntervalMs) * scheduler.prof.otherMs;
          const physicsBudget = budgetPerSec - renderBudget - updateBudget - otherBudget;
          const safePhysMs = Math.max(scheduler.prof.physStepMs, 0.001);
          const maxSteps = Math.max(0, physicsBudget) / safePhysMs;
          rawMax = Math.min(maxSteps / CONFIG.playback.baseStepsPerSecond, CONFIG.playback.maxSpeedCap);
        }
        // Recovering: explicit two-window blend from overloaded max to estimator max
        if (scheduler.mode === 'recovering' && scheduler.recoveringBlendRemaining > 0) {
          const stepIndex = 3 - scheduler.recoveringBlendRemaining; // 1, then 2
          const t = stepIndex / 2; // 0.5, then 1.0
          pb.maxSpeed = scheduler.recoveringStartMax + t * (rawMax - scheduler.recoveringStartMax);
          scheduler.recoveringBlendRemaining--;
        } else {
          pb.maxSpeed += alpha * (rawMax - pb.maxSpeed);
        }
        updateSpeedControls();
      }
    }

    // ── Stalled-worker detection ──
    // Uses workerProgressTs which is set when init() is called, then updated on
    // init ack, frameResult, frameSkipped. Covers both startup hangs (init never
    // resolves) and steady-state stalls (worker stops responding).
    if (workerBridge && workerProgressTs > 0) {
      const timeSinceProgress = performance.now() - workerProgressTs;
      const stalledThresholdMs = _testStalledThresholdMs > 0 ? _testStalledThresholdMs : 5000;
      const fatalThresholdMs = stalledThresholdMs * 3; // 15s default
      if (timeSinceProgress > fatalThresholdMs) {
        console.warn(`[worker] stalled (no progress for ${(fatalThresholdMs/1000).toFixed(0)}s) — falling back to sync physics`);
        _handleWorkerFailure(`Worker stalled (no progress for ${(fatalThresholdMs/1000).toFixed(0)}+ seconds)`);
      } else if (timeSinceProgress > stalledThresholdMs && !session.playback.paused) {
        workerStalled = true;
      }
    }

    // Update positions + feedback (every tick)
    const updateStart = performance.now();
    if (workerBridge && workerInitialized) {
      // C.2 Phase 2 — Worker mode: render from latest worker snapshot
      const snapshot = workerBridge.getLatestSnapshot();
      if (snapshot && snapshot.n > 0) {
        // Keep physics.n in sync with worker (canonical position sync is in updateFromSnapshot)
        physics.n = snapshot.n;

        // Wall removal sync: if worker returned fewer atoms than renderer expects
        if (snapshot.n !== renderer.getAtomCount()) {
          renderer.setAtomCount(snapshot.n);
          // Atom count changed (wall removal) — sync positions from THIS snapshot
          // BEFORE recomputing bonds, so bond computation uses current positions.
          physics.n = snapshot.n;
          if (physics.pos) {
            const len = Math.min(snapshot.positions.length, physics.pos.length);
            physics.pos.set(snapshot.positions.subarray(0, len));
          }
          renderer.setPhysicsRef(physics);
          physics.updateBondList();
          // Invalidate any active drag — atom indices changed after wall removal.
          // The user can't meaningfully continue dragging an atom whose index was remapped.
          if (stateMachine.isInteracting()) {
            const cmd = stateMachine.forceIdle();
            if (cmd) dispatchToInteraction(cmd);
          }
        }
        // Sync physics.pos from snapshot BEFORE bond refresh and rendering.
        // This is the canonical position sync for worker mode.
        if (physics.pos) {
          const syncLen = Math.min(snapshot.positions.length, physics.pos.length);
          physics.pos.set(snapshot.positions.subarray(0, syncLen));
        }

        // Periodic bond refresh — keeps bond list current as atoms move.
        // Runs every 20 frames (stable counter, not accumulated physics steps).
        // Must run AFTER position sync so bonds use current positions.
        _workerBondRefreshCounter++;
        if (_workerBondRefreshCounter >= 20) {
          _workerBondRefreshCounter = 0;
          physics.updateBondList();
        }

        renderer.updateFromSnapshot(snapshot.positions, snapshot.n);
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
      const isPlacementStale = isPlacementActive && workerBridge != null && workerInitialized && workerBridge.getSnapshotAge() > 500;
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
        workerStalled,
        rafIntervalMs: scheduler.prof.rafIntervalMs,
      });

    // ── Auto FPS gate for UI effects ──
    // Only runs when glass UI is visible AND mode is 'auto' (not forced by developer).
    const frameMs = scheduler.prof.rafIntervalMs;
    const glassVisible = isGlassUiVisible();
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
      updateActiveCountRow();
    }

  } catch (e) {
    console.error('[frameLoop] ERROR:', e);
  }
  if (_appRunning) _rafId = requestAnimationFrame(frameLoop);
}

// --- Start ---
init();
