/**
 * Watch ↔ Lab handoff — shared transport + validation contract.
 *
 * Lives under `src/` so both Watch (writer) and Lab (consumer) can import
 * type + runtime helpers without crossing the app boundary.
 *
 * Rev 5/6 notes:
 *   - Float64Array fields (`positions`, `velocities`) are base64-encoded on
 *     write and decoded on consume. Shrinks a 10k-atom seed payload from
 *     ~2 MB JSON-of-numbers to ~340 KB base64, and cuts the storage
 *     setItem latency from 30–50 ms to <5 ms on mid-range devices.
 *   - `isValidSeed()` enforces concrete bounds and a prototype-pollution
 *     guard so a hand-crafted storage payload cannot crash Lab.
 *
 * Rev 7 note:
 *   - Backing store is `localStorage`, not `sessionStorage`. The Lab-entry
 *     links open in a new tab with `noopener,noreferrer`, which creates a
 *     fresh session-storage namespace in the new tab — a sessionStorage
 *     handoff would be invisible to Lab. localStorage is origin-scoped so
 *     the handoff survives the new-tab crossing. The 10-min TTL + pre-
 *     write sweep keeps the effective lifetime short.
 */

import { IMPLAUSIBLE_VELOCITY_A_PER_FS } from '../history/units';

export const HANDOFF_STORAGE_PREFIX = 'atomdojo.watchLabHandoff:';
export const HANDOFF_TTL_MS_DEFAULT = 10 * 60 * 1000; // 10 min

/** Ceilings for seed validation — match (or are stricter than) Lab's own
 *  full-history importer thresholds. */
export const SEED_MAX_ATOMS = 50_000;
export const SEED_MAX_BONDS = 100_000;
/** Canonical re-export for tests + readability. Matches the single
 *  source of truth in src/history/units.ts (value: 10.0). Any future
 *  change to that constant flows through automatically. */
export const SEED_MAX_VELOCITY_A_PER_FS = IMPLAUSIBLE_VELOCITY_A_PER_FS;
/** Å — boundary / position magnitude ceiling. */
export const SEED_MAX_POSITION_A = 1e4;

export interface WatchLabAtomInfo {
  id: number;
  element: string;
  isotope?: number | null;
  charge?: number | null;
  label?: string | null;
}

export interface WatchLabBond {
  a: number;
  b: number;
  distance: number;
}

export interface WatchLabConfig {
  damping: number;
  kDrag: number;
  kRotate: number;
  dtFs: number;
  dampingRefDurationFs: number;
}

/** Concrete boundary shape — matches the object `physics.getBoundarySnapshot()`
 *  produces and `physics.restoreBoundarySnapshot()` consumes (see
 *  `lab/js/physics.ts:1426` / `:1445`). This is the only wire vocabulary
 *  the handoff accepts; any future schema expansion requires updating
 *  both sides together rather than letting a wider `[key]: unknown`
 *  escape hatch drift silently. */
export interface WatchLabBoundary {
  mode: 'contain' | 'remove';
  wallRadius: number;
  wallCenter: [number, number, number];
  wallCenterSet: boolean;
  removedCount: number;
  damping: number;
}

export interface WatchLabSceneSeed {
  /** Shared atom metadata (reuses the `AtomInfoV1` wire shape). */
  atoms: WatchLabAtomInfo[];
  /** Interleaved x,y,z per atom; length === atoms.length * 3.
   *  Serialized as base64 of the underlying Float64Array buffer. */
  positions: number[];
  /** Interleaved vx,vy,vz per atom. Null → Lab hydrates cold (zeros). */
  velocities: number[] | null;
  bonds: WatchLabBond[];
  boundary: WatchLabBoundary;
  config: WatchLabConfig;
  provenance: { historyKind: 'full' | 'capsule'; velocitiesAreApproximated: boolean };
}

export interface WatchToLabHandoffPayload {
  version: 1;
  source: 'watch';
  mode: 'current-frame';
  createdAt: number;
  sourceMeta: {
    fileName: string | null;
    fileKind: string | null;
    shareCode: string | null;
    timePs: number;
    /** Zero-based dense-frame index at `timePs` in the source Watch
     *  document. Integer ≥ 0. Null when the Watch document does not
     *  expose a resolvable dense-frame index at the handoff time
     *  (defensive — all real paths set this).
     *
     *  Consumers that render this for users shift to a 1-based
     *  ordinal at display time (see
     *  `formatProvenancePillCopy` in `WatchHandoffProvenancePill.tsx`).
     *  Internal APIs, tests, and storage keep the zero-based value. */
    frameId: number | null;
  };
  seed: WatchLabSceneSeed;
}

// ── base64 <-> Float64Array helpers ──

export function base64EncodeFloat64Array(arr: number[] | Float64Array): string {
  const buf = arr instanceof Float64Array ? arr.buffer : new Float64Array(arr).buffer;
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    );
  }
  return btoa(binary);
}

export function base64DecodeFloat64Array(b64: string): number[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const floats = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
  // Return a plain number[] so consumers get the same shape the schema
  // advertises; callers that need a Float64Array can wrap.
  const out = new Array<number>(floats.length);
  for (let i = 0; i < floats.length; i++) out[i] = floats[i];
  return out;
}

// ── Serialization ──

interface WireSeed extends Omit<WatchLabSceneSeed, 'positions' | 'velocities'> {
  positions: string;  // base64
  velocities: string | null;
}

interface WirePayload extends Omit<WatchToLabHandoffPayload, 'seed'> {
  seed: WireSeed;
}

export function serializePayload(payload: WatchToLabHandoffPayload): string {
  const wire: WirePayload = {
    ...payload,
    seed: {
      ...payload.seed,
      positions: base64EncodeFloat64Array(payload.seed.positions),
      velocities: payload.seed.velocities
        ? base64EncodeFloat64Array(payload.seed.velocities)
        : null,
    },
  };
  return JSON.stringify(wire);
}

// ── Validation ──

function hasOwnOrdinaryObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function allFiniteBounded(
  arr: unknown,
  maxAbs: number,
  expectLength: number | null,
): arr is number[] {
  if (!Array.isArray(arr)) return false;
  if (expectLength != null && arr.length !== expectLength) return false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) return false;
    if (Math.abs(v as number) > maxAbs) return false;
  }
  return true;
}

function isValidBoundary(value: unknown): value is WatchLabBoundary {
  if (!hasOwnOrdinaryObject(value)) return false;
  const b = value as Record<string, unknown>;
  if (b.mode !== 'contain' && b.mode !== 'remove') return false;
  if (!Number.isFinite(b.wallRadius)) return false;
  if (Math.abs(b.wallRadius as number) > SEED_MAX_POSITION_A) return false;
  if (!Array.isArray(b.wallCenter) || b.wallCenter.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    const v = (b.wallCenter as unknown[])[i];
    if (!Number.isFinite(v)) return false;
    if (Math.abs(v as number) > SEED_MAX_POSITION_A) return false;
  }
  if (typeof b.wallCenterSet !== 'boolean') return false;
  if (!Number.isInteger(b.removedCount) || (b.removedCount as number) < 0) return false;
  if (!Number.isFinite(b.damping)) return false;
  const damping = b.damping as number;
  if (damping < 0 || damping > 10) return false;
  return true;
}

function isValidConfig(value: unknown): value is WatchLabConfig {
  if (!hasOwnOrdinaryObject(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    Number.isFinite(c.damping) &&
    (c.damping as number) >= 0 &&
    (c.damping as number) <= 10 &&
    Number.isFinite(c.kDrag) &&
    Number.isFinite(c.kRotate) &&
    Number.isFinite(c.dtFs) &&
    (c.dtFs as number) >= 0.001 &&
    // Upper bound covers typical MD timesteps (≤ 5 fs for most integrators);
    // stricter than Lab's actual runtime range but within realistic molecular dynamics.
    (c.dtFs as number) <= 10 &&
    Number.isFinite(c.dampingRefDurationFs)
  );
}

function isValidAtom(v: unknown): v is WatchLabAtomInfo {
  if (!hasOwnOrdinaryObject(v)) return false;
  const a = v as Record<string, unknown>;
  return (
    Number.isInteger(a.id) &&
    (a.id as number) >= 0 &&
    typeof a.element === 'string' &&
    (a.element as string).length > 0 &&
    (a.element as string).length <= 8
  );
}

function isValidBond(v: unknown, atomCount: number): v is WatchLabBond {
  if (!hasOwnOrdinaryObject(v)) return false;
  const b = v as Record<string, unknown>;
  return (
    Number.isInteger(b.a) &&
    Number.isInteger(b.b) &&
    (b.a as number) >= 0 &&
    (b.b as number) >= 0 &&
    (b.a as number) < atomCount &&
    (b.b as number) < atomCount &&
    Number.isFinite(b.distance) &&
    (b.distance as number) > 0 &&
    (b.distance as number) < 100
  );
}

export function isValidSeed(value: unknown): value is WatchLabSceneSeed {
  if (!hasOwnOrdinaryObject(value)) return false;
  const s = value as Record<string, unknown>;
  if (!Array.isArray(s.atoms) || s.atoms.length < 1 || s.atoms.length > SEED_MAX_ATOMS) return false;
  for (const a of s.atoms) if (!isValidAtom(a)) return false;
  const atomCount = s.atoms.length;
  if (!allFiniteBounded(s.positions, SEED_MAX_POSITION_A, atomCount * 3)) return false;
  if (s.velocities !== null) {
    if (!allFiniteBounded(s.velocities, SEED_MAX_VELOCITY_A_PER_FS, atomCount * 3)) return false;
  }
  if (!Array.isArray(s.bonds) || s.bonds.length > SEED_MAX_BONDS) return false;
  for (const b of s.bonds) if (!isValidBond(b, atomCount)) return false;
  if (!isValidBoundary(s.boundary)) return false;
  if (!isValidConfig(s.config)) return false;
  if (!hasOwnOrdinaryObject(s.provenance)) return false;
  const prov = s.provenance as Record<string, unknown>;
  if (prov.historyKind !== 'full' && prov.historyKind !== 'capsule') return false;
  if (typeof prov.velocitiesAreApproximated !== 'boolean') return false;
  return true;
}

export function isValidPayload(value: unknown): value is WatchToLabHandoffPayload {
  if (!hasOwnOrdinaryObject(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.version !== 1) return false;
  if (p.source !== 'watch') return false;
  if (p.mode !== 'current-frame') return false;
  if (!Number.isFinite(p.createdAt)) return false;
  if (!hasOwnOrdinaryObject(p.sourceMeta)) return false;
  const meta = p.sourceMeta as Record<string, unknown>;
  if (meta.fileName !== null && typeof meta.fileName !== 'string') return false;
  if (meta.fileKind !== null && typeof meta.fileKind !== 'string') return false;
  if (meta.shareCode !== null && typeof meta.shareCode !== 'string') return false;
  if (!Number.isFinite(meta.timePs)) return false;
  // frameId: null or non-negative integer. Absent is equivalent to null
  // (back-compat with pre-pill handoffs minted before the field existed;
  // those payloads are still in-flight under the 10-min TTL at deploy).
  if (meta.frameId !== undefined && meta.frameId !== null) {
    if (typeof meta.frameId !== 'number' || !Number.isInteger(meta.frameId) || meta.frameId < 0) {
      return false;
    }
  }
  if (!isValidSeed(p.seed)) return false;
  return true;
}

// ── Deserialization ──

export type ConsumeReason =
  | 'missing-token'
  | 'missing-entry'
  | 'parse-error'
  | 'unknown-version'
  | 'wrong-source'
  | 'wrong-mode'
  | 'stale'
  | 'malformed-seed';

export interface ConsumeResult {
  status: 'ready' | 'rejected';
  reason?: ConsumeReason;
  payload?: WatchToLabHandoffPayload;
}

export function deserializeAndValidate(
  raw: string,
  nowMs: number,
  ttlMs: number,
): ConsumeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'rejected', reason: 'parse-error' };
  }
  if (!hasOwnOrdinaryObject(parsed)) return { status: 'rejected', reason: 'parse-error' };
  const wire = parsed as Record<string, unknown>;
  if (wire.version !== 1) return { status: 'rejected', reason: 'unknown-version' };
  if (wire.source !== 'watch') return { status: 'rejected', reason: 'wrong-source' };
  if (wire.mode !== 'current-frame') return { status: 'rejected', reason: 'wrong-mode' };
  if (!Number.isFinite(wire.createdAt)) return { status: 'rejected', reason: 'parse-error' };
  // Age must be in `[0, ttlMs]`. Negative age (future-dated `createdAt`)
  // is rejected as stale so a hand-crafted forward-dated payload cannot
  // outlive its TTL budget. See rev 6 correctness audit #3.
  const age = nowMs - (wire.createdAt as number);
  if (age < 0 || age > ttlMs) return { status: 'rejected', reason: 'stale' };

  // Decode the base64 arrays into number[] before running full validation.
  const wireSeed = wire.seed;
  if (!hasOwnOrdinaryObject(wireSeed)) return { status: 'rejected', reason: 'malformed-seed' };
  const ws = wireSeed as Record<string, unknown>;
  let positions: number[];
  let velocities: number[] | null;
  try {
    if (typeof ws.positions !== 'string') return { status: 'rejected', reason: 'malformed-seed' };
    positions = base64DecodeFloat64Array(ws.positions);
    if (ws.velocities == null) {
      velocities = null;
    } else if (typeof ws.velocities === 'string') {
      velocities = base64DecodeFloat64Array(ws.velocities);
    } else {
      return { status: 'rejected', reason: 'malformed-seed' };
    }
  } catch {
    return { status: 'rejected', reason: 'malformed-seed' };
  }

  // Reconstruct the seed with DECODED numeric arrays and validate.
  const rebuiltSeed = { ...ws, positions, velocities } as unknown;
  if (!isValidSeed(rebuiltSeed)) return { status: 'rejected', reason: 'malformed-seed' };

  // Normalize sourceMeta so every consumer sees a stable shape — in
  // particular, pre-pill handoffs (minted before `frameId` was added to
  // the schema but still in-flight under the 10-min TTL) deserialize
  // with `frameId: null` rather than `undefined`. Downstream code
  // reads the field unconditionally. Malformed sourceMeta (null, array,
  // primitive) is left untouched; `isValidPayload` below rejects it.
  let normalizedSourceMeta: unknown = wire.sourceMeta;
  if (hasOwnOrdinaryObject(normalizedSourceMeta)) {
    const m = normalizedSourceMeta as Record<string, unknown>;
    normalizedSourceMeta = {
      fileName: m.fileName,
      fileKind: m.fileKind,
      shareCode: m.shareCode,
      timePs: m.timePs,
      frameId: m.frameId ?? null,
    };
  }

  const rebuilt = {
    version: wire.version,
    source: wire.source,
    mode: wire.mode,
    createdAt: wire.createdAt,
    sourceMeta: normalizedSourceMeta,
    seed: rebuiltSeed,
  } as unknown;

  // Final guard — full payload shape including sourceMeta field types.
  // Without this, a malformed sourceMeta (e.g. sourceMeta = null or
  // timePs = "oops") slips through after the seed passes validation.
  // Correctness audit rev 6 #2.
  if (!isValidPayload(rebuilt)) return { status: 'rejected', reason: 'malformed-seed' };

  return { status: 'ready', payload: rebuilt as WatchToLabHandoffPayload };
}
