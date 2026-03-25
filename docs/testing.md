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

## Frontend Smoke Test

Manual verification checklist for the interactive page (`page/index.html`). Run after any changes to `page/` code.

### Setup
```bash
npm run dev
# Open http://localhost:5173/NanoToybox/page/
```

### Checklist

| # | Test | Expected |
|---|------|----------|
| 1 | Page loads | C60 renders with atoms and bonds visible |
| 2 | Switch structure | New structure loads, old one clears completely |
| 3 | Atom mode: left-drag on atom | Highlight (green), spring line shows, atom follows cursor |
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
| 15 | Move mode: drag atom | Entire molecule translates, blue highlight + force line |
| 15a | Release in Move mode, damping=0 | Molecule coasts (approximately NVE) |
| 15b | Release in Move mode, damping>0 | Motion decays visibly |
| 16 | Rotate mode: 1-finger drag on atom (mobile) | Molecule rotates (torque) |
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

- **Automated physics tests:** open `page/test-rollback.html` in a browser (requires serving from repo root). Tests physics append/rollback/clear/invariants/components directly against the real `PhysicsEngine` class. Does NOT test the full `commitMolecule` orchestration path (renderer + session state coordination).
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

### Code Review Invariants

Check during PRs that modify controller modules:

| # | Invariant | What to check |
|---|-----------|--------------|
| R1 | No duplicate listeners | Each DOM element has one event handler per event type |
| R2 | Controller destroy() complete | Every addEventListener has matching removeEventListener in destroy() |
| R3 | State ownership respected | New state writes go through the authoritative writer (see architecture.md) |
| R4 | No controller cross-imports | Controllers don't import each other — use callbacks via main.ts |
| R5 | New globals tracked | Any new window/document listener uses addGlobalListener() |
