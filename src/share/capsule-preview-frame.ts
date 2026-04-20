/**
 * Frame extraction for the V2 capsule preview pipeline (spec §capsule-preview-frame).
 *
 * Turns a validated {@link AtomDojoPlaybackCapsuleFileV1} into a
 * {@link CapsulePreviewScene3D}: the source frame's positions resolved
 * against the atom table and the color resolver. Pure; server-side safe;
 * no DOM or browser APIs.
 *
 * Source frame policy: `timeline.denseFrames[0]` (spec §3 source-frame).
 */

import type {
  AtomDojoPlaybackCapsuleFileV1,
  AtomInfoV1,
  CapsuleAppearanceV1,
} from '../history/history-file-v1';
import { resolveAtomColors } from './capsule-preview-colors';

export interface CapsulePreviewAtom3D {
  atomId: number;
  element: string;
  x: number;
  y: number;
  z: number;
  colorHex: string;
}

export interface CapsulePreviewScene3D {
  atoms: CapsulePreviewAtom3D[];
  frameId: number;
  timePs: number;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
  };
}

export type PreviewSceneBuildError =
  | { kind: 'no-dense-frames' }
  | { kind: 'invalid-positions'; reason: string };

export class PreviewSceneBuildException extends Error {
  readonly cause: PreviewSceneBuildError;
  constructor(cause: PreviewSceneBuildError) {
    const message = cause.kind === 'no-dense-frames'
      ? 'no-dense-frames'
      : `invalid-positions:${cause.reason}`;
    super(message);
    this.name = 'PreviewSceneBuildException';
    this.cause = cause;
  }
}

/**
 * Extract a previewable 3D scene from a validated capsule file.
 *
 * Throws {@link PreviewSceneBuildException} for unrecoverable conditions
 * (no dense frames, positions length mismatch). The poster route maps the
 * thrown cause into a structured `cause:` log prefix (spec §Observability).
 *
 * Atoms whose `atomId` is not in the atom table are silently skipped —
 * `validateCapsuleFile` performs only structural checks, so a mis-authored
 * dense-frame entry could reference an unknown ID; we prefer a shorter
 * preview to rejecting the publish.
 */
export function buildPreviewSceneFromCapsule(
  capsule: AtomDojoPlaybackCapsuleFileV1,
): CapsulePreviewScene3D {
  const dense = capsule.timeline.denseFrames;
  if (!dense || dense.length === 0) {
    throw new PreviewSceneBuildException({ kind: 'no-dense-frames' });
  }
  const frame = dense[0];
  const n = frame.n;
  if (!Array.isArray(frame.positions) || frame.positions.length !== n * 3) {
    throw new PreviewSceneBuildException({
      kind: 'invalid-positions',
      reason: `positions.length=${frame.positions?.length ?? 'null'} !== n*3=${n * 3}`,
    });
  }
  if (!Array.isArray(frame.atomIds) || frame.atomIds.length !== n) {
    throw new PreviewSceneBuildException({
      kind: 'invalid-positions',
      reason: `atomIds.length=${frame.atomIds?.length ?? 'null'} !== n=${n}`,
    });
  }

  const atomTable = new Map<number, AtomInfoV1>();
  for (const atom of capsule.atoms.atoms) atomTable.set(atom.id, atom);

  const colorMap = resolveAtomColors(
    capsule.atoms.atoms,
    capsule.appearance as CapsuleAppearanceV1 | undefined,
  );

  const out: CapsulePreviewAtom3D[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const atomId = frame.atomIds[i];
    const atom = atomTable.get(atomId);
    if (!atom) continue;
    const x = frame.positions[i * 3];
    const y = frame.positions[i * 3 + 1];
    const z = frame.positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const colorHex = colorMap.get(atomId) ?? '#9aa0a6';
    out.push({ atomId, element: atom.element, x, y, z, colorHex });
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  if (out.length === 0) {
    // Every atom filtered out — treat as "invalid positions" so the caller
    // hits the terminal-fallback branch rather than serving an empty scene.
    throw new PreviewSceneBuildException({
      kind: 'invalid-positions',
      reason: 'no-resolved-atoms',
    });
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  return {
    atoms: out,
    frameId: frame.frameId,
    timePs: frame.timePs,
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center: [cx, cy, cz],
    },
  };
}
