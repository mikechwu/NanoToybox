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
| Rendering | InstancedMesh (2 draw calls for atoms+bonds), MeshStandardMaterial (PBR), camera-relative 4-light rig, axis triad |
| Themes | Dark (default) / Light |
| Advanced | Adjustable drag strength, rotation strength, damping, speed, and boundary mode (Contain/Remove) |
| Containment boundary | Contain mode (soft harmonic wall bounces atoms back) or Remove mode (atoms deleted past boundary). Live atom count in control bar. Wall radius auto-scales with atom count (CONFIG.wall.density). Toggle in Advanced panel. |
| Speed control | 0.5x, 1x, 2x, 4x, Max — canonical 1x = 240 steps/sec independent of display refresh |
| Pause | Primary control — freezes physics, camera/UI remain active |
| Status | Sim speed (Nx), MD rate (ps/s), hardware-limited indicator. Tap to expand on mobile |
| Scene controls | Add Molecule, Add Another, Clear playground, Reset View |

### Interaction Modes

The control bar has a three-way mode selector: **Atom** | **Move** | **Rotate**. The mode determines what happens when the user drags an atom. Mode persists across structure loads.

| Mode | Physics behavior |
|------|-----------------|
| Atom (default) | Spring force on single atom (camera plane) |
| Move | Uniform force on connected component, normalized by component size. Blue highlight/force line. Detached fragments are unaffected. Force line originates from picked atom (v1 limitation) |
| Rotate | Torque via diagonal inertia tensor, distributed as tangential forces |

### Speed & Pause

**Pause** is a primary control in the main control bar. Physics freezes; camera, UI, and input remain active. Resume resets the accumulator to prevent catch-up burst.

**Speed** is in the Advanced panel: `0.5x | 1x | 2x | 4x | Max`. Canonical 1x = 240 steps/sec, independent of display refresh rate (fixes the old monitor-dependent behavior). Speed buttons above the current `maxSpeed` are disabled. **Max** is always enabled — it tracks the live maximum sustainable speed.

**Selected vs effective speed**: the user selects a target speed. The scheduler delivers the actual speed the hardware can sustain. Status shows both: `Sim 2.0x · 0.24 ps/s`. When hardware-limited: `Hardware-limited · Sim 1.6x · 0.19 ps/s`.

**Warm-up**: after scene changes or clear, the profiler needs ~30 steps to estimate costs. During warm-up, speed is capped at 1x, fixed buttons are disabled, and status shows `Estimating...`.

**MD rate**: displayed alongside relative speed. `mdRate = effectiveSpeed × 240 × 0.5fs / 1000 = ps/s`. Gives users a physically meaningful throughput metric.

**Overload**: if the scene is too heavy, the scheduler enters an overloaded mode that caps the accumulator and reports the true sustainable speed. Recovery blends back to the normal estimator over ~1s.

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
- On-the-fly distance computation — no N×N distance/unit-vector cache (benchmarked 45% faster than cached at 2040 atoms, eliminates 127 MB memory)
- Cell-list spatial acceleration for neighbor and bond detection (O(N) instead of O(N²) all-pairs)
- Neighbor list rebuilt every 10 steps
- Velocity Verlet integration with proper eV/Å → Å/fs² unit conversion
- **NVE by default** — no artificial damping; energy injected by user persists as thermal vibration. User-adjustable damping available (0 = NVE, up to 0.5 = heavy viscous drag, cubic slider scale)
- Drag (Atom mode): spring force `F = K_DRAG × (target - atom)` on the selected atom, in camera-perpendicular plane
- Translation (Move mode): uniform force applied to all atoms in the picked atom's **connected component** (patch), normalized by component size. Total force is `K_DRAG × displacement`, independent of patch size. Detached fragments are not affected. Components are recomputed from the bond graph via Union-Find after each bond refresh (~every 5 frames)
- Rotation (Rotate mode): spring force → torque → angular acceleration via diagonal inertia tensor → distributed tangential forces, scoped to the picked atom's **connected component**. COM and inertia are computed over the component only. Inertia-normalized so `K_ROTATE` feels consistent across patch sizes
- Safety guards: per-atom velocity hard cap and total KE cap (only trigger on extreme inputs)
- Containment boundary: soft harmonic wall at dynamically computed radius (`CONFIG.wall`). In Contain mode, applies `F = -K × (r - R_wall) / r` for atoms outside R_wall. In Remove mode, wall force is off; atoms beyond R_wall + removeMargin are deleted. Wall radius = `cbrt(3N / (4π × density)) + padding`, monotonically increasing in Contain mode, allows hysteresis-gated shrinkage in Remove mode. Wall center recenters from surviving atoms after large removals (>25% threshold).

### Architecture

```
page/index.html
  └── js/main.js (entry point, frame loop, atom-source abstraction)
        ├── loader.js       → fetch manifest.json + XYZ → atoms + bonds
        ├── physics.js      → Tersoff forces (on-the-fly distances), spatial-hash neighbor/bond,
        │                      Verlet integration, drag/rotate, Union-Find components
        ├── state-machine.js → interaction states (idle/hover/drag/move/rotate)
        ├── input.js        → mouse/touch → raycasting via atom-source → state machine events
        ├── renderer.js     → InstancedMesh atoms/bonds, highlight overlay, axis triad
        ├── fps-monitor.js  → frame time measurement
        ├── themes.js       → dark/light definitions
        └── tersoff-wasm.js → Wasm kernel bridge (lazy-load, buffer mgmt, CSR marshaling, JS fallback)
  └── bench/                → performance benchmarks and validation
        ├── bench-physics.html      — physics-only microbench
        ├── bench-render.html       — raw Three.js renderer test
        ├── bench-distance.html     — Tersoff kernel benchmark
        ├── bench-celllist.html     — spatial-hash equivalence validation
        ├── bench-preWasm.html      — pre-Wasm evaluation suite
        ├── bench-kernel-profile.html — kernel stage profiling
        ├── bench-wasm.html         — Wasm kernel benchmarks
        ├── bench-spread.html       — spread-domain sparse-grid benchmark
        └── bench-scenes.js         — shared scene generator
```

### Module Contracts

Each page module has defined ownership boundaries:

| Module | Owns | Receives | Provides |
|--------|------|----------|----------|
| `config.js` | All tuning constants, thresholds, defaults | — | `CONFIG` object imported by all modules |
| `physics.js` | Atom positions, velocities, forces, Tersoff computation | Drag/move/rotate targets, damping setting from main.js | Positions, bonds, KE via getter methods, wall state (radius, mode, removed count) |
| `renderer.js` | Three.js scene, InstancedMesh atoms/bonds, lighting, axis triad, highlight overlay | Positions from physics.pos, theme from main.js | Canvas element, instancedAtoms for raycasting, getAtomWorldPosition(idx, out) API |
| `input.js` | Event handling, raycasting, screen-to-world projection | Atom-source abstraction (count, getWorldPosition, raycastTarget) + camera from renderer | Atom index + screen coords via callbacks |
| `state-machine.js` | Interaction state transitions (IDLE→DRAG/MOVE/ROTATE→IDLE etc.) | Pointer events + resolved mode from main.js | Commands dispatched to main.js |
| `loader.js` | XYZ parsing, manifest fetching, bond topology | Library path from config | `{ atoms, bonds }` data |
| `main.js` | App lifecycle, session state, command dispatch, UI wiring | Everything above | Orchestration (no direct exports) |
| `fps-monitor.js` | Frame time measurement | begin/end calls from main.js | FPS display text |
| `themes.js` | Color/lighting definitions | — | `THEMES` object |
| `tersoff-wasm.js` | Wasm lifecycle, buffer management, CSR marshaling | CSR neighbor data from physics.js | `computeForces()` or null (fallback signal) |

**Key rules:**
- Modules import from `config.js` for shared constants. They do NOT import from each other's internals. Data flows through `main.js` orchestration.
- **Interaction mode coordination:** main.js resolves gesture intent into a mode string (`'atom'` | `'move'` | `'rotate'`) before passing it to the state machine. input.js reports raw gestures (atom index + isRotate boolean). The state machine maps mode → state (e.g., `'atom'` → `DRAG`). The core engineering dependency chain for adding new modes is main.js + state-machine.js + physics.js. Depending on the mode, input.js (new gesture metadata), renderer.js (visual feedback), index.html (UI controls, help panel), and docs (viewer.md, testing.md, README.md) may also need updates.
- **Known v1 limitation:** In Move mode, the force line still originates from the picked atom rather than the center of mass, so the visual cue partly reads as "drag this atom." The blue color and immediate whole-molecule motion mitigate this, but a COM-origin force line or bounding indicator would be a stronger signal.

### Technology

- Three.js v0.170 (CDN, ES modules via importmap)
- InstancedMesh for atoms and bonds (2 draw calls, geometric capacity growth)
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

## Optimization Status

| Optimization | Status | Impact |
|-------------|--------|--------|
| **InstancedMesh** | Done | Draw calls reduced from N+bonds to 2. Geometric capacity growth, active-instance compaction for bonds. |
| **On-the-fly Tersoff** | Done | 45% faster kernel at 2040 atoms. Eliminates 127 MB N×N distance cache. |
| **Spatial-hash neighbor/bond** | Done | O(N) time and memory via Teschner hash, independent of domain extent. Shared `_buildCellGrid` helper. |
| **C/Wasm Tersoff** | Done | ~11% faster than JS JIT. Enabled by default (config.js `useWasm: true`). CSR neighbor marshaling. Automatic JS fallback on load failure. |
| **Web Workers** | Pending | Secondary architecture direction — improves responsiveness, not throughput. |

Benchmark scripts are in `page/bench/`. Run via local server to collect data.
