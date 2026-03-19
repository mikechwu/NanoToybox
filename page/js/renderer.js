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
    this.atomMeshes = [];
    this.bondMeshes = [];
    this._activeBonds = 0;
    this.highlightAtom = -1;
    this.forceLine = null;
    this.currentTheme = 'dark';
    this._previewGroup = null;  // THREE.Group for placement preview

    // Pre-allocated vectors reused every frame (avoid GC pressure)
    this._bondUp = new THREE.Vector3(0, 1, 0);
    this._bondDir = new THREE.Vector3();

    this._initScene();
    this._initLighting();
    this._initForceLine();
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
    const resizeHandler = () => this._syncSize();
    window.addEventListener('resize', resizeHandler);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', resizeHandler);
    }
    // Deferred resize to catch iPad Safari layout settling after load
    setTimeout(resizeHandler, 100);
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
    // Dispose cloned highlight material before clearing meshes
    if (this.highlightAtom >= 0 && this.highlightAtom < this.atomMeshes.length) {
      const hm = this.atomMeshes[this.highlightAtom];
      if (hm.material !== this._atomMat) hm.material.dispose();
    }
    this.highlightAtom = -1;

    // Dispose old GPU resources
    if (this._atomGeom) this._atomGeom.dispose();
    if (this._atomMat) this._atomMat.dispose();
    if (this._bondGeom) this._bondGeom.dispose();
    if (this._bondMat) this._bondMat.dispose();
    this.atomMeshes.forEach(m => this.scene.remove(m));
    this.bondMeshes.forEach(m => this.scene.remove(m));
    this.atomMeshes = [];
    this.bondMeshes = [];
    this._activeBonds = 0;

    const t = THEMES[this.currentTheme];
    this._atomGeom = new THREE.SphereGeometry(
      CONFIG.atoms.radius, CONFIG.atoms.segments[0], CONFIG.atoms.segments[1]
    );
    this._atomMat = new THREE.MeshStandardMaterial({
      color: t.atom,
      roughness: CONFIG.material.roughness,
      metalness: CONFIG.material.metalness,
    });

    // Atoms rendered in physics space (no centering offset)
    atoms.forEach(a => {
      const mesh = new THREE.Mesh(this._atomGeom, this._atomMat);
      mesh.position.set(a.x, a.y, a.z);
      this.scene.add(mesh);
      this.atomMeshes.push(mesh);
    });

    // Pre-allocate bond meshes — shared geometry and material
    this._bondGeom = new THREE.CylinderGeometry(
      CONFIG.bondMesh.radius, CONFIG.bondMesh.radius, 1, CONFIG.bondMesh.segments
    );
    this._bondMat = new THREE.MeshStandardMaterial({
      color: t.bond,
      roughness: CONFIG.material.roughness,
      metalness: CONFIG.material.metalness,
    });
    bonds.forEach(() => {
      const mesh = new THREE.Mesh(this._bondGeom, this._bondMat);
      this.scene.add(mesh);
      this.bondMeshes.push(mesh);
    });
    this._activeBonds = bonds.length;

    this._updateBondTransforms(bonds);
    this._fitCamera();

    // Force immediate matrix update so raycasting works before next render frame.
    // Without this, new meshes have matrixWorld = identity until renderer.render()
    // runs, causing raycasts to miss all atoms between loadStructure() and the
    // next animation frame.
    this.scene.updateMatrixWorld(true);
  }

  updatePositions(physics) {
    for (let i = 0; i < this.atomMeshes.length; i++) {
      const [x, y, z] = physics.getPosition(i);
      this.atomMeshes[i].position.set(x, y, z);
    }

    const bonds = physics.getBonds();
    this._syncBondPool(bonds.length);
    this._updateBondTransforms(bonds);
  }

  /**
   * Ensure the bond mesh pool has at least `needed` meshes.
   * Excess meshes are hidden (not removed from the scene) to avoid
   * Three.js internal array rebuilds that cause frame drops.
   */
  _syncBondPool(needed) {
    // Grow pool if needed
    while (this.bondMeshes.length < needed) {
      const mesh = new THREE.Mesh(this._bondGeom, this._bondMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.bondMeshes.push(mesh);
    }
    // Hide any meshes beyond the active count (handled in _updateBondTransforms)
    this._activeBonds = needed;
  }

  /**
   * Position, orient, and show/hide bond meshes to match the current bond list.
   * Bonds beyond _activeBonds are hidden. Bonds stretched beyond the visibility
   * cutoff are also hidden.
   */
  _updateBondTransforms(bonds) {
    // Update active bonds
    for (let b = 0; b < this._activeBonds; b++) {
      const [i, j] = bonds[b];
      if (i >= this.atomMeshes.length || j >= this.atomMeshes.length) continue;
      const pi = this.atomMeshes[i].position;
      const pj = this.atomMeshes[j].position;
      const dx = pj.x - pi.x, dy = pj.y - pi.y, dz = pj.z - pi.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const mesh = this.bondMeshes[b];
      // Hide bonds that have stretched beyond physical range
      if (dist > CONFIG.bonds.visibilityCutoff) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(
        (pi.x + pj.x) / 2,
        (pi.y + pj.y) / 2,
        (pi.z + pj.z) / 2
      );
      mesh.scale.y = dist;
      this._bondDir.set(dx, dy, dz).normalize();
      mesh.quaternion.setFromUnitVectors(this._bondUp, this._bondDir);
    }
    // Hide pooled meshes beyond active count
    for (let b = this._activeBonds; b < this.bondMeshes.length; b++) {
      this.bondMeshes[b].visible = false;
    }
  }

  setHighlight(atomIndex) {
    // Clear previous — restore shared material
    if (this.highlightAtom >= 0 && this.highlightAtom < this.atomMeshes.length) {
      const prev = this.atomMeshes[this.highlightAtom];
      if (prev.material !== this._atomMat) {
        prev.material.dispose();
        prev.material = this._atomMat;
      }
      prev.scale.setScalar(1.0);
    }

    this.highlightAtom = atomIndex;

    if (atomIndex >= 0 && atomIndex < this.atomMeshes.length) {
      const mesh = this.atomMeshes[atomIndex];
      // Clone material for the highlighted atom so emissive doesn't affect all atoms
      if (mesh.material === this._atomMat) {
        mesh.material = this._atomMat.clone();
      }
      mesh.material.emissive.set(0x335544);
      mesh.material.emissiveIntensity = 1.0;
      mesh.scale.setScalar(1.15);
    }
  }

  showForceLine(fromAtomIndex, toWorldX, toWorldY, toWorldZ) {
    if (fromAtomIndex < 0) return;
    const atomPos = this.atomMeshes[fromAtomIndex].position;
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
    if (isActive && activeAtom >= 0 && activeAtom < this.atomMeshes.length) {
      const mesh = this.atomMeshes[activeAtom];
      if (mesh.material !== this._atomMat) {
        if (isMoving) {
          // Blue tint for Move mode
          mesh.material.emissive.set(0x445566);
          this.forceLine.material.color.set(0x66aaff);
        } else {
          // Green tint for Atom drag and Rotate
          mesh.material.emissive.set(0x446655);
          this.forceLine.material.color.set(0x66ffaa);
        }
        mesh.material.emissiveIntensity = 1.2;
      }
      mesh.scale.setScalar(1.2);
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
    // Update cloned highlight material if active
    if (this.highlightAtom >= 0 && this.highlightAtom < this.atomMeshes.length) {
      const m = this.atomMeshes[this.highlightAtom];
      if (m.material !== this._atomMat) m.material.color.set(t.atom);
    }
  }

  /**
   * Append atom meshes for a newly placed molecule.
   * Does NOT clear existing meshes — adds to the current scene.
   * Bond meshes are NOT added here — they are managed by the pool
   * in _syncBondPool() during updatePositions().
   */
  appendMeshes(atoms) {
    if (CONFIG.debug.failRendererAppend) throw new Error('[debug] Injected renderer append failure');
    const t = THEMES[this.currentTheme];
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
    const startIdx = this.atomMeshes.length;
    try {
      atoms.forEach(a => {
        const mesh = new THREE.Mesh(this._atomGeom, this._atomMat);
        mesh.position.set(a.x, a.y, a.z);
        this.scene.add(mesh);
        this.atomMeshes.push(mesh);
      });
      this.scene.updateMatrixWorld(true);
    } catch (e) {
      // Remove any meshes added before the failure
      while (this.atomMeshes.length > startIdx) {
        const mesh = this.atomMeshes.pop();
        this.scene.remove(mesh);
      }
      throw e;
    }
  }

  /**
   * Clear all atom and bond meshes from the scene.
   */
  clearAllMeshes() {
    if (this.highlightAtom >= 0 && this.highlightAtom < this.atomMeshes.length) {
      const hm = this.atomMeshes[this.highlightAtom];
      if (hm.material !== this._atomMat) hm.material.dispose();
    }
    this.highlightAtom = -1;
    this.atomMeshes.forEach(m => this.scene.remove(m));
    this.bondMeshes.forEach(m => this.scene.remove(m));
    this.atomMeshes = [];
    this.bondMeshes = [];
    this._activeBonds = 0;
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
    if (this.atomMeshes.length === 0) return;
    // Compute COM and bounding radius from atom positions (physics space)
    let cx = 0, cy = 0, cz = 0;
    this.atomMeshes.forEach(m => {
      cx += m.position.x; cy += m.position.y; cz += m.position.z;
    });
    cx /= this.atomMeshes.length;
    cy /= this.atomMeshes.length;
    cz /= this.atomMeshes.length;

    let maxR = 0;
    this.atomMeshes.forEach(m => {
      const dx = m.position.x - cx, dy = m.position.y - cy, dz = m.position.z - cz;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (r > maxR) maxR = r;
    });
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

  /** Reset camera to default empty-scene position (origin-centered). */
  resetToEmpty() {
    this.camera.position.set(0, 0, 15);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this._defaultCamPos.set(0, 0, 15);
    this._defaultCamTarget.set(0, 0, 0);
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
    const offsetX = 6;
    const offsetY = 50; // above controls bar

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
