/**
 * Placement controller — manages molecule preview placement lifecycle.
 *
 * Owns: placement state, preview lifecycle, drag interaction,
 *   canvas placement listeners, structure loading for preview.
 *
 * Listeners: canvas pointer/touch capture-phase (registered/unregistered per placement).
 * Requires destroy() if the app ever needs to tear down placement.
 *
 * Drag contract:
 * - Pointer capture is acquired on pointerdown via setPointerCapture() so drag
 *   continues past canvas/page boundaries. If capture fails, pointerleave aborts.
 * - frame-runtime may move the camera during drag (placement framing assist).
 *   After camera updates, frame-runtime calls updateDragFromLatestPointer() to
 *   reproject the dragged preview from the stored screen coordinates against the
 *   updated camera, keeping the grabbed atom under the cursor continuously.
 * - Drag start is centralized in _beginPreviewDrag(); drag end in _endPreviewDrag().
 *   Reprojection math lives in _reprojectDragAtScreenPoint() (single source of truth).
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

/** Narrow command interface for PlacementController — only methods it actually uses. */
export interface PlacementControllerCommands {
  setDockPlacementMode: (active: boolean) => void;
  commitToScene: (file: string, name: string, atoms: StructureAtom[], bonds: StructureBond[], offset: number[]) => void | Promise<void>;
  updateStatus: (text: string) => void;
  updateSceneStatus: () => void;
  forceIdle: () => void;
  forceRender: () => void;
  buildAtomSource: () => { count: number; getWorldPosition: (i: number, out: THREE.Vector3) => THREE.Vector3; raycastTarget: THREE.Object3D | THREE.InstancedMesh | null };
  getSceneMolecules: () => SceneMolecule[];
}

export class PlacementController {
  _renderer: Renderer;
  _physics: PhysicsEngine;
  _stateMachine: StateMachine;
  _inputManager: InputManager;
  _loadStructure: (filename: string) => Promise<{ atoms: StructureAtom[]; bonds: StructureBond[] }>;
  _commands: PlacementControllerCommands;
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
    /** World-space grab vector: preview center → grabbed point at pointerdown. */
    grabVectorWorld: number[];
    /** World-space preview center at placement start (before any drag offset).
     *  Used to convert absolute solved center back to group displacement. */
    basePreviewCenter: number[];
    /** Latest pointer screen coordinates during drag (for per-frame reprojection). */
    lastPointerScreen: { x: number; y: number } | null;
    /** Pointer ID with active capture (null when no capture held). */
    activePointerId: number | null;
    /** True only when setPointerCapture actually succeeded. Gates pointerleave behavior. */
    hasPointerCapture: boolean;
    lastStructureFile: string | null;
    lastStructureName: string | null;
    lastOffset: number[] | null;
    /** Whether the solver found a feasible non-overlapping placement.
     *  false = fallback placement, may need user adjustment. */
    previewFeasible: boolean;
  };

  constructor({ renderer, physics, stateMachine, inputManager, loadStructure, commands }: {
    renderer: Renderer;
    physics: PhysicsEngine;
    stateMachine: StateMachine;
    inputManager: InputManager;
    loadStructure: (filename: string) => Promise<{ atoms: StructureAtom[]; bonds: StructureBond[] }>;
    commands: PlacementControllerCommands;
  }) {
    this._renderer = renderer;
    this._physics = physics;
    this._stateMachine = stateMachine;
    this._inputManager = inputManager;
    this._loadStructure = loadStructure;
    // Commands: all required at construction
    this._commands = commands;
    // commands.setDockPlacementMode(active)
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
      grabVectorWorld: [0, 0, 0],
      basePreviewCenter: [0, 0, 0],
      lastPointerScreen: null,
      activePointerId: null,
      hasPointerCapture: false,
      lastStructureFile: null,
      lastStructureName: null,
      lastOffset: null,
      previewFeasible: true,
    };
  }

  get active() { return this._state.active; }
  /** Whether the current preview was placed at a validated (non-fallback) position. */
  get previewFeasible() { return this._state.previewFeasible; }
  get loading() { return this._loading; }
  /** Whether a commit is currently in progress (blocks duplicate Place). */
  get isCommitting() { return this._state.isCommitting; }
  /** Current structure file being placed (null if not active). */
  get structureFile() { return this._state.structureFile; }
  /** Current structure name being placed (null if not active). */
  get structureName() { return this._state.structureName; }
  /** Whether the user is currently dragging the preview. */
  get isDraggingPreview() { return this._state.isDraggingPreview; }
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
      this._state.previewFeasible = solverResult.feasible;

      // Set placement plane at the solver's computed center
      const camDir = new THREE.Vector3(...camState.direction);
      this._state.placementPlane = {
        normal: camDir,
        point: new THREE.Vector3(offset[0], offset[1], offset[2]),
      };

      // Show preview: transformed atoms are already in world space, group at origin
      this._renderer.showPreview(solverResult.transformedAtoms, bonds, [0, 0, 0]);

      // Capture base preview center (atoms' world centroid before any drag offset)
      const baseCenter = this._renderer.getPreviewWorldCenter();
      this._state.basePreviewCenter = [baseCenter[0], baseCenter[1], baseCenter[2]];

      // Show placement UI
      this._commands.setDockPlacementMode(true);
      const targetName = this._getTargetMoleculeName();
      if (!this._state.previewFeasible) {
        this._commands.updateStatus(`Placing ${name} · preview placed farther out (could not find a closer safe location)`);
      } else if (targetName) {
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

    this._endPreviewDrag();
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
      this._state.grabVectorWorld = [0, 0, 0];
      this._state.basePreviewCenter = [0, 0, 0];
      this._state.lastPointerScreen = null;
      this._state.activePointerId = null;
      this._state.hasPointerCapture = false;
      this._state.previewFeasible = true;
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

  /**
   * Per-frame drag reprojection: recompute the preview offset from the latest
   * stored pointer screen coordinates and the current camera state. Called by
   * frame-runtime after camera assist so the grabbed atom stays under the cursor
   * even when the camera has moved since the last pointer event.
   */
  updateDragFromLatestPointer(): void {
    if (!this._state.isDraggingPreview || !this._state.lastPointerScreen) return;
    // Clamp pointer to canvas rect for out-of-bounds robustness (captured pointer may be outside)
    const rect = this._renderer.getCanvas().getBoundingClientRect();
    const sx = Math.min(Math.max(this._state.lastPointerScreen.x, rect.left), rect.right);
    const sy = Math.min(Math.max(this._state.lastPointerScreen.y, rect.top), rect.bottom);
    this._reprojectDragAtScreenPoint(sx, sy);
  }

  /**
   * Acquire pointer capture on the canvas for continuous drag past boundaries.
   * On success: sets activePointerId and hasPointerCapture.
   * On failure: both remain empty/false — pointerleave will abort the drag.
   */
  private _acquirePreviewPointerCapture(pointerId: number): void {
    try {
      this._renderer.getCanvas().setPointerCapture(pointerId);
      this._state.activePointerId = pointerId;
      this._state.hasPointerCapture = true;
    } catch (_) {
      this._state.activePointerId = null;
      this._state.hasPointerCapture = false;
    }
  }

  /** Release pointer capture if held. Safe to call when no capture is active. */
  private _releasePreviewPointerCapture(): void {
    if (this._state.activePointerId != null) {
      try { this._renderer.getCanvas().releasePointerCapture(this._state.activePointerId); } catch (_) {}
      this._state.activePointerId = null;
    }
    this._state.hasPointerCapture = false;
  }

  /**
   * Initialize a drag session from a hit-test result. Shared by pointer and
   * touch start paths. Owns: drag state activation, screen coords, grab vector,
   * grabbed-point plane, and pointer capture (when pointerId is provided).
   */
  private _beginPreviewDrag(screenX: number, screenY: number, hitWorldPoint: number[], pointerId?: number): void {
    this._state.isDraggingPreview = true;
    this._state.lastPointerScreen = { x: screenX, y: screenY };
    if (pointerId != null) {
      this._acquirePreviewPointerCapture(pointerId);
    }
    const center = this._renderer.getPreviewWorldCenter();
    this._state.grabVectorWorld = [
      hitWorldPoint[0] - center[0],
      hitWorldPoint[1] - center[1],
      hitWorldPoint[2] - center[2],
    ];
    const grabPt = new THREE.Vector3(hitWorldPoint[0], hitWorldPoint[1], hitWorldPoint[2]);
    this._refreshPlacementPlane(grabPt);
  }

  /** Centralized drag-end cleanup. Owns all drag-session teardown state. */
  private _endPreviewDrag(): void {
    this._releasePreviewPointerCapture();
    this._state.isDraggingPreview = false;
    this._state.lastPointerScreen = null;
  }

  /**
   * Single source of truth for drag reprojection math.
   * Rebuilds the grabbed-point plane from the current camera, intersects the
   * cursor ray, and converts the solved world center to a group displacement.
   */
  private _reprojectDragAtScreenPoint(screenX: number, screenY: number): void {
    const gv = this._state.grabVectorWorld;
    const base = this._state.basePreviewCenter;
    const off = this._state.previewOffset;
    // Current grabbed point = baseCenter + currentOffset + grabVector
    const grabPt = new THREE.Vector3(
      base[0] + off[0] + gv[0],
      base[1] + off[1] + gv[1],
      base[2] + off[2] + gv[2],
    );
    this._refreshPlacementPlane(grabPt);
    const pp = this._state.placementPlane;
    if (!pp) return;
    const ray = this._renderer.screenPointToRay(screenX, screenY);
    const rayOrigin = new THREE.Vector3(...ray.origin);
    const rayDir = new THREE.Vector3(...ray.direction);
    const denom = rayDir.dot(pp.normal);
    if (Math.abs(denom) < 1e-10) return;
    const diff = pp.point.clone().sub(rayOrigin);
    const t = diff.dot(pp.normal) / denom;
    const worldPos = rayOrigin.add(rayDir.multiplyScalar(t));
    // newOffset = (rayPlaneHit - grabVector) - basePreviewCenter
    const newOffset = [
      worldPos.x - gv[0] - base[0],
      worldPos.y - gv[1] - base[1],
      worldPos.z - gv[2] - base[2],
    ];
    this._state.previewOffset = newOffset;
    this._renderer.updatePreviewOffset(newOffset);
  }

  /**
   * Rebuild the placement plane normal from the current camera direction.
   * The plane passes through `worldPoint` (the grabbed point, not the preview center).
   */
  private _refreshPlacementPlane(worldPoint?: THREE.Vector3) {
    const camState = this._renderer.getCameraState();
    const normal = new THREE.Vector3(...camState.direction);
    const point = worldPoint ?? (() => {
      const c = this._renderer.getPreviewWorldCenter();
      return new THREE.Vector3(c[0], c[1], c[2]);
    })();
    this._state.placementPlane = { normal, point };
  }

  private _registerListeners() {
    const canvas = this._renderer.getCanvas();
    const self = this;
    const handlers = {
      pointerdown: (e) => {
        if (self._state.isCommitting) return;
        if (e.button !== 0) return;
        const hit = self._renderer.raycastPreview(e.clientX, e.clientY);
        if (hit.hit) {
          e.stopPropagation();
          e.preventDefault();
          self._beginPreviewDrag(e.clientX, e.clientY, hit.worldPoint, e.pointerId);
        }
      },
      pointermove: (e) => {
        if (self._state.isCommitting || !self._state.isDraggingPreview) return;
        e.stopPropagation();
        self._state.lastPointerScreen = { x: e.clientX, y: e.clientY };
        self._reprojectDragAtScreenPoint(e.clientX, e.clientY);
      },
      pointerup: (_e) => {
        if (self._state.isDraggingPreview) {
          self._endPreviewDrag();
        }
      },
      touchstart: (e) => {
        if (self._state.isCommitting) return;
        if (e.touches.length !== 1) {
          if (self._state.isDraggingPreview) self._endPreviewDrag();
          return;
        }
        const touch = e.touches[0];
        const hit = self._renderer.raycastPreview(touch.clientX, touch.clientY);
        if (hit.hit) {
          e.stopPropagation();
          e.preventDefault();
          self._beginPreviewDrag(touch.clientX, touch.clientY, hit.worldPoint);
        }
      },
      touchmove: (e) => {
        if (self._state.isCommitting || !self._state.isDraggingPreview || e.touches.length !== 1) return;
        e.stopPropagation();
        e.preventDefault();
        const touch = e.touches[0];
        self._state.lastPointerScreen = { x: touch.clientX, y: touch.clientY };
        self._reprojectDragAtScreenPoint(touch.clientX, touch.clientY);
      },
      touchend: (e) => {
        if (e.touches.length === 0 && self._state.isDraggingPreview) {
          self._endPreviewDrag();
        }
      },
      pointercancel: (_e) => {
        if (self._state.isDraggingPreview) self._endPreviewDrag();
      },
      pointerleave: (_e) => {
        if (self._state.isDraggingPreview) {
          // If pointer capture is active, drag continues — pointerleave is just
          // the cursor leaving the element boundary. If capture failed, abort drag.
          if (!self._state.hasPointerCapture) {
            self._endPreviewDrag();
          }
        } else {
          self._state.lastPointerScreen = null;
        }
      },
      touchcancel: (_e) => {
        if (self._state.isDraggingPreview) self._endPreviewDrag();
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

  private _unregisterListeners() {
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
