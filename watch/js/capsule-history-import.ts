/**
 * Capsule history importer — normalizes both capsule and legacy reduced files
 * into a unified LoadedCapsuleHistory runtime type.
 *
 * Capsule files (kind: 'capsule') get full validation: mandatory bondPolicy,
 * frameId monotonicity, appearance/interaction normalization.
 *
 * Legacy reduced files (kind: 'reduced') get relaxed validation: optional
 * bondPolicy (falls back to BOND_DEFAULTS), no frameId uniqueness check,
 * frame-local interaction/boundary payloads preserved as-is.
 *
 * The runtime output is always LoadedCapsuleHistory — the legacy 'reduced'
 * kind string is erased at import time.
 */

import type {
  AtomDojoReducedFileV1,
  AtomDojoPlaybackCapsuleFileV1,
  AtomInfoV1,
  CapsuleAppearanceV1,
  CapsuleInteractionTimelineV1,
  CapsuleInteractionEventV1,
} from '../../src/history/history-file-v1';
import type { BondPolicyV1 } from '../../src/history/bond-policy-v1';
import { isBondPolicyId, KNOWN_BOND_POLICY_IDS } from '../../src/history/bond-policy-v1';
import { buildExportBondPolicy } from '../../src/topology/bond-policy-resolver';
import type { NormalizedDenseFrame } from './full-history-import';

// ── Normalized appearance/interaction types ──

export interface NormalizedColorAssignment {
  atomIds: number[];
  colorHex: string;
}

export interface NormalizedAppearanceState {
  colorAssignments: NormalizedColorAssignment[];
}

export type NormalizedInteractionState =
  | { kind: 'none' }
  | { kind: 'atom_drag'; atomId: number; target: [number, number, number] }
  | { kind: 'move_group'; atomId: number; target: [number, number, number] }
  | { kind: 'rotate_group'; atomId: number; target: [number, number, number] };

export interface NormalizedInteractionTimeline {
  events: CapsuleInteractionEventV1[];
}

// ── Loaded capsule history (unified runtime type) ──

export interface LoadedCapsuleHistory {
  kind: 'capsule';
  simulation: {
    units: { time: 'ps'; length: 'angstrom' };
    maxAtomCount: number;
    durationPs: number;
    frameCount: number;
    indexingModel: 'dense-prefix';
    title?: string | null;
    description?: string | null;
  };
  atoms: AtomInfoV1[];
  denseFrames: NormalizedDenseFrame[];
  elementById: ReadonlyMap<number, string>;
  bondPolicy: BondPolicyV1;
  appearance: NormalizedAppearanceState | null;
  interactionTimeline: NormalizedInteractionTimeline | null;
}

// ── Import from capsule file ──

export function importCapsuleHistory(file: AtomDojoPlaybackCapsuleFileV1): LoadedCapsuleHistory {
  const { simulation, atoms, timeline } = file;
  const errors: string[] = [];

  validateSimulationMeta(simulation, errors);
  validateUnits(simulation, errors);
  const atomById = validateAtomTable(atoms.atoms, errors);
  validateSimulationConstraints(simulation, atoms.atoms, errors);
  validateBondPolicy(file.bondPolicy, errors);
  validateDurationSpan(simulation, timeline.denseFrames, errors);

  validateDenseFrameLoop(timeline.denseFrames, simulation, atomById, errors, true);

  // Validate appearance if present
  const appearance = validateAppearance(file.appearance, atomById, errors);

  // Build frameId→index map locally for interaction validation (not stored on runtime type)
  let interactionTimeline: NormalizedInteractionTimeline | null = null;
  if (timeline.interactionTimeline && errors.length === 0) {
    const frameIdToIndex = new Map<number, number>();
    for (let i = 0; i < timeline.denseFrames.length; i++) {
      frameIdToIndex.set(timeline.denseFrames[i].frameId, i);
    }
    interactionTimeline = validateInteractionTimeline(
      timeline.interactionTimeline, frameIdToIndex, atomById, errors,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Capsule history import failed: ${errors[0]}`);
  }

  const denseFrames: NormalizedDenseFrame[] = timeline.denseFrames.map(f => ({
    frameId: f.frameId,
    timePs: f.timePs,
    n: f.n,
    atomIds: f.atomIds,
    positions: new Float64Array(f.positions),
    interaction: null,
    boundary: {},
  }));

  return {
    kind: 'capsule',
    simulation,
    atoms: atoms.atoms,
    denseFrames,
    elementById: atomById,
    bondPolicy: file.bondPolicy,
    appearance,
    interactionTimeline,
  };
}

// ── Import from legacy reduced file ──

export function importReducedAsCapsule(file: AtomDojoReducedFileV1): LoadedCapsuleHistory {
  const { simulation, atoms, timeline } = file;
  const errors: string[] = [];

  validateSimulationMeta(simulation, errors);
  validateUnits(simulation, errors);
  const atomById = validateAtomTable(atoms.atoms, errors);
  validateSimulationConstraints(simulation, atoms.atoms, errors);

  if (file.bondPolicy != null) {
    validateBondPolicy(file.bondPolicy, errors);
  }

  validateDurationSpan(simulation, timeline.denseFrames, errors);

  validateDenseFrameLoop(timeline.denseFrames, simulation, atomById, errors, false);

  if (errors.length > 0) {
    throw new Error(`Reduced history import failed: ${errors[0]}`);
  }

  // Legacy reduced: preserve frame-local interaction/boundary payloads
  const denseFrames: NormalizedDenseFrame[] = timeline.denseFrames.map(f => ({
    frameId: f.frameId,
    timePs: f.timePs,
    n: f.n,
    atomIds: f.atomIds,
    positions: new Float64Array(f.positions),
    interaction: f.interaction ?? null,
    boundary: f.boundary ?? {},
  }));

  const resolvedBondPolicy: BondPolicyV1 = file.bondPolicy ?? buildExportBondPolicy();

  return {
    kind: 'capsule',
    simulation: {
      units: simulation.units,
      maxAtomCount: simulation.maxAtomCount,
      durationPs: simulation.durationPs,
      frameCount: simulation.frameCount,
      indexingModel: simulation.indexingModel,
      ...(simulation.title != null ? { title: simulation.title } : {}),
      ...(simulation.description != null ? { description: simulation.description } : {}),
    },
    atoms: atoms.atoms,
    denseFrames,
    elementById: atomById,
    bondPolicy: resolvedBondPolicy,
    appearance: null,
    interactionTimeline: null,
  };
}

// ── Shared validation helpers ──

function validateUnits(
  simulation: { units?: unknown },
  errors: string[],
): void {
  const u = simulation.units;
  if (!u || typeof u !== 'object') {
    errors.push('simulation.units must be an object'); return;
  }
  const units = u as Record<string, unknown>;
  if (units.time !== 'ps') {
    errors.push(`simulation.units.time must be 'ps', got '${String(units.time)}'`);
  }
  if (units.length !== 'angstrom') {
    errors.push(`simulation.units.length must be 'angstrom', got '${String(units.length)}'`);
  }
}

function validateDenseFrameLoop(
  frames: readonly { frameId: number; timePs: number; n: number; atomIds: number[]; positions: number[] }[],
  simulation: { maxAtomCount: number; frameCount: number },
  atomById: Map<number, string>,
  errors: string[],
  requireMonotonicFrameId: boolean,
): void {
  if (simulation.frameCount !== frames.length) {
    errors.push(`frameCount ${simulation.frameCount} !== denseFrames.length ${frames.length}`);
  }
  let prevTimePs = -Infinity;
  let prevFrameId = -Infinity;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (typeof f.frameId !== 'number' || !Number.isFinite(f.frameId)) {
      errors.push(`frame ${i}: frameId must be a finite number`); break;
    }
    if (typeof f.timePs !== 'number' || !Number.isFinite(f.timePs)) {
      errors.push(`frame ${i}: timePs must be a finite number`); break;
    }
    if (typeof f.n !== 'number' || !Number.isFinite(f.n) || f.n < 0) {
      errors.push(`frame ${i}: n must be a non-negative finite number`); break;
    }
    if (f.timePs <= prevTimePs) {
      errors.push(`non-monotonic timePs at frame ${i}: ${f.timePs} <= ${prevTimePs}`); break;
    }
    if (requireMonotonicFrameId && f.frameId <= prevFrameId) {
      errors.push(`non-monotonic frameId at frame ${i}: ${f.frameId} <= ${prevFrameId}`); break;
    }
    prevTimePs = f.timePs;
    prevFrameId = f.frameId;
    if (f.positions.length !== f.n * 3) {
      errors.push(`frame ${i}: positions.length ${f.positions.length} !== n*3 ${f.n * 3}`); break;
    }
    if (!validatePositionComponents(f.positions, i, errors)) break;
    if (f.atomIds.length !== f.n) {
      errors.push(`frame ${i}: atomIds.length ${f.atomIds.length} !== n ${f.n}`); break;
    }
    if (f.n > simulation.maxAtomCount) {
      errors.push(`frame ${i}: n ${f.n} > maxAtomCount ${simulation.maxAtomCount}`); break;
    }
    if (!validateFrameAtomIds(f.atomIds, f.n, atomById, i, errors)) break;
    if (errors.length > 0) break;
  }
}

function validateSimulationMeta(
  simulation: { maxAtomCount: unknown; frameCount: unknown; durationPs: unknown },
  errors: string[],
): void {
  if (typeof simulation.maxAtomCount !== 'number' || !Number.isFinite(simulation.maxAtomCount) || simulation.maxAtomCount < 0) {
    errors.push('simulation.maxAtomCount must be a non-negative finite number');
  }
  if (typeof simulation.frameCount !== 'number' || !Number.isFinite(simulation.frameCount) || simulation.frameCount < 0) {
    errors.push('simulation.frameCount must be a non-negative finite number');
  }
  if (typeof simulation.durationPs !== 'number' || !Number.isFinite(simulation.durationPs) || simulation.durationPs < 0) {
    errors.push('simulation.durationPs must be a non-negative finite number');
  }
}

function validateAtomTable(atoms: AtomInfoV1[], errors: string[]): Map<number, string> {
  const atomById = new Map<number, string>();
  if (!atoms || atoms.length === 0) {
    errors.push('atoms.atoms is empty — reconstruction needs element identity');
    return atomById;
  }
  const seenIds = new Set<number>();
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (typeof a.id !== 'number' || !Number.isFinite(a.id)) {
      errors.push(`atom table entry ${i}: id must be a finite number`); break;
    }
    if (typeof a.element !== 'string' || a.element.length === 0) {
      errors.push(`atom table entry ${i}: element must be a non-empty string`); break;
    }
    if (seenIds.has(a.id)) {
      errors.push(`atom table: duplicate atom ID ${a.id}`); break;
    }
    seenIds.add(a.id);
    atomById.set(a.id, a.element);
  }
  return atomById;
}

function validateSimulationConstraints(
  simulation: { maxAtomCount: number; indexingModel: string },
  atoms: AtomInfoV1[],
  errors: string[],
): void {
  if (simulation.maxAtomCount > atoms.length) {
    errors.push(`maxAtomCount ${simulation.maxAtomCount} > atoms.atoms.length ${atoms.length}`);
  }
  if (simulation.indexingModel !== 'dense-prefix') {
    errors.push(`unsupported indexingModel: ${simulation.indexingModel}`);
  }
}

function validateBondPolicy(bp: BondPolicyV1, errors: string[]): void {
  if (!bp.policyId || !isBondPolicyId(bp.policyId)) {
    errors.push(`bondPolicy.policyId must be one of: ${KNOWN_BOND_POLICY_IDS.join(', ')}`);
  }
  if (typeof bp.cutoff !== 'number' || !Number.isFinite(bp.cutoff) || bp.cutoff <= 0) {
    errors.push('bondPolicy.cutoff must be a positive finite number');
  }
  if (typeof bp.minDist !== 'number' || !Number.isFinite(bp.minDist) || bp.minDist < 0) {
    errors.push('bondPolicy.minDist must be a non-negative finite number');
  }
  if (typeof bp.cutoff === 'number' && typeof bp.minDist === 'number' && bp.minDist >= bp.cutoff) {
    errors.push(`bondPolicy.minDist (${bp.minDist}) must be less than bondPolicy.cutoff (${bp.cutoff})`);
  }
}

function validateDurationSpan(
  simulation: { durationPs: number },
  frames: readonly { timePs: number }[],
  errors: string[],
): void {
  if (frames.length === 1) {
    if (simulation.durationPs !== 0) {
      errors.push(`single-frame file must have durationPs 0, got ${simulation.durationPs}`);
    }
  } else if (frames.length >= 2) {
    const expected = frames[frames.length - 1].timePs - frames[0].timePs;
    if (Math.abs(simulation.durationPs - expected) > 1e-10) {
      errors.push(`durationPs ${simulation.durationPs} !== computed ${expected}`);
    }
  }
}

function validatePositionComponents(positions: number[], frameIdx: number, errors: string[]): boolean {
  for (let k = 0; k < positions.length; k++) {
    if (typeof positions[k] !== 'number' || !Number.isFinite(positions[k])) {
      errors.push(`frame ${frameIdx}: positions[${k}] must be a finite number`);
      return false;
    }
  }
  return true;
}

function validateFrameAtomIds(
  atomIds: number[], n: number, atomById: Map<number, string>,
  frameIdx: number, errors: string[],
): boolean {
  const seen = new Set<number>();
  for (let j = 0; j < n; j++) {
    const id = atomIds[j];
    if (!atomById.has(id)) {
      errors.push(`frame ${frameIdx}: atomId ${id} not found in atom table`);
      return false;
    }
    if (seen.has(id)) {
      errors.push(`frame ${frameIdx}: duplicate atomId ${id} within frame`);
      return false;
    }
    seen.add(id);
  }
  return true;
}

function validateAppearance(
  raw: CapsuleAppearanceV1 | undefined,
  atomById: Map<number, string>,
  errors: string[],
): NormalizedAppearanceState | null {
  if (!raw) return null;
  if (!Array.isArray(raw.colorAssignments)) {
    errors.push('appearance.colorAssignments must be an array');
    return null;
  }
  const assignments: NormalizedColorAssignment[] = [];
  for (let i = 0; i < raw.colorAssignments.length; i++) {
    const a = raw.colorAssignments[i];
    if (!Array.isArray(a.atomIds) || a.atomIds.length === 0) {
      errors.push(`appearance.colorAssignments[${i}]: atomIds must be a non-empty array`);
      continue;
    }
    if (typeof a.colorHex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(a.colorHex)) {
      errors.push(`appearance.colorAssignments[${i}]: colorHex must be a 6-digit hex string (e.g. #ff5555)`);
      continue;
    }
    let valid = true;
    for (const id of a.atomIds) {
      if (!atomById.has(id)) {
        errors.push(`appearance.colorAssignments[${i}]: atomId ${id} not found in atom table`);
        valid = false;
        break;
      }
    }
    if (valid) {
      assignments.push({ atomIds: a.atomIds, colorHex: a.colorHex });
    }
  }
  return { colorAssignments: assignments };
}

function validateInteractionTimeline(
  raw: CapsuleInteractionTimelineV1 | undefined,
  frameIdToIndex: Map<number, number>,
  atomById: Map<number, string>,
  errors: string[],
): NormalizedInteractionTimeline | null {
  if (!raw) return null;
  if (raw.encoding !== 'event-stream-v1') {
    errors.push(`interactionTimeline.encoding must be 'event-stream-v1'`);
    return null;
  }
  if (!Array.isArray(raw.events)) {
    errors.push('interactionTimeline.events must be an array');
    return null;
  }
  const events: NormalizedInteractionTimeline['events'] = [];
  let prevFrameId = -Infinity;
  for (let i = 0; i < raw.events.length; i++) {
    const e = raw.events[i];
    if (typeof e.frameId !== 'number' || !Number.isFinite(e.frameId)) {
      errors.push(`interaction event ${i}: frameId must be a finite number`);
      break;
    }
    if (e.frameId <= prevFrameId) {
      errors.push(`interaction event ${i}: non-monotonic frameId ${e.frameId} <= ${prevFrameId}`);
      break;
    }
    if (!frameIdToIndex.has(e.frameId)) {
      errors.push(`interaction event ${i}: frameId ${e.frameId} not found in dense frames`);
      break;
    }
    prevFrameId = e.frameId;
    const VALID_KINDS = ['none', 'atom_drag', 'move_group', 'rotate_group'];
    if (!VALID_KINDS.includes(e.kind)) {
      errors.push(`interaction event ${i}: unsupported kind '${String(e.kind)}'`);
      break;
    }
    if (e.kind !== 'none') {
      if (typeof (e as { atomId?: unknown }).atomId !== 'number') {
        errors.push(`interaction event ${i}: atomId must be a number`);
        break;
      }
      if (!atomById.has((e as { atomId: number }).atomId)) {
        errors.push(`interaction event ${i}: atomId ${(e as { atomId: number }).atomId} not found in atom table`);
        break;
      }
      const t = (e as { target?: unknown }).target;
      if (!Array.isArray(t) || t.length !== 3 ||
          typeof t[0] !== 'number' || !Number.isFinite(t[0]) ||
          typeof t[1] !== 'number' || !Number.isFinite(t[1]) ||
          typeof t[2] !== 'number' || !Number.isFinite(t[2])) {
        errors.push(`interaction event ${i}: target must be a 3-number tuple`);
        break;
      }
    }
    events.push(e);
  }
  return { events };
}
