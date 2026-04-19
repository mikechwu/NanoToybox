/**
 * Watch → Lab scene-seed extraction.
 *
 * `buildWatchLabSceneSeed(args)` is the full allocation path; runs ONLY
 * on a Continue-intent click (tooltip-hover cache mint). Allocates
 * Float64Array-shaped position/velocity arrays and returns the transit
 * payload, or null when the frame cannot produce a seed. File-level
 * availability is gated upstream by the controller via
 * `playback.findNearestSeedableTimePs`, which snaps unseedable cursor
 * times to the nearest seedable dense frame before the builder runs.
 *
 * Velocity policy:
 *   - full history: use nearest restart frame's velocities when aligned.
 *   - capsule history: central-difference / forward-difference /
 *     backward-difference over neighboring dense frames, converted from
 *     Å/ps to Å/fs (dense frame timestamps are in ps).
 *   - clamp per-atom: any component magnitude > IMPLAUSIBLE_VELOCITY_A_PER_FS
 *     zeros that atom's velocity vector entirely.
 *   - if > 20% of atoms end up zeroed, promote `velocities` to null
 *     (cold-start hydrate) rather than shipping biased partial data.
 */

import type { WatchPlaybackModel, LoadedWatchHistory } from '../playback/watch-playback-model';
import type { AtomInfoV1 } from '../../../src/history/history-file-v1';
import { IMPLAUSIBLE_VELOCITY_A_PER_FS } from '../../../src/history/units';
import type { NormalizedRestartFrame } from '../document/full-history-import';
import type {
  WatchLabSceneSeed,
  WatchLabBoundary,
  WatchLabConfig,
  WatchLabColorAssignment,
  WatchLabOrbitCamera,
  WatchLabVelocitySource,
} from '../../../src/watch-lab-handoff/watch-lab-handoff-shared';
import type { WatchColorAssignment } from '../analysis/watch-bonded-group-appearance';

export interface BuildArgs {
  history: LoadedWatchHistory;
  timePs: number;
  playback: WatchPlaybackModel;
  /** Phase 1 — Watch authored-color authority getter. Absent or
   *  returning `undefined` → `[]` on the wire. Assignments whose
   *  `atomIds` do not resolve in the current display frame's atom
   *  manifest are dropped with a `console.warn`. */
  getColorAssignments?: () => readonly WatchColorAssignment[];
  /** Phase 2 — live renderer orbit-camera snapshot getter. Absent OR
   *  returning `null` → `camera: null` on the wire (fail-closed). */
  getOrbitCameraSnapshot?: () => WatchLabOrbitCamera | null;
  /** Optional defaults for boundary + config when a capsule history
   *  provides no simulation state. Both fields fall back to hardcoded
   *  safe values inside the builder when omitted. */
  capsuleBoundaryDefault?: WatchLabBoundary;
  capsuleConfigDefault?: WatchLabConfig;
}

/** Fraction of atoms zeroed beyond which we drop to cold-start. */
const VELOCITY_ZERO_FRACTION_COLD_THRESHOLD = 0.2;

/** Femtoseconds per picosecond. Dense-frame timestamps are in ps; Lab's
 *  physics integrator consumes velocities in Å/fs. Conversion: 1 ps = 1000 fs. */
const FS_PER_PS = 1000;

/** Safe capsule defaults — neutral boundary (contain mode, large radius,
 *  no wall removal) + conservative integrator config. These are NOT sourced
 *  from Lab's PhysicsEngine constructor (which is Lab-only code Watch must
 *  not import); the Lab-side hydrate can still override with engine-canonical
 *  values when it lands. */
const CAPSULE_BOUNDARY_DEFAULT: WatchLabBoundary = {
  mode: 'contain',
  wallRadius: 100,
  wallCenter: [0, 0, 0],
  wallCenterSet: false,
  removedCount: 0,
  damping: 0.05,
};

const CAPSULE_CONFIG_DEFAULT: WatchLabConfig = {
  damping: 0.05,
  kDrag: 1,
  kRotate: 1,
  dtFs: 0.5,
  dampingRefDurationFs: 100,
};

/**
 * Build an atom-id → AtomInfoV1 lookup map from the history's atom list.
 * O(n) construction; subsequent lookups are O(1). Used once per
 * `buildWatchLabSceneSeed` call to avoid O(n²) scans over large scenes.
 */
function buildAtomIndex(
  atoms: readonly AtomInfoV1[],
): ReadonlyMap<number, AtomInfoV1> {
  const m = new Map<number, AtomInfoV1>();
  for (const a of atoms) m.set(a.id, a);
  return m;
}

/**
 * Central/forward/backward difference velocity approximation for a
 * single atom between two frames whose positions share the same index.
 * Returns Å/fs component triple.
 */
function finiteDifferenceVelocity(
  prevPos: Float64Array, prevTimePs: number,
  nextPos: Float64Array, nextTimePs: number,
  atomIndexPrev: number, atomIndexNext: number,
): [number, number, number] | null {
  const dtFs = (nextTimePs - prevTimePs) * FS_PER_PS;
  if (!(dtFs > 0)) return null;
  const i3a = atomIndexPrev * 3;
  const i3b = atomIndexNext * 3;
  return [
    (nextPos[i3b] - prevPos[i3a]) / dtFs,
    (nextPos[i3b + 1] - prevPos[i3a + 1]) / dtFs,
    (nextPos[i3b + 2] - prevPos[i3a + 2]) / dtFs,
  ];
}

function isImplausible(v: number): boolean {
  return !Number.isFinite(v) || Math.abs(v) > IMPLAUSIBLE_VELOCITY_A_PER_FS;
}

/** Attempt to locate the nearest restart frame at-or-before `timePs` for a
 *  full history. Returns null when no restart frame covers the time. */
function findNearestRestartFrame(
  history: Extract<LoadedWatchHistory, { kind: 'full' }>,
  timePs: number,
): NormalizedRestartFrame | null {
  let candidate: NormalizedRestartFrame | null = null;
  for (const rf of history.restartFrames) {
    if (rf.timePs <= timePs) candidate = rf;
    else break;
  }
  return candidate;
}

/**
 * Full builder — allocates the seed arrays and runs the velocity
 * approximation path. Call ONCE per `Remix This Moment` click.
 * Returns null when the playback state cannot produce a coherent seed.
 */
export function buildWatchLabSceneSeed(args: BuildArgs): WatchLabSceneSeed | null {
  const { history, timePs, playback } = args;
  if (!history) return null;

  const display = playback.getDisplayPositionsAtTime(timePs);
  if (!display) return null;
  const topology = playback.getTopologyAtTime(timePs);
  if (!topology) return null;

  const n = display.n;
  if (n < 1) return null;

  // ── 1. atoms + positions aligned to display-frame ordering ──
  // Build the lookup map once — O(n) — instead of scanning per atom.
  const atomIndex = buildAtomIndex(history.atoms);
  const atoms: AtomInfoV1[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const info = atomIndex.get(display.atomIds[i]);
    if (!info) return null;
    atoms[i] = info;
  }
  // positions are already Float64Array-backed; convert to number[] for
  // the wire type (which the base64 codec re-packs into a buffer).
  const positions = new Array<number>(n * 3);
  for (let i = 0; i < n * 3; i++) positions[i] = display.positions[i];

  // ── 2. bonds ──
  const bonds = topology.bonds.map(([a, b, distance]) => ({ a, b, distance }));

  // ── 3. velocities + config + boundary + provenance ──
  let velocities: number[] | null = null;
  let config: WatchLabConfig;
  let boundary: WatchLabBoundary;
  let velocitiesAreApproximated = false;
  let velocitySource: WatchLabVelocitySource = 'restart';
  let unresolvedVelocityFraction = 0;

  if (history.kind === 'full' && history.velocityUnit === 'angstrom-per-fs') {
    const restart = findNearestRestartFrame(history, timePs);
    if (restart && restart.n === n) {
      // Copy velocities in the same atom-id order as display frame.
      // Restart frames may order atomIds differently; rebuild index.
      const out = new Array<number>(n * 3);
      const restartIndexById = new Map<number, number>();
      for (let i = 0; i < restart.atomIds.length; i++) {
        restartIndexById.set(restart.atomIds[i], i);
      }
      let unresolved = 0;
      for (let i = 0; i < n; i++) {
        const rIdx = restartIndexById.get(display.atomIds[i]);
        if (rIdx == null) { unresolved++; out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = 0; continue; }
        const j3 = rIdx * 3;
        out[i * 3] = restart.velocities[j3];
        out[i * 3 + 1] = restart.velocities[j3 + 1];
        out[i * 3 + 2] = restart.velocities[j3 + 2];
      }
      unresolvedVelocityFraction = unresolved / n;
      if (unresolved / n <= VELOCITY_ZERO_FRACTION_COLD_THRESHOLD) {
        velocities = out;
        velocitySource = 'restart';
      } else {
        velocitySource = 'none';
      }
      // Configure + boundary from restart frame.
      const rc = restart.config;
      config = {
        damping: rc.damping,
        kDrag: rc.kDrag,
        kRotate: rc.kRotate,
        dtFs: rc.dtFs,
        dampingRefDurationFs: rc.dampingRefDurationFs,
      };
      // Boundary is typed `unknown` in NormalizedRestartFrame; narrow
      // to the canonical shape only if it matches. Otherwise fall back.
      const rb = restart.boundary as Partial<WatchLabBoundary> | null;
      if (rb && (rb.mode === 'contain' || rb.mode === 'remove')) {
        boundary = {
          mode: rb.mode,
          wallRadius: Number.isFinite(rb.wallRadius) ? rb.wallRadius as number : CAPSULE_BOUNDARY_DEFAULT.wallRadius,
          wallCenter: Array.isArray(rb.wallCenter) && rb.wallCenter.length === 3
            ? [rb.wallCenter[0] as number, rb.wallCenter[1] as number, rb.wallCenter[2] as number]
            : [0, 0, 0],
          wallCenterSet: typeof rb.wallCenterSet === 'boolean' ? rb.wallCenterSet : false,
          removedCount: Number.isInteger(rb.removedCount) ? rb.removedCount as number : 0,
          damping: Number.isFinite(rb.damping) ? rb.damping as number : config.damping,
        };
      } else {
        boundary = args.capsuleBoundaryDefault ?? CAPSULE_BOUNDARY_DEFAULT;
      }
    } else {
      // Fall through to capsule-style approximation below.
      velocitiesAreApproximated = true;
      config = args.capsuleConfigDefault ?? CAPSULE_CONFIG_DEFAULT;
      boundary = args.capsuleBoundaryDefault ?? CAPSULE_BOUNDARY_DEFAULT;
    }
  } else {
    // Capsule (or full with unknown velocity unit) — approximate.
    velocitiesAreApproximated = true;
    config = args.capsuleConfigDefault ?? CAPSULE_CONFIG_DEFAULT;
    boundary = args.capsuleBoundaryDefault ?? CAPSULE_BOUNDARY_DEFAULT;

    const displayIndex = playback.getDisplayFrameIndexAtTime(timePs);
    if (displayIndex == null) return null;
    const { prev: prevIdx, next: nextIdx } = playback.getNeighborDenseFrameIndices(displayIndex);
    const denseFrames = history.denseFrames;

    // Build an atom-id → index-in-frame map for any frame we need to
    // sample, so finite-difference sees aligned data.
    const indexInFrame = (frame: typeof denseFrames[0]) => {
      const m = new Map<number, number>();
      for (let i = 0; i < frame.atomIds.length; i++) m.set(frame.atomIds[i], i);
      return m;
    };
    const curIndexMap = indexInFrame(denseFrames[displayIndex]);
    const prevFrame = prevIdx != null ? denseFrames[prevIdx] : null;
    const nextFrame = nextIdx != null ? denseFrames[nextIdx] : null;
    const prevMap = prevFrame ? indexInFrame(prevFrame) : null;
    const nextMap = nextFrame ? indexInFrame(nextFrame) : null;

    const out = new Array<number>(n * 3);
    let zeroedCount = 0;
    let centralCount = 0;
    let forwardCount = 0;
    let backwardCount = 0;
    for (let i = 0; i < n; i++) {
      const atomId = display.atomIds[i];
      const curJ = curIndexMap.get(atomId);
      if (curJ == null) { zeroedCount++; out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = 0; continue; }
      let v: [number, number, number] | null = null;
      let source: 'central' | 'forward' | 'backward' | null = null;
      const prevJ = prevMap?.get(atomId);
      const nextJ = nextMap?.get(atomId);
      if (prevFrame && nextFrame && prevJ != null && nextJ != null) {
        v = finiteDifferenceVelocity(
          prevFrame.positions, prevFrame.timePs,
          nextFrame.positions, nextFrame.timePs,
          prevJ, nextJ,
        );
        source = 'central';
      } else if (nextFrame && nextJ != null) {
        v = finiteDifferenceVelocity(
          denseFrames[displayIndex].positions, denseFrames[displayIndex].timePs,
          nextFrame.positions, nextFrame.timePs,
          curJ, nextJ,
        );
        source = 'forward';
      } else if (prevFrame && prevJ != null) {
        v = finiteDifferenceVelocity(
          prevFrame.positions, prevFrame.timePs,
          denseFrames[displayIndex].positions, denseFrames[displayIndex].timePs,
          prevJ, curJ,
        );
        source = 'backward';
      }
      if (!v || isImplausible(v[0]) || isImplausible(v[1]) || isImplausible(v[2])) {
        zeroedCount++;
        out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = 0;
      } else {
        out[i * 3] = v[0];
        out[i * 3 + 1] = v[1];
        out[i * 3 + 2] = v[2];
        if (source === 'central') centralCount++;
        else if (source === 'forward') forwardCount++;
        else if (source === 'backward') backwardCount++;
      }
    }
    unresolvedVelocityFraction = zeroedCount / n;
    // >20% zeroed → cold-start (null velocities) rather than shipping
    // biased partial data.
    if (zeroedCount / n > VELOCITY_ZERO_FRACTION_COLD_THRESHOLD) {
      velocities = null;
      velocitySource = 'none';
    } else {
      velocities = out;
      // Collapse per-atom sources into a single tag. If exactly one
      // source produced all resolved atoms → that tag. Else → 'mixed'.
      const activeSources = [
        centralCount > 0 ? 'central-difference' : null,
        forwardCount > 0 ? 'forward-difference' : null,
        backwardCount > 0 ? 'backward-difference' : null,
      ].filter((s): s is WatchLabVelocitySource => s !== null);
      if (activeSources.length === 1) {
        velocitySource = activeSources[0];
      } else if (activeSources.length === 0) {
        // Unreachable under the current threshold: the >20% zeroed
        // short-circuit above already sets `'none'` and returns.
        // Reaching here means at least one atom's velocity was
        // resolved, so at least one source counter is non-zero. Log
        // and fall back defensively if a future threshold change
        // makes this branch live.
        console.warn('[watch.seed] unreachable: resolved velocities with no active source — defaulting to "none"');
        velocitySource = 'none';
      } else {
        velocitySource = 'mixed';
      }
    }
  }

  // ── 4. Authored colors (phase 1). Reject assignments whose stable
  //       atomIds do not resolve in the current display frame's atom
  //       manifest. Preserve order for deterministic "later wins". ──
  const colorAssignments: WatchLabColorAssignment[] = [];
  if (args.getColorAssignments) {
    const source = args.getColorAssignments();
    if (source && source.length > 0) {
      const atomIdSet = new Set<number>();
      for (const a of atoms) atomIdSet.add(a.id);
      for (const a of source) {
        let allResolved = a.atomIds.length > 0;
        for (const id of a.atomIds) {
          if (!atomIdSet.has(id)) { allResolved = false; break; }
        }
        if (!allResolved) {
          console.warn(
            `[watch.seed] color assignment ${a.id} dropped — unknown atomId in current frame`,
          );
          continue;
        }
        colorAssignments.push({
          id: a.id,
          atomIds: a.atomIds.slice(),
          colorHex: a.colorHex,
          sourceGroupId: a.sourceGroupId,
        });
      }
    }
  }

  // ── 5. Orbit-camera snapshot (phase 2). Null is valid — fail-closed. ──
  const camera: WatchLabOrbitCamera | null = args.getOrbitCameraSnapshot
    ? (args.getOrbitCameraSnapshot() ?? null)
    : null;

  return {
    atoms,
    positions,
    velocities,
    bonds,
    boundary,
    config,
    colorAssignments,
    camera,
    provenance: {
      historyKind: history.kind,
      velocitySource,
      velocitiesAreApproximated,
      unresolvedVelocityFraction,
    },
  };
}
