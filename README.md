# NanoToybox

Interactive carbon nanostructure simulation playground running real-time molecular dynamics in the browser.

Drag atoms, spin molecules, and watch carbon structures respond with real Tersoff physics — no server required.

## Demo

Serve locally and open in your browser:

```bash
git clone https://github.com/mikechwu/NanoToybox.git
cd NanoToybox
python3 -m http.server 8000
# Open http://localhost:8000/page/
```

Or visit the live demo at [mikechwu.github.io/NanoToybox](https://mikechwu.github.io/NanoToybox/page/).

## Features

- **Real-time Tersoff potential** — full analytical carbon force field running in optimized JavaScript
- **Drag atoms** — left-click and pull; spring force in the camera plane
- **Rotate molecules** — Ctrl+click; torque via inertia tensor, distributed to all atoms
- **15 structure presets** — C60, C180, C540, C720, carbon nanotubes (armchair/zigzag/chiral), graphene, diamond
- **3D rendering** — PBR materials, camera-relative lighting, XYZ orientation axes
- **NVE dynamics by default** — energy-conserving; molecules vibrate indefinitely after interaction. Adjustable damping slider (0 to heavy)
- **Dark/Light themes** — full UI adaptation
- **Works on desktop and mobile** — mouse and touch interaction
- **No build step** — pure ES modules loaded via importmap from CDN

## How It Works

The page loads relaxed carbon structures from a pre-computed library, then runs the Tersoff (1988) interatomic potential in JavaScript at ~30 FPS. User interactions (drag, rotate) inject forces into the simulation, and the structure responds through real bond forces — not animation.

| Component | Technology |
|-----------|-----------|
| Physics | Tersoff potential, Velocity Verlet integration |
| Rendering | Three.js v0.170, MeshStandardMaterial (PBR) |
| Interaction | Raycasting + camera-plane projection |
| Rotation | Torque via diagonal inertia tensor, inertia-normalized |
| UI | Vanilla JS, glassmorphic panels, axis triad |

## Controls

### Desktop

| Gesture | Action |
|---------|--------|
| Left-drag on atom | Drag atom |
| Ctrl+click on atom | Rotate molecule |
| Right-drag | Orbit camera |
| Scroll | Zoom |

### Mobile

| Gesture | Action |
|---------|--------|
| 1-finger drag on atom | Drag atom |
| 2 fingers on 2 atoms | Rotate molecule |
| 2-finger pinch | Zoom |
| 2-finger drag | Pan camera |

## Project Structure

```
NanoToybox/
├── page/                   # Interactive playground (main app)
│   ├── index.html
│   └── js/
│       ├── config.js       # Centralized configuration
│       ├── main.js         # Entry point, session state
│       ├── physics.js      # Tersoff force engine
│       ├── renderer.js     # Three.js scene
│       ├── input.js        # Mouse/touch handling
│       ├── state-machine.js
│       ├── loader.js       # Structure library loader
│       ├── fps-monitor.js
│       └── themes.js
├── viewer/                 # Pre-computed trajectory viewer
├── sim/                    # Python simulation engine
│   ├── potentials/         # Tersoff (Python + Numba)
│   ├── integrators/        # Velocity Verlet
│   ├── structures/         # Geometry generators
│   └── io/                 # XYZ output
├── structures/library/     # 15 relaxed 0K structures
├── scripts/                # CLI tools, scaling research
├── tests/                  # 8 physics validation tests
└── docs/                   # Developer documentation
```

## Development

### Python simulation engine

```bash
# Install dependencies
pip install numpy numba matplotlib

# Run validation tests
python3 tests/test_01_dimer.py
python3 tests/test_04_c60.py

# Generate a new structure
python3 scripts/library_cli.py c60
python3 scripts/library_cli.py cnt 5 5 --cells 5
```

### Interactive page

No build step required. Serve from repo root:

```bash
python3 -m http.server 8000
# Open http://localhost:8000/page/
```

Three.js is loaded from CDN via ES module importmap.

## Documentation

Detailed docs in [`docs/`](docs/):

- [Architecture](docs/architecture.md) — module map, data flow
- [Physics](docs/physics.md) — Tersoff potential, units, validation
- [Structure Library](docs/structure-library.md) — 15 canonical structures
- [Viewer & Interactive Page](docs/viewer.md) — features, module contracts
- [Scaling Research](docs/scaling-research.md) — real-time limits, collision benchmarks
- [Decisions](docs/decisions.md) — key design rationale
- [Contributing](docs/contributing.md) — development guide

## License

[MIT](LICENSE)
