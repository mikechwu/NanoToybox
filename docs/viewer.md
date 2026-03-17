# Trajectory Viewer

## Overview

A single-file Three.js molecular viewer at `viewer/index.html`. No build step, no npm, no server required.

## Usage

```bash
# Option 1: Open directly, then drag-drop an .xyz file
open viewer/index.html

# Option 2: Serve from repo root (auto-loads example trajectories)
python3 -m http.server 8000
# Open http://localhost:8000/viewer/
```

## Features

| Feature | Details |
|---------|---------|
| File loading | XYZ/extended XYZ, drag-and-drop or file picker |
| Playback | Play/pause (space), frame step (arrows), slider, auto-loop |
| Speed | 1 / 5 / 15 / 30 (default) / 60 fps |
| Stride | 1 / 2 / 5 / 10 / 20 (default) / 50 / 100 frames |
| Rendering | Dark carbon atoms, light gray bonds, PBR shading (MeshStandardMaterial) |
| Lighting | Camera-relative 4-light rig: key + fill + rim + ambient, ACES filmic tone mapping |
| Camera | OrbitControls: drag=rotate, scroll=zoom, right-drag=pan, damped |
| Perspective | PerspectiveCamera FOV 50 |
| Themes | Dark (default) / Light |
| Bond control | Toggle + cutoff slider (1.0–2.5 Å) |

### Stride

The stride control (labeled "Stride" in the toolbar) sets how many frames to advance per playback tick. This follows the standard molecular visualization convention used by VMD, PyMOL, and GROMACS. For example, stride 20 at 30 fps plays a 900-frame trajectory in ~1.5 seconds.

Stride affects:
- Play/pause playback (advances by stride frames per tick)
- Arrow key stepping (jumps by stride frames)
- Prev/Next button stepping

The slider still allows scrubbing to any individual frame regardless of stride setting.

### Themes

Two themes are available:

| Theme | Background | Atoms | Bonds |
|-------|-----------|-------|-------|
| Dark (default) | Dark blue-gray (#181820) | Dark gray (#444444) | Light gray (#909090) |
| Light | Off-white (#f2f2f0) | Charcoal (#3a3a3a) | Medium gray (#808080) |

Both themes use the same camera-relative 4-light rig (key, fill, rim, ambient) with ACES filmic tone mapping. The "sunny day" lighting model uses a strong key light (sun), moderate fill light (sky bounce), subtle rim light (edge separation), and moderate ambient (diffuse sky). All directional lights are children of the camera so shading stays consistent as the user orbits.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| Left Arrow | Previous frame (by stride) |
| Right Arrow | Next frame (by stride) |

## Technology

- Three.js v0.170 (loaded from CDN)
- OrbitControls from Three.js addons
- MeshStandardMaterial (PBR) with roughness 0.7, metalness 0 — matte with soft shading
- ACES filmic tone mapping
- Camera-relative directional lighting (follows orbit like VMD/PyMOL/ChimeraX)
- No framework, no build tools — single HTML file with inline JS

## Integration with Simulator

The simulator writes XYZ trajectories via `sim/io/output.py`. These are directly loadable by the viewer. Collision trajectories from the scaling research are at `outputs/scaling_research/collision_*.xyz`.

When served from the repo root, the viewer auto-loads example trajectories in priority order: collision C60+C60, test C60, test graphene, test dimer.

## Rendering Performance

The current viewer uses individual `THREE.Mesh` per atom and O(N²) bond detection. See [scaling-research.md](scaling-research.md) for detailed measurements.

| Atoms | Est. Frame Time | Est. FPS |
|------:|----------------:|---------:|
| 60 | 3 ms | 144 |
| 200 | 25 ms | 40 |
| 500 | 137 ms | 7 |
| 1,000 | 525 ms | 2 |

For trajectory playback (pre-computed frames), the bond detection runs per frame change. Using a high stride value effectively reduces the rendering load by skipping intermediate bond recalculations.

## Future: Browser Simulation

The planned architecture for the interactive website:
```
Three.js Viewer <-> Wasm Tersoff Engine <-> Structure Library (XYZ presets)
                         |
                   User controls (T, play/pause, structure selection)
```

The viewer already handles rendering and playback. The missing piece is the Wasm force engine that runs simulation in real-time and feeds frames to the viewer.

### Rendering Optimization Path

For real-time simulation with >250 atoms, the viewer will need:

1. **InstancedMesh** — reduce draw calls from N+3N to 2 (one for atoms, one for bonds)
2. **Cell-list neighbor search** — reduce bond detection from O(N²) to O(N)
3. **Persistent bond geometry** — avoid rebuilding bond meshes every frame when bonds don't change

These optimizations would push the rendering limit to ~5,000–10,000 atoms.
