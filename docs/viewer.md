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
| Playback | Play/pause (space), frame step (arrows), slider, speed (1–30 fps), auto-loop |
| Rendering | Phong-shaded spheres, distance-based bonds, 3-point lighting |
| Camera | OrbitControls: drag=rotate, scroll=zoom, right-drag=pan, damped |
| Perspective | PerspectiveCamera FOV 60 (true 3D depth) |
| Styles | Dark Carbon / Light / Element Colors |
| Bond control | Toggle + cutoff slider (1.0–2.5 Å) |

## Technology

- Three.js v0.170 (loaded from CDN)
- OrbitControls from Three.js addons
- No framework, no build tools — single HTML file with inline JS

## Integration with Simulator

The simulator writes XYZ trajectories via `sim/io/output.py`. These are directly loadable by the viewer. Example files in `outputs/test4_c60/trajectory.xyz`.

## Future: Browser Simulation

The planned architecture for the interactive website:
```
Three.js Viewer ←→ Wasm Tersoff Engine ←→ Structure Library (XYZ presets)
                         ↑
                   User controls (T, play/pause, structure selection)
```

The viewer already handles rendering and playback. The missing piece is the Wasm force engine that runs simulation in real-time and feeds frames to the viewer.
