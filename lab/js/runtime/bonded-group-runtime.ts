/**
 * Bonded group runtime — thin lab/store adapter over shared projection logic.
 *
 * Display-source-aware: resolves topology from either live physics or
 * review historical data via BondedGroupDisplaySource. Delegates projection
 * to src/history/bonded-group-projection.ts and publishes results to Zustand.
 *
 * @module bonded-group-runtime
 *
 * Owns:        store writes (setBondedGroups), change detection (summariesEqual).
 * Depends on:  bonded-group-projection (shared pure logic),
 *              BondedGroupDisplaySource (topology resolver),
 *              app-store (write via setBondedGroups).
 * Called by:   bonded-group-coordinator (projectNow, reset).
 * Teardown:    reset() — clears projection state; store is set to [].
 */

import { useAppStore } from '../store/app-store';
import type { BondedGroupDisplaySource } from './bonded-group-display-source';
import { createBondedGroupProjection, type BondedGroupSummary } from '../../../src/history/bonded-group-projection';

// Re-export BondedGroupSummary so existing consumers keep working
export type { BondedGroupSummary } from '../../../src/history/bonded-group-projection';

export interface BondedGroupRuntime {
  projectNow(): void;
  reset(): void;
  /** Get atom indices for a group by its stable ID. Returns null if not found. */
  getAtomIndicesForGroup(id: string): number[] | null;
  /** Returns the display source kind used by the last projection ('live' | 'review' | null). */
  getDisplaySourceKind(): 'live' | 'review' | null;
}

function summariesEqual(a: BondedGroupSummary[], b: BondedGroupSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].displayIndex !== b[i].displayIndex
      || a[i].atomCount !== b[i].atomCount || a[i].orderKey !== b[i].orderKey
      || a[i].minAtomIndex !== b[i].minAtomIndex) {
      return false;
    }
  }
  return true;
}

export function createBondedGroupRuntime(deps: {
  getDisplaySource: () => BondedGroupDisplaySource | null;
}): BondedGroupRuntime {
  const projection = createBondedGroupProjection();
  let prevSummaries: BondedGroupSummary[] = [];
  let _lastSourceKind: 'live' | 'review' | null = null;

  function projectNow() {
    const source = deps.getDisplaySource();
    if (!source || source.atomCount === 0 || source.components.length === 0) {
      if (prevSummaries.length > 0) {
        prevSummaries = [];
        _lastSourceKind = null;
        projection.reset();
        useAppStore.getState().setBondedGroups([]);
      }
      return;
    }

    _lastSourceKind = source.kind;
    const summaries = projection.project({ components: source.components });

    if (!summariesEqual(prevSummaries, summaries)) {
      prevSummaries = summaries;
      useAppStore.getState().setBondedGroups(summaries);
    }
  }

  function reset() {
    prevSummaries = [];
    _lastSourceKind = null;
    projection.reset();
    useAppStore.getState().setBondedGroups([]);
  }

  function getAtomIndicesForGroup(id: string): number[] | null {
    return projection.getAtomIndicesForGroup(id);
  }

  function getDisplaySourceKind(): 'live' | 'review' | null { return _lastSourceKind; }

  return { projectNow, reset, getAtomIndicesForGroup, getDisplaySourceKind };
}
