# Viewer & Interactive Page

## Overview

NanoToybox has two browser interfaces:

| Interface | Path | Purpose |
|-----------|------|---------|
| **Interactive Page** | `page/index.html` | Real-time Tersoff simulation with drag/rotate interaction |
| **Trajectory Viewer** | `viewer/index.html` | Pre-computed trajectory playback with stride control |

## Interactive Page (`page/`)

The interactive page is the primary user-facing application. It runs a full Tersoff potential in JavaScript, allowing users to drag, rotate, and interact with carbon nanostructures in real-time.

### Usage

```bash
# Serve from repo root (required for structure library access)
python3 -m http.server 8000
# Open http://localhost:8000/page/
```

### Features

| Feature | Details |
|---------|---------|
| Multi-molecule | Add multiple structures to the scene via Add Molecule + placement mode |
| Placement mode | Tangent placement near target molecule, translucent preview, drag to adjust, Place/Cancel |
| Interact modes | Atom (drag single atom), Move (translate connected component), Rotate (torque on component) |
| Camera | Right-drag = orbit, scroll = zoom (OrbitControls, always active) |
| Physics | Full analytical Tersoff potential, Velocity Verlet, 4 substeps/frame, component-aware forces |
| Rendering | MeshStandardMaterial (PBR), camera-relative 4-light rig, axis triad |
| Themes | Dark (default) / Light |
| Advanced | Adjustable drag strength, rotation strength, and damping (0 = NVE to 0.5 = heavy) |
| FPS | Real frame computation time displayed (not vsync rate) |
| Scene controls | Add Molecule, Add Another, Clear playground, Reset View |

### Interaction Modes

The control bar has a three-way mode selector: **Atom** | **Move** | **Rotate**. The mode determines what happens when the user drags an atom. Mode persists across structure loads.

| Mode | Physics behavior |
|------|-----------------|
| Atom (default) | Spring force on single atom (camera plane) |
| Move | Uniform force on connected component, normalized by component size. Blue highlight/force line. Detached fragments are unaffected. Force line originates from picked atom (v1 limitation) |
| Rotate | Torque via diagonal inertia tensor, distributed as tangential forces |

### Interaction Model

| Gesture (Desktop) | Action |
|--------------------|--------|
| Left-drag on atom | Interact (depends on mode: Atom/Move/Rotate) |
| Ctrl+click on atom | Rotate molecule (shortcut, any mode) |
| Right-drag | Orbit camera |
| Scroll wheel | Zoom |

| Gesture (Mobile) | Action |
|-------------------|--------|
| 1-finger drag on atom | Interact (depends on mode: Atom/Move/Rotate) |
| 2-finger pinch | Zoom |
| 2-finger drag | Pan camera |

### Physics Engine

The page runs a full analytical Tersoff (1988) potential in JavaScript:
- Same parameters and algorithm as the Python reference (`sim/potentials/tersoff.py`)
- Optimized with flat `Float64Array` caches (no Map overhead)
- Neighbor list rebuilt every 10 steps
- Velocity Verlet integration with proper eV/Å → Å/fs² unit conversion
- **NVE by default** — no artificial damping; energy injected by user persists as thermal vibration. User-adjustable damping available (0 = NVE, up to 0.5 = heavy viscous drag, cubic slider scale)
- Drag (Atom mode): spring force `F = K_DRAG × (target - atom)` on the selected atom, in camera-perpendicular plane
- Translation (Move mode): uniform force applied to all atoms in the picked atom's **connected component** (patch), normalized by component size. Total force is `K_DRAG × displacement`, independent of patch size. Detached fragments are not affected. Components are recomputed from the bond graph via Union-Find after each bond refresh (~every 5 frames)
- Rotation (Rotate mode): spring force → torque → angular acceleration via diagonal inertia tensor → distributed tangential forces, scoped to the picked atom's **connected component**. COM and inertia are computed over the component only. Inertia-normalized so `K_ROTATE` feels consistent across patch sizes
- Safety guards: per-atom velocity hard cap and total KE cap (only trigger on extreme inputs)

### Architecture

```
page/index.html
  └── js/main.js (entry point, frame loop)
        ├── loader.js       → fetch manifest.json + XYZ → atoms + bonds
        ├── physics.js      → Tersoff forces, Verlet integration, drag/rotate
        ├── state-machine.js → interaction states (idle/hover/drag/move/rotate)
        ├── input.js        → mouse/touch → raycasting → state machine events
        ├── renderer.js     → Three.js scene, materials, lighting, axis triad
        ├── fps-monitor.js  → frame time measurement
        └── themes.js       → dark/light definitions
```

### Module Contracts

Each page module has defined ownership boundaries:

| Module | Owns | Receives | Provides |
|--------|------|----------|----------|
| `config.js` | All tuning constants, thresholds, defaults | — | `CONFIG` object imported by all modules |
| `physics.js` | Atom positions, velocities, forces, Tersoff computation | Drag/move/rotate targets, damping setting from main.js | Positions, bonds, KE via getter methods |
| `renderer.js` | Three.js scene, meshes, lighting, axis triad | Positions from physics, theme from main.js | Canvas element, atom mesh array for raycasting |
| `input.js` | Event handling, raycasting, screen-to-world projection | Mesh array + camera from renderer | Atom index + screen coords via callbacks |
| `state-machine.js` | Interaction state transitions (IDLE→DRAG/MOVE/ROTATE→IDLE etc.) | Pointer events + resolved mode from main.js | Commands dispatched to main.js |
| `loader.js` | XYZ parsing, manifest fetching, bond topology | Library path from config | `{ atoms, bonds }` data |
| `main.js` | App lifecycle, session state, command dispatch, UI wiring | Everything above | Orchestration (no direct exports) |
| `fps-monitor.js` | Frame time measurement | begin/end calls from main.js | FPS display text |
| `themes.js` | Color/lighting definitions | — | `THEMES` object |

**Key rules:**
- Modules import from `config.js` for shared constants. They do NOT import from each other's internals. Data flows through `main.js` orchestration.
- **Interaction mode coordination:** main.js resolves gesture intent into a mode string (`'atom'` | `'move'` | `'rotate'`) before passing it to the state machine. input.js reports raw gestures (atom index + isRotate boolean). The state machine maps mode → state (e.g., `'atom'` → `DRAG`). The core engineering dependency chain for adding new modes is main.js + state-machine.js + physics.js. Depending on the mode, input.js (new gesture metadata), renderer.js (visual feedback), index.html (UI controls, help panel), and docs (viewer.md, testing.md, README.md) may also need updates.
- **Known v1 limitation:** In Move mode, the force line still originates from the picked atom rather than the center of mass, so the visual cue partly reads as "drag this atom." The blue color and immediate whole-molecule motion mitigate this, but a COM-origin force line or bounding indicator would be a stronger signal.

### Technology

- Three.js v0.170 (CDN, ES modules via importmap)
- OrbitControls for camera (right-click orbit, scroll zoom)
- Custom axis triad (ArrowHelper + sprites, scissor-test viewport)
- MeshStandardMaterial with roughness 0.7, metalness 0 (PBR)
- Camera-relative 4-light rig (key/fill/rim/ambient)
- No build step, no npm — single HTML + JS modules

---

## Trajectory Viewer (`viewer/`)

The trajectory viewer plays back pre-computed XYZ trajectory files. It does not run physics.

### Usage

```bash
# Open directly, then drag-drop an .xyz file
open viewer/index.html

# Or serve and auto-load example trajectories
python3 -m http.server 8000
# Open http://localhost:8000/viewer/
```

### Features

| Feature | Details |
|---------|---------|
| Playback | Play/pause (space), frame step (arrows), slider, auto-loop |
| Speed | 1 / 5 / 15 / 30 (default) / 60 fps |
| Stride | 1 / 2 / 5 / 10 / 20 (default) / 50 / 100 frames |
| Rendering | MeshStandardMaterial (PBR), camera-relative lighting |
| Themes | Dark (default) / Light |
| Bonds | Toggle + cutoff slider (1.0–2.5 Å) |

### Rendering Performance

| Atoms | Est. FPS |
|------:|---------:|
| 60 | 144 |
| 200 | 40 |
| 500 | 7 |
| 1,000 | 2 |

For trajectory playback of large structures, use high stride values (20–100).

---

## Future Optimization

For real-time simulation beyond ~300 atoms:

1. **InstancedMesh** — reduce draw calls from N+bonds to 2
2. **Cell-list neighbor search** — reduce bond detection from O(N²) to O(N)
3. **C/Wasm Tersoff** — 5–10x speedup over JavaScript for force computation
4. **Web Workers** — offload physics to a separate thread
