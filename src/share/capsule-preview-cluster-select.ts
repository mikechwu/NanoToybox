/**
 * Preview subject-cluster selection (ADR D138).
 *
 * Selects the largest bonded cluster from a capsule-preview scene as the
 * subject for the poster + thumb pipeline, when a dominance guard accepts
 * it. Otherwise returns the full frame unchanged.
 *
 * "Bonded cluster" here means a connected component of the preview
 * proximity graph (distance-cutoff + min-dist on `bondPolicy`), NOT
 * authoritative molecular connectivity. The capsule file format does not
 * carry dense-frame topology, so close-approach frames can fuse unbonded
 * molecules into a single cluster. The dominance guard cannot unfuse
 * proximity-fused clusters — see ADR D138 for the scope caveat and the
 * `makeCloseApproachCapsule` regression fixture.
 *
 * Pure module — no DOM, no Cloudflare APIs. Safe to import from
 * publish-core, the audit page, and unit tests.
 *
 * Owns:        selectPreviewSubjectCluster, PreviewClusterSelection* types,
 *              MIN_MEANINGFUL_CLUSTER_SIZE, DOMINANCE_BY_RATIO,
 *              DOMINANCE_BY_FRACTION
 * Depends on:  src/history/connected-components.ts,
 *              src/share/capsule-preview-frame.ts (types only)
 * Called by:   src/share/publish-core.ts,
 *              preview-audit/main.tsx,
 *              tests/unit/capsule-preview-cluster-select.test.ts
 */

import type { CapsulePreviewScene3D } from './capsule-preview-frame';
import { computeConnectedComponents } from '../history/connected-components';

export interface PreviewBondPair {
  a: number;
  b: number;
}

export interface PreviewClusterSelectionOptions {
  mode: 'full-frame' | 'largest-bonded-cluster';
  minMeaningfulClusterSize?: number;
  dominanceByRatio?: number;
  dominanceByFraction?: number;
}

export type PreviewClusterFallbackReason =
  | 'none'
  | 'no-bonds'
  | 'no-meaningful'
  | 'dominance-failed'
  | 'mode-full-frame';

export interface PreviewClusterSelectionDiagnostics {
  mode: 'full-frame' | 'largest-bonded-cluster';
  componentCount: number;
  meaningfulComponentCount: number;
  selectedComponentSize: number | null;
  selectedMinAtomId: number | null;
  fullFrameAtomCount: number;
  fullFrameBondCount: number;
  selectedAtomCount: number;
  selectedBondCount: number;
  dominanceByRatio: number | null;
  dominanceByFraction: number | null;
  fellBackToFullFrame: boolean;
  fallbackReason: PreviewClusterFallbackReason;
}

export interface PreviewClusterSelectionResult {
  scene: CapsulePreviewScene3D;
  bondPairs: PreviewBondPair[];
  diagnostics: PreviewClusterSelectionDiagnostics;
}

export const MIN_MEANINGFUL_CLUSTER_SIZE = 2;
export const DOMINANCE_BY_RATIO = 2.0;
export const DOMINANCE_BY_FRACTION = 0.6;

function computeBounds(atoms: ReadonlyArray<{ x: number; y: number; z: number }>): {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
} {
  if (atoms.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0] };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const a of atoms) {
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.z < minZ) minZ = a.z;
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
    if (a.z > maxZ) maxZ = a.z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

function fullFrameResult(
  scene: CapsulePreviewScene3D,
  bondPairs: ReadonlyArray<PreviewBondPair>,
  mode: 'full-frame' | 'largest-bonded-cluster',
  componentCount: number,
  meaningfulComponentCount: number,
  dominanceByRatio: number | null,
  dominanceByFraction: number | null,
  fallbackReason: PreviewClusterFallbackReason,
): PreviewClusterSelectionResult {
  const fellBackToFullFrame = fallbackReason !== 'none';
  return {
    scene,
    bondPairs: bondPairs.slice(),
    diagnostics: {
      mode,
      componentCount,
      meaningfulComponentCount,
      selectedComponentSize: null,
      selectedMinAtomId: null,
      fullFrameAtomCount: scene.atoms.length,
      fullFrameBondCount: bondPairs.length,
      selectedAtomCount: scene.atoms.length,
      selectedBondCount: bondPairs.length,
      dominanceByRatio,
      dominanceByFraction,
      fellBackToFullFrame,
      fallbackReason,
    },
  };
}

/**
 * Filter `scene` + `bondPairs` to the largest dominant bonded cluster.
 *
 * Short-circuits when (a) caller opts out via `mode: 'full-frame'`, or
 * (b) `bondPairs` is empty — no graph computation needed in either case.
 * Otherwise reuses `computeConnectedComponents` from the history graph
 * primitives, applies the dominance guard, and returns a cluster-only
 * scene when the guard accepts it.
 *
 * The filtered scene preserves the original source order of surviving
 * atoms; downstream code assumes bond-pair indices reference the current
 * `scene.atoms` order.
 */
export function selectPreviewSubjectCluster(
  scene: CapsulePreviewScene3D,
  bondPairs: ReadonlyArray<PreviewBondPair>,
  opts?: PreviewClusterSelectionOptions,
): PreviewClusterSelectionResult {
  const mode = opts?.mode ?? 'largest-bonded-cluster';
  const minMeaningful = opts?.minMeaningfulClusterSize ?? MIN_MEANINGFUL_CLUSTER_SIZE;
  const ratioThreshold = opts?.dominanceByRatio ?? DOMINANCE_BY_RATIO;
  const fractionThreshold = opts?.dominanceByFraction ?? DOMINANCE_BY_FRACTION;

  if (mode === 'full-frame') {
    return fullFrameResult(
      scene, bondPairs, mode, 0, 0, null, null, 'mode-full-frame',
    );
  }

  if (bondPairs.length === 0) {
    return fullFrameResult(
      scene, bondPairs, mode, 0, 0, null, null, 'no-bonds',
    );
  }

  const n = scene.atoms.length;
  const bondsTuples: [number, number, number][] = bondPairs.map(
    (p) => [p.a, p.b, 0] as [number, number, number],
  );
  const components = computeConnectedComponents(n, bondsTuples);
  const componentCount = components.length;

  // Sort descending by size for ratio + fraction measurements.
  const sortedBySize = components.slice().sort((a, b) => b.size - a.size);
  const largestSize = sortedBySize[0]?.size ?? 0;
  const secondLargestSize = sortedBySize[1]?.size ?? 0;
  const dominanceByRatio = secondLargestSize > 0
    ? largestSize / secondLargestSize
    : (largestSize > 0 ? Infinity : null);
  const dominanceByFraction = n > 0 ? largestSize / n : null;
  const meaningfulComponentCount = components.filter((c) => c.size >= minMeaningful).length;

  if (largestSize < minMeaningful) {
    return fullFrameResult(
      scene, bondPairs, mode, componentCount, meaningfulComponentCount,
      dominanceByRatio, dominanceByFraction, 'no-meaningful',
    );
  }

  // Dominance guard — both ratio and fraction must pass.
  const ratioPasses = secondLargestSize === 0
    ? true
    : largestSize >= ratioThreshold * secondLargestSize;
  const fractionPasses = dominanceByFraction !== null
    && dominanceByFraction >= fractionThreshold;
  if (!ratioPasses || !fractionPasses) {
    return fullFrameResult(
      scene, bondPairs, mode, componentCount, meaningfulComponentCount,
      dominanceByRatio, dominanceByFraction, 'dominance-failed',
    );
  }

  // Candidates at the top size (tie-break).
  const topCandidates = components.filter((c) => c.size === largestSize);

  // Detect duplicate atomIds — defensive for fixture-authoring errors.
  const atomIdCounts = new Map<number, number>();
  for (const atom of scene.atoms) {
    atomIdCounts.set(atom.atomId, (atomIdCounts.get(atom.atomId) ?? 0) + 1);
  }
  const hasDuplicateAtomIds = Array.from(atomIdCounts.values()).some((c) => c > 1);
  if (hasDuplicateAtomIds) {
    console.warn(
      '[cluster-select] duplicate-atomIds: falling back to minSourceIndex tie-break',
    );
  }

  function minAtomIdOf(comp: { atoms: number[] }): number {
    let m = Infinity;
    for (const i of comp.atoms) {
      const id = scene.atoms[i]?.atomId;
      if (typeof id === 'number' && id < m) m = id;
    }
    return m;
  }
  function minSourceIndexOf(comp: { atoms: number[] }): number {
    let m = Infinity;
    for (const i of comp.atoms) if (i < m) m = i;
    return m;
  }

  let chosen = topCandidates[0];
  if (topCandidates.length > 1) {
    if (hasDuplicateAtomIds) {
      chosen = topCandidates.reduce((best, c) =>
        minSourceIndexOf(c) < minSourceIndexOf(best) ? c : best,
      );
    } else {
      chosen = topCandidates.reduce((best, c) =>
        minAtomIdOf(c) < minAtomIdOf(best) ? c : best,
      );
    }
  }

  const selectedSet = new Set<number>(chosen.atoms);
  // Build oldIndex → newIndex preserving source order.
  const oldToNew = new Map<number, number>();
  const keptAtoms: CapsulePreviewScene3D['atoms'] = [];
  for (let i = 0; i < n; i++) {
    if (selectedSet.has(i)) {
      oldToNew.set(i, keptAtoms.length);
      keptAtoms.push(scene.atoms[i]);
    }
  }

  const keptBonds: PreviewBondPair[] = [];
  for (const pair of bondPairs) {
    const ia = oldToNew.get(pair.a);
    const ib = oldToNew.get(pair.b);
    if (ia == null || ib == null) continue;
    keptBonds.push({ a: ia, b: ib });
  }

  const bounds = computeBounds(keptAtoms);
  const selectedScene: CapsulePreviewScene3D = {
    atoms: keptAtoms,
    frameId: scene.frameId,
    timePs: scene.timePs,
    bounds,
  };

  const selectedMinAtomId = hasDuplicateAtomIds ? null : minAtomIdOf(chosen);

  return {
    scene: selectedScene,
    bondPairs: keptBonds,
    diagnostics: {
      mode,
      componentCount,
      meaningfulComponentCount,
      selectedComponentSize: chosen.size,
      selectedMinAtomId: Number.isFinite(selectedMinAtomId ?? NaN) ? selectedMinAtomId : null,
      fullFrameAtomCount: n,
      fullFrameBondCount: bondPairs.length,
      selectedAtomCount: keptAtoms.length,
      selectedBondCount: keptBonds.length,
      dominanceByRatio,
      dominanceByFraction,
      fellBackToFullFrame: false,
      fallbackReason: 'none',
    },
  };
}
