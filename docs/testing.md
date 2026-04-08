# Testing & Validation

## Test Ladder

Tests are numbered in order of complexity. Earlier tests must pass before later tests are meaningful.

| Test | File | What it validates | Pass criteria |
|------|------|-------------------|---------------|
| 1 | `test_01_dimer.py` | 2-body pair forces | Energy continuity, F≈-dE/dr (<1e-3), NVE drift <1e-4 |
| 2 | `test_02_angular.py` | 3-body angular forces | Energy varies with angle, force consistency (<1e-3) |
| 3 | `test_03_graphene.py` | Many-body flat system | Bond length ~1.42±5%, NVE drift <1e-3, no collapse |
| 4 | `test_04_c60.py` | Full curved system | 90/90 bonds preserved, NVE drift <1e-3 |
| 5 | `test_05_static_validation.py` | 0K relaxation | All systems converge to Fmax <1e-3, structures stationary at 0K |
| 6 | `test_06_perturbation.py` | Near-equilibrium response | Energy increases on perturbation, oscillates back, no instability |
| 7 | `test_07_multiatom_forces.py` | Multi-atom force accuracy | Finite-diff on relaxed C60/graphene, max error <1e-3 |
| 8 | `test_08_data_loading.py` | ML data pipeline | NPY shapes correct, decomposition verified, no NaN |

## Running Tests

```bash
# Run individual test
python3 tests/test_01_dimer.py

# Run all tests sequentially
for t in tests/test_0*.py; do echo "=== $t ===" && python3 "$t" || echo "FAILED"; done
```

Each test prints PASS/FAIL and returns exit code 0 (pass) or 1 (fail).

## Test Details

### Test 1: 2-Atom Dimer
- Sweeps distance r across cutoff region
- Checks energy is zero beyond cutoff (continuity)
- Verifies F = -dE/dr via finite difference at 7 distances (ε=1e-5 Å)
- Runs 10,000-step NVE with small initial velocity
- **Key metric:** force relative error < 1e-3, NVE drift < 1e-4

### Test 2: 3-Atom Angular
- 3 atoms with variable angle θ (60°–180°)
- Verifies energy varies meaningfully (>0.01 eV range)
- Finite-difference force check at 5 angles, all 9 force components
- **Key metric:** force error < 1e-3, angular sensitivity confirmed

### Test 3: Small Graphene
- 18-atom graphene patch (3×3 cells)
- Thermalized at 50K, 5000-step NVE
- Checks average bond length within 5% of 1.42 Å
- **Key metric:** structural stability, NVE conservation

### Test 4: C60
- 60-atom Buckminsterfullerene
- Thermalized at 100K, 5000-step NVE
- Checks all 90 bonds preserved, radius of gyration stable
- **Key metric:** no bond breaking, NVE drift < 1e-3

### Test 5: Static Validation
- Relaxes dimer, triangle, graphene, C60 to 0K
- Reports residual forces (must be < 1e-3 eV/Å)
- Runs 0K stability check (100 steps, zero velocity → near-zero displacement)
- Saves relaxed structures

### Test 6: Perturbation
- Starts from relaxed structures
- Applies ±0.05 Å random perturbation
- Runs 500-step NVE, verifies sensible oscillation
- **Key metric:** energy increases on perturbation, no explosion

### Test 7: Multi-Atom Forces
- Finite-difference force check on **relaxed** C60 (180 components) and graphene (54 components)
- ε = 1e-5 Å, checks all atoms in all directions
- **Key metric:** max relative error < 1e-3

### Test 8: Data Loading
- Loads all datasets in `data/`
- Verifies NPY array shapes match metadata
- Confirms F_total = F_2body + F_residual to machine precision
- Checks train/val/test split validity

## Output Artifacts

Each test writes results to `outputs/testN_*/`:
- `energy.csv` — energy time series
- `trajectory.xyz` — atomic trajectories
- `energy_components.png` — energy plot (if matplotlib available)

## When to Run Tests

- After **any change** to `sim/potentials/tersoff.py` or `tersoff_fast.py`
- After changing `sim/integrators/velocity_verlet.py`
- After modifying `sim/minimizer.py`
- After modifying structure generators
- Before generating ML training data
- Before claiming any validation result

## Frontend Unit Tests

Automated unit tests live in `tests/unit/` and run via Vitest (`npm run test:unit`). Playwright E2E tests live in `tests/e2e/` (`npm run test:e2e`).

*Per-section test counts below are approximate guides. Contributor-facing docs (contributing.md) omit exact counts entirely to avoid maintenance churn. Run `npx vitest run` for the authoritative total.*

```bash
# Run all unit tests
npx vitest run

# Run a single file
npx vitest run tests/unit/simulation-timeline.test.ts
```

### Timeline Subsystem (~122 tests across 9 files)

| File | Tests | What it validates |
|------|------:|-------------------|
| `simulation-timeline.test.ts` | 28+ | Core SimulationTimeline: recording frames, retention limits, review mode entry/exit, scrub to arbitrary frame, restart from timeline, truncation on re-record, motion preservation across restore, arming lifecycle |
| `timeline-bar-lifecycle.test.tsx` | 32 | TimelineBar unified shell: invariant lane skeleton across all modes (time + overlay-zone + track + action-zone), off/ready use simple label not segmented switch, active uses two-segment mode switch, bidirectional mode switch (onEnterReview, onReturnToLive), Review segment disabled when no recorded range, restart anchor edge clamping (0% at 5%, 100% at 95%), clear confirmation dialog flow (confirm fires, cancel safe), format correctness across all unit ranges (fs/ps/ns/µs with exact string assertions), mode transitions (off→ready→active store changes, startup null→installed), accessibility labels (return-to-sim, restart-with-time, clear trigger), no old row1/row2 layout remnants, thick track across all states, lane structure identical for short and long time values, hint tooltip visibility (6 tests: start recording hint on hover+delay, simulation segment hint in review, review segment hint with range, disabled review hint via focus when no range, restart anchor hint on hover, clear trigger hint on hover — all use `vi.useFakeTimers()` + `fireEvent.mouseEnter` + `vi.advanceTimersByTime(HINT_DELAY_MS)` and assert `timeline-hint--visible` class) |
| `timeline-recording-orchestrator.test.ts` | 9 | Orchestrator arming, recording cadence (frame capture rate), review-mode blocking of new recordings, sim-time advancement during recording, reset behavior |
| `timeline-recording-policy.test.ts` | 5 | Arm/disarm/re-arm lifecycle, policy state transitions |
| `timeline-subsystem.test.ts` | 11 | Subsystem boundary isolation, clearAndDisarm, teardown cleanup, isInReview predicate, installStoreCallbacks wiring, placement-does-not-arm regression tests |
| `timeline-arming-wiring.test.ts` | 10 | Store callback integration: placement, pause, speed, physics settings do not arm; atom interaction arms after placement |
| `interaction-dispatch-arming.test.ts` | 16 | Real createInteractionDispatch: arming on startDrag/startMove/startRotate/flick regardless of worker state; continuation events do not arm; worker mirroring independent of arming |
| `store-callbacks-arming.test.ts` | 7 | Real registerStoreCallbacks: chooser, dock, and settings callbacks verified through actual store surface |
| `reconciled-steps.test.ts` | 4 | Snapshot deduplication — ensures reconciled steps don't produce duplicate frames |

### Restart & State Restore (11 tests across 2 files)

| File | Tests | What it validates |
|------|------:|-------------------|
| `restart-state-adapter.test.ts` | 8 | State serialization round-trip, application to simulation, no-interaction-restore (preserving untouched state) |
| `worker-lifecycle-restore.test.ts` | 3 | Restore success reactivates worker, restore failure tears down, error during restore tears down |

### Worker Bridge (3 new tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `worker-bridge-direct.test.ts` | 3 | restoreState posts correct command to worker, resolves on success acknowledgement, crash yields failure |

### Physics Timing (10 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `physics-timing.test.ts` | 10 | Derived simulation rate, damping invariance across speed changes, setTimeConfig parameter application, engine parameterization consistency |

### Highlight Composition (13 tests in 1 file + shared helpers)

| File | Tests | What it validates |
|------|------:|-------------------|
| `renderer-interaction-highlight.test.ts` | 13 | Panel/interaction layer independence, real InstancedMesh creation, overlap counts, review-visibility restoration, disposal cleanup, multi-molecule regression |
| `highlight-test-utils.ts` | — | Shared helpers: `makeStateFake()` (minimal state-only renderer fake), `makeRealMeshCtx()` (real THREE geometry context) |

### Highlight Runtime Gating (5 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-group-highlight.test.ts` | 5 | Tracked highlight gating when `canTrackBondedGroupHighlight` is false |

Tests live in a `"tracked highlight gating"` describe block and verify the store behaves correctly when the tracking capability is disabled:

- `toggleSelectedGroup` no-ops when `canTrackBondedGroupHighlight` is false
- `setHoveredGroup` still works when tracking disabled
- `clearHighlight` safe when tracking disabled
- `syncToRenderer` self-heals stale tracked state when feature gated off
- hover works again after stale tracked state self-healed

Tests are organized in 3 layers, each catching a different class of regression:

| Layer | Tests | What it proves |
|-------|------:|----------------|
| **State-level channel** | 6 | Panel and interaction state are independent channels. Setting one does not clobber, clear, or overwrite the other. Clearing interaction leaves panel intact. Panel updates during active interaction do not corrupt interaction state. |
| **Real-mesh** | 5 | Actual `InstancedMesh` objects created via real THREE geometry. Both meshes coexist with correct `.count`. Partial overlap: atom in both sets rendered on both layers with exact counts. Review hide followed by live `_updateGroupHighlight()` restores `mesh.visible`. `disposeHighlightLayers` resets all state including intensity defaults (`'selected'` / `'hover'`). |
| **Integration regression** | 1 | Reproduces the original bug: bonded-group selection on molecule A (panel channel) + rotate molecule B (interaction channel). Both highlights must remain visible and independently clearable. |

Key test scenarios:

- Panel stays visible during interaction (concurrent coexistence)
- Partial overlap: atom in both sets rendered on both layers with exact counts
- Review hide then live update restores `mesh.visible`
- `disposeHighlightLayers` resets all state including intensity defaults
- Multi-molecule regression: select group A, rotate group B, both visible

### Renderer Atom Color Overrides (8 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `renderer-atom-color-overrides.test.ts` | 8 | Root-cause fix for authored color visibility via `_applyAtomColorOverrides`: material becomes white when overrides active (neutral multiply), overridden atoms get HSL-lifted per-instance colors, non-overridden atoms receive theme atom color as instance color, clearing overrides restores material to theme color, instance colors reset to white on clear, override colors visibly distinct from default atom color, theme switch with active overrides keeps material white (re-applies overrides), CONFIG `atomColorOverride` minSaturation/minLightness in reasonable perceptual-lift range. |

### App Orchestration Tests

Architecture extractions should be guarded at the extracted owner, not only through indirect helper tests.

| File | Purpose |
|------|---------|
| `frame-runtime.test.ts` | Per-frame pipeline ordering (worker-mode sequencing proof, review-mode gating, drag-refresh gating, sync-mode fallback, placement framing integration: framing runs during placement, orbit-follow suppressed, idle shrink allowed, drag framing + reprojection, drag reprojection not called when idle) |
| `app-lifecycle.test.ts` | Teardown sequence ordering (exact dependency-ordered call sequence, subscription cleanup, partial-init safety) |

### UI Components (58 tests across 2 files)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-groups-panel.test.tsx` | 51 | Full BondedGroupsPanel contract (see breakdown below) |
| `status-bar-precedence.test.tsx` | 7 | Rewritten for message-only contract: status message precedence rules across simulation states |

Previously-skipped StatusBar tests have been unskipped and now pass.

#### BondedGroupsPanel Test Breakdown (51 tests)

Tests cover the disclosure pattern, two-level UI, highlight wiring, color editing, popover layout, highlight hide behavior, buildGroupColorLayout, and config contracts:

**Disclosure pattern:** panel expanded by default with large clusters visible, header shows Collapse when expanded and Expand when collapsed, aria-expanded toggles correctly on header click, header click collapses everything.

**Core panel behavior:** returns null when no groups, small-clusters button expands only small groups, side-class defaults, side-right class when store side is right.

**Highlight hide (tracking disabled):** row click does not toggle selection, row has no button role or tabIndex, selected-row class not applied, hover preview still works, Clear Highlight hidden even with legacy `hasTrackedBondedHighlight`, color chip still works, Center and Follow still work when tracking disabled, panel visible in review with historical groups, panel hidden in review when no groups projected, bonded-group select gated off in review, bonded-group hover works in review, keyboard Enter/Space does not toggle selection when tracked highlight is disabled.

**Color chip and popover:** color chip visible in every row without requiring selection, chip defaults to base atom color (no inline style), clicking chip opens portalled popover (not a grid-row child), chip click does not toggle row selection (independent of selection), choosing a swatch calls `onApplyGroupColor` (7 swatches: 6 presets + original), second chip click closes popover, clicking backdrop closes popover, row gets `bonded-groups-color-open` class when popover active.

**Popover structure (honeycomb layout):** popover has honeycomb layout with default swatch in center and 6 preset swatches in computed ring, default swatch in hex center clears color, preset swatch in hex ring applies color.

**Hover clearing regressions:** hover clears when cursor leaves row, moving across rows switches preview correctly, opening color popover clears hover preview.

**Original-color swatch and multi-color chip:** popover has original-color swatch instead of clear button (calls `clearGroupColor`), clicking original-color swatch calls onClearGroupColor, original-color swatch gets active class when no override exists, multi-color group chip shows conic gradient (2+ authored colors), colored + default atoms shows conic gradient with `var(--atom-base-color)` segment, single-color chip shows solid background (not conic gradient) when ALL atoms have same override, portalled popover does not keep `hoveredBondedGroupId` alive.

**buildGroupColorLayout:** default option placed in primary slot, secondary preserves original preset order, primary is null when no default option exists, works with varying palette sizes.

**computeHexGeometry:** adjacent swatches do not overlap at active scale (tested for n=3,4,5,6,8,10), container fits all swatches including scaled edges, n=1 handled without division by zero, ring slot positions do not overlap for 6 presets (pairwise distance check).

**Config contracts:** selected highlight opacity/emissive below readability thresholds, hover highlight more subtle than selected (opacity, emissive, scale), every theme defines numeric atom color for CSS and renderer parity.

### Placement Solver (117 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `placement-solver.test.ts` | 117 | PCA shape classification, camera frame, molecule frame, orientation selection, no-initial-bond feasibility, rigid transform, full solver integration, continuity sweeps, roll stability, 3-layer acceptance gates |

Tests use perspective projection via the shared `projectToScreen()` (matches renderer FOV=50 deg) and 2D PCA via `projected2DPCA()` for stable visible-axis measurement.

Real library structure data is used alongside synthetic shapes: CNT (20 atoms spanning all Y rings from `cnt_5_5_5cells.xyz`) and graphene (18 atoms from `graphene_6x6.xyz`).

#### 3-Layer Acceptance Architecture

The acceptance tests use three intentionally overlapping layers. All three must pass; each catches a different class of regression.

| Layer | What it proves | Failure means |
|-------|---------------|---------------|
| **[policy conformance]** | Solver output matches `chooseCameraFamily()` | Implementation disagrees with the current product rule. Does NOT prove the rule itself is correct. |
| **[external oracle]** | Hand-written canonical backstop with stable expected families | Policy helper or geometry selector changed behavior on a case that was previously validated by hand. NOT derived from policy helpers. |
| **[observable behavior]** | Policy-independent user-facing sanity: readability ratios, orbit stability, plane projected shape | Preview may look wrong to the user regardless of which family the solver chose. Can detect a bad product rule. |

**[policy conformance]** tests assert the solver's visible long-axis angle matches the family returned by `chooseCameraFamily()`. They prove implementation conformance to the current rule, not product correctness. Covers both line-dominant and plane-dominant regimes across front, side, and oblique views.

**[external oracle]** tests are an independent canonical backstop: a small set of stable hand-written expected families. Currently mostly vertical-family because the scorer architecture (pure target-axis extent) makes stable horizontal line cases rare. This is a known property of the scorer, not a test gap. Failure here warrants investigating whether a policy change was intentional.

**[observable behavior]** tests validate what the user actually sees without referencing any policy helper: readability ratios (visible extent vs 3D extent), orbit stability (angle drift under small camera perturbation), and plane projected shape (2D PCA aspect ratio confirms face-on presentation). These can detect a bad product rule that the other two layers would miss.

### Placement Camera Framing (20 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `placement-camera-framing.test.ts` | 13 | Pure framing solver: no-adjustment fast path, target shift toward edge pressure, distance increase for wide unions, asymmetric margins, near-plane safety, orientation independence, visible-anchor filtering, adaptive search regression (visible-anchor vs offscreen, edge-drag target-shift preference, no over-depth), drag offset geometry (grabbed-point plane, non-origin preview, camera rotation compensation) |
| `placement-drag-lifecycle.test.ts` | 7 | Controller-path drag lifecycle: pointer capture acquired on pointerdown, pointerleave does not abort drag with capture, pointerup releases capture, pointercancel aborts, per-frame reprojection runs during drag, capture-failure fallback (pointerleave aborts when capture unsupported) |

### Review Mode UI Lock (35 tests across 6 files)

| File | Tests | What it validates |
|------|------:|-------------------|
| `review-ui-lock-selector.test.ts` | 4 | Selector: live mode all false, review mode all true, tooltip text content (asserts `REVIEW_LOCK_TOOLTIP` contains 'read-only' and 'Simulation'), tooltip vs status copy |
| `review-ui-lock-guards.test.ts` | 7 | Runtime guards: onAdd, onPause, onModeChange, onAddMolecule, onSelectStructure, onClear blocked in review with hint; all work in live |
| `review-lock-dom-structure.test.tsx` | 9 | DOM contract: li is direct child of ul, no timeline-hint-anchor class, tooltip inside li not wrapping (asserts `REVIEW_LOCK_TOOLTIP` content), keyboard-focusable, tooltip not inside dimmed wrapper, bottom-start placement, selector integration (tooltip wording consistency with updated `REVIEW_LOCK_TOOLTIP`) |
| `review-locked-interaction-hook.test.tsx` | 4 | Shared hook: click triggers status hint, Enter triggers hint, Space triggers hint, show/hide tooltip timing |
| `dock-bar-review-lock.test.tsx` | 8 | DockBar: Add review-locked, Pause review-locked, Segmented items disabled, ActionHint tooltips on disabled items, Settings not locked, live mode normal, blocked click, live/review segmented structural parity |
| `structure-chooser-review-lock.test.tsx` | 4 | StructureChooser: rows wrapped in review lock, tooltips present, click shows hint not callback, live mode normal |

### Dock Layout Stability (6 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `dock-bar-layout-stability.test.tsx` | 6 | 4 named slot wrappers, paused toggle preserves slot structure, Pause/Resume in same slot, mode slot contains segmented, placement maps to same slots, grid structure |

### Bonded Group Runtime & Store (20 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-groups.test.ts` | 20 | Projection, reconciliation, store behavior, and partitioning (see breakdown below) |

Tests cover connected-component projection, stable tie ordering, merge/split reconciliation, no-op suppression, panel store behavior, group partitioning, and selection ownership:

**Projection:** projects components sorted by size desc, minAtomIndex correct, empty/null physics produce empty groups, reset clears groups.

**Stable tie ordering:** equal-size groups maintain order across projections.

**Merge reconciliation:** merged group inherits ID from largest-overlap predecessor.

**Split reconciliation:** larger-overlap child inherits original ID, smaller child gets new ID.

**No-op suppression:** minAtomIndex change triggers store update, new equal-size groups sort by minAtomIndex fallback, identical projections do not trigger store update.

**Panel store behavior:** `bondedGroupsExpanded` defaults to true (expanded by default), `toggleBondedGroupsExpanded` toggles in both directions, `resetTransientState` preserves expanded preference and clears groups, `bondedSmallGroupsExpanded` defaults to false and toggles, `resetTransientState` collapses small groups.

**Partitioning:** partitions into large and small buckets, custom threshold works.

**Selection ownership:** `projectNow` does not clear `selectedBondedGroupId`, `reset` does not clear `selectedBondedGroupId`.

### Bonded Group Pre-Feature (17 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-group-prefeature.test.ts` | 17 | Display source: live resolution, review resolution, null case, strict review (no live fallback). Capabilities: live allows all, review blocks mutation but allows inspect/target/edit, live mode `canTrackBondedGroupHighlight` false, review mode `canTrackBondedGroupHighlight` false. Appearance: group color writes atom overrides, clear removes overrides, syncToRenderer drives renderer, syncGroupIntents propagates to uncolored atoms, syncGroupIntents does NOT overwrite existing overrides from merged groups, pruning (group disappears then intent pruned), clearGroupColor removes intent so syncGroupIntents won't re-apply. Wiring: initial sync with preloaded store, applyGroupColor drives renderer. Persistence: colors survive timeline mode transitions, annotation-global semantics. |

### Shared History Modules & Watch App

| File | What it validates |
|------|-------------------|
| `shared-history-modules.test.ts` | Shared history modules and watch app components (see breakdown below) |

**detectHistoryFile:** valid files, non-objects, wrong format, missing fields.

**validateFullHistoryFile:** structural guards (malformed envelopes, null internals, per-frame shape), simulation/atom field guards, semantic checks (maxAtomCount, frameCount, durationPs, positions length, monotonic ordering, atomId uniqueness, bond validation with endpoint range checks).

**computeConnectedComponents:** zero atoms, zero bonds, single component, multiple components, out-of-range bond indices.

**createBondedGroupProjection:** projection, reconciliation, reset.

**loadHistoryFile:** all LoadDecision branches (supported, unsupported replay/version, invalid JSON/format/validation).

**importFullHistory:** Float64Array conversion, bond tuple conversion, restartAlignedToDense flag, checkpoint normalization.

**createWatchPlaybackModel:** load/unload, 4 sampling channels, binary search edge cases, time clamping (NaN, out-of-range).

**createWatchBondedGroups:** group computation, memoization by frameId, reset.

**End-to-end pipeline:** load → import → playback → groups.

*All 1449 tests pass across 87 test files, including existing lab tests.*

### Watch Controller & Parity (~40+ tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-parity.test.ts` | ~35 | Watch controller lifecycle, lab/watch parity, playback speed (see breakdown below) |
| `watch-react-integration.test.tsx` | ~7 | React component integration: landing/workspace transition, error banners, playback bar, bonded-groups panel, top bar badge, WatchCanvas mock |

#### watch-parity.test.ts Breakdown

**partitionBondedGroups shared extraction:** default threshold, custom threshold, empty groups.

**BondedGroupSummary consolidation:** lab selector re-exports same function reference.

**Controller lifecycle:** initial snapshot, subscribe/unsubscribe, error on invalid file, referential snapshot stability.

**Controller with valid file:** load, togglePlay, scrub, transactional second-file open.

**File load initial time:** currentTimePs at first frame, not 0; file replacement resets correctly.

**Lab/watch parity on same file:** topology at sampled timestamps, bonded-group counts, metadata match.

**Playback speed x1 canonical rate:** rate independent of file length, short file takes real seconds.

#### watch-react-integration.test.tsx Breakdown

**Landing vs workspace transition:** component renders landing or workspace based on controller state.

**Error banner:** shown on landing and during workspace (transactional failure).

**Playback bar:** reflects playing state.

**Bonded-groups panel:** expand/collapse.

**Top bar file-kind badge:** displays correct file kind.

**WatchCanvas mocked:** Three.js incompatible with jsdom.

### Watch Camera Input (22 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-camera-input.test.ts` | 22 | Camera orbit, triad interaction, pointer capture, contextmenu, blur/touchcancel (see breakdown below) |

**Shared gesture constants:** exports expected constant values (TRIAD_DRAG_COMMIT_PX, TAP_INTENT_PREVIEW_MS, TAP_MAX_DURATION_MS, DOUBLE_TAP_WINDOW_MS), all positive numbers.

**Camera-input lifecycle:** create/destroy without errors, contextmenu listener removed on destroy.

**Desktop orbit:** left-drag on background starts orbit and calls applyOrbitDelta, right-drag starts orbit, pointer capture acquired on orbit start, middle-click does not start orbit (OrbitControls owns dolly).

**Desktop triad click parity:** left-click on triad does NOT call snapToAxis (lab has no desktop triad click), left-click on triad starts orbit instead (everything = orbit on desktop).

**Contextmenu suppression:** prevents default on contextmenu events.

**Blur handler:** window blur resets gesture state (subsequent move does not orbit).

**Mobile 1-finger orbit:** 1-finger drag on background starts orbit, 2-finger transition cancels active orbit.

**Mobile triad interaction:** triad drag below commit threshold does NOT orbit, drag above threshold orbits, tap on axis endpoint calls snapToAxis, tap on center zone does NOT snap (waits for double-tap), double-tap on center calls animatedResetView.

**Mobile touchcancel:** resets all gesture state on touchcancel.

**Controller lifecycle wiring:** watch-controller imports and uses createWatchCameraInput and createWatchOverlayLayout, detachRenderer tears down overlayLayout then cameraInput then renderer (ordering verification).

**WatchRenderer Round 3 adapter interface:** interface has all 10 Round 3 methods (9 interaction + setOverlayLayout).

**No duplicate orbit-math:** watch-camera-input does not import from orbit-math.ts (uses renderer adapter).

### Watch Overlay Layout (18 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-overlay-layout.test.ts` | 18 | Triad sizing formulas, ResizeObserver, retry loop, device mode (see breakdown below) |

**Playback bar selector contract:** WatchApp.tsx has `data-watch-bottom-chrome` attribute on bottom chrome wrapper, watch-overlay-layout queries `[data-watch-bottom-chrome]`.

**Triad sizing formulas:** desktop formula `min(200, max(120, floor(W * 0.10)))` with clamp to min 120 and max 200, phone formula `min(140, max(96, floor(W * 0.15)))` with clamp to max 140.

**Triad bottom positioning:** desktop fixed bottom = 12, phone clears playback bar when `[data-watch-bottom-chrome]` is in DOM, phone uses PHONE_TRIAD_BOTTOM_FALLBACK when playback bar is not in DOM.

**Triad left inset:** uses `--safe-left` CSS variable + 6, defaults to 6 when variable not set.

**scheduleFirstLayout retry loop:** phone: scheduled RAF retry finds bar after insertion and attaches observer, desktop: initial layout completes without retry.

**ResizeObserver on playback bar:** attaches observer in phone mode when bar exists, does NOT attach in desktop mode, disconnects observer when switching out of phone mode, observer callback triggers re-layout, disconnect on destroy.

**Overlay layout lifecycle:** destroy removes resize and orientationchange listeners.

### Bonded Group Color Assignments (17 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-group-color-assignments.test.ts` | 17 | Shared pure color module: override projection, chip state, hex geometry (see breakdown below) |

**rebuildOverridesFromDenseIndices:** empty map from empty assignments, maps atom indices to colors, later assignments win for overlapping indices.

**computeGroupColorState:** returns default for empty atom list, returns default when no overrides match, returns single when all atoms have same color, returns multi when atoms have different colors, returns multi with hasDefault when some atoms are uncolored, caps to 4 unique colors.

**chipBackgroundValue:** returns undefined for default state, returns hex for single color, returns conic-gradient for multi color, includes atom-base-color fallback when hasDefault is true, returns string not React.CSSProperties.

**computeHexGeometry:** returns non-zero radius for 6 items, returns zero radius for 0 or 1 items.

**GROUP_COLOR_OPTIONS + buildGroupColorLayout:** 7 options (1 default + 6 presets), splits default into primary and presets into secondary.

**Shared module purity:** shared module does not import React or Zustand, chip-style helper does not import React.

### Watch Bonded Group Appearance (14 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-bonded-group-appearance.test.ts` | 14 | Stable atomId assignments, per-frame projection, controller lifecycle (see breakdown below) |

**WatchBondedGroupAppearance:** initial state (no assignments, default color state), applyGroupColor freezes stable atomIds not dense slots, per-frame projection maps atomIds to current dense slots across reordered frames, silently skips atomIds not present in current frame, clearGroupColor removes assignments for that group, clearAllColors resets everything and passes null to renderer, reset clears assignments on file load, getGroupColorState reflects current overrides, replacing color for same group replaces prior assignment.

**Renderer _getDisplayedAtomCount regression:** renderer.ts uses `_reviewAtomCount` in review mode, `_applyAtomColorOverrides` uses `_getDisplayedAtomCount` not `_atomCount` directly, updateReviewFrame re-applies authored overrides at end.

**Controller lifecycle wiring:** controller imports and creates appearance domain, `appearance.reset()` is called in openFile not detachRenderer.

### Watch Playback Speed (27 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-playback-speed.test.ts` | 27 | Speed math, log mapping, repeat modulo, step semantics, directional playback (see breakdown below) |

**Shared constants:** SPEED_MIN < SPEED_DEFAULT < SPEED_MAX, SPEED_PRESETS contains min/default/max.

**Logarithmic slider mapping:** sliderToSpeed(0) = SPEED_MIN, sliderToSpeed(1) = SPEED_MAX, roundtrip speedToSlider(sliderToSpeed(t)) identity, roundtrip sliderToSpeed(speedToSlider(s)) identity, 1x is at ~19% of slider travel, clamps input outside [0,1].

**formatSpeed:** sub-10 shows one decimal (e.g., "1.0x"), 10+ shows integer (e.g., "16x").

**WatchPlaybackModel speed:** default speed is 1x, setSpeed clamps to [SPEED_MIN, SPEED_MAX], advance uses speed multiplier, advance clamps dtMs to GAP_CLAMP_MS, load resets speed to default.

**WatchPlaybackModel repeat:** default repeat is false, repeat wraps time at end using modulo, without repeat pauses at end, load resets repeat to false.

**WatchPlaybackModel step:** stepForward advances to next dense frame, stepForward at last frame is no-op, stepBackward moves to previous dense frame, stepBackward at first frame is no-op, step pauses playback, step from mid-frame goes to adjacent frame.

**Directional playback:** startDirectionalPlayback(1) sets direction and playing, startDirectionalPlayback(-1) enables backward advance, stopDirectionalPlayback pauses and resets direction, backward playback clamps to start when not repeating, backward playback wraps when repeating, seekTo resets direction, stepForward resets direction.

### Watch Round 5 UI (30 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-round5-ui.test.tsx` | 30 | Dock hold-to-play, settings sheet, timeline scrub, rerender-during-hold regression (see breakdown below) |

**Hold threshold constant:** HOLD_PLAY_THRESHOLD_MS is a positive number under 300ms.

**WatchDock structure:** source has transport cluster, utility cluster, and settings zones. Dock CSS uses fixed-width grid for transport cluster (no layout shift).

**WatchSettingsSheet structure:** uses shared sheet lifecycle hook (not local mount/animate state), imports help content from settings-content.ts, uses shared Segmented component for theme and text-size, help action uses a real button not div role="button".

**Watch settings content:** WATCH_HELP_SECTIONS has expected sections (Playback, Camera, File).

**WatchTimeline structure:** uses thick review track variant, uses pointer events for scrubbing (not native range).

**Shared CSS token contracts:** core-tokens.css defines layout geometry tokens, bottom-region.css uses shared width token, sheet-shell.css uses shared sheet width token.

**Playback direction model:** playback model has no setPlaying method (unified direction model), isPlaying is derived from playDirection.

**WatchDock behavioral:** renders transport controls (Back, Play, Fwd), Play button calls onTogglePlay, Settings button calls onOpenSettings, Repeat button calls onToggleRepeat and reflects active state, disabled when canPlay is false.

**WatchSettingsSheet behavioral:** renders when open, does not render when closed, Escape calls onClose, backdrop click calls onClose, shows file info from props, Help button opens help content and Back returns.

**WatchDock hold-to-play:** short tap Back calls onStepBackward (not directional play), short tap Fwd calls onStepForward, hold Back past threshold calls onStepBackward (nudge) + onStartDirectionalPlayback(-1), hold Fwd past threshold calls onStepForward (nudge) + onStartDirectionalPlayback(1), release after hold calls onStopDirectionalPlayback, rerender during active hold does NOT cancel the gesture (regression: React re-render with new callback identities no longer kills the hold via effect cleanup).

**WatchTimeline behavioral:** renders time labels and track, uses thick review track variant, pointerDown on track calls onScrub, fill width reflects progress, thumb position reflects progress, pointerMove while captured calls onScrub with updated position, setPointerCapture failure: initial scrub + drag continuation both work via dragActive fallback.

### Shared Sheet Lifecycle Hook (7 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `use-sheet-lifecycle.test.tsx` | 7 | Mount/animate/escape/transition lifecycle shared across lab and watch (see breakdown below) |

Tests use a `SheetHarness` component that exposes hook state via data attributes.

**useSheetLifecycle:** starts unmounted when closed, mounts when opened, sets animating after reflow, unmounts after transitionend on close, calls onClose on Escape when provided, does not call onClose on Escape when not provided, lab-style usage without onClose works.

## Frontend Smoke Test

Manual verification checklist for the interactive page (`lab/index.html`). Run after any changes to `lab/` code.

### Setup
```bash
npm run dev
# Open http://localhost:5173/lab/
```

### Checklist

| # | Test | Expected |
|---|------|----------|
| 1 | Page loads | C60 renders with atoms and bonds visible |
| 2 | Switch structure | New structure loads, old one clears completely |
| 3 | Atom mode: left-drag on atom | Highlight (cool blue), spring line shows, atom follows cursor |
| 3a | Hold pointer still during drag | Force line endpoint keeps updating as atom moves under spring tension (per-frame reprojection) |
| 4 | Release drag | Atom retains momentum, structure vibrates naturally |
| 5 | Ctrl+click on atom (any mode) | Molecule rotates, spring line visible |
| 6 | Right-drag | Camera orbits around structure |
| 7 | Scroll wheel | Camera zooms in/out |
| 8 | Reset View (in Settings sheet Scene section) | Camera returns to default front view |
| 9 | Help drill-in | Tap Help in settings → help page appears. Tap Back → returns to settings. |
| 10 | Theme toggle | Dark/light switch — all UI elements adapt |
| 11 | Settings sheet | Sliders in Simulation/Interaction sections adjust drag strength, rotation strength, and damping in real-time |
| 11a | Damping at 0 | After drag/rotate, molecule vibrates indefinitely (NVE) |
| 11b | Damping raised | Vibration decays visibly; at max, motion stops almost instantly |
| 12 | Large structure (C720) | Loads without crash, interaction works at reduced FPS |
| 13 | XYZ axes indicator | Visible in corner, rotates with camera |
| 14 | Hint text | Fades on first atom interaction |
| 15 | Move mode: hover atom | Full bonded group highlights (not just the hovered atom) |
| 15a | Move mode: drag atom | Entire molecule translates, group highlight + blue force line |
| 15b | Release in Move mode, damping=0 | Molecule coasts (approximately NVE) |
| 15c | Release in Move mode, damping>0 | Motion decays visibly |
| 16 | Rotate mode: hover atom | Full bonded group highlights |
| 16a | Rotate mode: 1-finger drag on atom (mobile) | Molecule rotates (torque), group highlight |
| 17 | Switch mode during idle | No side effects, next interaction uses new mode |
| 18 | Ctrl+click in Atom/Move mode | Rotates molecule (shortcut override) |
| 19 | Move mode on C60 vs C720 | Both respond without being sluggish or explosive (subjective) |
| 20 | Mobile: 2-finger gesture in any mode | Always camera pinch/pan |
| 21 | Mobile: add 2nd finger during interaction | Active interaction cancelled, camera takes over |
| 22 | Load new structure while in Move mode | Mode persists, new structure responds to Move |
| 23 | Move mode: drag atom on intact C60 | Entire molecule translates (all atoms in one component) |
| 24 | Atom mode: pull atom until bond breaks, then Move mode on main fragment | Only the connected fragment translates, detached atoms stay |
| 25 | Rotate mode on intact structure | Molecule rotates normally |
| 26 | Rotate mode after fragmenting structure | Only the picked fragment rotates |
| 27 | Reset after fragmentation, Move mode | Full molecule translates again (components reset with bonds) |
| 28 | Atom mode: push two fragments close until bonds form, then Move mode | Merged fragment moves as one patch |
| 29 | Move mode: vigorous drag causing bonds to break mid-interaction | Detached atoms stop following after next bond refresh (~0.08s). Expected behavior |
| 30 | Move/Rotate near bond cutoff distance | Patch scope may change as bonds flicker. Expected behavior with cutoff-only detection (no hysteresis) |
| 31 | Add Molecule to empty scene | Preview appears centered in current viewport, Place creates real molecule |
| 32 | Add second molecule | Preview appears tangent to existing molecule, adjacent in current view |
| 33 | Drag preview, then Place | Preview becomes real atoms, simulation resumes |
| 34 | Cancel during placement | Preview removed, scene unchanged |
| 35 | Move mode: drag molecule A into molecule B | Collision occurs, Tersoff forces engage |
| 36 | Move mode on molecule A in 2-molecule scene | Only A's component translates (component-aware) |
| 37 | Clear playground | All molecules removed, scene empty |
| 38 | Camera during placement | Right-drag orbits, scroll zooms. Preview reprojects after camera gesture |
| 39 | Esc during placement (desktop) | Placement cancelled |
| 40 | Add molecule with rotated camera | Preview tangent direction adapts to camera orientation |
| 41 | Start preview drag, add 2nd finger for camera | Preview drag cancels cleanly, camera takes over, no state leaks |
| 42 | Clear playground, then orbit camera | Camera orbits around origin (0,0,0), not stale scene center |
| 43 | Clear playground, then Add Molecule | Preview appears centered in viewport at molecule-appropriate depth |
| 44 | Clear + Add + Atom drag | First molecule after Clear responds to all interaction modes correctly |
| 45 | Switch structure during placement | Select different structure in chooser sheet while preview is active — old preview replaced cleanly, new preview appears |
| 46a | Place confirms preview | Tap dock Add (shows "Place") while preview active — preview commits to scene, dock exits placement mode |
| 46b | Chooser replaces preview | Open chooser and select a different structure while preview is active — old preview replaced, new preview appears |
| 47 | Rapid structure switching in chooser sheet | Click two different structures quickly — only the last-clicked preview appears, first is discarded |
| 48 | Stale load failure during switching | If first structure fails to load after second was selected, error does not corrupt the active preview |
| 49 | Clear during pending preview load | Click Add Molecule, select structure, then Clear before preview appears — no preview appears after Clear |
| 50 | Escape during pending preview load (desktop) | Press Escape while structure is loading — load is cancelled, no preview appears |
| 51 | Preview drag on elongated structure (e.g., CNT) near bond region | Drag starts predictably; nearby atom is preferred when visually intended (CONFIG.picker.previewAtomPreference threshold) |

#### Placement Camera Framing
- [ ] Add a molecule to an existing scene → camera should NOT jump, preview and scene both visible
- [ ] If preview already fits in view → camera should not move at all
- [ ] Drag preview toward edge → camera smoothly makes room (target shift preferred over zoom-out)
- [ ] Drag preview past canvas boundary → drag continues (pointer capture), preview follows cursor
- [ ] Release drag → preview stays in place, camera settles smoothly
- [ ] Click Place → camera does NOT snap to new molecule (Policy A: no focus retarget on commit)
- [ ] After Place, click Center → camera animates to newly placed molecule (explicit focus works)

#### Review Mode UI Lock
- [ ] Enter review mode by scrubbing timeline → dock Add, Atom/Move/Rotate, Pause/Resume appear visually disabled
- [ ] Desktop: hover over disabled Add → tooltip shows "Review mode is read-only..."
- [ ] Desktop: hover over disabled Atom/Move/Rotate segment → each shows tooltip
- [ ] Mobile: tap disabled Add → transient status hint appears explaining review exits
- [ ] Mobile: tap disabled mode segment → same status hint
- [ ] Settings sheet: Add Molecule and Clear appear disabled with hint on hover/tap
- [ ] Structure chooser (if open): rows appear locked, click shows hint instead of placing
- [ ] Click Live → exit review, all controls re-enabled immediately
- [ ] Click Restart → exit review, controls re-enabled, simulation resumes from scrub point

#### Dock Stability
- [ ] Toggle Pause ↔ Resume repeatedly → Add, mode selector, and Settings do not shift
- [ ] Atom / Move / Rotate spacing looks identical in live and review modes

#### Bonded Group Architecture
- [ ] Bonded-group panel visible and expanded by default in live mode
- [ ] Bonded-group panel visible in review mode with historical topology
- [ ] Hover preview works in both live and review modes
- [ ] Persistent click-to-select is hidden (canTrackBondedGroupHighlight: false)
- [ ] Color editing, Center, Follow work in both live and review
- [ ] Theme change preserves authored atom color overrides
- [ ] Structure append preserves authored atom color overrides

| 52 | Speed 0.5x | Motion visibly slower |
| 53 | Speed 2x | Visibly faster, stable |
| 54 | Max mode on C720 | Tracks live max |
| 55 | Pause | Physics freezes, camera works |
| 56 | Resume | No catch-up burst |
| 57 | Tab switch/return | No burst |
| 58 | Speed change mid-interaction | No position jump |
| 59 | maxSpeed < 0.5x heavy scene | Fixed buttons disabled, Max still works |
| 60 | Add molecule while at 4x speed | Warm-up re-entered, speed caps at 1x briefly, buttons update |
| 61 | Clear heavy scene, add small molecule | No stale overload state, speed adapts to new workload |
| 62 | Sustained overload → scene lightens | maxSpeed recovers smoothly over ~1s |
| 63 | Warm-up: fixed speed buttons | Disabled/dimmed during warm-up, Max still enabled |
| 64 | Warm-up: Estimating status | Shows "Estimating..." after clear + add or molecule append |
| 65 | Pause/resume visual update | Screen updates immediately on toggle (forced render) |
| 66 | Placement enter/exit visual update | Screen updates immediately (forced render) |
| 67 | Mobile: tap status area | Diagnostics (ms/fps) expand for ~5s, then collapse |
| 68 | Drag atom far from molecule | Simulation stays responsive (no sparse-domain slowdown) |
| 69 | Fragment molecule into scattered atoms | No FPS drop from spread atoms |
| 70 | Two molecules placed far apart | Smooth interaction, no stutter |
| 71 | Move molecules together and apart repeatedly | No stutter or memory growth |
| 72 | Contain mode: fling atom outward | Atom bounces back from invisible boundary, stays in scene |
| 73 | Remove mode: fling atom outward | Atom deleted when it crosses boundary, atom count decreases |
| 74 | Remove mode: fling fragment (bonded pair) | Both atoms in fragment deleted when past boundary |
| 75 | Atom count in Settings sheet | Placed row shows historical total. Active row appears after boundary removal showing e.g. "57 (3 removed)" |
| 76 | Add molecule after Remove empties scene | Wall resets, new molecule gets fresh boundary |
| 77 | Switch Contain → Remove during flight | Atom that was bouncing back now flies freely and gets deleted |
| 78 | Boundary toggle in Settings sheet (Boundary section) | Contain/Remove buttons toggle correctly, visual feedback |

**Transaction rollback verification:**

- **Automated physics tests:** open `lab/test-rollback.html` in a browser (requires serving from repo root). Tests physics append/rollback/clear/invariants/components directly against the real `PhysicsEngine` class. Does NOT test the full `commitMolecule` orchestration path (renderer + session state coordination).
- **Manual commit-path testing:** set `CONFIG.debug.failAfterPhysicsAppend = true` or `CONFIG.debug.failRendererAppend = true` in config.ts, then place a molecule via the UI. Verify: placement fails gracefully, no orphan meshes, physics atom count restored, scene molecule list unchanged. Set `CONFIG.debug.assertions = true` to enable post-append invariant checks inside the rollback-protected block.
- **Coverage summary:** physics-level transaction safety is automated; full commit-path rollback (physics + renderer + session) requires manual flag toggling and UI interaction. Both complement manual smoke tests for interaction flow.
- **Future milestone — full integration test harness:** automate commitMolecule transaction path (physics + renderer + session coordination), preview hit-preference threshold tests (atom-vs-bond within/outside CONFIG.picker.previewAtomPreference), and remove CDN dependency from test page. Tracked as a separate infrastructure investment.

### Manual Runtime Checks

After changes to UI controllers or main.ts composition:

| # | Check | How to verify |
|---|-------|--------------|
| A1 | Overlay exclusivity | Open settings → tap Add → settings closes, chooser opens |
| A2 | Dock placement mode | Start placement → Place/Cancel in dock, Mode hidden, Pause/Settings disabled |
| A3 | Device-mode switch | Switch between device modes (responsive emulation or window resize) → overlays close on mode change, dock/sheet layout adapts |
| A4 | Theme across all panels | Toggle theme in settings → all panels adapt |
| A5 | Sheet close transition | Close sheet → no stale `sheet-visible` class after transition |
| A6a | Canvas dismiss (desktop) | Open settings → click canvas → sheet closes, no camera interaction starts. Click FPS/hint/info → sheet stays open |
| A6b | Backdrop dismiss (phone/tablet) | Open settings on phone/tablet → tap dimmed backdrop outside dock → sheet closes |
| A7 | Dock interactive with sheet open | Open settings → tap Pause → sheet stays open, pause toggles. Tap mode seg → mode changes, sheet stays |
| A8 | Chooser Recent row | Place a molecule → tap Add → chooser opens with pinned "Recent" row at top → tap it → placement starts |
| A9 | Hint above dock | On tablet/desktop, hint text does not overlap the floating dock pill |
| A10 | Triad sizing | On desktop, axis triad is visibly larger (~140–200px). On tablet/desktop, triad is corner-anchored, not pushed up by dock |
| A11 | Placement coachmark | Tap Add → pick structure → "Tap Place to add it" appears in hint area → tap Place → coachmark disappears |
| A12 | Coachmark + overlay | During placement, open Settings → coachmark hides immediately (no fade), no generic hint text visible under sheet |
| A13 | Text Size setting | Settings → Appearance → toggle Large → all text visibly larger. Toggle Normal → text returns to baseline. Segmented indicator aligned at both sizes |
| A14 | Info card reduced | Top-left card shows only status text (no "NanoToybox" title), smaller padding |

### Mobile Camera Orbit (Phase 1A)

Test on phone and iPad after changes to triad interaction or input.ts touch handling:

| # | Check | How to verify |
|---|---|---|
| B1 | Triad visible and touchable | On phone, triad is large enough to touch confidently (96-120px). Arrows and labels are clearly visible. |
| B2 | Triad drag orbits camera | 1-finger drag on triad rotates the camera smoothly. Drag-up = camera rotates down ("dragging the world"). |
| B3 | Atom interaction preserved | 1-finger drag on atom still triggers current interaction mode (Atom/Move/Rotate). No false triad captures. |
| B4 | 2-finger unchanged | Pinch to zoom and 2-finger drag to pan still work. 2nd finger during triad drag cancels triad and hands off. |
| B5 | Coachmark timing | On first mobile session: "Drag triad to rotate view" appears after ~3s of idle. Does NOT appear if user interacts immediately, or if sheet/placement is open. |
| B6 | Triad pulse | When coachmark appears, triad brightens briefly then fades back (~600ms). Visual tie between text and control. |
| B7 | First-attempt success | A first-time user can find the triad and drag it successfully on their first try without reading help text. |
| B8 | Desktop unaffected | On desktop, right-drag still orbits via OrbitControls. Triad is smaller (desktop size). No coachmark shown. |

### Mobile Camera Orbit (Phase 1B — Background Orbit)

Test on phone and iPad after changes to background orbit or coachmark v2:

| # | Check | How to verify |
|---|---|---|
| C1 | Background miss orbits | 1-finger drag on empty space (no atom) rotates the camera. Same drag direction as triad. |
| C2 | Atom hit still wins | 1-finger drag on an atom triggers interaction (drag/move/rotate), not camera orbit. No ambiguity. |
| C3 | Background orbit cue | When background orbit starts, triad brightens. When finger lifts, triad returns to normal intensity. |
| C4 | 2nd finger cancels | During background orbit, place a second finger → orbit cancels, 2-finger zoom/pan takes over. Triad cue clears. |
| C5 | Coachmark v2 for returning users | Clear mobile-orbit-v1 but not v2 from localStorage. Reload → v2 coachmark shows: "Drag triad anytime · Drag clear background when available". Does NOT show if v1 hasn't been dismissed yet. |
| C6 | Parity check | Same 100px drag on triad and on empty space produces identical rotation (both use applyOrbitDelta). Verify on phone and iPad. No momentum difference — both paths stop immediately on finger lift. |

**Orbit parity note:** Both triad drag and background orbit use the same
`applyOrbitDelta(dx, dy)` function with `CONFIG.orbit.rotateSpeed = 0.005` rad/px.
They are guaranteed identical — same code path, same constant. OrbitControls is NOT
used for mobile 1-finger orbit; it only handles desktop right-drag and 2-finger
mobile zoom/pan. Desktop right-drag speed (`controls.rotateSpeed`) is set independently
in `renderer.ts` and is decoupled from mobile orbit speed.

### Mobile Camera Orbit (Phase 2 — Canonical View Snaps)

Test on phone and iPad after changes to axis snap, double-tap reset, or tap-intent highlight:

| # | Check | How to verify |
|---|---|---|
| D1 | Single tap snaps to nearest axis | Rotate triad to show X prominently → tap near X tip → camera animates to +X view over ~300ms |
| D2 | All 6 views reachable | Tap near each of ±X, ±Y, ±Z endpoints → camera snaps to that view. Negative tails work when visible. |
| D3 | Double-tap center resets | Double-tap the center of the triad → camera animates to default front view (0, 0, 15) |
| D4 | Tap-intent highlight | Touch and hold triad (>150ms, don't move) → nearest axis endpoint shows a white sphere highlight. Start dragging → highlight disappears. |
| D5 | Drag still works | Drag on triad orbits normally. Tap-intent highlight does not interfere with drag gesture. |
| D6 | Center home glyph | Small gray dot visible at triad center — indicates double-tap reset target. |
| D7 | Snap preserves distance | After snap, camera distance from target is the same as before snap. |
| D8 | Sub-threshold jitter = tap only | Touch triad, move < 5px, release → camera does NOT orbit during the gesture. Only snap fires on release. |
| D9 | Non-center double-tap = two snaps | Double-tap near +X tip → two snap gestures (not a reset). Only double-tap in the center zone (near home glyph) triggers reset. |

### Camera Behavior (Quaternion Orbit + Parity)

Test after changes to applyOrbitDelta, resetView, fitCamera, or desktop input routing:

| # | Check | How to verify |
|---|---|---|
| E1 | Over-the-top orbit | Drag triad upward past the north pole → camera continues smoothly over the top, no wall or snap. |
| E2 | Reset after over-the-top | After E1, call resetView (double-tap triad center) → camera returns to default front view with level horizon (up=Y). |
| E3 | fitCamera levels camera | Load a structure while camera is in a rolled orientation → fitCamera levels the camera (up=Y) and centers on structure. |
| E4 | Desktop/mobile orbit parity | On desktop, right-drag produces the same rotation direction and speed as mobile triad drag or background orbit. |
| E5 | Desktop orbit at canvas edge | Right-drag orbit, move pointer outside canvas → orbit continues (pointer capture). Release mouse → orbit ends cleanly. |
| E6 | Snap after free rotation | Orbit to an arbitrary orientation, tap axis end → snap works correctly from any starting orientation. |

### Object View Controls and Onboarding

Test after changes to CameraControls, OnboardingOverlay, or object-view controls.

#### A. Manual Behavior Checks

| # | Check | How to verify |
|---|---|---|
| F1 | Center button | Tap Center → camera frames the focused molecule (or nearest if none focused). |
| F2 | Follow button (enable) | Tap Follow → resolves a target and begins continuous tracking. Button shows active visual state. |
| F3 | Follow button (disable) | While following, tap Follow → tracking stops. Button returns to inactive state. |
| F4 | Follow with no molecules | Tap Follow on empty scene → nothing happens (follow stays off). |
| F5 | Onboarding overlay appears | On page load, after scene content loads, a welcome overlay appears centered on screen. |
| F6 | Onboarding dismisses on tap | Tap anywhere on the overlay → it animates toward the Settings button and disappears. |
| F7 | Onboarding reappears on reload | After dismissing, reload the page → overlay reappears. |
| F8 | Settings help includes Object View | Open Settings > Controls → "Object View" section lists Center and Follow. |
| F9 | Progressive coachmark: snap hint | After first orbit drag on mobile → "Tap an axis end on the triad to snap to that view" appears (once per session, idle-gated). |
| F10 | Coachmark + overlay exclusivity | Coachmark visible → open settings → coachmark dismissed immediately. |
| | **F11–F18 require `CONFIG.camera.freeLookEnabled = true` (disabled by default)** | |
| F11 | Mode toggle | When freeLookEnabled: tap mode button toggles "Free"/"Orbit". When disabled (default): no mode button renders. |
| F12 | Return to Object (Free-Look) | In Free-Look, tap Return → camera flies to last focused molecule, returns to Orbit mode. |
| F13 | Free-Look look-around | In Free-Look, drag background (mobile) or right-drag (desktop) → camera yaw/pitch in place. |
| F14 | Free-Look WASD (desktop) | In Free-Look, WASD translates camera. Keys ignored when input/button/sheet focused. |
| F15 | Free-Look R key (desktop) | In Free-Look, R levels the camera. Ignored when form control focused. |
| F16 | Free-Look Freeze | When moving in Free-Look, Freeze button (✕) appears → tap stops flight velocity. |
| F17 | Free-Look recovery: Esc | In Free-Look with nothing else open, Esc returns to Orbit. |
| F18 | Free-Look axis-snap disabled | In Free-Look, tap axis end on triad → no snap. |
| F19 | Free-Look focus-select | In Free-Look, tap/click atom → molecule marked as orbit target. No drag interaction starts. |
| F20 | Keyboard guard | In Free-Look, focus a settings slider → type WASD → camera does NOT move. |

#### B. Engineering Verification

| # | Invariant | What to check |
|---|-----------|--------------|
| G1 | Follow returns false with no molecules | `onEnableFollow()` returns false and `orbitFollowEnabled` stays false when molecule list is empty. |
| G2 | Onboarding readiness gate | `isOnboardingEligible()` requires atomCount > 0, no open sheets, no placement, no review mode. |
| G3 | Onboarding E2E suppression | Adding `?e2e=1` to the URL suppresses the onboarding overlay entirely. |
| G4 | Sink animation timing | `SINK_DURATION_MS` in OnboardingOverlay.tsx matches CSS `--onboarding-sink-duration`. |

### E2E Test Conventions

- **`gotoApp(page, baseURL, path)`** from `tests/e2e/helpers.ts` — appends `?e2e=1` for onboarding suppression. All `/lab/` navigation in non-onboarding specs must use `gotoApp()`.
- **`dismissOnboardingIfPresent(page)`** — local helper in `camera-onboarding.spec.ts` that waits for the overlay, clicks to dismiss, and waits for removal. Used by onboarding tests that need the overlay to appear first.
- **Why:** Page-lifetime onboarding blocks pointer events until dismissed. Tests that don't test onboarding need the `?e2e=1` bypass via `gotoApp()`.

### Code Review Invariants

Check during PRs that modify controller modules:

| # | Invariant | What to check |
|---|-----------|--------------|
| R1 | No duplicate listeners | Each DOM element has one event handler per event type |
| R2 | Controller destroy() complete | Every addEventListener has matching removeEventListener in destroy() |
| R3 | State ownership respected | New state writes go through the authoritative writer (see architecture.md) |
| R4 | No controller cross-imports | Controllers don't import each other — use callbacks via main.ts |
| R5 | New globals tracked | Any new window/document listener uses addGlobalListener() |
