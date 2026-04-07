/**
 * Shared v1 history file types, detection, and validation.
 *
 * Single source of truth for the atomdojo-history wire format.
 * Used by lab/ (export builder) and watch/ (import loader).
 *
 * Owns:        v1 envelope types, file detection, file validation
 * Depends on:  nothing (pure types + functions)
 * Called by:   lab/js/runtime/history-export.ts (build + validate before download),
 *              watch/js/history-file-loader.ts (detect + validate on import)
 */

// ── V1 envelope types ──

export interface AtomDojoHistoryFileV1 {
  format: 'atomdojo-history';
  version: 1;
  kind: 'replay' | 'full';
  producer: { app: 'lab'; appVersion: string; exportedAt: string };
  simulation: SimulationMetaV1;
  atoms: { atoms: AtomInfoV1[] };
  timeline: FullTimelineV1;
  view?: ViewStateV1;
}

export interface SimulationMetaV1 {
  title?: string | null;
  description?: string | null;
  units: { time: 'ps'; length: 'angstrom' };
  maxAtomCount: number;
  durationPs: number;
  frameCount: number;
  indexingModel: 'dense-prefix';
}

export interface AtomInfoV1 {
  id: number;
  element: string;
  isotope?: number | null;
  charge?: number | null;
  label?: string | null;
}

export interface FullTimelineV1 {
  denseFrames: FullDenseFrameV1[];
  restartFrames: FullRestartFrameV1[];
  checkpoints: FullCheckpointV1[];
}

export interface FullDenseFrameV1 {
  frameId: number;
  timePs: number;
  n: number;
  atomIds: number[];
  positions: number[];
  interaction: unknown;
  boundary: unknown;
}

export interface FullRestartFrameV1 {
  frameId: number;
  timePs: number;
  n: number;
  atomIds: number[];
  positions: number[];
  velocities: number[];
  bonds: { a: number; b: number; distance: number }[];
  config: PhysicsConfigV1;
  interaction: unknown;
  boundary: unknown;
}

export interface FullCheckpointV1 {
  checkpointId: number;
  timePs: number;
  physics: {
    n: number;
    atomIds: number[];
    positions: number[];
    velocities: number[];
    bonds: { a: number; b: number; distance: number }[];
  };
  config: PhysicsConfigV1;
  interaction: unknown;
  boundary: unknown;
}

export interface PhysicsConfigV1 {
  damping: number;
  kDrag: number;
  kRotate: number;
  dtFs: number;
  dampingRefDurationFs: number;
}

export interface ViewStateV1 {
  camera?: { position: [number, number, number]; direction: [number, number, number]; up: [number, number, number] } | null;
  theme?: 'light' | 'dark' | null;
}

// ── Detection (purely descriptive) ──

export type DetectedHistoryFile =
  | { format: 'atomdojo-history'; version: number; kind: string; file: unknown }
  | { format: 'unknown'; reason: string };

/** Inspect a parsed JSON value and describe what kind of history file it is. */
export function detectHistoryFile(json: unknown): DetectedHistoryFile {
  if (!json || typeof json !== 'object') {
    return { format: 'unknown', reason: 'Not a JSON object' };
  }
  const obj = json as Record<string, unknown>;
  if (obj.format !== 'atomdojo-history') {
    return { format: 'unknown', reason: `Unrecognized format: ${String(obj.format ?? 'missing')}` };
  }
  const version = typeof obj.version === 'number' ? obj.version : -1;
  const kind = typeof obj.kind === 'string' ? obj.kind : 'unknown';
  return { format: 'atomdojo-history', version, kind, file: json };
}

// ── Validation ──

export function validateFullHistoryFile(file: unknown): string[] {
  const errors: string[] = [];

  // Structural guard — reject malformed envelopes before semantic validation
  if (!file || typeof file !== 'object') return ['file is not an object'];
  const f = file as Record<string, unknown>;
  if (!f.simulation || typeof f.simulation !== 'object') errors.push('missing or invalid simulation');
  if (!f.atoms || typeof f.atoms !== 'object' || !Array.isArray((f.atoms as any).atoms)) errors.push('missing or invalid atoms');
  if (!f.timeline || typeof f.timeline !== 'object') errors.push('missing or invalid timeline');
  if (errors.length > 0) return errors;
  const tl = f.timeline as Record<string, unknown>;
  if (!Array.isArray(tl.denseFrames)) errors.push('missing or invalid timeline.denseFrames');
  if (!Array.isArray(tl.restartFrames)) errors.push('missing or invalid timeline.restartFrames');
  if (!Array.isArray(tl.checkpoints)) errors.push('missing or invalid timeline.checkpoints');
  if (errors.length > 0) return errors;

  // Safe to destructure top-level sections now
  const typed = file as AtomDojoHistoryFileV1;
  const { simulation, atoms, timeline } = typed;

  // Guard simulation numeric fields
  const sim = simulation as any;
  if (typeof sim.maxAtomCount !== 'number' || !Number.isFinite(sim.maxAtomCount)) errors.push('simulation.maxAtomCount must be a finite number');
  if (typeof sim.frameCount !== 'number' || !Number.isFinite(sim.frameCount)) errors.push('simulation.frameCount must be a finite number');
  if (typeof sim.durationPs !== 'number' || !Number.isFinite(sim.durationPs)) errors.push('simulation.durationPs must be a finite number');
  if (errors.length > 0) return errors;

  // Guard atom table entries
  for (let i = 0; i < atoms.atoms.length; i++) {
    const a = atoms.atoms[i] as any;
    if (!a || typeof a !== 'object') { errors.push(`atoms.atoms[${i}] is not an object`); continue; }
    if (typeof a.id !== 'number') errors.push(`atoms.atoms[${i}].id must be a number`);
    if (typeof a.element !== 'string') errors.push(`atoms.atoms[${i}].element must be a string`);
  }
  if (errors.length > 0) return errors;

  const atomIdSet = new Set(atoms.atoms.map(a => a.id));

  // Atom table: unique IDs
  if (atomIdSet.size !== atoms.atoms.length) {
    errors.push(`atom table has ${atoms.atoms.length} entries but only ${atomIdSet.size} unique IDs`);
  }

  // maxAtomCount <= atoms.atoms.length
  if (simulation.maxAtomCount > atoms.atoms.length) {
    errors.push(`maxAtomCount ${simulation.maxAtomCount} > atom table length ${atoms.atoms.length}`);
  }

  // frameCount
  if (simulation.frameCount !== timeline.denseFrames.length) {
    errors.push(`frameCount ${simulation.frameCount} !== denseFrames.length ${timeline.denseFrames.length}`);
  }

  // durationPs
  if (timeline.denseFrames.length >= 2) {
    const expected = timeline.denseFrames[timeline.denseFrames.length - 1].timePs - timeline.denseFrames[0].timePs;
    if (Math.abs(simulation.durationPs - expected) > 1e-10) {
      errors.push(`durationPs ${simulation.durationPs} !== computed ${expected}`);
    }
  }

  // Validate dense frames (two-phase: shape guard → semantic checks, with safe prev tracking)
  let prevDense: { frameId: number; timePs: number } | null = null;
  for (let i = 0; i < timeline.denseFrames.length; i++) {
    const f = timeline.denseFrames[i] as any;
    if (!f || typeof f !== 'object') { errors.push(`denseFrame[${i}] is not an object`); continue; }
    if (typeof f.frameId !== 'number' || typeof f.timePs !== 'number' || typeof f.n !== 'number') { errors.push(`denseFrame[${i}] missing required numeric fields`); continue; }
    if (!Array.isArray(f.positions)) { errors.push(`denseFrame[${i}] positions must be an array`); continue; }
    if (!Array.isArray(f.atomIds)) { errors.push(`denseFrame[${i}] atomIds must be an array`); continue; }
    if (f.n > simulation.maxAtomCount) errors.push(`denseFrame[${i}] n ${f.n} > maxAtomCount ${simulation.maxAtomCount}`);
    if (f.positions.length !== f.n * 3) errors.push(`denseFrame[${i}] positions.length ${f.positions.length} !== n*3 ${f.n * 3}`);
    if (f.atomIds.length !== f.n) errors.push(`denseFrame[${i}] atomIds.length ${f.atomIds.length} !== n ${f.n}`);
    const denseIdSet = new Set(f.atomIds);
    if (denseIdSet.size !== f.atomIds.length) errors.push(`denseFrame[${i}] has ${f.atomIds.length - denseIdSet.size} duplicate atomIds`);
    for (const id of f.atomIds) {
      if (!atomIdSet.has(id)) errors.push(`denseFrame[${i}] atomId ${id} not in atom table`);
    }
    if (prevDense) {
      if (f.frameId <= prevDense.frameId) errors.push(`denseFrame[${i}] frameId ${f.frameId} not monotonically increasing`);
      if (f.timePs < prevDense.timePs) errors.push(`denseFrame[${i}] timePs ${f.timePs} < previous ${prevDense.timePs}`);
    }
    prevDense = { frameId: f.frameId, timePs: f.timePs };
  }

  // Validate restart frames
  let prevRestart: { frameId: number; timePs: number } | null = null;
  for (let i = 0; i < timeline.restartFrames.length; i++) {
    const f = timeline.restartFrames[i] as any;
    if (!f || typeof f !== 'object') { errors.push(`restartFrame[${i}] is not an object`); continue; }
    if (typeof f.frameId !== 'number' || typeof f.timePs !== 'number' || typeof f.n !== 'number') { errors.push(`restartFrame[${i}] missing required numeric fields`); continue; }
    if (!Array.isArray(f.positions)) { errors.push(`restartFrame[${i}] positions must be an array`); continue; }
    if (!Array.isArray(f.atomIds)) { errors.push(`restartFrame[${i}] atomIds must be an array`); continue; }
    if (!Array.isArray(f.velocities)) { errors.push(`restartFrame[${i}] velocities must be an array`); continue; }
    if (!Array.isArray(f.bonds)) { errors.push(`restartFrame[${i}] bonds must be an array`); continue; }
    if (f.n > simulation.maxAtomCount) errors.push(`restartFrame[${i}] n > maxAtomCount`);
    if (f.positions.length !== f.n * 3) errors.push(`restartFrame[${i}] positions.length !== n*3`);
    if (f.velocities.length !== f.n * 3) errors.push(`restartFrame[${i}] velocities.length !== n*3`);
    if (f.atomIds.length !== f.n) errors.push(`restartFrame[${i}] atomIds.length !== n`);
    const restartIdSet = new Set(f.atomIds);
    if (restartIdSet.size !== f.atomIds.length) errors.push(`restartFrame[${i}] has duplicate atomIds`);
    for (const id of f.atomIds) {
      if (!atomIdSet.has(id)) errors.push(`restartFrame[${i}] atomId ${id} not in atom table`);
    }
    for (let j = 0; j < f.bonds.length; j++) {
      const b = f.bonds[j] as any;
      if (!b || typeof b !== 'object') { errors.push(`restartFrame[${i}] bond[${j}] is not an object`); continue; }
      if (typeof b.a !== 'number' || typeof b.b !== 'number') { errors.push(`restartFrame[${i}] bond[${j}] a and b must be numbers`); continue; }
      if (b.a < 0 || b.b < 0 || b.a >= f.n || b.b >= f.n) errors.push(`restartFrame[${i}] bond[${j}] indices out of range`);
      if (typeof b.distance !== 'number') errors.push(`restartFrame[${i}] bond[${j}] missing or invalid distance`);
    }
    if (prevRestart) {
      if (f.frameId <= prevRestart.frameId) errors.push(`restartFrame[${i}] frameId not monotonically increasing`);
      if (f.timePs < prevRestart.timePs) errors.push(`restartFrame[${i}] timePs not monotonically increasing`);
    }
    prevRestart = { frameId: f.frameId, timePs: f.timePs };
  }

  // Validate checkpoints
  let prevCp: { checkpointId: number; timePs: number } | null = null;
  for (let i = 0; i < timeline.checkpoints.length; i++) {
    const cp = timeline.checkpoints[i] as any;
    if (!cp || typeof cp !== 'object') { errors.push(`checkpoint[${i}] is not an object`); continue; }
    if (typeof cp.checkpointId !== 'number' || typeof cp.timePs !== 'number') { errors.push(`checkpoint[${i}] missing required numeric fields`); continue; }
    if (!cp.physics || typeof cp.physics !== 'object') { errors.push(`checkpoint[${i}] missing physics`); continue; }
    if (typeof cp.physics.n !== 'number') { errors.push(`checkpoint[${i}] physics.n must be a number`); continue; }
    if (!Array.isArray(cp.physics.positions)) { errors.push(`checkpoint[${i}] physics.positions must be an array`); continue; }
    if (!Array.isArray(cp.physics.velocities)) { errors.push(`checkpoint[${i}] physics.velocities must be an array`); continue; }
    if (!Array.isArray(cp.physics.atomIds)) { errors.push(`checkpoint[${i}] physics.atomIds must be an array`); continue; }
    if (!Array.isArray(cp.physics.bonds)) { errors.push(`checkpoint[${i}] physics.bonds must be an array`); continue; }
    const n = cp.physics.n;
    if (n > simulation.maxAtomCount) errors.push(`checkpoint[${i}] n > maxAtomCount`);
    if (cp.physics.positions.length !== n * 3) errors.push(`checkpoint[${i}] positions.length !== n*3`);
    if (cp.physics.velocities.length !== n * 3) errors.push(`checkpoint[${i}] velocities.length !== n*3`);
    if (cp.physics.atomIds.length !== n) errors.push(`checkpoint[${i}] atomIds.length !== n`);
    const cpIdSet = new Set(cp.physics.atomIds);
    if (cpIdSet.size !== cp.physics.atomIds.length) errors.push(`checkpoint[${i}] has duplicate atomIds`);
    for (const id of cp.physics.atomIds) {
      if (!atomIdSet.has(id)) errors.push(`checkpoint[${i}] atomId ${id} not in atom table`);
    }
    for (let j = 0; j < cp.physics.bonds.length; j++) {
      const b = cp.physics.bonds[j] as any;
      if (!b || typeof b !== 'object') { errors.push(`checkpoint[${i}] bond[${j}] is not an object`); continue; }
      if (typeof b.a !== 'number' || typeof b.b !== 'number') { errors.push(`checkpoint[${i}] bond[${j}] a and b must be numbers`); continue; }
      if (b.a < 0 || b.b < 0 || b.a >= n || b.b >= n) errors.push(`checkpoint[${i}] bond[${j}] indices out of range`);
      if (typeof b.distance !== 'number') errors.push(`checkpoint[${i}] bond[${j}] missing or invalid distance`);
    }
    if (prevCp) {
      if (cp.checkpointId <= prevCp.checkpointId) errors.push(`checkpoint[${i}] checkpointId not monotonically increasing`);
      if (cp.timePs < prevCp.timePs) errors.push(`checkpoint[${i}] timePs not monotonically increasing`);
    }
    prevCp = { checkpointId: cp.checkpointId, timePs: cp.timePs };
  }

  return errors;
}
