/**
 * ReconstructedTopologySource — reconstructs bond topology from dense-frame
 * positions using the shared naive builder.
 *
 * Used for reduced-history files that have no restart frames.
 * Caches the last reconstructed topology object by dense-frame index.
 * Repeated calls for the same frame return the SAME object instance (identity
 * stability contract — the controller calls getTopologyAtTime twice per tick).
 *
 * Element lookup uses the stable-ID → element map from the reduced importer,
 * NOT array-index access. This aligns with Watch's stable-atomId semantics.
 */

import type { NormalizedDenseFrame } from '../full-history-import';
import type { WatchTopologySource } from '../watch-playback-model';
import { bsearchIndexAtOrBefore } from '../frame-search';
import type { BondPolicyV1 } from '../../../src/history/bond-policy-v1';
import { buildBondTopologyFromPositions } from '../../../src/topology/build-bond-topology';
import { resolveBondPolicy } from '../../../src/topology/bond-policy-resolver';

type TopologyResult = { bonds: [number, number, number][]; n: number; frameId: number };

// Future: accelerated reconstruction using the shared spatial-hash builder.
// Blocked on the shared accelerated path supporting per-element rules (elements !== null).
// Until then, the naive builder is used for all reduced files (~500 atom ceiling).

export function createReconstructedTopologySource(
  denseFrames: NormalizedDenseFrame[],
  elementById: ReadonlyMap<number, string>,
  fileBondPolicy?: BondPolicyV1 | null,
): WatchTopologySource {
  let _frames: NormalizedDenseFrame[] | null = denseFrames;
  let _elementById: ReadonlyMap<number, string> | null = elementById;

  let _cachedFrameIndex = -1;
  let _cachedResult: TopologyResult | null = null;

  // Resolve policy through shared code — branches on policyId, falls back to BOND_DEFAULTS for null
  const rules = resolveBondPolicy(fileBondPolicy ?? null);

  return {
    getTopologyAtTime(timePs: number): TopologyResult | null {
      if (!_frames || _frames.length === 0) return null;
      const idx = bsearchIndexAtOrBefore(_frames, timePs);
      if (idx < 0) return null;

      if (idx === _cachedFrameIndex && _cachedResult) return _cachedResult;

      const frame = _frames[idx];

      // Use the lower-level builder that accepts Watch-native data directly
      // — no intermediate { element, x, y, z } object array needed
      const bonds = buildBondTopologyFromPositions(
        frame.n, frame.positions, frame.atomIds, _elementById, rules,
      );

      _cachedFrameIndex = idx;
      _cachedResult = { bonds, n: frame.n, frameId: frame.frameId };
      return _cachedResult;
    },

    /**
     * Cheap frame-id probe. Reads ONLY the dense frame's `frameId` field —
     * never materializes bonds. This is what `canBuildWatchLabSceneSeed`
     * calls on the hot path so a UI availability check does not trigger
     * `buildBondTopologyFromPositions` on a cache miss.
     */
    getTopologyFrameIdAtTime(timePs: number): number | null {
      if (!_frames || _frames.length === 0) return null;
      const idx = bsearchIndexAtOrBefore(_frames, timePs);
      if (idx < 0) return null;
      return _frames[idx].frameId;
    },

    reset() {
      _frames = null;
      _elementById = null;
      _cachedFrameIndex = -1;
      _cachedResult = null;
    },
  };
}
