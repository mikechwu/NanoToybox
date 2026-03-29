/**
 * Bonded group selectors — UI-facing presentation helpers.
 *
 * Runtime (bonded-group-runtime.ts) owns topology-to-store projection.
 * This module owns UI bucket partitioning and presentation queries.
 */

import type { BondedGroupSummary } from '../app-store';

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
