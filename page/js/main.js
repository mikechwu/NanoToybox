/**
 * NanoToybox Interactive Page — Entry Point
 *
 * Multi-molecule playground with placement mode.
 * Wires together: loader, physics, state machine, input, renderer, FPS monitor.
 */
import * as THREE from 'three';
import { loadManifest, loadStructure } from './loader.js';
import { PhysicsEngine } from './physics.js';
import { StateMachine, State } from './state-machine.js';
import { InputManager } from './input.js';
import { Renderer } from './renderer.js';
import { FPSMonitor } from './fps-monitor.js';
import { THEMES } from './themes.js';
import { CONFIG } from './config.js';

const DEBUG_LOAD = CONFIG.debug.load;

// --- Globals ---
let renderer, physics, stateMachine, inputManager, fpsMonitor;
let manifest = null;

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
  placement: {
    active: false,
    structureFile: null,
    structureName: null,
    previewAtoms: null,
    previewBonds: null,
    previewOffset: [0, 0, 0],
    placementPlane: null,  // { normal: Vector3, point: Vector3 }
    isDraggingPreview: false,
    grabOffset: [0, 0, 0],  // 3D offset projected onto placement plane
    lastStructureFile: null,
    lastStructureName: null,
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

// --- Initialization ---
async function init() {
  const container = document.getElementById('container');
  renderer = new Renderer(container);
  physics = new PhysicsEngine();
  stateMachine = new StateMachine();
  fpsMonitor = new FPSMonitor(document.getElementById('fps'));

  renderer.applyTheme(session.theme);

  // Load manifest
  try {
    manifest = await loadManifest();
    populateStructureDrawer(manifest);

    // Auto-load C60 as first molecule
    const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);
    if (entries.length > 0) {
      const c60 = entries.find(([k]) => k === 'c60');
      const [key, info] = c60 || entries[0];
      await addMoleculeToScene(info.file, info.description, [0, 0, 0]);
    }
  } catch (e) {
    document.getElementById('status').textContent = 'Failed to load structures. Serve from repo root.';
    console.error(e);
    return;
  }

  // --- UI wiring ---

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    session.theme = session.theme === 'dark' ? 'light' : 'dark';
    renderer.applyTheme(session.theme);
    applyUITheme(session.theme);
  });

  // Clear playground
  document.getElementById('btn-clear').addEventListener('click', () => {
    clearPlayground();
  });

  // Reset camera view
  document.getElementById('btn-reset-view').addEventListener('click', () => {
    renderer.resetView();
  });

  // Interaction mode buttons
  const modeButtons = document.querySelectorAll('.mode-btn');
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      session.interactionMode = btn.dataset.mode;
      modeButtons.forEach(b => {
        b.classList.remove('active');
        b.style.color = '';
        b.style.background = '';
      });
      btn.classList.add('active');
      applyUITheme(session.theme);
    });
  });

  // Add Molecule button
  document.getElementById('btn-add-molecule').addEventListener('click', () => {
    const drawer = document.getElementById('structure-drawer');
    drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
  });

  // Add Another button
  document.getElementById('btn-add-another').addEventListener('click', () => {
    if (session.placement.lastStructureFile) {
      startPlacement(session.placement.lastStructureFile, session.placement.lastStructureName);
    }
  });

  // Place / Cancel buttons
  document.getElementById('btn-place').addEventListener('click', () => {
    exitPlacementMode(true);
  });
  document.getElementById('btn-cancel-place').addEventListener('click', () => {
    exitPlacementMode(false);
  });

  // Keyboard shortcuts for placement (works during preview AND pending load)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (session.placement.active) {
        exitPlacementMode(false);
        e.preventDefault();
      } else if (_placementLoading) {
        // Cancel a pending preview load
        _placementGeneration++;
        _placementLoading = false;
        updateSceneStatus();
        e.preventDefault();
      }
    }
    if (e.key === 'Enter' && session.placement.active) {
      exitPlacementMode(true);
      e.preventDefault();
    }
  });

  // Close panels when clicking outside
  const advPanel = document.getElementById('advanced-panel');
  const helpPanel = document.getElementById('help');
  const drawer = document.getElementById('structure-drawer');
  document.getElementById('btn-advanced').addEventListener('click', () => {
    advPanel.style.display = advPanel.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btn-help-open').addEventListener('click', () => {
    helpPanel.style.display = 'block';
  });
  document.addEventListener('pointerdown', (e) => {
    if (advPanel.style.display !== 'none' &&
        !advPanel.contains(e.target) && e.target.id !== 'btn-advanced') {
      advPanel.style.display = 'none';
    }
    if (helpPanel.style.display !== 'none' &&
        !helpPanel.contains(e.target) && e.target.id !== 'btn-help-open') {
      helpPanel.style.display = 'none';
    }
    if (drawer.style.display !== 'none' &&
        !drawer.contains(e.target) && e.target.id !== 'btn-add-molecule') {
      drawer.style.display = 'none';
    }
  });

  // Sliders
  function bindSlider(id, handler) {
    const el = document.getElementById(id);
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
    return el;
  }
  const dragVal = document.getElementById('drag-val');
  bindSlider('drag-strength', (e) => {
    const v = parseFloat(e.target.value);
    physics.setDragStrength(v);
    dragVal.textContent = v.toFixed(1);
  });
  const rotVal = document.getElementById('rotate-val');
  bindSlider('rotate-strength', (e) => {
    const v = parseFloat(e.target.value);
    physics.setRotateStrength(v);
    rotVal.textContent = v.toFixed(0);
  });
  const dampVal = document.getElementById('damping-val');
  bindSlider('damping-slider', (e) => {
    const t = parseFloat(e.target.value) / 100;
    const damping = t === 0 ? 0 : 0.5 * t * t * t;
    physics.setDamping(damping);
    if (damping === 0) dampVal.textContent = 'None';
    else if (damping < 0.001) dampVal.textContent = damping.toExponential(0);
    else dampVal.textContent = damping.toFixed(3);
  });

  // Pause button
  const pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      session.playback.paused = !session.playback.paused;
      pauseBtn.textContent = session.playback.paused ? 'Resume' : 'Pause';
      if (!session.playback.paused) {
        // Resume: prevent catch-up burst
        scheduler.lastFrameTs = performance.now();
        scheduler.simBudgetMs = 0;
      }
      scheduler.forceRenderThisTick = true;
    });
  }

  // Speed buttons
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.speed;
      if (val === 'max') {
        session.playback.speedMode = 'max';
      } else {
        session.playback.speedMode = 'fixed';
        session.playback.selectedSpeed = parseFloat(val);
      }
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      scheduler.forceRenderThisTick = true;
      updateSpeedControls();
    });
  });

  // Initial speed button state
  updateSpeedControls();

  // Mobile: tap FPS area to expand diagnostics for 5s
  const fpsEl = document.getElementById('fps');
  if (fpsEl) {
    fpsEl.addEventListener('click', () => {
      _fpsExpanded = true;
      clearTimeout(_fpsExpandTimer);
      _fpsExpandTimer = setTimeout(() => { _fpsExpanded = false; }, 5000);
    });
  }

  // Tab visibility: prevent catch-up burst
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      scheduler.lastFrameTs = performance.now();
      scheduler.simBudgetMs = 0;
    }
  });

  requestAnimationFrame(frameLoop);
}

// --- Structure drawer ---
function populateStructureDrawer(manifest) {
  const list = document.getElementById('structure-list');
  const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);
  for (const [key, info] of entries) {
    const item = document.createElement('div');
    item.className = 'drawer-item';
    item.textContent = `${info.description} (${info.n_atoms} atoms)`;
    item.addEventListener('click', () => {
      document.getElementById('structure-drawer').style.display = 'none';
      startPlacement(info.file, info.description);
    });
    list.appendChild(item);
  }
}

// --- Scene management ---
/** Load a structure from the library and add it to the scene. Used for initial auto-load. */
async function addMoleculeToScene(filename, name, offset) {
  session.isLoading = true;
  updateStatus('Loading...');
  try {
    const { atoms, bonds } = await loadStructure(filename);
    if (DEBUG_LOAD) console.log(`[add] ${name}: ${atoms.length} atoms, ${bonds.length} bonds`);
    commitMolecule(filename, name, atoms, bonds, offset);
  } catch (e) {
    updateStatus(`Error: ${e.message}`);
    console.error(e);
  }
  session.isLoading = false;
}

function clearPlayground() {
  _placementGeneration++;  // invalidate any pending preview loads
  _placementLoading = false; // clear transient loading state immediately
  exitPlacementMode(false);
  handleCommand(stateMachine.forceIdle());
  renderer.clearFeedback();
  renderer.clearAllMeshes();
  physics.clearScene();
  session.scene.molecules = [];
  session.scene.nextId = 1;
  session.scene.totalAtoms = 0;
  syncInputManager();
  renderer.resetToEmpty();
  fullSchedulerReset();
  updateSceneStatus();
}

function updateSceneStatus() {
  const n = session.scene.molecules.length;
  const a = session.scene.totalAtoms;
  if (n === 0) {
    updateStatus('Empty playground — add a molecule');
  } else {
    updateStatus(`${n} molecule${n > 1 ? 's' : ''} · ${a} atoms`);
  }
}

// --- Placement mode ---
let _placementGeneration = 0;  // guards against stale async loads
let _placementLoading = false; // true while a preview structure is being fetched

async function startPlacement(filename, name) {
  // Fully clean up any existing placement before starting a new one
  if (session.placement.active) {
    exitPlacementMode(false);
  }

  // Increment generation before async load — any load that resolves
  // with a stale generation is silently discarded
  const myGeneration = ++_placementGeneration;

  // Load structure for preview
  _placementLoading = true;
  updateStatus(`Loading ${name}...`);
  try {
    const { atoms, bonds } = await loadStructure(filename);
    _placementLoading = false;

    // Discard if a newer startPlacement call was made during the load
    if (myGeneration !== _placementGeneration) {
      if (DEBUG_LOAD) console.log(`[placement] Discarded stale load for ${name} (gen ${myGeneration} vs ${_placementGeneration})`);
      return;
    }

    // Cleanup any active simulation interaction
    handleCommand(stateMachine.forceIdle());
    renderer.clearFeedback();
    if (inputManager) inputManager.updateAtomMeshes(renderer.atomMeshes);

    session.placement.active = true;
    session.placement.structureFile = filename;
    session.placement.structureName = name;
    session.placement.previewAtoms = atoms;
    session.placement.previewBonds = bonds;
    session.placement.isDraggingPreview = false;

    // Compute preview bounding radius
    let pcx = 0, pcy = 0, pcz = 0;
    atoms.forEach(a => { pcx += a.x; pcy += a.y; pcz += a.z; });
    pcx /= atoms.length; pcy /= atoms.length; pcz /= atoms.length;
    let pR = 0;
    atoms.forEach(a => {
      const d = Math.sqrt((a.x-pcx)**2 + (a.y-pcy)**2 + (a.z-pcz)**2);
      if (d > pR) pR = d;
    });

    // Choose placement offset via tangent placement
    const offset = computeTangentPlacement(pR);
    session.placement.previewOffset = offset;

    // Set placement plane
    const camDir = new THREE.Vector3();
    renderer.camera.getWorldDirection(camDir);
    session.placement.placementPlane = {
      normal: camDir.clone(),
      point: new THREE.Vector3(offset[0], offset[1], offset[2]),
    };

    // Show preview
    renderer.showPreview(atoms, bonds, offset);

    // Show placement UI
    document.getElementById('placement-bar').style.display = 'flex';
    const targetName = getTargetMoleculeName();
    if (targetName) {
      updateStatus(`Placing ${name} near ${targetName} · target: center of view`);
    } else {
      updateStatus(`Placing ${name}`);
    }

    // Register placement listeners
    registerPlacementListeners();
    scheduler.forceRenderThisTick = true;

  } catch (e) {
    _placementLoading = false;
    // Only handle failure if this is still the current request.
    if (myGeneration !== _placementGeneration) {
      if (DEBUG_LOAD) console.log(`[placement] Ignored stale load error for ${name}`);
      return;
    }
    updateStatus(`Error loading preview: ${e.message}`);
    console.error(e);
    session.placement.active = false;
  }
}

function exitPlacementMode(commit) {
  if (!session.placement.active) return;

  unregisterPlacementListeners();
  session.placement.isDraggingPreview = false;
  scheduler.forceRenderThisTick = true;

  // Capture data before clearing state — commitMolecule may throw
  const shouldCommit = commit && session.placement.previewAtoms;
  const commitData = shouldCommit ? {
    file: session.placement.structureFile,
    name: session.placement.structureName,
    atoms: session.placement.previewAtoms,
    bonds: session.placement.previewBonds,
    offset: [...session.placement.previewOffset],
  } : null;

  // Always clean up preview and state, even if commit will fail
  renderer.hidePreview();
  session.placement.active = false;
  session.placement.structureFile = null;
  session.placement.structureName = null;
  session.placement.previewAtoms = null;
  session.placement.previewBonds = null;
  session.placement.previewOffset = [0, 0, 0];
  session.placement.placementPlane = null;
  session.placement.grabOffset = [0, 0, 0];
  document.getElementById('placement-bar').style.display = 'none';

  if (commitData) {
    try {
      commitMolecule(commitData.file, commitData.name, commitData.atoms, commitData.bonds, commitData.offset);
      // Only update "last structure" after successful commit
      session.placement.lastStructureFile = commitData.file;
      session.placement.lastStructureName = commitData.name;
      const btn = document.getElementById('btn-add-another');
      btn.textContent = `Add Another ${commitData.name}`;
      btn.style.display = '';
    } catch (e) {
      console.error('[placement] Commit failed:', e);
      updateStatus(`Error placing molecule: ${e.message}`);
      return;
    }
  }
  updateSceneStatus();
}

/**
 * Commit a molecule to the live scene. Transaction-safe:
 * - If physics.appendMolecule() throws (OOM during allocation), physics
 *   state is unchanged (allocate-before-commit pattern in physics.js).
 * - If renderer.appendMeshes() throws after physics append succeeds,
 *   physics is truncated back to the pre-append atom count.
 * - Session state (molecules[], totalAtoms) is only updated after both
 *   physics and renderer succeed.
 */
function commitMolecule(filename, name, atoms, bonds, offset) {
  const isFirstMolecule = session.scene.molecules.length === 0;
  const oldN = physics.n;
  const result = physics.appendMolecule(atoms, bonds, offset);

  try {
    // Debug: fault injection and invariant checks inside rollback-protected block
    if (CONFIG.debug.failAfterPhysicsAppend) throw new Error('[debug] Injected post-append failure');
    if (CONFIG.debug.assertions) {
      const ok = physics.pos.length === physics.n * 3
        && physics.vel.length === physics.n * 3
        && physics.force.length === physics.n * 3
        && (!physics.componentId || physics.componentId.length === physics.n);
      if (!ok) throw new Error(`[assertion] Post-append array invariant: n=${physics.n}, pos=${physics.pos.length}`);
      for (let b = 0; b < physics.bonds.length; b++) {
        if (physics.bonds[b][0] >= physics.n || physics.bonds[b][1] >= physics.n) {
          throw new Error(`[assertion] Bond ${b} index out of range: [${physics.bonds[b][0]}, ${physics.bonds[b][1]}], n=${physics.n}`);
        }
      }
    }
    const offsetAtoms = atoms.map(a => ({
      x: a.x + offset[0], y: a.y + offset[1], z: a.z + offset[2]
    }));
    renderer.appendMeshes(offsetAtoms);
  } catch (e) {
    // Rollback physics to pre-append state
    physics.n = oldN;
    physics.pos = physics.pos.slice(0, oldN * 3);
    physics.vel = physics.vel.slice(0, oldN * 3);
    physics.force = new Float64Array(oldN * 3); // zeroed — will be recomputed
    physics.bonds.length = physics.bonds.length - bonds.length;
    physics.neighborList = null; // force full neighbor rebuild
    physics.computeForces(); // recompute from restored positions
    physics.updateBondList();
    physics.rebuildComponents();
    throw e;
  }

  const mol = {
    id: session.scene.nextId++,
    name: name,
    structureFile: filename,
    atomCount: result.atomCount,
    atomOffset: result.atomOffset,
    localAtoms: atoms,
    localBonds: bonds,
  };
  session.scene.molecules.push(mol);
  session.scene.totalAtoms += result.atomCount;
  syncInputManager();
  // Partial profiler reset: scene cost changed
  partialProfilerReset();

  if (isFirstMolecule) {
    renderer.fitCamera();
  }
  updateSceneStatus();
}

// --- Tangent placement algorithm ---
function computeTangentPlacement(previewRadius) {
  if (session.scene.molecules.length === 0) {
    // Empty scene: place at center of current viewport at a default depth.
    // Use a fixed depth (enough to frame the molecule) rather than inheriting
    // stale camera-target distance from a cleared scene.
    const camPos = renderer.camera.position;
    const camDir = new THREE.Vector3();
    renderer.camera.getWorldDirection(camDir);
    const defaultDepth = previewRadius * 2.5 + 5; // same formula as _fitCamera
    return [
      camPos.x + camDir.x * defaultDepth,
      camPos.y + camDir.y * defaultDepth,
      camPos.z + camDir.z * defaultDepth,
    ];
  }

  // Find target molecule: nearest projected COM to viewport center
  const target = findTargetMolecule();
  const tCOM = getMoleculeCOM(target);
  const tR = getMoleculeRadius(target, tCOM);

  // Gap: adaptive, proportional to smaller radius
  const gap = Math.max(1.0, 0.3 * Math.min(tR, previewRadius));
  const tangentDist = tR + previewRadius + gap;

  // Camera-plane directions
  const camRight = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  renderer.camera.getWorldDirection(camDir);
  camRight.crossVectors(camDir, renderer.camera.up).normalize();
  camUp.crossVectors(camRight, camDir).normalize();

  // 8 candidate directions
  const dirs = [
    camRight, camRight.clone().negate(),
    camUp, camUp.clone().negate(),
    camRight.clone().add(camUp).normalize(),
    camRight.clone().negate().add(camUp).normalize(),
    camRight.clone().add(camUp.clone().negate()).normalize(),
    camRight.clone().negate().add(camUp.clone().negate()).normalize(),
  ];

  // Score each candidate
  let bestDir = dirs[0];
  let bestScore = Infinity;
  for (const d of dirs) {
    const cx = tCOM[0] + d.x * tangentDist;
    const cy = tCOM[1] + d.y * tangentDist;
    const cz = tCOM[2] + d.z * tangentDist;

    // Project to NDC for viewport checks
    const proj = new THREE.Vector3(cx, cy, cz).project(renderer.camera);
    let score = 0;

    // Viewport margin penalty
    const margin = 0.8;
    if (Math.abs(proj.x) > margin) score += (Math.abs(proj.x) - margin) * 10;
    if (Math.abs(proj.y) > margin) score += (Math.abs(proj.y) - margin) * 10;

    // Overlap penalty with existing molecules
    for (const mol of session.scene.molecules) {
      const mCOM = getMoleculeCOM(mol);
      const mR = getMoleculeRadius(mol, mCOM);
      const dx = cx - mCOM[0], dy = cy - mCOM[1], dz = cz - mCOM[2];
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const overlap = (mR + previewRadius) - dist;
      if (overlap > 0) score += overlap * 5;
    }

    // Directional bias: prefer right/left
    if (d === dirs[0] || d === dirs[1]) score -= 0.1;

    if (score < bestScore) {
      bestScore = score;
      bestDir = d;
    }
  }

  return [
    tCOM[0] + bestDir.x * tangentDist,
    tCOM[1] + bestDir.y * tangentDist,
    tCOM[2] + bestDir.z * tangentDist,
  ];
}

function findTargetMolecule() {
  if (session.scene.molecules.length === 1) return session.scene.molecules[0];
  // Nearest projected COM to viewport center
  let best = session.scene.molecules[0];
  let bestDist = Infinity;
  for (const mol of session.scene.molecules) {
    const com = getMoleculeCOM(mol);
    const proj = new THREE.Vector3(com[0], com[1], com[2]).project(renderer.camera);
    const d = proj.x * proj.x + proj.y * proj.y;
    if (d < bestDist) { bestDist = d; best = mol; }
  }
  return best;
}

function getTargetMoleculeName() {
  if (session.scene.molecules.length === 0) return null;
  return findTargetMolecule().name;
}

function getMoleculeCOM(mol) {
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < mol.atomCount; i++) {
    const [x, y, z] = physics.getPosition(mol.atomOffset + i);
    cx += x; cy += y; cz += z;
  }
  cx /= mol.atomCount; cy /= mol.atomCount; cz /= mol.atomCount;
  return [cx, cy, cz];
}

function getMoleculeRadius(mol, com) {
  let maxR = 0;
  for (let i = 0; i < mol.atomCount; i++) {
    const [x, y, z] = physics.getPosition(mol.atomOffset + i);
    const d = Math.sqrt((x-com[0])**2 + (y-com[1])**2 + (z-com[2])**2);
    if (d > maxR) maxR = d;
  }
  return maxR;
}

// --- Placement input handling ---
let _placementListeners = null;

/** Recompute placement plane from current camera, keeping preview at same world position. */
function _refreshPlacementPlane() {
  const camDir = new THREE.Vector3();
  renderer.camera.getWorldDirection(camDir);
  const center = renderer.getPreviewWorldCenter();
  session.placement.placementPlane = {
    normal: camDir.clone(),
    point: new THREE.Vector3(center[0], center[1], center[2]),
  };
}

function registerPlacementListeners() {
  const canvas = renderer.getCanvas();
  const handlers = {
    pointerdown: (e) => {
      if (e.button !== 0) return; // primary pointer only
      const hit = renderer.raycastPreview(e.clientX, e.clientY);
      if (hit.hit) {
        e.stopPropagation();
        e.preventDefault();
        session.placement.isDraggingPreview = true;
        // Recompute placement plane from current camera (may have changed since placement start)
        _refreshPlacementPlane();
        // Compute grab offset projected onto placement plane
        const center = renderer.getPreviewWorldCenter();
        const pp = session.placement.placementPlane;
        const dx = hit.worldPoint[0] - center[0];
        const dy = hit.worldPoint[1] - center[1];
        const dz = hit.worldPoint[2] - center[2];
        const dot = dx * pp.normal.x + dy * pp.normal.y + dz * pp.normal.z;
        session.placement.grabOffset = [
          dx - dot * pp.normal.x,
          dy - dot * pp.normal.y,
          dz - dot * pp.normal.z,
        ];
      }
      // If miss, let propagate (camera)
    },
    pointermove: (e) => {
      if (!session.placement.isDraggingPreview) return;
      e.stopPropagation();
      // Project pointer onto placement plane
      const pp = session.placement.placementPlane;
      const ndc = new THREE.Vector2(
        ((e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth) * 2 - 1,
        -((e.clientY - canvas.getBoundingClientRect().top) / canvas.clientHeight) * 2 + 1
      );
      renderer.camera.updateMatrixWorld(true);
      const rayOrigin = renderer.camera.position.clone();
      const rayDir = new THREE.Vector3(ndc.x, ndc.y, 0.5)
        .unproject(renderer.camera).sub(rayOrigin).normalize();
      const denom = rayDir.dot(pp.normal);
      if (Math.abs(denom) < 1e-10) return;
      const diff = pp.point.clone().sub(rayOrigin);
      const t = diff.dot(pp.normal) / denom;
      const worldPos = rayOrigin.add(rayDir.multiplyScalar(t));
      // Apply grab offset
      const go = session.placement.grabOffset;
      const newOffset = [worldPos.x - go[0], worldPos.y - go[1], worldPos.z - go[2]];
      session.placement.previewOffset = newOffset;
      renderer.updatePreviewOffset(newOffset);
    },
    pointerup: (e) => {
      if (session.placement.isDraggingPreview) {
        session.placement.isDraggingPreview = false;
      }
      // Always let propagate (OrbitControls needs pointerup)
    },
    touchstart: (e) => {
      if (e.touches.length !== 1) {
        // 2+ fingers: cancel preview drag, let camera handle
        if (session.placement.isDraggingPreview) {
          session.placement.isDraggingPreview = false;
        }
        return;
      }
      const touch = e.touches[0];
      const hit = renderer.raycastPreview(touch.clientX, touch.clientY);
      if (hit.hit) {
        e.stopPropagation();
        e.preventDefault();
        session.placement.isDraggingPreview = true;
        _refreshPlacementPlane();
        const center = renderer.getPreviewWorldCenter();
        const pp = session.placement.placementPlane;
        const dx = hit.worldPoint[0] - center[0];
        const dy = hit.worldPoint[1] - center[1];
        const dz = hit.worldPoint[2] - center[2];
        const dot = dx * pp.normal.x + dy * pp.normal.y + dz * pp.normal.z;
        session.placement.grabOffset = [
          dx - dot * pp.normal.x,
          dy - dot * pp.normal.y,
          dz - dot * pp.normal.z,
        ];
      }
    },
    touchmove: (e) => {
      if (!session.placement.isDraggingPreview || e.touches.length !== 1) return;
      e.stopPropagation();
      e.preventDefault();
      const touch = e.touches[0];
      const pp = session.placement.placementPlane;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((touch.clientX - rect.left) / rect.width) * 2 - 1,
        -((touch.clientY - rect.top) / rect.height) * 2 + 1
      );
      renderer.camera.updateMatrixWorld(true);
      const rayOrigin = renderer.camera.position.clone();
      const rayDir = new THREE.Vector3(ndc.x, ndc.y, 0.5)
        .unproject(renderer.camera).sub(rayOrigin).normalize();
      const denom = rayDir.dot(pp.normal);
      if (Math.abs(denom) < 1e-10) return;
      const diff = pp.point.clone().sub(rayOrigin);
      const t = diff.dot(pp.normal) / denom;
      const worldPos = rayOrigin.add(rayDir.multiplyScalar(t));
      const go = session.placement.grabOffset;
      const newOffset = [worldPos.x - go[0], worldPos.y - go[1], worldPos.z - go[2]];
      session.placement.previewOffset = newOffset;
      renderer.updatePreviewOffset(newOffset);
    },
    touchend: (e) => {
      if (e.touches.length === 0 && session.placement.isDraggingPreview) {
        session.placement.isDraggingPreview = false;
      }
    },
    pointercancel: (_e) => {
      session.placement.isDraggingPreview = false;
    },
    pointerleave: (_e) => {
      session.placement.isDraggingPreview = false;
    },
    touchcancel: (_e) => {
      session.placement.isDraggingPreview = false;
    },
  };
  // Register in capture phase
  canvas.addEventListener('pointerdown', handlers.pointerdown, { capture: true });
  canvas.addEventListener('pointermove', handlers.pointermove, { capture: true });
  canvas.addEventListener('pointerup', handlers.pointerup, { capture: true });
  canvas.addEventListener('pointercancel', handlers.pointercancel, { capture: true });
  canvas.addEventListener('pointerleave', handlers.pointerleave, { capture: true });
  canvas.addEventListener('touchstart', handlers.touchstart, { capture: true, passive: false });
  canvas.addEventListener('touchmove', handlers.touchmove, { capture: true, passive: false });
  canvas.addEventListener('touchend', handlers.touchend, { capture: true });
  canvas.addEventListener('touchcancel', handlers.touchcancel, { capture: true });
  _placementListeners = handlers;
}

function unregisterPlacementListeners() {
  if (!_placementListeners) return;
  const canvas = renderer.getCanvas();
  canvas.removeEventListener('pointerdown', _placementListeners.pointerdown, { capture: true });
  canvas.removeEventListener('pointermove', _placementListeners.pointermove, { capture: true });
  canvas.removeEventListener('pointerup', _placementListeners.pointerup, { capture: true });
  canvas.removeEventListener('pointercancel', _placementListeners.pointercancel, { capture: true });
  canvas.removeEventListener('pointerleave', _placementListeners.pointerleave, { capture: true });
  canvas.removeEventListener('touchstart', _placementListeners.touchstart, { capture: true });
  canvas.removeEventListener('touchmove', _placementListeners.touchmove, { capture: true });
  canvas.removeEventListener('touchend', _placementListeners.touchend, { capture: true });
  canvas.removeEventListener('touchcancel', _placementListeners.touchcancel, { capture: true });
  _placementListeners = null;
}

// --- Input manager ---
function syncInputManager() {
  if (!inputManager) createInputManager();
  inputManager.updateAtomMeshes(renderer.atomMeshes);
}

function updateStatus(text) {
  document.getElementById('status').textContent = text;
}

function createInputManager() {
  inputManager = new InputManager(
    renderer.getCanvas(),
    renderer.camera,
    renderer.controls,
    renderer.atomMeshes,
    {
      onHover: (atomIdx) => {
        if (session.placement.active) return;
        const cmd = atomIdx >= 0
          ? stateMachine.onPointerOverAtom(atomIdx)
          : stateMachine.onPointerOutAtom();
        if (cmd) handleCommand(cmd);
      },
      onPointerDown: (atomIdx, sx, sy, isRotate) => {
        if (session.placement.active) return;
        const mode = isRotate ? 'rotate' : session.interactionMode;
        const cmd = stateMachine.onPointerDown(atomIdx, sx, sy, mode);
        if (cmd) handleCommand(cmd, sx, sy);
      },
      onPointerMove: (sx, sy) => {
        if (session.placement.active) return;
        const cmd = stateMachine.onPointerMove(sx, sy);
        if (cmd) handleCommand(cmd, sx, sy);
      },
      onPointerUp: () => {
        if (session.placement.active) return;
        const cmd = stateMachine.onPointerUp();
        if (cmd) handleCommand(cmd);
      },
    }
  );
}

// --- Screen-to-physics projection ---
const _atomRenderPos = new THREE.Vector3();

function screenToPhysics(atomIdx, sx, sy) {
  const meshPos = renderer.atomMeshes[atomIdx].position;
  const atomRenderPos = _atomRenderPos.set(meshPos.x, meshPos.y, meshPos.z);
  return inputManager.screenToWorldOnAtomPlane(sx, sy, atomRenderPos);
}

// Fade out the onboarding hint on first interaction
let hintFaded = false;
function fadeHint() {
  if (hintFaded) return;
  hintFaded = true;
  const hint = document.getElementById('hint');
  if (hint) {
    hint.classList.add('fade');
    setTimeout(() => { hint.style.display = 'none'; }, 2000);
  }
}

function handleCommand(cmd, screenX, screenY) {
  switch (cmd.action) {
    case 'highlight':
      renderer.setHighlight(cmd.atom);
      break;

    case 'clearHighlight':
      renderer.setHighlight(-1);
      break;

    case 'startDrag': {
      fadeHint();
      const ai = cmd.atom;
      physics.startDrag(ai);
      renderer.setHighlight(ai);
      if (screenX !== undefined) {
        const target = screenToPhysics(ai, screenX, screenY);
        renderer.showForceLine(ai, target[0], target[1], target[2]);
      }
      break;
    }

    case 'updateDrag': {
      if (stateMachine.getSelectedAtom() < 0) break;
      const atomIdx = stateMachine.getSelectedAtom();
      const target = screenToPhysics(atomIdx, cmd.screenX, cmd.screenY);
      physics.updateDrag(target[0], target[1], target[2]);
      renderer.showForceLine(atomIdx, target[0], target[1], target[2]);
      break;
    }

    case 'endDrag':
      physics.endDrag();
      renderer.clearFeedback();
      break;

    case 'flick': {
      physics.endDrag();
      const scale = 0.002;
      physics.applyImpulse(cmd.atom, cmd.vx * scale, -cmd.vy * scale);
      renderer.clearFeedback();
      break;
    }

    case 'startMove': {
      fadeHint();
      const ai = cmd.atom;
      physics.startTranslate(ai);
      renderer.setHighlight(ai);
      updateStatus('Moving molecule');
      if (screenX !== undefined) {
        const target = screenToPhysics(ai, screenX, screenY);
        renderer.showForceLine(ai, target[0], target[1], target[2]);
      }
      break;
    }

    case 'updateMove': {
      if (stateMachine.getSelectedAtom() < 0) break;
      const atomIdx = stateMachine.getSelectedAtom();
      const target = screenToPhysics(atomIdx, cmd.screenX, cmd.screenY);
      physics.updateDrag(target[0], target[1], target[2]);
      renderer.showForceLine(atomIdx, target[0], target[1], target[2]);
      break;
    }

    case 'endMove':
      physics.endDrag();
      renderer.clearFeedback();
      updateSceneStatus();
      break;

    case 'startRotate': {
      fadeHint();
      const ai = cmd.atom;
      physics.startRotateDrag(ai);
      renderer.setHighlight(ai);
      updateStatus('Rotating molecule');
      if (screenX !== undefined) {
        const target = screenToPhysics(ai, screenX, screenY);
        renderer.showForceLine(ai, target[0], target[1], target[2]);
      }
      break;
    }

    case 'updateRotate': {
      if (stateMachine.getSelectedAtom() < 0) break;
      const atomIdx = stateMachine.getSelectedAtom();
      const target = screenToPhysics(atomIdx, cmd.screenX, cmd.screenY);
      physics.updateDrag(target[0], target[1], target[2]);
      renderer.showForceLine(atomIdx, target[0], target[1], target[2]);
      break;
    }

    case 'endRotate':
      physics.endDrag();
      renderer.clearFeedback();
      updateSceneStatus();
      break;

    case 'cancelInteraction':
      physics.endDrag();
      renderer.clearFeedback();
      break;

    case 'forceIdle':
      physics.endDrag();
      renderer.clearFeedback();
      break;
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

// --- Mobile status tap-to-expand ---
let _fpsExpanded = false;
let _fpsExpandTimer = null;

// --- Speed button state sync ---
function updateSpeedControls() {
  const max = session.playback.maxSpeed;
  const warm = scheduler.warmUpComplete;
  document.querySelectorAll('.speed-btn').forEach(btn => {
    const val = btn.dataset.speed;
    if (val === 'max') {
      btn.style.opacity = '';
      btn.disabled = false;
    } else if (!warm) {
      btn.style.opacity = '0.4';
      btn.disabled = true;
    } else {
      const spd = parseFloat(val);
      btn.style.opacity = spd > max ? '0.4' : '';
      btn.disabled = spd > max;
    }
  });
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
    const shouldStep = !session.playback.paused && !session.placement.active && physics.n > 0;
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
    if (renderer.atomMeshes.length > 0 && physics.n > 0) {
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

    // Update status display
    const pb = session.playback;
    const isIdle = pb.paused || session.placement.active || physics.n === 0;
    const displaySpeed = isIdle ? 0 : pb.effectiveSpeed;
    const mdRate = displaySpeed * CONFIG.playback.baseStepsPerSecond * CONFIG.physics.dt / 1000;
    const fps = Math.round(1000 / scheduler.prof.rafIntervalMs);
    const detail = `${scheduler.prof.rafIntervalMs.toFixed(1)} ms · ${fps} fps`;

    // Mobile: compact by default, detail on tap (via _fpsExpanded flag)
    // Layout-driven: use viewport width as the stable layout constraint
    const isCompact = window.innerWidth < 768;
    const showDetail = !isCompact || _fpsExpanded;

    let statusText;
    if (pb.paused) {
      statusText = showDetail ? `Paused · ${detail}` : 'Paused · 0 ps/s';
    } else if (session.placement.active) {
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

  } catch (e) {
    console.error('[frameLoop] ERROR:', e);
  }
  requestAnimationFrame(frameLoop);
}

// --- UI Theme ---
function applyUITheme(name) {
  const t = THEMES[name];
  const bar = document.getElementById('controls');
  bar.style.background = t.uiBg;
  bar.style.borderTopColor = t.uiBorder;
  bar.querySelectorAll('button:not(.mode-btn)').forEach(b => {
    b.style.color = t.uiText;
    b.style.background = t.uiBtn;
    b.style.borderColor = t.uiBorder;
  });
  bar.querySelectorAll('select').forEach(s => {
    s.style.color = t.uiText;
    s.style.background = t.uiBtn;
    s.style.borderColor = t.uiBorder;
  });
  bar.querySelectorAll('label, span').forEach(el => {
    el.style.color = t.uiMuted;
  });
  bar.querySelectorAll('.mode-btn').forEach(b => {
    b.style.borderColor = t.uiBorder;
    if (b.classList.contains('active')) {
      b.style.color = '';
      b.style.background = '';
    } else {
      b.style.color = t.uiMuted;
      b.style.background = t.uiBtn;
    }
  });

  const info = document.getElementById('info');
  info.style.background = t.uiBg;
  info.style.borderColor = t.uiBorder;
  info.querySelectorAll('*').forEach(el => {
    el.style.color = t.uiText;
  });
  document.getElementById('status').style.color = t.uiMuted;
  document.getElementById('fps').style.color = t.uiMuted;
}

// --- Start ---
init();
