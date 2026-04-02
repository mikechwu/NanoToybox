# Project Decisions

Key strategic and technical decisions made during development, with rationale.

## D1: Analytical Tersoff for First Website (not ML)

**Decision:** Use the analytical Tersoff potential for the first website version. Defer ML surrogates.

**Rationale:** Scaling benchmarks showed analytical Tersoff handles all target scenes (60–300 atoms) at interactive frame rates. The JavaScript implementation achieves sufficient performance for the target range without requiring Wasm. ML provided no speed advantage — descriptor computation has the same O(N·neighbors²) complexity as the analytical force. ML only becomes worthwhile for >1000 atoms with a GNN that avoids explicit descriptors.

**Update:** The interactive page (`page/`) now runs the full Tersoff potential with a C/Wasm kernel enabled by default (`config.ts` `useWasm: true`), providing ~11% speedup over JS JIT. Automatic fallback to JavaScript if Wasm fails to load. Physics runs on a dedicated Web Worker (`simulation-worker.ts`).

**Evidence:** dev_report_simdev9, dev_report_simdev10, page/js/physics.ts

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

**Update:** DockLayout, DockBar, Segmented, SettingsSheet, StructureChooser, StatusBar, FPSDisplay, and SheetOverlay are now React components (`page/js/components/`). UI state is owned by the Zustand store (`page/js/store/app-store.ts`). Placement mode is communicated via `placementActive` flag in the store; DockBar uses `selectDockSurface` (`store/selectors/dock.ts`) to conditionally render surface-specific controls (JSX branching, not CSS class toggling).

## D13: Controller Module Extraction

**Decision:** Extract the monolithic main.ts into focused controller modules with explicit state ownership, dependency injection, and full lifecycle teardown.

**Rationale:** The Phase 3 dock+sheet restructure created natural module boundaries. Controllers receive dependencies at construction, don't cross-import each other, and all expose destroy(). main.ts remains the composition root and runtime orchestration layer.

**Update:** `DockController`, `SettingsSheetController`, and `OverlayController` have been removed — those roles are now handled by React components. Only `PlacementController` (canvas touch listeners) and `StatusController` (hint/coachmark, hint-only) remain as class-based controllers with `destroy()` lifecycles.

## D14: Simulation Web Worker

**Decision:** Run `PhysicsEngine` on a dedicated Web Worker thread (`simulation-worker.ts`). The main thread communicates via a typed command/event protocol managed by `WorkerBridge` (`worker-bridge.ts`).

**Rationale:** Moves the O(N·neighbors²) Tersoff force computation off the main thread, preventing jank on the render/input thread. The protocol provides mutation acks with scene versioning, `requestFrame`/`frameResult` round-trip for position snapshots, and generation bumping to invalidate in-flight requests on scene clear. Automatic fallback to sync-mode physics if the worker fails or stalls (5s warning, 15s fatal).

**Evidence:** `page/js/simulation-worker.ts`, `page/js/worker-bridge.ts`, `src/types/worker-protocol.ts`, `page/js/runtime/worker-lifecycle.ts`, `page/js/runtime/snapshot-reconciler.ts`

## D15: React + Zustand for UI Chrome

**Decision:** Adopt React 19 (`createRoot`) for all UI chrome components and Zustand for shared UI state. Physics/renderer/worker state stays imperative outside the store.

**Rationale:** The imperative DOM controllers required explicit sync of every state change to the DOM. React provides declarative re-renders; Zustand provides a single, typed, subscribable state surface. Diagnostics and playback metrics are throttled to 5 Hz via the frame loop's coalesced status tick, avoiding per-frame React re-renders. Imperative callbacks from main.ts are registered into the store (`dockCallbacks`, `settingsCallbacks`, `chooserCallbacks`) so React components can invoke them without importing main.ts.

**Evidence:** `page/js/react-root.tsx`, `page/js/store/app-store.ts`, `page/js/components/` (DockLayout.tsx, DockBar.tsx, Segmented.tsx, SettingsSheet.tsx, StructureChooser.tsx, StatusBar.tsx, FPSDisplay.tsx, SheetOverlay.tsx)

## D16: Interactive Triad + Mobile Camera Orbit

**Decision:** Make the XYZ axis triad interactive for mobile camera orbit. Add background orbit on empty-space touch miss. No dedicated camera mode button.

**Rationale:** Desktop users orbit via right-drag, but touch devices had no orbit gesture. The triad is the primary mobile orbit control because it is always visible and works regardless of scene density. Background orbit (1-finger on empty space) is a secondary convenience — unreliable in dense scenes where atoms fill the viewport. Both gestures use the same rotation convention (drag-up = camera rotates down). Gesture priority: triad hit > atom raycast > background orbit. Atom hit always wins — no heuristics. Three triad gesture levels: drag=orbit, tap-axis=snap-to-canonical-view (±X/±Y/±Z), double-tap-center=reset. Dynamic `controls.touches.ONE` toggle per-gesture for background orbit. `CONFIG.isTouchInteraction()` (coarse pointer + no hover) gates mobile-only behavior — stable across resize, excludes hybrid desktops.

**Evidence:** `page/js/input.ts` (triad drag/tap/double-tap, background orbit), `page/js/renderer.ts` (applyOrbitDelta, snapToAxis, animatedResetView, getNearestAxisEndpoint, showAxisHighlight, pulseTriad), `page/js/config.ts` (CONFIG.orbit, isTouchInteraction), `page/js/runtime/input-bindings.ts` (triad source wiring), `docs/testing.md` (B1-B8, C1-C6, D1-D9)

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

**Evidence:** `page/js/components/CameraControls.tsx`, `page/js/components/OnboardingOverlay.tsx`, `page/js/renderer.ts` (applyFreeLookDelta, resetOrientation, setOrbitControlsForMode), `page/js/input.ts` (mode-aware routing), `page/js/runtime/onboarding.ts`, `page/js/runtime/focus-runtime.ts` (ensureFollowTarget), `page/js/store/app-store.ts` (cameraMode, orbitFollowEnabled, onboardingPhase, cameraCallbacks)

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

**Evidence:** `page/js/runtime/timeline-recording-policy.ts`, `page/js/runtime/interaction-dispatch.ts`, `tests/unit/interaction-dispatch-arming.test.ts`, `tests/unit/store-callbacks-arming.test.ts`

## D21: Object View Panel

**Decision:** Replace the old camera chip cluster (Orbit label + "?" + ⊕) with an explicit Object View panel containing Center and Follow buttons with inline SVG icons.

**Rationale:** The old cluster relied on hidden gestures (long-press for follow, "?" glyph for help) that were not discoverable. Center and Follow are now separate visible buttons. Follow uses `ensureFollowTarget()`: resolve a valid target first, then enable tracking. If no molecules exist, follow stays off. Touch devices show secondary hint text; desktop uses title tooltips. The panel is positioned below the status block via `[data-status-root]` layout anchor with named tokens (`STATUS_TO_OBJECT_VIEW_GAP`, `OBJECT_VIEW_FALLBACK_TOP`, `SAFE_EDGE_INSET`).

**Evidence:** `page/js/components/CameraControls.tsx`, `page/js/components/Icons.tsx`, `page/js/runtime/focus-runtime.ts` (ensureFollowTarget), `page/js/runtime/overlay-layout.ts`, `tests/unit/camera-controls-render.test.tsx`, `tests/unit/focus-runtime.test.ts`

## D22: Page-Load Onboarding Overlay

**Decision:** Show a welcome overlay on each page load. Page-lifetime dismissal only (no localStorage persistence). Reappears on reload.

**Rationale:** The overlay teaches that guidance lives in Settings via a two-phase sink animation (~950ms) toward the Settings button. A reactive readiness gate (`subscribeOnboardingReadiness()`) waits for atomCount > 0 and no blockers (sheets, placement, review) before showing. The Settings button receives a highlight class during the sink animation. `?e2e=1` debug param suppresses in E2E tests (via `getDebugParam()`).

**Evidence:** `page/js/components/OnboardingOverlay.tsx`, `page/js/runtime/onboarding.ts` (isOnboardingEligible, subscribeOnboardingReadiness), `page/js/store/app-store.ts` (onboardingPhase), `page/js/config.ts` (getDebugParam), `tests/unit/onboarding-overlay.test.tsx`, `tests/e2e/camera-onboarding.spec.ts`

## D23: Inline SVG Icon System

**Decision:** Shared `Icons.tsx` with 10 inline SVG icon components used across DockBar and CameraControls.

**Rationale:** Consistent visual language with accessibility defaults (`aria-hidden`, `focusable={false}`). Icons use a 20x20 viewBox with currentColor stroke. Optional `size`, `strokeWidth`, `title`, `className` props for responsive refinement. DockBar uses Add, Check, Cancel, Pause, Resume, Settings. CameraControls uses Center, Follow, Freeze, Return.

**Evidence:** `page/js/components/Icons.tsx`, `page/js/components/DockBar.tsx`, `page/js/components/CameraControls.tsx`

## D24: Mode-Aware Interaction Group Highlight

**Decision:** Highlight the full bonded group during Move and Rotate interactions, not just the picked atom. Atom mode continues to highlight a single atom. Hover preview reflects the upcoming action scope before pointer-down.

**Rationale:** Physics applies force to the full connected component in Move and Rotate modes. Highlighting only the picked atom made the interaction appear narrower than it actually was. The resolver (`interaction-highlight-runtime.ts`) maps interaction state + session mode to the correct highlight target using live `physics.componentId` / `physics.components`. The renderer has separate interaction and panel highlight channels so bonded-group panel selection is not clobbered. Interaction highlight takes visual priority; panel highlight restores automatically when interaction ends. Review mode clears both channels.

**Evidence:** `page/js/runtime/interaction-highlight-runtime.ts`, `page/js/renderer.ts` (setInteractionHighlightedAtoms, clearInteractionHighlight, updateFeedback with sessionMode), `page/js/main.ts` (resolveInteractionHighlight in frame loop), `tests/unit/interaction-highlight.test.ts`, `tests/unit/renderer-interaction-highlight.test.ts`

## D25: Placement Orientation — Camera-First Vertical-Preferred Policy

**Decision:** `chooseCameraFamily()` uses a camera-first vertical-preferred policy as the base orientation preference. It prefers `camera.up` unless the molecule's primary axis has a vertical fraction below 0.25 (`VERT_READABLE_THRESHOLD`), in which case it falls to `camera.right`.

**Rationale:** Molecules displayed upright relative to the user's viewport are the most immediately readable default. The threshold prevents degenerate near-horizontal alignments from being forced vertical — when m1 is nearly parallel to the camera's right axis, the vertical family would produce a foreshortened, unreadable orientation. If the primary axis is foreshortened in the camera plane entirely (`PROJ_WEAK`), an m2 fallback is attempted before defaulting to vertical.

**Evidence:** `page/js/runtime/placement-solver.ts` (chooseCameraFamily, VERT_READABLE_THRESHOLD = 0.25)

## D26: Geometry-Aware Family Selection as Final Runtime Arbiter

**Decision:** `selectOrientationByGeometry()` is the final runtime arbiter for orientation family. It evaluates both candidate families (up and right) by projecting atoms under each candidate rotation and scoring projected readability (extent along the target axis). Vertical wins ties — the right family must score more than `GEOMETRY_FAMILY_SWITCH_MARGIN` (20%) higher than up to override the vertical preference.

**Rationale:** `chooseCameraFamily()` operates on the molecule's intrinsic frame axes and the camera, without seeing how the actual atom cloud appears after rotation. The geometry-aware selector closes this gap by scoring what the user will actually see. Both candidate rotations are fully built and projected before comparison, so the decision is grounded in observable readability, not axis algebra alone. The 20% margin prevents jittery family flipping when both orientations are similarly readable.

**Evidence:** `page/js/runtime/placement-solver.ts` (selectOrientationByGeometry, GEOMETRY_FAMILY_SWITCH_MARGIN = 0.2, scoreProjectedReadability)

## D27: Perspective-Projected 2D PCA Geometry Refinement

**Decision:** After family selection, `refineOrientationFromGeometry()` applies a corrective twist around `camera.forward` using perspective-projected 2D PCA of the atom cloud. The refinement is adaptive (up to 2 convergence passes) with correction clamped to `BASE_GEOMETRY_CORRECTION` (~6.9 deg), doubled for high-anisotropy shapes (ratio > 3). Convergence exits early when residual error drops below 0.17 deg.

**Rationale:** The frame-alignment rotation places the molecule's intrinsic axis near the policy target, but residual twist can leave the visible silhouette rotated away from the intended screen-space direction. Perspective projection (not orthographic) is used so the refinement optimizes exactly what the user sees. The clamp prevents over-rotation from noisy PCA on near-circular projections. Two passes handle cases where the first correction shifts the silhouette enough to reveal a second-order error.

**Evidence:** `page/js/runtime/placement-solver.ts` (refineOrientationFromGeometry, computeGeometryError, projected2DPCA, BASE_GEOMETRY_CORRECTION = 0.12)

## D28: Scored Regime Classification (Planarity Wins Ties)

**Decision:** `classifyFrameMode()` uses scored comparison of planarity (mid/minor eigenvalue ratio) and elongation (major/mid eigenvalue ratio). Both scores are normalized against their respective thresholds. When both exceed 1.0, the higher score wins, with planarity winning ties.

**Rationale:** The original threshold-order classification checked elongation first, causing thin sheets like graphene to misroute through the line-dominant solver when their major/mid ratio happened to exceed the elongation threshold. Scored comparison fixes this: graphene's mid/minor ratio (planarity) is much stronger than its major/mid ratio (elongation), so it correctly routes through the plane-facing solver. Planarity wins ties because thin sheets benefit more from the plane-facing solver than near-round rods benefit from the line solver.

**Evidence:** `page/js/runtime/placement-solver.ts` (classifyFrameMode, lineScore, planeScore)

## D29: No Vertical Bias — Purely Readability-Driven Solver

**Decision:** The placement solver contains no vertical styling bias or override. Orientation is determined entirely by readability scoring (D25–D28). There is no additive score bonus, no post-hoc rotation toward vertical, and no user-facing "prefer upright" toggle.

**Rationale:** An earlier iteration applied a vertical bias to make molecules "look nicer" by tilting them upright regardless of geometry. This created incorrect orientations for molecules whose readable axis was horizontal in the camera frame (e.g., a CNT viewed from the side). The vertical preference in `chooseCameraFamily()` (D25) provides a soft default, but it is overridable by geometry scoring (D26), keeping the solver purely readability-driven.

**Evidence:** `page/js/runtime/placement-solver.ts` (no VERTICAL_BIAS constant, no bias term in scoring)

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

**Evidence:** `page/js/renderer.ts` (panel and interaction InstancedMesh instances, renderOrder 2 and 3)

## D32: Highlight Setters Are State-Only — Single Compositor

**Decision:** Highlight setters are state-only — all rendering flows through a single compositor (`_updateGroupHighlight`). This gives one rendering truth path and makes overlap computation deterministic.

**Rationale:** When setters both stored state and directly mutated mesh attributes, multiple code paths could produce highlight visuals, making it impossible to reason about what the user actually sees. Separating concerns — setters write to state arrays, a single compositor reads them and writes to both meshes — ensures every visual update goes through one code path. Overlap computation (atoms in both panel and interaction sets) happens in exactly one place, eliminating the class of bugs where two renderers disagree.

**Evidence:** `page/js/renderer.ts` (`_updateGroupHighlight` as sole rendering path for both highlight meshes)

## D33: Overlap Atoms Rendered on Both Layers

**Decision:** Overlap atoms rendered on both layers (panelOnly + overlap on panel mesh, interactionOnly + overlap on interaction mesh). This makes "same atom in both states" a first-class visual behavior.

**Rationale:** When an atom belongs to both the panel selection and the interaction highlight, it must be visually present on both meshes so that neither layer appears to have a hole. The compositor partitions atoms into three sets: panelOnly, interactionOnly, and overlap. Overlap atoms are written to both meshes with their respective colors, ensuring that removing the interaction highlight reveals the panel highlight underneath without a flash or gap. This partition is computed from the state arrays on every compositor pass, so it is always consistent with the current selection.

**Evidence:** `page/js/renderer.ts` (`_updateGroupHighlight` overlap set computation and dual-mesh writes)

## D34: CONFIG.groupHighlight Renamed to CONFIG.panelHighlight

**Decision:** `CONFIG.groupHighlight` renamed to `CONFIG.panelHighlight`. Interaction highlight tokens moved from hardcoded renderer values to `CONFIG.interactionHighlight`. Vocabulary now matches architecture.

**Rationale:** The old name `groupHighlight` was ambiguous — it could refer to any group-level highlight, but it only controlled the panel selection appearance. Renaming to `panelHighlight` makes the config key self-documenting for the two-layer architecture. Extracting interaction highlight parameters (color, opacity) from hardcoded values in the renderer into `CONFIG.interactionHighlight` makes both layers configurable in the same way and discoverable in the same config namespace. The vocabulary (panel vs. interaction) now matches the mesh layer names, the compositor logic, and the public API.

**Evidence:** `page/js/config.ts` (`CONFIG.panelHighlight`, `CONFIG.interactionHighlight`)
