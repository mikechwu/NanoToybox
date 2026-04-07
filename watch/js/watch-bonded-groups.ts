/**
 * Watch analysis domain boundary — bonded-group computation and tracking.
 *
 * This is the dedicated runtime boundary for watch/ analysis state.
 * The facade (watch-controller.ts) coordinates its lifecycle but does not
 * own its internal state. Future hover/selection/focus state belongs here.
 *
 * Rollback policy (Round 1): no save/restore. The facade restores prior
 * document/playback state, then analysis recomputes from restored time/topology
 * on the next tick or explicit updateForTime call.
 *
 * Uses the shared projection logic (no Zustand dependency).
 * Consumes topology from the playback model's getTopologyAtTime channel.
 */

import { computeConnectedComponents } from '../../src/history/connected-components';
import { createBondedGroupProjection, type BondedGroupSummary } from '../../src/history/bonded-group-projection';

export type { BondedGroupSummary };

export interface WatchBondedGroups {
  /** Update bonded groups for the given time. Returns summaries.
   *  Memoized by topology frameId — skips recomputation when the frame hasn't changed. */
  updateForTime(
    timePs: number,
    topology: { bonds: [number, number, number][]; n: number; frameId: number } | null,
  ): BondedGroupSummary[];
  /** Get current summaries. */
  getSummaries(): BondedGroupSummary[];
  /** Reset state (new file loaded). */
  reset(): void;
}

export function createWatchBondedGroups(): WatchBondedGroups {
  const projection = createBondedGroupProjection();
  let _summaries: BondedGroupSummary[] = [];
  let _lastFrameId = -1;

  return {
    updateForTime(_timePs, topology) {
      if (!topology || topology.n === 0) {
        if (_summaries.length > 0) {
          projection.reset();
          _summaries = [];
          _lastFrameId = -1;
        }
        return _summaries;
      }
      // Skip recomputation if same restart frame
      if (topology.frameId === _lastFrameId) return _summaries;
      _lastFrameId = topology.frameId;
      const components = computeConnectedComponents(topology.n, topology.bonds);
      _summaries = projection.project({ components });
      return _summaries;
    },

    getSummaries: () => _summaries,

    reset() {
      projection.reset();
      _summaries = [];
      _lastFrameId = -1;
    },
  };
}
