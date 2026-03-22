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
import { CONFIG } from './config.js';

const DEBUG_LOAD = CONFIG.debug.load;

export class PlacementController {
  constructor({ renderer, physics, stateMachine, inputManager, loadStructure, commands }) {
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
    // commands.updateDockAddLabel()
    // commands.forceIdle()
    // commands.syncInput()
    // commands.forceRender()
    // commands.buildAtomSource()
    // commands.getSceneMolecules()

    // Internal state
    this._generation = 0;
    this._loading = false;
    this._listeners = null;

    // Placement state (mirrors session.placement structure)
    this._state = {
      active: false,
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
    };
  }

  get active() { return this._state.active; }
  get loading() { return this._loading; }
  hasLastStructure() { return !!this._state.lastStructureFile; }
  getLastStructureFile() { return this._state.lastStructureFile; }
  getLastStructureName() { return this._state.lastStructureName; }

  async start(filename, name) {
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

      // Choose placement offset via tangent placement
      const offset = this._computeTangentPlacement(pR);
      this._state.previewOffset = offset;

      // Set placement plane
      const camDir = new THREE.Vector3();
      this._renderer.camera.getWorldDirection(camDir);
      this._state.placementPlane = {
        normal: camDir.clone(),
        point: new THREE.Vector3(offset[0], offset[1], offset[2]),
      };

      // Show preview
      this._renderer.showPreview(atoms, bonds, offset);

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

  exit(commit) {
    if (!this._state.active) return;

    this._unregisterListeners();
    this._state.isDraggingPreview = false;
    this._commands.forceRender();

    // Capture data before clearing state — commitMolecule may throw
    const shouldCommit = commit && this._state.previewAtoms;
    const commitData = shouldCommit ? {
      file: this._state.structureFile,
      name: this._state.structureName,
      atoms: this._state.previewAtoms,
      bonds: this._state.previewBonds,
      offset: [...this._state.previewOffset],
    } : null;

    // Always clean up preview and state, even if commit will fail
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

    if (commitData) {
      try {
        this._commands.commitToScene(commitData.file, commitData.name, commitData.atoms, commitData.bonds, commitData.offset);
        // Only update "last structure" after successful commit
        this._state.lastStructureFile = commitData.file;
        this._state.lastStructureName = commitData.name;
        this._commands.updateDockAddLabel();
      } catch (e) {
        console.error('[placement] Commit failed:', e);
        this._commands.updateStatus(`Error placing molecule: ${e.message}`);
        return;
      }
    }
    this._commands.updateSceneStatus();
  }

  /** Cancel pending loads. Called by clearPlayground. */
  invalidatePendingLoads() {
    this._generation++;
    this._loading = false;
  }

  // --- Tangent placement algorithm ---
  _computeTangentPlacement(previewRadius) {
    const molecules = this._commands.getSceneMolecules();
    if (molecules.length === 0) {
      // Empty scene: place at center of current viewport at a default depth.
      const camPos = this._renderer.camera.position;
      const camDir = new THREE.Vector3();
      this._renderer.camera.getWorldDirection(camDir);
      const defaultDepth = previewRadius * 2.5 + 5;
      return [
        camPos.x + camDir.x * defaultDepth,
        camPos.y + camDir.y * defaultDepth,
        camPos.z + camDir.z * defaultDepth,
      ];
    }

    // Find target molecule: nearest projected COM to viewport center
    const target = this._findTargetMolecule();
    const tCOM = this._getMoleculeCOM(target);
    const tR = this._getMoleculeRadius(target, tCOM);

    // Gap: adaptive, proportional to smaller radius
    const gap = Math.max(1.0, 0.3 * Math.min(tR, previewRadius));
    const tangentDist = tR + previewRadius + gap;

    // Camera-plane directions
    const camRight = new THREE.Vector3();
    const camUp = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this._renderer.camera.getWorldDirection(camDir);
    camRight.crossVectors(camDir, this._renderer.camera.up).normalize();
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
      const proj = new THREE.Vector3(cx, cy, cz).project(this._renderer.camera);
      let score = 0;

      // Viewport margin penalty
      const margin = 0.8;
      if (Math.abs(proj.x) > margin) score += (Math.abs(proj.x) - margin) * 10;
      if (Math.abs(proj.y) > margin) score += (Math.abs(proj.y) - margin) * 10;

      // Overlap penalty with existing molecules
      for (const mol of molecules) {
        const mCOM = this._getMoleculeCOM(mol);
        const mR = this._getMoleculeRadius(mol, mCOM);
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

  _findTargetMolecule() {
    const molecules = this._commands.getSceneMolecules();
    if (molecules.length === 1) return molecules[0];
    // Nearest projected COM to viewport center
    let best = molecules[0];
    let bestDist = Infinity;
    for (const mol of molecules) {
      const com = this._getMoleculeCOM(mol);
      const proj = new THREE.Vector3(com[0], com[1], com[2]).project(this._renderer.camera);
      const d = proj.x * proj.x + proj.y * proj.y;
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
    const camDir = new THREE.Vector3();
    this._renderer.camera.getWorldDirection(camDir);
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
        if (!self._state.isDraggingPreview) return;
        e.stopPropagation();
        // Project pointer onto placement plane
        const pp = self._state.placementPlane;
        const ndc = new THREE.Vector2(
          ((e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth) * 2 - 1,
          -((e.clientY - canvas.getBoundingClientRect().top) / canvas.clientHeight) * 2 + 1
        );
        self._renderer.camera.updateMatrixWorld(true);
        const rayOrigin = self._renderer.camera.position.clone();
        const rayDir = new THREE.Vector3(ndc.x, ndc.y, 0.5)
          .unproject(self._renderer.camera).sub(rayOrigin).normalize();
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
        if (!self._state.isDraggingPreview || e.touches.length !== 1) return;
        e.stopPropagation();
        e.preventDefault();
        const touch = e.touches[0];
        const pp = self._state.placementPlane;
        const rect = canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((touch.clientX - rect.left) / rect.width) * 2 - 1,
          -((touch.clientY - rect.top) / rect.height) * 2 + 1
        );
        self._renderer.camera.updateMatrixWorld(true);
        const rayOrigin = self._renderer.camera.position.clone();
        const rayDir = new THREE.Vector3(ndc.x, ndc.y, 0.5)
          .unproject(self._renderer.camera).sub(rayOrigin).normalize();
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
