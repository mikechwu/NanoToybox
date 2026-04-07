/**
 * Bonded group UI utilities — pure presentation helpers shared between lab/ and watch/.
 *
 * Owns:        size-based partitioning for two-level group display
 * Depends on:  BondedGroupSummary (from bonded-group-projection.ts)
 * Called by:    lab/js/store/selectors/bonded-groups.ts (re-exports for lab consumers),
 *              watch/js/components/WatchBondedGroupsPanel.tsx
 */

import type { BondedGroupSummary } from './bonded-group-projection';

/** Default small-cluster threshold (atoms). Groups with atomCount <= this are "small". */
export const SMALL_CLUSTER_THRESHOLD = 3;

/** Partition bonded groups into large and small buckets for two-level UI display. */
export function partitionBondedGroups(
  groups: BondedGroupSummary[],
  threshold = SMALL_CLUSTER_THRESHOLD,
): { large: BondedGroupSummary[]; small: BondedGroupSummary[] } {
  const large: BondedGroupSummary[] = [];
  const small: BondedGroupSummary[] = [];
  for (const g of groups) {
    if (g.atomCount > threshold) large.push(g);
    else small.push(g);
  }
  return { large, small };
}
