/**
 * NanoToybox Interactive Page — Entry Point
 *
 * Multi-molecule playground with placement mode.
 * Wires together: loader, physics, state machine, input, renderer, FPS monitor.
 */
import { loadManifest, loadStructure } from './loader.js';
import { PhysicsEngine } from './physics.js';
import { StateMachine, State } from './state-machine.js';
import { InputManager } from './input.js';
import { Renderer } from './renderer.js';
import { FPSMonitor } from './fps-monitor.js';
import { THEMES, applyThemeTokens } from './themes.js';
import { CONFIG } from './config.js';
import { commitMolecule, clearPlayground, addMoleculeToScene } from './scene.js';
import { OverlayController } from './ui/overlay.js';
import { DockController } from './ui/dock.js';
import { SettingsSheetController } from './ui/settings-sheet.js';
import { handleCommand as dispatchCommand } from './interaction.js';
import { StatusController } from './status.js';
import { PlacementController } from './placement.js';

const DEBUG_LOAD = CONFIG.debug.load;

// --- Globals ---
let renderer, physics, stateMachine, inputManager, fpsMonitor;
let manifest = null;
let overlay = null;
let dock = null;
let settingsSheet = null;
let statusCtrl = null;
let placement = null;

const session = {
  theme: 'dark',
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
function isGlassUiVisible() { return dock ? dock.isGlassActive() : false; }

// Global listener registry for teardown
const _globalListeners = [];
let _rafId = null;
let _appRunning = false;
let _fpsClickHandler = null;
let _fpsClickEl = null;
let _dockResizeObserver = null;
let _layoutPending = false;
let _layoutRafId = null;

/** Register a global listener and track it for teardown. Options forwarded to both add/remove. */
function addGlobalListener(target, event, handler, options) {
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
  const dockEl = document.getElementById('dock');
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
  // Stop frame loop
  _appRunning = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  // Remove global listeners
  for (const [event, handler, target, options] of _globalListeners) {
    target.removeEventListener(event, handler, options);
  }
  _globalListeners.length = 0;
  // Remove FPS click handler
  if (_fpsClickEl && _fpsClickHandler) {
    _fpsClickEl.removeEventListener('click', _fpsClickHandler);
    _fpsClickEl = null; _fpsClickHandler = null;
  }
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
  fpsMonitor = null;
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
  _fpsExpanded = false;
  clearTimeout(_fpsExpandTimer);
  _fpsExpandTimer = null;
  // Reset session state (theme preserved intentionally for re-init continuity)
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
  fpsMonitor = new FPSMonitor(document.getElementById('fps'));

  renderer.applyTheme(session.theme);
  applyThemeTokens(session.theme);

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
    if (prev && prev !== mode && overlay) overlay.close();
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
        overlay.close();
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
  addGlobalListener(document, 'pointerdown', (e) => {
    if (overlay.current === 'none') return;

    // Only primary pointer — reject second touch in multi-touch, and
    // non-left mouse buttons (right-click, middle, stylus barrel).
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // Clicks inside either sheet never dismiss (ownership boundary).
    const sSheet = document.getElementById('settings-sheet');
    const cSheet = document.getElementById('chooser-sheet');
    if (sSheet && sSheet.contains(e.target)) return;
    if (cSheet && cSheet.contains(e.target)) return;

    // Clicks inside the dock never dismiss.
    const dockEl = document.getElementById('dock');
    if (dockEl && dockEl.contains(e.target)) return;

    // Only backdrop and renderer canvas dismiss.
    const backdrop = document.getElementById('sheet-backdrop');
    const canvas = renderer ? renderer.getCanvas() : null;
    const isBackdrop = backdrop && (e.target === backdrop || backdrop.contains(e.target));
    const isCanvas = canvas && (e.target === canvas || canvas.contains(e.target));
    if (!isBackdrop && !isCanvas) return;

    // Close + consume so no interaction starts from the same event.
    overlay.close();
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
    overlay.open('chooser');
  });
  dock.onModeChange((mode) => { session.interactionMode = mode; });
  dock.onPause(() => {
    if (placement.active) return;
    session.playback.paused = !session.playback.paused;
    dock.setPauseLabel(session.playback.paused);
    if (!session.playback.paused) {
      scheduler.lastFrameTs = performance.now();
      scheduler.simBudgetMs = 0;
    }
    scheduler.forceRenderThisTick = true;
  });
  dock.onSettings(() => {
    if (placement.active) return;
    overlay.open('settings');
  });
  dock.onCancel(() => placement.exit(false));

  // ── Settings sheet controller ──
  settingsSheet = new SettingsSheetController({
    speedSeg: document.getElementById('speed-seg'),
    themeSeg: document.getElementById('theme-seg'),
    boundarySeg: document.getElementById('boundary-seg'),
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
  });
  settingsSheet.onThemeChange((theme) => {
    session.theme = theme;
    renderer.applyTheme(session.theme);
    applyThemeTokens(session.theme);
  });
  settingsSheet.onBoundaryChange((mode) => { physics.setWallMode(mode); });
  settingsSheet.onDragChange((v) => { physics.setDragStrength(v); });
  settingsSheet.onRotateChange((v) => { physics.setRotateStrength(v); });
  settingsSheet.onDampingChange((d) => { physics.setDamping(d); });
  settingsSheet.onAddMolecule(() => { _updateChooserRecentRow(); overlay.open('chooser'); });
  settingsSheet.onClear(() => { overlay.close(); _clearPlayground(); });
  settingsSheet.onResetView(() => { renderer.resetView(); });
  settingsSheet.onHelpOpen(() => { overlay.showHelpPage(); });
  settingsSheet.onHelpBack(() => { overlay.showMainPage(); });

  // Initial speed button state
  settingsSheet.updateSpeedButtons(session.playback.maxSpeed, scheduler.warmUpComplete);

  // ── Placement controller ──
  placement = new PlacementController({
    renderer, physics, stateMachine, inputManager, loadStructure,
    commands: {
      setDockPlacementMode: (active) => setDockPlacementMode(active),
      commitToScene: (file, name, atoms, bonds, offset) => _commitMolecule(file, name, atoms, bonds, offset),
      updateStatus,
      updateSceneStatus,
      updateDockAddLabel,
      forceIdle: () => handleCommand(stateMachine.forceIdle()),
      syncInput: syncInputManager,
      forceRender: () => { scheduler.forceRenderThisTick = true; },
      buildAtomSource,
      getSceneMolecules: () => session.scene.molecules,
    },
  });

  // ── Overlay layout: hint clearance + triad sizing/positioning ──
  // Initial synchronous pass for first-paint correctness (dock/renderer exist).
  _doOverlayLayout();
  addGlobalListener(window, 'resize', _requestOverlayLayout);
  _dockResizeObserver = new ResizeObserver(() => _requestOverlayLayout());
  _dockResizeObserver.observe(document.getElementById('dock'));

  // Mobile: tap FPS area to expand diagnostics for 5s
  _fpsClickEl = document.getElementById('fps');
  if (_fpsClickEl) {
    _fpsClickHandler = () => {
      _fpsExpanded = true;
      clearTimeout(_fpsExpandTimer);
      _fpsExpandTimer = setTimeout(() => { _fpsExpanded = false; }, 5000);
    };
    _fpsClickEl.addEventListener('click', _fpsClickHandler);
  }

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
}

// --- Structure drawer ---
function populateStructureDrawer(manifest) {
  const list = document.getElementById('structure-list');
  const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);
  for (const [key, info] of entries) {
    const item = document.createElement('div');
    item.className = 'drawer-item';
    item.textContent = `${info.description} (${info.n_atoms} atoms)`;
    // Listener on owned DOM node — GC'd when list is cleared. Not in _globalListeners.
    item.addEventListener('click', () => {
      overlay.close();
      placement.start(info.file, info.description);
    });
    list.appendChild(item);
  }
}

// --- Scene management ---

// ── Dock helpers (delegate to dock controller) ──
function setDockPlacementMode(active) {
  if (!dock) return;
  dock.setPlacementMode(active);
  if (!active) updateDockAddLabel();
}

function updateDockAddLabel() {
  if (!dock) return;
  dock.updateAddLabel();
}

/** Update the pinned "Recent" shortcut row at the top of the chooser. */
function _updateChooserRecentRow() {
  const list = document.getElementById('structure-list');
  if (!list) return;
  const prev = list.querySelector('.chooser-recent');
  if (prev) prev.remove();

  if (placement && placement.hasLastStructure()) {
    const row = document.createElement('div');
    row.className = 'chooser-recent';
    const label = document.createElement('span');
    label.className = 'chooser-recent-label';
    label.textContent = 'Recent';
    const name = document.createElement('span');
    name.className = 'chooser-recent-name';
    name.textContent = placement.getLastStructureName();
    row.appendChild(label);
    row.appendChild(name);
    row.addEventListener('click', () => {
      overlay.close();
      placement.start(placement.getLastStructureFile(), placement.getLastStructureName());
    });
    list.insertBefore(row, list.firstChild);
  }
}


function updateSceneStatus() {
  if (statusCtrl) statusCtrl.updateSceneStatus(session.scene.molecules.length, session.scene.totalAtoms);
  updatePlacedCount();
  updateActiveCountRow();
}

// Placed/Active count helpers — delegate to settingsSheet controller
function updatePlacedCount() {
  if (settingsSheet) settingsSheet.updatePlacedCount(session.scene.totalAtoms);
}

function updateActiveCountRow() {
  if (settingsSheet) settingsSheet.updateActiveCount(physics.getActiveAtomCount(), physics.getWallRemovedCount());
}

// ── Scene wrappers (delegate to scene.js with dependencies) ──
function _commitMolecule(filename, name, atoms, bonds, offset) {
  commitMolecule(physics, renderer, filename, name, atoms, bonds, offset, session.scene, {
    syncInput: syncInputManager,
    resetProfiler: partialProfilerReset,
    fitCamera: () => renderer.fitCamera(),
    updateSceneStatus,
  });
}

function _clearPlayground() {
  clearPlayground(physics, renderer, stateMachine, session.scene, {
    invalidatePlacement: () => placement.invalidatePendingLoads(),
    exitPlacement: () => placement.exit(false),
    forceIdle: () => handleCommand(stateMachine.forceIdle()),
    syncInput: syncInputManager,
    resetScheduler: fullSchedulerReset,
    updateSceneStatus,
    updateDockLabel: updateDockAddLabel,
  });
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

function createInputManager() {
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
        if (cmd) handleCommand(cmd);
      },
      onPointerDown: (atomIdx, sx, sy, isRotate) => {
        if (placement && placement.active) return;
        const mode = isRotate ? 'rotate' : session.interactionMode;
        const cmd = stateMachine.onPointerDown(atomIdx, sx, sy, mode);
        if (cmd) handleCommand(cmd, sx, sy);
      },
      onPointerMove: (sx, sy) => {
        if (placement && placement.active) return;
        const cmd = stateMachine.onPointerMove(sx, sy);
        if (cmd) handleCommand(cmd, sx, sy);
      },
      onPointerUp: () => {
        if (placement && placement.active) return;
        const cmd = stateMachine.onPointerUp();
        if (cmd) handleCommand(cmd);
      },
    }
  );
}

// screenToPhysics and fadeHint are now in interaction.js and status.js respectively

function handleCommand(cmd, screenX, screenY) {
  dispatchCommand(cmd, screenX, screenY, {
    physics, renderer, stateMachine, inputManager,
    fadeHint: () => statusCtrl.fadeHint(),
    updateStatus,
    updateSceneStatus,
  });
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

// --- Mobile status tap-to-expand ---
let _fpsExpanded = false;
let _fpsExpandTimer = null;

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
      // Compute target speed
      const pb = session.playback;
      let targetSpeed = pb.speedMode === 'max' ? pb.maxSpeed : Math.min(pb.selectedSpeed, pb.maxSpeed);

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
        } else {
          targetSpeed = Math.min(targetSpeed, 1.0);
        }
      }

      // Accumulate
      scheduler.simBudgetMs += frameDtMs * targetSpeed;

      // Budget cap based on overload mode
      const hardCap = CONFIG.playback.maxSubstepsPerTick * stepWallMs;
      if (scheduler.mode === 'overloaded') {
        scheduler.simBudgetMs = Math.min(scheduler.simBudgetMs, hardCap);
      } else {
        scheduler.simBudgetMs = Math.min(scheduler.simBudgetMs, hardCap * 1.5);
      }

      // Run substeps
      const physStart = performance.now();
      while (scheduler.simBudgetMs >= stepWallMs && substepsThisFrame < CONFIG.playback.maxSubstepsPerTick) {
        physics.stepOnce();
        scheduler.simBudgetMs -= stepWallMs;
        substepsThisFrame++;
      }
      const physEnd = performance.now();

      if (substepsThisFrame > 0) {
        physics.applySafetyControls();
        const msPerStep = (physEnd - physStart) / substepsThisFrame;
        scheduler.prof.physStepMs += alpha * (msPerStep - scheduler.prof.physStepMs);
        scheduler.totalStepsProfiled += substepsThisFrame;
      }

      // Overloaded in overloaded mode: discard residual budget
      if (scheduler.mode === 'overloaded') {
        scheduler.simBudgetMs = Math.min(scheduler.simBudgetMs, 0);
      }

      // Overload FSM
      if (substepsThisFrame >= CONFIG.playback.maxSubstepsPerTick) {
        scheduler.overloadCount = Math.min(scheduler.overloadCount + 1, 30);
      } else {
        scheduler.overloadCount = Math.max(0, scheduler.overloadCount - 1);
      }
      if (scheduler.mode === 'normal' && scheduler.overloadCount >= CONFIG.playback.overloadEntryTicks) {
        scheduler.mode = 'overloaded';
        scheduler.simBudgetMs = 0;
      }
      if (scheduler.mode === 'overloaded' && scheduler.overloadCount < CONFIG.playback.overloadExitTicks) {
        scheduler.mode = 'recovering';
        scheduler.recoveringStartMax = pb.maxSpeed; // capture for blend
        scheduler.recoveringBlendRemaining = 2;     // two update windows
      }
      if (scheduler.mode === 'recovering') {
        if (scheduler.overloadCount === 0) scheduler.mode = 'normal';
        if (scheduler.overloadCount >= CONFIG.playback.overloadEntryTicks) scheduler.mode = 'overloaded';
      }

      // Effective speed
      if (frameDtMs > 0) {
        const instantSpeed = (substepsThisFrame * 1000 / frameDtMs) / CONFIG.playback.baseStepsPerSecond;
        scheduler.effectiveSpeedWindow.push({ speed: instantSpeed, dt: frameDtMs });
        if (scheduler.effectiveSpeedWindow.length > 10) scheduler.effectiveSpeedWindow.shift();
        // Time-weighted average: longer frames carry more weight
        let wSum = 0, wTotal = 0;
        for (const s of scheduler.effectiveSpeedWindow) { wSum += s.speed * s.dt; wTotal += s.dt; }
        pb.effectiveSpeed = wTotal > 0 ? wSum / wTotal : 0;
      }

      // Max speed estimation — mode-specific source and cadence
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

    // Update positions + feedback (every tick)
    const updateStart = performance.now();
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
    renderer.updateFeedback(stateMachine.getFeedbackState());
    const updateEnd = performance.now();
    scheduler.prof.updatePosMs += alpha * ((updateEnd - updateStart) - scheduler.prof.updatePosMs);

    // Render decision: budget-driven with hysteresis
    const usedMs = (substepsThisFrame * scheduler.prof.physStepMs) + scheduler.prof.updatePosMs + scheduler.prof.otherMs;
    const canRender = (scheduler.prof.rafIntervalMs - usedMs) >= scheduler.prof.renderMs * 0.8;

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
      const mdRate = displaySpeed * CONFIG.playback.baseStepsPerSecond * CONFIG.physics.dt / 1000;
      const fps = Math.round(1000 / scheduler.prof.rafIntervalMs);
      const detail = `${scheduler.prof.rafIntervalMs.toFixed(1)} ms · ${fps} fps`;

      const isCompact = window.innerWidth < 768;
      const showDetail = !isCompact || _fpsExpanded;

      let statusText;
      if (pb.paused) {
        statusText = showDetail ? `Paused · ${detail}` : 'Paused · 0 ps/s';
      } else if (placement && placement.active) {
        statusText = showDetail ? `Placing... · ${detail}` : 'Placing...';
      } else if (!scheduler.warmUpComplete) {
        statusText = 'Estimating...';
      } else if (scheduler.mode === 'overloaded' || pb.maxSpeed < CONFIG.playback.minSpeed) {
        statusText = showDetail
          ? `Hardware-limited · Sim ${displaySpeed.toFixed(1)}x · ${mdRate.toFixed(2)} ps/s · ${detail}`
          : `Hardware-limited · Sim ${displaySpeed.toFixed(1)}x · ${mdRate.toFixed(2)} ps/s`;
      } else {
        statusText = showDetail
          ? `Sim ${displaySpeed.toFixed(1)}x · ${mdRate.toFixed(2)} ps/s · ${detail}`
          : `Sim ${displaySpeed.toFixed(1)}x · ${mdRate.toFixed(2)} ps/s`;
      }
      fpsMonitor.displayEl.textContent = statusText;

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
