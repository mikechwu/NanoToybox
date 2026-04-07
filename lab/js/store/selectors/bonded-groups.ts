/**
 * Bonded group selectors — UI-facing presentation helpers.
 *
 * Re-exports partitioning logic from the shared module so existing
 * lab consumers keep their import paths unchanged.
 */

export { partitionBondedGroups, SMALL_CLUSTER_THRESHOLD } from '../../../../src/history/bonded-group-utils';
