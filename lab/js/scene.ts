/**
 * Scene management — commit, clear, and load operations.
 * All dependencies are passed as parameters. This module does not import
 * session, physics, or renderer directly.
 */
import { CONFIG } from './config';
import type { IPhysicsEngine, IRenderer, BondTuple } from '../../src/types/interfaces';
import type { StructureAtom } from './placement';

const DEBUG_LOAD = CONFIG.debug.load;

export interface SceneStateMolecule {
  id: number;
  name: string;
  structureFile: string;
  atomCount: number;
  atomOffset: number;
  localAtoms: StructureAtom[];
  localBonds: BondTuple[];
}

export interface SceneState {
  molecules: SceneStateMolecule[];
  totalAtoms: number;
  nextId: number;
}

/** Deep clone a `SceneState` for rollback capture. Used by the Watch →
 *  Lab hydrate transaction (§7.1): the full contents of `session.scene`
 *  are captured before destructive commits so a mid-transaction failure
 *  can restore the exact pre-call scene without leaking the synthetic
 *  `@watch-handoff` molecule. The clone is deep for `localAtoms` /
 *  `localBonds` so subsequent mutations of the live scene do not touch
 *  the snapshot's arrays. */
export function cloneSceneState(state: SceneState): SceneState {
  return {
    totalAtoms: state.totalAtoms,
    nextId: state.nextId,
    molecules: state.molecules.map((m) => ({
      id: m.id,
      name: m.name,
      structureFile: m.structureFile,
      atomCount: m.atomCount,
      atomOffset: m.atomOffset,
      localAtoms: m.localAtoms.map((a) => ({ element: a.element, x: a.x, y: a.y, z: a.z })),
      localBonds: m.localBonds.map((b) => [b[0], b[1], b[2]] as BondTuple),
    })),
  };
}

/** Atomically replace `target`'s contents with `source`'s. Helper for
 *  the hydrate rollback path: `session.scene` is held by reference
 *  elsewhere (the scene-runtime closure's `sceneState`), so we must
 *  mutate in place rather than reassign. */
export function restoreSceneStateInPlace(target: SceneState, source: SceneState): void {
  target.molecules.length = 0;
  for (const m of source.molecules) {
    target.molecules.push({
      id: m.id,
      name: m.name,
      structureFile: m.structureFile,
      atomCount: m.atomCount,
      atomOffset: m.atomOffset,
      localAtoms: m.localAtoms.map((a) => ({ element: a.element, x: a.x, y: a.y, z: a.z })),
      localBonds: m.localBonds.map((b) => [b[0], b[1], b[2]] as BondTuple),
    });
  }
  target.totalAtoms = source.totalAtoms;
  target.nextId = source.nextId;
}

interface CommitCallbacks {
  syncInput: () => void;
  resetProfiler: () => void;
  fitCamera: () => void;
  updateSceneStatus: () => void;
}

interface ClearCallbacks {
  invalidatePlacement: () => void;
  exitPlacement: () => void;
  forceIdle: () => void;
  syncInput: () => void;
  resetScheduler: () => void;
  updateSceneStatus: () => void;
}

export interface CommitMoleculeResult {
  atomOffset: number;
  atomCount: number;
}

/** Transaction-safe molecule commit to physics + renderer. */
export function commitMolecule(
  physics: IPhysicsEngine,
  renderer: IRenderer,
  filename: string,
  name: string,
  atoms: StructureAtom[],
  bonds: BondTuple[],
  offset: number[],
  sceneState: SceneState,
  callbacks: CommitCallbacks,
): CommitMoleculeResult {
  const isFirstMolecule = sceneState.molecules.length === 0;
  const checkpoint = physics.createCheckpoint();
  const result = physics.appendMolecule(atoms, bonds, offset);

  try {
    // Debug: fault injection and invariant checks inside rollback-protected block
    if (CONFIG.debug.failAfterPhysicsAppend) throw new Error('[debug] Injected post-append failure');
    if (CONFIG.debug.assertions) {
      physics.assertPostAppendInvariants();
    }
    const offsetAtoms = atoms.map(a => ({
      x: a.x + offset[0], y: a.y + offset[1], z: a.z + offset[2]
    }));
    renderer.ensureCapacityForAppend(offsetAtoms.length);
    renderer.populateAppendedAtoms(offsetAtoms, result.atomOffset);
    physics.updateWallCenter(atoms, offset);
    physics.updateWallRadius();
  } catch (e) {
    // Rollback physics to pre-append state
    physics.restoreCheckpoint(checkpoint);
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
  return result;
}

/** Clear all molecules from the scene. */
export function clearPlayground(
  physics: IPhysicsEngine,
  renderer: IRenderer,
  _stateMachine: { forceIdle: () => unknown },
  sceneState: SceneState,
  callbacks: ClearCallbacks,
) {
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
}

interface AddMoleculeDeps {
  loadStructure: (filename: string) => Promise<{ atoms: StructureAtom[]; bonds: BondTuple[] }>;
  physics: IPhysicsEngine;
  renderer: IRenderer;
  sceneState: SceneState;
  commitCallbacks: CommitCallbacks;
  updateStatus: (text: string) => void;
  setLoading: (loading: boolean) => void;
}

/** Load a structure and add it to the scene. Used for initial auto-load. */
export async function addMoleculeToScene(filename: string, name: string, offset: number[], deps: AddMoleculeDeps): Promise<boolean> {
  deps.setLoading(true);
  deps.updateStatus('Loading...');
  let committed = false;
  try {
    const { atoms, bonds } = await deps.loadStructure(filename);
    if (DEBUG_LOAD) console.log(`[add] ${name}: ${atoms.length} atoms, ${bonds.length} bonds`);
    commitMolecule(deps.physics, deps.renderer, filename, name, atoms, bonds, offset, deps.sceneState, deps.commitCallbacks);
    committed = true;
  } catch (e) {
    deps.updateStatus(`Error: ${e.message}`);
    console.error(e);
  }
  deps.setLoading(false);
  return committed;
}
