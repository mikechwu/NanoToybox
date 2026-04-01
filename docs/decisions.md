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
