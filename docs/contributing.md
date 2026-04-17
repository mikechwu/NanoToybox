# Contributing & Development Guide

## For New Developers (and New Claude Sessions)

Read these docs in order:
1. `README.md` — project overview and quick start
2. `architecture.md` — where everything lives
3. `physics.md` — how the simulator works
4. `decisions.md` — why things are the way they are

Then run the test suite to verify the codebase is healthy:
```bash
python3 tests/test_01_dimer.py && echo "Test 1 OK"
python3 tests/test_02_angular.py && echo "Test 2 OK"
```

## Ultimate Goal

Build an **immersive, interactive, scientifically accurate browser-based playground** for carbon nanostructures. Users explore C60, graphene, CNTs, and diamond with real-time molecular dynamics running in the browser.

The long-term vision:
- Real physics (Tersoff potential, velocity Verlet)
- Real-time (>30 FPS for 60–300 atom scenes, up to ~2,100 atoms with optimized viewer)
- Beautiful visualization (Three.js, perspective 3D)
- Educational and accessible (not just for specialists)
- Expandable to ML surrogates for larger systems later

Measured limits (see [scaling-research.md](scaling-research.md)):
- Numba Tersoff: 30 FPS up to ~2,100 atoms; C/Wasm (browser): ~3,000–5,000 atoms (measured ~11% faster than JS JIT)
- Interactive page (InstancedMesh + spatial hash + Wasm): ~2,400 atoms at 30 FPS
- Legacy trajectory viewer (`viewer/`): ~250 atoms at 30 FPS (still O(N²) individual meshes); superseded by `watch/` for history playback
- Optimized viewer (InstancedMesh + neighbor list): ~5,000–10,000 atoms

## Rules to Obey

### Physics First
1. **Never approximate physics without validation.** Every force implementation must pass finite-difference checks (Tests 1, 2, 7).
2. **Energy conservation is non-negotiable.** NVE drift must be < 1e-3 for any accepted simulation.
3. **All library structures must be relaxed** to Fmax < 1e-3 eV/Å via the multi-minimizer pipeline.
4. **Don't skip the test ladder.** Tests 1-2 must pass before Tests 3-4 are meaningful.

### Code Quality
5. **Use Numba (`tersoff_fast.py`) for production**, pure Python (`tersoff.py`) for reference/validation.
6. **Keep the two implementations in sync.** Any physics change must be made in both files.
7. **Use the library CLI** to add structures — never hand-place atoms in XYZ files.
8. **Explicit Euler is forbidden.** Use velocity Verlet only.

### Architecture
9. **Don't restart ML work** unless >1000 atoms are needed or a GNN framework is available.
10. **Preserve all validation tests.** Don't delete tests even if they seem redundant.
11. **Don't add periodic boundaries** unless there's a clear product need.

### Process
12. **Run tests before claiming anything works.**
13. **Document decisions** in `docs/decisions.md` when making significant changes.
14. **Update `manifest.json`** when modifying the structure library.

## Completed Milestones

- Real-time Tersoff simulation in the browser (`lab/js/physics.ts`)
- Interactive page with drag/rotate/structure presets (`lab/index.html`)
- Camera-plane force projection (forces align with user's visual perspective)
- Inertia-normalized rotation (consistent feel across molecule sizes)
- Interactive 3D axis triad (drag=orbit, tap=snap, double-tap=reset on mobile), dark/light themes, dock + sheet settings
- InstancedMesh rendering — 2 draw calls for atoms+bonds, geometric capacity growth (`lab/js/renderer.ts`)
- On-the-fly Tersoff kernel — 45% faster than cached at 2040 atoms, eliminates 127 MB N×N cache (`lab/js/physics.ts`)
- Cell-list spatial acceleration — O(N) neighbor and bond detection instead of O(N²) (`lab/js/physics.ts`)
- C/Wasm Tersoff kernel — ~11% faster than JS JIT, enabled by default, automatic JS fallback (`sim/wasm/`, `lab/js/tersoff-wasm.ts`)
- Containment boundary — dynamic soft harmonic wall (`lab/js/physics.ts`), Contain/Remove toggle, live atom count, auto-scaling radius with hysteresis shrinkage
- Dock + sheet navigation — responsive two-tier UI with React components (`lab/js/components/`)
- React UI migration — primary surfaces (DockLayout, DockBar, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay, CameraControls, OnboardingOverlay, BondedGroupsPanel, TimelineBar) are React-authoritative with Zustand store. Supporting subcomponents: Segmented, Icons. TimelineBar is a composition layer with helper modules: timeline-format.ts, timeline-mode-switch.tsx, timeline-clear-dialog.tsx, timeline-hints.ts
- Web Worker physics — off-thread simulation via `lab/js/simulation-worker.ts` with automatic JS fallback
- Runtime module extraction — feature modules in `lab/js/runtime/`, orchestration modules in `lab/js/app/` (frame-runtime, app-lifecycle); see `docs/architecture.md` for the full inventory. main.ts is the composition root
- Object View panel — Center + Follow buttons with inline SVG icons, positioned below status block
- Page-load onboarding overlay — welcome card with sink-to-Settings animation, page-lifetime dismissal
- History file export — v1 `atomdojo-history` format with atom identity tracking (stable IDs across append/compaction), atom metadata registry (element, source provenance), export capability lifecycle (subsystem-owned, staleness-guarded), export validation (monotonic ordering, atom table integrity, per-frame atomId uniqueness), and export UI (capability-gated trigger, portaled dialog, mutual exclusion with clear dialog)
- Watch v1 — History File Import & Playback: shared schema module extraction (`src/history/history-file-v1.ts`: types, detection, shape-safe validation), connected-components extraction (`src/history/connected-components.ts`), bonded-group projection extraction (`src/history/bonded-group-projection.ts`), lab refactoring (bonded-group-runtime → thin store adapter, history-export → imports shared types, simulation-timeline → uses shared connected-components), watch app shell with file-open landing and playback workspace, two-step file detection (detect kind → apply support policy), full-history import with normalization (Float64Array, tuple bonds), playback model with 4 separated sampling channels and time clamping, renderer adapter over lab Renderer, memoized bonded-group analysis via shared projection
- Watch Review-Parity — React Shell + Shared CSS + Type Consolidation: React shell for watch (controller + 6 components + react-root), watch-controller.ts with RAF clock / useSyncExternalStore snapshots / transactional file open with rollback, shared review-parity CSS (`src/ui/review-parity.css`) with neutral `.review-*` class names, `partitionBondedGroups` extracted to `src/history/bonded-group-utils.ts`, `BondedGroupSummary` consolidated to single source (app-store re-exports from shared), `watch/index.html` reduced to minimal `#watch-root` mount node, `watch/js/main.ts` reduced to thin bootstrap, canonical x1 playback rate from `CONFIG.playback.baseSimRatePsPerSecond`, `tsconfig.json` updated to include `watch/js/`
- Watch Rounds 3-5 — Interaction parity, appearance domain, transport & settings: hover/follow/center commands, bonded-groups panel with color editing, overlay layout, camera input (orbit/pan/zoom), appearance domain (`watch-bonded-group-appearance.ts`), settings surface (theme + text size), playback speed control (0.5x–20x), repeat mode, step forward/backward, directional playback via unified `_playDirection` (0|1|-1), shared CSS modules extracted to `src/ui/` (design tokens, dock, sheet, segmented, timeline, layout), shared TS modules extracted to `src/input/`, `src/appearance/`, `src/config/`
- Watch Round 6 — Interpolation runtime: shared physical constants (`src/history/units.ts`), interpolation runtime with extension-oriented strategy registry (`watch/js/watch-trajectory-interpolation.ts`), three built-in strategies (Linear stable, Hermite + Catmull-Rom experimental), per-bracket capability layer (`InterpolationCapability` from importer), cursor-cache fast path for sequential playback, unified pipeline rule (`applyReviewFrameAtTime()` is sole caller of `interpolation.resolve()` + `renderer.updateReviewFrame()`), interpolation mode types in settings (`WatchInterpolationMode`, `PRODUCT_INTERPOLATION_MODE_IDS`), import diagnostics (`ImportDiagnostic`), CSS tokens scoped to `.watch-workspace`
- Shared Bond Topology Refactor — extraction of bond-topology computation from PhysicsEngine into reusable shared modules (`src/topology/`): naive builder (loader path), accelerated builder (physics hot path with buffer reuse), shared `BondRuleSet` contract (`bond-rules.ts`), bond-policy defaults (`src/config/bond-defaults.ts`), bond-policy resolver (`bond-policy-resolver.ts`), `lab/js/physics.ts` delegates bond building to shared topology builders
- Watch Topology Reconstruction — topology-source abstraction with stored (full-history) and reconstructed (reduced-file) sources, reduced-file schema and import with semantic validation, bond-policy metadata and resolution (`src/history/bond-policy-v1.ts`), stable `atomId` element lookup, watch now supports reduced files with on-import topology reconstruction
- Playback Capsule (Phases 1-4) — capsule file format and shared types in `src/history/history-file-v1.ts`, capsule importer (`watch/js/capsule-history-import.ts` replacing `reduced-history-import.ts`), appearance export/import, sparse interaction data contract, Lab capsule export builder with capsule/full export kinds (replay removed from export UI), stable-ID appearance model (Lab renderer and export use stable `atomId`s), golden parity validation
- Watch Cinematic Camera — default-on auto-framing: pure math module (`src/camera/cinematic-camera.ts`), camera-interaction-gate, service adapter (`watch-cinematic-camera.ts`), phase-aware gesture tracking, WatchCinematicCameraToggle UI, 4 snapshot fields, controller wiring with narrowed RAF error handling

## Architecture Rules

See `docs/architecture.md` for the full module map and state ownership model.

### Shared Modules (`src/`)

Shared TypeScript and CSS modules live in `src/` and are imported by both `lab/` and `watch/`. When adding new cross-app primitives, put them in the appropriate `src/` subdirectory rather than in `lab/` or `watch/`.

| Directory | Contents |
|-----------|----------|
| `src/ui/` | Design tokens and structural CSS (core-tokens, dock-shell, sheet-shell, segmented, timeline-track, bottom-region, text-size-tokens, bonded-groups-parity, device-mode helper), shared React hooks (`useSheetLifecycle`) |
| `src/input/` | Camera gesture constants shared across both apps |
| `src/appearance/` | Bonded-group color assignment logic (shared between lab appearance runtime and watch appearance domain) |
| `src/camera/` | Cinematic camera speed profile, target resolver, cooldown predicate (`cinematic-camera.ts`); event-attribution gate distinguishing user OrbitControls gestures from programmatic updates (`camera-interaction-gate.ts`) |
| `src/topology/` | Bond rules (`bond-rules.ts`), topology builders (`build-bond-topology.ts`: naive + accelerated), policy resolution (`bond-policy-resolver.ts`) |
| `src/config/` | Playback speed constants, viewer defaults (base sim rate, etc.), bond-policy defaults (`bond-defaults.ts`) |
| `src/history/` | History file v1 types/validation (including capsule types), connected components, bonded-group projection/utils, physical unit constants (`units.ts`: `FS_PER_PS`, `IMPLAUSIBLE_VELOCITY_A_PER_FS`), bond-policy wire types (`bond-policy-v1.ts`) |
| `src/types/` | Worker protocol types |

### CSS Architecture

Design tokens and structural CSS are shared via `src/ui/`. Both apps import these shared stylesheets. App-specific overrides stay in their own locations:
- **Lab**: `lab/index.html` (inline styles and app-specific CSS)
- **Watch**: `watch/css/` (`watch.css`, `watch-dock.css`) — CSS custom properties are scoped to `.watch-workspace`, not `:root`

Do not duplicate shared CSS in app-local files. When adding a new shared CSS primitive (e.g., a new component class or design token), add it to the appropriate file in `src/ui/`.

### Icons

Shared icons live in `lab/js/components/Icons.tsx`. Both lab and watch import from there. (This will move to `src/ui/` in a future round.)

### Lab Architecture

- **React components are the sole UI authority.** Primary surfaces (DockLayout, DockBar, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, FPSDisplay, CameraControls, OnboardingOverlay, BondedGroupsPanel, TimelineBar) are React-authoritative. Supporting subcomponents (Segmented, Icons) are composed by those surfaces; some are pure prop-driven helpers. TimelineBar is a composition layer delegating to helper modules (timeline-format.ts, timeline-mode-switch.tsx, timeline-clear-dialog.tsx, timeline-hints.ts). TimelineCallbacks includes onEnterReview for transitioning from live to review mode.
- **Timeline hint copy lives in `timeline-hints.ts`.** All tooltip text for timeline controls (record, review, restart, clear) is defined as constants in `lab/js/components/timeline-hints.ts`. Do not scatter timeline hint copy inline in components -- import from `TIMELINE_HINTS`.
- **ActionHint supports layout-aware wrapping.** `anchorClassName` and `anchorStyle` props let the wrapper span participate in parent layout (flex, grid, absolute positioning) without an extra wrapper element.
- **Imperative controllers** remain only for PlacementController (canvas touch listeners) and StatusController (hint/coachmark surface). Both expose `destroy()`.
- **Callbacks flow through the store.** React components invoke imperative callbacks (dockCallbacks, settingsCallbacks, chooserCallbacks) registered by main.ts into the Zustand store.
- **New globals require teardown.** Register via `addGlobalListener()` in main.ts.
- **Do not re-grow main.ts.** Route new code by kind:
  - **Feature-specific runtime behavior** → `lab/js/runtime/` (e.g. highlight resolver, placement solver, snapshot reconciler)
  - **Orchestration (frame sequencing, teardown order)** → `lab/js/app/` (e.g. frame-runtime.ts, app-lifecycle.ts)
  - **New UI surfaces** → `lab/js/components/` (React components, Zustand-driven)
- **State writes go through authoritative writers.** See state ownership table in architecture.md.

### Owner Map / Routing Guide

| File / Folder | Owns | Notes |
|---------------|------|-------|
| `main.ts` | Composition root — wires subsystems, owns RAF start/stop, registers global listeners | Nothing else should attach `window` listeners or call `requestAnimationFrame` directly. Narrow carve-out: **one-shot paint-deferral primitives** (e.g. `components/timeline-after-paint.ts`'s `scheduleAfterNextPaint`) may call rAF from UI components to yield a paint before expensive main-thread work (INP hygiene). These are fire-once (work → done, with cancel) and must not own a sustained frame loop — that remains `main.ts` / `app/frame-runtime.ts` territory. |
| `app/frame-runtime.ts` | Per-frame sequencing (physics → reconcile → feedback → highlight → record → render → status) | Ordering invariants live here, not in main.ts |
| `app/app-lifecycle.ts` | Teardown sequencing (ordered destroy of all runtime subsystems) | Dependency-aware order; see numbered list in its module header |
| `runtime/*` | Feature-specific runtime behavior (one module per concern) | Each module has its own contract header (see below) |
| `components/*` | React UI surfaces — sole authority for their DOM subtree | Communicate with runtime via Zustand store + registered callbacks |

### New Runtime Module Contract

Every `lab/js/runtime/*.ts` **and** `lab/js/app/*.ts` module must start with a contract header:

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

Rules:
- One active owner per concern — if two modules write the same state, the boundary is wrong
- Modules do NOT attach global listeners or write to `window` — main.ts wires those
- Teardown is the creator's responsibility
- Comments must never be stronger than code (no "single source of truth" without test evidence)

### Scene Mutation Primitives

Scene-content replacement goes through the same two primitives the native commit-molecule flow uses: `clearScene` + `appendMolecule`. This is the canonical path for any code replacing scene contents — file open, Watch→Lab handoff hydrate, test harness, structure-chooser swap.

- **Do not use `restoreCheckpoint` + `restoreState` for scene replacement.** `restoreCheckpoint` is reserved for transactional rollback (undoing a committed-then-failed mutation). Using it as a normal "set the scene" path conflates rollback with forward mutation and loses the invariant that `restoreCheckpoint` is always recovering from a known-good prior commit.
- Main-thread physics and worker both accept the same primitives; the transactional pattern below composes them.

### Worker Protocol: `{ ok: boolean }` Return Shape

`workerRuntime.init`, `restoreState`, `clearScene`, and `appendMolecule` all return `{ ok: boolean, ... }`. Callers **must** check `ok` and surface failures — either by triggering rollback (inside a transaction) or by calling `setStatusError` (outside one).

Void-returning worker calls that silently drop logical failures are the anti-pattern. The previous `restoreState: Promise<void>` shape was migrated precisely because a rejected worker op became indistinguishable from a successful one at the call site. New worker operations follow the `{ ok }` contract.

### Transactional Scene Mutation Pattern

The Watch→Lab hydrate module (`lab/js/runtime/hydrate-from-watch-seed.ts`) is the exemplar. Any code that mutates scene state across both main-thread physics and the worker — and must be atomic from the user's perspective — follows this shape:

1. **Capture rollback state** — physics checkpoint, boundary, scene state, registry snapshot, tracker snapshot, **appearance snapshot** (`bondedGroupAppearanceRuntime.snapshotAssignments()`), and **camera snapshot** (`renderer.getOrbitCameraSnapshot()`). Enough to fully restore the prior scene (including color and camera pose) if any later step throws.
2. **Stage the renderer** — prepare renderer state that can be unwound without a commit.
3. **Commit main-thread physics** via `appendMolecule` (following `clearScene` if replacing). When the seed carries `velocities`, they're handed to the worker's `appendMolecule` command (see "Worker velocity delivery" below) so the first post-append snapshot carries real motion state — not a zeroed frame.
4. **Commit worker** via `clearScene` + `appendMolecule`, checking `{ ok }` on each.
5. **Finalize** registry, tracker, and scene-state bookkeeping.
6. **Rebuild renderer, then apply camera and color** — after the renderer rebuild, call `renderer.applyOrbitCameraSnapshot(seed.camera)` (or fall back to `renderer.fitCamera()` when `camera === null`), then `bondedGroupAppearanceRuntime.restoreAssignments(reindexed)` unconditionally on the success path (REPLACE semantics — an empty array wipes any prior Lab color state).
7. **Publish** the post-commit signal (`onHydrated` or equivalent).

Any throw in steps 2–6 triggers **full rollback** from the captured state, including `restoreAssignments(capture.appearance)` and `applyOrbitCameraSnapshot(capture.camera)`. `rollback-also-failed` is a first-class `HydrateFailureReason` — if the rollback itself throws, that is a distinct classified failure, not a swallowed log line. Rollback sub-failures are accumulated into `cause: { originatingCause, rollbackSubFailures }` rather than swallowed.

### Hydration Lock Pattern (Boot-Scope Transactional Guards)

Long-running transactional mutations that run during or shortly after boot need a module-level guard so global-recovery callbacks don't interfere. The Watch→Lab hydrate uses this shape:

- **Module-level flag** in `main.ts`: `let _hydrationActive = false` (or similar).
- **Setter threaded through deps**: `setHydrationActive?: (active: boolean) => void` on the transaction's dependency bag.
- **Reader on the frame-runtime surface**: `isHydrating(): boolean` so other runtime modules can check it.
- **`finally` block releases the lock** on every exit path: success, classified rollback, and rollback-also-failed. Never leave the lock held on an error path.
- **Global recovery callbacks check the lock** — e.g., `recoverLocalPhysicsAfterWorkerFailure` and similar cross-cutting handlers early-return when `isHydrating()` is true and let the in-flight transaction's own rollback handle the failure. Two recoveries racing on the same crash corrupt state.

### Boot Order: Pure URL Checks, Late Storage Consume

Early boot-time checks that decide "do we have work queued from a prior surface?" **must be pure URL reads — no localStorage access, no side effects.** `_hasPendingWatchHandoff()` reads `window.location` only.

The destructive consume (`consumeWatchToLabHandoffFromLocation`) runs **later**, once subsystems (physics, worker, renderer) are ready to receive the payload. Pattern: **ask the URL early, consume storage late.** Consuming storage before subsystems are ready means a failed hydrate leaves the handoff already drained, so retry is impossible and the user loses the work silently.

### Watch→Lab Handoff (Continue-Flow Entry)

The Watch-side entry control projects the current Watch frame into a Lab hydrate token and navigates to Lab with the token referenced on the URL. Lab then consumes the token from localStorage and hydrates via the transactional pattern above. There is no arrival pill / provenance banner on the Lab side — hydrate success is signaled only by the rendered scene plus a `[lab.boot] watch handoff hydrated` console.info trace.

**Entry control shape** (`watch/js/components/watch-lab-entry-control.tsx`): a single accent-filled primary pill **"Interact From Here"** plus a caret `▼` that toggles a disclosure popover. The popover exposes the secondary action **"Open a Fresh Lab"** ("Starts with a default molecule. Build and experiment from there."). The primary tooltip copy ("Take over from this exact frame. Drag atoms and watch the physics react.") is a module-local const — not exported.

- **Disclosure, not menu.** The caret uses `aria-haspopup="true"` / `aria-expanded`; the popover is `role="group"` with `aria-label="More ways to open Lab"`. Do NOT add `role="menu"` / `role="menuitem"` — the regression tests and E2E spec pin disclosure semantics.
- **Mutual exclusion with hover tooltip.** React sets `data-menu-open="true"` on `.watch-lab-entry` whenever the popover is open; CSS `:has(…)` suppresses the hover tooltip. The two affordances never co-render.
- **Always opens above** the capsule at every viewport, to avoid overlap with the Cinematic toggle, timeline, and dock.
- **CSS class contract** (preserved for E2E): `.watch-lab-entry`, `.watch-lab-entry__primary`, `.watch-lab-entry__secondary`, `.watch-lab-entry__tooltip`, `.watch-lab-entry__caret`. Menu-item classes are gone; the secondary uses `.watch-lab-entry__secondary` directly.

**Primary-tooltip auto-cue.** A 5 s 1-3-1 animation (1 s fade-in, 3 s hold, 1 s fade-out) fires the primary tooltip on two timeline milestones — 50 % and 100 % — at most once per milestone per file. The semantics live in two shared hooks:

- `src/ui/use-timed-cue.ts` — `useTimedCue({ triggerToken, durationMs })` → `{ active, animKey }`. Baseline-on-first-observation + duration timer + `animKey` for React re-key-on-firing.
- `watch/js/hooks/use-timeline-milestone-tokens.ts` — `useTimelineMilestoneTokens(snapshot)` → `number`. Encapsulates the file-reset / arm-before-fire / paused-seek-coalesce rules.

Milestone rules:
1. **Once per file, not per session.** Fired-state resets on `fileIdentity` change.
2. **Arm-then-fire.** Each milestone must be observed with `currentTimePs < threshold` at least once before it can fire — a share-code deep-link that resumes at 80 % does not flash both cues at mount.
3. **Paused-seek coalescing, end-first.** At most one milestone fires per effect run; a scrub from 10 % → 95 % while paused fires the end cue only.
4. **Reduced-motion**: opacity phases remain, `--cue-y` / `--cue-s` zero out, collapsing translate + scale.
5. **SR announcer**: hidden `aria-live="polite"` sibling re-emits `"${primaryLabel}. ${tooltipCopy}"` on each firing.

The Lab-side `TransferTrigger` (see Share & Download below) intentionally does NOT consume `useTimedCue` — its trigger is a boolean event + 5-s-delay-then-show, distinct from the token-change + immediate-show shape `useTimedCue` models.

**Terminology (canonical — enforce everywhere):**

| Concept | Use | Do NOT use |
|---|---|---|
| Watch primary CTA | **Interact From Here** | Continue, Continue this frame in Lab, Remix, From this frame |
| Watch secondary CTA | **Open a Fresh Lab** | Open Lab, New Empty Lab, Open empty |
| Watch→Lab mechanism | **handoff** | seed-entry, remix |
| Payload | **seed** (`WatchLabSceneSeed`) | — |
| Per-atom velocity state | **motion state** | momentum (per-atom mass is not tracked on the wire) |
| Popover semantics | **disclosure** (`aria-haspopup="true"`) | menu, dropdown menu, contextmenu |
| Lab Transfer button | **Share & Download** | Transfer history, Export, Share |
| Restart review pill | **Restart here** | Restart, Restart simulation |
| Atom nudge | **"Drag any atom to start"** | Click to interact, Try dragging |
| Arrival UI | **none — hydrate success = rendered scene + `[lab.boot]` console.info** | arrival pill, provenance pill |

**Shared schema** (`src/watch-lab-handoff/watch-lab-handoff-shared.ts`):

| Field | Type | Notes |
|-------|------|-------|
| `atoms` | `WatchLabAtom[]` | Stable `id`, element, position. Index ↔ id stay in lockstep with the bonded-group tracker. |
| `bonds` | `WatchLabBond[]` | Stable-id pairs. |
| `colorAssignments` | `WatchLabColorAssignment[]` | `{ id, atomIds[], colorHex, sourceGroupId }` — stable-id quartet. No dense indices on the wire. |
| `camera` | `WatchLabOrbitCamera \| null` | `{ position, target, up, fovDeg }` — exact orbit pose, or `null` to request `renderer.fitCamera()`. |
| `provenance` | `{ historyKind, velocitySource, velocitiesAreApproximated, unresolvedVelocityFraction }` | `velocitySource ∈ 'restart' \| 'central-difference' \| 'forward-difference' \| 'backward-difference' \| 'mixed' \| 'none'`. |

`isValidSeed` and `isValidPayload` validate tokens in place via `isValidCamera` + `isValidColorAssignment` helpers. Legacy tokens (no camera, no colorAssignments, 2-field provenance) remain accepted — the new fields are optional at validate time.

**Normalizer** (`src/watch-lab-handoff/normalize-watch-seed.ts`): `normalizeWatchSeed` produces `NormalizedWatchHydratePayload` with `colorAssignments`, `camera`, and refined provenance. Legacy-token defaults: `camera → null`, `colorAssignments → []`, `velocitySource` derived from `velocitiesAreApproximated` (true → `'mixed'`, false → `'restart'`), `unresolvedVelocityFraction → 0`. Defensive `VALID_VELOCITY_SOURCES` coercion covers direct-call paths that bypass the validator.

**Watch seed builder** (`watch/js/watch-lab-seed.ts`): `BuildArgs` accepts optional `getColorAssignments` and `getOrbitCameraSnapshot` closures. Per-atom velocity source tracking collapses to a single tag matching `WatchLabVelocitySource`. `unresolvedVelocityFraction` is computed pre-null-promotion. Unknown `atomId`s in color assignments are dropped at build time with a `console.warn`.

**Watch controller cache identity** (`watch/js/watch-controller.ts`): `_currentFrameHrefCache` uses a 5-tuple identity that includes a `cameraIdentity` component — a quantized `(position, target, fovDeg)` string with `POSITION_Q = 0.01`, `FOV_Q = 0.5`. `buildCurrentFrameLabHref` passes both color and camera getters into the seed builder. The entry-control handlers (primary "Interact From Here" and secondary "Open a Fresh Lab") funnel through `projectCurrentFrameHref`, which re-reads the live camera on click; a cache hit requires **all 5** identity components to match, and a miss purges the stale token via `removeWatchToLabHandoff`.

**Lab hydrate transaction** (`lab/js/runtime/hydrate-from-watch-seed.ts`): follows the Transactional Scene Mutation Pattern above. Color re-indexing maps Watch `atomId` → display slot (via `seed.atoms[i].id`) → Lab `atomId` (via tracker `assignedIds[slot]`); atoms whose full resolution chain fails are dropped. `[lab.boot] watch handoff hydrated` extends with `velocitySource`, `unresolvedVelocityFraction`, `colorAssignmentCount`, and `hasCamera`.

**Worker velocity delivery** (`src/types/worker-protocol.ts`, `lab/js/simulation-worker.ts`, `lab/js/worker-bridge.ts`, `lab/js/runtime/worker-lifecycle.ts`): the `appendMolecule` command carries an optional `velocities: Float64Array`. The worker writes `engine.vel.set(velocities, atomOffset*3)` **before** `sceneVersion++` so the first post-append snapshot reflects real motion state — the snapshot reconciler previously zeroed main-thread velocities on the first frameResult. Velocity-length mismatches warn rather than silently clip.

**Bonded-group appearance runtime** (`lab/js/runtime/bonded-group-appearance-runtime.ts`): exposes `snapshotAssignments()` and `restoreAssignments(prev)` for transactional capture/restore. Both use structural deep-copy and REPLACE semantics (not additive) — restoring an empty snapshot wipes prior state, which is what the hydrate success path relies on.

**E2E observability hooks:**
- `_getWatchCameraSnapshot` (`watch/js/main.ts`, gated on `?e2e=1`) — returns the live Watch orbit pose.
- `_getLabCameraSnapshot` (`lab/js/main.ts`, **unconditional** — the Lab tab opened from Watch has no `?e2e` param, so the hook must be ungated for camera-continuity E2E specs).

**Key handoff test files** (under `tests/`): `unit/lab-scene-hydrate-from-seed.test.ts`, `unit/watch-lab-handoff.test.ts`, `unit/watch-lab-normalize-seed.test.ts`, `unit/watch-lab-seed-build.test.ts`, `unit/bonded-group-appearance-runtime-snapshot.test.ts`, `unit/watch-lab-entry-href-cache.test.ts`, `unit/watch-lab-entry-control.test.tsx` (21 cases — covers the disclosure semantics, auto-cue milestones, arm-then-fire, seek coalescing, reduced-motion, SR announcer), `unit/watch-lab-entry-new-tab.test.tsx` (4 cases), `unit/timeline-bar-lifecycle.test.tsx` (restart-affordance regression lock), `e2e/watch-lab-entry.spec.ts` (12 tests, includes the camera-continuity pose-match spec).

### Handoff-Boot Onboarding Suppression

The Welcome card ("Atom Simulation Studio") and the atom-interaction hint ("Drag any atom to start") are both suppressed on Watch→Lab handoff boots so arrivals land directly on the scene.

- **Shared predicate**: `isWatchHandoffBoot()` in `src/watch-lab-handoff/watch-handoff-url.ts` is the single source of truth for both the boot gate (`_hasPendingWatchHandoff`) and the onboarding gate (`isOnboardingEligible`).
- **Eager suppression**: `lab/js/main.ts` runs `if (isWatchHandoffBoot()) markOnboardingDismissed();` at module load — this writes the `atomdojo.onboardingDismissed` sessionStorage sentinel **before** the consume path scrubs the URL, so the suppression survives the URL rewrite.
- **Atom-hint gating** (Lab): the floating "Drag any atom to start" bubble (follows a target atom picked via 2D convex hull + centermost choice; no tail) reads the same predicate + sentinel and never appears on handoff boots. It dismisses on first atom interaction (`markAtomInteractionStarted` in dispatch).

### Restart-Here Review Pill

The timeline-review restart affordance is a single pill — `.timeline-restart-button` — with a circular-arrow icon, the label "Restart here", accent fill, and a downward pointer. There is no wrapping `ActionHint` tooltip (a prior duplicate hint was removed). The DOM contract is exactly two elements:

- `<span class="timeline-restart-anchor">` handles positioning / centering.
- `<button class="timeline-restart-button">` handles interaction.

This separation keeps the centering transform clear of the hover transform. The pointer (CSS `clip-path` polygon) supports a skewed triangle: the base stays on the pill's straight-bottom segment, the tip tracks the marker via `--tail-skew`, and all geometry numbers derive from measured pill dims + the CSS-var pointer base width — no hard-coded pixel constants in the TS clamp. `tests/unit/timeline-bar-lifecycle.test.tsx` is a regression lock on the two-element contract.

### Lab "Share & Download" Transfer Trigger

The Lab timeline-transfer button label and tooltip are both **"Share & Download"** — do not reintroduce "Transfer history", "Export", or standalone "Share". `TRANSFER_HINT_COPY` is exported from `lab/js/components/timeline-transfer-dialog.tsx` so tests can pin the copy.

Discoverability cue: 5 s after the first atom interaction (signal: `useAppStore.hasAtomInteraction`), the tooltip fades in (1 s), holds (3 s), and fades out (1 s). Fires once per page load. It is device-agnostic — the `.timeline-hint--force-visible` class bypasses the `@media (hover: none)` touch-hide. This is deliberately a one-shot boolean-triggered flow (not token-change), which is why `TransferTrigger` does not share `useTimedCue` with the Watch primary-tooltip auto-cue.

### Placement Solver Policy (3-Surface Architecture)

The placement solver (`lab/js/runtime/placement-solver.ts`) uses a 3-surface architecture that must be kept in sync. The module header documents this, but the key constraint is:

| Surface | Role |
|---------|------|
| `chooseCameraFamily()` | Base policy preference (vertical-first heuristic) |
| `selectOrientationByGeometry()` | Final runtime arbiter (geometry-scored) |
| Test layers: `[policy conformance]`, `[external oracle]`, `[observable behavior]` | Layered acceptance tests in `tests/unit/placement-solver.test.ts` |

When changing placement policy:

1. **Update `chooseCameraFamily()` first** — this is the base preference rule.
2. **Update `[policy conformance]` tests** — these prove the solver matches the current rule, not that the rule is correct.
3. **Update `[external oracle]` notes/expectations** where applicable — these are hand-written canonical backstops that catch accidental policy drift.
4. **Review `selectOrientationByGeometry()` comments** if override semantics change — this is the final arbiter and may score candidates differently from the base policy.
5. **`[observable behavior]` tests are policy-independent** — they check user-facing sanity (readability, stability, plane shape) and should not need updating for most policy changes.

### Placement Camera Framing Contract

The placement camera framing system (`lab/js/runtime/placement-camera-framing.ts`) is a pure solver with no THREE/renderer/store imports. When changing placement framing behavior:

1. **Pure math changes** go in `placement-camera-framing.ts` — tested via `tests/unit/placement-camera-framing.test.ts`
2. **Orchestration changes** (when to run, drag policy) go in `app/frame-runtime.ts` — tested via `tests/unit/frame-runtime.test.ts`
3. **Drag lifecycle changes** go in `placement.ts` — tested via `tests/unit/placement-drag-lifecycle.test.ts`
4. **Config tuning** goes in `config.ts` under `CONFIG.placementFraming`

Key invariants:
- Placement framing is independent from Center/Follow semantics
- Camera orientation is never changed by the framing solver
- Drag uses pointer capture; `updateDragFromLatestPointer()` is the per-frame reprojection contract
- Placement commit does not change focus metadata (Policy A)

### Review Mode UI Lock Contract

The review-mode UI lock system enforces display-only behavior across all React surfaces when `timelineMode === 'review'`.

| Layer | Module | Role |
|-------|--------|------|
| Selector | `store/selectors/review-ui-lock.ts` | `selectIsReviewLocked()` — single policy source. Components use this, not raw `timelineMode`. |
| Runtime guards | `runtime/ui-bindings.ts` | `blockIfReviewLocked()` — blocks 6 callbacks with `showReviewModeActionHint()` |
| Visual lock (buttons) | `components/ReviewLockedControl.tsx` | Span-wrapper for dock/chooser controls. Uses `ActionHint` + `useReviewLockedInteraction` |
| Visual lock (list rows) | `components/ReviewLockedListItem.tsx` | Li-native for settings rows. Content dimmed via inner wrapper; tooltip at full contrast |
| Shared behavior | `hooks/useReviewLockedInteraction.ts` | Tooltip timing, click/keyboard activation, status hint dispatch |
| Hint copy | `selectors/review-ui-lock.ts` | `REVIEW_LOCK_TOOLTIP` (desktop: "Tap Simulation to return"), `REVIEW_LOCK_STATUS` (mobile/status: references Simulation, Restart here, close icon) |
| Hint timing | `config.ts` | `CONFIG.reviewModeUi.statusHintMs` |

When changing review-lock behavior:
1. **Policy changes** go in `review-ui-lock.ts` selector
2. **Copy changes** update `REVIEW_LOCK_TOOLTIP` and/or `REVIEW_LOCK_STATUS`
3. **New locked actions** add a guard in `ui-bindings.ts` AND visual lock in the component
4. **Never** hardcode `timelineMode === 'review'` in components — use `selectIsReviewLocked`

### Dock Slot Geometry Contract

The dock bar (`DockBar.tsx`) uses a 4-slot CSS grid layout to prevent content-width rebalancing:

| Slot | Class | Content (primary) | Content (placement) |
|------|-------|-------------------|---------------------|
| A | `dock-slot--add` | Add button | Place button |
| B | `dock-slot--mode` | Segmented (Atom/Move/Rotate) | Cancel button |
| C | `dock-slot--pause` | Pause/Resume | Pause/Resume (disabled) |
| D | `dock-slot--aux` | Settings | Settings (disabled) |

Key rules:
- Action slots use `--dock-slot-action` (fixed width); mode slot uses `1fr`
- The Segmented control uses `.seg-item` wrappers for every option — live and review modes must produce identical flex children
- `.seg-item__content` owns layout filling; ActionHint sits inside it (no cross-component CSS dependency)
- Do NOT reintroduce `justify-content: space-around` on `.dock-bar`

### Bonded Group Architecture Contract

The bonded-group subsystem is display-source-aware with a centralized capability policy.

| Layer | Module | Role |
|-------|--------|------|
| Display source | `runtime/bonded-group-display-source.ts` | Resolves live physics or review historical topology |
| Projection | `runtime/bonded-group-runtime.ts` | Consumes `getDisplaySource()`, stable IDs, store projection |
| Capability policy | `selectors/bonded-group-capabilities.ts` | `selectCanInspectBondedGroups` gates panel + hover; `selectCanTrackBondedGroupHighlight` gates persistent tracked highlight |
| Highlight | `runtime/bonded-group-highlight-runtime.ts` | `toggleSelectedGroup` gated by `canTrackBondedGroupHighlightNow()`; hover (`setHoveredGroup`) gated only by `canInspectBondedGroupsNow()` |
| Appearance | `runtime/bonded-group-appearance-runtime.ts` | Group-to-atom color mapping, group color intents (`Map<string, string>`), renderer sync |
| Store | `app-store.ts` | `bondedGroupColorOverrides` (annotation-global), `colorEditorOpenForGroupId` |

Key rules:
- Bonded-group runtime reads `getDisplaySource()`, never physics directly
- Review inspection disabled until historical topology + review highlight rendering exist
- Color overrides are annotations (Option B) — persist across live/review, not part of timeline
- Highlight overlays and color overrides are independent renderer layers

#### Highlight Hide Architecture (Tracked Highlight Feature-Gated Off)

Persistent tracked highlights are feature-gated off via `canTrackBondedGroupHighlight: false` in `bonded-group-capabilities.ts`. The infrastructure is retained for future re-enablement or full removal.

**bonded-group-highlight-runtime.ts**:
- `toggleSelectedGroup(id)` is double-gated: `canInspectBondedGroupsNow()` AND `canTrackBondedGroupHighlightNow()`. While the tracking capability is false, toggle is a no-op.
- Self-healing via `clearTrackedIfFeatureDisabled()` at the top of both `syncToRenderer()` and `syncAfterTopologyChange()`. If stale tracked state survives (hot reload, prior session), it is cleared so hover preview is not permanently suppressed.
- Hover path (`setHoveredGroup`) is NOT gated by the tracking capability — it checks only `canInspectBondedGroupsNow()`. Hover works normally regardless of the tracked highlight gate.
- Priority resolution (tracked > hover > none) remains intact; with tracking disabled, hover is always the effective path.

**bonded-group-capabilities.ts**:
- New capability field: `canTrackBondedGroupHighlight: false` (hardcoded off).
- Primitive selector `selectCanTrackBondedGroupHighlight` + imperative helper `canTrackBondedGroupHighlightNow()` mirror the existing inspect pattern.
- Distinguished from `canInspectBondedGroups`: hover uses the inspect capability; tracked highlight uses the track capability. Both are independent policy decisions.

**BondedGroupCallbacks** (in `app-store.ts`):
- Active shipped callbacks at top: `onHover`, `onCenterGroup`, `onFollowGroup`, `onApplyGroupColor`, `onClearGroupColor`, `getGroupAtoms`.
- Legacy-hidden callbacks grouped at bottom under comment: `onToggleSelect?` and `onClearHighlight?` (both optional). Retained for future re-enablement.

**Future removal targets** (when tracked highlight is permanently dropped):
- Store fields: `selectedBondedGroupId`, `hasTrackedBondedHighlight`
- Runtime: `_trackedAtoms`, tracked branch in `syncToRenderer()` (Priority 1 block)
- Panel: selection handlers, `.selected` class, Clear Highlight button
- Callbacks: `onToggleSelect`, `onClearHighlight` in `BondedGroupCallbacks`

#### Color Editing Module Ownership & Wiring

**Appearance runtime** (`runtime/bonded-group-appearance-runtime.ts`):
- Owns group-to-atom color mapping, group color intents (`Map<string, string>`), and renderer sync
- `syncGroupIntents()` propagates intents to uncolored atoms after topology changes (newly joined atoms inherit the group's color)
- Wired to both projection trigger points in main.ts: `onSceneMutated` (scene changes) and `syncBondedGroupsForDisplayFrame` (timeline coordinator)
- Exposes `snapshotAssignments()` / `restoreAssignments(prev)` for transactional capture/restore (structural deep-copy, REPLACE semantics — restoring an empty snapshot wipes prior state). Used by the Watch→Lab hydrate transaction.

**Store additions** (`store/app-store.ts`):
- `colorEditorOpenForGroupId: string | null` — tracks which group's color popover is open
- Cleared conditionally in `setBondedGroups`: only when the open group disappears from the new group list
- `bondedGroupColorOverrides` — per-atom color overrides (annotation-global)
- `bondedGroupsExpanded` defaults to `true`, preserved across `resetTransientState` (user's collapse/expand choice survives resets)
- `bondedSmallGroupsExpanded` still resets to `false` (data-dependent — small clusters may not exist after scene change)

**CONFIG additions** (`config.ts`):
- `atomColorOverride.minSaturation` (0.7) — perceptual saturation lift threshold for override colors
- `atomColorOverride.minLightness` (0.55) — perceptual lightness lift threshold for override colors

**Renderer changes** (`renderer.ts`):
- `_applyAtomColorOverrides()` sets atom material to white when overrides are active, restores on clear. Uses CONFIG thresholds for HSL lift
- Re-applied after `populateAppendedAtoms()` and `applyTheme()` for lifecycle resilience
- `clearAtomColorOverrides()` removed (dead code)

**BondedGroupsPanel.tsx**:
- Unified popover uses `buildGroupColorLayout` + `ColorSwatch` component: primary (default) centered on top, secondary presets in honeycomb ring — no platform-specific JSX
- `computeHexGeometry()` (exported) derives ring radius and container size from swatch count + `SWATCH_DIAMETER` (20 px) + `ACTIVE_SCALE` (1.3) + `RING_GAP` (4 px). Minimum center-to-center distance between adjacent ring items exceeds `SWATCH_DIAMETER * ACTIVE_SCALE` to prevent overlap at max scale. Adding/removing palette entries automatically adjusts the ring radius, container size, and slot positions
- Panel expanded by default with disclosure header (`aria-expanded` + `aria-controls="bonded-groups-list"`)
- `useGroupColorState` hook returns `GroupColorState` with `hasDefault` flag (detects atoms still at base color within a partially colored group)
- `panelSide` prop threaded to `ClusterRow` for popover positioning (left/right)
- Escape key handler closes color editor
- ARIA attributes on interactive elements

**CSS** (`lab/index.html`):
- `--panel-width: 250px` on `.bonded-groups-panel` — single tuning point for fixed panel width
- `scrollbar-gutter: stable` on the panel body prevents content reflow when the scrollbar appears
- 5-column grid for bonded-group list: color-chip | label | atoms | center | follow
- Portal popover + backdrop at z-index 199 (backdrop) / 200 (popover)
- Hex container width/height set by inline style derived from `computeHexGeometry()`
- Plain borderless color chips (`.bonded-groups-swatch`); active swatch scales 1.3x with no border/box-shadow

**Header structure**:
- `.bonded-groups-header-label` — contains title ("Bonded Clusters:") + `.bonded-groups-count` (group count). Uses `min-width: 0` + `overflow: hidden` + `text-overflow: ellipsis` for narrow-width safety
- `.bonded-groups-header-toggle` — pill button ("Collapse"/"Expand") styled as a clickable affordance with border-radius, opacity transition, and hover highlight

**Data model** (`BondedGroupsPanel.tsx`):
- `GroupColorOption` — discriminated union: `{ kind: 'default' }` | `{ kind: 'preset'; hex: string }`
- `GROUP_COLOR_OPTIONS` — static palette array (1 default + 6 presets, tuned for luminance separation under 3D atom lighting)
- `buildGroupColorLayout(options)` — splits the options array into `{ primary, secondary }` (`GroupColorLayout`); primary is the default swatch, secondary is the preset ring

### Highlight Composition Policy (Dual-Channel Architecture)

The highlight system uses two independent visual channels composed by the renderer. Never collapse them back into a single mutable "current group highlight".

**Ownership boundaries:**

| Owner | Responsibility |
|-------|----------------|
| `bonded-group-highlight-runtime.ts` | Persistent panel state (calls `renderer.setHighlightedAtoms` only) |
| `interaction-highlight-runtime.ts` | Pure resolver (returns data, never calls renderer directly) |
| `renderer.ts` (`_updateGroupHighlight`) | Private compositor — merges both channels into the final visual |

When changing highlight behavior:

1. **Panel highlight goes through `bonded-group-highlight-runtime`** — it owns selection/hover state for the BondedGroupsPanel. It calls `renderer.setHighlightedAtoms()` and nothing else.
2. **Interaction highlight is a pure resolver** — `interaction-highlight-runtime` returns atom indices for Move/Rotate modes. The renderer consumes this data via `setInteractionHighlightedAtoms()` / `clearInteractionHighlight()`.
3. **Composition lives in the renderer** — `_updateGroupHighlight()` is the single private compositor that merges panel (renderOrder 2) and interaction (renderOrder 3) layers. Do not add composition logic elsewhere.
4. **Never reintroduce a single mutable highlight channel.** The dual-channel design exists so panel selection and interaction preview can coexist without stomping each other.

**Highlight config tokens (in `config.ts`):**

| Token | Palette | Purpose |
|-------|---------|---------|
| `CONFIG.panelHighlight` | Warm (renamed from `groupHighlight`) | BondedGroupsPanel selection/hover |
| `CONFIG.interactionHighlight` | Cool | Move/Rotate interaction preview |

Future style changes (colors, opacity, scale) go in `config.ts` config tokens, not scattered through renderer code.

**Test helpers (`tests/unit/highlight-test-utils.ts`):**

| Helper | Use case |
|--------|----------|
| `makeStateFake()` | State-only fake renderer for channel-state tests (no real meshes) |
| `makeRealMeshCtx()` | Real THREE geometry context for mesh behavior tests |

Both are shared across `bonded-group-highlight.test.ts` and `renderer-interaction-highlight.test.ts`. New highlight tests should import from this shared module rather than duplicating setup.

### Contrast Verification as a CI Gate

`tests/unit/lab-entry-contrast.test.ts` is the pattern for contrast-target CI gates: the test **re-derives** WCAG 2.1 sRGB→linear relative-luminance contrast from the live `THEMES` tokens at test time and fails CI on any target miss. The computation is the ground truth; the plan table is a human-readable snapshot, not a source of truth. When adding a new themed surface with a contrast commitment, add its token pairs to this test (or a sibling file following the same shape) rather than eyeballing from a design doc.

### Watch Architecture (Controller Pattern)

Watch (`watch/`) does **not** use Zustand. It uses a controller pattern where `watch-controller.ts` is the orchestration facade over domain services. React components consume state via `useSyncExternalStore`.

**Domain services orchestrated by the controller:**

| Service | Module | Role |
|---------|--------|------|
| Document | `watch-document-service.ts` | Stateful file open (transactional with rollback), file metadata |
| Playback | `watch-playback-model.ts` | Time tracking, advance, seek, speed, repeat, step, 4 separated sampling channels |
| Bonded groups | `watch-bonded-groups.ts` | Interaction state (hover/select), highlight priority resolution |
| View | `watch-view-service.ts` | Camera target, follow state, center/follow commands |
| Appearance | `watch-bonded-group-appearance.ts` | Group-to-atom color mapping, color intents |
| Camera input | `watch-camera-input.ts` | Orbit/pan/zoom gesture handling |
| Overlay layout | `watch-overlay-layout.ts` | Panel positioning and overlay geometry |
| Settings | `watch-settings.ts` | Theme, text size, interpolation mode types (`WatchInterpolationMode`, `PRODUCT_INTERPOLATION_MODE_IDS`, `isWatchInterpolationMode`) |
| Interpolation | `watch-trajectory-interpolation.ts` | Strategy registry, bracket lookup with cursor-cache fast path, preallocated output buffer, linear/Hermite/Catmull-Rom built-in strategies |
| Renderer | `watch-renderer.ts` | Adapter over lab Renderer |

**React components** (`watch/js/components/`): WatchApp, WatchCanvas, WatchDock, WatchTimeline, WatchTopBar, WatchCinematicCameraToggle, WatchBondedGroupsPanel, WatchOpenPanel, WatchSettingsSheet, PlaybackSpeedControl.

**Key rules:**
- All state mutations go through the controller facade. Components call controller commands (e.g., `controller.togglePlay()`, `controller.hoverGroup(id)`).
- Components read state from the controller snapshot via `useSyncExternalStore(controller.subscribe, controller.getSnapshot)`.
- Do not add a Zustand store to watch. The controller + useSyncExternalStore pattern is intentional.
- **Unified pipeline rule:** `applyReviewFrameAtTime()` in `watch-controller.ts` is the ONLY direct caller of `interpolation.resolve()` and `renderer.updateReviewFrame()`. All playback paths (tick, seek, step, file open) route through it. A source-level grep meta-test enforces this — do not call `interpolation.resolve()` or `renderer.updateReviewFrame()` from anywhere else.

### Watch Playback Model

The playback model uses a unified `_playDirection` field (`0 | 1 | -1`) as the **sole source of truth** for play state. There is no separate `_playing` boolean.

- `_playDirection === 0` means paused
- `_playDirection === 1` means playing forward
- `_playDirection === -1` means playing backward
- `isPlaying()` is derived: `_playDirection !== 0`

Control commands (`startPlayback`, `pausePlayback`, `startDirectionalPlayback`, `stopDirectionalPlayback`, `stepForward`, `stepBackward`) all manipulate `_playDirection`. Do not add a separate `_playing` flag.

### Adding an Interpolation Strategy

The interpolation runtime (`watch/js/watch-trajectory-interpolation.ts`) is designed for extension. To add a new method:

1. **Implement `InterpolationStrategy`** — a pure, stateless object with a `metadata` descriptor and a `run(input)` function. The `run` function writes interpolated positions into `input.outputBuffer` and returns `{ kind: 'ok', n }` on success or `{ kind: 'decline', reason }` to fall back to linear.
2. **Call `registerStrategy()`** on the interpolation runtime instance. The registry accepts any string ID, so dev-only or research methods can be registered without widening the product type.
3. **For product-visible methods:** add the new ID to `PRODUCT_INTERPOLATION_MODE_IDS` in `watch/js/watch-settings.ts` and use `availability: 'product'` in the metadata. The settings picker reads this array.
4. **For dev-only methods:** use `availability: 'dev-only'` in the metadata. The method will be invisible to the product UI but usable via test hooks or dev tools.

Key constraints:
- Strategies must NOT mutate input buffers — write only into `outputBuffer`.
- Declare `requiresVelocities: true` or `requires4Frames: true` in metadata if the method needs those inputs. The resolution loop provides them only when the capability layer certifies the bracket.
- If the capability layer cannot provide required inputs, the runtime short-circuits to linear — your strategy will not be called.
- The controller and UI do not need changes for new strategies; the registry is the extension point.

### Frontend State Patterns (Phase 6)

These are the preferred shapes when introducing new cross-redirect or state-machine flows in the Zustand store. They arose from the Phase 6 auth UX work but apply anywhere the same shape recurs.

#### Discriminated unions with narrow setters

Prefer a discriminated union over a flag-bag object when a slice of state is a state machine with mutually exclusive branches. Pair the union with narrow setters — one setter per variant — so transitions are explicit at the callsite and invalid intermediate states are unreachable.

Example (see `lab/js/store/app-store.ts` and `lab/js/runtime/auth-runtime.ts`): `AuthState` is a discriminated union with variants `{ status: 'loading', session: null }`, `{ status: 'signed-in', session: AuthSessionState }`, `{ status: 'signed-out', session: null }`, `{ status: 'unverified', session: null }`. The store exposes `setAuthSignedIn`, `setAuthSignedOut`, `setAuthUnverified`, `setAuthLoading` — not a single `setAuth(partial)` (the raw `setAuthState` exists only as a test seam, not for production callers). Callers pick the variant; the TS compiler rejects nonsense transitions.

When adding a new state machine to the store, follow this pattern rather than `{ loading: bool, error: string | null, user: User | null }`-style flag bags — those allow `{ loading: true, user: someUser, error: 'x' }` which is not a real state.

#### Kind-tagged error state

Error state in a state machine should be shaped `{ kind: 'someErrorCategory', message: string }`, not a bare `string` or a string with an adjacent "error effect" flag. The `kind` discriminator prevents cross-branch bleed — e.g., a popup-blocked error cannot be silently reinterpreted as a network error by a component that reads only the message.

When error branches need to drive different UI affordances (retry button vs. "open in new tab" button vs. dismiss-only), switch on `kind`, never parse the message.

The same shape applies to non-store error classification. Two canonical examples from the Watch→Lab handoff: `WatchHandoffWriteError` (`kind: 'storage-unavailable' | 'quota-exceeded'`) wraps write-path failures at the storage boundary, and `HydrateFailureReason` is a discriminated union for the hydrate module (`'rollback-also-failed'` is a first-class reason, not a log string). Pair each failure surface with a per-failure copy map (e.g., `HYDRATE_FAILURE_COPY`) so user-facing text stays consistent. Split diagnostic channels: `console.warn` for ops (with the `kind` in the message), `setStatusError` for the user-facing banner.

#### sessionStorage sentinel with `?authReturn=1` handshake

For flows that survive a full-page redirect (OAuth same-tab fallback is the canonical case), encode the pre-redirect intent in `sessionStorage` and tag the redirect destination with a `?authReturn=1` query marker. On load, the runtime checks the query marker first, then consumes the sessionStorage sentinel to resume the intent, then strips both. This is preferred over encoding intent into the OAuth `state` parameter (which is reserved for CSRF) or into cookies (which are visible to unrelated requests).

Scope sentinels to a narrow key (the existing `atomdojo.resumePublish` is the canonical example) and always clear them after consumption — a stale sentinel that survives into the next session is a latent bug.

### Phase 7 Conventions (Account, Privacy, Audit)

Phase 7 added account deletion, privacy/policy acceptance, per-row PII sweeping, and hardened the Pages Functions contract. These conventions are load-bearing — please do not open-code around them.

#### Shared utilities — single source of truth

Use these modules directly; do not inline equivalent logic:

| Module | Exports | Use for |
|---|---|---|
| `src/share/b64url.ts` | `b64urlEncode`, `b64urlDecode` (decoder restores `=` padding) | Any base64url encode/decode on client or shared code. Phase 7 consolidated two divergent decoders that disagreed on padding — do not reintroduce an inline variant |
| `src/share/error-message.ts` | `errorMessage(unknown): string` | Replaces inline `err instanceof Error ? err.message : String(err)` patterns. Use in catch blocks that render a user-visible message |
| `functions/http-cache.ts` | `NO_CACHE_HEADERS`, `noCacheHeaders()`, `noCacheJson(body, init?)` | **Every** account/privacy endpoint response. Sets `Cache-Control: no-store, private`, `Pragma: no-cache`, `Vary: Cookie` in one place |
| `functions/signed-intents.ts` | `createSignedIntent`, `verifySignedIntent` | Any new HMAC-signed CSRF/intent flow (account-delete confirmation, privacy request submission, etc.). Do not hand-roll HMAC with `SESSION_SECRET` |

#### Policy text source-of-truth

`src/policy/policy-config.ts` is the **single** definition of `POLICY_VERSION`, `ACTIVE_POLICY_SEGMENTS`, and `POLICY_FEATURES`. The Vite plugin at `src/policy/vite-policy-plugin.ts` injects them into `/privacy` and `/terms` HTML at build time via the `__POLICY_VERSION__` placeholder.

- **Do NOT** hardcode the version string in HTML — use the placeholder
- **Do NOT** add a new policy segment without updating all three: `ACTIVE_POLICY_SEGMENTS`, the segment-gating block in `scripts/deploy-smoke.sh`, and the relevant E2E spec

#### Pages Functions auth contract (`/api/account/*`)

- Per-user endpoints **must** call `authenticateRequest()` and return **401** when it yields `null`
- Owner-vs-other rows must return **404** (not 403) — no existence disclosure. See `tests/unit/owner-delete-endpoint.test.ts` for the canonical pattern
- **All** account endpoints set no-cache headers via `noCacheJson` / `noCacheHeaders` — never hand-roll `Cache-Control`

#### Audit log contract

New `AuditEventType` values introduced in Phase 7: `'owner_delete'`, `'account_delete'`, `'age_confirmation_recorded'`, `'audit_swept'`.

Per-row PII fields (`ip_hash`, `user_agent`, `reason`) are scrubbed at 180 days by the cron sweeper. When adding a new audit field, classify it explicitly: **skeleton** (retained indefinitely) or **PII** (scrubbed at the 180-day window). Document the classification in the same PR.

#### Migrations 0004–0007

Additive only; applied automatically by `deploy.yml`. New tables/columns contributors should know about:

- `user_policy_acceptance`
- `privacy_requests`
- `privacy_request_quota_window`
- `users.deleted_at` column

Convention is unchanged from prior migrations — name files `NNNN_<slug>.sql`, additive only, no destructive operations.

#### E2E lanes

Two lanes exist and have different backing servers:

| Command | Server | Use for |
|---|---|---|
| `npm run test:e2e` (default) | `vite preview` (static) | Frontend-only specs; Pages Functions are unavailable |
| `npm run test:e2e:pages-dev` | `wrangler pages dev` | Backend-dependent specs (auth, account, privacy, publish) |

Pages-dev specs must gate themselves via `test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'pages-dev'))` so they no-op under the default lane.

## Next Steps (Priority Order)

### 1. Expand Structure Library
- More CNT chiralities, larger graphene sheets
- Multi-structure collision presets

### 3. Viewer Modernization
- Port trajectory viewer (`viewer/index.html`) to InstancedMesh + spatial hash
- Currently limited to ~250 atoms at 30 FPS due to individual meshes + O(N²) bonds

### 4. ML (Future, When Needed)
- GNN architecture for >5,000 atoms where Wasm is too slow
- Use existing data pipeline and force decomposition code

### Deferred Architecture Work

The following items are intentionally deferred — do not start them without an explicit decision:

- **Phase 3B-D: Interface narrowing** — further narrowing the dependency surfaces passed between modules.
- **Phase 4: Folder reorganization** — restructuring `lab/js/` subdirectories beyond the current `app/`, `runtime/`, `components/` split.
- **Phase 5: Workspace assessment** — evaluating monorepo / workspace tooling changes.

## Development Workflow

### TypeScript / React (interactive page)

```
1. npm run dev                    # Vite dev server with HMR
2. Make changes to lab/js/ code
3. npm run typecheck              # TypeScript type-checking
4. npm run test:unit              # Vitest unit suite
5. npm run test:e2e               # Playwright E2E suite
6. npm run build                  # Production build → dist/
```

#### Doc-drift release check

Before opening a release PR, run this grep to catch retired-UX
references that slipped into new code or comments. All matches should
either be inside an append-only decision entry (e.g., D118) or a
clearly historical section ("Replaces the deleted AgeGateCheckbox"):

```
rg -n 'AgeGateCheckbox|refreshNonce|retro-ack checkbox|AGE_INTENT_STALE_AFTER_MS' \
  docs/ functions/ lab/js/ watch/js/ src/ tests/ \
  privacy/ terms/ account/ privacy-request/ README.md *.md
```

The `privacy/`, `terms/`, `account/`, and `privacy-request/` paths are
the static policy-facing surfaces — stale text there affects live
user-facing routes, not just source comments, so the release check
must cover them too.

Anything else is stale and should be updated — the retired UX should
not dangle in the active codebase's comments or live docs.

#### Production deploy readiness (Cloudflare side)

Before promoting any Workers/Pages change to production, verify the
following Cloudflare-side controls are in place. These are NOT
managed as code in this repo — they live in the Cloudflare dashboard
and must be kept in sync by the deploy operator.

1. **WAF rate-limit rules** — confirm every rule documented in the
   "Per-IP rate limiting" block of `wrangler.toml` is present and
   enabled in Security → WAF → Rate limiting rules. At minimum:
   - "Publish per IP" (30 req/min on `/api/capsules/publish`)
   - "Resolve per IP" (300 req/min on `/api/capsules/`)
   - "Age-intent signing per IP" (D120 — 30 req/min on
     `/api/account/age-confirmation/intent`)

   The age-intent endpoint has an app-level layer-2 cap in the Worker
   (60/isolate/min) that prevents unbounded single-isolate CPU
   amplification, but the WAF rule is still required for cross-IP /
   cross-isolate attacks. Treat a missing WAF rule as a launch
   blocker.

2. **Scheduled Workers** — `wrangler.toml` pins the cron-sweeper
   schedules; verify the Worker is deployed with both `X-Cron-Secret`
   matching the environment.

3. **Doc-drift grep** — see above subsection.

### Cloudflare / Share Backend (Phase 5 — Share & Publish)

The Phase 5 share-and-publish work adds a Cloudflare Pages Functions backend (under `functions/`) for publishing and sharing capsules, backed by D1 (SQLite) and R2 (object store), plus a companion scheduled Worker (`workers/cron-sweeper/`) for periodic cleanup. Lab + Watch UI work is unchanged — these onboarding notes apply when you're touching share/publish, auth, admin, or cron code. (Not to be confused with the deferred "Phase 5: Workspace assessment" item above, which is a separate architectural track.)

#### Required packages

Already in `devDependencies` — a fresh `npm install` is all you need:
- `wrangler` — Cloudflare CLI (pages dev, D1 migrations, worker deploy)
- `@cloudflare/workers-types` — Workers runtime type globals, consumed by `tsconfig.functions.json` and `workers/cron-sweeper/tsconfig.json`

#### First-time setup

```
cp .dev.vars.example .dev.vars     # (create this if not present)
# fill in OAuth client IDs/secrets from the operator, or set AUTH_DEV_USER_ID for bypass mode
npm install
```

`.dev.vars` is gitignored (`.dev.vars` and `.dev.vars.*` patterns) — **never commit it**.

#### `.dev.vars` contents

| Key | Purpose |
|-----|---------|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client credentials |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth client credentials |
| `SESSION_SECRET` | HMAC-signed session + OAuth state + IP hash salt (single rotate point) |
| `AUTH_DEV_USER_ID` | Optional dev bypass. With this set AND running on localhost, publish/admin endpoints treat every request as this user. **Never set in production.** |
| `DEV_ADMIN_ENABLED=true` | Optional. Unlocks admin routes for local testing alongside the localhost origin check. |
| `CRON_SECRET` | Optional. For local testing of the cron Worker dispatch. Production value must match between Pages and the companion Worker. |

#### Local dev modes

| Command | Runs | When to use |
|---|---|---|
| `npm run dev` | Vite (port 5173) | Normal Lab/Watch UI work; fast HMR; **no backend — `/api/capsules/*`, `/api/auth/*`, and `/auth/*` will 404** |
| `npm run build && npm run cf:dev` | Wrangler Pages dev (port 8788) | Share/publish **and auth** feature work; needs D1 + R2 bindings and Pages Functions; no HMR |
| `npm run cron:dev` | Wrangler dev for the cron Worker | Tests the scheduled handler locally against `localhost:8788` |

**Rule of thumb:** if you need to exercise sign-in, session, publish, or share-link flows locally, run `cf:dev`. Vite alone is fine for Lab/Watch UI iteration that does not touch those paths.

##### Auth in Vite dev

`lab/js/runtime/auth-runtime.ts` contains a Vite dev-host guard: when it detects the Vite dev server host (no Pages Functions available), it short-circuits the popup OAuth flow and logs a console message pointing at `wrangler pages dev`. This is intentional — do not try to make the popup flow work under Vite. Switch to `npm run build && npm run cf:dev` when touching auth.

The OAuth flow is popup-primary (a `window.open()` against the provider's consent screen) with an explicit, user-opted-in same-tab fallback (never silent). The popup completes against `/auth/popup-complete`, which is served by the Pages Function at `functions/auth/popup-complete.ts` (static HTML response with a strict CSP). After completion it notifies the opener via `window.opener.postMessage` plus a same-origin `BroadcastChannel('atomdojo-auth')` fallback; the opener re-runs `hydrateAuthSession()` to refresh session state.

The session endpoint (`/api/auth/session`) returns **200 for both signed-in and signed-out** states (it never returns 401). The server sets `Cache-Control: no-store, private`, `Pragma: no-cache`, `Vary: Cookie`, and opportunistically clears stale cookies on sign-out responses. The client fetches it with `cache: 'no-store'`. If you are debugging auth state, verify these response headers and the 200 contract before assuming a bug.

#### D1 setup

- `npm run cf:d1:migrate` — apply pending migrations to the local D1 (idempotent)
- First-time: `wrangler d1 create atomdojo-capsules`, then paste the returned `database_id` into `wrangler.toml`

Local Wrangler state (local D1 + R2 + cache, potentially including seeded/test user data) lives under `.wrangler/` and is gitignored.

#### Seeding a capsule for local share-link testing

```
# Terminal 1
npm run build && npm run cf:dev

# Terminal 2 (requires DEV_ADMIN_ENABLED=true in .dev.vars)
npm run seed:capsule -- path/to/capsule.atomdojo
```

The seed command prints `{ shareCode, objectKey }`. The capsule is then reachable via `/c/<shareCode>` and `/watch/?c=<shareCode>`.

#### Testing workflow

- `npm run typecheck` — runs frontend + functions + cron tsconfigs in one command. Prefer this over the granular `typecheck:frontend` / `typecheck:functions` / `typecheck:cron` variants for CI.
- `npm run test:unit` (vitest) — includes new endpoint handler tests and auth UX tests
- `npm run test:e2e` (playwright) — the share-link flow uses `page.route()` mocking, since Vite preview does not run Pages Functions
- `npm run lint:dock-contract` — unchanged from prior phases

To run a single test file, pass the path to vitest / playwright:

```
npm run test:unit -- tests/unit/auth-ux.test.tsx
npm run test:unit -- tests/unit/auth-middleware.test.ts
npm run test:unit -- tests/unit/session-endpoint.test.ts
npm run test:e2e -- tests/e2e/topbar-right-layout.spec.ts
```

##### Phase 6 auth test catalog

| File | Scope |
|---|---|
| `tests/unit/auth-ux.test.tsx` | ~100 tests — popup flow, `AuthState` state machine transitions, kind-tagged error state, sessionStorage sentinel handshake, dev-host guard (run `npx vitest run tests/unit/auth-ux.test.tsx` for the authoritative count) |
| `tests/unit/auth-middleware.test.ts` | Backend middleware — orphan session cleanup + `hasSessionCookie` detection (Workers tsconfig) |
| `tests/unit/session-endpoint.test.ts` | Backend — 200 contract for signed-in **and** signed-out, dev-cookie handling, user-missing recovery (Workers tsconfig) |
| `tests/e2e/topbar-right-layout.spec.ts` | AccountControl + FPSDisplay flex-container geometry regression |

The backend auth tests (`auth-middleware.test.ts`, `session-endpoint.test.ts`) compile under `tsconfig.functions.json` so they see the Workers runtime globals. They are listed in `tsconfig.functions.json` `include` **and** `tsconfig.json` `exclude` — same pattern as the capsule endpoint tests. Follow the same dual-listing rule when adding new backend-handler tests. The full `tsconfig.json` `exclude` list (18 entries as of Phase 7) is the authoritative source for what lives under the Workers config.

#### Adding a new endpoint test

- Place the test at `tests/unit/<name>-endpoint.test.ts` (or `<name>-middleware.test.ts` for middleware)
- Add the filename to **both** `tsconfig.functions.json` `include` **and** `tsconfig.json` `exclude` — this prevents Workers globals from leaking into frontend compilation. There is a precedent block of 18 dual-listed files as of Phase 7 (authoritative count: the exclude list in `tsconfig.json`); follow the existing ordering
- Use hoisted `vi.fn<(...args: unknown[]) => ...>()` for module mocks
- See `tests/unit/publish-endpoint.test.ts`, `tests/unit/session-endpoint.test.ts`, and `tests/unit/owner-delete-endpoint.test.ts` for the canonical patterns (`minimalValidCapsule()`, `makePermissiveEnv()` helpers; owner-vs-other 404 contract)
- New account/privacy endpoints should emit responses through `noCacheJson` (from `functions/http-cache.ts`) — tests should assert the no-cache headers are present

#### Cron Worker

- Code lives at `workers/cron-sweeper/` with its own `wrangler.toml` and `tsconfig.json`
- Deploy: `npm run cron:deploy`
- Tail production logs: `npm run cron:tail`
- Manual invocation: `curl -X GET 'https://<worker-url>/?target=sessions' -H 'X-Cron-Secret: …'` — returns 404 if the secret is missing or wrong (intentional; see `workers/cron-sweeper/README.md`)

#### OAuth redirect URIs

Register these in the Google and GitHub OAuth application dashboards:

- Local: `http://localhost:8788/auth/google/callback`, `http://localhost:8788/auth/github/callback`
- Production: `https://atomdojo.pages.dev/auth/google/callback`, `https://atomdojo.pages.dev/auth/github/callback`

#### Gotchas

- **Session cookie name differs by scheme.** OAuth login on plain-HTTP localhost uses `atomdojo_session_dev` (no `__Host-` prefix). Production/HTTPS uses `__Host-atomdojo_session`.
- **Admin endpoints return 404, not 403, on auth failure.** This is intentional to avoid leaking route existence.
- **Publish endpoint returns 201 even when `warnings[]` is present** — that is a successful publish with operator follow-up needed, not a failure.
- **Local caches are gitignored.** `.wrangler/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, and `.dev.vars` are all excluded from version control.

### Debug Query Params

The app supports URL-based debug overrides via `getDebugParam()` in `config.ts`.
All debug params must be routed through this single reader.

| Param | Effect | Used by |
|-------|--------|---------|
| `?kernel=js\|wasm` | Force physics kernel | `physics.ts` |
| `?e2e=1` | Suppress onboarding overlay | `runtime/onboarding.ts` |

E2E tests inject `?e2e=1` via `gotoApp()` from `tests/e2e/helpers.ts`.

E2E camera-snapshot hooks: `_getWatchCameraSnapshot` is gated on `?e2e=1` (`watch/js/main.ts`); `_getLabCameraSnapshot` is **unconditional** (`lab/js/main.ts`) because the Lab tab opened from Watch via the handoff (whether "Interact From Here" or "Open a Fresh Lab") carries no `?e2e` param, and the camera-continuity spec in `tests/e2e/watch-lab-entry.spec.ts` needs to read it on arrival. The E2E spec accesses the secondary action by first clicking `.watch-lab-entry__caret` to open the disclosure popover.

### Python (simulation engine)

```
1. Make changes to sim/ code
2. python -m pytest tests/test_*.py -v
3. If adding structures: python scripts/library_cli.py <command>
4. If changing force engine: verify tersoff.py and tersoff_fast.py match
5. Document significant changes in docs/decisions.md
6. Update docs/ if architecture or decisions change
```

## Key Files to Know

| If you're working on... | Read these files |
|--------------------------|-----------------|
| Interactive page | `lab/index.html`, `lab/js/main.ts`, `lab/js/components/*`, `lab/js/store/app-store.ts`, `docs/viewer.md` |
| React UI components | `lab/js/components/*.tsx`, `lab/js/store/app-store.ts`, `lab/js/hooks/*`, `lab/js/react-root.tsx` |
| Timeline components & hints | `lab/js/components/TimelineBar.tsx`, `lab/js/components/timeline-hints.ts`, `lab/js/components/timeline-mode-switch.tsx`, `lab/js/components/timeline-clear-dialog.tsx`, `lab/js/components/timeline-format.ts` |
| Web Worker / bridge | `lab/js/simulation-worker.ts`, `lab/js/worker-bridge.ts`, `src/types/worker-protocol.ts` |
| Runtime modules (scene, worker, input) | `lab/js/runtime/scene-runtime.ts`, `lab/js/runtime/worker-lifecycle.ts`, `lab/js/runtime/snapshot-reconciler.ts`, `lab/js/runtime/input-bindings.ts`, `lab/js/runtime/interaction-dispatch.ts` |
| Overlay layout & open/close policy | `lab/js/runtime/overlay-layout.ts`, `lab/js/runtime/overlay-runtime.ts` |
| Focus resolution & onboarding | `lab/js/runtime/focus-runtime.ts`, `lab/js/runtime/onboarding.ts`, `lab/js/components/OnboardingOverlay.tsx` |
| Object View & icons | `lab/js/components/CameraControls.tsx`, `lab/js/components/Icons.tsx` |
| E2E test helpers | `tests/e2e/helpers.ts` (gotoApp), `tests/e2e/camera-onboarding.spec.ts` |
| Bonded clusters (panel + highlight + color) | `lab/js/runtime/bonded-group-runtime.ts`, `lab/js/runtime/bonded-group-highlight-runtime.ts`, `lab/js/runtime/bonded-group-appearance-runtime.ts`, `lab/js/runtime/bonded-group-coordinator.ts`, `lab/js/components/BondedGroupsPanel.tsx`, `lab/js/runtime/interaction-highlight-runtime.ts` |
| Highlight tests | `tests/unit/bonded-group-highlight.test.ts`, `tests/unit/renderer-interaction-highlight.test.ts`, `tests/unit/highlight-test-utils.ts` |
| Timeline / export tests | `tests/unit/timeline-subsystem.test.ts` (37 tests incl. export capability and rehydration), `tests/unit/history-export-pipeline.test.ts` (19 tests incl. end-to-end lifecycle validation), `tests/unit/timeline-bar-lifecycle.test.tsx` (export UI regression) |
| Watch / shared history tests | `tests/unit/shared-history-modules.test.ts` (52+ tests covering shared modules, watch loader, importer, playback model, bonded groups, validation edge cases, end-to-end pipeline) |
| Watch parity tests | `tests/unit/watch-parity.test.ts` (controller lifecycle, transactional file open, parity validation, x1 playback rate), `tests/unit/watch-react-integration.test.tsx` (React component state transitions, error banner visibility, panel expand/collapse) |
| Watch controller & domains | `watch/js/watch-controller.ts`, `watch/js/watch-playback-model.ts`, `watch/js/watch-bonded-groups.ts`, `watch/js/watch-view-service.ts`, `watch/js/watch-bonded-group-appearance.ts`, `watch/js/watch-camera-input.ts`, `watch/js/watch-overlay-layout.ts`, `watch/js/watch-settings.ts`, `watch/js/watch-trajectory-interpolation.ts` |
| Watch interpolation | `watch/js/watch-trajectory-interpolation.ts` (strategy registry + built-in strategies), `watch/js/watch-settings.ts` (`WatchInterpolationMode`, `PRODUCT_INTERPOLATION_MODE_IDS`), `watch/js/full-history-import.ts` (`InterpolationCapability`, `ImportDiagnostic`), `src/history/units.ts` (physical constants) |
| Watch React components | `watch/js/components/WatchApp.tsx`, `watch/js/components/WatchDock.tsx`, `watch/js/components/WatchTimeline.tsx`, `watch/js/components/WatchBondedGroupsPanel.tsx`, `watch/js/components/WatchSettingsSheet.tsx`, `watch/js/components/PlaybackSpeedControl.tsx` |
| Shared modules (cross-app) | `src/ui/` (CSS tokens + structural styles), `src/input/` (camera gesture constants), `src/appearance/` (bonded-group color assignments), `src/config/` (playback speed constants, viewer defaults), `src/history/` (history file types, connected components, bonded-group projection, physical unit constants) |
| Shared icons | `lab/js/components/Icons.tsx` (both lab and watch import from here) |
| Store callback wiring | `lab/js/runtime/ui-bindings.ts`, `lab/js/store/app-store.ts` |
| Auth UX & session | `lab/js/runtime/auth-runtime.ts` (popup flow, dev-host guard, `AuthState` discriminated union, kind-tagged errors, sessionStorage sentinel), `lab/js/store/app-store.ts` (narrow setters: `setAuthSignedIn/Out/Unverified/Loading`), `functions/api/auth/session.ts` (200 contract) |
| Auth tests | `tests/unit/auth-ux.test.tsx` (~100 tests), `tests/unit/auth-middleware.test.ts`, `tests/unit/session-endpoint.test.ts`, `tests/e2e/topbar-right-layout.spec.ts` |
| Scene / placement | `lab/js/scene.ts`, `lab/js/placement.ts`, `lab/js/runtime/placement-solver.ts`, `tests/unit/placement-solver.test.ts` |
| Browser physics | `lab/js/physics.ts` (JS Tersoff), `sim/wasm/tersoff.c` (Wasm kernel) |
| Force calculation (Python) | `sim/potentials/tersoff.py`, `tersoff_fast.py` |
| Running simulations | `sim/integrators/velocity_verlet.py`, `sim/atoms.py` |
| Adding structures | `sim/structures/generate.py`, `scripts/library_cli.py` |
| Collision simulations | `scripts/scaling_research.py`, `docs/scaling-research.md` |
| Trajectory viewer | `viewer/index.html` |
| Validation | `tests/test_01_dimer.py` through `test_08_data_loading.py` |
| Performance & scaling | `scripts/scaling_research.py`, `docs/scaling-research.md` |

## Environment Setup

```bash
# Required
pip install numpy

# Strongly recommended (250-480x speedup)
pip install numba

# For plotting
pip install matplotlib

# For optional .mat file loading
pip install scipy

# For ML experiments (currently deferred)
pip install scikit-learn
```
