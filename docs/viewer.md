# Viewer & Interactive Page

## Overview

NanoToybox has two browser interfaces:

| Interface | Path | Purpose |
|-----------|------|---------|
| **Interactive Page** | `lab/index.html` | Real-time Tersoff simulation with drag/rotate interaction |
| **Trajectory Viewer** | `viewer/index.html` | Pre-computed trajectory playback with stride control |

## Interactive Page (`lab/`)

The interactive page is the primary user-facing application. It runs a full Tersoff potential in JavaScript, allowing users to drag, rotate, and interact with carbon nanostructures in real-time.

### Usage

```bash
npm run dev
# Open http://localhost:5173/lab/
```

### Features

| Feature | Details |
|---------|---------|
| Multi-molecule | Add multiple structures to the scene via Add Molecule + placement mode |
| Placement mode | Geometry-aware orientation + tangent placement near target molecule, translucent preview, drag to adjust, Place/Cancel. Preview and commit both use pre-transformed atoms from `solvePlacement()` for parity |
| Interact modes | Atom (drag single atom), Move (translate connected component), Rotate (torque on component) |
| Camera | Orbit mode (default). Object View panel: Center + Follow buttons. Free-Look available as advanced gated mode (`CONFIG.camera.freeLookEnabled`). See controls table below |
| Physics | Full analytical Tersoff potential, Velocity Verlet, 4 substeps/frame, component-aware forces |
| Rendering | InstancedMesh (2 draw calls for atoms+bonds), MeshStandardMaterial (PBR), camera-mounted 3-light rig (SpotLight headlight + DirectionalLight fill + ambient), axis triad |
| Themes | Dark (default) / Light |
| Text size | Normal (default) / Large — Appearance section in settings. CSS-only token override via `[data-text-size]` attribute |
| Settings sheet | Adjustable drag strength, rotation strength, damping, speed, boundary mode, theme, and text size — organized in grouped sections (Scene, Simulation, Interaction, Appearance, Boundary, Help) |
| Containment boundary | Contain mode (soft harmonic wall bounces atoms back) or Remove mode (atoms deleted past boundary). Live atom count in Settings sheet (Scene section). Wall radius auto-scales with atom count (CONFIG.wall.density). Toggle in Settings sheet (Boundary section). |
| Bonded clusters | Side panel showing live connected components, fixed at 250 px via `--panel-width` CSS custom property (compact #N labels + action columns; scrollbar space reserved with `scrollbar-gutter: stable`). Expanded by default. Header: "Bonded Clusters: N" label + "Collapse"/"Expand" toggle pill; label truncates with ellipsis on narrow panels. User's expand/collapse preference persists across resets. Hover to preview (pale yellow highlight, desktop only — mouse enter shows, mouse leave clears). Row click selection is feature-gated off; rows are display-only (no `role="button"`, no `tabIndex`). Clear Highlight button is hidden. Two-level expand: large clusters + collapsible small clusters. Per-cluster color chip for authored color overrides (see Color Editing UX below). Center and Follow buttons remain fully interactive. |
| Speed control | 0.5x, 1x, 2x, 4x, Max — canonical 1x = 240 steps/sec independent of display refresh |
| Pause | Primary control — freezes physics, camera/UI remain active |
| Timeline | TimelineBar with scrub track, review mode (display-only playback of history), and restart from dense frames. Recording arms on first atom interaction (drag/move/rotate/flick) |
| Status | Message-only StatusBar: shows statusError or statusText, returns null otherwise |
| Scene controls | Add (dock) and Add Molecule (settings sheet) both open the chooser; chooser shows a pinned Recent shortcut after first placement. Clear playground, Reset View. |

### Interaction Modes

The dock has a three-way segmented mode selector: **Atom** | **Move** | **Rotate**. The mode determines what happens when the user drags an atom. Mode persists across structure loads.

| Mode | Physics behavior |
|------|-----------------|
| Atom (default) | Spring force on single atom (camera plane). Single-atom interaction highlight (cool blue). |
| Move | Uniform force on connected component, normalized by component size. **Full bonded group highlighted** on interaction layer (cool blue). Force line originates from picked atom. Detached fragments are unaffected. |
| Rotate | Torque via diagonal inertia tensor, distributed as tangential forces. **Full bonded group highlighted** on interaction layer (cool blue). |

### Highlight Composition

The renderer uses two independent highlight layers, each backed by its own InstancedMesh halo ring. Setters update state only; a single compositor renders both layers each frame.

| Layer | Role | Color | renderOrder |
|-------|------|-------|-------------|
| **Panel layer** | Bonded-group highlight. Persistent click-select is feature-gated off; layer is used only for transient hover preview | Warm amber / pale yellow | 2 |
| **Interaction layer** | Transient Move/Rotate highlight (active during drag) | Cool blue | 3 |

With click-select gated off, the panel layer only carries transient hover previews. Overlap (panel + interaction) is possible only during a concurrent hover and drag, which is rare in practice.

**CONFIG tokens**

| Token | Variant | Color | Scale | Opacity |
|-------|---------|-------|-------|---------|
| `panelHighlight` | selected | amber | 1.2 | 0.6 |
| `panelHighlight` | hover | pale yellow | 1.1 | 0.4 |
| `interactionHighlight` | active | blue | 1.15 | 0.3 |
| `interactionHighlight` | hover | blue | 1.08 | 0.2 |

**Lifecycle:** `_disposeHighlightLayers()` is called on `loadStructure` and `resetToEmpty` to tear down both layers cleanly.

**Display-Source-Aware Bonded Groups**

The bonded-group panel is display-source-aware: it projects from live physics topology by default and from historical bond topology in review mode. The `selectCanInspectBondedGroups` capability selector gates panel visibility — always returns true in both live and review. Only `canMutateSimulation` is mode-gated (disabled in review).

**Atom Color Overrides (Annotation Model)**

Authored atom color overrides (`bondedGroupColorOverrides`) are global annotations that persist across live/review mode transitions. They are applied via `renderer.setAtomColorOverrides()` independently of highlight overlays. Colors survive theme changes, structure appends, scrub, and restart.

**Color Editing UX**

Each cluster row in the bonded-group panel has a 16 px circular color chip to the left of the label. The chip is a plain solid circle with no border ring. It reflects the current color state of the cluster:

| Chip state | Appearance |
|------------|------------|
| Default (no overrides) | Base atom color (`--atom-base-color`) |
| Single override | The authored color (solid fill) |
| Multi-color | Conic gradient of unique override colors + a default-color segment if some atoms in the cluster are uncolored |

Clicking the color chip opens a portalled honeycomb popover (escapes panel overflow). The default (original) swatch sits at the center; 6 preset swatches are arranged in a computed ring around it. Geometry is derived from `computeHexGeometry()` — ring radius and container size are calculated from the palette size and swatch diameter so adjacent swatches never overlap even at active scale. The active swatch scales up (1.3x) in its own color with no contrasting ring.

**Preset palette:** `#ff5555, #ffbb33, #33dd66, #55aaff, #aa77ff, #ff66aa` — tuned for luminance separation under 3D atom lighting.

**Popover positioning:** left of chip for right-side panels, right of chip for left-side panels.

**Popover dismissal:** chip toggle (re-click), backdrop click, or Escape key.

**Group color intents:** Applied colors persist across topology changes. When atoms join a colored group, they inherit the group's color. When colored groups merge, each group's atoms keep their original color (the chip transitions to the multi-color conic gradient).

**Interaction independence:** Clicking the color chip does NOT trigger any row-level behavior. Hover preview clears when the popover opens.

**Accessibility:** The popover has `role="menu"`, each swatch has `role="menuitem"`, and the backdrop has `role="presentation"`. The multi-color chip announces "Multiple colors in cluster N".

### Speed & Pause

**Pause** is a primary dock button. Physics freezes; camera, UI, and input remain active. Resume resets the accumulator to prevent catch-up burst.

**Speed** is in the Settings sheet (Simulation section): `0.5x | 1x | 2x | 4x | Max`. Canonical 1x = 240 steps/sec, independent of display refresh rate (fixes the old monitor-dependent behavior). Speed buttons above the current `maxSpeed` are disabled. **Max** is always enabled — it tracks the live maximum sustainable speed.

**Selected vs effective speed**: the user selects a target speed. The scheduler delivers the actual speed the hardware can sustain. Status shows both: `Sim 2.0x · 0.24 ps/s`. When hardware-limited: `Hardware-limited · Sim 1.6x · 0.19 ps/s`.

**Warm-up**: after scene changes or clear, the profiler needs ~30 steps to estimate costs. During warm-up, speed is capped at 1x, fixed buttons are disabled, and status shows `Estimating...`.

**MD rate**: displayed alongside relative speed. `mdRate = effectiveSpeed × 240 × 0.5fs / 1000 = ps/s`. Gives users a physically meaningful throughput metric.

**Overload**: if the scene is too heavy, the scheduler enters an overloaded mode that caps the accumulator and reports the true sustainable speed. Recovery blends back to the normal estimator over ~1s.

### Timeline

The TimelineBar component lives inside DockLayout as a normal-flow element above DockBar. It provides scrubbing, review playback, and restart capabilities for the simulation history.

**Timeline UI**

The bar uses a fixed-lane layout:

| Lane | Width | Content |
|------|-------|---------|
| Mode badge | 48 px | Shows **Live** or **Review** |
| Time readout | 76 px | Displays fs / ps / ns with auto-scaling resolution |
| Scrub track | flex | Draggable scrubber with pointer capture for smooth dragging |
| Actions | 140 px | **Live** button (returns to live simulation) |
| Restart target | — | **Restart** button with target time readout |

**Review Mode**

Scrubbing away from the live edge auto-pauses the simulation and enters review mode. Review is display-only: `renderer.updateReviewFrame()` never mutates physics. Live-edit actions (drag, add/remove atoms) are blocked at the input boundary during review. The bonded-groups panel remains visible with historical topology, supporting hover preview, Center/Follow, and color editing. The frozen scrubber range is decoupled from live retention.

**Review Mode UI Lock**

When review mode is active, the following actions are visually disabled and blocked at the runtime callback boundary:

- Dock: Add, Atom/Move/Rotate mode selector, Pause/Resume
- Settings: Add Molecule, Clear
- Chooser: Structure row selection (if chooser is open)

Desktop users see `ActionHint` tooltips explaining the lock on hover/focus. Mobile users see a transient status hint on tap. Both use centralized copy from `REVIEW_LOCK_TOOLTIP` (short) and `REVIEW_LOCK_STATUS` (fuller, explains exits).

Allowed actions in review: **Live** (return to current simulation), **Restart** (continue from scrub point), **Stop & Clear** (leave review and erase history). These remain fully interactive and visually prominent.

**Restart**

Restart uses dense restart frames recorded at 10 Hz containing pos + vel + bonds + config + boundary. Dense restart frames are preferred over sparse checkpoints because they are closer to the viewed time. The worker receives full dynamic state via a dedicated `restoreState` command. History is truncated after the restart point to maintain a monotonic timeline. Interaction state is NOT restored (prevents ghost spring forces).

**Recording Policy**

Recording is disarmed until the first direct atom interaction (drag, move, rotate, flick). Molecule placement, pause/resume, speed changes, and physics settings do not arm recording — users can set up complex scenes before history begins. Clearing the playground disarms recording.

### StatusBar

StatusBar is now message-only (no persistent scene summary). It shows `statusError` or `statusText` and returns `null` otherwise.

### Placement Solver

The placement solver (`lab/js/runtime/placement-solver.ts`) computes a rigid transform (rotation + translation) for molecule preview placement in the user's current camera frame. `PlacementController` calls `solvePlacement()` and consumes the result; the solver does not own preview lifecycle, drag-plane, or commit flow.

**Orientation Pipeline**

The solver uses a multi-stage orientation pipeline:

| Stage | Function | Role |
|-------|----------|------|
| PCA shape analysis | `computeLocalFrame()` → `buildMoleculeFrame()` | Builds molecule intrinsic frame (Msys) with axes m1/m2/m3. m1 from 3D PCA primary direction; m2 from transverse cross-section PCA (permutation-stable, geometry-only). Computes `lineConfidence` and `transverseAsymmetry` confidence metrics |
| Scored regime classification | `classifyFrameMode()` | Scores both line and plane regimes by how far above threshold each eigenvalue ratio is. Picks the stronger regime; planarity wins ties (thin sheets benefit more from face-on placement). Result: `line_dominant` / `plane_dominant` / `volumetric` |
| Camera-first vertical-preferred policy | `chooseCameraFamily()` | Base policy preference: prefer vertical (camera.up) unless the molecule would be unreadably foreshortened vertically, then use horizontal (camera.right). Falls back through m2 perpendicular, then default vertical. This is the base preference, not the final decision |
| Geometry-aware family selection | `selectOrientationByGeometry()` | Final runtime arbiter. Builds both candidate orientations (up and right) via `buildFamilyTarget()` + `buildFamilyRotation()`, scores each by projected readability (extent along target axis via perspective projection), vertical wins unless right scores > 20% higher (`GEOMETRY_FAMILY_SWITCH_MARGIN`) |
| 2D PCA refinement | `refineOrientationFromGeometry()` | Perspective-projects atoms through the camera (matching renderer FOV=50), computes visible principal axis via `projected2DPCA()`, applies corrective twist around camera.forward. Adaptive: high-anisotropy shapes allow 2x correction. Up to 2 passes for convergence |
| Unified twist | `resolveUnifiedTwist()` | Blends twist target between camera-defined and shape-defined, weighted by `transverseAsymmetry` via smoothstep(0.2, 0.7) confidence curve. At asymmetry=0 (symmetric tube): camera perpendicular. At asymmetry=1 (strongly asymmetric): projected m2 |

**View-Policy Targets by Frame Mode**

| Frame mode | Orientation strategy |
|------------|---------------------|
| `line_dominant` | Align m1 to the most readable camera axis (up preferred); m2 fills remaining in-plane direction; m3 goes into depth |
| `plane_dominant` | Rotate m3 (least-variance axis) into depth so the sheet faces the camera; in-plane twist maximizes m1 readability |
| `volumetric` | Preserve library orientation (identity rotation) |

**Translation Optimization**

After orientation is fixed, the solver optimizes translation to place the preview molecule near the target without creating initial bonds.

1. **Conservative gap**: `gap >= bond cutoff + SAFETY_MARGIN + READY_MARGIN`, also floored to 30% of the smaller molecule radius. `tangentDist = targetRadius + previewRadius + gap`.
2. **Staged ring search**: 8 camera-relative directions (cardinal + diagonal) are probed at 4 progressively wider radii: `[tangentDist, +1x safeStartDist, +2x safeStartDist, +4x safeStartDist]`.
3. **First-feasible-band policy**: the search stops at the first radius that yields a valid candidate (no initial bond via `checkNoInitialBond()`). Soft scoring within a band favors proximity to the desired "ready to collide" distance, screen-centered placement, and a slight camera-right preference.
4. **Last-resort fallback**: if all bands fail, places the preview along `camera.right` at the maximum radius (`tangentDist + 4x safeStartDist`) and sets `feasible = false`.
5. **Warning status**: `PlacementController` reads `feasible` from the solver result. When `feasible = false`, it shows a status message indicating the preview was placed farther out because no closer safe location was found.

**Shared Helpers**

The solver exports helpers used by both the runtime and test QA:

| Export | Purpose |
|--------|---------|
| `projectToScreen()` | Perspective projection matching the renderer camera (FOV=50). Position + basis + FOV + depth divide |
| `projected2DPCA()` | 2D PCA on screen-space points. Returns dominant eigenvector angle and eigenvalue ratio |
| `chooseCameraFamily()` | Base vertical-preferred policy decision. Returns family, target direction, and reason |

**Preview/Commit Parity**

`solvePlacement()` returns `transformedAtoms` — the authoritative pre-transformed atom positions in world space. Both preview rendering and commit-to-scene consume these same positions, eliminating double-transform divergence.

**Placement Camera Framing**

When a placement preview appears, the camera smoothly adjusts to keep both the existing scene and the preview molecule visible. The framing solver (`placement-camera-framing.ts`) works entirely in camera-basis coordinates with no world-axis assumptions:

- A frozen "visible-anchor" is captured at placement start — only scene atoms currently in the frustum participate, so offscreen content does not inflate the framing distance.
- An adaptive 5×5 target-shift search prefers re-centering over zoom-out, with search radius derived from actual overflow.
- Camera framing runs continuously during both idle placement and active drag.
- After camera adjustment, the dragged preview is reprojected per-frame so the grabbed atom stays under the cursor.

**Drag Contract**

Preview drag uses `setPointerCapture()` for continuity past canvas/page boundaries:

- Pointer capture is acquired on pointerdown; if capture fails, pointerleave aborts the drag as fallback.
- On every pointermove/touchmove, the screen coordinates are stored and the preview is reprojected using the grabbed-point plane (anchored at the actual clicked atom, not the preview center).
- On every frame, `updateDragFromLatestPointer()` re-runs the reprojection against the current camera state, ensuring the grabbed atom stays under the cursor even when the camera has moved since the last pointer event.
- `previewOffset` is always a group displacement added to world-positioned atoms — the drag math converts absolute solved positions back to displacements via `basePreviewCenter`.

**Focus Policy (Policy A)**

Placement commit does not change `lastFocusedMoleculeId` or retarget the camera. Camera retargeting only happens via explicit user actions (Center / Return to Object). First-molecule `fitCamera()` remains via `scene.ts` for the initial add-to-empty-scene path.

### Interaction Model

**Orbit Mode (default)** — rotate around focus target, atoms are directly manipulable.

| Gesture (Desktop) | Action |
|--------------------|--------|
| Left-drag on atom | Interact (depends on mode: Atom/Move/Rotate) |
| Ctrl+click on atom | Rotate molecule (shortcut, any mode) |
| Right-drag | Orbit camera |
| Scroll wheel | Zoom |

| Gesture (Mobile) | Action |
|-------------------|--------|
| 1-finger drag on atom | Interact (depends on mode: Atom/Move/Rotate) |
| Drag triad | Orbit camera (primary mobile orbit control) |
| 1-finger drag on background | Orbit camera (when no atom is hit) |
| Tap axis end on triad | Snap to canonical view (±X/±Y/±Z) |
| Double-tap triad center | Reset to default front view |
| 2-finger pinch | Zoom |
| 2-finger drag | Pan camera |

**Object View controls** (positioned below status block): Center (frame focused molecule) and Follow (continuous tracking) buttons with inline SVG icons. Help is available via Settings > Controls.

**Onboarding:** A welcome overlay appears on each page load when the scene is ready. Dismisses on any tap with a sink animation toward the Settings button, teaching that guidance lives in Settings.

**Free-Look Mode** *(advanced, gated off by default — `CONFIG.camera.freeLookEnabled = false`)*

When enabled, a mode toggle button appears in the Object View panel. Free-Look provides yaw+pitch camera rotation; atoms are focus-select only.

| Gesture / Control (Desktop) | Action |
|-----------------------------|--------|
| Right-drag | Look around (yaw+pitch) |
| Left-click on atom | Focus-select molecule (sets orbit target, no manipulation) |
| Scroll wheel | Move forward/back along look direction |
| WASD | Translate camera (local plane) |
| R | Level camera (reset orientation) |
| Esc | Return to Orbit mode |
| Return button (↩) | Fly back to focused molecule, enter Orbit |
| Freeze button (✕) | Stop flight velocity (visible when moving) |

| Gesture / Control (Mobile) | Action |
|-----------------------------|--------|
| 1-finger drag on background | Look around (yaw+pitch) |
| Tap molecule | Focus-select molecule (sets orbit target) |
| Drag triad | Look around (same as background) |
| Double-tap triad center | Return to Orbit + reset view |

### Physics Engine

The page runs a full analytical Tersoff (1988) potential in JavaScript:
- Same parameters and algorithm as the Python reference (`sim/potentials/tersoff.py`)
- On-the-fly distance computation — no N×N distance/unit-vector cache (benchmarked 45% faster than cached at 2040 atoms, eliminates 127 MB memory)
- Cell-list spatial acceleration for neighbor and bond detection (O(N) instead of O(N²) all-pairs)
- Neighbor list rebuilt every 10 steps
- Velocity Verlet integration with proper eV/Å → Å/fs² unit conversion
- **NVE by default** — no artificial damping; energy injected by user persists as thermal vibration. User-adjustable damping available (0 = NVE, up to 0.5 = heavy viscous drag, cubic slider scale)
- Drag (Atom mode): spring force `F = K_DRAG × (target - atom)` on the selected atom, in camera-perpendicular plane. The drag target is reprojected every frame from the latest pointer screen position and the atom's current world position (`drag-target-refresh.ts`), so the force line and spring response stay consistent even when the pointer is held still while the atom moves.
- Translation (Move mode): uniform force applied to all atoms in the picked atom's **connected component** (patch), normalized by component size. Total force is `K_DRAG × displacement`, independent of patch size. Detached fragments are not affected. Components are recomputed from the bond graph via Union-Find after each bond refresh (~every 5 frames)
- Rotation (Rotate mode): spring force → torque → angular acceleration via diagonal inertia tensor → distributed tangential forces, scoped to the picked atom's **connected component**. COM and inertia are computed over the component only. Inertia-normalized so `K_ROTATE` feels consistent across patch sizes
- Safety guards: per-atom velocity hard cap and total KE cap (only trigger on extreme inputs)
- Containment boundary: soft harmonic wall at dynamically computed radius (`CONFIG.wall`). In Contain mode, applies `F = -K × (r - R_wall) / r` for atoms outside R_wall. In Remove mode, wall force is off; atoms beyond R_wall + removeMargin are deleted. Wall radius = `cbrt(3N / (4π × density)) + padding`, monotonically increasing in Contain mode, allows hysteresis-gated shrinkage in Remove mode. Wall center recenters from surviving atoms after large removals (>25% threshold).

### Architecture

The interactive page uses a composition root pattern with React-authoritative UI components. `main.ts` is the composition root: it creates all subsystems, mounts the React UI, registers callbacks into the Zustand store, and wires modules together — but delegates runtime sequencing to dedicated modules. See `docs/architecture.md` for the full module map, state ownership model, and lifecycle details.

**Orchestration ownership:**

| Concern | Owner | Notes |
|---------|-------|-------|
| Composition & wiring | `main.ts` | Creates subsystems, mounts React, registers store callbacks. Owns RAF lifecycle (start/stop) but delegates the frame body |
| Per-frame sequencing | `app/frame-runtime.ts` | Owns the sequenced update pipeline executed each frame (physics step, render, timeline, status, etc.) |
| Teardown sequencing | `app/app-lifecycle.ts` | Owns ordered teardown of all subsystems, scheduler reset, session reset, and effects gate |

**Key rules:**
- Modules import from `config.ts` for shared constants. Data flows through `main.ts` orchestration and the Zustand store.
- **Interaction mode coordination:** React DockBar (mode segmented via shared Segmented component) → store callback → main.ts (applies interactionMode) → input.ts (reads mode). The state machine maps mode → state (e.g., `'atom'` → `DRAG`).
- **Known v1 limitation:** In Move mode, the force line still originates from the picked atom rather than the center of mass, so the visual cue partly reads as "drag this atom." The cool-blue interaction highlight and immediate whole-molecule motion mitigate this, but a COM-origin force line or bounding indicator would be a stronger signal.

### Technology

- Vite (v8) build pipeline: TypeScript + React (JSX) compiled and bundled. Dev server via `npm run dev`
- React 19 (`createRoot`) — primary UI surfaces: DockLayout, DockBar, TimelineBar, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay, CameraControls, OnboardingOverlay, BondedGroupsPanel. Supporting: Segmented, Icons, TimelineActionHint
- Zustand (`app-store.ts`) — reactive UI state store; imperative callbacks from `main.ts` registered via store slots
- Web Worker (`simulation-worker.ts`) + bridge (`worker-bridge.ts`) — physics runs off the main thread
- Three.js v0.170 (npm, bundled by Vite)
- InstancedMesh for atoms and bonds (2 draw calls, geometric capacity growth)
- OrbitControls for Orbit-mode camera (zoom, pan; rotation handled by custom quaternion orbit)
- Interactive axis triad (ArrowHelper + sprites, scissor-test viewport, device-aware sizing 96–200px via `setOverlayLayout()`; drag=orbit/look, tap=snap, double-tap=reset on touch devices)
- Object View controls: React CameraControls (Center + Follow action buttons) + OnboardingOverlay (page-load welcome card with sink animation)
- MeshStandardMaterial with roughness 0.7, metalness 0 (PBR)
- Camera-mounted 3-light rig (SpotLight headlight + DirectionalLight fill + AmbientLight)

---

## Trajectory Viewer (`viewer/`)

The trajectory viewer plays back pre-computed XYZ trajectory files. It does not run physics.

### Usage

```bash
# Open directly, then drag-drop an .xyz file
open viewer/index.html

# Or serve via Vite and auto-load example trajectories
npm run dev
# Open http://localhost:5173/viewer/
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
| **C/Wasm Tersoff** | Done | ~11% faster than JS JIT. Enabled by default (`config.ts` `useWasm: true`). CSR neighbor marshaling. Automatic JS fallback on load failure. |
| **Web Workers** | Done | Physics runs on a dedicated Web Worker (`simulation-worker.ts`). Main thread handles rendering + React UI. `WorkerBridge` provides mutation-acked protocol with scene versioning. |

Benchmark scripts are in `lab/bench/`. Run via local server to collect data.
