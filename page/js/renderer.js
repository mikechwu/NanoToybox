/**
 * Three.js renderer — scene management, PBR materials, visual feedback.
 *
 * Camera-relative lighting rig (key/fill/rim + ambient) follows orbit.
 * MeshStandardMaterial with roughness=0.7, metalness=0.
 * State-driven feedback: highlight, force line, rotation cue.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import { THEMES } from './themes.js';

export class Renderer {
  constructor(container) {
    this.container = container;
    this.atomMeshes = [];
    this.bondMeshes = [];
    this.bonds = [];
    this.highlightAtom = -1;
    this.forceLine = null;
    this.currentTheme = 'dark';

    this._initScene();
    this._initLighting();
    this._initForceLine();
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      50, window.innerWidth / window.innerHeight, 0.1, 2000
    );
    this.camera.position.set(0, 0, 15);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.autoClear = false; // needed for ViewHelper overlay
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Left-button is NOT mapped — it's handled by InputManager for atom interaction.
    // Right-button = orbit, middle = dolly, scroll = zoom — all handled by OrbitControls.
    // OrbitControls stays enabled=true always so it can process right-click and scroll.
    this.controls.mouseButtons = {
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = {
      ONE: null, // disabled — handled by InputManager
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.enabled = true; // always on — left-button excluded via mouseButtons

    // Save default camera state for reset
    this._defaultCamPos = new THREE.Vector3(0, 0, 15);
    this._defaultCamTarget = new THREE.Vector3(0, 0, 0);

    // Axis orientation indicator (bottom-right corner)
    this.viewHelper = new ViewHelper(this.camera, this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
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
    // Reset highlight index BEFORE replacing meshes to avoid stale index
    this.highlightAtom = -1;

    // Dispose old GPU resources to prevent memory leaks
    if (this.atomMeshes.length > 0) {
      this.atomMeshes[0].geometry.dispose(); // shared geometry
    }
    this.atomMeshes.forEach(m => {
      this.scene.remove(m);
      m.material.dispose();
    });
    if (this.bondMeshes.length > 0) {
      this.bondMeshes[0].geometry.dispose(); // shared geometry
    }
    this.bondMeshes.forEach(m => {
      this.scene.remove(m);
      m.material.dispose();
    });
    this.atomMeshes = [];
    this.bondMeshes = [];
    this.bonds = bonds;

    const t = THEMES[this.currentTheme];
    const atomGeom = new THREE.SphereGeometry(0.35, 24, 16);

    // Center of mass
    let cx = 0, cy = 0, cz = 0;
    atoms.forEach(a => { cx += a.x; cy += a.y; cz += a.z; });
    cx /= atoms.length; cy /= atoms.length; cz /= atoms.length;
    this.comOffset = [cx, cy, cz];

    atoms.forEach(a => {
      const mat = new THREE.MeshStandardMaterial({
        color: t.atom,
        roughness: 0.7,
        metalness: 0.0,
      });
      const mesh = new THREE.Mesh(atomGeom, mat);
      mesh.position.set(a.x - cx, a.y - cy, a.z - cz);
      this.scene.add(mesh);
      this.atomMeshes.push(mesh);
    });

    // Pre-allocate bond meshes
    const bondGeom = new THREE.CylinderGeometry(0.07, 0.07, 1, 12);
    bonds.forEach(() => {
      const mat = new THREE.MeshStandardMaterial({
        color: t.bond,
        roughness: 0.7,
        metalness: 0.0,
      });
      const mesh = new THREE.Mesh(bondGeom, mat);
      this.scene.add(mesh);
      this.bondMeshes.push(mesh);
    });

    this._updateBondTransforms();
    this._fitCamera();

    // Force immediate matrix update so raycasting works before next render frame.
    // Without this, new meshes have matrixWorld = identity until renderer.render()
    // runs, causing raycasts to miss all atoms between loadStructure() and the
    // next animation frame.
    this.scene.updateMatrixWorld(true);
  }

  updatePositions(physics) {
    const [cx, cy, cz] = this.comOffset;
    for (let i = 0; i < this.atomMeshes.length; i++) {
      const [x, y, z] = physics.getPosition(i);
      this.atomMeshes[i].position.set(x - cx, y - cy, z - cz);
    }

    // Sync bond topology (bonds may have changed)
    const currentBonds = physics.getBonds();
    if (currentBonds.length !== this.bonds.length) {
      this._syncBonds(currentBonds);
    }
    this._updateBondTransforms();
  }

  _syncBonds(newBonds) {
    // Remove excess bond meshes and dispose their materials
    while (this.bondMeshes.length > newBonds.length) {
      const mesh = this.bondMeshes.pop();
      this.scene.remove(mesh);
      mesh.material.dispose();
    }
    // Add new bond meshes if needed
    const t = THEMES[this.currentTheme];
    const bondGeom = new THREE.CylinderGeometry(0.07, 0.07, 1, 12);
    while (this.bondMeshes.length < newBonds.length) {
      const mat = new THREE.MeshStandardMaterial({
        color: t.bond, roughness: 0.7, metalness: 0.0,
      });
      const mesh = new THREE.Mesh(bondGeom, mat);
      this.scene.add(mesh);
      this.bondMeshes.push(mesh);
    }
    this.bonds = newBonds;
  }

  _updateBondTransforms() {
    const up = new THREE.Vector3(0, 1, 0);
    for (let b = 0; b < this.bonds.length; b++) {
      const [i, j] = this.bonds[b];
      if (i >= this.atomMeshes.length || j >= this.atomMeshes.length) continue;
      const pi = this.atomMeshes[i].position;
      const pj = this.atomMeshes[j].position;
      const dx = pj.x - pi.x, dy = pj.y - pi.y, dz = pj.z - pi.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const mesh = this.bondMeshes[b];
      // Hide bonds that have stretched beyond physical range
      if (dist > 2.0) {
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
      const dir = new THREE.Vector3(dx, dy, dz).normalize();
      mesh.quaternion.setFromUnitVectors(up, dir);
    }
  }

  setHighlight(atomIndex) {
    // Clear previous
    if (this.highlightAtom >= 0 && this.highlightAtom < this.atomMeshes.length) {
      const prev = this.atomMeshes[this.highlightAtom];
      prev.material.emissiveIntensity = 0;
      prev.material.emissive.set(0x000000);
      prev.scale.setScalar(1.0);
    }

    this.highlightAtom = atomIndex;

    if (atomIndex >= 0 && atomIndex < this.atomMeshes.length) {
      const mesh = this.atomMeshes[atomIndex];
      mesh.material.emissive.set(0x335544);
      mesh.material.emissiveIntensity = 1.0;
      mesh.scale.setScalar(1.15);
    }
  }

  showForceLine(fromAtomIndex, toWorldX, toWorldY, toWorldZ) {
    if (fromAtomIndex < 0) return;
    const atomPos = this.atomMeshes[fromAtomIndex].position;
    const [cx, cy, cz] = this.comOffset;
    const positions = this.forceLine.geometry.attributes.position.array;
    positions[0] = atomPos.x;
    positions[1] = atomPos.y;
    positions[2] = atomPos.z;
    positions[3] = toWorldX - cx;
    positions[4] = toWorldY - cy;
    positions[5] = (toWorldZ !== undefined ? toWorldZ : atomPos.z + cz) - cz;
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
    const { hoverAtom, activeAtom, isDragging, isRotating } = feedbackState;

    // Determine which atom should be highlighted
    const targetAtom = activeAtom >= 0 ? activeAtom : hoverAtom;

    // Only update if changed
    if (targetAtom !== this.highlightAtom) {
      this.setHighlight(targetAtom);
    }

    // Dragging gets stronger highlight
    if (isDragging && activeAtom >= 0 && activeAtom < this.atomMeshes.length) {
      const mesh = this.atomMeshes[activeAtom];
      mesh.material.emissive.set(0x446655);
      mesh.material.emissiveIntensity = 1.2;
      mesh.scale.setScalar(1.2);
    }

    // Force line visibility tied to drag state
    if (!isDragging) {
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

    this.atomMeshes.forEach(m => m.material.color.set(t.atom));
    this.bondMeshes.forEach(m => m.material.color.set(t.bond));
  }

  _fitCamera() {
    if (this.atomMeshes.length === 0) return;
    let maxR = 0;
    this.atomMeshes.forEach(m => {
      const r = m.position.length();
      if (r > maxR) maxR = r;
    });
    const dist = maxR * 2.5 + 5;
    this.camera.position.set(0, 0, dist);
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    // Save for resetView
    this._defaultCamPos.set(0, 0, dist);
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

  render() {
    this.controls.update();

    // Must clear manually because autoClear is off (needed for ViewHelper overlay)
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // Render the axis orientation helper on top without clearing the main scene
    this.viewHelper.render(this.renderer);
  }

  getCanvas() {
    return this.renderer.domElement;
  }
}
