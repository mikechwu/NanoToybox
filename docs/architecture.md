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
│       └── Makefile              # Build: emcc -O3 -fno-math-errno -ffinite-math-only → lab/wasm/
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
├── lab/                         # Interactive carbon playground (real-time simulation)
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
│   │   │   ├── onboarding.ts        # Coachmark scheduling + page-load onboarding overlay gate (isOnboardingEligible, subscribeOnboardingReadiness, markOnboardingDismissed / wasOnboardingDismissedInSession)
│   │   │   ├── auth-runtime.ts      # Session hydration + popup OAuth flow (createAuthRuntime, hydrateAuthSession, consumeResumePublishIntent, attach/detachAuthCompleteListener, AuthRequiredError, AUTH_RETURN_QUERY)
│   │   │   ├── bonded-group-runtime.ts     # Thin lab/store adapter over shared bonded-group-projection
│   │   │   ├── bonded-group-highlight-runtime.ts # Persistent atom tracking + hover preview resolution; self-healing clearTrackedIfFeatureDisabled()
│   │   │   ├── bonded-group-coordinator.ts # Coordinated projection + highlight lifecycle
│   │   │   ├── bonded-group-display-source.ts   # Display-source resolver: live physics or review historical topology
│   │   │   ├── bonded-group-appearance-runtime.ts # Stable-ID projection model: atomIds canonical for rendering+export. writeAssignments/syncToRenderer/pruneAndSync project from atomIds. Group-to-atom color translation + renderer sync (annotation model)
│   │   │   ├── simulation-timeline.ts        # Ring buffers (review frames, restart frames, checkpoints), RestartState contract, frozen review range, truncation on restart; uses shared computeConnectedComponents
│   │   │   ├── simulation-timeline-coordinator.ts # Orchestrates review/restart across physics, renderer, worker, store; enterReviewAtCurrentTime()
│   │   │   ├── timeline-context-capture.ts   # Capture/restore interaction and boundary state via public physics API
│   │   │   ├── timeline-recording-policy.ts  # Arming policy (disarmed until first atom interaction)
│   │   │   ├── timeline-recording-orchestrator.ts # Owns recording cadence, authority-aware capture from reconciled physics
│   │   │   ├── timeline-subsystem.ts         # Factory that creates the full subsystem, exposes high-level interface to main.ts; manages export capability lifecycle and atom identity/metadata rehydration
│   │   │   ├── restart-state-adapter.ts      # Serialization/application/capture of RestartState
│   │   │   ├── reconciled-steps.ts           # Deduplication helper for worker snapshot step counting
│   │   │   ├── review-mode-action-hints.ts  # Transient status hint for review-locked actions (mobile/fallback)
│   │   │   ├── orbit-follow-update.ts        # Per-frame orbit-follow camera tracking from displayed bounds
│   │   │   ├── drag-target-refresh.ts        # Per-frame drag target reprojection during active interactions
│   │   │   ├── interaction-highlight-runtime.ts # Mode-aware highlight resolver (atom vs bonded group for Move/Rotate)
│   │   │   ├── placement-solver.ts  # Placement solver: PCA shape analysis, molecule frame, chooseCameraFamily, selectOrientationByGeometry, refineOrientationFromGeometry, projectToScreen/projected2DPCA helpers, translation optimization with no-initial-bond constraint
│   │   │   ├── placement-camera-framing.ts  # Pure camera-basis framing solver for placement preview: overflow measurement, adaptive target-shift search, visible-anchor filtering
│   │   │   ├── timeline-atom-identity.ts    # Stable atom ID tracker for export (append, compaction, capture lifecycle)
│   │   │   ├── atom-metadata-registry.ts    # Persistent atom metadata keyed by stable atom ID (element, source)
│   │   │   └── history-export.ts            # V1 history file builder + capsule export: buildFullHistoryFile, buildCapsuleHistoryFile (with sparsifyInteractionTimeline), saveHistoryFile (picker + anchor fallback), formatBytes, generateExportFileName, CapsuleExportDeps; imports types from shared history module, re-exports validator
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
│   │   │   ├── AccountControl.tsx # Top-right auth disclosure (loading / signed-in / signed-out / unverified + popup-blocked sub-menu); Phase 7: signed-out menu embeds AgeGateCheckbox
│   │   │   ├── AgeGateCheckbox.tsx # Phase 7 — 13+ age-confirmation checkbox; POSTs to /api/account/age-confirmation/intent for a 5-min HMAC nonce; refreshes every 4 min + on visibility change + on consumer-bumped `refreshNonce`. Shared by AccountControl signed-out menu + Transfer dialog signed-out panel
│   │   │   ├── TopRightControls.tsx # Flex row wrapping AccountControl + FPSDisplay (replaces two absolutely-positioned surfaces)
│   │   │   ├── CameraControls.tsx # Object View panel: Center + Follow buttons (default); mode toggle when Free-Look gate is on
│   │   │   ├── OnboardingOverlay.tsx # Page-load welcome card with sink-to-Settings animation
│   │   │   ├── Icons.tsx         # Shared inline SVG icon utility (supporting component)
│   │   │   ├── BondedGroupsPanel.tsx # Bonded cluster inspection panel (hover highlight; tracked selection gated by canTrackBondedGroupHighlight)
│   │   │   ├── ActionHint.tsx     # Shared hover/focus tooltip (supporting component); anchorClassName/anchorStyle props for layout-aware wrapping
│   │   │   ├── ReviewLockedControl.tsx    # Review-lock wrapper (span-based, for dock/chooser controls)
│   │   │   ├── ReviewLockedListItem.tsx   # Review-lock list item (li-native, for settings rows)
│   │   │   ├── TimelineBar.tsx       # Composition layer: 2-column shell (mode rail + timeline lane), imports from 3 helper modules
│   │   │   ├── timeline-format.ts   # formatTime, getTimelineProgress, getRestartAnchorStyle
│   │   │   ├── timeline-mode-switch.tsx # TimelineModeSwitch: label (off/ready) or bidirectional 2-segment switch (live/review)
│   │   │   ├── timeline-clear-dialog.tsx # TimelineClearDialog, useClearConfirm hook, ClearTrigger icon button
│   │   │   ├── timeline-export-dialog.tsx # TimelineExportDialog, TimelineExportKind ('full' | 'capsule'), export trigger and confirmation UI
│   │   │   └── timeline-hints.ts     # Single source of truth for all timeline tooltip copy (TIMELINE_HINTS constant)
│   │   ├── store/
│   │   │   ├── app-store.ts      # Zustand store for UI state; BondedGroupColorAssignment has atomIds (canonical) + atomIndices (authoring snapshot); export capabilities: { full, capsule }; BondedGroupSummary re-exported from src/history/bonded-group-projection
│   │   │   └── selectors/
│   │   │       ├── dock.ts       # selectDockSurface derived selector
│   │   │       ├── camera.ts    # selectCameraMode selector + CameraMode type
│   │   │       ├── bonded-groups.ts # Re-exports partitionBondedGroups from shared module
│   │   │       ├── review-ui-lock.ts # Review UI lock selector (selectIsReviewLocked, REVIEW_LOCK_TOOLTIP/STATUS)
│   │   │       └── bonded-group-capabilities.ts # Bonded-group capability policy (inspect/target/edit/mutate/canTrackBondedGroupHighlight per mode)
│   │   ├── hooks/
│   │   │   ├── useSheetAnimation.ts # Sheet open/close CSS transitions
│   │   │   └── useReviewLockedInteraction.ts # Shared hook for review-locked control behavior (tooltip, activation, keyboard)
│   │   ├── react-root.tsx        # React mount/unmount entry point
│   │   ├── config.ts             # Centralized page configuration; bonds.cutoff/minDist read from BOND_DEFAULTS
│   │   ├── physics.ts            # Tersoff force engine + interaction forces; updateBondList() delegates to buildBondTopologyAccelerated, bonds typed as BondTuple[]
│   │   ├── renderer.ts           # Three.js scene, InstancedMesh, PBR materials, dual highlight layers, orbit + interactive triad
│   │   ├── orbit-math.ts         # Pure orbit math: arcball deltas, rigid rotation, shared constants
│   │   ├── input.ts              # Mouse/touch input, raycasting, triad drag/tap/snap, background orbit
│   │   ├── state-machine.ts      # Interaction state transitions
│   │   ├── loader.ts             # Structure library loader; delegates bond topology to shared buildBondTopologyFromAtoms
│   │   ├── format-status.ts      # Shared FPS/status text formatter
│   │   ├── scheduler-pure.ts     # Pure-function scheduler computations
│   │   ├── simulation-worker.ts  # Web Worker for off-thread physics
│   │   ├── worker-bridge.ts      # Main↔Worker bridge protocol
│   │   ├── themes.ts             # Theme definitions + CSS token bridge
│   │   └── tersoff-wasm.ts       # Wasm kernel bridge
├── src/                          # Shared modules consumed by both lab/ and watch/
│   ├── history/
│   │   ├── history-file-v1.ts        # Shared v1 file types (full + reduced + capsule), detection, validation (validateFullHistoryFile, validateReducedFile, validateCapsuleFile)
│   │   ├── connected-components.ts   # Union-find connected-component computation (extracted from simulation-timeline.ts)
│   │   ├── bonded-group-projection.ts # Pure overlap reconciliation, stable group IDs, display ordering (extracted from bonded-group-runtime.ts)
│   │   ├── bonded-group-utils.ts     # Shared bonded-group partitioning (partitionBondedGroups, SMALL_CLUSTER_THRESHOLD). Extracted from lab/js/store/selectors/bonded-groups.ts
│   │   ├── bond-policy-v1.ts         # Neutral bond-policy types: KNOWN_BOND_POLICY_IDS, BondPolicyId, isBondPolicyId guard, BondPolicyV1 interface. No deps.
│   │   └── units.ts                  # Physical unit constants (FS_PER_PS, IMPLAUSIBLE_VELOCITY_A_PER_FS) for history-file interpolation math
│   ├── input/
│   │   └── camera-gesture-constants.ts   # Shared triad tap/drag/double-tap discrimination thresholds (TRIAD_DRAG_COMMIT_PX, TAP_MAX_DURATION_MS, DOUBLE_TAP_WINDOW_MS, etc.)
│   ├── appearance/
│   │   └── bonded-group-color-assignments.ts # Shared pure domain logic for group→atom color projection (AtomColorOverrideMap, rebuildOverridesFromDenseIndices, computeGroupColorState). Both apps use stable atomIds as canonical; projection to dense indices at render time. No framework deps.
│   ├── config/
│   │   ├── viewer-defaults.ts            # Shared viewer configuration defaults (VIEWER_DEFAULTS)
│   │   ├── playback-speed-constants.ts   # Speed range (0.5x–20x), log slider mapping (sliderToSpeed/speedToSlider), gap clamp, hold threshold, formatSpeed
│   │   └── bond-defaults.ts              # Bond-policy defaults (BOND_DEFAULTS: cutoff, minDist) — single source of truth for both lab/ and watch/
│   ├── topology/                     # Bond-rule contracts, topology builders, policy resolution
│   │   ├── bond-rules.ts                 # BondRuleSet interface + createBondRules() factory (pure, no CONFIG)
│   │   ├── build-bond-topology.ts        # Three entry points: FromAtoms (loader), FromPositions (Watch reconstruction), Accelerated (physics hot path)
│   │   └── bond-policy-resolver.ts       # BOND_POLICY_RESOLVERS registry + resolveBondPolicy(); Record<BondPolicyId,...> exhaustive coverage
│   ├── types/                        # Shared TypeScript types
│   └── ui/                           # Shared UI assets consumed by both lab/ and watch/
│       ├── core-tokens.css               # Core CSS design tokens (colors, spacing, radii)
│       ├── dock-shell.css                # Dock layout shell CSS (shared chrome for both apps)
│       ├── dock-tokens.css               # Dock CSS custom properties (slot widths, heights)
│       ├── sheet-shell.css               # Bottom/side sheet layout + animation CSS
│       ├── segmented.css                 # Segmented control CSS (.seg-control, .seg-item)
│       ├── timeline-track.css            # Timeline track primitives (.timeline-time, .timeline-track, .timeline-fill, .timeline-thumb)
│       ├── bottom-region.css             # Bottom region stacking (dock + timeline clearance)
│       ├── text-size-tokens.css          # Text-size preference tokens (normal/large)
│       ├── review-parity.css             # Shared neutral-class CSS for review-like viewer surfaces (playback bar, panel chrome, status tones, row rhythm)
│       ├── bonded-groups-parity.css      # Bonded-groups panel parity CSS (extended with color popover rules)
│       ├── bonded-group-chip-style.ts    # Color chip style constants (shared between lab and watch swatch rendering)
│       ├── device-mode.ts                # Shared device-mode detection: getDeviceMode() (phone/tablet/desktop breakpoints), isCoarsePointer(), isTouchInteraction()
│       └── useSheetLifecycle.ts          # Shared React sheet lifecycle hook (mount/animate/escape/unmount state machine for bottom/side sheets)
├── watch/                        # Read-only history playback app
│   ├── index.html                # Minimal shell with single #watch-root mount node
│   ├── css/
│   │   ├── watch.css                 # Watch app-shell layout CSS
│   │   └── watch-dock.css            # Watch dock CSS (3-zone hierarchical layout)
│   └── js/
│       ├── main.ts                   # Thin bootstrap: theme init, controller creation, React mount
│       ├── watch-controller.ts       # Non-React facade: orchestrates domain services, owns RAF clock, snapshot publication, transactional file open, interpolation runtime lifecycle
│       ├── watch-document-service.ts # File lifecycle: read, detect, validate, import (kind-based dispatch: full → full importer, capsule/reduced → capsule importer). Non-destructive prepare/commit.
│       ├── watch-view-service.ts     # Camera target, follow state (frozen atom set), center/follow commands
│       ├── watch-camera-input.ts     # DOM event binding for orbit + triad interaction (desktop orbit + mobile triad, no atom picking)
│       ├── watch-overlay-layout.ts   # Triad sizing/positioning using lab-parity formulas (device-aware, dock-clearance)
│       ├── watch-bonded-group-appearance.ts # Stable-atomId color model: authored assignments keyed by stable atomIds, per-frame projection to dense indices, renderer sync
│       ├── watch-settings.ts         # Viewer preferences: theme, text-size, smoothPlayback, interpolationMode (session-only, survives file replacement)
│       ├── watch-trajectory-interpolation.ts # Interpolation runtime: buildCapsuleInterpolationCapability, createWatchTrajectoryInterpolationForCapsule; strategy registry (Linear stable, Hermite + Catmull-Rom experimental), bracket lookup with cursor cache, preallocated output buffer, resolve() API, fallback taxonomy
│       ├── watch-playback-model.ts   # WatchTopologySource abstraction + LoadedWatchHistory discriminated union (full | capsule); getInteractionAtTime(timePs) method; separated sampling channels, bidirectional playback, speed 0.5x–20x, repeat
│       ├── watch-renderer.ts         # Thin adapter over lab Renderer (initForPlayback, updateReviewFrame, applyTheme)
│       ├── watch-bonded-groups.ts    # Memoized bonded-group tracking via shared projection (no Zustand)
│       ├── react-root.tsx            # React mount/unmount entry point
│       ├── history-file-loader.ts    # Two-step file detection + support decision; LoadDecision includes { kind: 'capsule' } and { kind: 'reduced' } (legacy alias)
│       ├── full-history-import.ts    # Normalizes v1 file data (number[] → Float64Array, {a,b,distance} → tuples); precomputes InterpolationCapability (per-bracket/per-window typed-array flags + reason arrays), import diagnostics, velocity sanity check
│       ├── capsule-history-import.ts # LoadedCapsuleHistory: unified compact importer for capsule + legacy reduced files; elementById map, appearance/interaction normalization, bondPolicy validation
│       ├── frame-search.ts           # Shared binary search helpers: bsearchAtOrBefore, bsearchIndexAtOrBefore (time-indexed frame lookup)
│       ├── topology-sources/         # Topology source implementations for WatchTopologySource
│       │   ├── stored-topology-source.ts        # Wraps restart-frame topology lookup using shared bsearchAtOrBefore
│       │   └── reconstructed-topology-source.ts # Reconstructs bonds from dense frames via buildBondTopologyFromPositions + resolveBondPolicy(); object-identity cache by dense-frame index
│       ├── settings-content.ts       # Structured help section data for WatchSettingsSheet (viewer-specific, not cloned from lab)
│       └── components/
│           ├── WatchApp.tsx              # Top-level shell: landing vs workspace switching
│           ├── WatchCanvas.tsx           # Renderer lifecycle via useEffect + ref (create/destroy only)
│           ├── WatchLanding.tsx          # File-open landing with drag/drop
│           ├── WatchTopBar.tsx           # Top-left info panel (`.watch-info-panel`): kind chip + filename + Open Link / Open File actions
│           ├── WatchDock.tsx             # 3-zone hierarchical dock: transport (tap=step, hold=directional play), speed (log slider), repeat + Smooth toggle + settings
│           ├── WatchTimeline.tsx         # Custom scrubber track using shared timeline-track.css primitives (full-width, no mode rail)
│           ├── WatchSettingsSheet.tsx    # Settings sheet: Smooth Playback (toggle + method picker from registry), Appearance (theme, text-size via Segmented), File Info, Help. Uses shared useSheetLifecycle + sheet-shell.css
│           ├── WatchBondedGroupsPanel.tsx # Two-tier bonded-groups display using shared partitionBondedGroups; color chip + popover
│           └── PlaybackSpeedControl.tsx  # Compact log-mapped speed slider + readout (uses shared playback-speed-constants)
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

### Shared Modules (`src/`)

Pure, framework-free modules consumed by both `lab/` and `watch/`. No Zustand, no DOM, no Three.js (unless otherwise noted).

#### `src/history/` — History file format and topology analysis

- **`src/history/history-file-v1.ts`** — single source of truth for the v1 atomdojo-history wire format. Owns: full-history envelope types (`AtomDojoHistoryFileV1`, `SimulationMetaV1`, frame/checkpoint types), reduced-history types (`ReducedDenseFrameV1`, `AtomDojoReducedFileV1` with optional `bondPolicy` -- legacy), capsule types (`CapsuleDenseFrameV1`, `CapsuleSimulationMetaV1`, `CapsuleAppearanceV1`, `CapsuleInteractionTimelineV1`, `AtomDojoPlaybackCapsuleFileV1` with mandatory `bondPolicy`), `detectHistoryFile()`, `validateFullHistoryFile()`, `validateReducedFile()`, `validateCapsuleFile()`. Imports `BondPolicyV1` from `bond-policy-v1.ts` for its own use only -- does NOT re-export bond-policy types. Used by `lab/js/runtime/history-export.ts`, `watch/js/history-file-loader.ts`, and `watch/js/capsule-history-import.ts`.

- **`src/history/connected-components.ts`** — pure union-find algorithm for computing connected components from bond topology. Returns `BondedComponent[]` (atom indices + size). Used by `lab/js/runtime/simulation-timeline.ts` (review topology) and `watch/js/watch-bonded-groups.ts` (imported topology).

- **`src/history/bonded-group-projection.ts`** — pure overlap reconciliation, stable ID assignment, display ordering, and summary construction. Canonical definition of `BondedGroupSummary` (re-exported by `app-store.ts` for lab consumers). Provides `createBondedGroupProjection()` factory that returns a stateful projector tracking previous-frame IDs for stability across topology changes. Used by `lab/js/runtime/bonded-group-runtime.ts` (lab/store adapter) and `watch/js/watch-bonded-groups.ts` (local adapter without Zustand).

- **`src/history/bonded-group-utils.ts`** — pure partitioning function (`partitionBondedGroups`) that splits `BondedGroupSummary[]` into large and small buckets by atom count (threshold: `SMALL_CLUSTER_THRESHOLD`). Shared between `lab/js/store/selectors/bonded-groups.ts` (re-exports for lab consumers) and `watch/js/components/WatchBondedGroupsPanel.tsx`. No framework dependencies.

- **`src/history/bond-policy-v1.ts`** — neutral bond-policy type module. Owns: `KNOWN_BOND_POLICY_IDS` (canonical runtime list of known policy identifiers, currently `['default-carbon-v1']`), `BondPolicyId` type (derived from the runtime constant), `isBondPolicyId()` runtime type guard, `BondPolicyV1` interface (policyId + cutoff + minDist metadata for compact files). Depends on nothing. Imported by `src/history/history-file-v1.ts` (file types), `src/topology/bond-policy-resolver.ts` (resolution + `buildExportBondPolicy`), and `watch/js/capsule-history-import.ts` (validation).

- **`src/history/units.ts`** — physical unit conversion constants for history-file interpolation math. `FS_PER_PS` (1000 fs/ps) for converting Å/fs velocities to Å/ps in Hermite tangent computation. `IMPLAUSIBLE_VELOCITY_A_PER_FS` (10.0 Å/fs, ~66x simulator V_HARD_MAX) for import-time velocity magnitude sanity check — frames exceeding this threshold get `velocityReason = 'velocities-implausible'` so Hermite falls back to linear. Owned here (not in watch/) because the unit convention originates from the simulator. Used by `watch/js/watch-trajectory-interpolation.ts` (Hermite strategy) and `watch/js/full-history-import.ts` (sanity check).

#### `src/input/` — Shared input discrimination constants

- **`src/input/camera-gesture-constants.ts`** — single source of truth for triad gesture discrimination thresholds: `TRIAD_DRAG_COMMIT_PX` (movement threshold before orbit drag), `TAP_INTENT_PREVIEW_MS` (delay for axis highlight), `TAP_MAX_DURATION_MS` (tap vs drag cutoff), `DOUBLE_TAP_WINDOW_MS` (double-tap detection gap). Imported by `lab/js/input.ts` and `watch/js/watch-camera-input.ts` so triad tap/drag/double-tap behavior stays numerically identical across both apps.

#### `src/appearance/` — Shared visual model logic

- **`src/appearance/bonded-group-color-assignments.ts`** — pure domain logic for bonded-group color projection. Defines `AtomColorOverrideMap` (dense slot index → color) and `GroupColorState` (per-group color state). Provides `rebuildOverridesFromDenseIndices()` (deterministic projection from assignments to atom-level overrides) and `computeGroupColorState()` (derives group-level color state from per-atom assignments). No framework dependencies. Both apps use stable `atomId`s as the canonical assignment key. Lab's `BondedGroupColorAssignment` has `atomIds` (canonical for rendering + export) and `atomIndices` (authoring snapshot only). Watch imports stable atomId assignments from capsule files. Both project to dense indices at render time before calling `rebuildOverridesFromDenseIndices()`.

#### `src/config/` — Shared configuration constants

- **`src/config/viewer-defaults.ts`** — shared viewer configuration defaults (`VIEWER_DEFAULTS`). Consumed by both lab and watch for consistent initial camera, scene, and display parameters.

- **`src/config/bond-defaults.ts`** — single source of truth for bond-topology distance defaults. Owns: `BOND_DEFAULTS` (`cutoff: 1.8` A, `minDist: 0.5` A). Imported by `lab/js/config.ts` (bonds configuration) and `src/topology/bond-policy-resolver.ts` (fallback for legacy files with no declared bond policy).

- **`src/config/playback-speed-constants.ts`** — single source of truth for playback speed configuration. Owns: speed range (`SPEED_MIN` 0.5x, `SPEED_MAX` 20x, `SPEED_DEFAULT` 1x), preset values (`SPEED_PRESETS`), gap clamp (`PLAYBACK_GAP_CLAMP_MS` 250ms, prevents jumps after tab-background return), hold threshold (`HOLD_PLAY_THRESHOLD_MS` 160ms, tap-step vs hold-play discrimination). Provides logarithmic slider mapping functions (`sliderToSpeed`, `speedToSlider`) that give ~37% of slider travel to the fine-control 0.5x-2x range, and `formatSpeed()` for display formatting. Consumed by `watch/js/watch-playback-model.ts` (engine) and `watch/js/components/PlaybackSpeedControl.tsx` + `WatchDock.tsx` (UI).

#### `src/topology/` — Bond rules, topology builders, and policy resolution

Pure modules for bond-topology computation. No lab/, watch/, CONFIG, or framework dependencies (except imports from `src/` siblings).

- **`src/topology/bond-rules.ts`** — bond-rule contract. Owns: `BondRuleSet` interface (minDist, globalMaxDist, per-pair `maxPairDistance()`, precomputed squared values for the hot-path inner loop) and `createBondRules()` factory. Pure — callers pass explicit distance values, no CONFIG import. Used by `src/topology/build-bond-topology.ts` (all three entry points) and `src/topology/bond-policy-resolver.ts` (creates rules from policy metadata).

- **`src/topology/build-bond-topology.ts`** — shared bond-topology builders with three entry points for three callers. `buildBondTopologyFromAtoms()` — naive O(n^2) pair-scan for loader path (`lab/js/loader.ts`), genuinely pair-aware via `rules.maxPairDistance()`. `buildBondTopologyFromPositions()` — lower-level naive builder accepting dense interleaved positions + atomIds + element-by-ID map, suited for Watch reconstruction (`watch/js/topology-sources/reconstructed-topology-source.ts`); throws on missing element. `buildBondTopologyAccelerated()` — spatial-hash accelerated builder for the physics hot path (`lab/js/physics.ts`), with caller-owned `BondTopologyWorkspace` for output-buffer reuse (grow-only buffers, never shrink); global-rule-only in this round (elements must be null). Depends only on `BondTuple` from `src/types/interfaces` and `BondRuleSet` from `./bond-rules`.

- **`src/topology/bond-policy-resolver.ts`** — resolves file-declared `BondPolicyV1` (or null for legacy files) to a `BondRuleSet`. Owns: `BOND_POLICY_RESOLVERS` registry keyed by `BondPolicyId` — the `Record<BondPolicyId, ...>` type annotation enforces exhaustive coverage at compile time (adding a new ID to `KNOWN_BOND_POLICY_IDS` without a resolver entry is a compile error). `resolveBondPolicy(policy)` dispatches to the registry; null policies fall back to `BOND_DEFAULTS`. Depends on: `BondPolicyV1`/`BondPolicyId` from `src/history/bond-policy-v1` (neutral types), `createBondRules` from `./bond-rules`, `BOND_DEFAULTS` from `src/config/bond-defaults`. Used by `watch/js/topology-sources/reconstructed-topology-source.ts`.

#### `src/ui/` — Shared UI assets (CSS + hooks)

Shared CSS and React hooks consumed by both `lab/` and `watch/`. CSS files are framework-free class libraries; hook files are React-only.

- **`src/ui/core-tokens.css`** — core CSS design tokens (colors, spacing, border radii). Foundation layer imported by both apps.

- **`src/ui/dock-shell.css`** — dock layout shell CSS. Shared chrome for both lab and watch dock surfaces.

- **`src/ui/dock-tokens.css`** — dock CSS custom properties (slot widths, heights, breakpoint-responsive values).

- **`src/ui/sheet-shell.css`** — bottom/side sheet layout and animation CSS. Drives the open/close transition for `SettingsSheet` (lab) and `WatchSettingsSheet` (watch).

- **`src/ui/segmented.css`** — segmented control CSS (`.seg-control`, `.seg-item`). Used by the shared `Segmented` component in both apps.

- **`src/ui/timeline-track.css`** — timeline track primitives (`.timeline-time`, `.timeline-track`, `.timeline-fill`, `.timeline-thumb`). Consumed by lab's `TimelineBar` and watch's `WatchTimeline`.

- **`src/ui/bottom-region.css`** — bottom region stacking: dock + timeline clearance and safe-area coordination.

- **`src/ui/text-size-tokens.css`** — text-size preference tokens (`normal` / `large`). Applied by both apps when the user toggles text-size in settings.

- **`src/ui/review-parity.css`** — shared neutral-class CSS layer for review-like viewer surfaces. Uses `.review-*` prefix. Owns: playback-bar chrome (`.review-playback-bar`), compact panel chrome (`.review-panel`), status/message tones (`.review-status-msg`), list row rhythm (`.review-panel-row`). Does NOT own page layout, dock layout, or lab-specific rules. All values reference CSS custom properties (`--panel-bg`, `--color-border`, `--color-accent`, etc.) for theming.

- **`src/ui/bonded-groups-parity.css`** — bonded-groups panel CSS shared between lab and watch. Extended with color popover rules (honeycomb swatch layout, chip positioning).

- **`src/ui/bonded-group-chip-style.ts`** — color chip style constants shared between lab and watch swatch rendering.

- **`src/ui/device-mode.ts`** — shared device-mode and interaction-capability detection. `getDeviceMode()` replicates lab breakpoints (phone <768px, tablet <1024px or coarse-no-hover, else desktop). `isCoarsePointer()` and `isTouchInteraction()` provide stable capability detection that does not change with viewport width. Single source of truth for both apps.

- **`src/ui/useSheetLifecycle.ts`** — shared React hook for sheet mount/animate/escape/unmount lifecycle. State machine: open → mount → force reflow → add `.open` class (CSS transition triggers) → close → remove `.open` → wait transitionend → unmount. Respects reduced motion. Handles Escape key. Consolidated from `lab/js/hooks/useSheetAnimation.ts`; consumed by both `lab/js/components/SettingsSheet.tsx` and `watch/js/components/WatchSettingsSheet.tsx`.

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
                     timeline-subsystem.ts (factory + export capability)
                              │
              ┌───────────────┼───────────────────┬──────────────────┐
              ▼               ▼                   ▼                  ▼
  timeline-recording-   simulation-timeline-   simulation-timeline  history-export.ts
  orchestrator.ts       coordinator.ts         .ts (ring buffers)   (v1 file builder)
  (cadence + capture)   (review/restart)             │                   ▲
        │                     │               ┌──────┼──────┐            │
        │                     ▼               ▼      ▼      ▼   atom-metadata-
        │               restart-state-     review  restart  check-  registry.ts
        │               adapter.ts         frames  frames   points
        │               (serialize/apply)
        ▼                     │
  reconciled-steps.ts         ▼
  (dedup helper)        timeline-context-capture.ts
        │               (boundary + interaction state)
        ▼
  snapshot-reconciler.ts
  (reconciled physics         timeline-atom-identity.ts
   = single authority)        (stable ID assignment;
                               captureAtomIds wired to orchestrator)
```

**Recording flow:** timeline-recording-policy arms after first atom interaction (drag/move/rotate/flick via interaction-dispatch) → timeline-recording-orchestrator captures from reconciled physics state (single authority); the orchestrator's `captureAtomIds` callback is wired to the identity tracker so each frame carries stable atomIds → simulation-timeline stores dense review frames + periodic restart frames / checkpoints. On recording restart, the subsystem calls `rebuildExportAtomState` to rehydrate atom identity and metadata from the current scene.

**Review flow:** simulation-timeline-coordinator enters review mode (via `enterReviewAtCurrentTime()` from the mode switch, or `enterReview(timePs)` from scrub) → renderer.updateReviewFrame (display-only, no physics mutation) → all scene input gated at input-bindings boundary → TimelineBar scrub drives reviewTimePs.

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

### TimelineBar Layout

`TimelineBar.tsx` is a composition layer that imports from three helper modules and renders one of three mode-specific sub-components (`TimelineBarOff`, `TimelineBarReady`, `TimelineBarActive`) based on `timelineRecordingMode`.

**2-column shell** (`TimelineShell`):
```
┌──────────────┬──────────────────────────────────────────┐
│  mode rail   │  time  │      track zone       │ action │
│  (fixed      │ (fixed │  (1fr, with overlay   │ (fixed │
│  --tl-rail-  │ --tl-  │   zone above track)   │ --tl-  │
│  width)      │ time-  │                       │ action-│
│              │ width) │                       │ width) │
└──────────────┴──────────────────────────────────────────┘
```
CSS variables: `--tl-rail-width` (96px desktop, 84px mobile), `--tl-time-width` (56px desktop, 48px mobile), `--tl-action-width` (32px), `--tl-shell-height` (44px desktop, 38px mobile), `--tl-mode-height` (36px desktop, 32px mobile). Track width is invariant (1fr).

**Helper modules:**
- `timeline-format.ts` — `formatTime(ps)` (unit-adaptive: fs/ps/ns/us), `getTimelineProgress()` (clamped 0-1 ratio), `getRestartAnchorStyle()` (clamped left %). Width-fit enforced by `--tl-time-width`.
- `timeline-mode-switch.tsx` — `TimelineModeSwitch` renders a simple label (`ModeLabel`) for off/ready, or a bidirectional 2-segment vertical switch (`ModeSwitch`) for live/review. In active states, both segments are clickable: live→review via `onEnterReview` (gated by `hasRange`), review→live via `onReturnToLive` (gated by `canReturnToLive`). The `onEnterReview` callback wires to `coordinator.enterReviewAtCurrentTime()`.
- `timeline-clear-dialog.tsx` — `useClearConfirm` hook (open/request/cancel/confirm/reset), `TimelineClearDialog` (alertdialog with focus trap and Escape handling), `ClearTrigger` (close-icon button).

**Mode-specific rendering:**
- **Off:** "Start Recording" overlay button on the track (ActionHint-wrapped), no action slot.
- **Ready:** Empty overlay, `ClearTrigger` (ActionHint-wrapped) in action slot.
- **Active (live/review):** Scrub-interactive track with fill+thumb, `ClearTrigger` (ActionHint-wrapped) in action slot, "Restart here" overlay anchor (ActionHint-wrapped) in review mode (positioned at restart target progress). Mode-switch segments (Simulation, Review) are each ActionHint-wrapped.

All timeline ActionHint text comes from `TIMELINE_HINTS` in `timeline-hints.ts`. Hints are desktop/keyboard only; touch devices rely on visible labels and aria-labels instead (ActionHint tooltips CSS-hidden via `@media (pointer: coarse)`).

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

Hint copy lives in `lab/js/store/selectors/review-ui-lock.ts`. Hint timing (`statusHintMs`) lives in `CONFIG.reviewModeUi`.

**Dock slot geometry:** The dock uses CSS grid with stable slot widths (`--dock-slot-action` for action buttons, `1fr` for the mode slot) so Pause↔Resume label changes do not rebalance the layout. Each control renders inside a named `.dock-slot` wrapper. The Segmented control uses stable `.seg-item` wrappers for every option so live and review modes produce identical flex children.

### Bonded Group Display Source + Appearance

Bonded groups are display-source-aware: `bonded-group-display-source.ts` resolves topology from live physics or review historical data. The runtime projects from whichever source is active. Review topology is deferred (returns null) until the timeline stores historical components.

**Capability policy:** `bonded-group-capabilities.ts` gates inspection, targeting, color editing, and simulation mutation per mode. `canTrackBondedGroupHighlight: false` is a new capability that hides persistent tracked highlight (click-to-select a bonded group) while keeping hover preview active. The capability selector, runtime guard (`bonded-group-highlight-runtime.ts`), and panel (`BondedGroupsPanel.tsx`) all enforce this gate. Review disables all bonded-group interaction until historical topology + review highlight rendering exist.

**Tracked highlight hide (panel):** When `canTrackBondedGroupHighlight` is off, panel rows have no `role="button"`, no `tabIndex`, and no click/keyDown handlers — hover (`onMouseEnter`/`onMouseLeave`) remains active for preview. The "Clear Highlight" button is gated by `canTrackHighlight && hasTrackedHighlight`. Legacy callbacks `onToggleSelect` and `onClearHighlight` are now optional in `BondedGroupCallbacks`, grouped under a "Legacy-hidden" comment block.

**Atom appearance (stable-ID annotation model):** `bondedGroupColorOverrides` in the store holds authored atom colors as global annotations (not timeline history). Assignments are keyed by stable `atomIds` (canonical for rendering and export); `atomIndices` is retained as an authoring-time snapshot for UI chip state but does not drive rendering. The appearance runtime's `projectOverridesFromAtomIds()` builds a live atomId-to-slot map from the current dense layout each time overrides are applied, so colors track atoms correctly across compaction and restart. `renderer.setAtomColorOverrides()` applies the projected overrides, separate from highlight overlays. Colors survive scrub/restart/mode transitions.

**Group color intents:** The appearance runtime maintains `groupColorIntents: Map<string, string>` — a group-level color intent that persists across topology changes. `syncGroupIntents()` propagates intents to newly joined uncolored atoms without overwriting existing per-atom overrides from merged groups (preserves multi-color after merges). Stale intents for disappeared groups are pruned on each sync. `syncGroupIntents()` is called after both projection trigger points: `onSceneMutated` and `syncBondedGroupsForDisplayFrame` (timeline coordinator callback).

**Material white trick:** `_applyAtomColorOverrides()` sets the atom material to white (`0xffffff`) when per-instance overrides are active, because `InstancedMesh.setColorAt()` MULTIPLIES with the material color. When overrides are cleared, material is restored to the theme color and instance colors are reset to white. Re-applied after `populateAppendedAtoms()` and `applyTheme()` for lifecycle resilience.

**Perceptual HSL lift:** Override colors receive a perceptual lift — saturation floor from `CONFIG.atomColorOverride.minSaturation`, lightness floor from `CONFIG.atomColorOverride.minLightness` — so they remain readable under the atom material's lighting stack.

**Color editor popover:** The color swatch popover in `BondedGroupsPanel.tsx` is rendered via `createPortal(…, document.body)` to escape the panel's `overflow-y: auto` clipping. Positioned via `chipRef.getBoundingClientRect()` relative to the chip button. `colorEditorOpenForGroupId: string | null` in the store tracks which group's editor is open; `setBondedGroups` clears it conditionally (only when the open group's ID disappears from the new groups list).

**Honeycomb swatch geometry:** `computeHexGeometry(n, swatchDiam, activeScale, gap)` derives ring radius and container size from swatch count, diameter, active scale, and gap. Constants `SWATCH_DIAMETER`, `ACTIVE_SCALE`, `RING_GAP` are the single source of truth. Container sized via inline style (not a CSS custom property).

**Popover layout:** Unified across all screen sizes — same JSX, layout computed by `computeHexGeometry()`. Default swatch in center, preset swatches in a honeycomb ring. Ring radius and container size derived from swatch count and diameter.

**GroupColorOption + buildGroupColorLayout:** `GroupColorOption` is a discriminated union (`'default' | 'preset'`) modelling the default restore action and preset hex colors. `buildGroupColorLayout()` splits options into `primary` (the default swatch) and `secondary` (preset swatches) for the two-row popover layout.

**ColorSwatch component:** Reusable swatch button that owns active class, `aria-label`, and click behavior. The popover arranges swatches via `ColorSwatch` instances — layout is the popover's concern, interaction is the swatch's concern.

**Color chip style:** Plain solid circle, no border (`border: 2px solid transparent`). Active swatch scales 1.3× (`transform: scale(1.3)`) with transparent border and no box-shadow — the swatch's own color is the sole active indicator.

**Panel fixed width:** `--panel-width: 250px` CSS custom property. Stable for compact cluster labels (#N) plus action columns. Edge cases expand gracefully via `min-width` fallback.

**Scrollbar gutter:** `scrollbar-gutter: stable` reserves scrollbar space permanently — no layout reflow when the cluster list grows beyond the viewport.

**Panel disclosure:** Panel is expanded by default (`bondedGroupsExpanded: true`). Header comprises a label group ("Bonded Clusters: N") + toggle pill button ("Collapse"/"Expand"). Label truncates with ellipsis on narrow panels (`min-width: 0; overflow: hidden; text-overflow: ellipsis`). The header `<button>` acts as a disclosure control with `aria-expanded` and `aria-controls="bonded-groups-list"`. The user's expand/collapse preference is preserved across `resetTransientState` (intentionally NOT reset — the choice survives resets).

## Key Design Decisions

1. **Python reference + Numba acceleration** — pure Python for correctness, Numba for speed
2. **Tersoff potential only** — empirical but well-validated for carbon; sufficient for visualization
3. **No periodic boundaries** — all structures are finite/free-standing (simplifies force calculation)
4. **XYZ format throughout** — human-readable, viewer-compatible, ASE-compatible
5. **Analytical first, ML later** — ML explored and deferred; analytical is faster for <1000 atoms
6. **Centralized page config** — all tuning constants, thresholds, and defaults in `lab/js/config.ts`; no scattered magic numbers

### Composition Root Pattern

`main.ts` is the composition root: it creates all subsystems (renderer, physics, stateMachine), mounts the React UI, owns RAF start/stop, and wires global listeners. Per-frame sequencing is delegated to `app/frame-runtime.ts` and teardown sequencing to `app/app-lifecycle.ts`. Feature-level runtime responsibilities are delegated to modules in `lab/js/runtime/`:

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
- **onboarding.ts** — coachmark scheduling + page-load onboarding overlay gate (`isOnboardingEligible`, `subscribeOnboardingReadiness`, `markOnboardingDismissed()` / `wasOnboardingDismissedInSession()` — sessionStorage key `atomdojo.onboardingDismissed`)
- **auth-runtime.ts** — Lab-side auth: `createAuthRuntime()`, `hydrateAuthSession()` (monotonic `hydrateSeq`, `{cache: 'no-store', credentials: 'same-origin'}`), popup OAuth via `window.open` + dual-channel handshake (postMessage + `BroadcastChannel('atomdojo-auth')`), `consumeResumePublishIntent()`, `attachAuthCompleteListener()` / `detachAuthCompleteListener()`, `AuthRequiredError`, `AUTH_RETURN_QUERY`. Vite dev-host guard short-circuits popup when `protocol === 'http:' && port !== '8788'`. Popup-blocked sets store flag, never silently falls back to same-tab. See [Auth Architecture](#auth-architecture) for full state machine + transition table.
- **bonded-group-runtime.ts** — thin lab/store adapter that delegates projection logic to the shared module (`src/history/bonded-group-projection.ts`). Consumes `getDisplaySource()` (not physics directly) and writes results to Zustand store. `getDisplaySourceKind()` reports live vs review source. Does NOT re-export `BondedGroupSummary` — the canonical definition lives in `src/history/bonded-group-projection.ts` and is re-exported by `app-store.ts` for lab consumers.
- **bonded-group-highlight-runtime.ts** — persistent atom tracking, hover preview, panel highlight resolution (warm palette via `setHighlightedAtoms`). Self-healing: `clearTrackedIfFeatureDisabled()` clears stale tracked state (`_trackedAtoms`, `selectedBondedGroupId`, `hasTrackedBondedHighlight`) when `canTrackBondedGroupHighlight` is off; called at the top of `syncToRenderer()` and `syncAfterTopologyChange()`. Runtime structure preserved (no store fields or methods deleted — hide pass only).
- **bonded-group-coordinator.ts** — coordinated projection + highlight lifecycle (update + teardown)
- **bonded-group-display-source.ts** — resolves bonded-group topology source: live physics components or review historical topology. Pure function, no side effects.
- **bonded-group-appearance-runtime.ts** — stable-ID projection model: `atomIds` is canonical for rendering and export; `atomIndices` is an authoring-time snapshot only. `projectOverridesFromAtomIds()` is the rendering path (builds live atomId-to-slot map, delegates to `rebuildOverridesFromDenseIndices`). `writeAssignments`/`syncToRenderer`/`pruneAndSync` all project from `atomIds`. Translates group-level color edits into atom-level overrides via renderer `setAtomColorOverrides()`. Deps include optional `setStatusText` for user feedback on stale identity resolution. Annotation model: colors persist across live/review modes. Maintains `groupColorIntents` map for topology-resilient intent propagation; `syncGroupIntents()` fills newly joined atoms without overwriting existing overrides.
- **simulation-timeline.ts** — ring buffers for dense review frames, restart frames, and checkpoints; RestartState contract; frozen review range; truncation on restart. Imports `computeConnectedComponents` from shared module (`src/history/connected-components.ts`) for review topology.
- **simulation-timeline-coordinator.ts** — orchestrates review/restart across physics, renderer, worker, store; `enterReviewAtCurrentTime()` enables bidirectional mode switch from live→review. `restartFromHere()` calls `syncBondedGroupsForDisplayFrame()` after physics restore so bonded-group projection and appearance overrides reflect the restarted state. All review/scrub/returnToLive/restart paths call `syncBondedGroupsForDisplayFrame()` to keep bonded-group display and atom colors in sync.
- **timeline-context-capture.ts** — capture/restore interaction and boundary state via public physics API
- **timeline-recording-policy.ts** — arming policy (disarmed until first atom interaction; placement, pause, speed, and settings do not arm)
- **timeline-recording-orchestrator.ts** — owns recording cadence, authority-aware capture from reconciled physics state (single authority)
- **timeline-subsystem.ts** — factory that creates the full timeline subsystem, exposes high-level interface to main.ts; manages export capability lifecycle (single source of truth via `currentExportCapability`, derived from deps + identity staleness flag); rebuilds atom identity and metadata on recording restart (`rebuildExportAtomState` using `getSceneMolecules` dep for scene-aware rebuild); identity staleness guard disables export during worker compaction until rebuild completes
- **timeline-atom-identity.ts** — stable atom ID tracker. Auto-assigns on first capture, handles append and compaction. Required for export-capable timeline recording.
- **atom-metadata-registry.ts** — maps stable atom IDs to element metadata. Validates array length and element presence on registration.
- **history-export.ts** — builds and saves v1 atomdojo-history files (full + capsule). Types and validation moved to shared module (`src/history/history-file-v1.ts`); this file retains `buildFullHistoryFile()` (full envelope construction), `buildCapsuleHistoryFile()` (capsule envelope with `sparsifyInteractionTimeline` for sparse interaction data, `CapsuleExportDeps` interface), `saveHistoryFile()` (File System Access API picker with anchor fallback), `formatBytes()`, `generateExportFileName()`. Re-exports shared types and `validateFullHistoryFile` for existing consumers.
- **restart-state-adapter.ts** — serialization, application, and capture of RestartState
- **reconciled-steps.ts** — deduplication helper for worker snapshot step counting
- **orbit-follow-update.ts** — per-frame orbit-follow camera tracking from displayed molecule bounds
- **drag-target-refresh.ts** — per-frame reprojection of pointer intent during active drag/move/rotate interactions
- **interaction-highlight-runtime.ts** — mode-aware highlight resolver: Atom → single atom, Move/Rotate → bonded group from live physics topology (cool palette via `setInteractionHighlightedAtoms` / `clearInteractionHighlight`)
- **placement-solver.ts** — placement solver module: PCA shape analysis and molecule frame construction, camera-first orientation policy (`chooseCameraFamily`), geometry-aware family selection (`selectOrientationByGeometry`), perspective-projected geometry refinement (`refineOrientationFromGeometry`), shared projection helpers (`projectToScreen`, `projected2DPCA`), translation optimization with no-initial-bond constraint
- **placement-camera-framing.ts** — pure camera-basis framing solver for placement preview: camera-space projection, adaptive target-shift search (5×5 grid + refinement), overflow deadband, visible-anchor filtering. No THREE/renderer/store imports.
- **review-mode-action-hints.ts** — transient status hint for review-locked actions; uses `REVIEW_LOCK_STATUS` (fuller copy) via store `setStatusText` with auto-clear timer from `CONFIG.reviewModeUi.statusHintMs`

**Primary user-facing surfaces** (in the React tree): DockLayout, DockBar, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay, AccountControl, TopRightControls, CameraControls, OnboardingOverlay, BondedGroupsPanel, TimelineBar. **Supporting subcomponents** (composed by primary surfaces): Segmented, Icons, ActionHint. **Hint infrastructure:** ActionHint wraps 5 timeline controls (Start Recording, Restart here, Simulation segment, Review segment, ClearTrigger) plus ReviewLockedControl and Segmented; desktop/keyboard only (touch hidden via CSS media query). timeline-hints.ts is the single source of truth for all timeline tooltip copy (`TIMELINE_HINTS` constant). **Timeline helper modules** (composed by TimelineBar): timeline-format.ts (time formatting + progress), timeline-mode-switch.tsx (mode rail widget), timeline-clear-dialog.tsx (clear confirmation dialog + trigger), timeline-hints.ts (tooltip copy). Imperative controllers remain only for PlacementController and StatusController (hint-only).

**Camera callbacks** registered by main.ts via `cameraCallbacks` in the store:
- `onCenterObject()` — one-shot camera center
- `onEnableFollow?() → boolean` — resolve target via `ensureFollowTarget` + center; returns false if no molecules
- `onReturnToObject?()` — fly back to orbit target *(Free-Look only, when `freeLookEnabled` is true)*
- `onFreeze?()` — stop flight velocity *(Free-Look only)*

`main.ts` must not be re-grown: new runtime logic goes into `lab/js/runtime/`, new UI surfaces into `lab/js/components/`.

### Runtime Responsibility Classes

Four-tier layering (top to bottom):

**1. Composition root** (`main.ts`):
- Creates all subsystems (renderer, physics, stateMachine)
- Owns RAF start/stop lifecycle
- Wires teardown by constructing `TeardownSurface` and delegating to `app/app-lifecycle.ts`
- All Zustand subscriptions are tracked and unsubscribed in teardown
- Does NOT own per-frame business logic — delegates to `app/frame-runtime.ts`
- Does NOT own teardown sequencing — delegates to `app/app-lifecycle.ts`

**2. App orchestration** (`lab/js/app/`):

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

**3. Feature runtimes** (`lab/js/runtime/*.ts`):
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
| Panel highlight | renderer (`_panelHighlightMesh`, renderOrder 2) — state via `setHighlightedAtoms()` | bonded-group-highlight-runtime.ts (hover preview always; persistent tracked selection gated by `canTrackBondedGroupHighlight`) |
| Interaction highlight | renderer (`_interactionHighlightMesh`, renderOrder 3) — state via `setInteractionHighlightedAtoms()` / `clearInteractionHighlight()` | interaction-highlight-runtime.ts (transient Move/Rotate); both layers composed by `_updateGroupHighlight()` |
| placement state | placement.ts (`_state`) | React DockBar (add/cancel via dockCallbacks) |
| Placement framing anchor | app/frame-runtime.ts (frozen at placement start) | Captured from visible scene atoms; cleared on placement exit |
| Placement drag screen coords | placement.ts (`lastPointerScreen`) | Pointer/touch move events; consumed per-frame by `updateDragFromLatestPointer()` |
| scheduler / effectsGate | app/frame-runtime.ts (per-frame) | — |
| Timeline state (`mode`, `currentTimePs`, `reviewTimePs`, `rangePs`, etc.) | simulation-timeline-coordinator.ts (via store) | TimelineBar (scrub, enterReview, returnToLive, restart), timeline-recording-orchestrator (range updates) |
| Timeline recording arm state | timeline-recording-policy.ts | interaction-dispatch (first atom interaction: drag/move/rotate/flick) |
| Review UI lock state | Derived by `selectIsReviewLocked()` from `timelineMode` | Components (visual lock), ui-bindings.ts (runtime guards) |
| Bonded-group color overrides | app-store (`bondedGroupColorOverrides`) | bonded-group-appearance-runtime (applyGroupColor, clearGroupColor); `groupColorIntents` map propagated by `syncGroupIntents()` |
| Color editor popover | app-store (`colorEditorOpenForGroupId`) | BondedGroupsPanel (chip click); `setBondedGroups` clears when open group disappears |
| Panel disclosure (`bondedGroupsExpanded`) | Zustand store (`app-store.ts`) | BondedGroupsPanel header toggle; survives `resetTransientState` |
| Bonded-group display source | bonded-group-display-source.ts (resolved per projection) | bonded-group-runtime (consumes via getDisplaySource) |
| Timeline buffers (review frames, restart frames, checkpoints) | simulation-timeline.ts | timeline-recording-orchestrator (writes), simulation-timeline-coordinator (reads) |
| Timeline export capabilities (`timelineExportCapabilities`) | timeline-subsystem.ts (via `currentExportCapability`) | Store reads only; subsystem owns capability in all non-off states. `publishTimelineReadyState` does NOT clear `timelineExportCapabilities` — the subsystem is the sole writer. |
| Atom identity (slot→atomId mapping) | timeline-atom-identity.ts | scene-runtime (append), physics compaction listener, recording orchestrator (capture) |
| Atom metadata (id→element mapping) | atom-metadata-registry.ts | scene-runtime (register after commit), history-export (getAtomTable for export) |
| Auth state (`auth.status` / `auth.session`) | Primary writer: `auth-runtime.ts` (via `setAuthLoading` / `setAuthSignedIn` / `setAuthSignedOut` / `setAuthUnverified`). Secondary writer: `TimelineBar.tsx` (calls `setAuthSignedOut()` on `AuthRequiredError` from publish, the 401 recovery path). Both write through the narrow setters — never assemble a raw `AuthState` object. Persists across `resetTransientState`. |
| `authPopupBlocked` (one-shot) | auth-runtime.ts (set on blocked `window.open`) | AccountControl sub-menu (Retry / Continue-in-tab / Back); cleared by `onDismissPopupBlocked` or `resetTransientState`. |
| `shareTabOpenRequested` (one-shot) | auth-runtime.ts (on post-popup resume-publish consumption) | TimelineBar read-and-clear on next render; cleared by `resetTransientState`. |

**Note:** The table above covers `lab/` state only. `watch/` has no Zustand store -- all state lives across domain service closures (document, playback, view, camera, appearance, settings) coordinated by the `WatchController` facade, with React `useState` for local UI concerns. React subscribes via `useSyncExternalStore`. See the [Watch App](#watch-app-watch) section for details.

**Type ownership:** `BondedGroupSummary` is canonically defined in `src/history/bonded-group-projection.ts`. `app-store.ts` re-exports it for lab consumers. `bonded-group-runtime.ts` imports but does NOT re-export it.

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
- **Panel highlight** (`_panelHighlightMesh`) — warm amber palette (`CONFIG.panelHighlight`, formerly `groupHighlight`), renderOrder 2. Driven by bonded-group-highlight-runtime for hover preview (always) and persistent tracked selection (gated by `canTrackBondedGroupHighlight`).
- **Interaction highlight** (`_interactionHighlightMesh`) — cool blue palette (`CONFIG.interactionHighlight`), renderOrder 3. Driven by interaction-highlight-runtime for transient Move/Rotate mode feedback.

**Additive composition:** When both layers are active, the compositor computes overlap (atoms present in both index sets). Overlap atoms appear on *both* layers: the panel layer renders panelOnly + overlap, the interaction layer renders interactionOnly + overlap. This ensures neither highlight visually disappears when the other is set.

**Setter/compositor split:** `setHighlightedAtoms()`, `setInteractionHighlightedAtoms()`, and `clearInteractionHighlight()` are state-only — they store indices and intensity but do not touch meshes directly. All mesh creation, capacity management, material styling, and transform updates flow through `_updateGroupHighlight()`, the single rendering truth path.

**Lifecycle cleanup:** `_disposeHighlightLayers()` disposes both InstancedMesh layers and resets all associated state. It is called from `loadStructure()` and `resetToEmpty()` to prevent stale highlight geometry from surviving across structure transitions. The old save/restore pattern (`_restorePanelHighlight`) has been removed entirely.

**Atom color overrides (third visual layer):** `renderer.setAtomColorOverrides()` applies authored per-atom colors to the base InstancedMesh, independent of both highlight layers. The highlight overlays render on top of colored atoms. `_applyAtomColorOverrides()` uses the material white trick (material set to `0xffffff` when overrides are active, because `setColorAt()` multiplies with material color) and applies a perceptual HSL lift (`CONFIG.atomColorOverride.minSaturation` / `minLightness` floors) so colors remain readable under the lighting stack. Re-applied after `populateAppendedAtoms()` and `applyTheme()` for lifecycle resilience. The appearance runtime (`bonded-group-appearance-runtime.ts`) translates group-level color intent into atom-level overrides.

### Watch App (`watch/`)

`watch/` is a read-only history file viewer — it imports `.atomdojo` files exported by the lab and plays them back with full bidirectional playback (0.5x-20x speed, repeat, step forward/backward), with optional smooth inter-frame interpolation (Linear stable default; Hermite and Catmull-Rom experimental). No simulation, no editing, no Zustand store. React UI with a controller facade: `main.ts` creates the controller and mounts React; the controller orchestrates domain services (document, playback, view, camera, overlay, bonded groups, appearance, settings, interpolation) and owns the RAF clock; React components subscribe via `useSyncExternalStore`. Reuses the lab renderer via a narrow adapter.

**Domain service architecture:**
```
main.ts (bootstrap: theme init, controller creation, React mount)
       │
       ▼
watch-controller.ts (facade: orchestrates domains, RAF clock, snapshot publication)
       │
       ├── watch-document-service.ts    ← file lifecycle: non-destructive prepare/commit,
       │       │                           document metadata, kind-based importer dispatch
       │       │                           (full vs capsule/reduced), transactional rollback
       │       ├── history-file-loader.ts   ← file I/O, delegates detection + validation
       │       │                               to src/history/history-file-v1.ts;
       │       │                               LoadDecision: full, capsule, reduced (legacy)
       │       ├── full-history-import.ts   ← normalizes v1 data into playback-ready model;
       │       │                               precomputes InterpolationCapability + diagnostics
       │       └── capsule-history-import.ts ← LoadedCapsuleHistory: unified compact importer,
       │                                       appearance/interaction normalization, bondPolicy
       │
       ├── watch-trajectory-interpolation.ts ← interpolation runtime: strategy registry,
       │       │                                bracket lookup with cursor cache, resolve() API,
       │       │                                preallocated output buffer, fallback taxonomy.
       │       │                                Owned by controller (created on file load,
       │       │                                disposed on unload/rollback)
       │       └── src/history/units.ts        (FS_PER_PS, IMPLAUSIBLE_VELOCITY_A_PER_FS)
       │
       ├── watch-playback-model.ts      ← WatchTopologySource abstraction +
       │       │                           LoadedWatchHistory discriminated union
       │       │                           (LoadedFullHistory | LoadedCapsuleHistory);
       │       │                           separated sampling channels, bidirectional
       │       │                           playback, speed 0.5x–20x, repeat, step
       │       │
       │       ├── frame-search.ts         ← shared bsearchAtOrBefore / bsearchIndexAtOrBefore
       │       │
       │       └── topology-sources/
       │               ├── stored-topology-source.ts        ← restart-frame topology lookup
       │               └── reconstructed-topology-source.ts ← bond reconstruction from dense
       │                       │                               frames (object-identity cache)
       │                       └── buildBondTopologyFromPositions + resolveBondPolicy()
       │
       ├── watch-renderer.ts            ← thin adapter over lab Renderer
       │       │                           (initForPlayback, updateReviewFrame, applyTheme)
       │       ▼
       │   lab/js/renderer.ts           (reused — review-frame display only;
       │                                 _getDisplayedAtomCount() for review-mode color)
       │
       ├── watch-camera-input.ts        ← DOM event binding for orbit + triad interaction
       │       │                           (desktop orbit + mobile triad, no atom picking)
       │       └── src/input/camera-gesture-constants.ts (shared thresholds)
       │
       ├── watch-overlay-layout.ts      ← triad sizing/positioning using lab-parity formulas
       │       └── src/ui/device-mode.ts (shared device detection)
       │
       ├── watch-bonded-groups.ts       ← memoized bonded-group tracking from imported topology
       │       │
       │       ├── src/history/connected-components.ts   (union-find)
       │       ├── src/history/bonded-group-projection.ts (stable IDs + overlap reconciliation)
       │       └── src/history/bonded-group-utils.ts      (partitioning for two-level display)
       │
       ├── watch-bonded-group-appearance.ts ← stable-atomId color model: assignments keyed
       │       │                               by stable atomIds, per-frame projection to
       │       │                               dense indices, renderer sync
       │       └── src/appearance/bonded-group-color-assignments.ts (shared projection logic)
       │
       ├── watch-view-service.ts        ← camera target, follow state (frozen atom set),
       │                                   center/follow commands
       │
       └── watch-settings.ts            ← viewer preferences: theme, text-size,
                                           smoothPlayback, interpolationMode
                                           (session-only, survives file replacement)
```

**React component tree:**
```
react-root.tsx (mountWatchUI → createRoot)
       │
       ▼
WatchApp (top-level shell, useSyncExternalStore → controller snapshot)
       │
       ├── WatchLanding              ← file open / drag-drop landing (shown when !loaded)
       │
       └── [workspace]               ← shown when loaded:
           ├── WatchTopBar           ← top-left corner info panel (kind chip + filename + Open Link / Open File)
           ├── WatchCanvas           ← owns renderer create/destroy lifecycle only
           │                            (controller's RAF loop pushes frames to renderer)
           ├── WatchBondedGroupsPanel ← collapsible bonded-group inspector with color chips/popover
           ├── WatchDock             ← 3-zone playback dock (consistent icon+label columns):
           │   ├── [transport]          Back, Play, Fwd, Repeat (tap=step, hold=directional play)
           │   ├── PlaybackSpeedControl log-mapped 0.5x–20x slider + "Speed · 1.0x" meta row
           │   └── [settings]           Settings button (Smooth lives here, default ON)
           ├── WatchTimeline         ← full-width scrubber (no mode rail — watch advantage over lab)
           └── WatchSettingsSheet    ← Smooth Playback (toggle + method picker),
                                       Appearance (theme, text-size), File Info, Help
                                       (shared Segmented + useSheetLifecycle)
```

**Domain modules:**
- **main.ts** — thin bootstrap: applies theme tokens, creates the `WatchController`, mounts the React UI via `mountWatchUI()`. Does NOT own DOM manipulation, playback logic, or renderer lifecycle.
- **watch-controller.ts** — non-React facade that orchestrates domain services and bridges to React UI. Owns: RAF clock (playback timing + renderer frame application + follow tracking + appearance sync in the same `tick()`), `WatchControllerSnapshot` publication via `getSnapshot()`/`subscribe()`, interpolation runtime lifecycle (`installInterpolationRuntime`/`teardownInterpolationRuntime` — recreated on file load, disposed on unload/rollback). All render entry points (RAF tick, scrub/step, initial load, rollback) route through the single `applyReviewFrameAtTime()` helper, which is the sole caller of `interpolation.resolve()` and `renderer.updateReviewFrame()`. Snapshot fields include `smoothPlayback`, `interpolationMode`, `activeInterpolationMethod` (string `InterpolationMethodId`), `lastFallbackReason`, and `importDiagnostics`. Exposes `getRegisteredInterpolationMethods()` as a stable accessor (frozen array, reference changes only on registry mutation). Delegates file lifecycle to `watch-document-service.ts`, playback to `watch-playback-model.ts`, camera input to `watch-camera-input.ts`, overlay to `watch-overlay-layout.ts`, color to `watch-bonded-group-appearance.ts`, interpolation to `watch-trajectory-interpolation.ts`, and viewer preferences to `watch-settings.ts`. Coordinates commit/rollback across services on file open; during `openFile`, imports appearance (color assignments) from capsule files via `appearance.importColorAssignments()`.
- **watch-document-service.ts** — file lifecycle service. Non-destructive `prepare()` (read, detect, validate, import -- no side effects) and `commit()` (apply to playback model). Kind-based importer dispatch: branches on `LoadDecision.kind` to route `full` to `full-history-import.ts`, and both `capsule` and `reduced` (legacy alias) to `capsule-history-import.ts`, producing `LoadedWatchHistory` (`LoadedFullHistory | LoadedCapsuleHistory`). Owns `DocumentMetadata` (fileName, fileKind, atomCount, frameCount, maxAtomCount). The controller coordinates commit/rollback around this service.
- **watch-playback-model.ts** — defines `WatchTopologySource` interface and `LoadedWatchHistory` discriminated union (`LoadedFullHistory | LoadedCapsuleHistory`). Provides `getInteractionAtTime(timePs)` for time-indexed interaction state lookup from capsule interaction timelines. At load time, branches on `kind` to select the appropriate topology source: `StoredTopologySource` for full histories (restart-frame lookup), `ReconstructedTopologySource` for capsule/compact histories (bond reconstruction). Separated sampling channels for positions, topology, config, and boundary state. Bidirectional playback with speed 0.5x-20x (logarithmic mapping via shared `playback-speed-constants.ts`), repeat, step forward/backward. Gap clamp prevents huge jumps after tab-background return. All channels return exact recorded data (stepwise from nearest frame at or before `timePs`). Position interpolation is handled by the trajectory interpolation runtime in the controller pipeline, not in the playback model itself; topology/config/boundary remain stepwise.
- **watch-camera-input.ts** — DOM event binding for orbit and triad interaction. Simpler than lab's `InputManager` because watch has no atoms to interact with -- only discriminates triad hit area vs. background. Desktop: left/right-drag orbit, scroll zoom. Mobile: 1-finger orbit via triad, 2-finger pinch zoom, tap to snap to axis, double-tap to reset. Uses shared `camera-gesture-constants.ts` for numerical thresholds.
- **watch-overlay-layout.ts** — triad sizing and positioning using the same formulas as lab's `overlay-layout.ts`. Measures dock region, applies device-mode-aware sizing (phone/tablet/desktop via shared `device-mode.ts`). Phone clears full-width dock; tablet/desktop uses safe-area corner margins.
- **watch-bonded-group-appearance.ts** — authored color assignments using stable atomIds (from history file frames), not dense slot indices. Each frame, stable atomIds are projected to current dense slot indices via `rebuildOverridesFromDenseIndices()` from the shared appearance module before passing to the renderer. Owns: authored color assignments, per-frame projection, renderer sync, import hydration via `importColorAssignments()`. Does NOT own: hover highlight, follow state, color editor UI state.
- **watch-view-service.ts** — camera target and follow state. Follow model matches lab: follow freezes the atom membership at click time and tracks those specific atoms, not the live group-id projection. This prevents follow from drifting when group IDs or memberships change. Owns: camera target ref, follow target (frozen atom set), center/follow commands.
- **watch-settings.ts** — viewer preferences: theme, text-size, `smoothPlayback` (default ON), and `interpolationMode` (default `'linear'`). Session-only (no localStorage). Survives file replacement (viewer preferences, not transport). Exports the `WatchInterpolationMode` type (derived from `PRODUCT_INTERPOLATION_MODE_IDS` frozen tuple: `'linear' | 'hermite' | 'catmull-rom'`), the `isWatchInterpolationMode()` type guard, and the `PRODUCT_INTERPOLATION_MODE_IDS` tuple as single source of truth for productized mode IDs. Does NOT own speed or repeat (transport -- owned by playback model).
- **watch-renderer.ts** — narrow adapter over the lab `Renderer`, exposing only `initForPlayback()`, `updateReviewFrame()`, `applyTheme()`, and canvas access. Shields watch code from the 2500+ line lab renderer surface. Lab's renderer provides `_getDisplayedAtomCount()` which uses `_reviewAtomCount` in review mode so that `_applyAtomColorOverrides()` iterates over the correct atom count for watch display.
- **watch-bonded-groups.ts** — local adapter that computes bonded groups from imported topology using the shared `connected-components` and `bonded-group-projection` modules. Memoized by topology `frameId` -- skips recomputation when the frame has not changed. No Zustand dependency.
- **react-root.tsx** — React mount/unmount entry point. Mounts `WatchApp` under `React.StrictMode` into `#watch-root`.
- **history-file-loader.ts** — two-step file load: `detectHistoryFile()` (envelope) then kind-specific validation, delegated to the shared schema module. `LoadDecision` supports `full`, `capsule`, and `reduced` (legacy alias). Owns only `File` I/O and the user-facing load flow.
- **full-history-import.ts** — normalizes validated v1 file data into `LoadedFullHistory`: converts `number[]` to `Float64Array` for positions/velocities, `{ a, b, distance }` to `[a, b, distance]` tuples for bonds, and precomputes `restartAlignedToDense` flag. Round 6 additions: precomputes `InterpolationCapability` — per-frame velocity endpoint reasons, per-bracket `bracketSafe` / `hermiteSafe` typed-array flags, per-4-window `window4Safe` flags, plus diagnostic reason arrays (`BracketReason`, `WindowReason`, `VelocityEndpointReason`). Records `velocityUnit` (always `'angstrom-per-fs'` for v1; `'unknown'` reserved for hypothetical v2). Performs velocity magnitude sanity check against `IMPLAUSIBLE_VELOCITY_A_PER_FS` from `src/history/units.ts`. Collects `ImportDiagnostic[]` (typed codes: `'velocities-implausible'`, `'restart-count-mismatch'`, `'restart-time-mismatch'`, `'atomids-mismatch-at-frame'`) surfaced to the settings UI.
- **capsule-history-import.ts** — unified compact importer for both `capsule` and legacy `reduced` files, normalizing both to `LoadedCapsuleHistory`. Exports: `LoadedCapsuleHistory`, `importCapsuleHistory`, `importReducedAsCapsule`, `NormalizedAppearanceState`, `NormalizedInteractionState`, `NormalizedInteractionTimeline`. Owns `elementById: ReadonlyMap<number, string>` for atom-id-to-element resolution. Capsule mode: full validation (mandatory `bondPolicy`, `frameId` monotonicity, appearance/interaction normalization, `units` validation). Reduced mode: relaxed validation (optional `bondPolicy` with `buildExportBondPolicy()` fallback, frame-local payloads preserved). Builds `frameIdToIndex` map lazily only when interaction data exists.
- **frame-search.ts** — shared binary search helpers for time-indexed frame lookup. `bsearchAtOrBefore(frames, timePs)` returns the frame at or before the target time; `bsearchIndexAtOrBefore` returns the index. Used by both `StoredTopologySource` (restart-frame lookup) and the playback model's channel sampling.
- **topology-sources/stored-topology-source.ts** — `StoredTopologySource` implements `WatchTopologySource` for full history files. Wraps restart-frame topology lookup using `bsearchAtOrBefore` from `frame-search.ts`. Returns pre-recorded bond arrays from the nearest restart frame at or before the requested time.
- **topology-sources/reconstructed-topology-source.ts** — `ReconstructedTopologySource` implements `WatchTopologySource` for capsule/compact history files that lack stored bond topology. Reconstructs bonds from dense-frame atom positions using `buildBondTopologyFromPositions` and resolves the bond-distance policy via `resolveBondPolicy()`. Maintains an object-identity cache keyed by dense-frame index so repeated queries for the same frame avoid redundant reconstruction.
- **watch-trajectory-interpolation.ts** — interpolation runtime created by the controller on file load. Exports `buildCapsuleInterpolationCapability` (derives capability from capsule dense frames) and `createWatchTrajectoryInterpolationForCapsule` (factory for capsule-backed interpolation). Strategy registry ships three built-in strategies (`BUILTIN_STRATEGIES` export): Linear (stable, universal fallback), Hermite (experimental, velocity-based cubic using `FS_PER_PS` tangent scaling), and Catmull-Rom (experimental, 4-frame window). New strategies can be registered via `registerStrategy()` with any string `InterpolationMethodId` — dev-only methods do not widen the productized `WatchInterpolationMode` union. Method metadata uses a discriminated union (`ProductMethodMetadata` / `DevMethodMetadata`) with `availability` as discriminant, so the UI can narrow to product methods without casting. The `resolve()` API handles the full resolution chain: smoothPlayback-disabled bypass, bracket lookup (binary search with cursor-cache fast path for monotonic playback), non-interpolatable bracket fallback (via capability layer flags), strategy input assembly (velocity pairs for Hermite, 4-frame windows for Catmull-Rom), strategy execution, and decline-to-linear fallback. `FallbackReason` taxonomy (`'none' | 'disabled' | 'at-boundary' | 'single-frame' | 'variable-n' | 'atomids-mismatch' | 'velocities-unavailable' | 'insufficient-frames' | 'window-mismatch' | 'capability-declined'`) surfaces in the controller snapshot. Buffer ownership: the preallocated `Float64Array` output buffer (sized to `maxAtomCount * 3` at file load) is returned by reference on interpolated paths; on boundary/fallback paths the importer's immutable dense-frame positions reference is returned directly. Lifecycle: `reset()` clears cursor cache and diagnostics; `dispose()` releases internal state.
- **settings-content.ts** — structured help section data (`WATCH_HELP_SECTIONS`) for `WatchSettingsSheet`. Viewer-specific content (not cloned from lab simulation instructions). Separates content from presentation.

**React components:**
- **WatchApp** — top-level shell. Subscribes to controller via `useSyncExternalStore(controller.subscribe, controller.getSnapshot)`. Routes between `WatchLanding` (no file loaded) and the workspace layout (file loaded). Owns local panel expand/collapse and sheet open/close state.
- **WatchCanvas** — owns Three.js renderer create/destroy lifecycle only. Creates the renderer via `controller.createRenderer()` on mount, destroys and detaches on unmount. Does NOT own the playback clock or frame updates -- the controller's RAF loop pushes frames into the renderer directly.
- **WatchDock** — 3-zone playback dock with consistent icon+label columns at every breakpoint. Transport zone (4-column grid): Back, Play, Fwd, Repeat. Back/Play/Fwd use tap=step, hold=directional play via pointer capture (`HOLD_PLAY_THRESHOLD_MS` from shared speed constants); Repeat is a preference toggle that stays enabled even when no file is loaded. Speed zone: `PlaybackSpeedControl` (log-mapped slider + "Speed · 1.0x" meta row). Settings zone: Settings button. Smooth playback lives in Settings only (default ON). Uses shared `dock-shell.css` and `dock-tokens.css` plus watch-specific `watch-dock.css`.
- **WatchTimeline** — custom scrubber using shared `timeline-track.css` primitives (`.timeline-track`, `.timeline-fill`, `.timeline-thumb`). Full-width track (no mode rail -- watch advantage over lab). Drag resilience via pointer capture with fallback. Uses `formatTime` from lab's `timeline-format.ts`.
- **WatchSettingsSheet** — settings surface with four sections: Smooth Playback (on/off toggle + interpolation method picker driven from registry metadata via `getRegisteredInterpolationMethods()`, with per-frame diagnostic note when active method diverges from selection), Appearance (theme + text-size via shared `Segmented` component), File Info (atom count, frame count, duration), Help (viewer-specific sections from `settings-content.ts`). Method picker shows product methods only (filtered via `availability === 'product'` discriminant); stable methods first, then experimental. Uses shared `useSheetLifecycle` hook for mount/animate/escape lifecycle, shared `sheet-shell.css` and `segmented.css` for styling.
- **PlaybackSpeedControl** — column-shaped speed control: log-mapped slider on top inside a fixed 18 px row (`.watch-dock__speed-slider-row`) so the thumb centerline aligns with `.dock-icon` glyphs in neighboring columns across browsers; "Speed · 1.0x" meta row below. The numeric readout (`.watch-dock__speed-value`) is a click-to-reset button, disabled at default to make the no-op visible. Uses `sliderToSpeed`, `speedToSlider`, `formatSpeed`, `SPEED_DEFAULT` from shared `playback-speed-constants.ts`.
- **WatchBondedGroupsPanel** — collapsible bonded-group inspector with two-level display (large/small clusters via `partitionBondedGroups` from `src/history/bonded-group-utils.ts`). Includes color chip + popover for per-group color assignment. Uses shared `review-parity.css` and `bonded-groups-parity.css`.
- **WatchTopBar** — top-left corner info panel (`.watch-info-panel` in `watch/css/watch.css`). Renders the file-kind chip, truncated filename, and two parallel actions: **Open Link** (paste a share URL/code) and **Open File** (local file picker). Surface tokens mirror `.bg-panel` so both canvas-corner panels read as one family.
- **WatchLanding** — drag-drop zone and open-file button for initial file selection.

**State model:** watch/ has no Zustand store. The `WatchController` holds all mutable state across its domain services as plain local variables in closures. React components subscribe via `useSyncExternalStore` -- the controller publishes immutable `WatchControllerSnapshot` objects and notifies listeners on change. Local UI state (panel expanded, small clusters expanded, sheet open) lives in React `useState`.

**Topology reconstruction:** The playback model supports two topology source strategies behind the `WatchTopologySource` interface. Full history files use `StoredTopologySource`, which performs binary search (`bsearchAtOrBefore` from `frame-search.ts`) over restart frames to find pre-recorded bond arrays. Capsule/compact history files lack stored topology and use `ReconstructedTopologySource`, which rebuilds bonds on demand from dense-frame atom positions via `buildBondTopologyFromPositions` with a bond-distance policy resolved by `resolveBondPolicy()`. Reconstructed results are cached by dense-frame index (object-identity cache) to avoid redundant computation during scrub and repeat. The playback model selects the topology source at load time by branching on the `LoadedWatchHistory` discriminated union's `kind` field (`'full'` vs `'capsule'`). The `capsule-history-import.ts` module validates `bondPolicy` at import time so reconstruction can proceed without runtime policy errors.

**Shared CSS architecture:** Both apps import from `src/ui/` for dock (`dock-shell.css`, `dock-tokens.css`), sheet (`sheet-shell.css`), segmented (`segmented.css`), timeline (`timeline-track.css`), and tokens (`core-tokens.css`, `text-size-tokens.css`). Lab keeps only app-specific overrides in `index.html`. Watch adds `watch-dock.css` for its 3-zone transport layout.

**Build:** `tsconfig.json` includes `watch/js/**/*.ts` and `watch/js/**/*.tsx` so watch app sources participate in the project-wide type check alongside lab and shared modules.

### Share-Link Backend (Phase 5)

Phase 5 adds cloud-published capsule share links: Lab publishes a capsule → Cloudflare Pages Functions persist metadata + blob → a 12-character share code (Crockford Base32, e.g. `7M4K2D8Q9T1V`, displayed grouped `7M4K-2D8Q-9T1V`) lets anyone open the capsule in Watch. The backend is a thin Pages Functions layer over D1 (metadata) and R2 (blobs), with a companion cron Worker that drives periodic sweeps.

**Repository additions:**
```
NanoToybox/
├── functions/                        # Cloudflare Pages Functions (backend)
│   ├── env.ts                        # Env type (D1, R2, secrets)
│   ├── admin-gate.ts                 # Two-path admin gate (constant-time compare)
│   ├── auth-middleware.ts            # Session cookie verification + dev bypass; LEFT JOIN `ON u.deleted_at IS NULL` routes tombstoned users through orphan-session cleanup (Phase 7)
│   ├── oauth-state.ts                # HMAC-signed state (10min TTL, provider-bound)
│   ├── oauth-helpers.ts              # User + session creation after provider callback
│   ├── signed-intents.ts             # HMAC-signed nonce primitives (5-min TTL) — Phase 7 age-confirmation intent
│   ├── http-cache.ts                 # Shared no-cache helpers (Cache-Control: no-store, private; Vary: Cookie) — Phase 7
│   ├── api/
│   │   ├── capsules/
│   │   │   ├── publish.ts            # POST — authenticated publish (quota + persist); 428 + structured body when no `age_13_plus` row (Phase 7)
│   │   │   ├── [code].ts             # GET — metadata (gated by accessibility predicate)
│   │   │   └── [code]/
│   │   │       ├── blob.ts           # GET — capsule JSON blob with safe headers
│   │   │       ├── preview/poster.ts # GET — poster image (404 until preview ready)
│   │   │       └── report.ts         # POST — abuse report (IP-hash de-dup)
│   │   ├── account/                  # Phase 7 — authenticated owner self-service
│   │   │   ├── me.ts                         # GET /me (deterministic provider via ORDER BY)
│   │   │   ├── delete.ts                     # POST /delete — authoritative cascade w/ re-scan + per-step audit + truthful `ok` flag
│   │   │   ├── age-confirmation/
│   │   │   │   ├── intent.ts                 # POST /intent — issue 5-min HMAC nonce (consumed by auth/{provider}/start.ts)
│   │   │   │   └── index.ts                  # Age confirmation accept/read for `user_policy_acceptance`
│   │   │   └── capsules/
│   │   │       ├── index.ts                  # GET /capsules?cursor= — cursor-paginated, base64url `(created_at, share_code)`
│   │   │       ├── delete-all.ts             # POST /delete-all — LIMIT 200 batch + `moreAvailable` flag
│   │   │       └── [code]/index.ts           # DELETE /capsules/:code — 404 on cross-user (no existence disclosure)
│   │   ├── privacy-request.ts         # Phase 7 — POST; CSRF nonce / honeypot / per-IP D1 quota / 24h body-dedup
│   │   ├── privacy-request/
│   │   │   └── nonce.ts               # GET — one-shot form nonce (paired w/ privacy-request.ts)
│   │   ├── admin/
│   │   │   ├── capsules/[code]/delete.ts  # Moderation delete (idempotent); wraps shared capsule-delete core (Phase 7)
│   │   │   ├── sweep/orphans.ts           # R2 orphan sweep (24h threshold)
│   │   │   ├── sweep/sessions.ts          # Expired/idle session + quota-bucket prune
│   │   │   ├── sweep/audit.ts             # Phase 7 — POST ?mode=scrub|delete-abuse-reports; class-based PII scrub; row-delete abuse_report + privacy_requests past 180d
│   │   │   └── seed.ts                    # Local-only admin seed
│   │   └── auth/
│   │       ├── session.ts            # Current-session probe
│   │       └── logout.ts             # Clear session cookie
│   ├── auth/                         # OAuth start/callback per provider
│   │   ├── google/{start,callback}.ts # Phase 7: start.ts validates age-confirmation HMAC nonce; live-session bypass for already-signed-in users
│   │   ├── github/{start,callback}.ts # Phase 7: same nonce validation as Google
│   │   └── popup-complete.ts         # Static landing for popup flow: dual-channel notify (postMessage + BroadcastChannel) + DOM stuck-state fallback
│   └── c/[code].ts                   # GET /c/:code — share-preview HTML (og: metadata)
├── src/share/                        # Shared modules (frontend + backend)
│   ├── d1-types.ts                   # Minimal D1 shim shared by both tsconfigs
│   ├── share-code.ts                 # Generate / normalize / validate share codes
│   ├── share-record.ts               # Status enums, accessibility predicates, metadata mapper
│   ├── publish-core.ts               # Validation, metadata extraction, SHA-256, collision-safe persist
│   ├── rate-limit.ts                 # Split quota API (check / consume / prune)
│   ├── audit.ts                      # Append-only audit log, IP hashing, usage counters
│   ├── capsule-delete.ts             # Phase 7 — shared delete core (admin moderation + owner self-service wrap it); tombstone semantics (status='deleted', NULL content fields, NULL object_key on R2 success)
│   ├── b64url.ts                     # Phase 7 — base64url helpers (cursor encoding for /account/capsules)
│   ├── error-message.ts              # Phase 7 — uniform error-shape helper
│   └── constants.ts                  # Shared 20 MB publish size limit (also surfaced via structured 413)
├── src/policy/                       # Phase 7 — policy source-of-truth + build-time injector
│   ├── policy-config.ts              # Exports `POLICY_VERSION`, `ACTIVE_POLICY_SEGMENTS`, `POLICY_FEATURES`
│   └── vite-policy-plugin.ts         # Injects `<meta name="policy-version">` + `<meta name="policy-active-segments">` into /privacy and /terms HTML at build; consumed by scripts/deploy-smoke.sh and tests/e2e/policy-routes.spec.ts
├── privacy/index.html                # Phase 7 — /privacy static route (policy meta injected at build)
├── terms/index.html                  # Phase 7 — /terms static route (policy meta injected at build)
├── account/                          # Phase 7 — /account authenticated self-service (index.html + main.tsx)
├── privacy-request/                  # Phase 7 — /privacy-request form (index.html + main.ts); CSRF nonce + honeypot
├── migrations/                       # D1 schema (sqlite)
│   ├── 0001_capsule_share.sql
│   ├── 0002_audit_quota_counters.sql
│   ├── 0003_capsule_object_key_index.sql
│   ├── 0004_capsule_delete_clears_body_metadata.sql  # Phase 7 — capsule_delete sentinel (tombstone content NULL-out)
│   ├── 0005_user_tombstone.sql                        # Phase 7 — users.deleted_at (soft-delete tombstone)
│   ├── 0006_user_policy_acceptance.sql                # Phase 7 — `user_policy_acceptance` (PK: user_id + policy_kind, UPSERT)
│   └── 0007_privacy_requests.sql                      # Phase 7 — `privacy_requests` + `privacy_request_quota_window`
├── workers/cron-sweeper/             # Companion Worker (separate deploy)
│   ├── wrangler.toml                 # Own config, two cron triggers
│   ├── tsconfig.json                 # Own tsconfig
│   ├── README.md                     # Deploy notes
│   └── src/index.ts                  # Scheduled handler (HMAC-header call to admin sweeps)
├── tsconfig.json                     # Frontend (lab + watch + src/)
├── tsconfig.functions.json           # Backend (functions/ + handler tests, workers-types)
└── wrangler.toml                     # Pages project binding manifest
```

#### Data Plane vs Control Plane

- **Control plane — D1 (SQLite):** the authoritative index of every share. `capsule_share` holds one row per capsule keyed by internal `id`, indexed on `share_code` (unique), `status`, `owner_user_id`, `created_at`, and `object_key`. Status transitions (`draft` → `ready` → optional `ready_pending_preview` → `removed`/`rejected`) are the only signal that ever gates reads. `users`, `oauth_accounts` (`(provider, provider_account_id)` unique, **no auto cross-provider linking** — Phase 1 policy), and `sessions` (`last_seen_at` for 30-day idle expiration) live beside it. Append-only observability lives in `capsule_share_audit` and per-day `usage_counter`. Quota state lives in `publish_quota_window` (`(user_id, window_key)` PK).
- **Data plane — R2:** validated capsule blobs under a single `capsules/<id>/capsule.atomdojo` prefix. **Validate-then-write** (no quarantine prefix); validation lives in `src/share/publish-core.ts` and runs before any R2 write. The bucket is **never** served publicly — all reads flow through `functions/api/capsules/[code]/blob.ts`, which re-checks the row status before streaming bytes. Preview assets (poster, motion) use sibling keys tracked by `preview_poster_key` / `preview_motion_key`.
- **Accessibility gate:** `src/share/share-record.ts` exposes `isAccessibleStatus(status)` — only `ready` and `ready_pending_preview` expose blob/metadata. Every GET handler runs the predicate before responding; non-accessible statuses return `404` (no state leak). `toMetadataResponse(row)` is the single place metadata is projected for clients.

#### Control Flows

**Publish (Lab → cloud):**
```
Lab TimelineBar (Transfer → Share tab)
    → onPublishCapsule callback (lab/js/components/timeline-transfer-dialog.tsx
                                 + lab/js/runtime/timeline-subsystem.ts)
    → POST /api/capsules/publish
           │
           ▼
    functions/api/capsules/publish.ts
      1. auth-middleware  → require session user
      2. rate-limit.checkPublishQuota(userId)      (read-only preflight)
      3. publish-core.validateAndExtractMetadata() (size, format, version, SHA-256)
      4. publish-core.persistRecord()              (insert draft row, collision-safe share_code)
      5. R2.put(capsules/<id>/capsule.atomdojo)
      6. flip status draft → ready (or ready_pending_preview if preview pipeline defers)
      7. rate-limit.consumePublishQuota(userId)    (write-only; failure → warning, not abort)
      8. audit.recordAuditEvent('publish_success')
    → 201 { shareCode, warnings?: ['quota_accounting_failed' | 'audit_write_failed'] }
```
The response `warnings[]` surfaces publish-succeeded-but-bookkeeping-degraded states; the lab success state renders each warning as a subtle note.

**Resolve (Watch opens a share):**
```
User pastes any of: raw code, grouped code, /c/<code>, /watch/?c=<code>, full URL
    → share-code.normalizeShareInput()          (src/share/share-code.ts)
    → WatchController.openSharedCapsule(input)  (watch/js/watch-controller.ts)
         ├── GET /api/capsules/<code>           → metadata (404 if not accessible)
         ├── GET /api/capsules/<code>/blob      → capsule JSON bytes
         ├── construct File (synthesize name/type)
         └── route through existing openFile() transactional pipeline
    → document-service prepare/commit → renderer displays the capsule
```

**Share preview (`GET /c/:code`):** `functions/c/[code].ts` returns HTML with `og:` metadata plus a client-side redirect to `/watch/?c=<code>`. Bots get metadata without JS; browsers get the redirect. Non-accessible statuses return `404` (same predicate as the API).

**Moderation:**
```
Admin caller (dev localhost OR cron header)
    → POST /api/admin/capsules/<code>/delete
    → functions/api/admin/capsules/[code]/delete.ts
         1. admin-gate.ts                 (two-path check; 404 on failure)
         2. flip status → removed         (idempotent — already-removed returns OK)
         3. R2.delete(object_key)
         4. audit.recordAuditEvent('moderation_delete')
```

**Sweep (cron companion → admin endpoints):**
```
Cloudflare cron trigger (workers/cron-sweeper/wrangler.toml)
    → workers/cron-sweeper/src/index.ts scheduled handler
    → POST /api/admin/sweep/sessions   (every 6h)
        → functions/api/admin/sweep/sessions.ts
        → prune expired/idle sessions + expired quota buckets (rate-limit.pruneExpiredQuotaBuckets)
        → audit 'session_swept'
    → POST /api/admin/sweep/orphans    (daily 03:30 UTC)
        → functions/api/admin/sweep/orphans.ts
        → list R2 keys older than 24h with no matching capsule_share row
        → delete orphans; audit 'orphan_swept' / 'orphan_sweep_failed'
    → POST /api/admin/sweep/audit?mode=scrub               (weekly Sun 04:15 UTC)
        → functions/api/admin/sweep/audit.ts
        → NULL ip_hash / user_agent / reason on rows older than 180d
        → audit 'audit_swept'
    → POST /api/admin/sweep/audit?mode=delete-abuse-reports (weekly Sun 04:45 UTC)
        → functions/api/admin/sweep/audit.ts
        → row-delete abuse_report audit rows + privacy_requests past 180d
        → audit 'audit_swept'
```

#### Auth Architecture

OAuth is the only identity source. State is server-signed and provider-bound; sessions are cookie-only.

```
Client clicks "Sign in with <Provider>"
    → GET /auth/<provider>/start
          │  functions/auth/<provider>/start.ts
          │    ├── oauth-state.signState(provider, nonce, ttl=10min)
          │    └── 302 → provider consent URL (state in query)
          ▼
    Provider consent
          │
          ▼
    → GET /auth/<provider>/callback
          │  functions/auth/<provider>/callback.ts
          │    ├── oauth-state.verifyState() — HMAC + TTL + provider binding
          │    ├── exchange code for token, fetch provider profile
          │    ├── oauth-helpers.findOrCreateUser()   (no cross-provider linking — Phase 1)
          │    ├── oauth-helpers.createSession()       (D1 insert)
          │    └── Set-Cookie session + 302 → app
          ▼
    Subsequent requests
          │  functions/auth-middleware.ts
          │    ├── read session cookie, verify row, bump last_seen_at
          │    └── attach userId to context, else 401
```

- **Cookie names by environment:** production and preview use distinct cookie names so a preview session never satisfies a production request (and vice versa). Protocol-scoped: `__Host-atomdojo_session` on HTTPS, `atomdojo_session_dev` on plain-HTTP localhost.
- **Dev bypass:** when `AUTH_DEV_USER_ID` is set and the request is from localhost, `auth-middleware.ts` short-circuits to that user id. Never active in production.
- **Idle expiration:** sessions expire after 30 days of no `last_seen_at` bump; the session sweeper (above) reclaims the rows.

##### Session probe contract (`GET /api/auth/session`)

Always returns **200** with a JSON `status` discriminator — never 401 for the signed-out case. Rationale: a state-discovery probe is not a protected action, and emitting a red 401 on every Lab page load for signed-out users would bury real auth errors in devtools noise. 401 is reserved for protected-action endpoints (e.g. `/api/capsules/publish`) where it genuinely means "flip UI to an auth prompt".

Response shapes:
- signed in: `{ status: 'signed-in', userId, displayName, createdAt }`
- signed out: `{ status: 'signed-out' }`

Anti-cache headers on every response: `Cache-Control: no-store, private`, `Pragma: no-cache`, `Vary: Cookie`. A cached signed-out response could make the opener think a completed popup login failed; a cached signed-in response could keep a stale identity visible after logout. `no-store` is the only directive that forbids storage outright.

**Opportunistic cookie clear (`Set-Cookie`):** when the request presented a session cookie but auth resolution returned `null` (orphan / expired / idle / unknown session id), the signed-out response appends a clearing `Set-Cookie`. Without this the browser would keep sending the stale cookie on every subsequent probe until a protected action finally cleared it. The helper `hasSessionCookie(request)` in `auth-middleware.ts` drives this decision (protocol-scoped to match the request's cookie name).

##### Orphan-session handling

A "session" row whose `user_id` no longer references a live `users` row (user was deleted after sign-in) is treated as unauthenticated. `authenticateRequest()` uses a single `LEFT JOIN sessions→users` round-trip: `users.id IS NULL` distinguishes "session exists but user is gone" from "session row itself missing". Orphans are deleted fire-and-forget so future requests don't repeat the join-and-reject cost. Per-isolate `orphanDeleteDedupe: Set<string>` prevents a persistently-failing DELETE from hammering D1; bounded at `ORPHAN_DEDUPE_LIMIT = 256` so adversarial cookies can't grow memory unbounded. Failures log with the `[auth.orphan-delete-failed]` prefix. Without this check the session probe would report signed-out while protected endpoints still accepted the cookie as authorized — a real correctness gap.

##### Lab-side auth runtime (`lab/js/runtime/auth-runtime.ts`)

Owns session hydration, popup OAuth initiation, and the resume-publish handoff. The Lab must work for unauthenticated users; this runtime never blocks boot on the session fetch. Watch and local download stay fully public.

**Exports:** `createAuthRuntime()`, `hydrateAuthSession()`, `consumeResumePublishIntent()`, `attachAuthCompleteListener()` / `detachAuthCompleteListener()`, `AuthRequiredError`, `AUTH_RETURN_QUERY`, `_resetAuthRuntimeForTest()`.

**AuthCallbacks** (registered on the store): `onSignIn(provider, opts?)`, `onSignInSameTab()`, `onDismissPopupBlocked()`, `onSignOut()`.

**Auth state machine (store contract):** `AuthState` is a discriminated union:

```ts
| { status: 'loading',    session: null }
| { status: 'signed-in',  session: AuthSessionState }
| { status: 'signed-out', session: null }
| { status: 'unverified', session: null }
```

Narrow setters in the store: `setAuthLoading`, `setAuthSignedIn`, `setAuthSignedOut`, `setAuthUnverified` (plus raw `setAuthState` as a test seam). `unverified` is distinct from `signed-out` — it means transport/5xx/malformed and we can't confirm either way; UI must render a neutral "can't verify" affordance, NOT an OAuth prompt. Treating a transport blip as signed-out would mislead users whose cookie is still valid server-side.

**Hydration transition table** (`hydrateAuthSession()`; source-of-truth comment lives in `auth-runtime.ts`):

| Outcome                         | Prior state       | Next state   |
|---------------------------------|-------------------|--------------|
| 200 `status: 'signed-in'` + shape OK | any          | signed-in    |
| 200 `status: 'signed-out'`      | any               | signed-out   |
| network / 5xx / malformed       | loading           | unverified   |
| network / 5xx / malformed       | any other         | (keep prior) |

Preserving non-`loading` prior states on indeterminate outcomes is the key invariant: a late/concurrent fetch must not clobber an authoritative signed-in or signed-out answer with the weaker `unverified` state. Concurrency is enforced by a monotonic `hydrateSeq` token — each call snapshots its sequence number at start and drops the write if it is no longer the latest. Fetches use `{ cache: 'no-store', credentials: 'same-origin' }`.

**Popup OAuth data-flow (primary path):** Lab issues `window.open(startUrl, 'atomdojo-auth', ...)` — this preserves in-memory scene/timeline state. The OAuth callback sets the session cookie and redirects the popup to `/auth/popup-complete` (static HTML). The landing page notifies the opener via two independent channels:

1. **`window.postMessage({ type: 'atomdojo-auth-complete' }, origin)`** — same-origin, delivered only when `window.opener` survives.
2. **`BroadcastChannel('atomdojo-auth')`** — same-origin fallback for the case where a Cross-Origin-Opener-Policy response anywhere in the provider → callback → popup-complete chain severs `window.opener` and postMessage silently fails.

Both listeners are attached by `attachAuthCompleteListener()`; on either signal the opener re-hydrates the session and (if `resumePublish` was requested) consumes the intent and reopens the Transfer dialog on the Share tab. The popup-complete page also includes a DOM stuck-state fallback so a user staring at a frozen popup knows what to do. `validateReturnTo` in `functions/oauth-state.ts` is called from `auth/{google,github}/start.ts`, then carried through the signed OAuth state payload and re-used verbatim by the callback redirect; it accepts both `/auth/popup-complete` (popup) and `/lab/?authReturn=1` (same-tab fallback).

**Popup-blocked handling — no silent same-tab fallback:** if `window.open` returns null (blocked), the runtime sets `authPopupBlocked = { provider, resumePublish }` on the store and stops. The UI drives Retry / Continue-in-tab / Back via `AccountControl`'s popup-blocked sub-menu; `onDismissPopupBlocked()` clears the flag. Silent same-tab redirect would throw away Lab in-memory state without user consent.

**Vite dev-host guard:** `window.location.protocol === 'http:' && window.location.port !== '8788'` short-circuits popup on non-wrangler dev hosts (e.g. Vite on 5173). `/auth/{provider}/start` isn't served there, so the runtime surfaces an instructive error instead of opening a popup to nowhere. Wrangler `pages dev` on 8788 is the supported local auth path.

**Resume-publish intent:** structured `{ kind, provider, iat }` JSON written to sessionStorage under `atomdojo.resumePublish` with a 10-minute TTL. Consumed in two paths:
- **Popup:** via the postMessage/BroadcastChannel handshake after hydration reports signed-in.
- **Same-tab fallback:** via the `?authReturn=1` query marker (constant `AUTH_RETURN_QUERY`) — without this marker the sentinel is treated as stale and ignored, preventing the "user started OAuth, abandoned it, came back hours later already signed in" leak case.

**`AuthRequiredError`:** typed error (`kind = 'auth-required'`) thrown by protected-action callers (publish) on 401. Consumers flip the store's auth state to signed-out so the Transfer dialog's Share panel re-renders as the in-context auth prompt rather than a generic "publish failed".

##### Store contract: auth transient flags

Both flags are one-shot UI control-flow signals cleared by `resetTransientState()`. `auth.status` / `auth.session` are NOT cleared — identity persists across resets.

- **`authPopupBlocked: { provider, resumePublish } | null`** — present iff the most recent sign-in attempt's `window.open` returned null. `AccountControl` renders the popup-blocked sub-menu (Retry / Continue-in-tab / Back) while non-null. Cleared by `onDismissPopupBlocked()` or `resetTransientState()`.
- **`shareTabOpenRequested: boolean`** — one-shot trigger telling `TimelineBar` to open the Transfer dialog on the Share tab after the OAuth return completes. Set by the auth runtime on successful post-popup hydration when a resume-publish intent was consumed; read-and-cleared by the TimelineBar consumer on next render. Also cleared by `resetTransientState()`.

##### Lab UI components

- **`AccountControl.tsx`** — top-right auth disclosure with four status branches (loading / signed-in / signed-out / unverified) plus a popup-blocked sub-menu (Retry / Continue-in-tab / Back). Uses plain ARIA disclosure semantics (not `role="menu"`).
- **`TopRightControls.tsx`** — flex row wrapping `AccountControl` + `FPSDisplay`. Replaces the previous pair of independently-absolutely-positioned surfaces so they lay out against each other deterministically.
- **`TimelineBar.tsx`** — auth wiring: opportunistic `hydrateAuthSession()` on Share-tab open, 401 recovery via `AuthRequiredError` (flips store to signed-out), kind-tagged `shareError: { kind: 'auth' | 'other', message }`, Back handler delegates to `onDismissPopupBlocked`.
- **`timeline-transfer-dialog.tsx`** — five Share-panel states (success / loading / unverified / signed-out / signed-in) plus a popup-blocked sub-panel and a `ShareActions` sub-component.

#### Admin Gate

`functions/admin-gate.ts` is the single authorization primitive for `functions/api/admin/*` and is also enforced independently in `workers/cron-sweeper/src/index.ts`. It accepts **either** of two paths:

1. `DEV_ADMIN_ENABLED === 'true'` **and** the request originates from localhost. Local-only developer escape hatch.
2. An `X-Cron-Secret` header whose value matches `CRON_SECRET`, compared with `crypto.subtle.timingSafeEqual`-style **constant-time** compare. This is the path the cron companion uses.

On failure the gate returns `404 Not Found` (not `401`/`403`) so the endpoint does not leak its own existence to unauthenticated callers. Both sides of the wire use the same constant-time helper so secret-length mismatches don't create a timing channel.

#### Rate Limiting / Quota

Per-user publishing is bounded by a sliding-window quota backed by D1. Contract in `src/share/rate-limit.ts`:

- **Split API** — `checkPublishQuota(userId)` is **read-only** (preflight gate), `consumePublishQuota(userId)` is **write-only** (called only after the blob write + status flip succeed). This split exists so **failed publish attempts don't consume quota**: a 4xx rejection leaves the user's budget untouched. `pruneExpiredQuotaBuckets()` is called by the session sweep.
- **Defaults** — `DEFAULT_PUBLISH_QUOTA`: 10 publishes per 24h, composed of 24× 1h buckets (coarse-bucket sliding window). Callers may override via `PublishQuotaConfig`.
- **Overshoot axes** (documented in the module docstring — ops must understand both):
  1. **Bounded-burst overshoot:** concurrent publishes that each pass `checkPublishQuota` before any calls `consumePublishQuota`. Bounded by in-flight concurrency; acceptable.
  2. **Consume-failure overshoot:** if `consumePublishQuota` throws after the publish already succeeded, quota is not debited. The handler records `publish_quota_accounting_failed` in the audit stream and surfaces `'quota_accounting_failed'` in the response `warnings[]`. Under sustained D1 outages this becomes **unbounded** — ops must alert on `publish_quota_accounting_failed` counts and treat spikes as an incident, because the user-visible quota gate is degraded while the write path still works.
- **Event vocabulary** distinguishes rejection causes so dashboards can separate them: `publish_rejected_quota`, `publish_rejected_size`, `publish_rejected_invalid`.

#### Audit Stream Contract

`src/share/audit.ts` is the append-only observability layer for the control plane. Every consequential state change writes one row to `capsule_share_audit`.

- **Event types:** `publish_success`, `publish_rejected_quota`, `publish_quota_accounting_failed`, `publish_rejected_size`, `publish_rejected_invalid`, `abuse_report`, `moderation_delete`, `orphan_swept`, `orphan_sweep_failed`, `session_swept`, `owner_delete`, `account_delete`, `age_confirmation_recorded`, `audit_swept` (last four added in Phase 7). Each state transition emits exactly one event type, so the stream is a reconciliation log: replaying it reproduces the count of each outcome per day.
- **`recordAuditEvent()`** is the only writer. It defensively truncates `reason` fields to `MAX_AUDIT_REASON_LENGTH = 500` chars so a caller with a huge error message cannot bloat the table.
- **`hasRecentAuditEvent(ipHash, eventType, windowSeconds)`** supports per-IP per-day de-duplication for abuse reports (prevents report spam from a single source).
- **`hashIp(ip)`** is a SHA-256 over the IP plus `SESSION_SECRET` salt. The function **rejects an empty salt** to fail loudly if the secret is unset — an empty salt would make the hash trivially reversible.
- **`incrementUsageCounter(metric, day)`** writes to `usage_counter` (PK `(metric, day)`), giving pre-aggregated per-day rollups for dashboards without scanning the audit stream.

Reconciliation model: the audit stream is the system of record for "what happened". The quota and usage counters are derived caches; the sweeper can rebuild them from the audit stream if needed.

#### Cron Companion Worker (`workers/cron-sweeper/`)

Cloudflare Pages Functions do not support scheduled handlers, so the sweeps run from a separately deployed standard Worker. It owns its own `wrangler.toml` and `tsconfig.json`; it shares no runtime code with the Pages project — it is a pure HTTP client that POSTs to `/api/admin/sweep/*` on the production Pages URL with the `X-Cron-Secret` header.

- **Schedule** (from `workers/cron-sweeper/wrangler.toml`):
  - `0 */6 * * *` — every 6 hours → `/api/admin/sweep/sessions`
  - `30 3 * * *` — daily 03:30 UTC → `/api/admin/sweep/orphans`
  - `15 4 * * 0` — weekly Sun 04:15 UTC → `/api/admin/sweep/audit?mode=scrub`
  - `45 4 * * 0` — weekly Sun 04:45 UTC → `/api/admin/sweep/audit?mode=delete-abuse-reports`
- **Cron count:** 4 of the 5-trigger free-tier ceiling. Adding a fifth is fine; a sixth requires the paid plan (which raises the ceiling to 250 crons/account).
- Both ends (`functions/admin-gate.ts` and `workers/cron-sweeper/src/index.ts`) compare the secret with the same constant-time routine — never string equality.
- Deploy notes (secret setup, base URL override for local dev) live in `workers/cron-sweeper/README.md`. Keep cron counts within the active Workers plan's limits (free tier: 5 crons/account).

#### Module Ownership

Narrow module ownership table — who owns what across the Phase 5 surface:

| Area | Owner module(s) | Notes |
|------|-----------------|-------|
| Share-code shape | `src/share/share-code.ts` | Generate / normalize / validate. Single source of truth for every paste shape (raw, grouped, `/c/<code>`, `/watch/?c=<code>`, full URL). |
| Status + accessibility | `src/share/share-record.ts` | `isAccessibleStatus`, `toMetadataResponse`. Every GET handler routes through these. |
| Publish pipeline | `src/share/publish-core.ts` | Validation, metadata extraction, SHA-256, ID generation, collision-safe `persistRecord`. |
| Rate limit / quota | `src/share/rate-limit.ts` | Split API: `checkPublishQuota` / `consumePublishQuota` / `pruneExpiredQuotaBuckets`. Hot path: `functions/api/capsules/publish.ts`. |
| Audit + counters | `src/share/audit.ts` | `recordAuditEvent`, `hasRecentAuditEvent`, `hashIp`, `incrementUsageCounter`. Event-type vocabulary is closed. |
| D1 type shim | `src/share/d1-types.ts` | Shared across `tsconfig.json` and `tsconfig.functions.json` so handler tests don't depend on `@cloudflare/workers-types`. |
| Publish endpoint | `functions/api/capsules/publish.ts` | Auth → preflight quota → validate → R2 write → status flip → consume quota → audit. |
| Read endpoints | `functions/api/capsules/[code].ts`, `.../blob.ts`, `.../preview/poster.ts` | All gated by `isAccessibleStatus`; 404 on anything else. |
| Abuse report | `functions/api/capsules/[code]/report.ts` | IP-hash de-dup via `hasRecentAuditEvent`. |
| Moderation | `functions/api/admin/capsules/[code]/delete.ts` | Idempotent status flip + R2 remove. |
| Sweeps | `functions/api/admin/sweep/orphans.ts`, `.../sessions.ts` | Invoked only via `admin-gate.ts`. |
| Admin seed (local) | `functions/api/admin/seed.ts` | Dev-only. |
| Share-preview HTML | `functions/c/[code].ts` | og: metadata + redirect; 404 on non-accessible. |
| Session API | `functions/api/auth/session.ts`, `.../logout.ts` | `session.ts` always returns 200 with `status` discriminator, anti-cache headers, opportunistic `Set-Cookie` clear on stale-cookie+signed-out. Cookie verification lives in `functions/auth-middleware.ts`. |
| OAuth | `functions/auth/{google,github}/{start,callback}.ts` + `oauth-state.ts` + `oauth-helpers.ts` + `functions/auth/popup-complete.ts` | HMAC-signed state, 10min TTL, provider-bound. No cross-provider auto-linking. `popup-complete.ts` is the popup landing; dual-channel notify (postMessage + `BroadcastChannel('atomdojo-auth')`) + DOM stuck-state fallback. |
| Auth gate (user) | `functions/auth-middleware.ts` | Session cookie verify with LEFT JOIN→users (orphan → null + fire-and-forget DELETE, `[auth.orphan-delete-failed]` log prefix, per-isolate dedupe). `hasSessionCookie()` helper for session-probe cookie-clear decision. `AUTH_DEV_USER_ID` dev bypass on localhost. |
| Lab auth runtime | `lab/js/runtime/auth-runtime.ts` | Session hydration (monotonic `hydrateSeq` guard), popup OAuth (`window.open`), dual-channel handshake, `AuthRequiredError`, resume-publish intent (sessionStorage + `AUTH_RETURN_QUERY`), Vite dev-host guard (8788). |
| Lab auth UI | `lab/js/components/AccountControl.tsx`, `TopRightControls.tsx`, `TimelineBar.tsx`, `timeline-transfer-dialog.tsx` | Four-branch disclosure + popup-blocked sub-menu; top-right flex row; Share-tab hydration + 401 recovery; five-state Share panel. |
| Auth gate (admin) | `functions/admin-gate.ts` | Two-path: localhost+`DEV_ADMIN_ENABLED`, or `X-Cron-Secret` constant-time. 404 on failure. |
| Env binding type | `functions/env.ts` | D1, R2, secret typing shared by all handlers. |
| Cron scheduling | `workers/cron-sweeper/` | Standalone Worker with its own `wrangler.toml` / `tsconfig.json` / `README.md`. Pure HTTP client to admin sweeps. |
| Schema migrations | `migrations/0001_capsule_share.sql`, `0002_audit_quota_counters.sql`, `0003_capsule_object_key_index.sql` (Phase 7 additions — `0004_capsule_delete_clears_body_metadata.sql`, `0005_user_tombstone.sql`, `0006_user_policy_acceptance.sql`, `0007_privacy_requests.sql` — are enumerated in the Phase 7 ownership table below) | Applied via `wrangler d1 migrations apply`. |
| Lab integration | `lab/js/components/TimelineBar.tsx` + `timeline-transfer-dialog.tsx`, `lab/js/runtime/timeline-subsystem.ts` (`onPublishCapsule` on `TimelineCallbacks`) | Unified "Transfer" dialog: Download / Share tabs. Renders response `warnings[]` as a subtle note. |
| Watch integration | `watch/js/watch-controller.ts` (`openSharedCapsule`), `watch/js/main.ts` | Normalize → metadata fetch → blob fetch → synthesize `File` → existing `openFile()` transactional pipeline. |

### Phase 7 — Account Self-Service, Policy Surfaces, Age Gate, Privacy Channel

Phase 7 adds four static route entrypoints, an authenticated owner-self-service account API, a server-authoritative 13+ age gate that is checked at both OAuth start and at capsule publish, a privacy-request intake channel, a weekly audit-retention sweeper, and a shared capsule-delete core that both moderation and self-service routes wrap. The design principle across the surface is **no existence disclosure** (cross-user reads return 404 rather than 403) and **authoritative cascade with truthful `ok`** (the self-service delete endpoint re-scans after each step and returns `ok=false` if any cascade step actually failed).

**Routes (build entrypoints — see `vite.config.ts`):** `/privacy`, `/terms`, `/account`, `/privacy-request`. `/privacy` and `/terms` receive build-time `<meta name="policy-version">` + `<meta name="policy-active-segments">` injection from `src/policy/vite-policy-plugin.ts`, driven by `POLICY_VERSION` / `ACTIVE_POLICY_SEGMENTS` / `POLICY_FEATURES` in `src/policy/policy-config.ts`. The meta tags are consumed by `scripts/deploy-smoke.sh` and `tests/e2e/policy-routes.spec.ts` to assert deploy-and-test alignment without duplicating the policy version as a magic string.

**13+ age gate (server-authoritative, two enforcement points):**

```
Signed-out user on Lab (signed-out AccountControl menu OR Transfer dialog signed-out panel)
    ├── AgeGateCheckbox.tsx (shared component)
    │     ├── POST /api/account/age-confirmation/intent
    │     │     → functions/api/account/age-confirmation/intent.ts
    │     │     → signed-intents.ts issues 5-min HMAC nonce
    │     ├── Refresh policy: every 4 min + on visibilitychange + on consumer-bumped `refreshNonce`
    │     └── Nonce carried into OAuth `state` payload
    │
    └── User clicks Sign-In with <Provider>
          → GET /auth/{google,github}/start
                → validates nonce (HMAC + TTL) before 302 to provider
                → live-session bypass: already-signed-in users skip the check
                → on successful callback, upserts `user_policy_acceptance` row
                     (composite PK on user_id + policy_kind; UPSERT)

Already-signed-in user publishes a capsule
    → POST /api/capsules/publish
          → if no `user_policy_acceptance` row for `age_13_plus`:
                → 428 Precondition Required, structured body
                → Lab catches via AgeConfirmationRequiredError
                → Transfer dialog renders inline retro-ack (accept → re-post publish)
```

This two-point enforcement (OAuth start for new users; publish for pre-existing users who signed in before the gate shipped) means no user reaches a publish without either (a) consenting at sign-in or (b) consenting inline in the Transfer dialog.

**Account API (`functions/api/account/*`, all behind `auth-middleware.ts`):**

- `GET /me` — deterministic OAuth provider via `ORDER BY` so the displayed provider is stable across requests.
- `GET /capsules?cursor=` — cursor-paginated; cursor is base64url-encoded `(created_at, share_code)` tuple via `src/share/b64url.ts`.
- `DELETE /capsules/:code` — 404 on cross-user (no existence disclosure); wraps shared `src/share/capsule-delete.ts` core.
- `POST /capsules/delete-all` — batch delete capped at `LIMIT 200`; response includes `moreAvailable` so the client can loop.
- `POST /delete` — authoritative cascade: runs the delete steps (capsules, sessions, oauth_accounts, user tombstone) then **re-scans** and emits a per-step audit trail. Returns `ok: false` if any re-scan still finds live rows — the UI never shows a false-success.

All five endpoints share `functions/http-cache.ts` no-cache helpers (`Cache-Control: no-store, private`, `Vary: Cookie`) so authenticated responses are never stored by intermediaries or browser caches.

**Shared capsule-delete core (`src/share/capsule-delete.ts`):** Admin moderation (`functions/api/admin/capsules/[code]/delete.ts`) and owner self-service (`DELETE /api/account/capsules/:code`, `POST /api/account/capsules/delete-all`, `POST /api/account/delete`) **both wrap this module**. Delete semantics are **tombstone, not row-delete**: `status='deleted'`, content fields set to `NULL`, and `object_key` set to `NULL` only on successful R2 delete (preserving the pointer on R2 failure so a retry can still reach the blob). Migration `0004_capsule_delete_clears_body_metadata.sql` encodes the sentinel shape.

**User tombstone (`migrations/0005_user_tombstone.sql`):** `users.deleted_at`. `auth-middleware.ts` was extended with `LEFT JOIN users ON u.deleted_at IS NULL` so any session whose user is tombstoned resolves to the same "orphan session" code path that already deletes the session row fire-and-forget. No new rejection path was added — tombstone reuses the existing invariant.

**Audit retention sweeper (`functions/api/admin/sweep/audit.ts`, weekly cron):** `POST /api/admin/sweep/audit?mode=scrub|delete-abuse-reports`. The `scrub` mode performs **class-based PII scrub** — it NULLs `ip_hash`, `user_agent`, and `reason` on rows older than the retention window, without deleting the audit row itself (so reconciliation counts remain intact). The `delete-abuse-reports` mode is a **narrow row-delete** targeting `abuse_report` rows and `privacy_requests` rows past 180 days. Adding `audit.ts` is additive to the existing sweep cadence — the cron companion Worker gains a new HMAC-authenticated call.

**Privacy-request channel (`/privacy-request`):**

```
User submits /privacy-request form
    ├── GET /api/privacy-request/nonce          (CSRF single-use nonce)
    ├── Honeypot hidden field (spam trap)
    └── POST /api/privacy-request
          → functions/api/privacy-request.ts
            1. Validate nonce (single-use)
            2. Honeypot must be empty
            3. Per-IP D1 quota via privacy_request_quota_window
            4. 24h body-hash dedup (same body → idempotent)
            5. Insert into privacy_requests table
    → Operator runbook lives in docs/operations.md ("Privacy contact channel")
```

`migrations/0007_privacy_requests.sql` creates both `privacy_requests` and `privacy_request_quota_window`.

**Phase 7 module ownership (extension of the Phase 5 table):**

| Area | Owner module(s) | Notes |
|------|-----------------|-------|
| Policy source-of-truth | `src/policy/policy-config.ts` | `POLICY_VERSION`, `ACTIVE_POLICY_SEGMENTS`, `POLICY_FEATURES`. Single string constant referenced everywhere (smoke script, E2E, injected meta). |
| Policy build-time injection | `src/policy/vite-policy-plugin.ts` | Registered in `vite.config.ts`. Injects two meta tags into `privacy/index.html` and `terms/index.html` at build. |
| Policy routes | `privacy/index.html`, `terms/index.html`, `account/` (`index.html` + `main.tsx`), `privacy-request/` (`index.html` + `main.ts`) | Registered in `vite.config.ts` `rollupOptions.input`. |
| Age-gate checkbox | `lab/js/components/AgeGateCheckbox.tsx` | Shared by signed-out AccountControl menu + Transfer dialog signed-out panel. Refreshes every 4 min + on `visibilitychange` + on consumer-bumped `refreshNonce`. |
| Age-gate intent | `functions/signed-intents.ts`, `functions/api/account/age-confirmation/intent.ts`, `.../age-confirmation/index.ts` | `signed-intents.ts` is the HMAC primitive (5-min TTL). `intent.ts` issues; the nonce is validated at `auth/{google,github}/start.ts`. |
| Age-gate publish enforcement | `functions/api/capsules/publish.ts` | 428 with structured body when no `age_13_plus` row. Lab catches via `AgeConfirmationRequiredError` and renders inline retro-ack. |
| Policy acceptance persistence | `migrations/0006_user_policy_acceptance.sql` | Composite PK `(user_id, policy_kind)`; UPSERT on accept. |
| Account API | `functions/api/account/me.ts`, `.../delete.ts`, `.../capsules/index.ts`, `.../capsules/delete-all.ts`, `.../capsules/[code]/index.ts` | All no-cache (`http-cache.ts`). Cross-user → 404. Self-delete is re-scan-and-verify; `ok: false` on any residual row. |
| Shared capsule-delete core | `src/share/capsule-delete.ts` | Wrapped by both admin moderation and owner self-service. Tombstone semantics (`status='deleted'`, NULL content fields, NULL `object_key` on R2 success). |
| Tombstone middleware | `functions/auth-middleware.ts` | `LEFT JOIN ... ON u.deleted_at IS NULL` routes tombstoned users into the existing orphan-session cleanup path. |
| Audit retention sweep | `functions/api/admin/sweep/audit.ts` | `?mode=scrub` class-based PII scrub (NULL `ip_hash`/`user_agent`/`reason`); `?mode=delete-abuse-reports` row-deletes `abuse_report` + `privacy_requests` rows past 180 days. Weekly cron. |
| Privacy-request intake | `functions/api/privacy-request.ts`, `functions/api/privacy-request/nonce.ts`, `privacy-request/` | CSRF nonce + honeypot + per-IP D1 quota + 24h body-dedup. Runbook in `docs/operations.md`. |
| Shared utils | `src/share/b64url.ts`, `src/share/error-message.ts`, `functions/http-cache.ts` | `b64url` encodes the `(created_at, share_code)` cursor. `error-message.ts` uniform error shape. `http-cache.ts` no-cache helpers shared by all account endpoints. |
| Schema migrations | `migrations/0004_capsule_delete_clears_body_metadata.sql`, `0005_user_tombstone.sql`, `0006_user_policy_acceptance.sql`, `0007_privacy_requests.sql` | Applied via `wrangler d1 migrations apply`. |

### Deferred Phases

Phase 3B-D (remaining interface narrowing) and Phase 4 (folder reorganization) are intentionally deferred.

## External Dependencies

| Package | Required | Purpose |
|---------|----------|---------|
| numpy | Yes | Core numerics |
| numba | Recommended | 250-480x speedup for force evaluation |
| matplotlib | Optional | Plot generation |
| scipy | Optional | .mat file loading (optional fullerene import) |
| scikit-learn | Optional | ML pilot training |
