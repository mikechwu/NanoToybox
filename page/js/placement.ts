/**
 * Placement controller — manages molecule preview placement lifecycle.
 *
 * Owns: placement state, preview lifecycle, tangent computation,
 *   canvas placement listeners, structure loading for preview.
 *
 * Listeners: canvas pointer/touch capture-phase (registered/unregistered per placement).
 * Requires destroy() if the app ever needs to tear down placement.
 */
import * as THREE from 'three';
import { CONFIG } from './config';
import type { Renderer } from './renderer';
import type { PhysicsEngine } from './physics';
import type { StateMachine } from './state-machine';
import type { InputManager } from './input';
import { solvePlacement, type SceneAtom } from './runtime/placement-solver';

/** A parsed atom from an XYZ structure file. */
export interface StructureAtom {
  element: string;
  x: number;
  y: number;
  z: number;
}

/** A bond entry: [atomIndex1, atomIndex2, distance]. */
export type StructureBond = [number, number, number];

/** A molecule record in the scene. */
export interface SceneMolecule {
  id: number;
  name: string;
  structureFile: string;
  atomCount: number;
  atomOffset: number;
}

const DEBUG_LOAD = CONFIG.debug.load;

export class PlacementController {
  _renderer: Renderer;
  _physics: PhysicsEngine;
  _stateMachine: StateMachine;
  _inputManager: InputManager;
  _loadStructure: (filename: string) => Promise<{ atoms: StructureAtom[]; bonds: StructureBond[] }>;
  _commands: {
    setDockPlacementMode: (active: boolean) => void;
    commitToScene: (file: string, name: string, atoms: StructureAtom[], bonds: StructureBond[], offset: number[]) => void | Promise<void>;
    updateStatus: (text: string) => void;
    updateSceneStatus: () => void;
    forceIdle: () => void;
    syncInput: () => void;
    forceRender: () => void;
    buildAtomSource: () => { count: number; getWorldPosition: (i: number, out: THREE.Vector3) => THREE.Vector3; raycastTarget: THREE.Object3D | THREE.InstancedMesh | null };
    getSceneMolecules: () => SceneMolecule[];
    /** Returns true if the physics snapshot is fresh enough for placement computation. */
    isSnapshotFresh: () => boolean;
  };
  _generation: number;
  _commitGeneration: number;
  _loading: boolean;
  _listeners: Record<string, (e: PointerEvent | TouchEvent) => void> | null;
  _state: {
    active: boolean;
    isCommitting: boolean;
    structureFile: string | null;
    structureName: string | null;
    previewAtoms: StructureAtom[] | null;
    previewBonds: StructureBond[] | null;
    previewOffset: number[];
    placementPlane: { normal: THREE.Vector3; point: THREE.Vector3 } | null;
    isDraggingPreview: boolean;
    grabOffset: number[];
    lastStructureFile: string | null;
    lastStructureName: string | null;
    lastOffset: number[] | null;
  };

  constructor({ renderer, physics, stateMachine, inputManager, loadStructure, commands }: {
    renderer: Renderer;
    physics: PhysicsEngine;
    stateMachine: StateMachine;
    inputManager: InputManager;
    loadStructure: (filename: string) => Promise<{ atoms: StructureAtom[]; bonds: StructureBond[] }>;
    commands: PlacementController['_commands'];
  }) {
    this._renderer = renderer;
    this._physics = physics;
    this._stateMachine = stateMachine;
    this._inputManager = inputManager;
    this._loadStructure = loadStructure;
    // Commands: all required at construction
    this._commands = commands;
    // commands.setDockPlacementMode(active)
    // commands.commitToScene(file, name, atoms, bonds, offset)
    // commands.updateStatus(text)
    // commands.updateSceneStatus()
    // commands.forceIdle()
    // commands.syncInput()
    // commands.forceRender()
    // commands.buildAtomSource()
    // commands.getSceneMolecules()

    // Internal state
    this._generation = 0;
    this._commitGeneration = 0;
    this._loading = false;
    this._listeners = null;

    // Placement state (mirrors session.placement structure)
    this._state = {
      active: false,
      isCommitting: false,
      structureFile: null,
      structureName: null,
      previewAtoms: null,
      previewBonds: null,
      previewOffset: [0, 0, 0],
      placementPlane: null,
      isDraggingPreview: false,
      grabOffset: [0, 0, 0],
      lastStructureFile: null,
      lastStructureName: null,
      lastOffset: null,
    };
  }

  get active() { return this._state.active; }
  get loading() { return this._loading; }
  hasLastStructure() { return !!this._state.lastStructureFile; }
  getLastStructureFile() { return this._state.lastStructureFile; }
  getLastStructureName() { return this._state.lastStructureName; }

  async start(filename: string, name: string) {
    // Fully clean up any existing placement before starting a new one
    if (this._state.active) {
      this.exit(false);
    }

    // Increment generation before async load — any load that resolves
    // with a stale generation is silently discarded
    const myGeneration = ++this._generation;

    // Load structure for preview
    this._loading = true;
    this._commands.updateStatus(`Loading ${name}...`);
    try {
      const { atoms, bonds } = await this._loadStructure(filename);
      this._loading = false;

      // Discard if a newer start call was made during the load
      if (myGeneration !== this._generation) {
        if (DEBUG_LOAD) console.log(`[placement] Discarded stale load for ${name} (gen ${myGeneration} vs ${this._generation})`);
        return;
      }

      // Cleanup any active simulation interaction
      this._commands.forceIdle();
      this._renderer.clearFeedback();
      if (this._inputManager) this._inputManager.updateAtomSource(this._commands.buildAtomSource());

      this._state.active = true;
      this._state.structureFile = filename;
      this._state.structureName = name;
      this._state.previewAtoms = atoms;
      this._state.previewBonds = bonds;
      this._state.isDraggingPreview = false;

      // Compute preview bounding radius
      let pcx = 0, pcy = 0, pcz = 0;
      atoms.forEach(a => { pcx += a.x; pcy += a.y; pcz += a.z; });
      pcx /= atoms.length; pcy /= atoms.length; pcz /= atoms.length;
      let pR = 0;
      atoms.forEach(a => {
        const d = Math.sqrt((a.x-pcx)**2 + (a.y-pcy)**2 + (a.z-pcz)**2);
        if (d > pR) pR = d;
      });

      // Solve placement via rigid-transform solver
      const camState = this._renderer.getCameraState();
      const sceneMols = this._commands.getSceneMolecules();
      const sceneAtoms: SceneAtom[] = [];
      const physics = this._physics;
      for (let i = 0; i < physics.n; i++) {
        sceneAtoms.push({ x: physics.pos[i * 3], y: physics.pos[i * 3 + 1], z: physics.pos[i * 3 + 2] });
      }

      // Find target molecule (nearest to viewport center)
      let targetCOM: THREE.Vector3 | undefined;
      let targetRadius: number | undefined;
      if (sceneMols.length > 0) {
        const target = this._findTargetMolecule();
        if (target) {
          const com = this._getMoleculeCOM(target);
          targetCOM = new THREE.Vector3(com[0], com[1], com[2]);
          targetRadius = this._getMoleculeRadius(target, com);
        }
      }

      const solverResult = solvePlacement(atoms, sceneAtoms, physics.n, camState, targetCOM, targetRadius);
      const offset = solverResult.offset;

      // Store pre-transformed atoms (world-space from solver) for preview + commit parity
      this._state.previewAtoms = solverResult.transformedAtoms as StructureAtom[];
      this._state.previewOffset = [0, 0, 0]; // atoms already at world position
      this._state.lastOffset = [0, 0, 0];

      // Set placement plane at the solver's computed center
      const camDir = new THREE.Vector3(...camState.direction);
      this._state.placementPlane = {
        normal: camDir,
        point: new THREE.Vector3(offset[0], offset[1], offset[2]),
      };

      // Show preview: transformed atoms are already in world space, group at origin
      this._renderer.showPreview(solverResult.transformedAtoms, bonds, [0, 0, 0]);

      // Show placement UI
      this._commands.setDockPlacementMode(true);
      const targetName = this._getTargetMoleculeName();
      if (targetName) {
        this._commands.updateStatus(`Placing ${name} near ${targetName} · target: center of view`);
      } else {
        this._commands.updateStatus(`Placing ${name}`);
      }

      // Register placement listeners
      this._registerListeners();
      this._commands.forceRender();

    } catch (e) {
      this._loading = false;
      // Only handle failure if this is still the current request.
      if (myGeneration !== this._generation) {
        if (DEBUG_LOAD) console.log(`[placement] Ignored stale load error for ${name}`);
        return;
      }
      this._commands.updateStatus(`Error loading preview: ${e.message}`);
      console.error(e);
      this._state.active = false;
    }
  }

  exit(commit: boolean) {
    if (!this._state.active) return;
    // Block duplicate Place presses during async commit, but always allow Cancel
    if (this._state.isCommitting && commit) return;

    this._state.isDraggingPreview = false;
    this._commands.forceRender();

    // Capture data before clearing state — commitMolecule may throw
    const shouldCommit = commit && this._state.previewAtoms;
    // Atoms are pre-transformed to world space by solver. Drag offset (previewOffset)
    // is the group displacement from the user's drag. Bake drag offset into atom
    // positions so commit receives final world-space atoms with zero physics offset.
    let commitData: { file: string | null; name: string | null; atoms: StructureAtom[]; bonds: StructureBond[] | null; offset: number[] } | null = null;
    if (shouldCommit && this._state.previewAtoms) {
      const dragOff = this._state.previewOffset;
      const worldAtoms = this._state.previewAtoms.map(a => ({
        ...a,
        x: a.x + dragOff[0],
        y: a.y + dragOff[1],
        z: a.z + dragOff[2],
      }));
      commitData = {
        file: this._state.structureFile,
        name: this._state.structureName,
        atoms: worldAtoms,
        bonds: this._state.previewBonds,
        offset: [0, 0, 0], // atoms already in final world position
      };
    }

    // Helper: finalize placement exit (called after commit succeeds or on cancel).
    // Tears down listeners + bumps commit generation to invalidate pending async commits.
    const finalize = () => {
      this._commitGeneration++;
      this._state.isCommitting = false;
      this._unregisterListeners();
      this._renderer.hidePreview();
      this._state.active = false;
      this._state.structureFile = null;
      this._state.structureName = null;
      this._state.previewAtoms = null;
      this._state.previewBonds = null;
      this._state.previewOffset = [0, 0, 0];
      this._state.placementPlane = null;
      this._state.grabOffset = [0, 0, 0];
      this._commands.setDockPlacementMode(false);
      this._commands.updateSceneStatus();
    };

    if (!commitData) {
      finalize();
      return;
    }

    try {
      // Mark committing — prevents duplicate Place, freezes preview interaction handlers
      this._state.isCommitting = true;
      const myCommitGen = ++this._commitGeneration;
      const result = this._commands.commitToScene(commitData.file, commitData.name, commitData.atoms, commitData.bonds, commitData.offset);
      if (result && typeof (result as any).then === 'function') {
        // Async path: keep placement active until commit resolves.
        // Use commit generation token to ignore stale promise resolution
        // if the user cancels or starts a new placement before this resolves.
        (result as Promise<void>).then(() => {
          if (myCommitGen !== this._commitGeneration) return; // stale
          this._state.lastStructureFile = commitData.file;
          this._state.lastStructureName = commitData.name;
          finalize();
        }).catch((e: Error) => {
          if (myCommitGen !== this._commitGeneration) return; // stale
          console.error('[placement] Async commit failed:', e);
          this._commands.updateStatus(`Placement failed: ${e.message}`);
          // Recoverable failure: keep placement open, re-enable interaction
          this._state.isCommitting = false;
        });
        return;
      }
      // Sync path: finalize immediately
      this._state.lastStructureFile = commitData.file;
      this._state.lastStructureName = commitData.name;
    } catch (e) {
      console.error('[placement] Commit failed:', e);
      this._commands.updateStatus(`Placement failed: ${(e as Error).message}`);
      // Recoverable failure: keep placement open, re-enable interaction
      this._state.isCommitting = false;
      return;
    }
    finalize();
  }

  /** Cancel pending loads. Called by clearPlayground. */
  invalidatePendingLoads() {
    this._generation++;
    this._loading = false;
  }

  _findTargetMolecule() {
    const molecules = this._commands.getSceneMolecules();
    if (molecules.length === 1) return molecules[0];
    // Nearest projected COM to viewport center
    let best = molecules[0];
    let bestDist = Infinity;
    for (const mol of molecules) {
      const com = this._getMoleculeCOM(mol);
      const proj = this._renderer.projectToNDC([com[0], com[1], com[2]]);
      const d = proj[0] * proj[0] + proj[1] * proj[1];
      if (d < bestDist) { bestDist = d; best = mol; }
    }
    return best;
  }

  _getTargetMoleculeName() {
    const molecules = this._commands.getSceneMolecules();
    if (molecules.length === 0) return null;
    return this._findTargetMolecule().name;
  }

  _getMoleculeCOM(mol) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < mol.atomCount; i++) {
      const [x, y, z] = this._physics.getPosition(mol.atomOffset + i);
      cx += x; cy += y; cz += z;
    }
    cx /= mol.atomCount; cy /= mol.atomCount; cz /= mol.atomCount;
    return [cx, cy, cz];
  }

  _getMoleculeRadius(mol, com) {
    let maxR = 0;
    for (let i = 0; i < mol.atomCount; i++) {
      const [x, y, z] = this._physics.getPosition(mol.atomOffset + i);
      const d = Math.sqrt((x-com[0])**2 + (y-com[1])**2 + (z-com[2])**2);
      if (d > maxR) maxR = d;
    }
    return maxR;
  }

  // --- Placement input handling ---

  /** Recompute placement plane from current camera, keeping preview at same world position. */
  _refreshPlacementPlane() {
    const camState = this._renderer.getCameraState();
    const camDir = new THREE.Vector3(...camState.direction);
    const center = this._renderer.getPreviewWorldCenter();
    this._state.placementPlane = {
      normal: camDir.clone(),
      point: new THREE.Vector3(center[0], center[1], center[2]),
    };
  }

  _registerListeners() {
    const canvas = this._renderer.getCanvas();
    const self = this;
    const handlers = {
      pointerdown: (e) => {
        if (self._state.isCommitting) return; // frozen during async commit
        if (e.button !== 0) return; // primary pointer only
        const hit = self._renderer.raycastPreview(e.clientX, e.clientY);
        if (hit.hit) {
          e.stopPropagation();
          e.preventDefault();
          self._state.isDraggingPreview = true;
          // Recompute placement plane from current camera (may have changed since placement start)
          self._refreshPlacementPlane();
          // Compute grab offset projected onto placement plane
          const center = self._renderer.getPreviewWorldCenter();
          const pp = self._state.placementPlane;
          const dx = hit.worldPoint[0] - center[0];
          const dy = hit.worldPoint[1] - center[1];
          const dz = hit.worldPoint[2] - center[2];
          const dot = dx * pp.normal.x + dy * pp.normal.y + dz * pp.normal.z;
          self._state.grabOffset = [
            dx - dot * pp.normal.x,
            dy - dot * pp.normal.y,
            dz - dot * pp.normal.z,
          ];
        }
        // If miss, let propagate (camera)
      },
      pointermove: (e) => {
        if (self._state.isCommitting || !self._state.isDraggingPreview) return;
        e.stopPropagation();
        // Project pointer onto placement plane
        const pp = self._state.placementPlane;
        const ray = self._renderer.screenPointToRay(e.clientX, e.clientY);
        const rayOrigin = new THREE.Vector3(...ray.origin);
        const rayDir = new THREE.Vector3(...ray.direction);
        const denom = rayDir.dot(pp.normal);
        if (Math.abs(denom) < 1e-10) return;
        const diff = pp.point.clone().sub(rayOrigin);
        const t = diff.dot(pp.normal) / denom;
        const worldPos = rayOrigin.add(rayDir.multiplyScalar(t));
        // Apply grab offset
        const go = self._state.grabOffset;
        const newOffset = [worldPos.x - go[0], worldPos.y - go[1], worldPos.z - go[2]];
        self._state.previewOffset = newOffset;
        self._renderer.updatePreviewOffset(newOffset);
      },
      pointerup: (e) => {
        if (self._state.isDraggingPreview) {
          self._state.isDraggingPreview = false;
        }
        // Always let propagate (OrbitControls needs pointerup)
      },
      touchstart: (e) => {
        if (self._state.isCommitting) return; // frozen during async commit
        if (e.touches.length !== 1) {
          // 2+ fingers: cancel preview drag, let camera handle
          if (self._state.isDraggingPreview) {
            self._state.isDraggingPreview = false;
          }
          return;
        }
        const touch = e.touches[0];
        const hit = self._renderer.raycastPreview(touch.clientX, touch.clientY);
        if (hit.hit) {
          e.stopPropagation();
          e.preventDefault();
          self._state.isDraggingPreview = true;
          self._refreshPlacementPlane();
          const center = self._renderer.getPreviewWorldCenter();
          const pp = self._state.placementPlane;
          const dx = hit.worldPoint[0] - center[0];
          const dy = hit.worldPoint[1] - center[1];
          const dz = hit.worldPoint[2] - center[2];
          const dot = dx * pp.normal.x + dy * pp.normal.y + dz * pp.normal.z;
          self._state.grabOffset = [
            dx - dot * pp.normal.x,
            dy - dot * pp.normal.y,
            dz - dot * pp.normal.z,
          ];
        }
      },
      touchmove: (e) => {
        if (self._state.isCommitting || !self._state.isDraggingPreview || e.touches.length !== 1) return;
        e.stopPropagation();
        e.preventDefault();
        const touch = e.touches[0];
        const pp = self._state.placementPlane;
        const ray = self._renderer.screenPointToRay(touch.clientX, touch.clientY);
        const rayOrigin = new THREE.Vector3(...ray.origin);
        const rayDir = new THREE.Vector3(...ray.direction);
        const denom = rayDir.dot(pp.normal);
        if (Math.abs(denom) < 1e-10) return;
        const diff = pp.point.clone().sub(rayOrigin);
        const t = diff.dot(pp.normal) / denom;
        const worldPos = rayOrigin.add(rayDir.multiplyScalar(t));
        const go = self._state.grabOffset;
        const newOffset = [worldPos.x - go[0], worldPos.y - go[1], worldPos.z - go[2]];
        self._state.previewOffset = newOffset;
        self._renderer.updatePreviewOffset(newOffset);
      },
      touchend: (e) => {
        if (e.touches.length === 0 && self._state.isDraggingPreview) {
          self._state.isDraggingPreview = false;
        }
      },
      pointercancel: (_e) => {
        self._state.isDraggingPreview = false;
      },
      pointerleave: (_e) => {
        self._state.isDraggingPreview = false;
      },
      touchcancel: (_e) => {
        self._state.isDraggingPreview = false;
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
    this._listeners = handlers;
  }

  _unregisterListeners() {
    if (!this._listeners) return;
    const canvas = this._renderer.getCanvas();
    canvas.removeEventListener('pointerdown', this._listeners.pointerdown, { capture: true });
    canvas.removeEventListener('pointermove', this._listeners.pointermove, { capture: true });
    canvas.removeEventListener('pointerup', this._listeners.pointerup, { capture: true });
    canvas.removeEventListener('pointercancel', this._listeners.pointercancel, { capture: true });
    canvas.removeEventListener('pointerleave', this._listeners.pointerleave, { capture: true });
    canvas.removeEventListener('touchstart', this._listeners.touchstart, { capture: true });
    canvas.removeEventListener('touchmove', this._listeners.touchmove, { capture: true });
    canvas.removeEventListener('touchend', this._listeners.touchend, { capture: true });
    canvas.removeEventListener('touchcancel', this._listeners.touchcancel, { capture: true });
    this._listeners = null;
  }

  /** Clean up placement state and listeners. */
  destroy() {
    if (this._state.active) {
      this._unregisterListeners();
      this._renderer.hidePreview();
      this._state.active = false;
    }
    this.invalidatePendingLoads();
  }
}
