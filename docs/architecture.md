# Architecture

## Repository Structure

```
NanoToybox/
├── sim/                          # Core simulation engine
│   ├── atoms.py                  # Atom container (positions, velocities, forces, KE, temperature)
│   ├── minimizer.py              # Energy minimizers (steepest descent + FIRE)
│   ├── potentials/
│   │   ├── tersoff.py            # Pure Python Tersoff potential (reference)
│   │   └── tersoff_fast.py       # Numba JIT-compiled Tersoff (250-480x faster)
│   ├── integrators/
│   │   └── velocity_verlet.py    # Velocity Verlet NVE integrator
│   ├── structures/
│   │   ├── generate.py           # Geometry generators (CNT, graphene, C60, diamond)
│   │   ├── generators.py         # Legacy generators (used by some tests)
│   │   └── library.py            # Structure catalog with CATALOG dict
│   ├── io/
│   │   └── output.py             # XYZ trajectory + CSV energy writers
│   └── wasm/
│       ├── tersoff.c             # C Tersoff kernel for Wasm (Emscripten)
│       └── Makefile              # Build: emcc -O3 -fno-math-errno -ffinite-math-only → page/wasm/
├── tests/                        # Python validation + JS unit + E2E suites (see testing.md)
├── scripts/                      # CLI tools and analysis scripts
│   ├── library_cli.py            # Structure library management CLI
│   ├── plot_energy.py            # Energy curve plotting
│   ├── plot_bonds.py             # Bond histogram plotting
│   ├── plot_angles.py            # Angle distribution plotting
│   ├── bottleneck_analysis.py    # Performance profiling
│   ├── scaling_analysis.py       # N-scaling benchmarks (analytical vs ML)
│   ├── scaling_research.py       # Real-time limit research (collisions, rendering, data)
│   ├── product_scaling.py        # Website feasibility benchmarks
│   └── generate_*.py             # Dataset generation scripts
├── structures/
│   └── library/                  # 15 canonical relaxed 0K structures (XYZ + manifest.json)
├── page/                         # Interactive carbon playground (real-time simulation)
│   ├── index.html                # HTML shell + #react-root mount + #hint surface
│   ├── bench/                    # Performance benchmarks
│   │   ├── bench-physics.html    # Physics-only microbench (per-stage timing)
│   │   ├── bench-render.html     # Raw Three.js renderer microbench (3 modes)
│   │   ├── bench-distance.html   # Tersoff kernel benchmark (production on-the-fly)
│   │   ├── bench-celllist.html   # Cell-list equivalence validation
│   │   ├── bench-preWasm.html    # Pre-Wasm evaluation suite (validation + profiling + scaling)
│   │   ├── bench-kernel-profile.html  # Kernel stage profiling
│   │   ├── bench-wasm.html       # Wasm kernel benchmarks
│   │   ├── bench-spread.html     # Spread-domain sparse-grid benchmark (9-case span sweep)
│   │   └── bench-scenes.ts       # Shared scene generator
│   ├── wasm/                     # Pre-built Wasm kernel (committed binaries)
│   │   ├── tersoff.wasm          # Compiled C Tersoff kernel
│   │   └── tersoff.js            # Emscripten glue code
│   ├── js/
│   │   ├── main.ts               # Composition root — RAF lifecycle, global wiring, delegates to app/ and runtime/
│   │   ├── app/                  # App-level orchestration extracted from main.ts
│   │   │   ├── frame-runtime.ts      # Per-frame update pipeline sequencing
│   │   │   └── app-lifecycle.ts      # Teardown sequencing and reset helpers
│   │   ├── runtime/              # Runtime modules extracted from main.ts
│   │   │   ├── scene-runtime.ts      # Scene mutation wrappers + scene-to-UI projection
│   │   │   ├── worker-lifecycle.ts   # Worker bridge creation, init, stall detection, teardown
│   │   │   ├── snapshot-reconciler.ts # Worker snapshot → physics/renderer reconciliation
│   │   │   ├── overlay-layout.ts     # Hint clearance + triad sizing (RAF-coalesced, ResizeObserver)
│   │   │   ├── overlay-runtime.ts    # Overlay open/close policy (Escape, outside-click)
│   │   │   ├── interaction-dispatch.ts # Interaction command effects, worker mirroring, timeline arming
│   │   │   ├── input-bindings.ts     # InputManager construction, sync, callback wiring
│   │   │   ├── ui-bindings.ts        # Zustand store callback registration + review-mode guards (blockIfReviewLocked)
│   │   │   ├── atom-source.ts        # Renderer-to-input atom-picking adapter
│   │   │   ├── focus-runtime.ts     # Focus resolution: molecule lookup, centroid, pivot update; ensureFollowTarget for follow-mode validation
│   │   │   ├── onboarding.ts        # Coachmark scheduling + page-load onboarding overlay gate (isOnboardingEligible, subscribeOnboardingReadiness)
│   │   │   ├── bonded-group-runtime.ts     # Display-source-aware connected-component projection + stable ID reconciliation (consumes getDisplaySource(), not getPhysics())
│   │   │   ├── bonded-group-highlight-runtime.ts # Persistent atom tracking + hover preview resolution
│   │   │   ├── bonded-group-coordinator.ts # Coordinated projection + highlight lifecycle
│   │   │   ├── bonded-group-display-source.ts   # Display-source resolver: live physics or review historical topology
│   │   │   ├── bonded-group-appearance-runtime.ts # Group-to-atom color translation + renderer sync (annotation model)
│   │   │   ├── simulation-timeline.ts        # Ring buffers (review frames, restart frames, checkpoints), RestartState contract, frozen review range, truncation on restart
│   │   │   ├── simulation-timeline-coordinator.ts # Orchestrates review/restart across physics, renderer, worker, store
│   │   │   ├── timeline-context-capture.ts   # Capture/restore interaction and boundary state via public physics API
│   │   │   ├── timeline-recording-policy.ts  # Arming policy (disarmed until first atom interaction)
│   │   │   ├── timeline-recording-orchestrator.ts # Owns recording cadence, authority-aware capture from reconciled physics
│   │   │   ├── timeline-subsystem.ts         # Factory that creates the full subsystem, exposes high-level interface to main.ts
│   │   │   ├── restart-state-adapter.ts      # Serialization/application/capture of RestartState
│   │   │   ├── reconciled-steps.ts           # Deduplication helper for worker snapshot step counting
│   │   │   ├── review-mode-action-hints.ts  # Transient status hint for review-locked actions (mobile/fallback)
│   │   │   ├── orbit-follow-update.ts        # Per-frame orbit-follow camera tracking from displayed bounds
│   │   │   ├── drag-target-refresh.ts        # Per-frame drag target reprojection during active interactions
│   │   │   ├── interaction-highlight-runtime.ts # Mode-aware highlight resolver (atom vs bonded group for Move/Rotate)
│   │   │   ├── placement-solver.ts  # Placement solver: PCA shape analysis, molecule frame, chooseCameraFamily, selectOrientationByGeometry, refineOrientationFromGeometry, projectToScreen/projected2DPCA helpers, translation optimization with no-initial-bond constraint
│   │   │   └── placement-camera-framing.ts  # Pure camera-basis framing solver for placement preview: overflow measurement, adaptive target-shift search, visible-anchor filtering
│   │   ├── scene.ts              # Scene commit/clear/load (transaction-safe)
│   │   ├── placement.ts          # Placement lifecycle, pointer-capture drag, per-frame reprojection, canvas listeners
│   │   │                           #   → delegates rigid-transform to placement-solver.ts, framing to placement-camera-framing.ts
│   │   ├── interaction.ts        # Command dispatch, screen-to-physics projection
│   │   ├── status.ts             # Hint fade + contextual coachmarks (hint-only)
│   │   ├── ui/
│   │   │   └── coachmarks.ts     # Onboarding copy and IDs (placement, future hints)
│   │   ├── components/           # React-authoritative UI components
│   │   │   ├── DockLayout.tsx    # Dock positioning wrapper ([data-dock-root] measurement root)
│   │   │   ├── DockBar.tsx       # Toolbar with 4-slot CSS grid (Add, Mode, Pause, Settings); role="toolbar"
│   │   │   ├── Segmented.tsx     # Shared native-radio segmented control
│   │   │   ├── SettingsSheet.tsx # Settings sheet with all controls
│   │   │   ├── StructureChooser.tsx # Structure picker sheet
│   │   │   ├── SheetOverlay.tsx  # Sheet backdrop
│   │   │   ├── StatusBar.tsx     # Scene status display
│   │   │   ├── FPSDisplay.tsx    # FPS/simulation status
│   │   │   ├── CameraControls.tsx # Object View panel: Center + Follow buttons (default); mode toggle when Free-Look gate is on
│   │   │   ├── OnboardingOverlay.tsx # Page-load welcome card with sink-to-Settings animation
│   │   │   ├── Icons.tsx         # Shared inline SVG icon utility (supporting component)
│   │   │   ├── BondedGroupsPanel.tsx # Bonded cluster inspection panel (selection + hover highlight)
│   │   │   ├── ActionHint.tsx     # Shared hover/focus tooltip (supporting component)
│   │   │   ├── ReviewLockedControl.tsx    # Review-lock wrapper (span-based, for dock/chooser controls)
│   │   │   ├── ReviewLockedListItem.tsx   # Review-lock list item (li-native, for settings rows)
│   │   │   ├── TimelineActionHint.tsx # Re-export of ActionHint for backwards compatibility
│   │   │   └── TimelineBar.tsx       # Bottom timeline UI inside DockLayout with FeatureBoundary
│   │   ├── store/
│   │   │   ├── app-store.ts      # Zustand store for UI state
│   │   │   └── selectors/
│   │   │       ├── dock.ts       # selectDockSurface derived selector
│   │   │       ├── camera.ts    # selectCameraMode selector + CameraMode type
│   │   │       ├── bonded-groups.ts # partitionBondedGroups (large/small bucket selector)
│   │   │       ├── review-ui-lock.ts # Review UI lock selector (selectIsReviewLocked, REVIEW_LOCK_TOOLTIP/STATUS)
│   │   │       └── bonded-group-capabilities.ts # Bonded-group capability policy (inspect/target/edit/mutate per mode)
│   │   ├── hooks/
│   │   │   ├── useSheetAnimation.ts # Sheet open/close CSS transitions
│   │   │   └── useReviewLockedInteraction.ts # Shared hook for review-locked control behavior (tooltip, activation, keyboard)
│   │   ├── react-root.tsx        # React mount/unmount entry point
│   │   ├── config.ts             # Centralized page configuration
│   │   ├── physics.ts            # Tersoff force engine + interaction forces
│   │   ├── renderer.ts           # Three.js scene, InstancedMesh, PBR materials, dual highlight layers, orbit + interactive triad
│   │   ├── orbit-math.ts         # Pure orbit math: arcball deltas, rigid rotation, shared constants
│   │   ├── input.ts              # Mouse/touch input, raycasting, triad drag/tap/snap, background orbit
│   │   ├── state-machine.ts      # Interaction state transitions
│   │   ├── loader.ts             # Structure library loader + bond topology
│   │   ├── format-status.ts      # Shared FPS/status text formatter
│   │   ├── scheduler-pure.ts     # Pure-function scheduler computations
│   │   ├── simulation-worker.ts  # Web Worker for off-thread physics
│   │   ├── worker-bridge.ts      # Main↔Worker bridge protocol
│   │   ├── themes.ts             # Theme definitions + CSS token bridge
│   │   └── tersoff-wasm.ts       # Wasm kernel bridge
├── viewer/
│   └── index.html                # Three.js pre-computed trajectory viewer
├── data/                         # ML training/test datasets (NPY + metadata)
├── ml/                           # ML surrogate code (deferred — see ml-surrogate.md)
├── outputs/                      # Test output artifacts (energy CSVs, trajectories, plots)
└── docs/                         # This documentation
```

## Module Dependencies

```
sim/atoms.py                      ← no dependencies
sim/potentials/tersoff.py         ← numpy only
sim/potentials/tersoff_fast.py    ← numpy + numba
sim/integrators/velocity_verlet.py ← sim.atoms
sim/minimizer.py                  ← sim.atoms
sim/structures/generate.py        ← sim.atoms
sim/io/output.py                  ← numpy, pathlib
```

## Data Flow

### Simulation Pipeline
```
Structure Generator → Atoms → Minimizer → Relaxed Atoms → Integrator → Trajectory
       ↓                                       ↓                          ↓
   generate.py                          library_cli.py              output.py
   (geometry)                          (relax + save)           (XYZ + CSV)
```

### Collision Research Pipeline
```
Library Structures → Place + Gap → Assign Velocities → NVE Dynamics → Monitor → Trajectory
        ↓                ↓               ↓                  ↓             ↓
  structures/library/  place_for_    set_collision_     vv_step()    min_dist,
  (relaxed 0K)         collision()   velocities()                   PE, KE, COM
```

### ML Pipeline (deferred)
```
Trajectory → Force Decomposition → NPY Export → Descriptors → MLP → Predicted Forces
                  ↓                     ↓            ↓
          tersoff.py              generate_*.py  descriptors_v2.py
    (F_total, F_2body, F_resid)    (data/)        (ml/)
```

### Timeline Subsystem
```
                     timeline-subsystem.ts (factory)
                              │
              ┌───────────────┼───────────────────┐
              ▼               ▼                   ▼
  timeline-recording-   simulation-timeline-   simulation-timeline.ts
  orchestrator.ts       coordinator.ts         (ring buffers)
  (cadence + capture)   (review/restart)             │
        │                     │               ┌──────┼──────┐
        ▼                     ▼               ▼      ▼      ▼
  reconciled-steps.ts   restart-state-     review  restart  check-
  (dedup helper)        adapter.ts         frames  frames   points
        │               (serialize/apply)
        ▼                     │
  snapshot-reconciler.ts      ▼
  (reconciled physics   timeline-context-capture.ts
   = single authority)  (boundary + interaction state)
```

**Recording flow:** timeline-recording-policy arms after first atom interaction (drag/move/rotate/flick via interaction-dispatch) → timeline-recording-orchestrator captures from reconciled physics state (single authority) → simulation-timeline stores dense review frames + periodic restart frames / checkpoints.

**Review flow:** simulation-timeline-coordinator enters review mode → renderer.updateReviewFrame (display-only, no physics mutation) → all scene input gated at input-bindings boundary → TimelineBar scrub drives reviewTimePs.

**Restart flow:** simulation-timeline-coordinator reads RestartState from nearest restart frame → restart-state-adapter applies state to physics → timeline-context-capture restores boundary snapshot via physics public API (`getBoundarySnapshot()` / `restoreBoundarySnapshot()`) → worker receives dedicated `restoreState` command (separate from `init`) → simulation-timeline truncates buffer at restart point.

**Worker changes:** dedicated `restoreState` command for restart (separate from `init`); `workerTransaction` helper factored from shared init/restore logic.

**Physics changes:** instance-owned timing (`dtFs`, `dampingRefSteps`, `dampingRefDurationFs`); `getBoundarySnapshot()` / `restoreBoundarySnapshot()` public API; time-based exponential damping model; `getPhysicsTiming()` derives scheduler step rate from engine `dtFs`.

**Key rules:**
- Review mode is display-only (no physics mutation)
- All scene input gated at input-bindings boundary during review
- RestartState is the single authoritative contract for rewindable physical state (interaction is metadata only, not restored)
- Recording uses reconciled physics state as single authority
- Timeline recording disarmed until first atom interaction (placement, pause, speed, and settings do not arm)
- Scheduler timing derived live from engine `dtFs`, not cached constants

### Placement Solver

`placement-solver.ts` computes the rigid transform (rotation + translation) for molecule preview placement. PlacementController (`placement.ts`) calls `solvePlacement()` and consumes the result; the solver does not own preview lifecycle, drag-plane, or commit flow.

```
placement.ts (lifecycle)
       │
       ▼
placement-solver.ts
       │
       ├── 1. Local frame analysis
       │       computeLocalFrame()    — 3D PCA → eigenvalues + shape class
       │       buildMoleculeFrame()   — robust Msys: m1 (PCA primary), m2 (cross-section PCA), frameMode
       │       classifyFrameMode()    — scored regime: line_dominant / plane_dominant / volumetric
       │
       ├── 2. Camera frame
       │       buildCameraFrame()     — orthonormal right/up/forward from renderer camera state
       │
       ├── 3. Multi-stage orientation pipeline
       │       selectOrientationByGeometry()   — geometry-aware family selection (final arbiter)
       │         ├─ buildFamilyTarget()         — signed camera-axis target per family
       │         ├─ buildFamilyRotation()        — candidate rotation per family
       │         ├─ scoreProjectedReadability()  — perspective-projected extent along target
       │         └─ refineOrientationFromGeometry() — 2D PCA corrective twist
       │
       ├── 4. Feasibility check
       │       checkNoInitialBond()   — hard constraint: no bonds at placement
       │       minCrossDistance()     — nearest inter-molecule distance
       │
       └── 5. Translation optimization
               staged ring search (4 progressively wider radii) → first-feasible-band stop → fallback with feasible=false
```

**Orientation pipeline (step 3 in detail):**

1. **Frame-based target** — `chooseCameraFamily()` determines the base policy preference: vertical (camera.up) unless the molecule's primary axis is unreadably foreshortened vertically, then horizontal (camera.right). When the primary axis is fully foreshortened, falls back through the secondary axis (m2 perpendicular), then defaults to vertical. This is the centralized policy helper exported for both runtime and test use.

2. **Geometry-aware family selection** — `selectOrientationByGeometry()` is the final family arbiter at runtime. It builds both candidate orientations (up and right) using `buildFamilyTarget()`, scores each by projected readability (perspective-projected atom extent along the target axis via `scoreProjectedReadability()`), and applies a switch margin: vertical wins unless right scores meaningfully higher (`GEOMETRY_FAMILY_SWITCH_MARGIN`).

3. **Within-family refinement** — `refineOrientationFromGeometry()` uses 2D PCA (`projected2DPCA()`) of perspective-projected atoms to compute the visible principal axis, compares it with the declared policy target direction, and applies a bounded corrective twist around `camera.forward`. Adaptive correction: high-anisotropy shapes allow up to 2x the base correction. Runs up to 2 passes for convergence.

4. **Unified twist resolution** — within each candidate rotation, `resolveUnifiedTwist()` blends the roll target between camera-defined (perpendicular to the primary alignment axis) and shape-defined (projected m2) using smoothstep confidence based on `transverseAsymmetry`. At asymmetry=0 (symmetric tube), the twist is purely camera-defined; at asymmetry=1, it follows the molecule's intrinsic secondary axis.

**Frame mode classification** — `classifyFrameMode()` uses scored regime selection: both line (major/mid eigenvalue ratio) and plane (mid/minor ratio) scores are computed against their respective thresholds (`LINE_DOMINANT_RATIO`, `PLANE_DOMINANT_RATIO`). Planarity wins over elongation via scored comparison because thin sheets benefit more from the plane-facing solver.

**Exported utilities:**
- `projectToScreen()` — shared perspective projection matching the renderer FOV (50 degrees), used by both solver refinement and test QA gates
- `projected2DPCA()` — 2D principal component analysis of projected point clouds, returns dominant axis angle and eigenvalue ratio
- `chooseCameraFamily()` — centralized policy helper for axis-family selection (vertical-first rule)

**Policy architecture** (keep in sync when editing):
- `chooseCameraFamily()` — base policy preference (vertical-first)
- `selectOrientationByGeometry()` — final runtime arbiter (geometry-scored)
- Tests enforce: policy conformance, external oracle backstop, observable behavior

### Placement Camera Framing

`placement-camera-framing.ts` is a pure solver that computes camera target and distance adjustments to keep both scene content and the placement preview visible. It has no THREE/renderer/store dependencies — all math is expressed in camera-basis vectors.

```
placement.ts (lifecycle + drag)
       │
       ▼
frame-runtime.ts (orchestration)
       │
       ├── 1. Capture frozen visible-anchor (first frame only)
       │       filterVisiblePoints() — keeps only scene atoms currently in frustum
       │
       ├── 2. Compute framing goal
       │       computePlacementFramingGoal() — adaptive 5×5 search + refinement
       │       overflow deadband (0.02 NDC) prevents threshold jitter
       │
       ├── 3. Apply camera assist (renderer.updatePlacementFraming)
       │       smooth exponential ease, frame-rate independent
       │       distance shrink suppressed during drag
       │
       └── 4. Reproject drag preview (placement.updateDragFromLatestPointer)
               grabbed-point plane + stored screen coords → group displacement
               runs after camera assist so grabbed atom stays under cursor
```

**Drag contract:** Pointer capture (`setPointerCapture`) is acquired on preview pointerdown so drag continues past canvas/page boundaries. If capture fails, pointerleave aborts the drag as fallback. Frame-runtime runs camera framing during active drag and calls `updateDragFromLatestPointer()` per frame to reproject the preview against the updated camera. The grabbed atom remains under the cursor continuously.

**Focus policy (Policy A):** Placement commit does not change `lastFocusedMoleculeId` or retarget the camera. Placement framing handles visibility; Center/Follow handle explicit focus.

### Review Mode UI Lock

When `timelineMode === 'review'`, live-edit actions are disabled at two layers:

1. **Visual lock (React):** Components subscribe to `selectIsReviewLocked()` and render locked controls via `ReviewLockedControl` (span-based wrapper for dock/chooser) or `ReviewLockedListItem` (li-native for settings rows). Both use `useReviewLockedInteraction` hook for shared tooltip/activation behavior.
2. **Runtime guard (ui-bindings.ts):** `blockIfReviewLocked()` early-returns from 6 callbacks with `showReviewModeActionHint()`.

**Locked actions:** Add, Atom/Move/Rotate mode change, Pause/Resume, Add Molecule, Clear, Structure selection.
**Allowed actions:** Live, Restart, Stop & Clear.
**Desktop:** ActionHint tooltips with `REVIEW_LOCK_TOOLTIP` (short copy).
**Mobile:** Transient status hint with `REVIEW_LOCK_STATUS` (fuller copy explaining exits).

Hint copy lives in `page/js/store/selectors/review-ui-lock.ts`. Hint timing (`statusHintMs`) lives in `CONFIG.reviewModeUi`.

**Dock slot geometry:** The dock uses CSS grid with stable slot widths (`--dock-slot-action` for action buttons, `1fr` for the mode slot) so Pause↔Resume label changes do not rebalance the layout. Each control renders inside a named `.dock-slot` wrapper. The Segmented control uses stable `.seg-item` wrappers for every option so live and review modes produce identical flex children.

### Bonded Group Display Source + Appearance

Bonded groups are display-source-aware: `bonded-group-display-source.ts` resolves topology from live physics or review historical data. The runtime projects from whichever source is active. Review topology is deferred (returns null) until the timeline stores historical components.

**Capability policy:** `bonded-group-capabilities.ts` gates inspection, targeting, color editing, and simulation mutation per mode. Review disables all bonded-group interaction until historical topology + review highlight rendering exist.

**Atom appearance (annotation model):** `bondedGroupColorOverrides` in the store holds authored atom colors as global annotations (not timeline history). The appearance runtime translates group-level color intent to atom-level overrides via `renderer.setAtomColorOverrides()`, separate from highlight overlays. Colors survive scrub/restart/mode transitions.

## Key Design Decisions

1. **Python reference + Numba acceleration** — pure Python for correctness, Numba for speed
2. **Tersoff potential only** — empirical but well-validated for carbon; sufficient for visualization
3. **No periodic boundaries** — all structures are finite/free-standing (simplifies force calculation)
4. **XYZ format throughout** — human-readable, viewer-compatible, ASE-compatible
5. **Analytical first, ML later** — ML explored and deferred; analytical is faster for <1000 atoms
6. **Centralized page config** — all tuning constants, thresholds, and defaults in `page/js/config.ts`; no scattered magic numbers

### Composition Root Pattern

`main.ts` is the composition root: it creates all subsystems (renderer, physics, stateMachine), mounts the React UI, owns RAF start/stop, and wires global listeners. Per-frame sequencing is delegated to `app/frame-runtime.ts` and teardown sequencing to `app/app-lifecycle.ts`. Feature-level runtime responsibilities are delegated to modules in `page/js/runtime/`:

- **scene-runtime.ts** — scene mutation wrappers, scene-to-store projection, worker scene mirroring
- **worker-lifecycle.ts** — worker bridge creation, init, stall detection (5s warning / 15s fatal), teardown
- **snapshot-reconciler.ts** — worker snapshot → physics position sync, atom-remap handling, bond refresh
- **overlay-layout.ts** — hint clearance, triad sizing, object-view positioning below status block via `[data-status-root]` (RAF-coalesced, ResizeObserver)
- **overlay-runtime.ts** — overlay open/close policy (Escape, outside-click, device-mode switch)
- **interaction-dispatch.ts** — interaction command side effects, worker mirroring (flick ordering), and timeline arming (unconditional on startDrag/startMove/startRotate/flick)
- **input-bindings.ts** — InputManager construction, sync (scene-mutation resync contract)
- **ui-bindings.ts** — Zustand store callback registration (React intents → imperative commands). Review-mode guards via `blockIfReviewLocked()` block 6 callbacks: onAdd, onPause, onModeChange, onAddMolecule, onClear, onSelectStructure.
- **atom-source.ts** — shared renderer-to-input atom-picking adapter
- **focus-runtime.ts** — focus resolution: molecule lookup, centroid computation, camera pivot update; `ensureFollowTarget()` for follow-mode validation. Placement commit does NOT change focus metadata or retarget camera (Policy A).
- **onboarding.ts** — coachmark scheduling + page-load onboarding overlay gate (`isOnboardingEligible`, `subscribeOnboardingReadiness`)
- **bonded-group-runtime.ts** — display-source-aware bonded-group projection with overlap-reconciled stable IDs. Consumes `getDisplaySource()` (not physics directly). `getDisplaySourceKind()` reports live vs review source.
- **bonded-group-highlight-runtime.ts** — persistent atom tracking, hover preview, panel highlight resolution (warm palette via `setHighlightedAtoms`)
- **bonded-group-coordinator.ts** — coordinated projection + highlight lifecycle (update + teardown)
- **bonded-group-display-source.ts** — resolves bonded-group topology source: live physics components or review historical topology. Pure function, no side effects.
- **bonded-group-appearance-runtime.ts** — translates group-level color edits into atom-level overrides via renderer `setAtomColorOverrides()`. Annotation model: colors persist across live/review modes.
- **simulation-timeline.ts** — ring buffers for dense review frames, restart frames, and checkpoints; RestartState contract; frozen review range; truncation on restart
- **simulation-timeline-coordinator.ts** — orchestrates review/restart across physics, renderer, worker, store
- **timeline-context-capture.ts** — capture/restore interaction and boundary state via public physics API
- **timeline-recording-policy.ts** — arming policy (disarmed until first atom interaction; placement, pause, speed, and settings do not arm)
- **timeline-recording-orchestrator.ts** — owns recording cadence, authority-aware capture from reconciled physics state (single authority)
- **timeline-subsystem.ts** — factory that creates the full timeline subsystem, exposes high-level interface to main.ts
- **restart-state-adapter.ts** — serialization, application, and capture of RestartState
- **reconciled-steps.ts** — deduplication helper for worker snapshot step counting
- **orbit-follow-update.ts** — per-frame orbit-follow camera tracking from displayed molecule bounds
- **drag-target-refresh.ts** — per-frame reprojection of pointer intent during active drag/move/rotate interactions
- **interaction-highlight-runtime.ts** — mode-aware highlight resolver: Atom → single atom, Move/Rotate → bonded group from live physics topology (cool palette via `setInteractionHighlightedAtoms` / `clearInteractionHighlight`)
- **placement-solver.ts** — placement solver module: PCA shape analysis and molecule frame construction, camera-first orientation policy (`chooseCameraFamily`), geometry-aware family selection (`selectOrientationByGeometry`), perspective-projected geometry refinement (`refineOrientationFromGeometry`), shared projection helpers (`projectToScreen`, `projected2DPCA`), translation optimization with no-initial-bond constraint
- **placement-camera-framing.ts** — pure camera-basis framing solver for placement preview: camera-space projection, adaptive target-shift search (5×5 grid + refinement), overflow deadband, visible-anchor filtering. No THREE/renderer/store imports.
- **review-mode-action-hints.ts** — transient status hint for review-locked actions; uses `REVIEW_LOCK_STATUS` (fuller copy) via store `setStatusText` with auto-clear timer from `CONFIG.reviewModeUi.statusHintMs`

**Primary user-facing surfaces** (in the React tree): DockLayout, DockBar, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay, CameraControls, OnboardingOverlay, BondedGroupsPanel, TimelineBar. **Supporting subcomponents** (composed by primary surfaces): Segmented, Icons, TimelineActionHint. Imperative controllers remain only for PlacementController and StatusController (hint-only).

**Camera callbacks** registered by main.ts via `cameraCallbacks` in the store:
- `onCenterObject()` — one-shot camera center
- `onEnableFollow?() → boolean` — resolve target via `ensureFollowTarget` + center; returns false if no molecules
- `onReturnToObject?()` — fly back to orbit target *(Free-Look only, when `freeLookEnabled` is true)*
- `onFreeze?()` — stop flight velocity *(Free-Look only)*

`main.ts` must not be re-grown: new runtime logic goes into `page/js/runtime/`, new UI surfaces into `page/js/components/`.

### Runtime Responsibility Classes

Four-tier layering (top to bottom):

**1. Composition root** (`main.ts`):
- Creates all subsystems (renderer, physics, stateMachine)
- Owns RAF start/stop lifecycle
- Wires teardown by constructing `TeardownSurface` and delegating to `app/app-lifecycle.ts`
- All Zustand subscriptions are tracked and unsubscribed in teardown
- Does NOT own per-frame business logic — delegates to `app/frame-runtime.ts`
- Does NOT own teardown sequencing — delegates to `app/app-lifecycle.ts`

**2. App orchestration** (`page/js/app/`):

- **`frame-runtime.ts`** (`executeFrame()`):
  - Owns the per-frame update pipeline sequence (physics → reconciliation → feedback → highlight → recording → placement framing → drag reprojection → render)
  - `main.ts:frameLoop()` is a thin wrapper that constructs the `FrameRuntimeSurface` and delegates
  - Ordering matters: recording MUST happen after reconciliation; highlights MUST happen after feedback; placement framing runs before render; drag reprojection runs after camera assist
  - Depends on: physics, renderer, stateMachine, scheduler, worker runtime, timeline, drag-target-refresh, interaction-highlight-runtime, placement-camera-framing

- **`app-lifecycle.ts`** (`teardownAllSubsystems()`):
  - Owns the ordered teardown sequence (dependency-ordered; test verifies exact call sequence)
  - Sequence: frame loop → listeners → debug hooks → timeline → onboarding + subscriptions → bonded groups → overlay → controllers → input → worker → renderer → helpers → state reset
  - Subsystem-specific cleanup stays inside each subsystem's own destroy/teardown
  - Tested by `tests/unit/app-lifecycle.test.ts` — full sequence verified

**3. Feature runtimes** (`page/js/runtime/*.ts`):
- Each module owns one concern (e.g., bonded-group projection, drag refresh, timeline recording)
- Each module documents: owns / depends on / called by / teardown
- Modules do NOT attach global listeners or write to `window` — main.ts wires those
- Teardown is the creator's responsibility (main.ts or the module's coordinator)

**4. Pure helpers / store / React surfaces**:
- Pure helpers (`scheduler-pure.ts`, `orbit-math.ts`, `format-status.ts`, etc.) — stateless computation, no side effects
- Store (`store/app-store.ts`, `store/selectors/`) — Zustand state, derived selectors
- React components (`components/`) — declarative UI surfaces, emit intents via store callbacks

**Default runtime module shape** (for new modules):
```
/**
 * Module name — one-sentence purpose.
 *
 * Owns: [what state/behavior this module is authoritative for]
 * Depends on: [what it reads or calls]
 * Called by: [what invokes it — main.ts, frame loop, store callback, etc.]
 * Teardown: [how cleanup works — stateless, dispose(), coordinator, etc.]
 */
```

### State Ownership

Each state slice has one authoritative writer. Other modules emit intents via callbacks; the authoritative writer applies mutations.

| State slice | Authoritative writer | Intent sources |
|-------------|---------------------|---------------|
| `session.scene` | scene-runtime.ts (commit/clear/add) | React SettingsSheet (clear), PlacementController (commit) |
| `session.playback` | app/frame-runtime.ts (per-frame) | React DockBar (pause), React SettingsSheet (speed) |
| `session.interactionMode` | main.ts (via store callback) | React DockBar (mode segmented) |
| Camera mode (`cameraMode`) | Zustand store (`app-store.ts`) | CameraControls mode toggle (feature-gated), Esc key, Free-Look recovery callbacks |
| Camera focus (`lastFocusedMoleculeId`) | focus-runtime.ts (via store) | interaction-dispatch (orbit), input-bindings (free-look). Placement commit does NOT change focus (Policy A). |
| Orbit follow (`orbitFollowEnabled`) | Zustand store (`app-store.ts`) | CameraControls Follow button; per-frame via `app/frame-runtime.ts` → `runtime/orbit-follow-update.ts` |
| Onboarding phase (`onboardingPhase`) | Zustand store (`app-store.ts`) | OnboardingOverlay consumer; `subscribeOnboardingReadiness` producer |
| UI chrome (sheets, theme, etc.) | Zustand store (`app-store.ts`) | React components |
| `session.theme` | main.ts (via settings callback) | React SettingsSheet (theme segmented) |
| Drag target (spring anchor) | physics.ts (`dragTarget`, `dragAtom`) + drag-target-refresh.ts (screen coords) | interaction-dispatch (event-driven), drag-target-refresh (per-frame reprojection) |
| Panel highlight | renderer (`_panelHighlightMesh`, renderOrder 2) — state via `setHighlightedAtoms()` | bonded-group-highlight-runtime.ts (persistent bonded-group selection/hover) |
| Interaction highlight | renderer (`_interactionHighlightMesh`, renderOrder 3) — state via `setInteractionHighlightedAtoms()` / `clearInteractionHighlight()` | interaction-highlight-runtime.ts (transient Move/Rotate); both layers composed by `_updateGroupHighlight()` |
| placement state | placement.ts (`_state`) | React DockBar (add/cancel via dockCallbacks) |
| Placement framing anchor | app/frame-runtime.ts (frozen at placement start) | Captured from visible scene atoms; cleared on placement exit |
| Placement drag screen coords | placement.ts (`lastPointerScreen`) | Pointer/touch move events; consumed per-frame by `updateDragFromLatestPointer()` |
| scheduler / effectsGate | app/frame-runtime.ts (per-frame) | — |
| Timeline state (`mode`, `currentTimePs`, `reviewTimePs`, `rangePs`, etc.) | simulation-timeline-coordinator.ts (via store) | TimelineBar (scrub, restart), timeline-recording-orchestrator (range updates) |
| Timeline recording arm state | timeline-recording-policy.ts | interaction-dispatch (first atom interaction: drag/move/rotate/flick) |
| Review UI lock state | Derived by `selectIsReviewLocked()` from `timelineMode` | Components (visual lock), ui-bindings.ts (runtime guards) |
| Bonded-group color overrides | app-store (`bondedGroupColorOverrides`) | bonded-group-appearance-runtime (applyGroupColor, clearGroupColor) |
| Bonded-group display source | bonded-group-display-source.ts (resolved per projection) | bonded-group-runtime (consumes via getDisplaySource) |
| Timeline buffers (review frames, restart frames, checkpoints) | simulation-timeline.ts | timeline-recording-orchestrator (writes), simulation-timeline-coordinator (reads) |

### Overlay Close Policy

Unified outside-click dismiss rule (all devices): a capture-phase `pointerdown` handler on `document` closes the open sheet when the primary pointer hits the backdrop or renderer canvas. Clicks inside either sheet, the dock, or HUD chrome (`#info`, `#fps`, `#hint`) do not dismiss. The event is consumed (`stopPropagation` + `preventDefault`) to prevent canvas interaction from the same gesture. The dock sits above the backdrop in z-order (z-index 205 vs 200) so dock buttons remain interactive while sheets are open.

### Overlay Layout Contract

`overlay-layout.ts` (`createOverlayLayout`) owns bottom-overlay layout arbitration via `doLayout()` (RAF-coalesced). It measures the dock region via `document.querySelector(DOCK_ROOT_SELECTOR)` (`[data-dock-root]` on DockLayout's root element) and `getBoundingClientRect()`, producing separate layout outputs:

- **Hint** (`--hint-bottom` CSS var): always clears the dock top edge + gap
- **Triad** (`renderer.setOverlayLayout({ triadSize, triadLeft, triadBottom })`): interactive camera orbit control on touch devices (drag=rotate, tap=snap-to-axis, double-tap=reset). Phone clears full-width dock; tablet/desktop uses safe-area corner margins. `triadLeft` accounts for `env(safe-area-inset-left)`. Sizes 96–140px on phone, 120–200px on tablet/desktop. `CONFIG.orbit` defines `rotateSpeed` and `triadHitPadding`.
- **Object View controls** (`--cam-ctrl-top`, `--cam-ctrl-left` CSS vars): positioned below the top status block via `[data-status-root]` (StatusBar.tsx). Named tokens: `STATUS_TO_OBJECT_VIEW_GAP` (8px), `OBJECT_VIEW_FALLBACK_TOP` (48px when status bar is hidden), `SAFE_EDGE_INSET` (12px).

Layout updates are triggered by `window.resize` and a `ResizeObserver` on the `[data-dock-root]` element (DockLayout's root), coalesced to one computation per frame. All dock child surfaces must be in normal document flow inside the measured root so `getBoundingClientRect()` reflects the total bottom-control footprint.

### App Lifecycle

- **Construction:** `init()` creates all subsystems and controllers
- **Runtime:** `frameLoop()` gated by `_appRunning` flag
- **Teardown:** `destroyApp()` stops the frame loop, removes all global listeners (including capture-phase), disconnects the dock `ResizeObserver`, cancels any pending layout RAF, destroys all controllers and subsystems, nulls refs, and resets session/scheduler/effectsGate state
- All controllers expose `destroy()` for listener cleanup
- Renderer GPU disposal is intentionally deferred (browser reclaims on page unload)

### Highlight Composition

The renderer uses two independent InstancedMesh layers for group highlights, composed additively rather than replacing each other:

```
bonded-group-highlight-runtime.ts          interaction-highlight-runtime.ts
  (persistent selection/hover)                (transient Move/Rotate)
         │                                           │
         ▼                                           ▼
  setHighlightedAtoms()                 setInteractionHighlightedAtoms()
  (state-only setter)                   clearInteractionHighlight()
         │                              (state-only setters)
         │                                           │
         └──────────────┬────────────────────────────┘
                        ▼
              _updateGroupHighlight()
              (single compositor — called each frame)
                        │
           ┌────────────┴────────────┐
           ▼                         ▼
  _panelHighlightMesh         _interactionHighlightMesh
  renderOrder 2               renderOrder 3
  CONFIG.panelHighlight       CONFIG.interactionHighlight
  warm amber palette          cool blue palette
```

**Layers:**
- **Panel highlight** (`_panelHighlightMesh`) — warm amber palette (`CONFIG.panelHighlight`, formerly `groupHighlight`), renderOrder 2. Driven by bonded-group-highlight-runtime for persistent bonded-group selection and hover preview.
- **Interaction highlight** (`_interactionHighlightMesh`) — cool blue palette (`CONFIG.interactionHighlight`), renderOrder 3. Driven by interaction-highlight-runtime for transient Move/Rotate mode feedback.

**Additive composition:** When both layers are active, the compositor computes overlap (atoms present in both index sets). Overlap atoms appear on *both* layers: the panel layer renders panelOnly + overlap, the interaction layer renders interactionOnly + overlap. This ensures neither highlight visually disappears when the other is set.

**Setter/compositor split:** `setHighlightedAtoms()`, `setInteractionHighlightedAtoms()`, and `clearInteractionHighlight()` are state-only — they store indices and intensity but do not touch meshes directly. All mesh creation, capacity management, material styling, and transform updates flow through `_updateGroupHighlight()`, the single rendering truth path.

**Lifecycle cleanup:** `_disposeHighlightLayers()` disposes both InstancedMesh layers and resets all associated state. It is called from `loadStructure()` and `resetToEmpty()` to prevent stale highlight geometry from surviving across structure transitions. The old save/restore pattern (`_restorePanelHighlight`) has been removed entirely.

**Atom color overrides (third visual layer):** `renderer.setAtomColorOverrides()` applies authored per-atom colors to the base InstancedMesh, independent of both highlight layers. The highlight overlays render on top of colored atoms. Color overrides are re-applied after `populateAppendedAtoms()` and `applyTheme()` for lifecycle resilience. The appearance runtime (`bonded-group-appearance-runtime.ts`) translates group-level color intent into atom-level overrides.

### Deferred Phases

Phase 3B-D (remaining interface narrowing), Phase 4 (folder reorganization), and Phase 5 (workspace assessment) are intentionally deferred.

## External Dependencies

| Package | Required | Purpose |
|---------|----------|---------|
| numpy | Yes | Core numerics |
| numba | Recommended | 250-480x speedup for force evaluation |
| matplotlib | Optional | Plot generation |
| scipy | Optional | .mat file loading (optional fullerene import) |
| scikit-learn | Optional | ML pilot training |
