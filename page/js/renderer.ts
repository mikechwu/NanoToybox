/**
 * Three.js renderer — scene management, PBR materials, visual feedback.
 *
 * Camera-relative lighting rig (key/fill/rim + ambient) follows orbit.
 * MeshStandardMaterial with roughness=0.7, metalness=0.
 * State-driven feedback: highlight, force line, rotation cue.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { THEMES } from './themes';
import { CONFIG } from './config';

export class Renderer {
  // Container
  container: HTMLElement;

  // Three.js core
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer!: THREE.WebGLRenderer;
  controls!: OrbitControls;

  // InstancedMesh state
  _instancedAtoms: THREE.InstancedMesh | null;
  _instancedBonds: THREE.InstancedMesh | null;
  _atomCapacity: number;
  _bondCapacity: number;
  _atomCount: number;
  _activeBonds: number;

  // Interaction state
  highlightAtom: number;
  forceLine!: THREE.Line;
  currentTheme: string;

  // Preview layer
  _previewGroup: THREE.Group | null;
  _previewMat: THREE.MeshStandardMaterial | null;
  _previewBondMat: THREE.MeshStandardMaterial | null;
  _previewAtomMeshes: THREE.Mesh[] | null;

  // Pre-allocated scratch objects (reused every frame)
  _bondUp: THREE.Vector3;
  _bondDir: THREE.Vector3;
  _tmpVec3: THREE.Vector3;
  _tmpMat4: THREE.Matrix4;
  _tmpQuat: THREE.Quaternion;
  _dummyObj: THREE.Object3D;

  // Highlight overlay
  _highlightMesh: THREE.Mesh | null;
  _highlightMat: THREE.MeshStandardMaterial | null;

  // Physics reference (read-only access to positions for rendering)
  _physicsRef: { n: number; pos: Float64Array; getBonds?: () => any[] } | null;

  // Geometry and material (created in loadStructure / appendMeshes)
  _atomGeom!: THREE.SphereGeometry;
  _atomMat!: THREE.MeshStandardMaterial;
  _bondGeom!: THREE.CylinderGeometry;
  _bondMat!: THREE.MeshStandardMaterial;

  // Camera defaults
  _defaultCamPos!: THREE.Vector3;
  _defaultCamTarget!: THREE.Vector3;
  _defaultCamUp!: THREE.Vector3;

  // Lighting
  ambientLight!: THREE.AmbientLight;
  keyLight!: THREE.DirectionalLight;
  fillLight!: THREE.DirectionalLight;
  rimLight!: THREE.DirectionalLight;

  // Resize handling
  _resizeHandler!: () => void;
  _deferredResizeTimer: ReturnType<typeof setTimeout> | null;

  // Axis triad
  _axisScene!: THREE.Scene;
  _axisCamera!: THREE.OrthographicCamera;
  _axisSize!: number;

  // Overlay layout
  _overlayLayout: { triadSize?: number; triadLeft?: number; triadBottom?: number } | null;

  // Triad pulse animation state
  _pulseRafId: number | null;

  constructor(container: HTMLElement) {
    this.container = container;

    // InstancedMesh state — replaces individual atomMeshes[]/bondMeshes[]
    this._instancedAtoms = null;  // THREE.InstancedMesh for atoms
    this._instancedBonds = null;  // THREE.InstancedMesh for bonds
    this._atomCapacity = 0;       // current InstancedMesh max (geometric growth)
    this._bondCapacity = 0;       // current bond InstancedMesh max
    this._atomCount = 0;          // active atom count
    this._activeBonds = 0;        // active bond count (after visibility filtering)

    this.highlightAtom = -1;
    this.forceLine = null;
    this.currentTheme = 'dark';
    this._previewGroup = null;  // THREE.Group for placement preview

    // Pre-allocated vectors/matrices reused every frame (avoid GC pressure)
    this._bondUp = new THREE.Vector3(0, 1, 0);
    this._bondDir = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();
    this._tmpMat4 = new THREE.Matrix4();
    this._tmpQuat = new THREE.Quaternion();
    this._dummyObj = new THREE.Object3D(); // scratch for instance matrix writes

    // Highlight overlay mesh — separate from instanced atoms
    this._highlightMesh = null;
    this._highlightMat = null;

    // Current physics reference for position reads (set each updatePositions call)
    this._physicsRef = null;

    this._initScene();
    this._initLighting();
    this._initForceLine();
  }

  /** Stable raycast target — returns the instanced atom mesh directly (no array allocation). */
  get instancedAtoms() {
    return this._instancedAtoms;
  }

  /** Compute next geometric capacity (next power of 2, minimum 64). */
  static _nextCapacity(needed) {
    let cap = 64;
    while (cap < needed) cap *= 2;
    return cap;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(0, 0, 15);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // setPixelRatio MUST be called before setSize for correct internal resolution
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.autoClear = false; // needed for axis triad overlay
    this.container.appendChild(this.renderer.domElement);

    // Apply correct size after canvas is in the DOM (so container has layout dimensions)
    this._syncSize();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // OrbitControls owns: scroll zoom + middle-drag dolly + 2-finger mobile zoom/pan.
    // Orbit rotation is handled by applyOrbitDelta on all devices (quaternion trackball).
    this.controls.enableRotate = false; // rotation via custom applyOrbitDelta
    this.controls.mouseButtons = {
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: null, // right-drag handled by InputManager → applyOrbitDelta
    };
    this.controls.touches = {
      ONE: null,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.enabled = true;

    this._defaultCamPos = new THREE.Vector3(0, 0, 15);
    this._defaultCamTarget = new THREE.Vector3(0, 0, 0);
    this._defaultCamUp = new THREE.Vector3(0, 1, 0);

    this._initAxisTriad();

    // Resize handling — use visualViewport on mobile for accurate sizing
    this._resizeHandler = () => this._syncSize();
    window.addEventListener('resize', this._resizeHandler);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._resizeHandler);
    }
    // Deferred resize to catch iPad Safari layout settling after load
    this._deferredResizeTimer = setTimeout(this._resizeHandler, 100);
  }

  /**
   * Sync renderer and camera to the actual visible container size.
   * Handles iOS Safari's dvh/vh differences and safe area insets.
   */
  _syncSize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _initLighting() {
    const ambient = new THREE.AmbientLight(0x8090b0, 1.2);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    const key = new THREE.DirectionalLight(0xffffff, 3.0);
    key.position.set(1.0, 0.7, 0.6);
    this.camera.add(key);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x8098c0, 1.5);
    fill.position.set(-1.0, 0.2, 0.4);
    this.camera.add(fill);
    this.fillLight = fill;

    const rim = new THREE.DirectionalLight(0x6070a0, 0.8);
    rim.position.set(0.3, -0.6, -1.0);
    this.camera.add(rim);
    this.rimLight = rim;

    this.scene.add(this.camera);
  }

  _initForceLine() {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(6); // 2 points × 3 coords
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x66ffaa,
      linewidth: 2,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
    });
    this.forceLine = new THREE.Line(geometry, material);
    this.forceLine.visible = false;
    this.forceLine.renderOrder = 999;
    this.scene.add(this.forceLine);
  }

  loadStructure(atoms, bonds) {
    this.highlightAtom = -1;
    // Dispose highlight mesh before geometry — it shares _atomGeom
    if (this._highlightMesh) {
      this.scene.remove(this._highlightMesh);
      this._highlightMesh = null;
    }
    if (this._highlightMat) {
      this._highlightMat.dispose();
      this._highlightMat = null;
    }

    // Dispose old instanced meshes
    this._disposeInstanced();

    // Dispose old geometry/material
    if (this._atomGeom) this._atomGeom.dispose();
    if (this._atomMat) this._atomMat.dispose();
    if (this._bondGeom) this._bondGeom.dispose();
    if (this._bondMat) this._bondMat.dispose();

    const t = THEMES[this.currentTheme];
    this._atomGeom = new THREE.SphereGeometry(
      CONFIG.atoms.radius, CONFIG.atoms.segments[0], CONFIG.atoms.segments[1]
    );
    this._atomMat = new THREE.MeshStandardMaterial({
      color: t.atom,
      roughness: CONFIG.material.roughness,
      metalness: CONFIG.material.metalness,
    });
    this._bondGeom = new THREE.CylinderGeometry(
      CONFIG.bondMesh.radius, CONFIG.bondMesh.radius, 1, CONFIG.bondMesh.segments
    );
    this._bondMat = new THREE.MeshStandardMaterial({
      color: t.bond,
      roughness: CONFIG.material.roughness,
      metalness: CONFIG.material.metalness,
    });

    // Create instanced atom mesh with geometric capacity
    this._atomCount = atoms.length;
    this._atomCapacity = Renderer._nextCapacity(atoms.length);
    this._instancedAtoms = new THREE.InstancedMesh(this._atomGeom, this._atomMat, this._atomCapacity);
    this._instancedAtoms.count = this._atomCount;

    // Write initial atom positions into instance matrices
    const dummy = this._dummyObj;
    for (let i = 0; i < atoms.length; i++) {
      dummy.position.set(atoms[i].x, atoms[i].y, atoms[i].z);
      dummy.scale.setScalar(1);
      dummy.quaternion.identity();
      dummy.updateMatrix();
      this._instancedAtoms.setMatrixAt(i, dummy.matrix);
    }
    this._instancedAtoms.instanceMatrix.needsUpdate = true;
    this.scene.add(this._instancedAtoms);

    // Create instanced bond mesh
    this._bondCapacity = Renderer._nextCapacity(Math.max(bonds.length, 256));
    this._instancedBonds = new THREE.InstancedMesh(this._bondGeom, this._bondMat, this._bondCapacity);
    this._instancedBonds.count = 0; // set during _updateBondTransforms
    this.scene.add(this._instancedBonds);

    this._updateBondTransformsInstanced(bonds, null, atoms);
    this._fitCamera();

    // Force immediate matrix update so raycasting works before next render frame.
    this.scene.updateMatrixWorld(true);
  }

  /** Dispose instanced meshes and remove from scene. */
  _disposeInstanced() {
    if (this._instancedAtoms) {
      this.scene.remove(this._instancedAtoms);
      this._instancedAtoms.dispose();
      this._instancedAtoms = null;
    }
    if (this._instancedBonds) {
      this.scene.remove(this._instancedBonds);
      this._instancedBonds.dispose();
      this._instancedBonds = null;
    }
    this._atomCount = 0;
    this._atomCapacity = 0;
    this._bondCapacity = 0;
    this._activeBonds = 0;
  }

  /** Keep physics reference current for bond topology reads in updateFromSnapshot. */
  setPhysicsRef(physics) {
    this._physicsRef = physics;
  }

  updatePositions(physics) {
    // Reacquire physics reference each call (pos may be reallocated on appendMolecule)
    this._physicsRef = physics;
    const pos = physics.pos;
    const n = physics.n;

    // Update instanced atom matrices from physics.pos
    if (this._instancedAtoms && n > 0) {
      const dummy = this._dummyObj;
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        dummy.position.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
        dummy.scale.setScalar(1);
        dummy.quaternion.identity();
        dummy.updateMatrix();
        this._instancedAtoms.setMatrixAt(i, dummy.matrix);
      }
      this._instancedAtoms.instanceMatrix.needsUpdate = true;
    }

    // Update instanced bonds
    const bonds = physics.getBonds();
    this._ensureBondCapacity(bonds.length);
    this._updateBondTransformsInstanced(bonds, pos, null);

    // Update highlight overlay position
    if (this._highlightMesh && this._highlightMesh.visible && this.highlightAtom >= 0) {
      const hi3 = this.highlightAtom * 3;
      this._highlightMesh.position.set(pos[hi3], pos[hi3 + 1], pos[hi3 + 2]);
    }
  }

  /**
   * Return the current camera state (position, direction, up) as plain arrays.
   * Used by the orchestrator to send camera info to the worker for
   * view-dependent calculations.
   */
  getCameraState(): { position: [number, number, number]; direction: [number, number, number]; up: [number, number, number] } {
    const cam = this.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    return {
      position: cam.position.toArray() as [number, number, number],
      direction: [dir.x, dir.y, dir.z],
      up: cam.up.toArray() as [number, number, number],
    };
  }

  /**
   * Project a world-space position to NDC (Normalized Device Coordinates).
   * Returns [x, y, z] where x,y are in [-1,1] and z is the depth.
   */
  projectToNDC(worldPos: [number, number, number]): [number, number, number] {
    this.camera.updateMatrixWorld(true);
    const v = new THREE.Vector3(worldPos[0], worldPos[1], worldPos[2]);
    v.project(this.camera);
    return [v.x, v.y, v.z];
  }

  /**
   * Construct a world-space ray from screen (client) coordinates.
   * Useful for pointer-to-plane intersection without exposing the camera.
   */
  screenPointToRay(screenX: number, screenY: number): { origin: [number, number, number]; direction: [number, number, number] } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1
    );
    this.camera.updateMatrixWorld(true);
    const origin = this.camera.position.clone();
    const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5)
      .unproject(this.camera).sub(origin).normalize();
    return {
      origin: [origin.x, origin.y, origin.z],
      direction: [dir.x, dir.y, dir.z],
    };
  }

  /**
   * Apply a snapshot of positions received from the worker thread.
   * Milestone B: positions are applied to atom instance matrices.
   * Bond args (_bonds, _bondCount) are accepted but intentionally ignored —
   * bond-driven rendering will be wired in Milestone C when the worker sends
   * topology updates via bondUpdate events.
   * The existing updatePositions() remains the active rendering path during B.
   */
  updateFromSnapshot(positions: Float64Array, n: number, _bonds: Int32Array | null = null, _bondCount: number = 0): void {
    if (!this._instancedAtoms || n === 0) return;
    const m = new THREE.Matrix4();
    const count = Math.min(n, this._atomCapacity);
    for (let i = 0; i < count; i++) {
      m.makeTranslation(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      this._instancedAtoms.setMatrixAt(i, m);
    }
    this._instancedAtoms.count = count;
    this._instancedAtoms.instanceMatrix.needsUpdate = true;

    // Update bonds from current topology + current snapshot positions.
    // Bond topology comes from _physicsRef.getBonds() (set during appendMolecule).
    // Bond POSITIONS use _physicsRef.pos which covers all locally committed atoms
    // (may include atoms not yet in the worker snapshot). We copy the current
    // snapshot positions into _physicsRef.pos first so bonds are frame-coherent
    // with atoms (no one-frame lag).
    if (this._physicsRef?.getBonds) {
      const rpos = this._physicsRef.pos;
      if (rpos) {
        const copyLen = Math.min(positions.length, rpos.length);
        rpos.set(positions.subarray(0, copyLen));
      }
      const bonds = this._physicsRef.getBonds();
      this._ensureBondCapacity(bonds.length);
      this._updateBondTransformsInstanced(bonds, rpos || positions, null);
    }

    // Update highlight overlay position from snapshot
    if (this._highlightMesh && this._highlightMesh.visible && this.highlightAtom >= 0) {
      const hi3 = this.highlightAtom * 3;
      if (hi3 + 2 < positions.length) {
        this._highlightMesh.position.set(positions[hi3], positions[hi3 + 1], positions[hi3 + 2]);
      }
    }
  }

  /**
   * Ensure bond InstancedMesh capacity is sufficient.
   * Uses geometric growth (grow-only during session).
   */
  _ensureBondCapacity(needed) {
    if (this._instancedBonds && needed <= this._bondCapacity) return;
    const newCap = Renderer._nextCapacity(Math.max(needed, 256));
    if (this._instancedBonds) {
      this.scene.remove(this._instancedBonds);
      this._instancedBonds.dispose();
    }
    this._bondCapacity = newCap;
    this._instancedBonds = new THREE.InstancedMesh(this._bondGeom, this._bondMat, newCap);
    this._instancedBonds.count = 0;
    this.scene.add(this._instancedBonds);
  }

  /**
   * Write active bond transforms densely into the bond InstancedMesh.
   * Active-instance compaction: only visible bonds are written, then
   * instancedBonds.count is set to the active count.
   *
   * @param {Array} bonds - bond list from physics
   * @param {Float64Array|null} pos - physics.pos typed array (null = use atoms array)
   * @param {Array|null} atoms - atom objects with {x,y,z} (used by loadStructure initial setup)
   */
  _updateBondTransformsInstanced(bonds, pos, atoms) {
    if (!this._instancedBonds) return;
    const dummy = this._dummyObj;
    const up = this._bondUp;
    const dir = this._bondDir;
    let activeCount = 0;
    const n = pos ? pos.length / 3 : (atoms ? atoms.length : 0);

    for (let b = 0; b < bonds.length; b++) {
      const [i, j] = bonds[b];
      if (i >= n || j >= n) continue;

      let pix, piy, piz, pjx, pjy, pjz;
      if (pos) {
        const i3 = i * 3, j3 = j * 3;
        pix = pos[i3]; piy = pos[i3 + 1]; piz = pos[i3 + 2];
        pjx = pos[j3]; pjy = pos[j3 + 1]; pjz = pos[j3 + 2];
      } else {
        pix = atoms[i].x; piy = atoms[i].y; piz = atoms[i].z;
        pjx = atoms[j].x; pjy = atoms[j].y; pjz = atoms[j].z;
      }

      const dx = pjx - pix, dy = pjy - piy, dz = pjz - piz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Skip bonds beyond visibility cutoff (active-instance compaction)
      if (dist > CONFIG.bonds.visibilityCutoff) continue;

      // Write dense instance matrix
      dummy.position.set(
        (pix + pjx) / 2,
        (piy + pjy) / 2,
        (piz + pjz) / 2
      );
      dummy.scale.set(1, dist, 1); // cylinder stretches along Y
      dir.set(dx, dy, dz).normalize();
      dummy.quaternion.setFromUnitVectors(up, dir);
      dummy.updateMatrix();
      this._instancedBonds.setMatrixAt(activeCount, dummy.matrix);
      activeCount++;
    }

    this._instancedBonds.count = activeCount;
    this._instancedBonds.instanceMatrix.needsUpdate = true;
    this._activeBonds = activeCount;
  }

  setHighlight(atomIndex) {
    this.highlightAtom = atomIndex;

    if (atomIndex >= 0) {
      // Create overlay mesh on first use
      if (!this._highlightMesh) {
        const geom = this._atomGeom || new THREE.SphereGeometry(
          CONFIG.atoms.radius, CONFIG.atoms.segments[0], CONFIG.atoms.segments[1]
        );
        this._highlightMat = new THREE.MeshStandardMaterial({
          color: this._atomMat ? this._atomMat.color.clone() : new THREE.Color(0xe0e0e0),
          roughness: CONFIG.material.roughness,
          metalness: CONFIG.material.metalness,
          emissive: new THREE.Color(0x335544),
          emissiveIntensity: 1.0,
        });
        this._highlightMesh = new THREE.Mesh(geom, this._highlightMat);
        this._highlightMesh.renderOrder = 1; // render after atoms for consistent depth
        this.scene.add(this._highlightMesh);
      }

      // Position at the highlighted atom
      this.getAtomWorldPosition(atomIndex, this._highlightMesh.position);
      this._highlightMesh.scale.setScalar(1.15);
      this._highlightMat.emissive.set(0x335544);
      this._highlightMat.emissiveIntensity = 1.0;
      this._highlightMesh.visible = true;
    } else if (this._highlightMesh) {
      this._highlightMesh.visible = false;
    }
  }

  showForceLine(fromAtomIndex, toWorldX, toWorldY, toWorldZ) {
    if (fromAtomIndex < 0) return;
    const atomPos = this.getAtomWorldPosition(fromAtomIndex);
    const positions = this.forceLine.geometry.attributes.position.array;
    positions[0] = atomPos.x;
    positions[1] = atomPos.y;
    positions[2] = atomPos.z;
    positions[3] = toWorldX;
    positions[4] = toWorldY;
    positions[5] = toWorldZ !== undefined ? toWorldZ : atomPos.z;
    this.forceLine.geometry.attributes.position.needsUpdate = true;
    this.forceLine.visible = true;
  }

  hideForceLine() {
    this.forceLine.visible = false;
  }

  /**
   * State-driven feedback update — called every frame.
   * Reads state machine feedback and sets all visuals accordingly.
   * No event-driven flickering — purely a function of state.
   */
  updateFeedback(feedbackState) {
    const { hoverAtom, activeAtom, isDragging, isMoving, isRotating } = feedbackState;
    const isActive = isDragging || isMoving || isRotating;

    // Determine which atom should be highlighted
    const targetAtom = activeAtom >= 0 ? activeAtom : hoverAtom;

    // Only update if changed
    if (targetAtom !== this.highlightAtom) {
      this.setHighlight(targetAtom);
    }

    // Active interaction gets stronger highlight with mode-specific color
    if (isActive && activeAtom >= 0 && this._highlightMesh && this._highlightMat) {
      if (isMoving) {
        // Blue tint for Move mode
        this._highlightMat.emissive.set(0x445566);
        (this.forceLine.material as THREE.LineBasicMaterial).color.set(0x66aaff);
      } else {
        // Green tint for Atom drag and Rotate
        this._highlightMat.emissive.set(0x446655);
        (this.forceLine.material as THREE.LineBasicMaterial).color.set(0x66ffaa);
      }
      this._highlightMat.emissiveIntensity = 1.2;
      this._highlightMesh.scale.setScalar(1.2);
    }

    // Force line visibility tied to active interaction state
    if (!isActive) {
      this.hideForceLine();
    }
  }

  clearFeedback() {
    this.setHighlight(-1);
    this.hideForceLine();
  }

  applyTheme(name) {
    this.currentTheme = name;
    const t = THEMES[name];
    this.scene.background = new THREE.Color(t.bg);
    this.ambientLight.color.set(t.ambientColor);
    this.ambientLight.intensity = t.ambientIntensity;
    this.keyLight.color.set(t.keyColor);
    this.keyLight.intensity = t.keyIntensity;
    this.fillLight.color.set(t.fillColor);
    this.fillLight.intensity = t.fillIntensity;
    this.rimLight.color.set(t.rimColor);
    this.rimLight.intensity = t.rimIntensity;

    if (this._atomMat) this._atomMat.color.set(t.atom);
    if (this._bondMat) this._bondMat.color.set(t.bond);
    // Update highlight overlay material if active
    if (this._highlightMat) this._highlightMat.color.set(t.atom);
  }

  /**
   * Ensure InstancedMesh has capacity for `newAtomCount` additional atoms.
   * Creates geometry/material if they don't exist yet, and grows the
   * InstancedMesh geometrically if the current capacity is insufficient.
   * Does NOT write any instance matrices or change the visible atom count.
   */
  ensureCapacityForAppend(newAtomCount: number) {
    const t = THEMES[this.currentTheme];

    // Ensure geometry/material exist
    if (!this._atomGeom) {
      this._atomGeom = new THREE.SphereGeometry(
        CONFIG.atoms.radius, CONFIG.atoms.segments[0], CONFIG.atoms.segments[1]
      );
      this._atomMat = new THREE.MeshStandardMaterial({
        color: t.atom, roughness: CONFIG.material.roughness, metalness: CONFIG.material.metalness,
      });
    }
    if (!this._bondGeom) {
      this._bondGeom = new THREE.CylinderGeometry(
        CONFIG.bondMesh.radius, CONFIG.bondMesh.radius, 1, CONFIG.bondMesh.segments
      );
      this._bondMat = new THREE.MeshStandardMaterial({
        color: t.bond, roughness: CONFIG.material.roughness, metalness: CONFIG.material.metalness,
      });
    }

    const newCount = this._atomCount + newAtomCount;

    // Grow capacity if needed (geometric, grow-only within session)
    if (newCount > this._atomCapacity) {
      const newCap = Renderer._nextCapacity(newCount);
      const oldInstanced = this._instancedAtoms;
      const newInstanced = new THREE.InstancedMesh(this._atomGeom, this._atomMat, newCap);

      // Copy existing instance matrices
      if (oldInstanced && this._atomCount > 0) {
        for (let i = 0; i < this._atomCount; i++) {
          oldInstanced.getMatrixAt(i, this._tmpMat4);
          newInstanced.setMatrixAt(i, this._tmpMat4);
        }
      }

      if (oldInstanced) {
        this.scene.remove(oldInstanced);
        oldInstanced.dispose();
      }
      this._instancedAtoms = newInstanced;
      this._atomCapacity = newCap;
      this.scene.add(newInstanced);
    }
  }

  /**
   * Write initial instance matrices for newly appended atoms.
   * Call after ensureCapacityForAppend(). Updates the visible atom count.
   *
   * @param atoms - positions for the new atoms
   * @param offsetStart - index in the instance buffer where writing begins
   */
  populateAppendedAtoms(atoms: {x: number, y: number, z: number}[], offsetStart: number) {
    if (CONFIG.debug.failRendererAppend) throw new Error('[debug] Injected renderer append failure');

    const dummy = this._dummyObj;
    for (let i = 0; i < atoms.length; i++) {
      dummy.position.set(atoms[i].x, atoms[i].y, atoms[i].z);
      dummy.scale.setScalar(1);
      dummy.quaternion.identity();
      dummy.updateMatrix();
      this._instancedAtoms.setMatrixAt(offsetStart + i, dummy.matrix);
    }

    const newCount = offsetStart + atoms.length;
    this._atomCount = newCount;
    this._instancedAtoms.count = newCount;
    this._instancedAtoms.instanceMatrix.needsUpdate = true;
    this.scene.updateMatrixWorld(true);
  }

  /**
   * Append atom instances for a newly placed molecule.
   * Convenience wrapper: grows capacity then populates matrices.
   * Bond instances are managed during updatePositions().
   */
  /** @deprecated Use ensureCapacityForAppend() + populateAppendedAtoms() instead. Milestone C must not use this. */
  private appendMeshes(atoms: { x: number; y: number; z: number }[]) {
    this.ensureCapacityForAppend(atoms.length);
    this.populateAppendedAtoms(atoms, this._atomCount);
  }

  /**
   * Clear all atom and bond instances from the scene.
   * Retains InstancedMesh capacity within session (grow-only).
   * Full capacity reclaim happens on resetToEmpty / page reload.
   */
  clearAllMeshes() {
    this.highlightAtom = -1;
    if (this._highlightMesh) this._highlightMesh.visible = false;
    this._atomCount = 0;
    this._activeBonds = 0;
    if (this._instancedAtoms) this._instancedAtoms.count = 0;
    if (this._instancedBonds) this._instancedBonds.count = 0;
  }

  // --- Preview layer for placement mode ---

  showPreview(atoms, bonds, offset) {
    this.hidePreview();
    const t = THEMES[this.currentTheme];
    const group = new THREE.Group();
    const previewAtomMat = new THREE.MeshStandardMaterial({
      color: t.atom, roughness: 0.7, metalness: 0,
      transparent: true, opacity: 0.4,
      emissive: 0x334466, emissiveIntensity: 0.5,
    });
    const previewGeom = this._atomGeom || new THREE.SphereGeometry(
      CONFIG.atoms.radius, CONFIG.atoms.segments[0], CONFIG.atoms.segments[1]
    );
    this._previewAtomMeshes = [];
    atoms.forEach(a => {
      const mesh = new THREE.Mesh(previewGeom, previewAtomMat);
      mesh.position.set(a.x, a.y, a.z);
      group.add(mesh);
      this._previewAtomMeshes.push(mesh);
    });
    // Preview bonds
    if (bonds && bonds.length > 0) {
      const previewBondMat = new THREE.MeshStandardMaterial({
        color: t.bond, roughness: 0.7, metalness: 0,
        transparent: true, opacity: 0.3,
      });
      const bondGeom = this._bondGeom || new THREE.CylinderGeometry(
        CONFIG.bondMesh.radius, CONFIG.bondMesh.radius, 1, CONFIG.bondMesh.segments
      );
      const up = new THREE.Vector3(0, 1, 0);
      const dir = new THREE.Vector3();
      for (const [i, j] of bonds) {
        if (i >= atoms.length || j >= atoms.length) continue;
        const ai = atoms[i], aj = atoms[j];
        const dx = aj.x - ai.x, dy = aj.y - ai.y, dz = aj.z - ai.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist > CONFIG.bonds.visibilityCutoff) continue;
        const mesh = new THREE.Mesh(bondGeom, previewBondMat);
        mesh.position.set((ai.x+aj.x)/2, (ai.y+aj.y)/2, (ai.z+aj.z)/2);
        mesh.scale.y = dist;
        dir.set(dx, dy, dz).normalize();
        mesh.quaternion.setFromUnitVectors(up, dir);
        group.add(mesh);
      }
      this._previewBondMat = previewBondMat;
    }
    group.position.set(offset[0], offset[1], offset[2]);
    this.scene.add(group);
    this._previewGroup = group;
    this._previewMat = previewAtomMat;
  }

  updatePreviewOffset(offset) {
    if (this._previewGroup) {
      this._previewGroup.position.set(offset[0], offset[1], offset[2]);
    }
  }

  hidePreview() {
    if (this._previewGroup) {
      this.scene.remove(this._previewGroup);
      if (this._previewMat) this._previewMat.dispose();
      if (this._previewBondMat) this._previewBondMat.dispose();
      this._previewGroup = null;
      this._previewMat = null;
      this._previewBondMat = null;
      this._previewAtomMeshes = null;
    }
  }

  /**
   * Raycast against all preview meshes (atoms and bonds) with hybrid
   * hit preference: if both an atom and a bond are hit within a small
   * ray-distance threshold, prefer the atom hit for more stable grab
   * behavior. Bonds are still draggable when they are the only hit.
   */
  raycastPreview(screenX, screenY) {
    if (!this._previewGroup || !this._previewGroup.children.length) {
      return { hit: false, worldPoint: null };
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1
    );
    this.camera.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const hits = raycaster.intersectObjects(this._previewGroup.children, false);
    if (hits.length === 0) return { hit: false, worldPoint: null };

    // Prefer atom hits over bond hits when both are within a small threshold
    const atomHits = this._previewAtomMeshes
      ? hits.filter(h => this._previewAtomMeshes!.includes(h.object as THREE.Mesh))
      : [];
    const threshold = CONFIG.picker.previewAtomPreference;
    let best = hits[0];
    if (atomHits.length > 0 && atomHits[0].distance - hits[0].distance < threshold) {
      best = atomHits[0];
    }
    const p = best.point;
    return { hit: true, worldPoint: [p.x, p.y, p.z] };
  }

  getPreviewWorldCenter() {
    if (!this._previewGroup) return [0, 0, 0];
    const p = this._previewGroup.position;
    return [p.x, p.y, p.z];
  }

  _fitCamera() {
    const n = this._atomCount;
    if (n === 0) return;

    // Compute COM and bounding radius from physics positions or instance matrices
    let cx = 0, cy = 0, cz = 0;
    if (this._physicsRef && this._physicsRef.n === n) {
      const pos = this._physicsRef.pos;
      for (let i = 0; i < n; i++) {
        cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2];
      }
    } else if (this._instancedAtoms) {
      // Fall back to reading instance matrices (e.g., during loadStructure before physics ref is set)
      const m = this._tmpMat4;
      for (let i = 0; i < n; i++) {
        this._instancedAtoms.getMatrixAt(i, m);
        cx += m.elements[12]; cy += m.elements[13]; cz += m.elements[14];
      }
    } else {
      return;
    }
    cx /= n; cy /= n; cz /= n;

    let maxR = 0;
    if (this._physicsRef && this._physicsRef.n === n) {
      const pos = this._physicsRef.pos;
      for (let i = 0; i < n; i++) {
        const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > maxR) maxR = r;
      }
    } else if (this._instancedAtoms) {
      const m = this._tmpMat4;
      for (let i = 0; i < n; i++) {
        this._instancedAtoms.getMatrixAt(i, m);
        const dx = m.elements[12] - cx, dy = m.elements[13] - cy, dz = m.elements[14] - cz;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > maxR) maxR = r;
      }
    }
    const dist = maxR * 2.5 + 5;
    this.camera.position.set(cx, cy, cz + dist);
    this.camera.up.set(0, 1, 0); // Level the camera on fit
    this.controls.target.set(cx, cy, cz);
    this.controls.update();

    // Save for resetView
    this._defaultCamPos.set(cx, cy, cz + dist);
    this._defaultCamTarget.set(cx, cy, cz);
    this._defaultCamUp.set(0, 1, 0);
  }

  /** Public API: fit camera to current atom positions. */
  fitCamera() { this._fitCamera(); }

  /** Reset camera to default empty-scene position. Retains instanced capacity. */
  resetCamera() {
    this._physicsRef = null;
    this.camera.position.set(0, 0, 15);
    this.camera.up.set(0, 1, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this._defaultCamPos.set(0, 0, 15);
    this._defaultCamTarget.set(0, 0, 0);
    this._defaultCamUp.set(0, 1, 0);
  }

  /** Hard reset: reclaims instanced capacity. Reserved for debug/explicit reset only. */
  resetToEmpty() {
    this._disposeInstanced();
    this.highlightAtom = -1;
    if (this._highlightMesh) this._highlightMesh.visible = false;
    this.resetCamera();
  }

  /**
   * Get atom world position for the latest physics state.
   * Renderer-owned API, physics-backed. Returns scene/world coordinates
   * without depending on mesh objects. Callers within the same frame get
   * a consistent snapshot.
   *
   * Fast path: reads from _physicsRef.pos (O(1) typed-array lookup).
   * Fallback path: reads from InstancedMesh instance matrix via getMatrixAt() —
   * materially slower. Only used before the first updatePositions() call
   * (e.g., during loadStructure). Interaction and picking should always run
   * after updatePositions() to avoid the fallback.
   *
   * @param {number} index - atom index
   * @param {THREE.Vector3} [out] - optional output vector (avoids allocation)
   * @returns {THREE.Vector3} the atom's world position
   */
  getAtomWorldPosition(index: number, out?: THREE.Vector3) {
    const v = out || this._tmpVec3;
    if (this._physicsRef && index >= 0 && index < this._physicsRef.n) {
      const pos = this._physicsRef.pos;
      const i3 = index * 3;
      v.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
    } else if (this._instancedAtoms && index >= 0 && index < this._atomCount) {
      this._instancedAtoms.getMatrixAt(index, this._tmpMat4);
      v.set(this._tmpMat4.elements[12], this._tmpMat4.elements[13], this._tmpMat4.elements[14]);
    } else {
      v.set(0, 0, 0);
    }
    return v;
  }

  /** Number of active atoms. */
  getAtomCount() {
    return this._atomCount;
  }

  /** Update active atom count (e.g. after boundary removal compacts physics arrays). */
  setAtomCount(n) {
    this._atomCount = n;
    if (this._instancedAtoms) {
      this._instancedAtoms.count = n;
      this._instancedAtoms.instanceMatrix.needsUpdate = true;
    }
    // Clear bond visuals when all atoms are removed
    if (n === 0 && this._instancedBonds) {
      this._instancedBonds.count = 0;
      this._instancedBonds.instanceMatrix.needsUpdate = true;
      this._activeBonds = 0;
    }
  }

  /**
   * Set overlay layout parameters. Called by main.js when dock geometry
   * or device mode changes. Renderer treats these as opaque layout hints.
   * @param {object} layout
   * @param {number} layout.triadSize - axis triad viewport size in CSS px
   * @param {number} layout.triadLeft - triad X offset from left edge
   * @param {number} layout.triadBottom - triad Y offset from bottom edge
   */
  setOverlayLayout(layout) {
    this._overlayLayout = layout;
    if (layout.triadSize != null) this._axisSize = layout.triadSize;
  }

  /**
   * Remove global listeners. Call from app teardown.
   * Note: GPU resource disposal (WebGLRenderer, geometries, materials, textures)
   * is intentionally deferred. Full disposal requires a dedicated pass if the app
   * ever supports remounting or embedded use. Currently the browser reclaims GPU
   * resources on page unload.
   */
  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._resizeHandler);
    }
    if (this._deferredResizeTimer) {
      clearTimeout(this._deferredResizeTimer);
      this._deferredResizeTimer = null;
    }
    if (this._pulseRafId != null) {
      cancelAnimationFrame(this._pulseRafId);
      this._pulseRafId = null;
    }
    if (this._snapRafId != null) {
      cancelAnimationFrame(this._snapRafId);
      this._snapRafId = null;
    }
    this.showAxisHighlight(null); // clean up triad highlight
    if (this._focusIndicator) {
      this.scene.remove(this._focusIndicator);
      this._focusIndicator.geometry.dispose();
      (this._focusIndicator.material as THREE.Material).dispose();
      this._focusIndicator = null;
    }
    if (this._focusIndicatorTimer) {
      clearTimeout(this._focusIndicatorTimer);
      this._focusIndicatorTimer = null;
    }
  }

  /** Debug info for instanced capacity monitoring. */
  getCapacityInfo() {
    return {
      atomCount: this._atomCount,
      atomCapacity: this._atomCapacity,
      bondActive: this._activeBonds,
      bondCapacity: this._bondCapacity,
    };
  }

  /**
   * Reset camera to default position and orientation (front view).
   */
  resetView() {
    this.camera.position.copy(this._defaultCamPos);
    this.camera.up.copy(this._defaultCamUp);
    this.controls.target.copy(this._defaultCamTarget);
    this.controls.update();
  }

  // ── Focus-aware pivot ──

  private _focusIndicator: THREE.Mesh | null = null;
  private _focusIndicatorTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Update orbit pivot to a new focus target.
   * Does NOT update _defaultCamTarget — resetView still returns to scene centroid.
   */
  setCameraFocusTarget(target: THREE.Vector3) {
    this.controls.target.copy(target);
    this.controls.update();
    this._showFocusIndicator(target);
  }

  /** Show a temporary translucent sphere at the focus point (~1 second). */
  private _showFocusIndicator(pos: THREE.Vector3) {
    // Remove existing indicator
    if (this._focusIndicator) {
      this.scene.remove(this._focusIndicator);
      this._focusIndicator.geometry.dispose();
      (this._focusIndicator.material as THREE.Material).dispose();
      this._focusIndicator = null;
    }
    if (this._focusIndicatorTimer) {
      clearTimeout(this._focusIndicatorTimer);
      this._focusIndicatorTimer = null;
    }

    const geo = new THREE.SphereGeometry(0.5, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.25,
      depthTest: true,
    });
    this._focusIndicator = new THREE.Mesh(geo, mat);
    this._focusIndicator.position.copy(pos);
    this.scene.add(this._focusIndicator);

    // Fade out after 1 second
    this._focusIndicatorTimer = setTimeout(() => {
      this._focusIndicatorTimer = null;
      if (this._focusIndicator) {
        this.scene.remove(this._focusIndicator);
        this._focusIndicator.geometry.dispose();
        (this._focusIndicator.material as THREE.Material).dispose();
        this._focusIndicator = null;
      }
    }, 1000);
  }

  /**
   * Compute the centroid of a molecule given its atom offset and count.
   * Returns null if physics ref is not available.
   */
  getMoleculeCentroid(atomOffset: number, atomCount: number): THREE.Vector3 | null {
    if (!this._physicsRef || this._physicsRef.n === 0) return null;
    const pos = this._physicsRef.pos;
    let cx = 0, cy = 0, cz = 0;
    for (let i = atomOffset; i < atomOffset + atomCount && i < this._physicsRef.n; i++) {
      cx += pos[i * 3];
      cy += pos[i * 3 + 1];
      cz += pos[i * 3 + 2];
    }
    const n = Math.min(atomCount, this._physicsRef.n - atomOffset);
    if (n <= 0) return null;
    return new THREE.Vector3(cx / n, cy / n, cz / n);
  }

  // ── Free-Look mode (Phase 3) ──

  /**
   * Apply free-look rotation (camera rotates in place, no pivot).
   * Yaw around world up (stable horizon), pitch around camera right.
   * No roll.
   */
  applyFreeLookDelta(dx: number, dy: number) {
    const speed = CONFIG.orbit.rotateSpeed;
    // Yaw around world up — keeps horizon stable
    const qYaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), -dx * speed
    );
    // Pitch around camera-local right axis
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * speed);
    this.camera.quaternion.premultiply(qYaw).premultiply(qPitch);
  }

  /**
   * Translate camera along its look direction (forward/back zoom in Free-Look).
   */
  applyFreeLookZoom(delta: number) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.add(forward.multiplyScalar(delta * 0.5));
  }

  /**
   * Translate camera in its local plane (WASD in Free-Look).
   */
  applyFreeLookTranslate(dx: number, dy: number) {
    const speed = 0.05;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.add(right.multiplyScalar(dx * speed));
    this.camera.position.add(forward.multiplyScalar(-dy * speed));
  }

  /**
   * Reset camera orientation to default (look along -Z, up=Y).
   * Does NOT change position.
   */
  resetOrientation() {
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z - 1
    );
  }

  /**
   * Fly-to animation: return to orbiting the last focused molecule.
   * Animated over 500ms.
   */
  /**
   * Fly-to callback: set externally by main.ts to provide store access
   * without renderer importing the store directly.
   */
  _returnToObjectCallback: (() => THREE.Vector3 | null) | null = null;

  returnToFocusedObject() {
    // Get target position from callback (set by main.ts) or fall back to default
    let targetPos = this._returnToObjectCallback?.() ?? null;
    if (!targetPos) {
      targetPos = this._defaultCamTarget.clone();
    }

    // Animate fly-to
    const startPos = this.camera.position.clone();
    const distance = 15; // comfortable viewing distance
    const endPos = targetPos.clone().add(new THREE.Vector3(0, 0, distance));
    const start = performance.now();
    const duration = 500;

    if (this._snapRafId != null) cancelAnimationFrame(this._snapRafId);

    const animate = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      const ease = 1 - (1 - t) * (1 - t);
      this.camera.position.lerpVectors(startPos, endPos, ease);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(targetPos!);
      this.controls.target.copy(targetPos!);
      this.controls.update();
      if (t < 1) {
        this._snapRafId = requestAnimationFrame(animate);
      } else {
        this._snapRafId = null;
      }
    };
    this._snapRafId = requestAnimationFrame(animate);
  }

  /**
   * Configure OrbitControls for the given camera mode.
   * In Free-Look: all OrbitControls interaction disabled.
   * In Orbit: rotation disabled (handled by custom applyOrbitDelta), zoom+pan enabled.
   */
  setOrbitControlsForMode(mode: 'orbit' | 'freelook') {
    if (mode === 'freelook') {
      this.controls.enableRotate = false;
      this.controls.enablePan = false;
      this.controls.enableZoom = false;
    } else {
      this.controls.enableRotate = false; // custom quaternion orbit
      this.controls.enablePan = true;
      this.controls.enableZoom = true;
    }
  }

  // ── Triad interaction (mobile camera orbit) ──

  /**
   * Get the triad's screen-space hit rect in CSS pixels.
   * Returns { left, bottom, size } — the enlarged touch target including padding.
   */
  getTriadRect() {
    const size = this._axisSize;
    const left = this._overlayLayout?.triadLeft ?? 6;
    const bottom = this._overlayLayout?.triadBottom ?? 50;
    const pad = CONFIG.orbit.triadHitPadding;
    return {
      left: left - pad,
      bottom: bottom - pad,
      size: size + 2 * pad,
      visualSize: size,
      visualLeft: left,
      visualBottom: bottom,
    };
  }

  /**
   * Check if a screen point (clientX, clientY) is inside the triad hit rect.
   * Uses getBoundingClientRect for layout-robust canvas-local coordinates.
   */
  isInsideTriad(clientX: number, clientY: number): boolean {
    const triad = this.getTriadRect();
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    // Convert client coords to canvas-local, then to bottom-up (renderer origin)
    const localX = clientX - canvasRect.left;
    const localY = canvasRect.height - (clientY - canvasRect.top);
    return (
      localX >= triad.left &&
      localX <= triad.left + triad.size &&
      localY >= triad.bottom &&
      localY <= triad.bottom + triad.size
    );
  }

  /**
   * Apply an orbit rotation delta to the camera (quaternion trackball).
   * Used by triad drag and background orbit. Rotates around camera's local
   * axes — no phi clamp, free rotation through all orientations.
   * Drag-up rotates camera down ("dragging the world").
   */
  applyOrbitDelta(dx: number, dy: number) {
    const speed = CONFIG.orbit.rotateSpeed;
    const offset = this.camera.position.clone().sub(this.controls.target);

    // Quaternion trackball rotation around camera's local axes.
    // No spherical coordinates, no phi clamp — free rotation through all orientations.
    const qx = new THREE.Quaternion().setFromAxisAngle(
      this.camera.up.clone().normalize(), -dx * speed
    );
    const right = new THREE.Vector3()
      .crossVectors(this.camera.up, offset).normalize();
    const qy = new THREE.Quaternion().setFromAxisAngle(right, dy * speed);

    const q = qx.multiply(qy);
    offset.applyQuaternion(q);
    this.camera.up.applyQuaternion(q);

    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  // ── Canonical view snaps (Phase 2) ──

  /** Axis endpoints in triad-scene coordinates: ±1.0 along each axis. */
  private _axisEndpoints = [
    { dir: new THREE.Vector3(1, 0, 0), label: '+X' },
    { dir: new THREE.Vector3(-1, 0, 0), label: '-X' },
    { dir: new THREE.Vector3(0, 1, 0), label: '+Y' },
    { dir: new THREE.Vector3(0, -1, 0), label: '-Y' },
    { dir: new THREE.Vector3(0, 0, 1), label: '+Z' },
    { dir: new THREE.Vector3(0, 0, -1), label: '-Z' },
  ];

  /** Snap animation state */
  private _snapRafId: number | null = null;

  /** Highlight mesh for triad tap-intent preview */
  private _triadHighlight: THREE.Mesh | null = null;

  /**
   * Find the nearest axis endpoint to a screen point within the triad viewport.
   * Returns the axis direction vector, or null if the point is in the center zone.
   * @param clientX, clientY — screen coordinates
   */
  getNearestAxisEndpoint(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this._axisCamera || !this._axisScene) return null;
    const rect = this.getTriadRect();
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    const localX = clientX - canvasRect.left;
    const localY = canvasRect.height - (clientY - canvasRect.top);

    // Center of triad viewport in canvas-local bottom-up coords
    const cx = rect.visualLeft + rect.visualSize / 2;
    const cy = rect.visualBottom + rect.visualSize / 2;

    // Center zone — double-tap reset area (25% of visual radius)
    const centerRadius = rect.visualSize * 0.25;
    const distToCenter = Math.sqrt((localX - cx) ** 2 + (localY - cy) ** 2);
    if (distToCenter < centerRadius) return null; // center zone → reset, not snap

    // Project all 6 endpoints to 2D within the triad viewport
    let nearest: THREE.Vector3 | null = null;
    let minDist = Infinity;
    const projVec = new THREE.Vector3();

    for (const ep of this._axisEndpoints) {
      projVec.copy(ep.dir);
      projVec.project(this._axisCamera);
      // NDC (-1..1) → viewport-local pixels
      const px = cx + (projVec.x * rect.visualSize) / 2;
      const py = cy + (projVec.y * rect.visualSize) / 2;
      const d = Math.sqrt((localX - px) ** 2 + (localY - py) ** 2);
      if (d < minDist) {
        minDist = d;
        nearest = ep.dir;
      }
    }
    return nearest;
  }

  /**
   * Animate camera to look along an axis direction over ~300ms.
   * Preserves current camera distance from target.
   */
  snapToAxis(axisDir: THREE.Vector3) {
    // Cancel any in-progress snap
    if (this._snapRafId != null) {
      cancelAnimationFrame(this._snapRafId);
      this._snapRafId = null;
    }

    const distance = this.camera.position.distanceTo(this.controls.target);
    const targetPos = this.controls.target.clone().add(
      axisDir.clone().normalize().multiplyScalar(distance)
    );
    const startPos = this.camera.position.clone();
    const startUp = this.camera.up.clone();
    // Choose an appropriate up vector — avoid gimbal lock when looking along Y
    const targetUp = Math.abs(axisDir.y) > 0.9
      ? new THREE.Vector3(0, 0, axisDir.y > 0 ? -1 : 1)
      : new THREE.Vector3(0, 1, 0);

    const start = performance.now();
    const duration = 300;

    const animate = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      // Smooth ease-out
      const ease = 1 - (1 - t) * (1 - t);
      this.camera.position.lerpVectors(startPos, targetPos, ease);
      this.camera.up.lerpVectors(startUp, targetUp, ease).normalize();
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      if (t < 1) {
        this._snapRafId = requestAnimationFrame(animate);
      } else {
        this._snapRafId = null;
      }
    };
    this._snapRafId = requestAnimationFrame(animate);
  }

  /**
   * Animated reset to default front view over ~300ms.
   */
  animatedResetView() {
    this.snapToAxis(new THREE.Vector3(0, 0, 1)); // +Z = front view = default (0,0,15)
  }

  /**
   * Show a highlight sphere at the nearest axis endpoint in the triad scene.
   * Used for tap-intent preview (>150ms hold). Pass null to clear.
   */
  showAxisHighlight(axisDir: THREE.Vector3 | null) {
    // Remove existing triad highlight
    if (this._triadHighlight && this._axisScene) {
      this._axisScene.remove(this._triadHighlight);
      this._triadHighlight.geometry.dispose();
      (this._triadHighlight.material as THREE.Material).dispose();
      this._triadHighlight = null;
    }
    if (!axisDir || !this._axisScene) return;

    const geo = new THREE.SphereGeometry(0.12, 12, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
    });
    this._triadHighlight = new THREE.Mesh(geo, mat);
    this._triadHighlight.position.copy(axisDir);
    this._axisScene.add(this._triadHighlight);
  }

  // ── Background orbit engagement cue ──

  /** Brighten triad while background orbit is active — confirms gesture recognition. */
  startBackgroundOrbitCue() {
    if (!this._axisScene) return;
    const ambients = this._axisScene.children.filter(
      (c) => c instanceof THREE.AmbientLight
    ) as THREE.AmbientLight[];
    if (ambients.length > 0) ambients[0].intensity = 3.0;
  }

  /** Restore triad brightness when background orbit ends. */
  endBackgroundOrbitCue() {
    if (!this._axisScene) return;
    const ambients = this._axisScene.children.filter(
      (c) => c instanceof THREE.AmbientLight
    ) as THREE.AmbientLight[];
    if (ambients.length > 0) ambients[0].intensity = 2.0;
  }

  /**
   * Brief visual pulse on the triad to draw attention (one-time affordance).
   * Temporarily increases triad ambient light intensity, then fades back.
   * Lifecycle-safe: cancels any existing pulse, stores RAF id for cleanup.
   */
  pulseTriad() {
    if (!this._axisScene) return;
    // Cancel any in-progress pulse
    if (this._pulseRafId != null) {
      cancelAnimationFrame(this._pulseRafId);
      this._pulseRafId = null;
    }
    const ambients = this._axisScene.children.filter(
      (c) => c instanceof THREE.AmbientLight
    ) as THREE.AmbientLight[];
    if (ambients.length === 0) return;
    const original = ambients[0].intensity;
    const target = original * 2.5;
    ambients[0].intensity = target;
    const start = performance.now();
    const duration = 600;
    const fade = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      ambients[0].intensity = target + (original - target) * t;
      if (t < 1) {
        this._pulseRafId = requestAnimationFrame(fade);
      } else {
        this._pulseRafId = null;
      }
    };
    this._pulseRafId = requestAnimationFrame(fade);
  }

  /**
   * Create a professional axis triad indicator (ParaView/OVITO style).
   * Uses 3D ArrowHelpers with X/Y/Z labels in a separate orthographic
   * scene, rendered via scissor test in a corner mini-viewport.
   */
  _initAxisTriad() {
    this._axisScene = new THREE.Scene();
    this._axisCamera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 10);
    this._axisCamera.position.set(0, 0, 4);
    this._axisCamera.lookAt(0, 0, 0);

    // Coarse-pointer check for triad sizing — available immediately (no device-mode needed).
    // Matches phone/tablet with imprecise primary pointer; desktop touchscreens with
    // precise pointer stay on the desktop path.
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;
    const len = 1.0;
    const headLen = isCoarse ? 0.28 : 0.22;  // larger arrow heads for coarse pointers
    const headW = isCoarse ? 0.13 : 0.10;

    // 3D arrows — standard convention: X=red, Y=green, Z=blue
    const axX = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0),
      len, 0xe05050, headLen, headW
    );
    const axY = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0),
      len, 0x50c050, headLen, headW
    );
    const axZ = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0),
      len, 0x5080e0, headLen, headW
    );
    this._axisScene.add(axX, axY, axZ);

    // Text labels at arrow tips using sprites (no font loading needed)
    const makeLabel = (text, color, pos) => {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.font = 'bold 48px -apple-system, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(text, 32, 32);
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      const labelScale = isCoarse ? 0.45 : 0.35;
      sprite.scale.set(labelScale, labelScale, 1);
      return sprite;
    };

    this._axisScene.add(
      makeLabel('X', '#e05050', new THREE.Vector3(1.35, 0, 0)),
      makeLabel('Y', '#50c050', new THREE.Vector3(0, 1.35, 0)),
      makeLabel('Z', '#5080e0', new THREE.Vector3(0, 0, 1.35))
    );

    // Ambient light for the axis scene
    this._axisScene.add(new THREE.AmbientLight(0xffffff, 2.0));

    // Center home glyph — subtle dot indicating double-tap reset target
    const homeDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.4, depthTest: false }),
    );
    homeDot.position.set(0, 0, 0);
    this._axisScene.add(homeDot);

    // Mini-viewport size scales with screen — smaller on tablets
    this._axisSize = Math.min(100, Math.floor(window.innerWidth * 0.08));
  }

  render() {
    this.controls.update();

    // Must clear manually because autoClear is off (needed for axis overlay)
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // ── Axis triad overlay ──
    // Sync axis camera rotation with main camera (rotation only, no translation)
    this._axisCamera.quaternion.copy(this.camera.quaternion);
    this._axisCamera.position.set(0, 0, 4).applyQuaternion(this._axisCamera.quaternion);
    this._axisCamera.lookAt(0, 0, 0);

    // Render axis triad in bottom-left corner via scissor test.
    // All values in CSS pixels — Three.js handles pixel ratio internally
    // when setPixelRatio() has been called before setSize().
    const size = this._axisSize;
    const offsetX = this._overlayLayout?.triadLeft ?? 6;
    const offsetY = this._overlayLayout?.triadBottom ?? 50;

    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    this.renderer.setViewport(offsetX, offsetY, size, size);
    this.renderer.setScissor(offsetX, offsetY, size, size);
    this.renderer.setScissorTest(true);
    this.renderer.clear(false, true, false); // clear depth only
    this.renderer.render(this._axisScene, this._axisCamera);
    this.renderer.setScissorTest(false);
    // Restore full viewport
    this.renderer.setViewport(0, 0, w, h);
  }

  getCanvas() {
    return this.renderer.domElement;
  }
}
