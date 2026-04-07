/**
 * Watch analysis domain boundary — bonded-group computation, hover state,
 * and highlight resolution.
 *
 * Parity with lab: persistent selection / selected highlight is feature-gated OFF.
 * Only hover preview drives highlight. Follow owns its own target state in the view service.
 *
 * Uses the shared projection logic (no Zustand dependency).
 */

import { computeConnectedComponents } from '../../src/history/connected-components';
import { createBondedGroupProjection, type BondedGroupSummary } from '../../src/history/bonded-group-projection';

export type { BondedGroupSummary };

export interface HighlightResult {
  atomIndices: number[] | null;
  intensity: 'hover';
}

export interface WatchBondedGroups {
  updateForTime(
    timePs: number,
    topology: { bonds: [number, number, number][]; n: number; frameId: number } | null,
  ): BondedGroupSummary[];
  getSummaries(): BondedGroupSummary[];
  getAtomIndicesForGroup(id: string): number[] | null;
  getHoveredGroupId(): string | null;
  setHoveredGroupId(id: string | null): void;
  /** Resolve highlight: hover-only (parity: persistent selection gated OFF). */
  resolveHighlight(): HighlightResult | null;
  reset(): void;
}

export function createWatchBondedGroups(): WatchBondedGroups {
  const projection = createBondedGroupProjection();
  let _summaries: BondedGroupSummary[] = [];
  let _lastFrameId = -1;
  let _hoveredGroupId: string | null = null;

  function isValidGroupId(id: string | null): boolean {
    if (!id) return false;
    return _summaries.some(g => g.id === id);
  }

  function pruneStaleState() {
    if (_hoveredGroupId && !isValidGroupId(_hoveredGroupId)) _hoveredGroupId = null;
  }

  return {
    updateForTime(_timePs, topology) {
      if (!topology || topology.n === 0) {
        if (_summaries.length > 0) {
          projection.reset();
          _summaries = [];
          _lastFrameId = -1;
        }
        _hoveredGroupId = null;
        return _summaries;
      }
      if (topology.frameId === _lastFrameId) return _summaries;
      _lastFrameId = topology.frameId;
      const components = computeConnectedComponents(topology.n, topology.bonds);
      _summaries = projection.project({ components });
      pruneStaleState();
      return _summaries;
    },

    getSummaries: () => _summaries,
    getAtomIndicesForGroup: (id) => projection.getAtomIndicesForGroup(id),

    getHoveredGroupId: () => _hoveredGroupId,
    setHoveredGroupId(id) { _hoveredGroupId = id && isValidGroupId(id) ? id : null; },

    resolveHighlight() {
      if (_hoveredGroupId) {
        const atoms = projection.getAtomIndicesForGroup(_hoveredGroupId);
        if (atoms && atoms.length > 0) return { atomIndices: atoms, intensity: 'hover' };
      }
      return null;
    },

    reset() {
      projection.reset();
      _summaries = [];
      _lastFrameId = -1;
      _hoveredGroupId = null;
    },
  };
}
