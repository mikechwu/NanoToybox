/**
 * Three.js renderer — scene management, PBR materials, visual feedback.
 *
 * Camera-relative lighting rig (key/fill/rim + ambient) follows orbit.
 * MeshStandardMaterial with roughness=0.7, metalness=0.
 * State-driven feedback: highlight, force line, rotation cue.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { THEMES } from './themes.js';
import { CONFIG } from './config.js';

export class Renderer {
  constructor(container) {
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
    this.controls.mouseButtons = {
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = {
      ONE: null,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.enabled = true;

    this._defaultCamPos = new THREE.Vector3(0, 0, 15);
    this._defaultCamTarget = new THREE.Vector3(0, 0, 0);

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
        this.forceLine.material.color.set(0x66aaff);
      } else {
        // Green tint for Atom drag and Rotate
        this._highlightMat.emissive.set(0x446655);
        this.forceLine.material.color.set(0x66ffaa);
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
   * Append atom instances for a newly placed molecule.
   * Grows InstancedMesh capacity geometrically if needed.
   * Bond instances are managed during updatePositions().
   */
  appendMeshes(atoms) {
    if (CONFIG.debug.failRendererAppend) throw new Error('[debug] Injected renderer append failure');
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

    const newCount = this._atomCount + atoms.length;

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

    // Write new atom positions
    const dummy = this._dummyObj;
    for (let i = 0; i < atoms.length; i++) {
      dummy.position.set(atoms[i].x, atoms[i].y, atoms[i].z);
      dummy.scale.setScalar(1);
      dummy.quaternion.identity();
      dummy.updateMatrix();
      this._instancedAtoms.setMatrixAt(this._atomCount + i, dummy.matrix);
    }

    this._atomCount = newCount;
    this._instancedAtoms.count = newCount;
    this._instancedAtoms.instanceMatrix.needsUpdate = true;
    this.scene.updateMatrixWorld(true);
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
      ? hits.filter(h => this._previewAtomMeshes.includes(h.object))
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
    this.controls.target.set(cx, cy, cz);
    this.controls.update();

    // Save for resetView
    this._defaultCamPos.set(cx, cy, cz + dist);
    this._defaultCamTarget.set(cx, cy, cz);
  }

  /** Public API: fit camera to current atom positions. */
  fitCamera() { this._fitCamera(); }

  /** Reset camera to default empty-scene position. Retains instanced capacity. */
  resetCamera() {
    this._physicsRef = null;
    this.camera.position.set(0, 0, 15);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this._defaultCamPos.set(0, 0, 15);
    this._defaultCamTarget.set(0, 0, 0);
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
  getAtomWorldPosition(index, out) {
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
    this.camera.up.set(0, 1, 0);
    this.controls.target.copy(this._defaultCamTarget);
    this.controls.update();
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

    const len = 1.0;
    const headLen = 0.22;
    const headW = 0.10;

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
      sprite.scale.set(0.35, 0.35, 1);
      return sprite;
    };

    this._axisScene.add(
      makeLabel('X', '#e05050', new THREE.Vector3(1.35, 0, 0)),
      makeLabel('Y', '#50c050', new THREE.Vector3(0, 1.35, 0)),
      makeLabel('Z', '#5080e0', new THREE.Vector3(0, 0, 1.35))
    );

    // Ambient light for the axis scene
    this._axisScene.add(new THREE.AmbientLight(0xffffff, 2.0));

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
