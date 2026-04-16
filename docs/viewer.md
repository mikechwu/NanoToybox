# Viewer & Interactive Page

## Overview

NanoToybox has three browser interfaces:

| Interface | Path | Purpose |
|-----------|------|---------|
| **Interactive Page** | `lab/index.html` | Real-time Tersoff simulation with drag/rotate interaction |
| **Trajectory Viewer** | `viewer/index.html` | Pre-computed trajectory playback with stride control |
| **Watch** | `watch/index.html` | Import and play back `.atomdojo` history files — from local files or from shared cloud capsules via share code |

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
| Timeline | TimelineBar with 2-column layout (mode rail + timeline lane), scrub track, review mode (display-only playback of history), restart from dense frames, and a unified transfer dialog (Download + Share tabs). 2-slot action zone (transfer + clear triggers). Recording arms on first atom interaction (drag/move/rotate/flick) |
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

The bar uses a 2-column layout: a vertical **mode rail** on the left and a **timeline lane** on the right. A shared `TimelineShell` component enforces this structure across all recording states.

All layout dimensions are centralized as CSS variables on `.timeline-bar`:

| CSS variable | Default (desktop / mobile) | Purpose |
|---|---|---|
| `--tl-rail-width` | 96 px / 84 px | Mode rail column width |
| `--tl-time-width` | 56 px / 48 px | Fixed time column in the timeline lane |
| `--tl-action-width` | 32 px | Action column (close icon) |
| `--tl-shell-height` | 44 px / 38 px | Shell row height |
| `--tl-mode-height` | 36 px / 32 px | Mode switch height inside rail |

**Mode rail** (left column — `timeline-shell__left`):

| Recording state | Rail content |
|---|---|
| **off** | Simple centered label "History Off" (`ModeLabel`) — no segmented control chrome |
| **ready** | Simple centered label "Ready" (`ModeLabel`) |
| **live** | Bidirectional 2-segment vertical switch: **Simulation** (active) / Review. Tapping Review enters review at the current time |
| **review** | Same vertical switch: Simulation / **Review** (active). Tapping Simulation returns to the live simulation |

The vertical switch (`ModeSwitch` in `timeline-mode-switch.tsx`) uses a sliding indicator controlled by `--tms-active` (0 = Simulation, 1 = Review). Each segment is a `<button>`: the inactive segment is clickable, the active segment is disabled.

**Timeline lane** (right column — `timeline-shell__center`):

The lane has an invariant 3-part grid:

| Zone | Width | Content |
|---|---|---|
| Time column | `--tl-time-width` (fixed) | Formatted time readout (fs / ps / ns / us, auto-scaling via `formatTime`) |
| Track | `1fr` | Draggable scrub track with pointer capture; fill bar + thumb. Disabled (no range) in off/ready states |
| Action zone | `--tl-action-width` (fixed) | 2-slot zone: transfer trigger (`TransferTrigger`, opens the unified Download + Share dialog; appears when at least one destination is available and the timeline has a range) + close/clear trigger (`ClearTrigger`) when available |

**Overlays** (`timeline-overlay-zone`) float in a reserved zone above the track:

| State | Overlay |
|---|---|
| **off** | "Start Recording" button |
| **ready** | Empty (spacer preserves grid skeleton) |
| **review** (with restart target) | "Restart here" button, positioned along the track at the restart-target progress via `getRestartAnchorStyle` |

Empty spacers preserve the grid skeleton in modes that don't use overlays or actions.

**Clear action**: The close icon (`ClearTrigger`) always triggers a confirmation dialog (`TimelineClearDialog`, portaled to `document.body`) before clearing. The dialog announces "Stop recording?" and requires an explicit "Continue" or "Cancel" — the icon-only control is too ambiguous for an irreversible erase on any device. Focus is trapped inside the dialog; Escape dismisses.

**Transfer action**: The transfer icon (`TransferTrigger`) opens a unified transfer dialog (`TimelineTransferDialog`, portaled to `document.body`) with two tabs:

- **Download** — save a local `.atomdojo` file (capsule or full). Each kind shows a size estimate next to its radio, and opening the dialog pauses live playback so the estimate does not shift under the user while they're reading it. Download capability is gated by: export dependencies exist AND atom identity is not stale. Rebuild failures surface via `setStatusText` on the StatusBar.
- **Share** — publish the capsule to the cloud and return a share link (see "Sharing & Accounts" below). Share is the default tab when both destinations are available (higher-value, cross-session path).

The tab bar is hidden when only one destination is usable (focused surface instead of a dead tab). While a download or publish is in flight, the dialog's backdrop click, Escape, Cancel, and tab switching are all disabled so an in-flight transfer cannot be hidden behind a closed dialog.

**Dialog mutual exclusion**: Opening the transfer dialog closes the clear dialog and vice versa — at most one dialog is visible at a time.

**Timeline Hints**

All 5 timeline interactive controls have `ActionHint` hover/focus tooltips (desktop only). Hint text is centralized in `timeline-hints.ts` via the `TIMELINE_HINTS` constant:

| Control | Hint |
|---|---|
| Start Recording | "Start saving timeline history now." |
| Simulation (return) | "Back to the current simulation." |
| Review (enter) | "Enter review mode at the current time." |
| Review (disabled) | "No recorded history to review yet." |
| Restart here | "Restart the simulation from this point." |
| Transfer (transfer icon) | "Transfer history" (opens the Download + Share dialog) |
| Clear (close icon) | "Stop recording and clear timeline history." |

On touch/coarse-pointer devices, `ActionHint` tooltips are CSS-hidden. Touch discoverability relies on visible button labels and `aria-label` attributes instead.

**Review Mode**

Tapping the Review segment in the mode switch (or scrubbing away from the live edge) enters review mode. Review is display-only: `renderer.updateReviewFrame()` never mutates physics. Live-edit actions (drag, add/remove atoms) are blocked at the input boundary during review. The bonded-groups panel remains visible with historical topology, supporting hover preview, Center/Follow, and color editing. The frozen scrubber range is decoupled from live retention.

**Review Mode UI Lock**

When review mode is active, the following actions are visually disabled and blocked at the runtime callback boundary:

- Dock: Add, Atom/Move/Rotate mode selector, Pause/Resume
- Settings: Add Molecule, Clear
- Chooser: Structure row selection (if chooser is open)

Desktop users see `ActionHint` tooltips explaining the lock on hover/focus. Mobile users see a transient status hint on tap. Both use centralized copy from `REVIEW_LOCK_TOOLTIP` ("Tap Simulation to return") and `REVIEW_LOCK_STATUS` (fuller — references "Simulation", "Restart here", and "close icon" as the three exits).

Allowed actions in review: **Simulation** (tap in mode switch — return to current simulation), **Restart here** (overlay on track — continue from scrub point), **Clear** (close icon with confirmation — leave review and erase history). These remain fully interactive and visually prominent.

**Restart**

Restart uses dense restart frames recorded at 10 Hz containing pos + vel + bonds + config + boundary. Dense restart frames are preferred over sparse checkpoints because they are closer to the viewed time. The worker receives full dynamic state via a dedicated `restoreState` command. History is truncated after the restart point to maintain a monotonic timeline. Interaction state is NOT restored (prevents ghost spring forces).

**Recording Policy**

Recording is disarmed until the first direct atom interaction (drag, move, rotate, flick). Molecule placement, pause/resume, speed changes, and physics settings do not arm recording — users can set up complex scenes before history begins. Clearing the playground disarms recording.

### StatusBar

StatusBar is now message-only (no persistent scene summary). It shows `statusError` or `statusText` and returns `null` otherwise. Export rebuild failures surface here via `setStatusText`.

### Sharing & Accounts

Publishing a capsule to the cloud requires signing in. Opening or downloading a capsule does not — reading and downloading remain public. Sign-in state is surfaced in two places: the Share tab inside the transfer dialog, and the account control in the top-right of the Lab.

**Share panel states**

The Share tab in the transfer dialog renders one of five branches depending on the current auth status and publish progress:

| Status | What the Share panel shows |
|--------|---------------------------|
| `loading` | "Checking sign-in…" neutral row with a Cancel action. No provider buttons yet. |
| `signed-out` | "Sign in to publish a share link. Anyone with the link can open it in Watch without signing in." with Continue with Google and Continue with GitHub buttons. |
| `unverified` | "Can't verify sign-in right now. Retry or continue later." with a Retry button. The OAuth prompt is deliberately withheld so a transport blip (offline, 5xx) cannot push a signed-in user through an unnecessary round-trip. |
| `signed-in` | "Publish this capsule to get a share link that anyone can open in Watch." with a Publish button. |
| Success | Share URL in a read-only field with a Copy button and the 12-char share code rendered below. Close action. Non-fatal server warnings (e.g. `quota_accounting_failed`) render as a subtle note alongside the URL without hiding it. |

**Auth-prompt notes.** When a publish attempt returns 401 (session expired mid-flight), the panel flips back to `signed-out` with an inline note — "Your session expired. Sign in to publish again." — rendered alongside the provider buttons. This note comes only from auth-required errors; rate-limit and other publish errors render as a red error line above the Publish button in the signed-in branch instead, so the two error classes never cross-contaminate.

**Primary popup flow.** Clicking a provider button opens a small OAuth popup pointed at `/auth/{provider}/start?returnTo=/auth/popup-complete`. The main Lab tab keeps its scene, timeline, and dismissed-onboarding state throughout; it never navigates away. After the user consents at Google or GitHub, the provider callback sets the session cookie and redirects the popup to `/auth/popup-complete`, which notifies the Lab via `window.opener.postMessage` (or a same-origin `BroadcastChannel` fallback when the browser severed `window.opener`) and then closes itself. The Lab detects completion and resumes the publish request if one was pending.

**Popup-blocked fallback.** If the browser blocks the popup, the Share panel replaces the provider buttons with an explicit three-way choice:

- **Retry popup** — try opening the popup again (useful when the user just granted a one-time permission).
- **Continue in this tab** — redirect the current tab through OAuth. This warns that unsaved Lab state may be lost, because the main tab will navigate away.
- **Back** — dismiss the blocked state and pick a different provider.

The runtime never silently falls through to a same-tab redirect — destructive navigation is always user-opt-in.

**Popup-complete landing page.** The `/auth/popup-complete` route renders a minimal spinner with "Signing you in…" and tries to auto-close once the opener has been notified. If it cannot notify the opener (cross-origin-opener-policy severed `window.opener`, Safari chain restrictions) it falls into a stuck-state recovery message: "Sign-in completed. We couldn't notify the original tab automatically. Close this tab and refresh the Lab tab to continue." That way a user who lands on a stuck popup has an actionable hint instead of a perpetual spinner.

**Account control (top-right).** A companion surface in the top-right of the Lab lets users see and change sign-in state without opening the transfer dialog. It sits to the left of the FPS display inside a shared flex container (`TopRightControls`) so the two controls re-flow cleanly as display-name widths or text-size tokens change.

| Status | What the control shows |
|--------|-----------------------|
| `loading` | Nothing rendered — a tiny reserved slot felt worse than a clean appearance when the status settles. |
| `signed-out` | Subtle "Sign in" text action. Click opens a popover with the same Continue-with-Google / Continue-with-GitHub buttons and, if the most recent sign-in attempt was blocked, the same Retry / Continue-in-tab / Back choice as the Share panel. |
| `signed-in` | Pill chip with an avatar glyph and display name. Click opens a popover with an identity summary and Sign out. |
| `unverified` | Muted "Sign-in unknown" action whose popover contains a Retry-only menu — no provider buttons. Prevents a transport blip from pushing a signed-in user through a round-trip. |

**Watch is unchanged.** Watch does not require sign-in to open a local file or a shared capsule; the account control is Lab-only.

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
- Safety guards: per-atom velocity hard cap (`vHardMax`), per-atom thresholded smooth saturation for internal forces (Tersoff+wall), and smooth saturation for interaction forces (drag/translate/rotate) at the spring level
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
- React 19 (`createRoot`) — primary UI surfaces: DockLayout, DockBar, TimelineBar, SettingsSheet, StructureChooser, SheetOverlay, StatusBar, TopRightControls (AccountControl + FPSDisplay), CameraControls, OnboardingOverlay, BondedGroupsPanel, TimelineTransferDialog. Supporting: Segmented, Icons, ActionHint
- Zustand (`app-store.ts`) — reactive UI state store; imperative callbacks from `main.ts` registered via store slots
- Web Worker (`simulation-worker.ts`) + bridge (`worker-bridge.ts`) — physics runs off the main thread
- Three.js v0.170 (npm, bundled by Vite)
- InstancedMesh for atoms and bonds (2 draw calls, geometric capacity growth)
- OrbitControls for Orbit-mode camera (zoom, pan; rotation handled by custom quaternion orbit)
- Interactive axis triad (ArrowHelper + sprites, scissor-test viewport, device-aware sizing 96–200px via `setOverlayLayout()`; drag=orbit/look, tap=snap, double-tap=reset on touch devices)
- Object View controls: React CameraControls (Center + Follow action buttons) + OnboardingOverlay (page-load welcome card with sink animation)
- MeshStandardMaterial with roughness 0.7, metalness 0 (PBR)
- Camera-mounted 3-light rig (SpotLight headlight + DirectionalLight fill + AmbientLight)

### Known Issues

- **Popup blockers during sign-in.** If the browser or an extension blocks the OAuth popup, the Share panel (and the top-right Sign-in popover) replaces the provider buttons with a Retry popup / Continue in this tab / Back choice. Retry re-opens the popup; Continue in this tab falls back to a full-page redirect (destructive — see below); Back dismisses the blocked state.
- **Same-tab sign-in loses unsaved Lab state.** Choosing "Continue in this tab" navigates the main Lab tab through OAuth, so any in-memory scene, timeline history, and transient UI state that has not been saved or published will be lost when the tab reloads. The prompt calls this out before the user commits.
- **Private browsing re-shows onboarding after same-tab OAuth.** After a same-tab sign-in round-trip in a private / incognito window, the welcome overlay may reappear because `sessionStorage` (where the dismissed-onboarding flag is kept) is not available across the redirect. The popup-based flow preserves onboarding because the Lab tab never navigates.

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

## Watch (`watch/`)

The watch app imports and plays back `.atomdojo` history files exported from the lab timeline. It is a React application with a `useSyncExternalStore`-compatible controller that owns the RAF clock and renderer frame application. `WatchCanvas` owns only renderer lifecycle (init/dispose). `watch/index.html` is minimal (`#watch-root` only, no inline CSS or DOM).

### Usage

```bash
# Open directly, then drag-drop or browse for an .atomdojo file
open watch/index.html

# Or serve via Vite
npm run dev
# Open http://localhost:5173/watch/
```

### Landing State

"Watch History" title, an "Open File" button, and a drag-and-drop zone. A support note describes accepted formats. File detection is automatic (format, version, and kind inspection) — there is no user type picker.

The landing page also exposes a **share-code input** for opening capsules that live in the cloud (see Remote Open via Share Code below). The top bar in the workspace provides the same affordance so the user can switch to a shared capsule without returning to the landing state.

### Supported Formats

| Kind | Version | Status |
|------|---------|--------|
| `"full"` | v1 | Supported — loads into workspace. Contains dense frames, restart frames, and checkpoints. Bond topology is stored in restart frames. |
| `"capsule"` | v1 | Supported — loads into workspace. Contains dense frames and atoms but NO restart frames or checkpoints. Bond topology is reconstructed at playback time from atom positions. Capsule files may include optional appearance (`CapsuleAppearanceV1`) with authored color assignments and optional sparse interaction timeline (`CapsuleInteractionTimelineV1`). |
| `"reduced"` | v1 | Legacy import alias — normalized to `LoadedCapsuleHistory` at import time. Same runtime behavior as capsule. |

### Remote Open via Share Code

Watch can open capsules hosted in the cloud via a 12-char Crockford Base32 share code. When Watch is loaded with a `?c=<code>` query parameter, it auto-fetches the referenced capsule and routes it through the same transactional file-open pipeline as a local file — a failure leaves the current document intact.

**URL entry points:**

- `/watch/?c=<code>` — Watch auto-loads on page init
- `/c/:code` — backend share-preview HTML page that redirects into `/watch/?c=<code>`
- Landing-page share-code input and top-bar share-code affordance — user pastes a code (or any of the supported input shapes below), and the controller fetches and loads it

**Accepted input shapes:** the controller's `openSharedCapsule(input)` method normalizes input via `normalizeShareInput()` (in `src/share/share-code.ts`) and accepts:

- Raw 12-char code (e.g. `ABCDEFGHJKMN`)
- Grouped/spaced code (e.g. `ABCD-EFGH-JKMN` or `ABCD EFGH JKMN`)
- Path form `/c/:code`
- Watch URL form `/watch/?c=<code>`
- Full absolute URL containing either of the above

Invalid or unparseable input produces an "Invalid share code or URL" error without disturbing the current document.

**Fetch pipeline:** `openSharedCapsule()` (in `watch/js/watch-controller.ts`) first calls `/api/capsules/:code` for metadata (existence / accessibility check), then `/api/capsules/:code/blob` for the capsule JSON. The response is wrapped in a `File` object and handed to the same `openFile()` entry point used by drag-drop and file-picker flows, so all validation, transactional rollback, and commit-phase checks are shared between local and remote opens. Network or server errors surface through the error overlay.

### Workspace

Once a valid file loads, the app presents:

| Element | Details |
|---------|---------|
| Canvas | Three.js scene (same renderer as lab, via thin adapter: `initForPlayback` + `updateReviewFrame`) |
| Top bar | File-kind badge + file name + "Open File" action + share-code input (see Remote Open via Share Code above) |
| Bonded-groups panel | Two-tier expand (large/small clusters) with hover preview, Center/Follow buttons, and authored color editing (see Color Editing below) |
| Timeline | Custom scrub track (thick variant from shared `timeline-track.css`) with pointer-event scrubbing and time readouts at both ends |
| Playback dock | Transport cluster + utility cluster (repeat, smooth toggle, speed) + settings button (see Playback Dock below) |
| Settings sheet | Smooth Playback, Appearance, File Info, Help sections (see Settings below) |

The workspace grid (`watch-workspace`) uses `grid-template-rows: auto 1fr auto` — top bar, canvas area (with overlaid bonded-groups panel), and bottom chrome region.

### Camera & Interaction

Watch has full camera orbit and axis triad interaction, matching lab review-mode behavior.

| Gesture (Desktop) | Action |
|--------------------|--------|
| Left-drag on background | Orbit camera |
| Right-drag on background | Orbit camera |
| Scroll wheel | Zoom |
| Middle-click | Dolly (via OrbitControls) |

| Gesture (Mobile) | Action |
|-------------------|--------|
| 1-finger drag on background | Orbit camera |
| Drag triad | Orbit camera (drag commits after `TRIAD_DRAG_COMMIT_PX` threshold) |
| Tap axis end on triad | Snap to canonical view (nearest axis endpoint) |
| Double-tap triad center | Animated reset to default front view |
| 2-finger pinch | Zoom (via OrbitControls) |
| 2-finger drag | Pan camera (via OrbitControls) |

Event ownership is split: `watch-camera-input.ts` owns orbit rotation and triad gestures, OrbitControls (inside Renderer) owns scroll zoom and 2-finger pinch/pan. Desktop uses pointer events with capture; mobile uses touch events with passive: false. Shared gesture constants from `src/input/camera-gesture-constants.ts`.

**Triad tap-intent highlight:** On mobile, after `TAP_INTENT_PREVIEW_MS`, if the finger has not committed to a drag, the nearest axis endpoint is highlighted. Highlight clears on drag commit, release, or cancel.

**Overlay layout:** Triad sizing and positioning is driven by `watch-overlay-layout.ts`, which replicates lab's formulas. On phone, triad bottom position clears `[data-watch-bottom-chrome]` (the combined dock + timeline wrapper) with an 8 px gap, measured via ResizeObserver. On desktop, triad bottom is a fixed 12 px offset.

### Cinematic Camera

Cinematic camera is a default-on automatic framing system for Watch playback. It smoothly translates the orbit target and dollies along the view direction to keep major bonded clusters centered and well-framed throughout the timeline. It never rotates the camera — the user's chosen orientation is always preserved.

**Framing target:** The framing target is computed from all bonded clusters that exceed a minimum size threshold. Small clusters (3 atoms or fewer) are excluded so isolated fragments and debris do not pull the frame. The target center is weighted per-atom, not per-group — a 200-atom cluster contributes proportionally more than a 10-atom cluster.

**Motion model:** The camera translates the orbit target toward the computed framing center and dollies along the view direction to maintain appropriate framing distance. Motion is smoothed so the camera glides rather than snaps.

**Speed-profile scaling:** Motion smoothing and the target-refresh rate adapt to the current playback speed (0.5x through 20x) via configurable tuning curves. At low speeds the camera moves gently; at high speeds refreshes are more frequent and tracking is more responsive.

**User interaction pause:** Any user camera gesture — scroll, drag, pinch, orbit, triad snap — immediately pauses cinematic framing. After a configurable cooldown (default 1500 ms) with no further user input, cinematic framing resumes automatically.

**Phase-aware gesture tracking:** Held gestures (pointerdown without a matching pointerup) keep cinematic paused indefinitely until the pointer is released. The cooldown window starts from the release timestamp, not the initial press. This prevents cinematic from resuming while the user is mid-drag.

**Manual Follow wins:** When a specific bonded group is being followed via the Follow button in the bonded-groups panel, cinematic framing is suppressed — Follow takes precedence. On unfollow, the standard cooldown applies from the last user interaction timestamp. If that timestamp has already expired, cinematic resumes immediately.

**Waiting for targets:** When no clusters exceed the minimum size threshold (e.g., early in a timeline before bonds form), cinematic is idle and reports "Waiting for major clusters" as its status.

**UI toggle:** A "Cinematic Camera" pill is rendered between the info panel and the bonded-clusters panel. Clicking the pill toggles cinematic on or off. Status text beneath the pill reflects the current state:

| Status text | Condition |
|-------------|-----------|
| "Keeps major clusters framed" | Cinematic is on and actively framing |
| "Paused while you adjust the camera" | Cinematic is on but paused due to user interaction (cooldown running or gesture held) |
| "Waiting for major clusters" | Cinematic is on but no eligible clusters exist in the current frame |
| "Off" | Cinematic is toggled off by the user |

### Camera Interaction Gate

The lab Renderer distinguishes user OrbitControls gestures from programmatic camera updates using a source-attribution gate (`camera-interaction-gate.ts`). Programmatic camera mutations — follow tracking, cinematic framing, fit-to-view, reset, and view animations — call `controls.update()` as part of their work, which would otherwise fire OrbitControls change events indistinguishable from user input. The gate suppresses attribution for all 10 renderer-owned `controls.update()` call sites so these programmatic updates do not masquerade as user gestures. This is critical for cinematic camera in Watch: without the gate, every programmatic framing adjustment would re-trigger the user-interaction pause, preventing cinematic from ever running.

### Playback Dock

The dock (`WatchDock`) is a 3-zone hierarchical toolbar using shared `dock-shell.css`:

| Zone | Content |
|------|---------|
| **Transport** (Zone 1) | Step Back, Play/Pause, Step Forward, Repeat — fixed-width 4-column grid of icon+label buttons, no layout shift on label swap |
| **Utility** (Zone 2) | Speed column: continuous logarithmic slider on top, "Speed · 1.0x" meta row below |
| **Settings** (Zone 3) | Settings button (opens settings sheet) |

**Transport buttons (Step Back / Step Forward):** Dual-mode gesture — tap triggers a single dense-frame step; hold (past `HOLD_PLAY_THRESHOLD_MS` = 160 ms) initiates continuous directional playback with an immediate nudge frame. Release stops directional playback. The `useTransportButton` hook stores callbacks in refs so React re-renders do not kill active hold gestures. Pointer capture is attempted but optional; global fallback listeners (pointerup, pointercancel, blur, visibilitychange) ensure release is always detected.

**Repeat:** Icon+label toggle button in the transport cluster — when active, playback wraps around (modulo) at file boundaries in both forward and backward directions. Stays enabled even when no file is loaded so users can pre-arm the loop.

**Speed control:** `PlaybackSpeedControl` owns the full Zone 2 column: a continuous logarithmic slider (0.5x to 20x) on top, and a centered "Speed · 1.0x" meta row below. The slider maps `[0,1]` to `[SPEED_MIN, SPEED_MAX]` via `sliderToSpeed()`/`speedToSlider()` (shared from `src/config/playback-speed-constants.ts`). Logarithmic mapping gives ~37% of slider travel to the 0.5x-2x range where fine control matters most. The numeric readout (`.watch-dock__speed-value`) is a click-to-reset button (disabled at default to make the no-op visible). The slider sits inside a fixed-height row (`.watch-dock__speed-slider-row`, 18 px = `.dock-icon` baseline) so its thumb centerline aligns with the icon centerlines in neighboring columns across browsers (native range height varies 16–24 px).

**Smooth playback** is configured in **Settings only** (default ON via `_smoothPlayback = true` in `watch/js/watch-settings.ts`). It was previously a dock toggle but moved to Settings to give the speed slider room and to keep the dock format uniform (every column = icon+label).

### Timeline

`WatchTimeline` provides a full-width scrub track (no mode rail — watch advantage over lab). Layout is a 3-column grid: start time readout, scrub track (`1fr`), end time readout.

The track uses the shared `timeline-track.css` thick variant (`.timeline-track--thick`) with fill bar and thumb. Pointer-event scrubbing with capture (attempted, optional) and a `dragActive` ref fallback for browsers that do not support capture. Time readouts use shared `formatTime` (auto-scaling units: fs/ps/ns/us).

The timeline and dock are sibling shells inside `.bottom-region` (shared `bottom-region.css`), with `[data-watch-bottom-chrome]` as the layout hook for phone triad clearance.

### Bonded-Groups Panel

The panel (`WatchBondedGroupsPanel`) provides lab-parity bonded-group inspection:

- **Two-tier expand:** Large clusters shown by default, collapsible small-clusters section
- **Hover preview:** Mouse enter/leave highlights the group on the 3D canvas (desktop only)
- **Center button:** Frame camera on the group
- **Follow button:** Continuously track the group during playback; "Follow On" banner with unfollow action when active
- **Header:** "Bonded Clusters: N" label + Expand/Collapse toggle

**Color Editing**

Each cluster row has a circular color chip. Clicking the chip opens a portalled honeycomb popover:

- **Center swatch:** Default (restore original) color
- **Ring swatches:** 6 preset colors arranged in a computed hexagonal ring via `computeHexGeometry()` — ring radius and container size are derived from palette size and swatch diameter so adjacent swatches never overlap even at active scale (1.3x)
- **Preset palette:** `#ff5555, #ffbb33, #33dd66, #55aaff, #aa77ff, #ff66aa`
- **Popover positioning:** Left of chip (panel is on the right side of the viewport)
- **Popover dismissal:** Chip toggle (re-click), backdrop click, or Escape key

**Stable-atomId color model:** Watch stores color assignments keyed by stable `atomId` values from history file frames, not dense slot indices. Each frame, stable atomIds are projected to current dense slot indices before passing to the renderer via `renderer.setAtomColorOverrides()`. This ensures colors survive scrubbing across frames where dense slot ordering may differ. Assignments are scoped per source group and replaced on re-assignment.

The color editor open/close state is local React state — auto-cleared when the open group disappears from the topology.

### Settings Sheet

`WatchSettingsSheet` uses shared design system components: `useSheetLifecycle` (mount/animate/escape/transition), `sheet-shell.css`, and shared `Segmented` component from lab.

| Section | Content |
|---------|---------|
| **Smooth Playback** | On/Off toggle (shared Segmented control, default On) + Interpolation Method picker (see below). Per-frame diagnostic note when an experimental method falls back to Linear. Neutral note when smooth playback is off and a non-stable method is selected |
| **Appearance** | Theme: Dark / Light (shared Segmented control). Text Size: Normal / Large (shared Segmented control, CSS-only via `[data-text-size]`) |
| **File Info** | Kind, Atoms, Frames, Duration (formatted via shared `formatTime`) |
| **Help** | Navigates to a viewer-specific help page with sections: Playback, Timeline, Bonded Groups, Camera, File. Back button returns to main settings |

Speed and repeat controls live in the dock only — they are not duplicated in settings.

**Interpolation Method picker:** A Segmented control built from the strategy registry's product-visible methods (filtered by `availability === 'product'`). Stable methods appear first, then experimental. Dev-only methods are excluded from the user-facing picker.

| Method | Stability | Description |
|--------|-----------|-------------|
| **Linear** | Stable (default) | Component-wise lerp between bracket endpoints. Always succeeds — universal fallback for all other strategies |
| **Hermite (Velocity-Based)** | Experimental | Cubic Hermite using real velocities from restart frames (Å/fs, converted via `FS_PER_PS`). Requires velocity data aligned to both bracket endpoints. Falls back to Linear when velocities are unavailable or implausible |
| **Catmull-Rom** | Experimental | Catmull-Rom spline over a 4-frame window (f[i-1], prev, next, f[i+2]). Requires 4 safe frames with matching atom counts and IDs. Falls back to Linear at timeline edges or when the window has mismatched atoms |

When an experimental method cannot run for a specific bracket, the runtime falls back to Linear automatically and the settings sheet shows a diagnostic note explaining why (e.g., "velocities not available for this frame pair", "timeline edge").

### Playback Model

`WatchPlaybackModel` provides exact recorded-frame playback from `denseFrames` at canonical x1 rate from `VIEWER_DEFAULTS.baseSimRatePsPerSecond` (0.12 ps/s). Rate is file-length-independent — not normalized to file duration.

- **Speed:** Continuous 0.5x to 20x multiplier applied to the advance delta
- **Direction:** Single `playDirection` field (1 = forward, -1 = backward, 0 = paused) — `isPlaying()` is derived, no separate boolean
- **Repeat:** Modulo wrap at file boundaries in both directions
- **Step:** Dense-frame-boundary stepping via binary search index
- **Gap clamp:** Wall-clock delta capped at `PLAYBACK_GAP_CLAMP_MS` (250 ms) to prevent large jumps after tab-background return
- **History union:** `LoadedWatchHistory = LoadedFullHistory | LoadedCapsuleHistory`. Full files load as `LoadedFullHistory` (kind `'full'`); capsule files load as `LoadedCapsuleHistory` (kind `'capsule'`). Legacy reduced files are normalized to `LoadedCapsuleHistory` at import time
- **Topology:** Provided by a `WatchTopologySource` — an abstraction over how bond data is obtained for a given playback time. Full files use `StoredTopologySource` (restart-frame lookup via binary search at-or-before). Capsule files use `ReconstructedTopologySource` (builds bonds from atom positions at playback time). The playback model delegates `getTopologyAtTime()` to the active source without knowing which strategy is in use
- **Bond-policy resolution:** `ReconstructedTopologySource` resolves bond rules at load time via `resolveBondPolicy()`. If the file declares a `bondPolicy` (policyId + cutoff + minDist), those parameters are used. If `bondPolicy` is null (legacy compatibility only — production exports must always include it), the resolver falls back to `BOND_DEFAULTS`
- **Interaction timeline:** `getInteractionAtTime(timePs)` is a time-based query API on `WatchTopologySource` that returns the interaction state at a given time from the capsule file's sparse interaction timeline. Returns `null` for full files or capsule files without an interaction timeline. This is a Tier 1 data contract — no visual rendering yet
- **Appearance import:** Capsule files with an `appearance` field carry authored color assignments. On load, these are imported via `importColorAssignments()` into the bonded-group appearance model so Watch renders the same authored colors as lab
- **Stable atomId semantics:** Atom IDs in compact files are stable identifiers from the original simulation, not array indices. The `elementById` map (`ReadonlyMap<number, string>`) in `LoadedCapsuleHistory` is keyed by these stable IDs, enabling correct element lookup during reconstruction even when dense-frame slot ordering varies across frames
- **Bonded-group analysis:** Memoized to avoid redundant recomputation during scrubbing

### Topology Reconstruction

Capsule files (and legacy reduced files) carry dense frames with atom positions but no stored bond topology. Watch reconstructs bonds at playback time using the following pipeline:

1. **Source selection:** On file load, the playback model creates a `ReconstructedTopologySource` (for capsule files) or a `StoredTopologySource` (for full files). Both implement the `WatchTopologySource` interface — the rest of the playback pipeline is source-agnostic.

2. **Bond-policy resolution:** `resolveBondPolicy()` converts the file's `bondPolicy` field into a `BondRuleSet` at load time. The policy declares the cutoff distance, minimum distance, and policy ID used at export. Missing `bondPolicy` (null) falls back to `BOND_DEFAULTS` for legacy compatibility.

3. **Per-frame reconstruction:** When `getTopologyAtTime(timePs)` is called, the source locates the dense frame at-or-before `timePs` via binary search, then builds bond topology from atom positions using the shared topology builders and the resolved bond rules. Results are cached per frame index to avoid redundant recomputation during scrubbing.

4. **Element identity:** Reconstruction requires knowing each atom's element to apply element-pair-specific bond rules. The `elementById` map (built once at import from the atom table) maps stable `atomId` values to element strings. Atom IDs are not array indices — they are stable identifiers that persist across frames even when atoms are added or removed.

5. **Import validation:** The capsule-file import pipeline validates: simulation metadata (maxAtomCount, frameCount, durationPs), atom table uniqueness (no duplicate IDs), stable atomId references (every frame's atomIds reference valid atom-table entries), per-frame atomId uniqueness, position components (finite numbers, correct length), durationPs span (matches computed timeline extent), and bondPolicy fields (valid policyId, positive cutoff, non-negative minDist, minDist < cutoff). Capsule files additionally validate appearance (color assignments reference valid atomIds) and interaction timeline (event-stream-v1 encoding, monotonic timestamps, valid frameId references).

### Smooth Playback & Interpolation

When smooth playback is enabled (default), positions between recorded dense frames are reconstructed at render time via a trajectory interpolation runtime (`watch-trajectory-interpolation.ts`). The runtime is created on file load and disposed on unload, sized to the file's `maxAtomCount`.

**Render pipeline:** All render entry points (RAF tick, scrub, step, initial load, rollback) route through a single `applyReviewFrameAtTime()` helper in the controller. This helper is the sole caller of `interpolation.resolve()` and `renderer.updateReviewFrame()` — enforcing a unified pipeline for geometry, authored colors, analysis, and highlight in one pass.

**Strategy registry:** The runtime ships three built-in strategies (Linear, Hermite, Catmull-Rom) and accepts new strategies at runtime via `registerStrategy()`. The `resolve()` API takes the current playback time and the user's preference (`enabled` + `mode`) and returns positions, atom IDs, and per-frame diagnostics (active method + fallback reason). Unregistered or unknown mode IDs fall back to Linear.

**Capability layer:** For full files, precomputed at import time in `full-history-import.ts`. Per-bracket and per-4-frame-window flags (`bracketSafe`, `hermiteSafe`, `window4Safe`) are stored as typed arrays for hot-path lookup. Diagnostic reason arrays (`bracketReason`, `velocityReason`, `window4Reason`) explain why specific brackets are not safely interpolatable. The capability layer also maps each dense frame to its aligned restart frame for velocity access. For capsule files, `buildCapsuleInterpolationCapability()` computes bracket adjacency from dense frames only — Hermite and Catmull-Rom capabilities are zeroed (no velocity or restart-frame data available). The interpolation runtime is created via `createWatchTrajectoryInterpolationForCapsule()` which binds the capsule capability layer without requiring a synthetic `LoadedFullHistory` bridge.

**Bracket lookup:** Binary search with a cursor-cache fast path. Same-bracket and one-step-forward lookups are O(1); all other cases (backward, jump, wrap, first call) fall through to binary search.

**Fallback taxonomy:** When a strategy cannot run (missing velocities, insufficient frames, atom-count mismatch, timeline edge), the runtime falls back to Linear over the same bracket and records a typed `FallbackReason` for UI diagnostics.

**Settings ownership:** `smoothPlayback` (boolean) and `interpolationMode` (WatchInterpolationMode: `'linear' | 'hermite' | 'catmull-rom'`) are session-only viewer preferences in `watch-settings.ts`. They survive file replacement but are not persisted to localStorage.

**Unit conversion:** Hermite interpolation converts Å/fs velocities to Å/ps using `FS_PER_PS` (1000) from `src/history/units.ts`. An import-time sanity check flags implausibly large velocities (> `IMPLAUSIBLE_VELOCITY_A_PER_FS` = 10.0 Å/fs) so Hermite falls back to Linear cleanly.

### Shared Design System

Watch imports shared CSS and components from `src/ui/`:

| Module | Watch usage |
|--------|-------------|
| `core-tokens.css` | Font family, color tokens |
| `dock-tokens.css` + `dock-shell.css` | `.dock-bar`, `.dock-slot`, `.dock-item`, `.dock-icon`, `.dock-label` |
| `sheet-shell.css` | `.sheet`, `.sheet-handle`, `.sheet-header`, `.group`, `.group-list`, `.group-item` |
| `segmented.css` | `.segmented`, `.seg-item`, `.seg-label` — used by Segmented component |
| `timeline-track.css` | `.timeline-time`, `.timeline-track`, `.timeline-fill`, `.timeline-thumb`, thick variant |
| `bottom-region.css` | `.bottom-region` — centered pill on desktop |
| `review-parity.css` | Neutral review-surface classes |
| `bonded-groups-parity.css` | Panel row and chip styles |
| `text-size-tokens.css` | Text size token overrides |
| `useSheetLifecycle.ts` | Settings sheet mount/animate/escape/transition hook |
| `device-mode.ts` | `isTouchInteraction()` for camera input, `getDeviceMode()` for overlay layout |
| `bonded-group-chip-style.ts` | `chipBackgroundValue()` for color chip rendering |

Watch-specific overrides live in `watch/css/watch-dock.css` (dock grid, transport cluster, speed slider, timeline lane metrics, help back button).

### Error Handling

Transactional file open: a bad replacement file keeps the current document intact and shows an error overlay. Commit-phase rollback restores the previous document on failure (including color assignment and interpolation runtime rollback). The error overlay is visible in both the landing and workspace states.

### Theme & Renderer

Uses the same `DEFAULT_THEME` as lab, applied via `applyThemeTokens`. Text size applied via `applyTextSizeTokens`. The renderer is a thin adapter over the lab `Renderer` — it calls `initForPlayback` for setup and `updateReviewFrame` for each displayed frame, never mutating physics state. All frame application routes through the controller's unified `applyReviewFrameAtTime()` pipeline, which resolves interpolated (or discrete) positions before passing them to the renderer.

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
