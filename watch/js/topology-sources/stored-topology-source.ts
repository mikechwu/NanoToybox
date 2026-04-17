/**
 * StoredTopologySource — wraps restart-frame topology from full-history files.
 *
 * Behavior identical to the pre-abstraction inline implementation in
 * watch-playback-model.ts. Receives restartFrames at construction, uses
 * bsearchAtOrBefore to find topology at or before a given time.
 */

import type { NormalizedRestartFrame } from '../full-history-import';
import type { WatchTopologySource } from '../watch-playback-model';
import { bsearchAtOrBefore } from '../frame-search';

export function createStoredTopologySource(
  restartFrames: NormalizedRestartFrame[],
): WatchTopologySource {
  let _frames: NormalizedRestartFrame[] | null = restartFrames;

  return {
    getTopologyAtTime(timePs: number) {
      if (!_frames) return null;
      const frame = bsearchAtOrBefore(_frames, timePs);
      if (!frame) return null;
      return { bonds: frame.bonds, n: frame.n, frameId: frame.frameId };
    },
    /** Cheap frame-id probe — O(log n) binary search, no bond access. */
    getTopologyFrameIdAtTime(timePs: number): number | null {
      if (!_frames) return null;
      const frame = bsearchAtOrBefore(_frames, timePs);
      return frame ? frame.frameId : null;
    },
    reset() {
      _frames = null;
    },
  };
}
