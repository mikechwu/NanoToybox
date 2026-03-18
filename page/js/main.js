/**
 * NanoToybox Interactive Page — Entry Point
 *
 * Wires together: loader, physics, state machine, input, renderer, FPS monitor.
 * Runs the 8-step frame loop as defined in the UX contract.
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

const session = {
  atoms: null,
  structureFile: null,
  theme: 'dark',
  isLoading: false,
};

// --- Initialization ---
async function init() {
  const container = document.getElementById('container');
  renderer = new Renderer(container);
  physics = new PhysicsEngine();
  stateMachine = new StateMachine();
  fpsMonitor = new FPSMonitor(document.getElementById('fps'));

  renderer.applyTheme(session.theme);

  // Load manifest and populate structure selector
  try {
    const manifest = await loadManifest();
    const selector = document.getElementById('structure-select');

    // Sort by atom count for logical ordering
    const entries = Object.entries(manifest).sort((a, b) => a[1].n_atoms - b[1].n_atoms);

    for (const [key, info] of entries) {
      const opt = document.createElement('option');
      opt.value = info.file;
      opt.textContent = `${info.description} (${info.n_atoms} atoms)`;
      opt.dataset.key = key;
      selector.appendChild(opt);
    }

    selector.addEventListener('change', () => loadSelected(selector.value));

    // Load first structure
    if (entries.length > 0) {
      // Default to c60 if available, otherwise first
      const c60Entry = entries.find(([k]) => k === 'c60');
      const defaultFile = c60Entry ? c60Entry[1].file : entries[0][1].file;
      selector.value = defaultFile;
      await loadSelected(defaultFile);
    }
  } catch (e) {
    document.getElementById('status').textContent = 'Failed to load structures. Serve from repo root.';
    console.error(e);
    return;
  }

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    session.theme = session.theme === 'dark' ? 'light' : 'dark';
    renderer.applyTheme(session.theme);
    applyUITheme(session.theme);
  });

  // Reset structure button
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (session.atoms) {
      physics.reset(session.atoms);
      stateMachine.forceIdle();
      renderer.clearFeedback();
    }
  });

  // Reset camera view button
  document.getElementById('btn-reset-view').addEventListener('click', () => {
    renderer.resetView();
  });

  // Advanced settings panel
  const advPanel = document.getElementById('advanced-panel');
  document.getElementById('btn-advanced').addEventListener('click', () => {
    advPanel.style.display = advPanel.style.display === 'none' ? 'block' : 'none';
  });
  // Close panel when clicking outside
  document.addEventListener('pointerdown', (e) => {
    if (advPanel.style.display !== 'none' &&
        !advPanel.contains(e.target) &&
        e.target.id !== 'btn-advanced') {
      advPanel.style.display = 'none';
    }
  });

  // Help panel buttons
  document.getElementById('btn-help-open').addEventListener('click', () => {
    document.getElementById('help').style.display = 'block';
  });
  document.getElementById('btn-help-close').addEventListener('click', () => {
    document.getElementById('help').style.display = 'none';
  });

  // Drag strength slider
  const dragSlider = document.getElementById('drag-strength');
  const dragVal = document.getElementById('drag-val');
  dragSlider.addEventListener('input', () => {
    const v = parseFloat(dragSlider.value);
    physics.setDragStrength(v);
    dragVal.textContent = v.toFixed(1);
  });

  // Rotate strength slider
  const rotSlider = document.getElementById('rotate-strength');
  const rotVal = document.getElementById('rotate-val');
  rotSlider.addEventListener('input', () => {
    const v = parseFloat(rotSlider.value);
    physics.setRotateStrength(v);
    rotVal.textContent = v.toFixed(0);
  });

  // Damping slider — cubic log scale for perceptually linear control
  // Slider 0 → damping 0 (NVE, no energy drain)
  // Slider 50 → damping 0.0625 (mild friction)
  // Slider 100 → damping 0.5 (heavy drag)
  const dampSlider = document.getElementById('damping-slider');
  const dampVal = document.getElementById('damping-val');
  dampSlider.addEventListener('input', () => {
    const t = parseFloat(dampSlider.value) / 100; // 0..1
    const damping = t === 0 ? 0 : 0.5 * t * t * t; // cubic: 0 at 0, 0.5 at 1
    physics.setDamping(damping);
    if (damping === 0) {
      dampVal.textContent = 'None';
    } else if (damping < 0.001) {
      dampVal.textContent = damping.toExponential(0);
    } else {
      dampVal.textContent = damping.toFixed(3);
    }
  });

  // Start frame loop
  requestAnimationFrame(frameLoop);
}

async function loadSelected(filename) {
  session.isLoading = true;
  session.structureFile = filename;
  updateStatus('Loading...');

  try {
    const { atoms, bonds } = await loadStructure(filename);
    if (DEBUG_LOAD) console.log(`[load] Parsed: ${atoms.length} atoms, ${bonds.length} bonds`);
    if (DEBUG_LOAD && atoms.length > 0) {
      console.log(`[load] First atom: (${atoms[0].x.toFixed(3)}, ${atoms[0].y.toFixed(3)}, ${atoms[0].z.toFixed(3)})`);
    }
    session.atoms = atoms;
    cleanupCurrentSession();
    initPhysicsSession(atoms, bonds);
    initRendererSession(atoms, bonds);
    syncInputManager();
    updateStatus(`${atoms.length} atoms · ${bonds.length} bonds`);
  } catch (e) {
    updateStatus(`Error: ${e.message}`);
    console.error(e);
  }

  session.isLoading = false;
}

function cleanupCurrentSession() {
  handleCommand(stateMachine.forceIdle());
  renderer.clearFeedback();
}

function initPhysicsSession(atoms, bonds) {
  physics.init(atoms, bonds);
  if (DEBUG_LOAD) console.log(`[load] Physics initialized: n=${physics.n}`);
}

function initRendererSession(atoms, bonds) {
  renderer.loadStructure(atoms, bonds);
  if (DEBUG_LOAD) console.log(`[load] Renderer loaded: ${renderer.atomMeshes.length} atom meshes, ${renderer.bondMeshes.length} bond meshes`);
}

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
        const cmd = atomIdx >= 0
          ? stateMachine.onPointerOverAtom(atomIdx)
          : stateMachine.onPointerOutAtom();
        if (cmd) handleCommand(cmd);
      },
      onPointerDown: (atomIdx, sx, sy, isRotate) => {
        const cmd = stateMachine.onPointerDown(atomIdx, sx, sy, isRotate);
        if (cmd) handleCommand(cmd, sx, sy);
      },
      onPointerMove: (sx, sy) => {
        const cmd = stateMachine.onPointerMove(sx, sy);
        if (cmd) handleCommand(cmd, sx, sy);
      },
      onPointerUp: () => {
        const cmd = stateMachine.onPointerUp();
        if (cmd) handleCommand(cmd);
      },
    }
  );
}

/**
 * Convert screen click position to physics-space 3D coordinates.
 *
 * Projects the mouse ray onto the camera-perpendicular plane through the atom.
 * This ensures drag/rotation forces are always in the user's visual plane,
 * regardless of camera orientation.
 *
 * The atom mesh lives in render space (centered by comOffset).
 * The result is in physics space (uncentered, matching physics.pos).
 */
function screenToPhysics(atomIdx, sx, sy) {
  // Get atom's render-space position (from the mesh, which is what the user sees)
  const meshPos = renderer.atomMeshes[atomIdx].position;
  const atomRenderPos = new THREE.Vector3(meshPos.x, meshPos.y, meshPos.z);

  // Project screen point onto camera-perpendicular plane through atom (render space)
  const [wx, wy, wz] = inputManager.screenToWorldOnAtomPlane(sx, sy, atomRenderPos);

  // Convert from render space to physics space by adding comOffset
  const [cx, cy, cz] = renderer.comOffset;
  return [wx + cx, wy + cy, wz + cz];
}

// Fade out the onboarding hint on first interaction
let hintFaded = false;
function fadeHint() {
  if (hintFaded) return;
  hintFaded = true;
  const hint = document.getElementById('hint');
  if (hint) {
    hint.classList.add('fade');
    // Remove from DOM after transition completes
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
      // Convert screen velocity to world velocity (approximate)
      const scale = 0.002; // screen px/s → Å/step
      physics.applyImpulse(cmd.atom, cmd.vx * scale, -cmd.vy * scale);
      renderer.clearFeedback();
      break;
    }

    case 'startRotate': {
      fadeHint();
      const ai = cmd.atom;
      physics.startRotateDrag(ai);
      renderer.setHighlight(ai);
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
      // Release — angular momentum persists, Tersoff handles dissipation
      physics.endDrag();
      renderer.clearFeedback();
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

// --- 8-Step Frame Loop ---
function frameLoop(timestamp) {
  fpsMonitor.begin();
  try {
    // Step 1-2: Input and state transitions handled by event callbacks
    // Step 3-6: Physics
    if (physics.n > 0) {
      physics.step();
    }
    // Step 7: Update visual state
    if (renderer.atomMeshes.length > 0 && physics.n > 0) {
      renderer.updatePositions(physics);
    }
    renderer.updateFeedback(stateMachine.getFeedbackState());
    // Step 8: Render
    renderer.render();
  } catch (e) {
    console.error('[frameLoop] ERROR:', e);
  }
  fpsMonitor.end();
  requestAnimationFrame(frameLoop);
}

// --- UI Theme ---
function applyUITheme(name) {
  const t = THEMES[name];
  const bar = document.getElementById('controls');
  bar.style.background = t.uiBg;
  bar.style.borderTopColor = t.uiBorder;
  bar.querySelectorAll('button').forEach(b => {
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
