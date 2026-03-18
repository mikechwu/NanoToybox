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
| Structures | 15 presets loaded from library (C60, CNTs, graphene, diamond, fullerenes) |
| Drag | Left-click atom, spring force in camera plane (3D) |
| Rotate | Ctrl+click atom, torque distributed to all atoms via inertia tensor |
| Camera | Right-drag = orbit, scroll = zoom (OrbitControls, always active) |
| Physics | Full analytical Tersoff potential, Velocity Verlet, 4 substeps/frame |
| Rendering | MeshStandardMaterial (PBR), camera-relative 4-light rig, axis triad |
| Themes | Dark (default) / Light |
| Advanced | Adjustable drag strength, rotation strength sliders |
| FPS | Real frame computation time displayed (not vsync rate) |
| Reset | Reset structure (reload atoms) and Reset View (restore camera) buttons |

### Interaction Model

| Gesture (Desktop) | Action |
|--------------------|--------|
| Left-drag on atom | Drag atom with spring force (camera plane) |
| Ctrl+click on atom | Rotate molecule (torque via inertia tensor) |
| Right-drag | Orbit camera |
| Scroll wheel | Zoom |

| Gesture (Mobile) | Action |
|-------------------|--------|
| 1-finger drag on atom | Drag atom |
| 2-finger pinch | Zoom |
| 2-finger drag | Pan camera |

### Physics Engine

The page runs a full analytical Tersoff (1988) potential in JavaScript:
- Same parameters and algorithm as the Python reference (`sim/potentials/tersoff.py`)
- Optimized with flat `Float64Array` caches (no Map overhead)
- Neighbor list rebuilt every 10 steps
- Velocity Verlet integration with proper eV/Å → Å/fs² unit conversion
- Drag: spring force `F = K_DRAG × (target - atom)` in camera-perpendicular plane
- Rotation: spring force → torque → angular acceleration via diagonal inertia tensor → distributed tangential forces on all atoms. Inertia-normalized so `K_ROTATE` feels consistent across molecule sizes.

### Architecture

```
page/index.html
  └── js/main.js (entry point, frame loop)
        ├── loader.js       → fetch manifest.json + XYZ → atoms + bonds
        ├── physics.js      → Tersoff forces, Verlet integration, drag/rotate
        ├── state-machine.js → interaction states (idle/hover/drag/rotate)
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
| `physics.js` | Atom positions, velocities, forces, Tersoff computation | Drag/rotate targets from main.js | Positions, bonds, KE via getter methods |
| `renderer.js` | Three.js scene, meshes, lighting, axis triad | Positions from physics, theme from main.js | Canvas element, atom mesh array for raycasting |
| `input.js` | Event handling, raycasting, screen-to-world projection | Mesh array + camera from renderer | Atom index + screen coords via callbacks |
| `state-machine.js` | Interaction state transitions (IDLE→DRAG→IDLE etc.) | Pointer events from input.js | Commands dispatched to main.js |
| `loader.js` | XYZ parsing, manifest fetching, bond topology | Library path from config | `{ atoms, bonds }` data |
| `main.js` | App lifecycle, session state, command dispatch, UI wiring | Everything above | Orchestration (no direct exports) |
| `fps-monitor.js` | Frame time measurement | begin/end calls from main.js | FPS display text |
| `themes.js` | Color/lighting definitions | — | `THEMES` object |

**Key rule:** modules import from `config.js` for shared constants. They do NOT import from each other's internals. Data flows through `main.js` orchestration.

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
