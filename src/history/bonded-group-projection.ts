/**
 * Pure bonded-group projection — overlap reconciliation, stable IDs, display ordering.
 *
 * Extracted from lab/js/runtime/bonded-groups/bonded-group-runtime.ts so both lab/ (Zustand store)
 * and watch/ (local state) can use the same projection logic without store coupling.
 *
 * Owns:        overlap scoring, stable ID assignment, sort ordering, summary construction
 * Depends on:  nothing (pure state machine)
 * Called by:   lab/js/runtime/bonded-groups/bonded-group-runtime.ts (store adapter),
 *              watch/js/analysis/watch-bonded-groups.ts (local adapter)
 */

export interface BondedGroupSummary {
  id: string;
  displayIndex: number;
  atomCount: number;
  minAtomIndex: number;
  orderKey: number;
}

export interface BondedGroupProjectionInput {
  components: { atoms: number[]; size: number }[];
}

export interface BondedGroupProjectionState {
  /** Project current components, reconcile with previous state, return summaries. */
  project(input: BondedGroupProjectionInput): BondedGroupSummary[];
  /** Return atom indices for a group by its stable ID. */
  getAtomIndicesForGroup(id: string): number[] | null;
  /** Reset state (new file / teardown). */
  reset(): void;
}

function overlapScore(atoms: number[], prevSet: Set<number>): number {
  let count = 0;
  for (const a of atoms) {
    if (prevSet.has(a)) count++;
  }
  return count;
}

export function createBondedGroupProjection(): BondedGroupProjectionState {
  let nextGroupId = 1;
  function freshId(): string { return `g${nextGroupId++}`; }

  let prevGroups: { id: string; atoms: Set<number>; orderKey: number }[] = [];
  const groupAtomMap = new Map<string, number[]>();

  function project(input: BondedGroupProjectionInput): BondedGroupSummary[] {
    const { components } = input;

    // Build raw fingerprints
    const raw = components.map((comp) => ({
      atoms: comp.atoms,
      atomSet: new Set(comp.atoms),
      atomCount: comp.size,
      minAtomIndex: comp.atoms.length > 0 ? comp.atoms.reduce((m, a) => a < m ? a : m, comp.atoms[0]) : 0,
    }));

    // Overlap-based reconciliation
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
          orderKey: Number.MAX_SAFE_INTEGER,
        });
      }
    }

    // Sort: atomCount desc, orderKey asc, minAtomIndex asc
    reconciled.sort((a, b) => {
      if (a.atomCount !== b.atomCount) return b.atomCount - a.atomCount;
      if (a.orderKey !== b.orderKey) return a.orderKey - b.orderKey;
      return a.minAtomIndex - b.minAtomIndex;
    });

    // Build summaries
    const summaries: BondedGroupSummary[] = reconciled.map((g, i) => ({
      id: g.id,
      displayIndex: i + 1,
      atomCount: g.atomCount,
      minAtomIndex: g.minAtomIndex,
      orderKey: i,
    }));

    // Update previous state
    groupAtomMap.clear();
    prevGroups = reconciled.map((g, i) => {
      groupAtomMap.set(g.id, Array.from(g.atoms));
      return { id: g.id, atoms: g.atoms, orderKey: i };
    });

    return summaries;
  }

  function getAtomIndicesForGroup(id: string): number[] | null {
    return groupAtomMap.get(id) ?? null;
  }

  function reset(): void {
    prevGroups = [];
    groupAtomMap.clear();
    nextGroupId = 1;
  }

  return { project, getAtomIndicesForGroup, reset };
}
