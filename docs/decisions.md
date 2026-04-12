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

**Evidence:** `src/topology/build-bond-topology.ts` (`buildBondTopologyFromPositions`), `watch/js/reduced-history-import.ts` (builds `elementById` map with uniqueness validation)
