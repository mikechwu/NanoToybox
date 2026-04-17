/**
 * `normalizeWatchSeed` — single conversion pass from a validated
 * `WatchLabSceneSeed` into the concrete shapes every Lab-side hydrate
 * authority expects. Consumed by (a) main-thread `physics.restoreCheckpoint`
 * + `restoreBoundarySnapshot`, (b) worker `restoreState`, (c) scene-runtime
 * metadata / renderer registration. The hydrate contract in plan §7
 * requires a single normalization pass so both physics authorities
 * cannot drift at construction time.
 *
 * Correctness property (plan rev 4 S6): "same normalization-pass data",
 * NOT referential object identity. Both authorities read values derived
 * from the same source, but each gets its own shape (checkpoint-shape
 * for main-thread, separate arguments for worker).
 */

import type { BondTuple } from '../types/interfaces';
import type { PhysicsConfig, WorkerCommand } from '../types/worker-protocol';
import type {
  WatchLabColorAssignment,
  WatchLabOrbitCamera,
  WatchLabSceneSeed,
  WatchLabVelocitySource,
} from './watch-lab-handoff-shared';

/** Tiny structural shape matching `lab/js/placement.ts::StructureAtom`.
 *  Duplicated here (rather than imported) so `src/` has no Lab dep.
 *  Shapes are trivially compatible via duck-typing. */
export interface StructureAtomShape {
  element: string;
  x: number;
  y: number;
  z: number;
}

/** Shape of `physics.restoreBoundarySnapshot` / worker restoreState
 *  `boundary` — aliased from the worker protocol so both sides share
 *  one source of truth. */
export type NormalizedBoundary = Extract<WorkerCommand, { type: 'restoreState' }>['boundary'];

export interface NormalizedWatchHydratePayload {
  /** Atom count; equals `localStructureAtoms.length`. */
  n: number;

  // ── Worker config + boundary (byte-for-byte the shape the worker
  //    expects; see src/types/worker-protocol.ts). ──
  workerConfig: PhysicsConfig;
  bonds: BondTuple[];
  velocities: Float64Array;
  boundary: NormalizedBoundary;

  // ── Primary atom-data view: what both main-thread physics
  //    `appendMolecule` and the renderer `populateAppendedAtoms` +
  //    scene-runtime registry consume. One shape, all consumers. ──
  /** `{ element, x, y, z }` per atom in display order. */
  localStructureAtoms: StructureAtomShape[];

  /** Authored color assignments carried across the handoff. Stable-ID
   *  identity quartet; Lab re-derives dense `atomIndices` at hydrate
   *  time after tracker/registry restoration. Empty array when Watch
   *  had no authored colors. */
  colorAssignments: WatchLabColorAssignment[];

  /** Orbit-camera snapshot at click time. `null` → Lab applies its
   *  default framing. */
  camera: WatchLabOrbitCamera | null;

  // ── Provenance for console diagnostics + motion-fidelity honesty. ──
  provenance: {
    historyKind: 'full' | 'capsule';
    velocitySource: WatchLabVelocitySource;
    velocitiesAreApproximated: boolean;
    unresolvedVelocityFraction: number;
  };
}

/**
 * Convert a validated `WatchLabSceneSeed` into its normalized hydrate
 * payload. Assumes the seed has already passed `isValidSeed` in the
 * consume path — this function never throws on well-formed input.
 *
 * Contract invariants verified by tests:
 *   1. `n === seed.atoms.length === localStructureAtoms.length`.
 *   2. `velocities.length === n * 3` (zeroed when
 *      `seed.velocities === null` — cold start).
 *   3. `localStructureAtoms[i]` xyz and element correspond to the
 *      same index in `seed.atoms` and `seed.positions[i*3..i*3+2]`.
 *   4. `workerConfig.wallMode === boundary.mode` (worker config
 *      must agree with the boundary snapshot).
 */
export function normalizeWatchSeed(seed: WatchLabSceneSeed): NormalizedWatchHydratePayload {
  const n = seed.atoms.length;
  const stride3 = n * 3;

  // Velocities: number[] | null → Float64Array. Null becomes zero-fill
  // (cold start — same policy as the worker init path).
  const velocities = new Float64Array(stride3);
  if (seed.velocities) {
    for (let i = 0; i < stride3; i++) velocities[i] = seed.velocities[i];
  }
  // else: already zero-initialized by `new Float64Array(...)`.

  // Single atom-data view derived from seed positions in display order.
  const localStructureAtoms: StructureAtomShape[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    localStructureAtoms[i] = {
      element: seed.atoms[i].element,
      x: seed.positions[i3],
      y: seed.positions[i3 + 1],
      z: seed.positions[i3 + 2],
    };
  }

  // Bonds: `{a, b, distance}` → `[a, b, distance]` tuple (the shape
  // physics.appendMolecule and worker.appendMolecule both consume).
  const bonds: BondTuple[] = seed.bonds.map((bb) => [bb.a, bb.b, bb.distance]);

  // Boundary: WatchLabBoundary → NormalizedBoundary. Same shape in
  // practice; the alias documents which end of the wire each side
  // consumes from.
  const boundary: NormalizedBoundary = {
    mode: seed.boundary.mode,
    wallRadius: seed.boundary.wallRadius,
    wallCenter: [
      seed.boundary.wallCenter[0],
      seed.boundary.wallCenter[1],
      seed.boundary.wallCenter[2],
    ],
    wallCenterSet: seed.boundary.wallCenterSet,
    removedCount: seed.boundary.removedCount,
    damping: seed.boundary.damping,
  };

  // WorkerConfig: WatchLabConfig → PhysicsConfig. Both fields of the
  // damping-timing pair (`dampingReferenceSteps` — step count — and
  // `dampingRefDurationFs` — the physical window) are propagated. The
  // duration is the semantically authoritative one: the engine's
  // `_recomputeDampingFactor` uses it (not `dt * refSteps`) as the
  // decay window, so omitting it would silently drop the handed-off
  // damping calibration even though the TS types align. See
  // `physics.ts::setTimeConfig` three-arg overload + audit rev 8 P1.
  //
  // `useWasm: true` matches the project's typical runtime policy; the
  // worker negotiates its own WASM availability on the receiving side.
  const workerConfig: PhysicsConfig = {
    dt: seed.config.dtFs,
    dampingReferenceSteps: Math.max(
      1,
      Math.round(seed.config.dampingRefDurationFs / Math.max(1e-9, seed.config.dtFs)),
    ),
    // Preserve the authoritative damping window end-to-end so
    // post-hydrate physics uses the same decay calibration the
    // recording was made with.
    dampingRefDurationFs: seed.config.dampingRefDurationFs,
    damping: seed.config.damping,
    kDrag: seed.config.kDrag,
    kRotate: seed.config.kRotate,
    wallMode: boundary.mode,
    useWasm: true,
  };

  // Color assignments — structural deep-copy so downstream mutations
  // (dense-index re-derivation at hydrate time) cannot reach back into
  // the consumed wire payload. Absent on legacy tokens → [].
  const rawColor = (seed as { colorAssignments?: unknown }).colorAssignments;
  const colorAssignments: WatchLabColorAssignment[] = Array.isArray(rawColor)
    ? (rawColor as WatchLabColorAssignment[]).map((a) => ({
        id: a.id,
        atomIds: a.atomIds.slice(),
        colorHex: a.colorHex,
        sourceGroupId: a.sourceGroupId,
      }))
    : [];

  // Camera — structural copy; absent on legacy tokens → null. Guard
  // against array inputs (which pass `typeof === 'object'`) so a direct
  // `normalizeWatchSeed` caller that bypasses `isValidSeed` cannot crash
  // when reading `.position[0]` on an array shell.
  const rawCamera = (seed as { camera?: unknown }).camera;
  const camera: WatchLabOrbitCamera | null =
    rawCamera && typeof rawCamera === 'object' && !Array.isArray(rawCamera)
      ? {
          position: [
            (rawCamera as WatchLabOrbitCamera).position[0],
            (rawCamera as WatchLabOrbitCamera).position[1],
            (rawCamera as WatchLabOrbitCamera).position[2],
          ],
          target: [
            (rawCamera as WatchLabOrbitCamera).target[0],
            (rawCamera as WatchLabOrbitCamera).target[1],
            (rawCamera as WatchLabOrbitCamera).target[2],
          ],
          up: [
            (rawCamera as WatchLabOrbitCamera).up[0],
            (rawCamera as WatchLabOrbitCamera).up[1],
            (rawCamera as WatchLabOrbitCamera).up[2],
          ],
          fovDeg: (rawCamera as WatchLabOrbitCamera).fovDeg,
        }
      : null;

  // Provenance — legacy-token defaults. `velocitySource` is derived
  // from the existing boolean; `unresolvedVelocityFraction` defaults to 0.
  const rawProv = seed.provenance as {
    historyKind: 'full' | 'capsule';
    velocitiesAreApproximated: boolean;
    velocitySource?: WatchLabVelocitySource;
    unresolvedVelocityFraction?: number;
  };
  // Defense-in-depth: `isValidSeed` already gates `velocitySource`
  // against the canonical set on the token-decode path, but direct
  // `normalizeWatchSeed(...)` callers (tests, future paths) can bypass
  // that gate. Coerce any unrecognized value to `'none'` so downstream
  // consumers never see junk in provenance.
  const VALID_VELOCITY_SOURCES: ReadonlySet<string> = new Set([
    'restart', 'central-difference', 'forward-difference',
    'backward-difference', 'mixed', 'none',
  ]);
  const rawVs = rawProv.velocitySource;
  const velocitySource: WatchLabVelocitySource =
    rawVs != null && VALID_VELOCITY_SOURCES.has(rawVs)
      ? rawVs
      : (rawProv.velocitiesAreApproximated ? 'mixed' : 'restart');
  const unresolvedVelocityFraction = Number.isFinite(rawProv.unresolvedVelocityFraction)
    ? (rawProv.unresolvedVelocityFraction as number)
    : 0;

  return {
    n,
    workerConfig,
    bonds,
    velocities,
    boundary,
    localStructureAtoms,
    colorAssignments,
    camera,
    provenance: {
      historyKind: rawProv.historyKind,
      velocitySource,
      velocitiesAreApproximated: rawProv.velocitiesAreApproximated,
      unresolvedVelocityFraction,
    },
  };
}
