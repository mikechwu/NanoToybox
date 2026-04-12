/**
 * Reduced history importer — normalizes reduced v1 file data into playback-ready model.
 *
 * Reduced files have dense frames + atoms but NO restart frames or checkpoints.
 * Bond topology is reconstructed at playback time by the ReconstructedTopologySource.
 *
 * Semantic validation is the importer's responsibility (structural validation
 * is handled by validateReducedFile in the shared schema).
 *
 * AtomIds in frames are stable IDs (AtomInfoV1.id), NOT dense array indices.
 * The importer builds an ID→element map for reconstruction lookups.
 */

import type { AtomDojoReducedFileV1, AtomInfoV1, SimulationMetaV1 } from '../../src/history/history-file-v1';
import type { BondPolicyV1 } from '../../src/history/bond-policy-v1';
import { isBondPolicyId, KNOWN_BOND_POLICY_IDS } from '../../src/history/bond-policy-v1';
import type { NormalizedDenseFrame } from './full-history-import';

export interface LoadedReducedHistory {
  kind: 'reduced';
  simulation: SimulationMetaV1;
  atoms: AtomInfoV1[];
  denseFrames: NormalizedDenseFrame[];
  /** Stable atomId → element lookup. Built once at import time for
   *  reconstruction. Keyed by AtomInfoV1.id, not array index. */
  elementById: ReadonlyMap<number, string>;
  /** Bond policy from export time. Null = use BOND_DEFAULTS (legacy files). */
  bondPolicy: BondPolicyV1 | null;
}

export function importReducedHistory(file: AtomDojoReducedFileV1): LoadedReducedHistory {
  const { simulation, atoms, timeline } = file;
  const errors: string[] = [];

  // ── Simulation metadata validation ──

  if (typeof simulation.maxAtomCount !== 'number' || !Number.isFinite(simulation.maxAtomCount) || simulation.maxAtomCount < 0) {
    errors.push(`simulation.maxAtomCount must be a non-negative finite number`);
  }
  if (typeof simulation.frameCount !== 'number' || !Number.isFinite(simulation.frameCount) || simulation.frameCount < 0) {
    errors.push(`simulation.frameCount must be a non-negative finite number`);
  }
  if (typeof simulation.durationPs !== 'number' || !Number.isFinite(simulation.durationPs) || simulation.durationPs < 0) {
    errors.push(`simulation.durationPs must be a non-negative finite number`);
  }

  // ── Atom-table validation ──

  if (!atoms.atoms || atoms.atoms.length === 0) {
    errors.push('atoms.atoms is empty — reconstruction needs element identity');
  }

  // Build ID-based lookup with full scalar-type validation
  const atomById = new Map<number, string>();
  const seenIds = new Set<number>();
  for (let i = 0; i < atoms.atoms.length; i++) {
    const a = atoms.atoms[i];
    if (typeof a.id !== 'number' || !Number.isFinite(a.id)) {
      errors.push(`atom table entry ${i}: id must be a finite number`);
      break;
    }
    if (typeof a.element !== 'string' || a.element.length === 0) {
      errors.push(`atom table entry ${i}: element must be a non-empty string`);
      break;
    }
    if (seenIds.has(a.id)) {
      errors.push(`atom table: duplicate atom ID ${a.id}`);
      break;
    }
    seenIds.add(a.id);
    atomById.set(a.id, a.element);
  }

  if (simulation.maxAtomCount > atoms.atoms.length) {
    errors.push(`maxAtomCount ${simulation.maxAtomCount} > atoms.atoms.length ${atoms.atoms.length}`);
  }

  if (simulation.indexingModel !== 'dense-prefix') {
    errors.push(`unsupported indexingModel: ${simulation.indexingModel}`);
  }

  // durationPs must match the dense-frame timeline span (same tolerance as full-file validation)
  if (timeline.denseFrames.length >= 2) {
    const expected = timeline.denseFrames[timeline.denseFrames.length - 1].timePs - timeline.denseFrames[0].timePs;
    if (Math.abs(simulation.durationPs - expected) > 1e-10) {
      errors.push(`durationPs ${simulation.durationPs} !== computed ${expected}`);
    }
  }

  // ── Bond policy validation (optional field — legacy files may omit it) ──

  if (file.bondPolicy != null) {
    const bp = file.bondPolicy;
    if (!bp.policyId || !isBondPolicyId(bp.policyId)) {
      errors.push(`bondPolicy.policyId must be one of: ${KNOWN_BOND_POLICY_IDS.join(', ')}`);
    }
    if (typeof bp.cutoff !== 'number' || !Number.isFinite(bp.cutoff) || bp.cutoff <= 0) {
      errors.push(`bondPolicy.cutoff must be a positive finite number`);
    }
    if (typeof bp.minDist !== 'number' || !Number.isFinite(bp.minDist) || bp.minDist < 0) {
      errors.push(`bondPolicy.minDist must be a non-negative finite number`);
    }
    if (typeof bp.cutoff === 'number' && typeof bp.minDist === 'number' && bp.minDist >= bp.cutoff) {
      errors.push(`bondPolicy.minDist (${bp.minDist}) must be less than bondPolicy.cutoff (${bp.cutoff})`);
    }
  }

  // ── Frame-level validation ──

  if (simulation.frameCount !== timeline.denseFrames.length) {
    errors.push(`frameCount ${simulation.frameCount} !== denseFrames.length ${timeline.denseFrames.length}`);
  }

  let prevTimePs = -Infinity;
  for (let i = 0; i < timeline.denseFrames.length; i++) {
    const f = timeline.denseFrames[i];
    // Scalar-type validation — catches malformed JSON that passed structural gate
    if (typeof f.frameId !== 'number' || !Number.isFinite(f.frameId)) {
      errors.push(`frame ${i}: frameId must be a finite number`);
      break;
    }
    if (typeof f.timePs !== 'number' || !Number.isFinite(f.timePs)) {
      errors.push(`frame ${i}: timePs must be a finite number`);
      break;
    }
    if (typeof f.n !== 'number' || !Number.isFinite(f.n) || f.n < 0) {
      errors.push(`frame ${i}: n must be a non-negative finite number`);
      break;
    }
    if (f.timePs <= prevTimePs) {
      errors.push(`non-monotonic timePs at frame ${i}: ${f.timePs} <= ${prevTimePs}`);
      break;
    }
    prevTimePs = f.timePs;
    if (f.positions.length !== f.n * 3) {
      errors.push(`frame ${i}: positions.length ${f.positions.length} !== n*3 ${f.n * 3}`);
      break;
    }
    // Validate every position component is a finite number
    let posValid = true;
    for (let k = 0; k < f.positions.length; k++) {
      if (typeof f.positions[k] !== 'number' || !Number.isFinite(f.positions[k])) {
        errors.push(`frame ${i}: positions[${k}] must be a finite number`);
        posValid = false;
        break;
      }
    }
    if (!posValid) break;
    if (f.atomIds.length !== f.n) {
      errors.push(`frame ${i}: atomIds.length ${f.atomIds.length} !== n ${f.n}`);
      break;
    }
    if (f.n > simulation.maxAtomCount) {
      errors.push(`frame ${i}: n ${f.n} > maxAtomCount ${simulation.maxAtomCount}`);
      break;
    }
    // Validate atomIds reference valid atom-table entries (by stable ID, not index)
    const frameIdSet = new Set<number>();
    for (let j = 0; j < f.n; j++) {
      const id = f.atomIds[j];
      if (!atomById.has(id)) {
        errors.push(`frame ${i}: atomId ${id} not found in atom table`);
        break;
      }
      if (frameIdSet.has(id)) {
        errors.push(`frame ${i}: duplicate atomId ${id} within frame`);
        break;
      }
      frameIdSet.add(id);
    }
    if (errors.length > 0) break;
  }

  if (errors.length > 0) {
    throw new Error(`Reduced history import failed: ${errors[0]}`);
  }

  // Normalize: optional interaction/boundary default to null/{}
  const denseFrames: NormalizedDenseFrame[] = timeline.denseFrames.map(f => ({
    frameId: f.frameId,
    timePs: f.timePs,
    n: f.n,
    atomIds: f.atomIds,
    positions: new Float64Array(f.positions),
    interaction: f.interaction ?? null,
    boundary: f.boundary ?? {},
  }));

  return {
    kind: 'reduced',
    simulation,
    atoms: atoms.atoms,
    denseFrames,
    elementById: atomById,
    bondPolicy: file.bondPolicy ?? null,
  };
}
