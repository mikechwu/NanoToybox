# Project Decisions

Key strategic and technical decisions made during development, with rationale.

## D1: Analytical Tersoff for First Website (not ML)

**Decision:** Use the analytical Tersoff potential for the first website version. Defer ML surrogates.

**Rationale:** Scaling benchmarks showed analytical Tersoff handles all target scenes (60–300 atoms) at interactive frame rates. The JavaScript implementation achieves sufficient performance for the target range without requiring Wasm. ML provided no speed advantage — descriptor computation has the same O(N·neighbors²) complexity as the analytical force. ML only becomes worthwhile for >1000 atoms with a GNN that avoids explicit descriptors.

**Update:** The interactive page (`lab/`) now runs the full Tersoff potential with a C/Wasm kernel enabled by default (`config.ts` `useWasm: true`), providing ~11% speedup over JS JIT. Automatic fallback to JavaScript if Wasm fails to load. Physics runs on a dedicated Web Worker (`simulation-worker.ts`).

**Evidence:** dev_report_simdev9, dev_report_simdev10, lab/js/physics.ts

## D2: Python Reference + Numba Acceleration

**Decision:** Write the reference implementation in pure Python, accelerate with Numba JIT.

**Rationale:** Python enables rapid development and debugging. A force sign error was found and fixed in minutes during Test 1. Numba provides 250–480x speedup with minimal code changes (just `@njit` decorator), bridging the gap to C performance. The pure Python version remains the authoritative reference for validation.

**Evidence:** bottleneck_analysis.py, tersoff_fast.py benchmarks

## D3: Velocity Verlet (Euler Forbidden)

**Decision:** Use velocity Verlet for all MD. Explicit Euler is explicitly forbidden.

**Rationale:** Velocity Verlet is symplectic (no energy drift), time-reversible, and second-order accurate. Euler is non-symplectic and causes catastrophic energy growth within hundreds of steps.

## D4: Per-Atom Force Residual as ML Target

**Decision:** ML target is F_residual = F_total - F_2body (per-atom 3D vector).

**Rationale:** Compared three options (per-atom force, per-bond order, local energy). Per-atom force is simplest to train, easiest to debug, and compatible with standard GNN architectures. Non-conservative forces are acceptable for visualization use case; fallback to energy-based target if conservation is critical.

**Evidence:** res3 proposal, dev_report_simdev7

## D5: Cosine Cutoff (not Legacy Exponential)

**Decision:** Use the standard Tersoff cosine cutoff, not the exponential variant found in some implementations.

**Rationale:** Both are smooth and produce similar equilibrium structures. The cosine form is standard in literature and easier to verify. The difference is documented as a known caveat.

## D6: Multi-Minimizer Best-of-Three Strategy

**Decision:** The library CLI runs all three minimizers (SD, FIRE, SD+FIRE) and picks the best result.

**Rationale:** Different minimizers perform best for different structures. FIRE wins for CNTs, SD wins for diamond (FIRE diverges), SD+FIRE wins for graphene. Running all three and picking the lowest energy ensures the library always has the best available structure.

## D7: CNT Generation via Graphene Rolling

**Decision:** Use the chiral vector rotation + cylindrical rolling method for CNT generation.

**Rationale:** This is the standard algorithm for generating CNT coordinates from first principles. It supports any chirality (n,m) — armchair, zigzag, and chiral — from a single code path.

## D8: No Periodic Boundaries

**Decision:** All structures use free (non-periodic) boundary conditions.

**Rationale:** Simplifies the force calculation significantly (no minimum image convention, no ghost atoms). Edge effects exist for graphene but are acceptable for visualization. The website shows finite structures, not infinite crystals.

## D9: Relaxed Library Structures Required for Dynamics

**Decision:** All collision and MD simulations must use structures relaxed to Fmax < 10⁻³ eV/Å. Never use raw generator output directly.

**Rationale:** The geometry generators produce coordinates far from equilibrium (Fmax 3–7 eV/Å). In dynamics, these unrelaxed structures undergo rapid self-relaxation (shrinking/expansion) that dominates over any applied physics. For C60, the generated coordinates are 14.9 eV above the relaxed minimum with residual forces 4,763x larger than the library version. This was discovered during scaling research when collision simulations showed structures deforming before any collision occurred. The fix: load from `structures/library/` or relax with `simple_minimize()` before use.

**Evidence:** scaling_research.py v1→v3 evolution, outputs/scaling_research/results.json

## D10: Collision Placement by Surface Gap (not Center Distance)

**Decision:** Multi-structure collision scenarios are set up by computing bounding extents and placing structures with a controlled surface-to-surface gap.

**Rationale:** Naively placing structures by center-to-center distance ignores structure size and can produce overlapping atoms (initial distance < 1 Å), causing instant catastrophic repulsion. The 4x C60 scenario initially placed balls at offset 5.0 Å from origin, resulting in inter-atomic distances of 0.45 Å and PE = +1,079 eV (positive = massive repulsion). The corrected placement uses `place_for_collision()` which computes actual bounding box extents and achieves a verified surface gap of 3.0 Å with initial min distance 4.19 Å.

**Evidence:** scaling_research.py Scenario 3, collision_4xc60.xyz trajectory comparison

## D11: Dynamic Containment Boundary

**Decision:** Add a soft harmonic containment wall that scales with atom count. Two modes: Contain (bounce back) and Remove (delete escaped atoms).

**Rationale:** With free boundary conditions (D8) and the spatial hash (which handles any span efficiently), atoms flung by rotation or collision can expand to thousands of Å. While the spatial hash prevents computational blowup, the boundary provides a physically meaningful arena and prevents the user from losing atoms to infinity. The harmonic wall preserves O(dt²) energy conservation in Contain mode.

**Design:** Spherical wall centered at placement COM. Radius derived from target density (CONFIG.wall.density = 0.00005 atoms/ų) plus padding. Generous default: ~116 Å for 60 atoms, ~245 Å for 780 atoms. Wall force applied only in Contain mode; Remove mode deletes atoms past R_wall + margin with full state cleanup (force recompute, component invalidation, renderer sync).

**Evidence:** User-reported "Hardware-limited" scenario at 780 atoms with rotation was resolved by spatial hashing, but atoms still flew to infinity without containment. The boundary completes the solution.

## D12: Dock + Sheet UI Architecture

**Decision:** Replace the horizontal control strip with a responsive two-tier UI: a 4-item dock for high-frequency actions and a settings sheet with grouped sections.

**Rationale:** The old bottom strip scrolled horizontally on mobile, hiding controls. The dock provides large tap targets and no scrolling. The settings sheet organizes controls into grouped sections with drill-in navigation. One overlay at a time (settings | chooser). Placement mode swaps dock slots via CSS class.

**Update:** DockLayout, DockBar, Segmented, SettingsSheet, StructureChooser, StatusBar, FPSDisplay, and SheetOverlay are now React components (`lab/js/components/`). UI state is owned by the Zustand store (`lab/js/store/app-store.ts`). Placement mode is communicated via `placementActive` flag in the store; DockBar uses `selectDockSurface` (`store/selectors/dock.ts`) to conditionally render surface-specific controls (JSX branching, not CSS class toggling).

## D13: Controller Module Extraction

**Decision:** Extract the monolithic main.ts into focused controller modules with explicit state ownership, dependency injection, and full lifecycle teardown.

**Rationale:** The Phase 3 dock+sheet restructure created natural module boundaries. Controllers receive dependencies at construction, don't cross-import each other, and all expose destroy(). main.ts remains the composition root and runtime orchestration layer.

**Update:** `DockController`, `SettingsSheetController`, and `OverlayController` have been removed — those roles are now handled by React components. Only `PlacementController` (canvas touch listeners) and `StatusController` (hint/coachmark, hint-only) remain as class-based controllers with `destroy()` lifecycles.

## D14: Simulation Web Worker

**Decision:** Run `PhysicsEngine` on a dedicated Web Worker thread (`simulation-worker.ts`). The main thread communicates via a typed command/event protocol managed by `WorkerBridge` (`worker-bridge.ts`).

**Rationale:** Moves the O(N·neighbors²) Tersoff force computation off the main thread, preventing jank on the render/input thread. The protocol provides mutation acks with scene versioning, `requestFrame`/`frameResult` round-trip for position snapshots, and generation bumping to invalidate in-flight requests on scene clear. Automatic fallback to sync-mode physics if the worker fails or stalls (5s warning, 15s fatal).

**Evidence:** `lab/js/simulation-worker.ts`, `lab/js/worker-bridge.ts`, `src/types/worker-protocol.ts`, `lab/js/runtime/worker-lifecycle.ts`, `lab/js/runtime/snapshot-reconciler.ts`

## D15: React + Zustand for UI Chrome

**Decision:** Adopt React 19 (`createRoot`) for all UI chrome components and Zustand for shared UI state. Physics/renderer/worker state stays imperative outside the store.

**Rationale:** The imperative DOM controllers required explicit sync of every state change to the DOM. React provides declarative re-renders; Zustand provides a single, typed, subscribable state surface. Diagnostics and playback metrics are throttled to 5 Hz via the frame loop's coalesced status tick, avoiding per-frame React re-renders. Imperative callbacks from main.ts are registered into the store (`dockCallbacks`, `settingsCallbacks`, `chooserCallbacks`) so React components can invoke them without importing main.ts.

**Evidence:** `lab/js/react-root.tsx`, `lab/js/store/app-store.ts`, `lab/js/components/` (DockLayout.tsx, DockBar.tsx, Segmented.tsx, SettingsSheet.tsx, StructureChooser.tsx, StatusBar.tsx, FPSDisplay.tsx, SheetOverlay.tsx)

## D16: Interactive Triad + Mobile Camera Orbit

**Decision:** Make the XYZ axis triad interactive for mobile camera orbit. Add background orbit on empty-space touch miss. No dedicated camera mode button.

**Rationale:** Desktop users orbit via right-drag, but touch devices had no orbit gesture. The triad is the primary mobile orbit control because it is always visible and works regardless of scene density. Background orbit (1-finger on empty space) is a secondary convenience — unreliable in dense scenes where atoms fill the viewport. Both gestures use the same rotation convention (drag-up = camera rotates down). Gesture priority: triad hit > atom raycast > background orbit. Atom hit always wins — no heuristics. Three triad gesture levels: drag=orbit, tap-axis=snap-to-canonical-view (±X/±Y/±Z), double-tap-center=reset. Dynamic `controls.touches.ONE` toggle per-gesture for background orbit. `CONFIG.isTouchInteraction()` (coarse pointer + no hover) gates mobile-only behavior — stable across resize, excludes hybrid desktops.

**Evidence:** `lab/js/input.ts` (triad drag/tap/double-tap, background orbit), `lab/js/renderer.ts` (applyOrbitDelta, snapToAxis, animatedResetView, getNearestAxisEndpoint, showAxisHighlight, pulseTriad), `lab/js/config.ts` (CONFIG.orbit, isTouchInteraction), `lab/js/runtime/input-bindings.ts` (triad source wiring), `docs/testing.md` (B1-B8, C1-C6, D1-D9)

## D17: Two-Mode Camera System (Orbit + Free-Look)

**Decision:** Two-mode camera system with Orbit as default. Object View panel provides Center + Follow buttons. Free-Look is an advanced feature-gated path (`CONFIG.camera.freeLookEnabled`).

*Supersedes the original D17 design which used a mode chip, "?" help glyph, and QuickHelp card. Those are removed.*

**Default shipped UI:**

- **Orbit** (default): rotate around a focus target (pivot). Atoms are directly manipulable (drag/move/rotate). Object View panel provides Center (one-shot frame) and Follow (continuous tracking via `ensureFollowTarget` — resolve target first, enable second). No long-press discovery.
- **Onboarding:** Dual-layer system in `runtime/onboarding.ts`: (1) page-load welcome overlay shown via `subscribeOnboardingReadiness()`, page-lifetime dismissal, sink animation toward Settings; (2) coachmark system with achievement-triggered progressive hints and max-one-per-session pacing.
- **Help:** Settings > Controls drill-in only. No floating help button.

**Advanced gated path (not default):**

- **Free-Look** (when `CONFIG.camera.freeLookEnabled = true`): yaw+pitch camera rotation in place. Atoms are focus-select only. Recovery via Return to Object, Freeze, Esc, or mode toggle.

**Store is sole authority for camera mode** (`cameraMode: 'orbit' | 'freelook'`). Renderer, input, and UI are consumers only.

**Evidence:** `lab/js/components/CameraControls.tsx`, `lab/js/components/OnboardingOverlay.tsx`, `lab/js/renderer.ts` (applyFreeLookDelta, resetOrientation, setOrbitControlsForMode), `lab/js/input.ts` (mode-aware routing), `lab/js/runtime/onboarding.ts`, `lab/js/runtime/focus-runtime.ts` (ensureFollowTarget), `lab/js/store/app-store.ts` (cameraMode, orbitFollowEnabled, onboardingPhase, cameraCallbacks)

## D18: Simulation Timeline with Review and Restart

**Decision:** Implement a simulation timeline with dense review frames, dense restart frames, and sparse full checkpoints, keeping review display-only and restart physically consistent.

**Rationale:** Dense review frames at 10 Hz capture positions only, enabling smooth visual scrubbing with minimal memory overhead. Dense restart frames at 10 Hz store full force-defining state (pos+vel+bonds+config+boundary) so the simulation can resume from any point with physical consistency. Sparse full checkpoints at 1/sec serve as a fallback safety net. Review is display-only — it uses a dedicated renderer path with no physics mutation, preventing accidental state corruption during scrubbing. `RestartState` is the single authoritative contract shared by storage, main-thread restore, and worker restore, eliminating divergent state definitions. Interaction state (e.g., drag targets) is captured as metadata but NOT restored on restart, preventing ghost spring forces from stale drag targets.

## D19: Instance-Owned Physics Timing

**Decision:** Make `PhysicsEngine` own all physics timing parameters (`dtFs`, `dampingRefSteps`, `dampingRefDurationFs`) as instance state. Remove module-level `DT` and `STEPS_PER_FRAME` constants.

**Rationale:** Module-level timing constants created hidden coupling and made it impossible to vary dt at runtime. With instance-owned timing, the time-based exponential damping model preserves the physical decay rate when dt changes. Scheduler timing is derived live from `engine.getDtFs()` rather than cached constants. The worker receives timing via the protocol config and applies it via `setTimeConfig()`. `getPhysicsTiming()` derives `baseStepsPerSecond` from `baseSimRatePsPerSecond` and dt, keeping all timing relationships consistent from a single source.

## D20: Timeline Recording Policy

**Decision:** Recording is disarmed until the first direct atom interaction (drag, move, rotate, flick), preventing idle memory allocation. The policy is extracted into a dedicated module (`timeline-recording-policy.ts`), and arming is triggered by `interaction-dispatch.ts` unconditionally (not gated by `isWorkerActive`).

**Rationale:** Without a gating policy, the timeline would begin allocating frames immediately on page load even if the user never interacts, wasting memory. The policy arms recording ONLY on direct atom interactions — startDrag, startMove, startRotate, and flick commands dispatched through `interaction-dispatch.ts`. Molecule placement, pause/resume, speed changes, and physics settings changes (wall mode, drag/rotate strength, damping) explicitly do NOT arm recording. This allows users to set up complex multi-molecule scenes before history begins. Clearing the playground disarms and resets the policy. Recording reads only from reconciled physics state (single authority), ensuring frames are never captured from stale or in-flight data.

**Update:** The original implementation incorrectly armed on `startPlacement` and on several non-atom callbacks (pause, speed, physics settings). This was narrowed to atom-interaction-only arming, the method was renamed from `markUserEngaged()` to `markAtomInteractionStarted()`, and arming was moved from the `sendWorkerInteraction` callback (which was gated by `isWorkerActive`) into the dispatch function itself (unconditional). This ensures recording arms in both worker and sync/local modes.

**Evidence:** `lab/js/runtime/timeline-recording-policy.ts`, `lab/js/runtime/interaction-dispatch.ts`, `tests/unit/interaction-dispatch-arming.test.ts`, `tests/unit/store-callbacks-arming.test.ts`

## D21: Object View Panel

**Decision:** Replace the old camera chip cluster (Orbit label + "?" + ⊕) with an explicit Object View panel containing Center and Follow buttons with inline SVG icons.

**Rationale:** The old cluster relied on hidden gestures (long-press for follow, "?" glyph for help) that were not discoverable. Center and Follow are now separate visible buttons. Follow uses `ensureFollowTarget()`: resolve a valid target first, then enable tracking. If no molecules exist, follow stays off. Touch devices show secondary hint text; desktop uses title tooltips. The panel is positioned below the status block via `[data-status-root]` layout anchor with named tokens (`STATUS_TO_OBJECT_VIEW_GAP`, `OBJECT_VIEW_FALLBACK_TOP`, `SAFE_EDGE_INSET`).

**Evidence:** `lab/js/components/CameraControls.tsx`, `lab/js/components/Icons.tsx`, `lab/js/runtime/focus-runtime.ts` (ensureFollowTarget), `lab/js/runtime/overlay-layout.ts`, `tests/unit/camera-controls-render.test.tsx`, `tests/unit/focus-runtime.test.ts`

## D22: Page-Load Onboarding Overlay

**Decision:** Show a welcome overlay on each page load. Page-lifetime dismissal only (no localStorage persistence). Reappears on reload.

**Rationale:** The overlay teaches that guidance lives in Settings via a two-phase sink animation (~950ms) toward the Settings button. A reactive readiness gate (`subscribeOnboardingReadiness()`) waits for atomCount > 0 and no blockers (sheets, placement, review) before showing. The Settings button receives a highlight class during the sink animation. `?e2e=1` debug param suppresses in E2E tests (via `getDebugParam()`).

**Evidence:** `lab/js/components/OnboardingOverlay.tsx`, `lab/js/runtime/onboarding.ts` (isOnboardingEligible, subscribeOnboardingReadiness), `lab/js/store/app-store.ts` (onboardingPhase), `lab/js/config.ts` (getDebugParam), `tests/unit/onboarding-overlay.test.tsx`, `tests/e2e/camera-onboarding.spec.ts`

## D23: Inline SVG Icon System

**Decision:** Shared `Icons.tsx` with 10 inline SVG icon components used across DockBar and CameraControls.

**Rationale:** Consistent visual language with accessibility defaults (`aria-hidden`, `focusable={false}`). Icons use a 20x20 viewBox with currentColor stroke. Optional `size`, `strokeWidth`, `title`, `className` props for responsive refinement. DockBar uses Add, Check, Cancel, Pause, Resume, Settings. CameraControls uses Center, Follow, Freeze, Return.

**Evidence:** `lab/js/components/Icons.tsx`, `lab/js/components/DockBar.tsx`, `lab/js/components/CameraControls.tsx`

## D24: Mode-Aware Interaction Group Highlight

**Decision:** Highlight the full bonded group during Move and Rotate interactions, not just the picked atom. Atom mode continues to highlight a single atom. Hover preview reflects the upcoming action scope before pointer-down.

**Rationale:** Physics applies force to the full connected component in Move and Rotate modes. Highlighting only the picked atom made the interaction appear narrower than it actually was. The resolver (`interaction-highlight-runtime.ts`) maps interaction state + session mode to the correct highlight target using live `physics.componentId` / `physics.components`. The renderer has separate interaction and panel highlight channels so bonded-group panel selection is not clobbered. Both layers coexist additively — panel highlight stays visible during interaction (see D31-D33 for the composition model that superseded the earlier save/restore pattern). Review mode clears both channels.

**Evidence:** `lab/js/runtime/interaction-highlight-runtime.ts`, `lab/js/renderer.ts` (setInteractionHighlightedAtoms, clearInteractionHighlight, updateFeedback with sessionMode), `lab/js/main.ts` (resolveInteractionHighlight in frame loop), `tests/unit/interaction-highlight.test.ts`, `tests/unit/renderer-interaction-highlight.test.ts`

## D25: Placement Orientation — Camera-First Vertical-Preferred Policy

**Decision:** `chooseCameraFamily()` uses a camera-first vertical-preferred policy as the base orientation preference. It prefers `camera.up` unless the molecule's primary axis has a vertical fraction below 0.25 (`VERT_READABLE_THRESHOLD`), in which case it falls to `camera.right`.

**Rationale:** Molecules displayed upright relative to the user's viewport are the most immediately readable default. The threshold prevents degenerate near-horizontal alignments from being forced vertical — when m1 is nearly parallel to the camera's right axis, the vertical family would produce a foreshortened, unreadable orientation. If the primary axis is foreshortened in the camera plane entirely (`PROJ_WEAK`), an m2 fallback is attempted before defaulting to vertical.

**Evidence:** `lab/js/runtime/placement-solver.ts` (chooseCameraFamily, VERT_READABLE_THRESHOLD = 0.25)

## D26: Geometry-Aware Family Selection as Final Runtime Arbiter

**Decision:** `selectOrientationByGeometry()` is the final runtime arbiter for orientation family. It evaluates both candidate families (up and right) by projecting atoms under each candidate rotation and scoring projected readability (extent along the target axis). Vertical wins ties — the right family must score more than `GEOMETRY_FAMILY_SWITCH_MARGIN` (20%) higher than up to override the vertical preference.

**Rationale:** `chooseCameraFamily()` operates on the molecule's intrinsic frame axes and the camera, without seeing how the actual atom cloud appears after rotation. The geometry-aware selector closes this gap by scoring what the user will actually see. Both candidate rotations are fully built and projected before comparison, so the decision is grounded in observable readability, not axis algebra alone. The 20% margin prevents jittery family flipping when both orientations are similarly readable.

**Evidence:** `lab/js/runtime/placement-solver.ts` (selectOrientationByGeometry, GEOMETRY_FAMILY_SWITCH_MARGIN = 0.2, scoreProjectedReadability)

## D27: Perspective-Projected 2D PCA Geometry Refinement

**Decision:** After family selection, `refineOrientationFromGeometry()` applies a corrective twist around `camera.forward` using perspective-projected 2D PCA of the atom cloud. The refinement is adaptive (up to 2 convergence passes) with correction clamped to `BASE_GEOMETRY_CORRECTION` (~6.9 deg), doubled for high-anisotropy shapes (ratio > 3). Convergence exits early when residual error drops below 0.17 deg.

**Rationale:** The frame-alignment rotation places the molecule's intrinsic axis near the policy target, but residual twist can leave the visible silhouette rotated away from the intended screen-space direction. Perspective projection (not orthographic) is used so the refinement optimizes exactly what the user sees. The clamp prevents over-rotation from noisy PCA on near-circular projections. Two passes handle cases where the first correction shifts the silhouette enough to reveal a second-order error.

**Evidence:** `lab/js/runtime/placement-solver.ts` (refineOrientationFromGeometry, computeGeometryError, projected2DPCA, BASE_GEOMETRY_CORRECTION = 0.12)

## D28: Scored Regime Classification (Planarity Wins Ties)

**Decision:** `classifyFrameMode()` uses scored comparison of planarity (mid/minor eigenvalue ratio) and elongation (major/mid eigenvalue ratio). Both scores are normalized against their respective thresholds. When both exceed 1.0, the higher score wins, with planarity winning ties.

**Rationale:** The original threshold-order classification checked elongation first, causing thin sheets like graphene to misroute through the line-dominant solver when their major/mid ratio happened to exceed the elongation threshold. Scored comparison fixes this: graphene's mid/minor ratio (planarity) is much stronger than its major/mid ratio (elongation), so it correctly routes through the plane-facing solver. Planarity wins ties because thin sheets benefit more from the plane-facing solver than near-round rods benefit from the line solver.

**Evidence:** `lab/js/runtime/placement-solver.ts` (classifyFrameMode, lineScore, planeScore)

## D29: No Vertical Bias — Purely Readability-Driven Solver

**Decision:** The placement solver contains no vertical styling bias or override. Orientation is determined entirely by readability scoring (D25–D28). There is no additive score bonus, no post-hoc rotation toward vertical, and no user-facing "prefer upright" toggle.

**Rationale:** An earlier iteration applied a vertical bias to make molecules "look nicer" by tilting them upright regardless of geometry. This created incorrect orientations for molecules whose readable axis was horizontal in the camera frame (e.g., a CNT viewed from the side). The vertical preference in `chooseCameraFamily()` (D25) provides a soft default, but it is overridable by geometry scoring (D26), keeping the solver purely readability-driven.

**Evidence:** `lab/js/runtime/placement-solver.ts` (no VERTICAL_BIAS constant, no bias term in scoring)

## D30: Placement Test Suite — 3-Layer Acceptance Architecture

**Decision:** The placement solver test suite uses a 3-layer acceptance architecture: [policy conformance], [external oracle], [observable behavior].

**Rationale:** Each layer tests a different contract:
- **[policy conformance]** — proves the solver matches `chooseCameraFamily()`'s declared family for each frame mode and camera angle. These tests break if the policy rule changes, acting as a change-detection gate.
- **[external oracle]** — hand-written canonical backstop with independently computed expected orientations. These are immune to refactoring because they encode the "right answer" from first principles, not from the code's own logic.
- **[observable behavior]** — policy-independent user-facing sanity: readability (projected extent), stability (determinism across repeated calls), and plane-shape correctness. These survive policy changes as long as the user-visible result remains acceptable.

This layering ensures that a policy change triggers conformance failures (intentional), oracle tests catch regression in canonical cases, and behavior tests confirm the user experience is preserved regardless of internal refactoring.

**Evidence:** `tests/unit/placement-solver.test.ts` ([policy conformance], [external oracle], [observable behavior] describe blocks)

## D31: Two-Layer Highlight Composition

**Decision:** Two-layer highlight composition replaces single-mesh priority system. Panel and interaction highlights use separate InstancedMesh instances (renderOrder 2 and 3). The old save/restore pattern is removed — panel layer stays rendered during interaction.

**Rationale:** The single-mesh approach required saving and restoring panel highlight state around interaction highlights, creating fragile ordering dependencies and edge cases where restore could silently clobber an updated panel selection. Two independent meshes eliminate the save/restore lifecycle entirely — each layer writes to its own mesh, and the GPU composites them via renderOrder. The panel mesh (renderOrder 2) is always visible; the interaction mesh (renderOrder 3) draws on top without touching panel state.

**Evidence:** `lab/js/renderer.ts` (panel and interaction InstancedMesh instances, renderOrder 2 and 3)

## D32: Highlight Setters Are State-Only — Single Compositor

**Decision:** Highlight setters are state-only — all rendering flows through a single compositor (`_updateGroupHighlight`). This gives one rendering truth path and makes overlap computation deterministic.

**Rationale:** When setters both stored state and directly mutated mesh attributes, multiple code paths could produce highlight visuals, making it impossible to reason about what the user actually sees. Separating concerns — setters write to state arrays, a single compositor reads them and writes to both meshes — ensures every visual update goes through one code path. Overlap computation (atoms in both panel and interaction sets) happens in exactly one place, eliminating the class of bugs where two renderers disagree.

**Evidence:** `lab/js/renderer.ts` (`_updateGroupHighlight` as sole rendering path for both highlight meshes)

## D33: Overlap Atoms Rendered on Both Layers

**Decision:** Overlap atoms rendered on both layers (panelOnly + overlap on panel mesh, interactionOnly + overlap on interaction mesh). This makes "same atom in both states" a first-class visual behavior.

**Rationale:** When an atom belongs to both the panel selection and the interaction highlight, it must be visually present on both meshes so that neither layer appears to have a hole. The compositor partitions atoms into three sets: panelOnly, interactionOnly, and overlap. Overlap atoms are written to both meshes with their respective colors, ensuring that removing the interaction highlight reveals the panel highlight underneath without a flash or gap. This partition is computed from the state arrays on every compositor pass, so it is always consistent with the current selection.

**Evidence:** `lab/js/renderer.ts` (`_updateGroupHighlight` overlap set computation and dual-mesh writes)

## D34: CONFIG.groupHighlight Renamed to CONFIG.panelHighlight

**Decision:** `CONFIG.groupHighlight` renamed to `CONFIG.panelHighlight`. Interaction highlight tokens moved from hardcoded renderer values to `CONFIG.interactionHighlight`. Vocabulary now matches architecture.

**Rationale:** The old name `groupHighlight` was ambiguous — it could refer to any group-level highlight, but it only controlled the panel selection appearance. Renaming to `panelHighlight` makes the config key self-documenting for the two-layer architecture. Extracting interaction highlight parameters (color, opacity) from hardcoded values in the renderer into `CONFIG.interactionHighlight` makes both layers configurable in the same way and discoverable in the same config namespace. The vocabulary (panel vs. interaction) now matches the mesh layer names, the compositor logic, and the public API.

**Evidence:** `lab/js/config.ts` (`CONFIG.panelHighlight`, `CONFIG.interactionHighlight`)

## D35: Frame-Loop Sequencing Extracted to app/frame-runtime.ts

**Decision:** The per-frame update pipeline was extracted from main.ts into lab/js/app/frame-runtime.ts as executeFrame(). main.ts retains only RAF lifecycle (start/stop/teardown) as a thin wrapper constructing FrameRuntimeSurface.

**Rationale:** Gives frame sequencing a single testable owner. Ordering invariants (recording after reconciliation, highlights after feedback) are enforced in one place.

**Evidence:** `lab/js/app/frame-runtime.ts`, `tests/unit/frame-runtime.test.ts` (worker-mode ordering proof, review-mode gating)

## D36: Teardown Sequencing Extracted to app/app-lifecycle.ts

**Decision:** The ordered teardown sequence was extracted from main.ts into lab/js/app/app-lifecycle.ts as teardownAllSubsystems(). Reset helpers (resetSchedulerState, resetSessionState, resetEffectsGate) are also exported. main.ts constructs TeardownSurface and delegates.

**Rationale:** Makes teardown ordering testable and explicit. Fixes a Zustand camera-mode subscription leak that was discovered during extraction.

**Evidence:** `lab/js/app/app-lifecycle.ts`, `tests/unit/app-lifecycle.test.ts` (exact dependency-ordered sequence verified)

## D37: Package/Workspace Split Remains Deferred and Optional

**Decision:** Phase 3B-D (remaining interface narrowing), Phase 4 (folder reorganization), and Phase 5 (workspace assessment) are intentionally deferred. The current single-package structure with logical boundaries (main.ts → app/ → runtime/) is sufficient.

**Rationale:** Contract clarity, single-path orchestration, and test-backed lifecycle are achieved without physical package boundaries. Splitting would add build complexity without clear benefit at current scale.

**Evidence:** `docs/architecture.md` (layering documented), `tests/unit/frame-runtime.test.ts` and `tests/unit/app-lifecycle.test.ts` (orchestration boundaries guarded).

## D38: Placement Camera Framing — Pure Solver with Frozen Visible-Anchor

**Decision:** Camera framing during placement is handled by a pure camera-basis solver (`placement-camera-framing.ts`) that has no THREE/renderer/store imports. The solver works with plain `{x,y,z}` objects and uses an adaptive 5×5 target-shift search centered on the projected bbox error. A frozen "visible-anchor" set is captured at placement start so offscreen scene atoms do not inflate the framing distance. An overflow deadband (0.02 NDC) prevents threshold jitter.

**Rationale:** Placement framing is about keeping what the user was already viewing plus the preview visible — not about framing the entire scene. The pure solver enables thorough unit testing without DOM/WebGL dependencies. The adaptive search prefers target shift over zoom-out, matching the UX goal of "making room" rather than "backing away."

**Evidence:** `lab/js/runtime/placement-camera-framing.ts` (pure solver), `tests/unit/placement-camera-framing.test.ts` (20 tests including orientation independence and visible-anchor regressions), `lab/js/app/frame-runtime.ts` (frozen anchor capture + orchestration)

## D39: Placement Focus Decoupled from Commit (Policy A)

**Decision:** Placement commit does not change `lastFocusedMoleculeId` or retarget the camera. `focusNewestPlacedMolecule` was removed from `focus-runtime.ts`. Camera retargeting only happens via explicit user actions (Center / Return). First-molecule `fitCamera()` still works via `scene.ts`.

**Rationale:** Placement framing handles visibility; Center/Follow handle explicit focus. Coupling these caused a sudden camera jump on Place click. Decoupling makes focus selection and camera framing different concerns.

**Evidence:** `lab/js/runtime/scene-runtime.ts` (no focusNewestPlaced import), `lab/js/runtime/focus-runtime.ts` (function removed, module header updated), `tests/unit/focus-runtime.test.ts` (Policy A tests)

## D40: Continuous Drag with Pointer Capture and Per-Frame Reprojection

**Decision:** Preview drag uses `setPointerCapture()` so drag continues past canvas/page boundaries. Frame-runtime runs camera framing during active drag and calls `updateDragFromLatestPointer()` per frame to reproject the preview against the updated camera state. The grabbed atom stays under the cursor continuously even when the camera moves.

**Rationale:** Event-driven-only drag breaks when the camera moves between pointer events. Pointer capture is the browser-standard way to maintain drag past element boundaries. Per-frame reprojection from stored screen coordinates closes the gap between camera motion and cursor fidelity.

**Evidence:** `lab/js/placement.ts` (pointer capture, `_beginPreviewDrag`, `_endPreviewDrag`, `_reprojectDragAtScreenPoint`, `updateDragFromLatestPointer`), `tests/unit/placement-drag-lifecycle.test.ts` (7 controller-path tests including capture failure fallback)

## D41: Review Mode UI Lock — Centralized Selector with Defense-in-Depth Guards

**Decision:** Review mode (`timelineMode === 'review'`) disables live-edit actions at two layers: (1) visual lock in React components via `selectIsReviewLocked()` + `ReviewLockedControl`/`ReviewLockedListItem` wrappers, and (2) runtime callback guards via `blockIfReviewLocked()` in `ui-bindings.ts`. Locked actions: Add, mode change, Pause/Resume, Add Molecule, Clear, Structure selection. Allowed: Live, Restart, Stop & Clear.

**Rationale:** Review mode was enforced at the scene-input layer but not at the React action layer. Users could still trigger Add, mode changes, and pause through exposed dock/settings controls. Defense-in-depth ensures correctness even with stale UI state. The centralized `selectIsReviewLocked` selector prevents policy drift across surfaces. Desktop uses `ActionHint` tooltips (`REVIEW_LOCK_TOOLTIP`); mobile uses transient status hints (`REVIEW_LOCK_STATUS`) explaining the exits.

**Evidence:** `lab/js/store/selectors/review-ui-lock.ts` (selector + copy constants), `lab/js/runtime/ui-bindings.ts` (6 guarded callbacks), `lab/js/components/ReviewLockedControl.tsx` + `ReviewLockedListItem.tsx` (visual lock wrappers), `lab/js/hooks/useReviewLockedInteraction.ts` (shared behavior hook), `tests/unit/review-ui-lock-*.test.ts` + `tests/unit/dock-bar-review-lock.test.tsx` + `tests/unit/structure-chooser-review-lock.test.tsx` (35+ tests across 6 files)

## D42: Dock Slot Geometry — CSS Grid with Stable Widths

**Decision:** The dock bar uses CSS grid (`grid-template-columns: var(--dock-slot-action) 1fr var(--dock-slot-action) var(--dock-slot-action)`) instead of `flex justify-content: space-around`. Each control renders inside a named `.dock-slot` wrapper (--add, --mode, --pause, --aux). The Segmented control wraps every item in a stable `.seg-item` element with an explicit `.seg-item__content` inner node, so live and disabled/review modes produce identical flex children.

**Rationale:** `space-around` caused layout shift when Pause↔Resume toggled because the labels have different widths. Fixed-width action slots and a `1fr` mode slot eliminate content-driven rebalancing. The `.seg-item` wrapper prevents alignment differences between live mode (bare labels) and review mode (ActionHint-wrapped labels). The `.seg-item__content` node owns layout filling so the segmented control does not depend on ActionHint's internal class names.

**Evidence:** `lab/index.html` (grid-template-columns, --dock-slot-action, .seg-item, .seg-item__content), `lab/js/components/DockBar.tsx` (dock-slot wrappers), `lab/js/components/Segmented.tsx` (SegmentedItemShell), `tests/unit/dock-bar-layout-stability.test.tsx` (6 structural tests), `tests/unit/dock-bar-review-lock.test.tsx` (live/review parity test)

## D43: Display-Source-Aware Bonded Groups

**Decision:** Bonded-group projection consumes a display-source abstraction (`bonded-group-display-source.ts`) instead of reading physics directly. The runtime's `getDisplaySource()` resolves from live physics or review historical topology. Review topology is deferred (returns null) until the timeline stores historical components.

**Rationale:** The bonded-group system was live-only by architecture. Making it display-source-aware prepares for review-mode bonded-group inspection without duplicating topology logic. The abstraction allows future review topology to plug in without changing the runtime.

**Evidence:** `lab/js/runtime/bonded-group-display-source.ts`, `lab/js/runtime/bonded-group-runtime.ts` (getDisplaySource, getDisplaySourceKind), `lab/js/main.ts` (wiring with resolveBondedGroupDisplaySource)

## D44: Bonded Group Capability Policy

**Decision:** A centralized capability selector (`bonded-group-capabilities.ts`) gates bonded-group actions per mode: inspect, target, color-edit, track-highlight, simulate. Review only disables mutation (`canMutateSimulation: false`); inspection, targeting, and color editing are always enabled. Persistent tracked highlight is feature-gated off (`canTrackBondedGroupHighlight: false`). Primitive selectors derive from the full capability object for React stability.

**Rationale:** Hardcoded `timelineMode === 'review'` blocks were scattered across components and runtimes. A centralized policy makes capability changes a single-selector edit. Primitive selectors avoid React infinite-render issues with object selectors.

**Evidence:** `lab/js/store/selectors/bonded-group-capabilities.ts`, `lab/js/components/BondedGroupsPanel.tsx` (selectCanInspectBondedGroups), `lab/js/runtime/bonded-group-highlight-runtime.ts` (canInspectBondedGroupsNow)

## D45: Annotation Model for Atom Color Persistence (Option B)

**Decision:** Bonded-group color edits are global annotations, not part of timeline history (Option B). `bondedGroupColorOverrides` in the store persists across live/review mode transitions. The appearance runtime translates group-level color intent to atom-level overrides via `renderer.setAtomColorOverrides()`, which is separate from highlight overlays. Colors are not affected by scrub, restart, or review entry.

**Rationale:** Historical color state (Option A) would require extending timeline frames, restart state, and review rendering. Annotation-global colors are simpler to implement and match the UX expectation that color edits are user preferences, not simulation state. Color editing in review is gated on inspection capability (currently disabled).

**Update:** Group-level color intents (D46) now supplement per-atom overrides. The appearance runtime resolves `groupColorIntents` into per-atom overrides, filling only atoms with no existing override. Per-atom overrides remain the renderer-facing contract; group intents are a higher-level annotation layer.

**Evidence:** `lab/js/store/app-store.ts` (AtomColorOverrideMap, bondedGroupColorOverrides), `lab/js/runtime/bonded-group-appearance-runtime.ts`, `lab/js/renderer.ts` (setAtomColorOverrides, _applyAtomColorOverrides), `tests/unit/bonded-group-prefeature.test.ts` (persistence semantics)

## D46: Group Color Intents Over Per-Atom-Only Overrides

**Decision:** Store group-level color intents (`groupColorIntents: Map<string, string>`) that survive topology changes and propagate to uncolored atoms. Intents fill atoms with NO existing override, preserving multi-color after group merges.

**Rationale:** Per-atom-index-only overrides broke on topology changes: when groups merged, newly joined atoms did not inherit the group's color. Group-level intents are resolved by the appearance runtime on each frame, so new atoms entering a group pick up the intent color automatically. Atoms that already carry a per-atom override are left untouched, preserving intentional multi-color within a merged group.

## D47: Material White for InstancedMesh Color Overrides

**Decision:** Set the atom InstancedMesh material to white (`0xffffff`) when color overrides are active; restore the original dark material color on clear.

**Rationale:** `InstancedMesh.setColorAt()` multiplies the per-instance color with the material's base color. With the default dark atom material (`0x444444`), all override colors appeared nearly black regardless of the chosen hue. White is the neutral element for multiplication, so override colors render at their intended value.

## D48: Perceptual HSL Lift for Override Colors

**Decision:** Apply perceptual saturation and lightness floors (from CONFIG) to override colors before passing them to `setColorAt()`.

**Rationale:** Small shaded spheres under strong directional lighting compress hue differences — pale or desaturated colors become indistinguishable. The HSL lift ensures override colors remain visually distinct on 3D-lit geometry without requiring users to manually pick high-saturation values.

## D49: Portal Popover for Color Editor

**Decision:** Render the color swatch popover via `createPortal(document.body)` with a transparent backdrop for click-outside-to-close.

**Rationale:** The bonded-groups panel lives inside a scrollable container with `overflow-y: auto`, which clipped the popover. Portaling to `document.body` escapes all ancestor overflow/stacking contexts. The transparent backdrop provides a standard click-outside dismiss without requiring global event listeners or focus-trap complexity.

## D50: Hide Persistent Bonded-Group Highlight (Keep Hover)

**Decision:** Feature-gate persistent tracked highlight off via `canTrackBondedGroupHighlight: false` while keeping hover preview active. Store fields, runtime methods, and CSS retained for future re-enablement.

**Rationale:** Persistent highlight overlaps visually with authored color overrides, creating confusion. Hover preview provides sufficient inspection feedback. The hide-first approach is lowest-risk — the runtime self-heals stale tracked state via `clearTrackedIfFeatureDisabled()`, and the UI becomes inert for selection while remaining fully interactive for color editing, Center, and Follow.

## D51: Unified Popover Layout (CSS-Only Responsive)

**Superseded by D53.** The CSS grid approach was replaced by derived honeycomb geometry (`computeHexGeometry`).

**Decision:** Replace hex-ring popover with primary (default) + CSS grid (presets). Same JSX on all platforms — mobile 3×2, desktop 6×1 via `@media` breakpoint. No platform-specific JSX branches.

**Rationale:** Simpler to maintain. Layout changes are CSS-only. Palette changes require editing data array only.

## D52: Panel Expanded by Default with User Preference Preservation

**Decision:** `bondedGroupsExpanded` defaults to `true`. `resetTransientState` does NOT reset it — user's collapse/expand choice survives scene reloads and mode transitions. `bondedSmallGroupsExpanded` still resets because it is data-dependent.

**Rationale:** "Default open" should mean initial state, not always-reopen. User intent wins after first interaction.

## D53: Derived Honeycomb Geometry (Single Source of Truth)

**Decision:** `computeHexGeometry()` derives ring radius and container size from swatch count, diameter, active scale, and minimum gap. All layout constants (`SWATCH_DIAMETER`, `ACTIVE_SCALE`, `RING_GAP`) live in one place. Adding/removing palette entries auto-adjusts geometry without editing CSS or position constants.

**Rationale:** The previous fixed-size hex container (80px with 36% radius) only worked for exactly 6 presets at 20px. Any change to palette size, swatch size, or scale broke the layout silently. Deriving geometry from a formula guarantees non-overlapping swatches at any scale.

## D54: Timeline Bar — Invariant 2-Column Layout with Vertical Mode Rail

**Decision:** The timeline bar uses an invariant 2-column layout with a vertical mode rail. Track width is geometrically constant across all modes. Mode switching is secondary chrome; scrubbing is the primary interaction.

**Rationale:** Earlier iterations restructured the timeline bar's layout when switching modes, causing visual jank and making the scrub track a moving target. A geometrically stable track — same width, same position in every mode — ensures the user's muscle memory for scrubbing is never disrupted. Mode switching is a less frequent action and belongs in a secondary vertical rail rather than competing for horizontal space with the scrub track.

**Key design choices:**

- **Off/Ready modes** use a simple label (no segmented chrome). The mode rail shows only text status, avoiding unnecessary interactive controls when the timeline is inactive.
- **Live/Review modes** use a bidirectional vertical switch. The vertical orientation keeps the rail narrow and spatially distinct from the horizontal scrub track.
- **All layout dimensions centralized as CSS variables.** Track width, rail width, gaps, and padding are defined once and referenced everywhere, eliminating magic numbers and making responsive adjustments a single-variable edit.
- **Lane skeleton is identical in every mode** (time + overlay-zone + track + action-zone). The four zones always exist in the DOM regardless of mode; their contents change but their geometry does not.

**Module split:** `TimelineBar.tsx` is the composition layer that assembles the bar from three focused helper modules. This keeps the top-level component declarative (layout + mode branching) while isolating scrub logic, mode-rail rendering, and track visualization into independently testable units.

## D55: Timeline Hints — Shared ActionHint with anchorClassName for Layout-Aware Wrapping

**Decision:** Timeline hints use the shared `ActionHint` component with `anchorClassName` for layout-aware wrapping.

**Rationale:** `ActionHint` wrappers insert a `<span>` that can break flex/absolute layout. `anchorClassName` lets the wrapper carry the parent's layout contract (flex for mode switch segments, absolute for overlay controls).

**Key choices:**

- **Hint text centralized in `timeline-hints.ts`.** All hint copy lives in one module, making it easy to audit and update without touching component JSX.
- **Desktop/keyboard only.** Touch devices hide hints via CSS — timeline controls are too compact for tooltip chrome on small viewports.
- **Restart and start overlay positioning split between anchor (wrapper) and button (visual).** The anchor `<span>` owns absolute positioning so the inner button can remain a simple visual element without layout responsibilities.
- **Unconditional confirmation for clear icon.** The clear action always confirms — no conditional gating — because timeline data loss is irreversible.
- **Hint is additive discoverability, not primary guidance.** Hints supplement spatial affordance and direct manipulation; they are not the primary way users learn the timeline controls.

## D56: Shared History Modules Extracted Before watch/ Implementation

**Decision:** Extract shared pure modules to `src/history/` before building the `watch/` app, rather than duplicating or creating import coupling between apps.

**Rationale:** The `watch/` app needs v1 file types, validation, connected-component computation, and bonded-group projection that were previously private to `lab/` modules. Duplication would create divergent logic; direct cross-app imports would create coupling problems.

**Key choices:**

- **Types + validation + detection in `src/history/history-file-v1.ts`** — single source of truth for the wire format.
- **Connected-components in `src/history/connected-components.ts`** — used by both lab simulation-timeline and watch bonded-groups.
- **Bonded-group projection in `src/history/bonded-group-projection.ts`** — pure logic; lab and watch each have thin adapters.
- **Validator is fully shape-safe:** structural guards before semantic checks, safe prev-tracking for monotonicity, bond endpoint validation.
- **Watch uses plain TS + DOM (no React/Zustand for v1)**, separated playback sampling channels (now used by Round 6 trajectory interpolation).

## D57: Watch v1 Uses Exact Recorded Frames with Separated Sampling Channels

**Decision:** v1 watch playback uses exact recorded frames with 4 independent sampling methods on `WatchPlaybackModel` instead of one monolithic `getDisplayFrameAtTime`.

**Rationale:** v1 does not implement interpolation, but the architecture must leave room for it. Position sampling may later become interpolated while topology/config/boundary remain stepwise. Separating the channels now avoids a breaking refactor when interpolation is added — each channel can independently switch from stepwise to interpolated without affecting the others.

**Update (Round 6):** Position interpolation is now implemented via the trajectory interpolation runtime (`watch-trajectory-interpolation.ts`). The separated-channel architecture proved correct — only positions are interpolated; topology, config, and boundary remain discrete at-or-before. The playback model's sampling channels are unchanged; interpolation runs in the controller's unified pipeline (`applyReviewFrameAtTime`) between the playback model and the renderer.

## D58: Watch Controller Owns RAF Clock and Renderer Frame Application

**Decision:** The watch-controller.ts owns both the playback timing (RAF loop) and pushes frames into the renderer. WatchCanvas.tsx owns only renderer create/destroy lifecycle.

**Rationale:** Splitting frame application between controller and canvas would create two owners of render timing, recreating the orchestration ambiguity from the old imperative main.ts. Keeping both in the controller keeps the RAF callback self-contained.

## D59: Transactional File Open with Rollback

**Decision:** openFile() prepares new file data non-destructively (Phase 1), then commits atomically (Phase 2) with rollback on failure. Bad replacement files keep the current document visible.

**Rationale:** Document-viewer UX expects that opening a bad file does not destroy the current view. The prepare/commit/rollback pattern matches this expectation.

## D60: Canonical x1 Playback Rate from Shared CONFIG, Not Normalized to File Duration

**Decision:** Watch playback advances at CONFIG.playback.baseSimRatePsPerSecond (0.12 ps/s), the same rate as lab review mode. Not normalized to file length.

**Rationale:** Normalized playback (fit any file into 10 seconds) makes long files play faster and short files play slower — the opposite of expected behavior. Canonical rate makes playback speed independent of file length.

## D61: Stable atomIds for Color Assignment (Not Dense Slot Indices)

**Decision:** Watch uses stable `atomId` identifiers for color assignments because history file frames can reorder atoms. Per-frame projection maps atomIds to current dense slots before passing to the renderer.

**Rationale:** Dense slot indices are ephemeral — they depend on the atom ordering within a single frame, which is not guaranteed to be stable across frames in history files. If color assignments were keyed to slot indices, an atom could silently change color when its slot position shifted between frames. Stable atomIds provide identity continuity across the full trajectory. The per-frame projection step translates from the identity domain (atomIds) to the rendering domain (dense slots) so the renderer can continue to use compact typed arrays without caring about identity semantics.

**UPDATE 2026-04-17:** The same stable-id discipline now governs the Watch→Lab handoff wire format (see D124–D128). `WatchLabColorAssignment` is a stable-id quartet `{ id, atomIds[], colorHex, sourceGroupId }` — no dense indices cross the wire. On the Lab side, hydrate re-indexes Watch atomIds → display slot (via `seed.atoms[i].id`) → Lab atomId (via the tracker's `assignedIds[slot]`); atoms whose full resolution chain fails are dropped. This extends the D61 invariant across the app boundary: identity crosses; slot indices never do.

## D62: Shared Design System in src/ui/

**Decision:** Shared design system extracted to `src/ui/` — both lab and watch import the same dock-shell, sheet-shell, segmented, and timeline-track CSS. Apps keep only app-specific overrides (e.g., grid column counts).

**Rationale:** Before extraction, lab and watch had duplicated or divergent copies of the same UI primitives. Centralizing in `src/ui/` ensures visual consistency between apps and eliminates the maintenance burden of keeping two copies in sync. App-specific overrides are scoped to each app's own stylesheet, keeping the shared layer generic and the app layer minimal.

## D63: Unified Playback Direction Model (_playDirection as Sole Source of Truth)

**Decision:** `_playDirection` (0 | 1 | -1) is the sole source of truth for playback state. There is no separate `_playing` boolean. Forward = 1, reverse = -1, paused = 0.

**Rationale:** A two-variable model (`_playing` + `_direction`) creates an entire class of invalid states: `_playing = true` with `_direction = 0`, `_playing = false` with `_direction = 1`, and so on. Each combination must be handled or guarded against. A single three-valued enum eliminates these invalid states by construction. Every consumer checks one variable, and the meaning is unambiguous.

## D64: Hold-to-Play Uses Ref-Based Callbacks to Prevent Gesture Death on Re-Render

**Decision:** Hold-to-play uses ref-based callbacks (`useRef` + `useCallback`) to prevent React re-render from killing active gestures. Global fallback listeners (`pointerup`, `blur`, `visibilitychange`) ensure release is always detected.

**Rationale:** React re-renders during a pointer-down gesture can unmount or replace the element the gesture started on, silently dropping the `pointerup` event. Ref-based callbacks keep the handler identity stable across re-renders, so the gesture survives any state-driven re-render that occurs while the user is holding. The global fallback listeners cover edge cases where the pointer leaves the browser window, the tab loses focus, or the page is backgrounded — all of which would otherwise leave playback stuck in the "playing" state with no way to stop.

## D65: Pointer Capture Is Optional (try/catch) in Dock and Timeline

**Decision:** Pointer capture is wrapped in try/catch in both the dock and timeline interaction handlers. When capture is unavailable, interaction continues via local state fallback.

**Rationale:** `setPointerCapture()` can throw in several real-world situations: the pointer ID may be stale, the element may have been removed from the DOM, or the browser may not support capture on touch events. Treating capture as a hard requirement would break interaction entirely in these cases. The try/catch pattern degrades gracefully — capture provides smoother drag tracking when available, but local `pointermove`/`pointerup` listeners still work without it.

## D66: _applyAtomColorOverrides Uses _getDisplayedAtomCount() (Review-Aware)

**Decision:** Renderer `_applyAtomColorOverrides` uses `_getDisplayedAtomCount()` instead of `_atomCount` to determine how many atoms to apply color overrides to.

**Rationale:** `_atomCount` reflects the live simulation atom count, which can differ from the number of atoms currently displayed during review mode (where a historical frame is shown). Using `_getDisplayedAtomCount()` ensures color overrides are applied to exactly the atoms visible on screen, fixing incorrect or missing color rendering when watching historical frames with different atom counts than the current live state.

## D67: Bottom-Region Shell Is Positioning-Only (No Paint)

**Decision:** The bottom-region shell (`.dock-region` / `.bottom-region`) is a positioning-only container with no background, border, or shadow. The dock itself is the painted pill surface.

**Rationale:** This matches lab's `.dock-region` architecture, where the region element exists solely to position its child within the viewport layout (e.g., fixed bottom, centered, safe-area insets). Painting belongs to the dock pill — it owns its own background, border-radius, and shadow. Splitting positioning from painting means the region can be reused for different dock styles or swapped between apps without carrying visual baggage. It also avoids double-painting artifacts (region background showing through dock border-radius corners).

## D68: Smooth Playback Defaults to ON

**Decision:** `_smoothPlayback` defaults to `true` in `createWatchSettings()`. Linear interpolation is the default mode (`_interpolationMode = 'linear'`).

**Rationale:** Smooth playback produces visibly better motion between recorded frames with negligible cost (linear interpolation is a single lerp per component). Defaulting to on means first-time users see the best available visual quality immediately. The default mode is linear because it is the only stable strategy (see D69). Users who prefer exact recorded frames can disable smooth playback in settings.

**Evidence:** `watch/js/watch-settings.ts` (`_smoothPlayback = true`, `_interpolationMode: WatchInterpolationMode = 'linear'`)

## D69: Linear Stable, Hermite + Catmull-Rom Experimental (metadata.stability)

**Decision:** Each interpolation strategy declares a `stability` field in its metadata: `'stable'` for Linear, `'experimental'` for Hermite (velocity-based) and Catmull-Rom. The UI can filter or annotate methods by stability.

**Rationale:** Linear interpolation is unconditionally safe — it always succeeds, never overshoots, and has no data requirements beyond two adjacent frames. Hermite requires aligned velocity data and can produce overshoot if velocities are noisy. Catmull-Rom requires a valid 4-frame window and can overshoot away from knots. Marking these as experimental allows the UI to warn users and prevents accidental promotion of methods that may produce visual artifacts in edge cases.

**Evidence:** `watch/js/watch-trajectory-interpolation.ts` (`LinearStrategy.metadata.stability: 'stable'`, `HermiteStrategy.metadata.stability: 'experimental'`, `CatmullRomStrategy.metadata.stability: 'experimental'`)

## D70: Strategy Registry Pattern (Map + InterpolationStrategy Interface)

**Decision:** Interpolation methods are registered in a `Map<InterpolationMethodId, InterpolationStrategy>` keyed by string ID. New methods plug in by implementing the `InterpolationStrategy` interface (metadata + `run()`) and calling `registerStrategy()`. The controller and UI do not need to change when a strategy is added.

**Rationale:** An if/else or switch chain would require editing the resolution loop for every new method, creating coupling between method implementation and orchestration. The registry pattern inverts this: the resolution loop is closed to modification — it reads strategy metadata to decide what inputs to prepare (velocities, 4-frame window), calls `run()`, and handles decline/fallback generically. Dev-only or research strategies can register with arbitrary string IDs without widening the productized `WatchInterpolationMode` union.

**Evidence:** `watch/js/watch-trajectory-interpolation.ts` (`registry: Map<InterpolationMethodId, InterpolationStrategy>`, `registerStrategy()`, `unregisterStrategy()`, `InterpolationStrategy` interface)

## D71: Capability Layer Precomputed at Import Time

**Decision:** `InterpolationCapability` (per-bracket, per-window, per-endpoint flags and reason codes) is computed once at file import in `computeInterpolationCapability()` and stored on `LoadedFullHistory`. The interpolation runtime reads these flags on the hot path via typed-array indexing — no per-frame recomputation.

**Rationale:** Capability determination involves cross-frame comparisons (atom count parity, atomId equality, velocity plausibility, 4-frame window consistency) that are invariant for a given file. Recomputing per frame would waste cycles on the hot path. Precomputing at import and storing as `Uint8Array` flags (`bracketSafe`, `hermiteSafe`, `window4Safe`) gives O(1) lookup during playback. Diagnostic reason arrays (`bracketReason`, `velocityReason`, `window4Reason`) are regular arrays on the cold path for UI messaging.

**Evidence:** `watch/js/full-history-import.ts` (`computeInterpolationCapability()`, `InterpolationCapability` interface, typed-array flags on `LoadedFullHistory`)

## D72: Unified Render Pipeline — Single applyReviewFrameAtTime() Helper

**Decision:** All render entry points in the watch controller (RAF tick, scrub, step, initial load, rollback, renderer reattach) route through a single `applyReviewFrameAtTime()` helper. This helper is the only direct caller of `interpolation.resolve()` and `renderer.updateReviewFrame()`. Enforced by a source-level meta-test that greps the controller source (with comments stripped) and asserts exactly one call site for each.

**Rationale:** Multiple call sites for resolve or updateReviewFrame would allow them to diverge (different arguments, missing steps, inconsistent ordering). A single helper guarantees that every rendered frame goes through the same sequence: interpolation resolve, topology lookup, renderer update, appearance sync, analysis update, highlight application. The meta-test prevents regression — adding a second direct call to either function will fail the test.

**Evidence:** `watch/js/watch-controller.ts` (`applyReviewFrameAtTime()` — sole caller), `tests/unit/watch-round6-interpolation.test.ts` (`'Controller unified render pipeline'` describe block — source grep meta-tests)

## D73: Follow Excluded from Render Helper (Rate-Based Easing)

**Decision:** Camera follow (`viewService.updateFollow(dtMs, renderer)`) is called in the RAF tick loop AFTER `applyReviewFrameAtTime()` and BEFORE the final `renderer.render()`, but NOT inside the render helper itself.

**Rationale:** `Renderer.updateOrbitFollow()` uses frame-rate-independent exponential easing (`1 - Math.exp(-8 * (dtMs / 1000))`). If follow were inside the render helper, scrub and load paths would call it with `dtMs = 0`, producing a blend factor of zero — a no-op that would make follow appear broken on non-RAF paths. Keeping follow in the RAF tick ensures it always receives real elapsed time. The render helper's `render` flag (true for scrub/load/rollback, false for RAF tick) cleanly separates the two concerns: the helper owns frame data, the tick owns camera animation.

**Evidence:** `watch/js/watch-controller.ts` (RAF tick: `applyReviewFrameAtTime(…, { render: false })` then `viewService.updateFollow(dtMs, renderer)` then `renderer.render()`), `lab/js/renderer.ts` (`updateOrbitFollow` — `Math.exp(-8 * (dtMs / 1000))` easing)

## D74: Conservative At-or-Before Fallback Policy

**Decision:** When the interpolation runtime cannot interpolate (smoothPlayback disabled, boundary degeneracy, non-interpolatable bracket, strategy decline), it falls back to the at-or-before frame — never the nearest frame.

**Rationale:** "Nearest" lookup can return a future frame, violating temporal monotonicity: if the user scrubs forward past a boundary, the displayed frame could jump backward to the nearest neighbor behind. At-or-before guarantees that the displayed frame's timestamp is always less than or equal to the requested time, preserving forward-only temporal progression. This is consistent with the binary search policy (`bsearchAtOrBefore`) and the bracket lookup, which both use `<=` as the match criterion.

**Evidence:** `watch/js/watch-trajectory-interpolation.ts` (`bsearchAtOrBefore()` — `frames[lo].timePs <= timePs`, `atOrBeforeReference()` used on all fallback paths), `tests/unit/watch-round6-interpolation.test.ts` (`'Conservative fallback policy (at-or-before)'` describe block)

## D75: Discriminated Metadata Union (Product vs. Dev Methods)

**Decision:** Strategy metadata uses a discriminated union: `ProductMethodMetadata` (with `availability: 'product'` and `id: WatchInterpolationMode`) vs. `DevMethodMetadata` (with `availability: 'dev-only'` and `id: string`). The `availability` field is the discriminant.

**Rationale:** The settings UI picker must show only productized methods and use their IDs as `WatchInterpolationMode` without unsafe casts. Dev-only or research methods need arbitrary string IDs that do not widen the product type. The discriminated union lets the UI narrow via `m.availability === 'product'` and then safely read `m.id` as `WatchInterpolationMode`. Without the union, either the registry would need a separate dev-only map (duplication) or the product type would need to accept arbitrary strings (loss of type safety).

**Evidence:** `watch/js/watch-trajectory-interpolation.ts` (`ProductMethodMetadata`, `DevMethodMetadata`, `InterpolationMethodMetadata` union, `availability` discriminant)

## D76: Registry Metadata Not in Snapshot (Stable Frozen Accessor)

**Decision:** The array of registered interpolation method metadata is NOT part of `WatchControllerSnapshot`. It is accessed via a dedicated `getRegisteredInterpolationMethods()` accessor on the controller that returns a stable, frozen array reference.

**Rationale:** Registry metadata is configuration metadata (what methods exist), not per-frame state. Including it in the snapshot would cause reference-inequality churn on every `buildSnapshot()` call, triggering unnecessary React re-renders in the settings UI. The frozen array reference changes only when the registry is mutated (register/unregister/dispose), so React components that call the accessor will not re-render on every frame tick. The snapshot carries only the scalar results of interpolation (`activeInterpolationMethod`, `lastFallbackReason`).

**Evidence:** `watch/js/watch-controller.ts` (`getRegisteredInterpolationMethods()` — separate from `WatchControllerSnapshot`), `watch/js/watch-trajectory-interpolation.ts` (`_cachedMethods` — frozen, rebuilt only on registry mutation)

## D77: CSS Tokens Scoped to .watch-workspace (Not :root)

**Decision:** Watch-specific CSS custom properties (`--watch-dock-utility-gap`, `--watch-dock-smooth-min-w`, `--watch-dock-speed-slider-w`) are scoped to `.watch-workspace`, not `:root`.

**Rationale:** The watch app renders inside a `.watch-workspace` container. Scoping tokens to this container keeps watch-specific layout policy local and avoids polluting the global CSS namespace. If both lab and watch were loaded in the same document (e.g., a future multi-app shell), `:root`-scoped tokens would collide. `.watch-workspace` scoping also documents intent: these tokens are consumed only by descendants of the watch workspace, and their responsive breakpoint (`@media (min-width: 768px)`) mirrors `dock-shell.css`.

**Evidence:** `watch/css/watch-dock.css` (tokens defined on `.watch-workspace`, not `:root`), `watch/css/watch.css` (`.watch-workspace` grid container)

## D78: Shared Bond Topology Extraction

**Decision:** Extract bond-topology computation from PhysicsEngine into reusable shared modules under `src/topology/` with three entry points: naive (loader), position-based (Watch reconstruction), and accelerated (physics hot path).

**Rationale:** Lab and Watch both need bond topology. The physics engine's bond computation was tightly coupled to its spatial hash and state. Three entry points serve different callers without leaking physics internals.

**Evidence:** `src/topology/bond-rules.ts`, `src/topology/build-bond-topology.ts`, `lab/js/physics.ts` (delegates to `buildBondTopologyAccelerated`), `watch/js/topology-sources/reconstructed-topology-source.ts` (uses `buildBondTopologyFromPositions`)

## D79: Neutral Bond-Policy Module

**Decision:** Bond-policy types (`BondPolicyId`, `BondPolicyV1`, `KNOWN_BOND_POLICY_IDS`, `isBondPolicyId`) live in `src/history/bond-policy-v1.ts` — a neutral module with no dependencies. The file schema imports types for its own fields. The topology resolver imports types for its registry. Neither re-exports them.

**Rationale:** `history-file-v1.ts` and `bond-policy-resolver.ts` both needed `BondPolicyId`. Having the schema import from the resolver (or vice versa) created a cycle. A neutral module breaks the cycle without re-export hubs.

**Evidence:** `src/history/bond-policy-v1.ts`, `src/history/history-file-v1.ts` (import type only), `src/topology/bond-policy-resolver.ts` (import type only)

## D80: Registry-Based Bond-Policy Resolution

**Decision:** Bond-policy resolution uses a `Record<BondPolicyId, resolver>` registry. The `Record` type annotation enforces compile-time exhaustiveness — adding a new policy ID without a resolver entry (or vice versa) is a type error. No separate type assertions or runtime constants needed.

**Rationale:** Switch-based resolution required manual fallthrough handling. Separate `KNOWN_BOND_POLICY_IDS` + resolver lists drifted independently. `Record<BondPolicyId,...>` makes the two inseparable at the type level.

**Evidence:** `src/topology/bond-policy-resolver.ts` (`BOND_POLICY_RESOLVERS`)

## D81: Watch Topology Source Abstraction

**Decision:** Watch playback uses a `WatchTopologySource` interface with two implementations: `StoredTopologySource` (restart-frame lookup for full files) and `ReconstructedTopologySource` (position-based bond building for reduced files). The playback model branches on file kind at load time.

**Rationale:** Full history files include pre-computed topology in restart frames. Reduced files omit restart frames entirely — topology must be reconstructed from dense-frame positions and the shared bond builders. A common interface lets the playback model delegate without file-kind conditionals in every topology access.

**Evidence:** `watch/js/watch-playback-model.ts` (`WatchTopologySource`), `watch/js/topology-sources/`

## D82: Fail-Fast Element Lookup in Reconstruction

**Decision:** `buildBondTopologyFromPositions` throws on missing element IDs in the `elementById` map. No silent fallback to carbon (`'C'`).

**Rationale:** An earlier version silently substituted `'C'` for unknown atom IDs. This masked data-integrity bugs in reduced-file import — wrong element assignments would produce wrong bond cutoffs with no diagnostic. Throwing immediately at the reconstruction call site surfaces the root cause.

**Evidence:** `src/topology/build-bond-topology.ts` (`buildBondTopologyFromPositions`), `watch/js/capsule-history-import.ts` (builds `elementById` map with uniqueness validation)

## D83: Playback Capsule File Format

**Decision:** Add `kind: 'capsule'` as a production compact file format alongside `kind: 'full'`. Capsule files carry mandatory `bondPolicy`, optional `appearance` (assignment-grouped `atomIds` + `colorHex`), and optional sparse interaction timeline (event-stream keyed by `frameId`). Legacy `kind: 'reduced'` is accepted on import as an alias.

**Rationale:** The codebase needed a cloud-friendly compact format. Capsule is smaller than full (no restart frames, checkpoints, or per-frame interaction/boundary) while preserving topology reconstruction, authored colors, and interaction semantics.

**Evidence:** `src/history/history-file-v1.ts` (capsule types), `watch/js/capsule-history-import.ts`, `lab/js/runtime/history-export.ts` (`buildCapsuleHistoryFile`)

## D84: Stable Atom ID Appearance Model

**Decision:** Lab color assignments are authored by stable `atomId` (captured from the identity tracker at coloring time). Both Lab rendering and capsule export project from `atomIds` onto current dense slots. `atomIndices` is an authoring-time snapshot only.

**Rationale:** The original model froze dense slot indices, which drifted after compaction/reorder. Watch already used stable `atomIds`. Unifying both apps on the same identity model eliminates the Lab/Watch rendering mismatch.

**Evidence:** `lab/js/runtime/bonded-group-appearance-runtime.ts` (`projectOverridesFromAtomIds`, `syncToRenderer`), `lab/js/store/app-store.ts` (`BondedGroupColorAssignment.atomIds`)

## D85: Replay Removed from Lab Export UI

**Decision:** Remove replay from the export dialog and Lab export types. `TimelineExportKind` is now `'full' | 'capsule'`. Capsule is the preferred compact export; full is the review-complete export.

**Rationale:** Replay was a legacy format with no implementation path. Keeping it in the UI created dead product surface and confused the export state machine.

**Evidence:** `lab/js/components/timeline-export-dialog.tsx`, `lab/js/store/app-store.ts`

## D86: Capsule Share-Link Architecture — Metadata-First Control Plane + Private R2 Data Plane

**Decision:** Split the share-link service into a D1 control plane (metadata, share-code lookup, publish state machine) and an R2 data plane holding capsule blobs. R2 stays private — all public access is mediated by Pages Functions that resolve the share code through application policy before streaming the blob.

**Rationale:** D1 gives cheap, queryable metadata (lookups, audit joins, quota) while R2 gives cheap blob storage. Routing every read through a Function keeps user-controlled filenames and raw storage URLs out of the public surface, and lets us change storage layouts without breaking links.

**Alternatives rejected:** Public R2 bucket (leaks filenames, no access control, impossible to rotate); storing capsule bytes in D1 (wrong pricing and size model).

## D87: Share-Code Format — 12-Char Crockford Base32

**Decision:** Share codes are 12 characters of Crockford Base32 (~60 bits entropy), case-insensitive, excluding ambiguous glyphs (I, L, O, U). The canonical URL is `/c/<code>` (ungrouped); display form groups as `7M4K-2D8Q-9T1V`. `normalizeShareInput` accepts raw code, grouped code, `/c/:code`, `/watch/?c=…`, or a full URL.

**Rationale:** 60 bits defeats enumeration at any reasonable request rate; Crockford Base32 is readable on paper and over voice. A single normalizer collapses every observed input form into one canonical lookup key.

**Alternatives rejected:** Shorter codes (enumeration risk); UUIDs (user-unfriendly, unreadable).

## D88: Validate-Then-Write Publish Model (Phase 1b)

**Decision:** The publish Pages Function validates the capsule body in memory and only writes to R2 on success. If the subsequent D1 metadata insert fails, the R2 object is deleted to roll back. The quarantine/`incoming/` prefix pattern is reserved for a future presigned-URL direct-upload path.

**Rationale:** The Function already holds the full body in memory at validation time, so an upload-then-validate two-stage flow adds latency and a cleanup burden for no win. Rollback on D1 failure keeps the two stores consistent without distributed-transaction machinery.

**Alternatives rejected:** Upload-to-`incoming/` then validate (unnecessary when the body is already in the Function); fire-and-forget with an async janitor (leaves orphans during outages).

## D89: OAuth + Session Cookie (Not Cloudflare Access)

**Decision:** Auth uses OAuth 2.0 authorization-code flow against Google and GitHub, exchanged for an HttpOnly session cookie. Cookie name is `__Host-atomdojo_session` over HTTPS and `atomdojo_session_dev` over plain-HTTP localhost. Each `(provider, provider_account_id)` maps to exactly one user — no automatic cross-provider account linking in Phase 1. A `AUTH_DEV_USER_ID` env var plus a localhost origin (both required) enables a dev bypass.

**Rationale:** OAuth is standard, familiar to users, and avoids embedding long-lived API keys in the browser bundle. The `__Host-` prefix enforces Secure + path=/ + no Domain, which blocks subdomain cookie attacks. Requiring both the env var and the localhost origin for the dev bypass is defense in depth against accidental production exposure.

**Alternatives rejected:** Cloudflare Access (wrong audience — we need public sign-up, not SSO to an app); long-lived API keys in browser bundles (unrevocable, easy to exfiltrate); auto cross-provider linking (email-confusion account-takeover risk).

## D90: Two-Phase Publish Quota — Preflight Check + Post-Success Consume

**Decision:** Quota enforcement splits into `checkPublishQuota` (read-only preflight, before validation and write) and `consumePublishQuota` (run after a successful persist). Failed attempts — size, validation, R2 error, D1 metadata error — do NOT consume quota. If the consume itself fails after a successful persist, the client still receives 201 with `warnings: ['quota_accounting_failed']`; the publish is real. Overshoot is bounded by concurrency under normal conditions and by D1-outage duration in the pathological case, which emits a `publish_quota_accounting_failed` critical audit event that ops alerting MUST watch.

**Rationale:** Single-step check+consume would charge failures, turning a bug or network blip into user-visible quota loss. A full Durable-Object atomic counter would eliminate drift but costs significant complexity and is scoped to a future phase.

**Alternatives rejected:** Single-step check+consume (charges failures); Durable-Object atomic counter (deferred to a later phase).

## D91: Distinct Audit Event Types for Quota Rejection vs. Accounting Failure

**Decision:** Quota-related audit events split into `publish_rejected_quota` (429 path — the user was denied) and `publish_quota_accounting_failed` (publish succeeded, counter drifted, critical). These are never collapsed into a single event type.

**Rationale:** 429 dashboards count user-facing rejections; reconciliation tooling counts internal drift. Conflating them would contaminate both streams — alert fatigue on one side, false-negative reconciliation on the other.

## D92: Admin Gate Dual Auth Path

**Decision:** Admin endpoints require one of two auth paths, both enforced by `functions/admin-gate.ts`: (1) local operator — `DEV_ADMIN_ENABLED=true` AND a localhost origin, strict equality check on both; (2) production automation — `X-Cron-Secret` header, constant-time compared against the `CRON_SECRET` env var. Every failure path returns 404 (not 403) to avoid leaking endpoint existence. Used by `seed`, `delete`, `sweep/orphans`, and `sweep/sessions`.

**Rationale:** Dev operators need a zero-friction local path; scheduled automation needs a headless path; neither should unlock the other. 404-on-failure denies attackers even the signal that a gated route exists at that URL.

**Alternatives rejected:** 403 on failure (existence leak); one-size-fits-all bearer token (dev workflow friction); checking only env var or only origin (each alone is insufficient).

## D93: IP Hashing with Mandatory Salt

**Decision:** IPs are never stored raw. `hashIp(ip, salt)` computes SHA-256 over `ip\u0000salt` with the salt sourced from `SESSION_SECRET`; the function rejects an empty salt. The digest is stored in `capsule_share_audit.ip_hash` and used for per-IP-per-day de-duplication. Rotating `SESSION_SECRET` invalidates old hashes, and that rotation is documented as an operational runbook item.

**Rationale:** Hashed-with-salt preserves the de-dup signal we need (same IP twice in one day) without retaining PII. A mandatory salt prevents accidental plain-SHA-256 collisions with global rainbow tables. Unicode NUL as the delimiter makes the pre-image unambiguous even if an IP string contains unusual separators.

**Alternatives rejected:** Storing raw IPs (PII and retention risk); hashing without a salt (rainbow-table attack); hashing with a compile-time constant salt (can't be rotated without a code deploy).

## D94: Companion Cron Worker at `workers/cron-sweeper/`

**Decision:** Scheduled sweeps live in a dedicated Worker at `workers/cron-sweeper/` that calls the Pages Functions admin sweep endpoints via `X-Cron-Secret`. Schedules: `0 */6 * * *` (sessions + quota buckets), `30 3 * * *` (R2 orphans).

**Rationale:** Pages Functions cannot register scheduled handlers; something outside Pages must invoke the sweeps. Embedding sweep logic directly in the Worker would duplicate code already implemented as Pages Functions endpoints. Having the Worker call the Functions keeps one implementation, one test surface, and one set of audit events.

**Alternatives rejected:** Inline sweep logic in the Worker (code duplication); external cron service (adds a third-party dependency and credential).

## D95: Unified "Transfer" Dialog Replaces Separate Publish + Export Triggers

**Decision:** One cloud-arrows trigger opens one dialog containing Download and Share tabs. The tab bar is hidden when only one destination is available. The dialog holds a dialog-level busy guard — one operation at a time; cancel, close, Escape, and backdrop dismissal are all disabled during submit. Action availability is the single source of truth; dead tabs never render. Warnings appear as a subtle non-blocking pill in the Share success state.

**Rationale:** Two separate top-level triggers fragmented the transfer flow and doubled the icon surface. A unified dialog gives a single mental model ("send this somewhere") with per-destination tabs, and driving visibility off action availability eliminates drift between "button present" and "button usable." The busy guard prevents double-submit during the inherently-async publish/export.

**Alternatives rejected:** Two separate buttons (fragmented UX, duplicated state); one button that silently does the "right" thing (breaks discoverability for the non-default destination).

**UPDATE 2026-04-17:** The Timeline Transfer trigger's user-facing label and tooltip are now canonicalized as **"Share & Download"** (NOT "Transfer history", "Export", or "Share" alone); the string is exported as `TRANSFER_HINT_COPY` from `lab/js/components/timeline-transfer-dialog.tsx`. A timed discoverability cue (1 s fade-in / 3 s hold / 1 s fade-out) fires once per page load, 5 s after the first atom interaction (signal: `useAppStore.hasAtomInteraction`), bypassing the `@media (hover: none)` touch-hide via `.timeline-hint--force-visible` so the cue is device-agnostic. The underlying dialog architecture (single dialog, busy guard, availability-driven tab visibility, subtle non-blocking warning pills) is unchanged.

## D96: tsconfig Split — Frontend / Functions / Cron

**Decision:** The repo ships three TypeScript configs: `tsconfig.json` for the frontend (excludes endpoint tests), `tsconfig.functions.json` for Pages Functions and their tests (includes Workers globals such as `PagesFunction`, `D1Database`, `R2Bucket`), and a third config for the cron Worker. `npm run typecheck` runs all three as a single gate.

**Rationale:** Endpoint tests need Workers runtime globals that must not leak into Vite's compile of the frontend, but they also must be type-checked somewhere or they silently rot. Three narrow configs plus one gate catches drift in any codebase without polluting the others.

**Alternatives rejected:** Single shared config (Workers globals pollute frontend compile); excluding endpoint tests from type-check entirely (silent rot).

## D97: WAF Rate Limiting for Per-IP, In-Code for Per-User Quota

**Decision:** Per-IP request limiting is enforced at the Cloudflare WAF edge (the recommended configuration is documented in `wrangler.toml`), not in Pages Functions code. Per-user publish quota is enforced in code via the `publish_quota_window` D1 table.

**Rationale:** Per-IP is an anonymous, identity-free signal best handled at the edge where it can short-circuit before reaching our Functions. Per-user quota is identity-aware and requires looking up a session and a window row — it must run in code where auth is already resolved.

**Alternatives rejected:** In-code per-IP limiting (adds DB round-trips to every request, worse-than-edge latency); WAF-only (can't express per-user quotas).

## D98: Popup-Primary OAuth with Explicit Same-Tab Fallback

**Decision:** Lab-side sign-in opens OAuth in a popup window first (`tryBeginOAuthPopup`). If the popup is blocked or fails to complete, the UI surfaces a blocker dialog with three explicit choices — Retry popup, Continue in this tab (destructive), or Back — rather than silently redirecting. Popup completion posts a `message` back to the opener which runs `hydrateAuthSession()` without a navigation; the opener's in-memory state (scene, timeline, dismissed onboarding) is preserved. The same-tab path is reserved for when the user explicitly opts in.

**Rationale:** A full-page redirect destroys every piece of Lab state that lives outside the session cookie — the live scene, the recorded timeline, the onboarding-dismissed flag — because those are all in-memory. Popups preserve that state end-to-end. When popups are unavailable, having the runtime silently fall back to a destructive redirect would make the Lab "randomly" lose state depending on the user's browser popup policy. A user-driven choice keeps the destructive action explicit and recoverable (Back returns to the prior Lab state untouched).

**Alternatives rejected:** Silent same-tab fallback on popup block (destroys Lab state with no warning); popup-only with no fallback (users with aggressive popup blockers cannot sign in at all); full-page redirect as primary (every sign-in drops in-memory work).

**Evidence:** `lab/js/runtime/auth-runtime.ts` (`tryBeginOAuthPopup`, `onSignInSameTab`, `onDismissPopupBlocked`, `AUTH_RETURN_QUERY`), `functions/auth/popup-complete.ts`

## D99: `/api/auth/session` Returns 200 With Status Discriminator, Never 401

**Decision:** The session-discovery endpoint always responds 200 with a JSON body carrying a `status` discriminator (`'signed-in' | 'signed-out'`). HTTP 401 is reserved for protected actions (publish). The endpoint also sets `Cache-Control: no-store` and `Vary: Cookie`, and opportunistically clears stale session cookies on signed-out responses.

**Rationale:** `/api/auth/session` is state discovery, not a protected action. Returning 401 on every Lab boot for signed-out users filled devtools with red network errors on a nominal code path, making genuine auth failures harder to spot during development and noisy for users who opened devtools. Using a body discriminator keeps the network tab clean and lets the client branch on semantics rather than HTTP status. `no-store` + `Vary: Cookie` prevent intermediate caches from serving another user's session; opportunistic cookie clearing keeps client and server in sync without a round-trip.

**Alternatives rejected:** 401 for signed-out (confuses state discovery with access denial, dirties devtools); cache-friendly 200 without `Vary: Cookie` (cross-user cache poisoning).

**Evidence:** `functions/api/auth/session.ts`, `lab/js/runtime/auth-runtime.ts` (`hydrateAuthSession` branches on body `status`, not HTTP status)

## D100: Discriminated `AuthState` Union With Narrow Setter Helpers

**Decision:** The store models auth as a discriminated union where each branch carries an explicit `session` field — `{ status: 'signed-in', session: AuthSessionState } | { status: 'loading' | 'signed-out' | 'unverified', session: null }`. The non-signed-in branches all carry `session: null` (not `session?`); the discriminator is `status`, and consumers always have a defined property to read. The canonical transition API is a set of narrow setters — `setAuthSignedIn`, `setAuthSignedOut`, `setAuthUnverified`, `setAuthLoading` — rather than a generic `setAuth(partial)`.

**Rationale:** A flat shape (`{ status, session: Session | null }`) allows impossible combinations such as `{ status: 'signed-in', session: null }` to compile and silently break consumers. A discriminated union makes those states type errors. Narrow setters encode the valid transitions at the API level: callers cannot accidentally write `signed-in` without supplying a session, and they cannot leave stale session data attached to a signed-out status. The set of setters is also the complete transition vocabulary, which pairs with the state machine in D101.

**Evidence:** `lab/js/store/app-store.ts` (`AuthState` union, `setAuthSignedIn`, `setAuthSignedOut`, `setAuthUnverified`, `setAuthLoading`)

## D101: Four-State Auth Machine Including `unverified`

**Decision:** The auth state machine has four states: `loading`, `signed-in`, `signed-out`, `unverified`. `unverified` is entered when the session probe fails in an indeterminate way (network error, 5xx, malformed response) AND there is no prior authoritative answer to preserve. The UI renders a neutral Retry affordance for `unverified` — NOT the OAuth prompt. If a transport blip happens after an authoritative answer, the prior state is kept instead of being clobbered.

**Rationale:** Collapsing "can't verify" into "signed-out" would push signed-in users whose cookie is still valid server-side into an unnecessary OAuth round-trip every time the network hiccups. A separate `unverified` state lets the UI say "couldn't reach the server" without implying the user was logged out. The preservation rule (keep prior authoritative state on indeterminate outcomes) ensures that a late or transient failure during normal operation does not silently downgrade the UI.

**Evidence:** `lab/js/runtime/auth-runtime.ts` (transition table in the module header, `hydrateAuthSession` implementation)

## D102: Orphan-Session LEFT JOIN in Auth Middleware

**Decision:** The auth middleware's session lookup uses a `LEFT JOIN` from `sessions` to `users` and treats a session whose user row is missing as signed-out. Orphan sessions are fire-and-forget deleted from D1 with a per-isolate dedupe set to bound load during a storm.

**Rationale:** Prior middleware trusted the `sessions` table alone, so a deleted user's row could leave cookies that the session-discovery endpoint correctly reported as signed-out while the protected-action middleware still accepted them — a real correctness gap where a user could publish after account deletion. The LEFT JOIN makes the middleware's single source of truth the same as the discovery endpoint's. Per-isolate dedupe prevents a single orphan cookie in a hot path from issuing a delete on every request.

**Evidence:** `functions/auth-middleware.ts`

## D103: Sequence-Token Gating in `hydrateAuthSession`

**Decision:** `hydrateAuthSession` increments a monotonic `hydrateSeq` counter at function entry and captures the value locally. Before every authoritative store write (`setAuthSignedIn`, `setAuthSignedOut`, `setAuthUnverified`), it checks `isLatest()` — if a newer call has started, the current call's result is dropped.

**Rationale:** Multiple hydrate calls can be in flight simultaneously — the initial boot probe, a post-OAuth-popup refresh, a manual retry after an `unverified` blip. Without sequence gating, a slow stale fetch (e.g., the boot probe held up by cold-start) could land after a fresh signed-in answer and overwrite it with `unverified` or stale-signed-out, flipping the UI back to a sign-in prompt moments after a successful sign-in. A monotonic token plus a pre-write staleness check makes late writes a no-op by construction.

**Evidence:** `lab/js/runtime/auth-runtime.ts` (`hydrateSeq`, `isLatest()` guard before every authoritative setter call)

## D104: Kind-Tagged `shareError` for Transfer Dialog

**Decision:** `shareError` in the store is a discriminated object `{ kind: 'auth' | 'other'; message: string } | null` rather than a plain `string | null`. UI branches that render auth-prompt copy read only `kind === 'auth'`; generic error chrome reads `kind === 'other'`.

**Rationale:** With a single `string | null` field, a 429 rate-limit message could leak into the auth-prompt UI after an opportunistic signed-out flip happened between the error being set and the component re-rendering, because both branches shared the same string slot. A discriminator makes cross-branch bleed a type error: a rate-limit message cannot be stored under `kind: 'auth'` and therefore cannot render as an auth note. The same structure also prevents the reverse (auth messages appearing as generic red error pills).

**Evidence:** `lab/js/components/TimelineBar.tsx`, `lab/js/components/timeline-transfer-dialog.tsx`, `lab/js/store/app-store.ts` (`ShareError` type)

## D105: `TopRightControls` Flex Container for Account + FPS

**Decision:** The top-right surface is a single flex container (`TopRightControls`) that owns layout for `AccountControl` and `ReactFPS`. Neither child is independently absolutely positioned — they flow inside the flex parent.

**Rationale:** Previously, both surfaces were absolutely positioned relative to the viewport with hand-tuned offsets. Long display names and narrow viewports caused them to overlap (the account menu grew leftward under the FPS counter) with no self-correction. A single flex container provides a stable placement contract: the children are siblings with gap-based spacing, so changes in either child's width push the other predictably and safely.

**Evidence:** `lab/js/components/TopRightControls.tsx`, `lab/index.html`

## D106: Plain-Disclosure Popover Semantics for `AccountControl`

**Decision:** `AccountControl` is rendered as a plain disclosure (a button that toggles a popover containing native `<button>` items) rather than with ARIA `role="menu"` / `role="menuitem"`. Arrow-key navigation, typeahead, and managed initial focus are not implemented.

**Rationale:** `role="menu"` commits to a full menubar-style keyboard model — arrow keys, Home/End, typeahead, and initial-focus management — because screen readers stop treating child elements as individual buttons once the parent is a menu. For a 1–3 item account popover (View, Sign out), that complexity adds no accessibility value. Native buttons inside a plain disclosure are already fully keyboard and screen-reader accessible (Tab, Enter/Space, labels) without additional ARIA commitments.

**Alternatives rejected:** `role="menu"` with partial keyboard model (worse than native buttons — screen readers announce as menu but keyboard doesn't behave like one); full menubar implementation (disproportionate for two actions).

**Evidence:** `lab/js/components/AccountControl.tsx`

**UPDATE 2026-04-17:** The disclosure-over-menu policy established for `AccountControl` is now extended to the Watch→Lab entry control's caret-toggled popover (see D124 entry-control redesign update). The caret button carries `aria-haspopup="true"`, the popover uses `role="group"` with `aria-label="More ways to open Lab"`, and the single secondary item is a native `<button>`. Explicitly NOT used anywhere: `role="menu"`, `role="menuitem"`, or an APG menu keyboard model. The same rationale applies — for a one-item popover (the secondary "Open a Fresh Lab" action), committing to the APG menu pattern would add arrow-key / typeahead / managed-focus overhead without accessibility benefit. A plain disclosure keeps the secondary as a native button, fully keyboard- and screen-reader-accessible via Tab + Enter/Space, while the caret itself signals "reveals more options" via `aria-haspopup`. Canonicalized terminology: this pattern is called **disclosure**, never "menu" / "dropdown menu" / "contextmenu".

## D107: sessionStorage Onboarding Sentinel

**Decision:** The onboarding-dismissed flag uses `sessionStorage`, not `localStorage`. A same-tab OAuth round-trip preserves the flag (same browser session); a full tab restart or new window does not.

**Rationale:** Without any sentinel, a same-tab OAuth bounce reshows the onboarding overlay on return to Lab, which is disorienting for a user who already dismissed it moments ago. `localStorage` would overcorrect by remembering the dismissal forever, making users who return days later miss the intended fresh-load welcome. `sessionStorage` scopes dismissal to the current browser session, matching the implicit contract users expect from "I dismissed this on this visit."

**Evidence:** `lab/js/runtime/onboarding.ts`

## D108: Server-Authoritative 13+ Age Gate via Short-Lived HMAC Nonce

**Decision:** `auth/{provider}/start` requires a nonce minted by `POST /api/account/age-confirmation/intent`. The HMAC nonce is short-lived and bound to the pending OAuth flow. Already-signed-in users get a live-session bypass (their prior acknowledgement stands).

**Rationale:** The gate must be enforced where accounts are actually created, which is the OAuth start path. A checkbox alone is UI friction, not enforcement — nothing prevents a client bypassing it. Binding the start to a server-issued nonce means the server refuses to begin OAuth without prior acknowledgement.

**Alternatives rejected:** Client-only checkbox (UI friction is not enforcement); on-publish-only check (would let an unauthenticated user create an account first, then be gated — inverts the consent order).

## D109: Publish 428 Precondition (Not 401 or 403)

**Decision:** `POST /api/capsules/publish` returns `428 Precondition Required` with a structured body when a signed-in user has no `age_13_plus` row. The client uses this signal to render the retro-acknowledgement UI.

**Rationale:** 401 misrepresents a valid session as missing; 403 misrepresents a policy precondition as an authorization denial. 428 is the exact semantic — the request would succeed once the precondition is satisfied — and gives the client a clean signal to drive the retro-ack UI.

**Alternatives rejected:** 401 (not a session problem); 403 (not an authorization problem); silent block (user needs the retro-ack UI, not a dead button).

## D110: Owner-Delete 404 (Not 403) on Cross-User

**Decision:** `DELETE /api/account/capsules/:code` returns 404 for a wrong-owner request, indistinguishable from "no such code." No existence disclosure.

**Rationale:** A 403 on someone else's share code leaks that the code exists. 404 in both the missing-code and wrong-owner branches removes the oracle.

## D111: Tombstone (Not Hard-Delete) for `users` Row on Account Deletion

**Decision:** Account deletion sets `users.deleted_at` and nulls `display_name`; the row is not removed. Auth middleware's `LEFT JOIN ON u.deleted_at IS NULL` makes a tombstoned row behave like a missing row for session resolution.

**Rationale:** `capsule_share.owner_user_id` and `capsule_share_audit.actor` foreign references must remain resolvable for historical integrity and chain-of-custody; a hard delete would either cascade-destroy those records or leave dangling IDs. Tombstoning preserves referential integrity while the middleware JOIN condition ensures the user cannot authenticate.

## D112: Capsule Delete Cascade — Ordered Steps With Audit Folded Into `ok`

**Decision:** The account-delete cascade executes in this order and tracks each in a `steps` map: sessions → quota → capsules → oauth → user-tombstone → audit. The final `ok` flag folds in the `audit` step — an audit-write failure cannot silently report success.

**Rationale:** Ordering is chosen so that auth-terminating steps (sessions, oauth) land early, content steps land in the middle, and the audit record is written last to capture the final state. Folding audit into `ok` forces any observability gap to surface as a visible failure rather than a silent drop.

## D113: Re-Scan for Concurrent-Publish Race Window in Delete Cascade

**Decision:** The cascade selects owned capsules twice — once before sessions-DELETE and once after. Any capsule that appears in the second scan but not the first is processed identically.

**Rationale:** A publish that resolved auth before sessions-DELETE can land after the first scan, leaving an unreachable owned capsule row otherwise. The re-scan closes that window without requiring a distributed lock.

## D114: Cursor Pagination With Base64url Padding Restoration

**Decision:** The capsule list API uses keyset pagination on `(created_at DESC, share_code DESC)` with a base64url-encoded opaque cursor. The decoder MUST restore `=` padding before `atob`. A shared helper at `src/share/b64url.ts` enforces this for both cursor and signed-intent encodings.

**Rationale:** Keyset pagination is stable under concurrent inserts (OFFSET is not). Base64url omits padding, but `atob` requires it — skipping restoration produces intermittent `InvalidCharacterError`. Centralizing the helper prevents drift between cursor and intent code paths.

**Evidence:** `src/share/b64url.ts`

## D115: Class-Based Audit Retention — Scrub, Not Delete

**Decision:** `capsule_share_audit` is treated as operational chain-of-custody. A 180-day sweep nulls PII fields (`ip_hash`, `user_agent`, and `reason` for `abuse_report` + `moderation_delete` event types) while retaining the row skeleton indefinitely. Only rows with `event_type='abuse_report'` are row-deleted.

**Rationale:** The audit stream is the only durable record of moderation and quota decisions — deleting rows would break forensic reconstruction. Scrubbing PII reconciles retention minimization with chain-of-custody. Abuse reports are the one class that is appropriate to row-delete because the report itself is PII and has no post-resolution operational value.

## D116: Privacy Contact Channel — In-App Form (Option B), Not Mailbox

**Decision:** Privacy / data-subject requests flow through an in-app `/privacy-request` form rather than a `privacy@` mailbox. Form protections: CSRF nonce, honeypot, per-IP D1 quota, 24h body de-dup. `POLICY_FEATURES.privacyContactMode = 'form'` is the source-of-truth flag; flipping to mailbox requires hiding the route and the link in the same change.

**Rationale:** The project does not yet own a custom domain, so a `privacy@` address would either be a third-party forwarder (trust/latency issues) or unavailable. The form channel also gives the server-side quota, dedup, and audit hooks that an inbox cannot. The feature flag makes the mode switchable without code archaeology.

## D117: Build-Time Policy-Version Injection via Vite Plugin

**Decision:** `src/policy/policy-config.ts` is the single source of truth for `POLICY_VERSION`. A Vite plugin injects the value into HTML placeholders at build and throws if any required placeholder (`<!--POLICY_META-->`, `__POLICY_VERSION__`, `<!--POLICY_FEATURES-->`) is missing from the template.

**Rationale:** Duplicating the version across HTML, meta tags, and TS constants guarantees drift. A single constant plus a build-time injector makes the value mechanically consistent, and the fail-on-missing-placeholder check turns a silent template regression into a loud build failure.

**Evidence:** `src/policy/policy-config.ts`

## D118: AgeGateCheckbox Refresh Strategy — Interval + Visibility + Consumer-Bumped Token

**Decision:** The age-gate intent nonce refreshes on a 4-minute interval, on `visibilitychange`, and when the consumer bumps a `refreshNonce` counter. A click-time staleness check reroutes the user back to the picker via the popup-blocked descriptor's `ageIntentMintedAt` if the nonce has aged out.

**Rationale:** A just-in-time fetch on click would introduce an async hop between user gesture and `window.open`, which browsers treat as a non-gesture-initiated popup and block. The interval + visibility refresh keeps the nonce warm without breaking gesture semantics; the click-time staleness check is a safety net that reroutes rather than silently failing.

**Alternatives rejected:** Just-in-time fetch on click (breaks popup-not-blocked semantics).

## D119: Pages-Dev E2E Lane Separate From Default Lane

**Decision:** Backend-dependent E2E specs (`tests/e2e/pages-dev-flows.spec.ts`) gate via `testInfo.project.name !== 'pages-dev'` and are skipped by the default project. The default lane runs against `vite preview` and stays fast; contributors do not need wrangler installed to run it.

**Rationale:** A single-lane setup either forces every contributor to install and run wrangler (high friction) or drops backend coverage (quality regression). Splitting the projects lets each lane optimize for its constraint — default for speed and zero-install, pages-dev for real backend paths.

**Evidence:** `tests/e2e/pages-dev-flows.spec.ts`

## D120: Age Clickwrap + Just-In-Time Intent — Supersedes D118

**Supersedes:** D118.

**Decision:** Replace the explicit 13+ checkbox + interval-refreshed age-intent nonce with:

1. A single short clickwrap sentence (`<AgeClickwrapNotice>`) rendered above the provider buttons in every gated surface (AccountControl signed-out menu, Transfer dialog signed-out Share panel, Transfer dialog publish-428 fallback). Clicking the provider/Publish button IS the consent.
2. A just-in-time `fetch('/api/account/age-confirmation/intent')` issued by the auth runtime AFTER it has already opened the popup shell synchronously inside the user gesture (`openOAuthPopupShell` → `fetchAgeIntent` → `navigatePopupTo`). Same-tab fallback also fetches JIT but can await before `location.assign` because that path doesn't need user-gesture qualification.
3. A new OAuth state field `age13PlusConfirmed?: true` (plus `agePolicyVersion?: string`) so the callback can write the durable `user_policy_acceptance` row at the moment account-linked personal data starts being stored — fused with new-user creation in a single `db.batch([...])` via `findOrCreateUserWithPolicyAcceptance`.

**Rationale:**

- Lower friction: one less click on every sign-in.
- No stored expiring nonce in React state — no refresh intervals, no stale-token recovery dance, no `AGE_INTENT_STALE_AFTER_MS` constant.
- Single proof artifact: every acceptance write goes through `recordAge13PlusAcceptance` (the new-user batch is the one allowed exception, inlined for atomicity).
- Stronger invariant: brand-new accounts cannot exist without a matching `user_policy_acceptance` row (atomic batch). Existing accounts and pre-deploy in-flight users are still publish-gated by the unchanged `428` backstop.
- Popup reliability preserved: the runtime opens the popup shell synchronously inside the click handler (still inside the live user gesture), then performs the async fetch and navigates the popup once the intent resolves.

**Acceptance invariant — precise wording (do not relax):**

1. New-account creation through the post-clickwrap flow ⇒ acceptance.
2. Callback acceptance failure ⇒ no session (callback bails before `createSessionAndRedirect`, redirects to `/auth/error`).
3. Legacy / pre-deploy existing sessions are still publish-gated by `428`.

The publish-`428` path is **not** redundant with the callback acceptance write — it covers the legacy population that the callback write does not.

**Resume-publish sentinel timing (load-bearing):** the runtime writes `atomdojo.resumePublish` to sessionStorage **only after** the JIT intent fetch resolves successfully and immediately before `navigatePopupTo` / `location.assign`. Pre-fetch sentinel writes orphan into a later unrelated sign-in's auto-Share-open; the post-fetch timing closes that failure window. Defensive `clearResumeIntent()` runs in the catch branch.

**Alternatives rejected:**

- Keep the checkbox + interval refresh (D118 — superseded). Higher friction and stale-token recovery is intricate.
- Drop the popup entirely and always same-tab. Regresses Lab's "don't lose canvas state" UX.
- `findOrCreateUser` followed by a separate acceptance UPSERT. Re-introduces the gap where account-linked rows can exist without acceptance if the second await throws.

**Evidence:** `functions/policy-acceptance.ts`, `functions/oauth-state.ts`, `functions/auth/error.ts`, `lab/js/runtime/auth-runtime.ts`, `lab/js/components/AgeClickwrapNotice.tsx`, `tests/unit/policy-acceptance.test.ts`, `tests/unit/oauth-state.test.ts`, `tests/unit/auth-error-route.test.ts`.

## D121: Cinematic Camera Source-Attribution Gate

**Decision:** Programmatic `controls.update()` calls in the Renderer are routed through a source-attribution gate (`camera-interaction-gate.ts`) that suppresses interaction events for non-user-originated updates. Only OrbitControls user gestures ('start' → 'change' → 'end') are forwarded to `onCameraInteraction` listeners.

**Rationale:** Without source separation, the cinematic camera's own framing updates called `controls.update()`, which emitted OrbitControls 'change' events, which the cinematic service interpreted as user input, causing a 1.5s self-induced cooldown loop and visible stutter. The gate makes the invariant mechanical: "renderer-owned programmatic updates never wake interaction listeners."

**Evidence:** The original bug manifested as: cinematic moves a little, pauses 1.5s, moves a little, pauses 1.5s. The fix: all 10 programmatic `controls.update()` call sites route through `_updateControlsSilently()`, which uses `gate.runSilently()`.

## D122: Phase-Aware Camera Interaction Tracking

**Decision:** Camera interaction listeners receive a phase ('start' | 'change' | 'end') instead of a void callback. The cinematic service tracks `_userGestureActive` based on start/end boundaries.

**Rationale:** Timestamp-only cooldown (1500ms) does not cover a held gesture without motion. If the user holds pointerdown and stops moving, no 'change' events fire, the cooldown expires, and cinematic resumes while the user is still holding. Phase tracking keeps the service paused for the entire hold; cooldown starts from release.

## D123: Cinematic Speed Tuning Parameterization

**Decision:** All speed-profile coefficients (motion exponent, refresh exponent, smoothing constants, Hz bounds) are injected via a `CinematicSpeedTuning` config rather than hard-coded in the function body. `normalizeCinematicSpeedTuning()` clamps invalid values to defaults.

**Rationale:** Future UX tuning is a config change, not code archaeology. Watch and Lab can reuse the same module with different tuning profiles.

## D124: Watch→Lab Handoff Transport — `localStorage` Over `sessionStorage`

**Decision:** The Watch→Lab entry funnel serializes its handoff payload to `localStorage` under a namespaced key, not `sessionStorage`. Lifetime is bounded by a 10-minute TTL, a pre-write sweep of stale entries, and one-shot consume semantics on the Lab side (read-and-clear in the same transaction).

**Rationale:** The Remix affordance opens Lab via `window.open('_blank', 'noopener,noreferrer')`. `_blank` with `noopener` creates a fresh top-level browsing context with its own `sessionStorage` namespace — a sessionStorage-based handoff written in Watch would be invisible to the new Lab tab. `localStorage` is origin-scoped and survives the new-tab boundary, making it the only built-in storage primitive that works end-to-end for this funnel. The longer effective lifetime is mitigated by TTL + sweep + one-shot consume: a payload that is never consumed (Lab tab closed before read, handoff aborted) is bounded to 10 minutes, and a consumed payload is deleted atomically so the same entry cannot hydrate two Lab tabs.

**Alternatives rejected:** `sessionStorage` (invisible across the `_blank` boundary); `postMessage` across the `noopener` pair (impossible by construction — `noopener` severs the opener reference for clickjacking safety, and opening without `noopener` would regress that protection); URL fragment payload (atom data is far larger than URL length limits are willing to guarantee, and would leak into referrer-style surfaces on subsequent navigation).

**UPDATE 2026-04-17:** Canonical terminology: the Watch-side primary button is now **Continue** (previously called "Remix" / "From this frame"). The transport decision is unchanged — `localStorage` + 10-minute TTL + pre-write sweep + one-shot consume still hold. The seed schema (`WatchLabSceneSeed`) now carries three additional fields: `colorAssignments: WatchLabColorAssignment[]`, `camera: WatchLabOrbitCamera | null`, and a refined `provenance: { historyKind, velocitySource, velocitiesAreApproximated, unresolvedVelocityFraction }`, where `velocitySource ∈ { restart | central-difference | forward-difference | backward-difference | mixed | none }`. Validators (`isValidSeed`/`isValidPayload`) accept legacy tokens (no camera, no colorAssignments, 2-field provenance) — the new fields are optional at validate time; the normalizer defaults camera→null, colorAssignments→[], velocitySource derived from `velocitiesAreApproximated`. The Watch-side href identity tuple (`_currentFrameHrefCache`) now has **5 components** — `documentKey`, `displayFrameKey`, `topologyFrameKey`, `restartFrameId`, and `cameraIdentity` (quantized `(position, target, fovDeg)` with `POSITION_Q=0.01`, `FOV_Q=0.5`). Cache hit requires all five to match; cache miss purges the stale token via `removeWatchToLabHandoff`.

**UPDATE 2026-04-17 (entry-control redesign):** The Watch-side entry affordance has migrated from a split-capsule (both halves always visible — "Open Lab" + "Continue") to a **primary pill + caret-toggled disclosure popover**. Canonical copy:

- **Primary** (accent-filled pill, always visible): **"Interact From Here"**. Module-local tooltip constant: *"Take over from this exact frame. Drag atoms and watch the physics react."* (two sentences, no em-dash).
- **Caret `▼`** toggles a popover anchored **above** the capsule (never below, at every viewport — avoids overlap with Cinematic toggle / timeline / dock).
- **Secondary** (inside popover): **"Open a Fresh Lab"** — *"Starts with a default molecule. Build and experiment from there."* (NOT "Open Lab", "New Empty Lab", or "Open empty").

The transport contract (`localStorage` + 10-min TTL + one-shot consume) is unchanged; only the surface that writes the seed changed. Primary tooltip and popover are mutually exclusive — React writes `data-menu-open="true"` on `.watch-lab-entry` while the popover is open and CSS `:has(…)` suppresses the tooltip. Menu styling uses shared `--color-surface` / `--color-border` / `--glass-blur` tokens to match `.watch-open-panel` rather than custom accent-tinted glass. CSS classes `.watch-lab-entry`, `.watch-lab-entry__primary`, `.watch-lab-entry__secondary`, `.watch-lab-entry__tooltip` are preserved for E2E compat; `.watch-lab-entry__menu-item*` were dropped (merged into the secondary classes).

**Rationale for the split-capsule → primary+disclosure migration:** Always-visible dual halves forced first-time users to disambiguate two unfamiliar labels simultaneously ("Open Lab" vs "Continue"), and "Lab" means nothing without context. One label at a time is clearer: the primary CTA answers "what does this button do?" in a self-contained sentence ("Interact From Here"), and the caret is a universally understood disclosure affordance for users who want alternatives. The secondary lives behind the caret precisely because it's the rarer path (fresh start instead of continuing this frame).

## D125: Handoff Commit Primitives — `clearScene + appendMolecule`, Not `restoreState`

**Decision:** The Lab-side hydrate transaction seeds the scene via the same `clearScene` + `appendMolecule` primitives that Lab's native commit-molecule flow uses. It does NOT route through `worker.restoreState`, even though `restoreState` superficially looks like the right API for "install this structure into the physics world."

**Rationale:** `worker.restoreState` has a silent-failure mode that is incompatible with a transactional handoff. When the worker returns a logical `{ok: false}`, the worker lifecycle's `onFailure` callback fires synchronously and invokes `recoverLocalPhysicsAfterWorkerFailure`, which overwrites main-thread physics with the worker's pre-mutation snapshot. The `await worker.restoreState(...)` call itself returns void regardless of outcome, so hydrate cannot detect the failure and the implicit recovery clobbers the transactional commit with stale state. `clearScene` and `appendMolecule` return explicit `{ok}` results, giving hydrate the signal it needs to route failures through its own rollback path (restore prior scene, surface failure copy per D128) rather than be silently rewound by the worker lifecycle's recovery hook.

**Alternatives rejected:** `worker.restoreState` (silent `{ok:false}` fires implicit recovery that clobbers the commit); patching the worker lifecycle to suppress recovery during hydrate (couples hydrate to worker internals and breaks recovery for legitimate mid-hydrate failures — D126's hydration lock is the cleaner mechanism).

**Evidence:** hydrate transaction uses the same primitives as Lab's native commit-molecule path; `normalizeWatchSeed` produces a single `localStructureAtoms` payload that feeds `appendMolecule` directly.

**UPDATE 2026-04-17:** The transaction now extends beyond atom placement to cover **camera pose and color assignments** as first-class hydrated state. After the renderer rebuild step, hydrate applies the seed camera via `renderer.applyOrbitCameraSnapshot(snapshot)` (cancels animation, sets camera + target + up, updates projection matrix if FOV changed, silent controls update, recomputes focus distance), or falls back to `renderer.fitCamera()` when `seed.camera === null`. Color assignments are applied unconditionally on the success path via `bondedGroupAppearanceRuntime.restoreAssignments(seed.colorAssignments)` — REPLACE semantics, so an empty array wipes prior Lab state. The `appendMolecule` worker command now carries an optional `velocities: Float64Array`; the worker handler writes `engine.vel.set(velocities, atomOffset*3)` **before** bumping `sceneVersion++` so the first post-append snapshot carries real momentum (previously the snapshot reconciler zeroed main-thread velocities on the first frameResult). Rollback captures **both** camera and color pre-hydrate via `snapshotAssignments()` / live camera read, and restores both on failure. Rollback sub-failures accumulate into `cause: { originatingCause, rollbackSubFailures }` rather than being swallowed.

## D126: Hydration Lock as a Boot-Scope Transactional Lock

**Decision:** A module-scope `_hydrationActive` flag in `main.ts`, set by the transactional handoff module via a `setHydrationActive` dep and read by `frame-runtime.ts` via `isHydrating()` on the runtime surface, gates three main-thread behaviors for the duration of the hydrate transaction: (1) snapshot apply in the frame-runtime snapshot reconciler, (2) local physics step, and (3) `recoverLocalPhysicsAfterWorkerFailure`. The lock is released in a `finally` block covering both the success path and the rollback path.

**Rationale:** The rAF-driven frame runtime's snapshot reconciler races hydrate's awaited commits — a worker snapshot generated before the hydrate's `clearScene` can land on top of the seed commit, producing a scene that briefly contains the pre-hydrate structure. Without the lock, `executeFrame` would also run a local physics step against the partially-seeded state, and a mid-rollback worker failure would trigger `recoverLocalPhysicsAfterWorkerFailure` against the restored-prior state and clobber the rollback. Gating all three from a single boot-scope flag makes "hydration is a transaction" a mechanical invariant: the snapshot reconciler, physics step, and recovery hook all read the same gate, and the transactional module is the sole writer. Recovery itself is gated (not just the frame loop) because rollback is a legitimate state-writing path that must not be interrupted by a late worker failure.

**Evidence:** `setHydrationActive` dep injected into the transactional handoff module; `isHydrating()` on the frame-runtime surface; `recoverLocalPhysicsAfterWorkerFailure` consults the same flag.

## D127: Boot Defers the Default Scene When a Handoff Is Pending

**Decision:** Boot calls `_hasPendingWatchHandoff()` — a pure URL check with no storage access and no side effects — before the default-scene `addMoleculeToScene(c60)` call. When it returns true, boot skips the default scene entirely; the handoff hydrate is responsible for populating the scene. A fallback at the END of the handoff consume block loads the default when `physics.n === 0`, covering every failure path (stale-TTL / missing-entry / malformed / rollback).

**Rationale:** Unconditionally loading the default C60 before the handoff consumed meant the user saw ~500ms of C60 before hydrate replaced it — a visible flash that made the entry feel broken on slower devices. Deferring the default requires a pre-consume predicate that is cheap and side-effect-free so boot can make the skip decision without touching storage (which would race the hydrate's one-shot consume in D124). The URL carries the handoff token, making URL inspection the obvious pure signal. The end-of-consume fallback is the mirror of the skip: if hydrate produced no atoms for any reason, boot's skipped default is restored, so every failure mode converges on the same "user sees default scene" end state rather than "empty canvas."

**Alternatives rejected:** Load default and replace on hydrate (user-visible flash); have hydrate run before boot's default scene call with no skip predicate (ordering is fragile — any future boot refactor that moves default-scene loading risks re-introducing the flash); check storage directly in boot's skip predicate (races the one-shot consume in D124 and makes boot depend on storage state).

## D128: Handoff Failure-Copy Policy — User-Plausible Visible, Tampering Silent

**Decision:** The handoff consume block partitions rejection reasons into two policy classes with different user-facing behavior: (1) **user-plausible** — `stale` (TTL expired) and `missing-entry` (consumed / cleared / private-mode-dropped storage) surface visible copy to the user; (2) **tampering-or-drift** — `malformed`, `wrong-version`, `wrong-source`, `wrong-mode`, `parse-error`, and `missing-token` stay silent at the UI layer and emit a `console.warn` diagnostic only.

**Rationale:** Every rejection reason could in principle produce a toast or be silent; leaving the choice implicit scatters policy across the rejection call sites and drifts under refactor. Explicit partitioning makes the question "should this failure be visible?" answerable by category rather than case-by-case. TTL expiry and missing-entry are outcomes the user can plausibly cause through normal behavior (waited too long, closed the tab, used a private window that dropped storage) — they deserve an explanation. The remaining reasons signal either tampering (hand-crafted URL, malformed payload, mismatched source app) or schema drift (version mismatch across deploys); in both cases, visible copy either exposes internal detail to a bad actor or confuses users who did nothing wrong. Silent `console.warn` preserves the diagnostic signal for developers without surfacing policy-layer noise to end users. All rejection paths still fall through to the default-scene fallback in D127, so the user always lands on a usable state.

**UPDATE 2026-04-17:** Success copy policy is now explicit and symmetric with the silent-tampering branch: **there is no arrival provenance pill on hydrate success.** Successful hydrate is signaled by the rendered scene itself plus a structured `console.info` boot trace (`[lab.boot] watch handoff hydrated` — now extended with `velocitySource`, `unresolvedVelocityFraction`, `colorAssignmentCount`, `hasCamera`). The UI has no banner, no toast, and no badge indicating "this scene arrived from Watch." The Interact-From-Here-centric entry funnel (D124 update) is fast and transparent enough that explicit arrival attribution reads as noise; the `provenance` field on the seed is diagnostic state, not UI state. The arrival-pill / provenance-pill decision is reaffirmed under the current entry-control redesign — no pill was reintroduced alongside the primary+disclosure migration.

## D129: Watch Primary-Tooltip Auto-Cue — Per-File, Arm-Then-Fire, Paused-Seek Coalesced

**Decision:** The Watch primary CTA ("Interact From Here") fires a 5-second 1-3-1 tooltip cue (1 s fade-in, 3 s hold, 1 s fade-out) on two timeline milestones — **50 %** and **100 %** — under three invariants: (1) **once per file**, not once per session, with fired-state reset on `fileIdentity` change; (2) **arm-then-fire** — each milestone must be observed with `currentTimePs < threshold` at least once before it can fire; (3) **paused-seek coalescing** — at most one milestone per effect run, end-first (a paused scrub from 10 % → 95 % fires the end cue only, halfway is skipped). Reduced-motion collapses `--cue-y` / `--cue-s` to zero, preserving opacity phases only. A hidden `aria-live="polite"` sibling re-emits `"${primaryLabel}. ${tooltipCopy}"` on each firing. Encoded in `watch/js/hooks/use-timeline-milestone-tokens.ts` as `useTimelineMilestoneTokens(snapshot) → number`.

**Rationale:** Each invariant closes a specific misfire mode:

- **Once-per-file** (not per-session): users loading a new file should see the same discoverability cue — session-scoping would silently strand later-loaded files with no prompt.
- **Arm-then-fire**: a share-code deep-link that resumes at 80 % would otherwise flash both the 50 % and 100 % cues simultaneously at mount, since both thresholds are already crossed on first observation. Requiring each to be observed below-threshold at least once makes "passing through" a necessary condition for firing.
- **Paused-seek coalescing**: a user scrubbing past both thresholds while paused is expressing intent to reach a destination, not to watch the trajectory. Firing the end cue only (and skipping halfway) matches that intent without suppressing cues on normal playback, where the effect runs once per threshold cross.

**Shared hook extraction:** The animation-side of the cue lives in `src/ui/use-timed-cue.ts` — `useTimedCue({ triggerToken, durationMs }) → { active, animKey }` — encapsulating baseline-on-first-observation, duration timer, and `animKey` for React re-key-on-firing. Splitting milestone detection (`useTimelineMilestoneTokens`) from cue animation (`useTimedCue`) lets other surfaces reuse the cue primitive without inheriting timeline semantics. `TransferTrigger` in `lab/js/components/timeline-transfer-dialog.tsx` deliberately does **not** consume `useTimedCue` because its trigger shape (boolean event + 5 s-delay-then-show) differs from Watch's (token-change + immediate-show) — forcing a single hook across both would require parameterizing the delay model and lose the clarity of "token bumps mean fire now."

**Alternatives rejected:** Fire on every threshold cross (annoying on replay); fire once per session (strands later-loaded files); fire without arming (share-deep-links flash spuriously); fire every milestone crossed per effect run (paused scrubs spam two cues at once); merge `useTimedCue` and `useTimelineMilestoneTokens` into a single hook (couples timeline semantics to the cue primitive, blocks reuse).

**Evidence:** `watch/js/hooks/use-timeline-milestone-tokens.ts` (file-reset / arm-before-fire / seek-coalesce rules), `src/ui/use-timed-cue.ts` (shared cue primitive), `.watch-lab-entry__tooltip` CSS (opacity + `--cue-y` / `--cue-s` translate-and-scale phases), hidden `aria-live="polite"` announcer sibling.
