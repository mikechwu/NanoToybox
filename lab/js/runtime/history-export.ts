/**
 * History export — builds and downloads v1 atomdojo-history files.
 *
 * Owns:        v1 envelope construction, JSON serialization, browser download trigger
 * Depends on:  SimulationTimeline (getExportSnapshot), AtomMetadataRegistry (getAtomTable)
 * Called by:   timeline-subsystem (onExportHistory callback)
 * Teardown:    stateless — no teardown needed
 */

import type { TimelineFrame, TimelineRestartFrame, TimelineCheckpoint } from './simulation-timeline';
import type { AtomMetadataEntry } from './atom-metadata-registry';

// ── V1 file format types (match April 5 spec) ──

interface AtomDojoHistoryFileV1 {
  format: 'atomdojo-history';
  version: 1;
  kind: 'replay' | 'full';
  producer: { app: 'lab'; appVersion: string; exportedAt: string };
  simulation: SimulationMetaV1;
  atoms: { atoms: AtomInfoV1[] };
  timeline: FullTimelineV1;
  view?: ViewStateV1;
}

interface SimulationMetaV1 {
  title?: string | null;
  description?: string | null;
  units: { time: 'ps'; length: 'angstrom' };
  maxAtomCount: number;
  durationPs: number;
  frameCount: number;
  indexingModel: 'dense-prefix';
}

interface AtomInfoV1 {
  id: number;
  element: string;
  isotope?: number | null;
  charge?: number | null;
  label?: string | null;
}

interface FullTimelineV1 {
  denseFrames: FullDenseFrameV1[];
  restartFrames: FullRestartFrameV1[];
  checkpoints: FullCheckpointV1[];
}

interface FullDenseFrameV1 {
  frameId: number;
  timePs: number;
  n: number;
  atomIds: number[];
  positions: number[];
  interaction: unknown;
  boundary: unknown;
}

interface FullRestartFrameV1 {
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

interface FullCheckpointV1 {
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

interface PhysicsConfigV1 {
  damping: number;
  kDrag: number;
  kRotate: number;
  dtFs: number;
  dampingRefDurationFs: number;
}

interface ViewStateV1 {
  camera?: { position: [number, number, number]; direction: [number, number, number]; up: [number, number, number] } | null;
  theme?: 'light' | 'dark' | null;
}

// ── Export deps ──

export interface TimelineExportData {
  denseFrames: TimelineFrame[];
  restartFrames: TimelineRestartFrame[];
  checkpoints: TimelineCheckpoint[];
}

export interface HistoryExportDeps {
  getTimelineExportData: () => TimelineExportData | null;
  getAtomTable: () => AtomMetadataEntry[];
  appVersion: string;
}

// ── Conversion helpers ──

function float64ToArray(f: Float64Array): number[] {
  return Array.from(f);
}

function convertBonds(bonds: [number, number, number][]): { a: number; b: number; distance: number }[] {
  return bonds.map(([a, b, d]) => ({ a, b, distance: d }));
}

function stripBoundaryDamping(boundary: Record<string, unknown>): Record<string, unknown> {
  const { damping: _, ...rest } = boundary as Record<string, unknown>;
  return rest;
}

// ── Builder ──

export function buildFullHistoryFile(deps: HistoryExportDeps): AtomDojoHistoryFileV1 | null {
  const data = deps.getTimelineExportData();
  if (!data || data.denseFrames.length === 0) return null;

  const atomTable = deps.getAtomTable();
  const { denseFrames, restartFrames, checkpoints } = data;

  // SimulationMetaV1
  const firstFrame = denseFrames[0];
  const lastFrame = denseFrames[denseFrames.length - 1];
  let maxAtomCount = 0;
  for (const f of denseFrames) if (f.n > maxAtomCount) maxAtomCount = f.n;
  for (const f of restartFrames) if (f.n > maxAtomCount) maxAtomCount = f.n;
  for (const cp of checkpoints) if (cp.physics.n > maxAtomCount) maxAtomCount = cp.physics.n;

  const simulation: SimulationMetaV1 = {
    title: null,
    description: 'Full history export from atomdojo lab',
    units: { time: 'ps', length: 'angstrom' },
    maxAtomCount,
    durationPs: lastFrame.timePs - firstFrame.timePs,
    frameCount: denseFrames.length,
    indexingModel: 'dense-prefix',
  };

  // Convert frames
  const fullDenseFrames: FullDenseFrameV1[] = denseFrames.map(f => ({
    frameId: f.frameId,
    timePs: f.timePs,
    n: f.n,
    atomIds: f.atomIds,
    positions: float64ToArray(f.positions),
    interaction: f.interaction,
    boundary: stripBoundaryDamping(f.boundary as unknown as Record<string, unknown>),
  }));

  const fullRestartFrames: FullRestartFrameV1[] = restartFrames.map(f => ({
    frameId: f.frameId,
    timePs: f.timePs,
    n: f.n,
    atomIds: f.atomIds,
    positions: float64ToArray(f.positions),
    velocities: float64ToArray(f.velocities),
    bonds: convertBonds(f.bonds),
    config: f.config,
    interaction: f.interaction,
    boundary: stripBoundaryDamping(f.boundary as unknown as Record<string, unknown>),
  }));

  const fullCheckpoints: FullCheckpointV1[] = checkpoints.map(cp => ({
    checkpointId: cp.checkpointId,
    timePs: cp.timePs,
    physics: {
      n: cp.physics.n,
      atomIds: cp.atomIds,
      positions: float64ToArray(cp.physics.pos),
      velocities: float64ToArray(cp.physics.vel),
      bonds: convertBonds(cp.physics.bonds as [number, number, number][]),
    },
    config: cp.config,
    interaction: cp.interaction,
    boundary: stripBoundaryDamping(cp.boundary as unknown as Record<string, unknown>),
  }));

  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'full',
    producer: {
      app: 'lab',
      appVersion: deps.appVersion,
      exportedAt: new Date().toISOString(),
    },
    simulation,
    atoms: {
      atoms: atomTable.map(e => ({
        id: e.id,
        element: e.element,
        isotope: null,
        charge: null,
        label: null,
      })),
    },
    timeline: {
      denseFrames: fullDenseFrames,
      restartFrames: fullRestartFrames,
      checkpoints: fullCheckpoints,
    },
  };
}

// ── Validation ──

export function validateFullHistoryFile(file: AtomDojoHistoryFileV1): string[] {
  const errors: string[] = [];
  const { simulation, atoms, timeline } = file;
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

  // Validate dense frames
  for (let i = 0; i < timeline.denseFrames.length; i++) {
    const f = timeline.denseFrames[i];
    if (f.n > simulation.maxAtomCount) errors.push(`denseFrame[${i}] n ${f.n} > maxAtomCount ${simulation.maxAtomCount}`);
    if (f.positions.length !== f.n * 3) errors.push(`denseFrame[${i}] positions.length ${f.positions.length} !== n*3 ${f.n * 3}`);
    if (f.atomIds.length !== f.n) errors.push(`denseFrame[${i}] atomIds.length ${f.atomIds.length} !== n ${f.n}`);
    const denseIdSet = new Set(f.atomIds);
    if (denseIdSet.size !== f.atomIds.length) errors.push(`denseFrame[${i}] has ${f.atomIds.length - denseIdSet.size} duplicate atomIds`);
    for (const id of f.atomIds) {
      if (!atomIdSet.has(id)) errors.push(`denseFrame[${i}] atomId ${id} not in atom table`);
    }
    if (i > 0) {
      if (f.frameId <= timeline.denseFrames[i - 1].frameId) errors.push(`denseFrame[${i}] frameId ${f.frameId} not monotonically increasing`);
      if (f.timePs < timeline.denseFrames[i - 1].timePs) errors.push(`denseFrame[${i}] timePs ${f.timePs} < previous ${timeline.denseFrames[i - 1].timePs}`);
    }
  }

  // Validate restart frames
  for (let i = 0; i < timeline.restartFrames.length; i++) {
    const f = timeline.restartFrames[i];
    if (f.n > simulation.maxAtomCount) errors.push(`restartFrame[${i}] n > maxAtomCount`);
    if (f.positions.length !== f.n * 3) errors.push(`restartFrame[${i}] positions.length !== n*3`);
    if (f.velocities.length !== f.n * 3) errors.push(`restartFrame[${i}] velocities.length !== n*3`);
    if (f.atomIds.length !== f.n) errors.push(`restartFrame[${i}] atomIds.length !== n`);
    const restartIdSet = new Set(f.atomIds);
    if (restartIdSet.size !== f.atomIds.length) errors.push(`restartFrame[${i}] has duplicate atomIds`);
    for (const id of f.atomIds) {
      if (!atomIdSet.has(id)) errors.push(`restartFrame[${i}] atomId ${id} not in atom table`);
    }
    for (const b of f.bonds) {
      if (b.distance === undefined) errors.push(`restartFrame[${i}] bond missing distance`);
    }
    if (i > 0) {
      if (f.frameId <= timeline.restartFrames[i - 1].frameId) errors.push(`restartFrame[${i}] frameId not monotonically increasing`);
      if (f.timePs < timeline.restartFrames[i - 1].timePs) errors.push(`restartFrame[${i}] timePs not monotonically increasing`);
    }
  }

  // Validate checkpoints
  for (let i = 0; i < timeline.checkpoints.length; i++) {
    const cp = timeline.checkpoints[i];
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
    for (const b of cp.physics.bonds) {
      if (b.distance === undefined) errors.push(`checkpoint[${i}] bond missing distance`);
    }
    if (i > 0) {
      if (cp.checkpointId <= timeline.checkpoints[i - 1].checkpointId) errors.push(`checkpoint[${i}] checkpointId not monotonically increasing`);
      if (cp.timePs < timeline.checkpoints[i - 1].timePs) errors.push(`checkpoint[${i}] timePs not monotonically increasing`);
    }
  }

  return errors;
}

// ── Download ──

export function downloadHistoryFile(file: AtomDojoHistoryFileV1, filename?: string): void {
  const json = JSON.stringify(file);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const name = filename ?? `atomdojo-full-${ts}.atomdojo`;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
