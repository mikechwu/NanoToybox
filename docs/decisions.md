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
