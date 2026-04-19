/**
 * History export — builds and downloads v1 atomdojo-history files.
 *
 * Owns:        v1 envelope construction, JSON serialization, browser download trigger
 * Depends on:  src/history/history-file-v1 (shared types + validation),
 *              SimulationTimeline (getExportSnapshot), AtomMetadataRegistry (getAtomTable)
 * Called by:   timeline-subsystem (onExportHistory callback)
 * Teardown:    stateless — no teardown needed
 */

import type { TimelineFrame, TimelineRestartFrame, TimelineCheckpoint } from './simulation-timeline';
import type { AtomMetadataEntry } from './atom-metadata-registry';
import type {
  AtomDojoHistoryFileV1,
  AtomDojoPlaybackCapsuleFileV1,
  CapsuleInteractionEventV1,
  FullDenseFrameV1,
  FullRestartFrameV1,
  FullCheckpointV1,
  SimulationMetaV1,
} from '../../../../src/history/history-file-v1';
import type { TimelineInteractionState } from './timeline-context-capture';
import { buildExportBondPolicy } from '../../../../src/topology/bond-policy-resolver';

// Re-export shared types and validation for existing consumers
export { validateFullHistoryFile } from '../../../../src/history/history-file-v1';
export type { AtomDojoHistoryFileV1 } from '../../../../src/history/history-file-v1';

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

// ── Byte formatting ──
//
// Re-exported from `src/format/bytes` so existing Lab callers keep
// their import path while Watch consumes the canonical shared
// implementation directly. Both apps used to reach into this file;
// shared utilities belong in `src/` per docs/contributing.md.
export { formatBytes } from '../../../../src/format/bytes';

// ── Filename generation ──

export function generateExportFileName(prefix: string): string {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `${prefix}-${ts}.atomdojo`;
}

// ── Save strategy (picker + anchor fallback) ──

export async function saveHistoryFile(blob: Blob, defaultFileName: string): Promise<'saved' | 'picker-cancelled'> {
  if (typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function') {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: defaultFileName,
        types: [{ description: 'AtomDojo History', accept: { 'application/json': ['.atomdojo'] } }],
      });
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (writeErr) {
        await writable.abort().catch((abortErr: unknown) => { console.warn('[history-export] writable.abort() failed:', abortErr); });
        throw writeErr;
      }
      return 'saved';
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'picker-cancelled';
      }
      throw err;
    }
  }
  // Fallback: anchor click
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return 'saved';
}

// ── Capsule export ──

export interface CapsuleExportDeps {
  getTimelineExportData: () => TimelineExportData | null;
  getAtomTable: () => AtomMetadataEntry[];
  getColorAssignments: () => { atomIds: number[]; colorHex: string }[];
  appVersion: string;
}

export function buildCapsuleHistoryFile(deps: CapsuleExportDeps): AtomDojoPlaybackCapsuleFileV1 | null {
  const data = deps.getTimelineExportData();
  if (!data || data.denseFrames.length === 0) return null;

  const atomTable = deps.getAtomTable();
  const { denseFrames } = data;

  const firstFrame = denseFrames[0];
  const lastFrame = denseFrames[denseFrames.length - 1];
  let maxAtomCount = 0;
  for (const f of denseFrames) if (f.n > maxAtomCount) maxAtomCount = f.n;

  const capsuleFrames = denseFrames.map(f => ({
    frameId: f.frameId,
    timePs: f.timePs,
    n: f.n,
    atomIds: f.atomIds,
    positions: float64ToArray(f.positions),
  }));

  // Appearance: use stable atomIds captured at authoring time
  const colorAssignments = deps.getColorAssignments();
  const appearance = colorAssignments.length > 0 ? {
    colorAssignments: colorAssignments
      .filter(a => a.atomIds.length > 0)
      .map(a => ({ atomIds: a.atomIds, colorHex: a.colorHex })),
  } : undefined;

  // Interaction: each frame carries its own stable atomIds — use frame-local lookup
  const interactionTimeline = sparsifyInteractionTimeline(denseFrames);

  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: {
      app: 'lab',
      appVersion: deps.appVersion,
      exportedAt: new Date().toISOString(),
    },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount,
      durationPs: lastFrame.timePs - firstFrame.timePs,
      frameCount: denseFrames.length,
      indexingModel: 'dense-prefix',
    },
    atoms: {
      atoms: atomTable.map(e => ({
        id: e.id,
        element: e.element,
        isotope: null,
        charge: null,
        label: null,
      })),
    },
    bondPolicy: buildExportBondPolicy(),
    timeline: {
      denseFrames: capsuleFrames,
      ...(interactionTimeline ? { interactionTimeline } : {}),
    },
    ...(appearance && appearance.colorAssignments.length > 0 ? { appearance } : {}),
  };
}

function sparsifyInteractionTimeline(
  frames: readonly TimelineFrame[],
): { encoding: 'event-stream-v1'; events: CapsuleInteractionEventV1[] } | undefined {
  const events: CapsuleInteractionEventV1[] = [];
  let lastKey = 'none';
  for (const f of frames) {
    const interaction = f.interaction as TimelineInteractionState | null;
    const key = interaction ? canonicalInteractionKey(interaction) : 'none';
    if (key === lastKey) continue;
    lastKey = key;
    if (!interaction || interaction.kind === 'none') {
      events.push({ frameId: f.frameId, kind: 'none' });
    } else {
      if (interaction.atomIndex >= f.atomIds.length) {
        console.warn(`[capsule-export] frame ${f.frameId}: interaction.atomIndex ${interaction.atomIndex} >= atomIds.length ${f.atomIds.length}, downgrading to 'none'`);
        events.push({ frameId: f.frameId, kind: 'none' });
        lastKey = 'none';
        continue;
      }
      const atomId = f.atomIds[interaction.atomIndex];
      const target = interaction.target;
      events.push({ frameId: f.frameId, kind: interaction.kind, atomId, target });
    }
  }
  return events.length > 0 ? { encoding: 'event-stream-v1', events } : undefined;
}

function canonicalInteractionKey(s: TimelineInteractionState): string {
  if (s.kind === 'none') return 'none';
  return `${s.kind}:${s.atomIndex}:${s.target[0]},${s.target[1]},${s.target[2]}`;
}

