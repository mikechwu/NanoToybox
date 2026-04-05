/**
 * Bonded group runtime — projects connected components into store.
 *
 * Display-source-aware: resolves topology from either live physics or
 * review historical data via BondedGroupDisplaySource. Builds UI summaries
 * with overlap-reconciled stable IDs and publishes to the Zustand store.
 *
 * Update policy: called after scene mutations and at throttled cadence during
 * simulation. Only publishes when the projection actually changes.
 *
 * @module bonded-group-runtime
 *
 * Owns:        BondedGroupSummary[] projection, stable group IDs, freshId counter,
 *              overlap-reconciled ID assignment.
 * Depends on:  BondedGroupDisplaySource (display-source-aware topology),
 *              app-store (BondedGroupSummary[], write via setBondedGroups).
 * Called by:   bonded-group-coordinator (projectNow, reset).
 * Teardown:    reset() — clears previous summaries and ID state; store is set to [].
 */

import { useAppStore, type BondedGroupSummary } from '../store/app-store';
import type { BondedGroupDisplaySource } from './bonded-group-display-source';

export interface BondedGroupRuntime {
  projectNow(): void;
  reset(): void;
  /** Get atom indices for a group by its stable ID. Returns null if not found. */
  getAtomIndicesForGroup(id: string): number[] | null;
  /** Returns the display source kind used by the last projection ('live' | 'review' | null). */
  getDisplaySourceKind(): 'live' | 'review' | null;
}

// freshId counter is instance-scoped (moved inside createBondedGroupRuntime)

/**
 * Compute overlap score between two atom sets.
 * Returns the number of atoms in common.
 */
function overlapScore(a: number[], b: Set<number>): number {
  let count = 0;
  for (const atom of a) {
    if (b.has(atom)) count++;
  }
  return count;
}

/**
 * Check if two summary arrays are equivalent (all fields match).
 * Used to suppress no-op store updates.
 */
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
  // Instance-scoped ID counter — resets with the runtime instance
  let nextGroupId = 1;
  function freshId(): string { return `g${nextGroupId++}`; }

  // Previous projection state for reconciliation
  let prevGroups: { id: string; atoms: Set<number>; orderKey: number }[] = [];
  let prevSummaries: BondedGroupSummary[] = [];

  // Atom membership map — keyed by group ID, updated after each projection
  const groupAtomMap = new Map<string, number[]>();

  /** Track which display source kind was last used for getDisplaySourceKind(). */
  let _lastSourceKind: 'live' | 'review' | null = null;

  function projectNow() {
    const source = deps.getDisplaySource();
    if (!source || source.atomCount === 0 || source.components.length === 0) {
      if (prevSummaries.length > 0) {
        prevGroups = [];
        prevSummaries = [];
        groupAtomMap.clear();
        _lastSourceKind = null;
        useAppStore.getState().setBondedGroups([]);
      }
      return;
    }

    _lastSourceKind = source.kind;
    const components = source.components;

    // Step 1: Build raw fingerprints for each current component
    const raw = components.map((comp) => ({
      atoms: comp.atoms,
      atomSet: new Set(comp.atoms),
      atomCount: comp.size,
      minAtomIndex: comp.atoms.length > 0 ? Math.min(...comp.atoms) : 0,
    }));

    // Step 2: Overlap-based reconciliation against previous groups
    const usedPrevIds = new Set<string>();
    const reconciled: { id: string; atoms: Set<number>; atomCount: number; minAtomIndex: number; orderKey: number }[] = [];

    for (const curr of raw) {
      let bestId: string | null = null;
      let bestScore = 0;
      let bestOrderKey = 0;

      for (const prev of prevGroups) {
        if (usedPrevIds.has(prev.id)) continue;
        const score = overlapScore(curr.atoms, prev.atoms);
        if (score > bestScore) {
          bestScore = score;
          bestId = prev.id;
          bestOrderKey = prev.orderKey;
        }
      }

      // Threshold: at least 1 atom overlap to inherit identity
      if (bestId && bestScore > 0) {
        usedPrevIds.add(bestId);
        reconciled.push({
          id: bestId,
          atoms: curr.atomSet,
          atomCount: curr.atomCount,
          minAtomIndex: curr.minAtomIndex,
          orderKey: bestOrderKey,
        });
      } else {
        reconciled.push({
          id: freshId(),
          atoms: curr.atomSet,
          atomCount: curr.atomCount,
          minAtomIndex: curr.minAtomIndex,
          orderKey: Number.MAX_SAFE_INTEGER, // new groups sort after existing
        });
      }
    }

    // Step 3: Sort — atomCount desc, orderKey asc (stable tie-break), minAtomIndex asc (fallback)
    reconciled.sort((a, b) => {
      if (a.atomCount !== b.atomCount) return b.atomCount - a.atomCount;
      if (a.orderKey !== b.orderKey) return a.orderKey - b.orderKey;
      return a.minAtomIndex - b.minAtomIndex;
    });

    // Assign final orderKeys and 1-based displayIndex from sorted position
    const summaries: BondedGroupSummary[] = reconciled.map((g, i) => ({
      id: g.id,
      displayIndex: i + 1,
      atomCount: g.atomCount,
      minAtomIndex: g.minAtomIndex,
      orderKey: i,
    }));

    // Update previous state and atom membership map for next reconciliation
    groupAtomMap.clear();
    prevGroups = reconciled.map((g, i) => {
      groupAtomMap.set(g.id, Array.from(g.atoms));
      return { id: g.id, atoms: g.atoms, orderKey: i };
    });

    // Step 4: Only publish if changed
    if (!summariesEqual(prevSummaries, summaries)) {
      prevSummaries = summaries;
      useAppStore.getState().setBondedGroups(summaries);
      // Selection invalidation is owned by bonded-group-highlight-runtime.syncAfterTopologyChange()
    }
  }

  /** Reset projection state and clear groups from store.
   *  Does NOT clear selection/highlight — that is owned by bonded-group-highlight-runtime.
   *  Callers must coordinate with updateBondedGroups() or highlight runtime teardown. */
  function reset() {
    prevGroups = [];
    prevSummaries = [];
    _lastSourceKind = null;
    useAppStore.getState().setBondedGroups([]);
    groupAtomMap.clear();
  }

  function getAtomIndicesForGroup(id: string): number[] | null {
    return groupAtomMap.get(id) ?? null;
  }

  function getDisplaySourceKind(): 'live' | 'review' | null { return _lastSourceKind; }

  return { projectNow, reset, getAtomIndicesForGroup, getDisplaySourceKind };
}

