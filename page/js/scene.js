/**
 * Scene management — commit, clear, and load operations.
 * All dependencies are passed as parameters. This module does not import
 * session, physics, or renderer directly.
 */
import { CONFIG } from './config.js';

const DEBUG_LOAD = CONFIG.debug.load;

/**
 * Transaction-safe molecule commit to physics + renderer.
 * Side effects are dispatched via the callbacks object.
 *
 * @param {object} physics - PhysicsEngine instance
 * @param {object} renderer - Renderer instance
 * @param {string} filename - structure file name
 * @param {string} name - display name
 * @param {Array} atoms - atom array [{x,y,z}, ...]
 * @param {Array} bonds - bond array [[i,j,d], ...]
 * @param {Array} offset - [x,y,z] placement offset
 * @param {object} sceneState - session.scene (molecules, totalAtoms, nextId)
 * @param {object} callbacks - { syncInput, resetProfiler, fitCamera, updateSceneStatus }
 */
export function commitMolecule(physics, renderer, filename, name, atoms, bonds, offset, sceneState, callbacks) {
  const isFirstMolecule = sceneState.molecules.length === 0;
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
    physics.updateWallCenter(atoms, offset);
    physics.updateWallRadius();
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
    id: sceneState.nextId++,
    name: name,
    structureFile: filename,
    atomCount: result.atomCount,
    atomOffset: result.atomOffset,
    localAtoms: atoms,
    localBonds: bonds,
  };
  sceneState.molecules.push(mol);
  sceneState.totalAtoms += result.atomCount;
  callbacks.syncInput();
  if (DEBUG_LOAD) {
    const cap = renderer.getCapacityInfo();
    console.log(`[load] Renderer capacity: atoms=${cap.atomCount}/${cap.atomCapacity} bonds=${cap.bondActive}/${cap.bondCapacity}`);
  }
  // Partial profiler reset: scene cost changed
  callbacks.resetProfiler();

  if (isFirstMolecule) {
    callbacks.fitCamera();
  }
  callbacks.updateSceneStatus();
}

/**
 * Clear all molecules from the scene.
 * @param {object} physics - PhysicsEngine instance
 * @param {object} renderer - Renderer instance
 * @param {object} stateMachine - StateMachine instance
 * @param {object} sceneState - session.scene
 * @param {object} callbacks - { invalidatePlacement, exitPlacement, forceIdle, syncInput, resetCamera, resetScheduler, updateSceneStatus, updateDockLabel }
 */
export function clearPlayground(physics, renderer, stateMachine, sceneState, callbacks) {
  callbacks.invalidatePlacement();
  callbacks.exitPlacement();
  callbacks.forceIdle();
  renderer.clearFeedback();
  renderer.clearAllMeshes();
  physics.clearScene();
  sceneState.molecules = [];
  sceneState.nextId = 1;
  sceneState.totalAtoms = 0;
  callbacks.syncInput();
  renderer.resetCamera();
  callbacks.resetScheduler();
  callbacks.updateSceneStatus();
  callbacks.updateDockLabel();
}

/**
 * Load a structure and add it to the scene. Used for initial auto-load.
 * @param {string} filename
 * @param {string} name
 * @param {Array} offset - [x,y,z]
 * @param {object} deps - { loadStructure, physics, renderer, sceneState, commitCallbacks, updateStatus, setLoading }
 */
export async function addMoleculeToScene(filename, name, offset, deps) {
  deps.setLoading(true);
  deps.updateStatus('Loading...');
  try {
    const { atoms, bonds } = await deps.loadStructure(filename);
    if (DEBUG_LOAD) console.log(`[add] ${name}: ${atoms.length} atoms, ${bonds.length} bonds`);
    commitMolecule(deps.physics, deps.renderer, filename, name, atoms, bonds, offset, deps.sceneState, deps.commitCallbacks);
  } catch (e) {
    deps.updateStatus(`Error: ${e.message}`);
    console.error(e);
  }
  deps.setLoading(false);
}
