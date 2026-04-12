/**
 * Bond-policy types and identifiers — shared contract for reduced-file
 * topology reconstruction.
 *
 * Neutral module: imported by both the file schema (history-file-v1.ts) and
 * the topology resolver (bond-policy-resolver.ts). Neither depends on the other.
 *
 * Owns:        KNOWN_BOND_POLICY_IDS, BondPolicyId, BondPolicyV1
 * Depends on:  nothing
 */

/** Canonical runtime list of known bond-policy identifiers. */
export const KNOWN_BOND_POLICY_IDS = ['default-carbon-v1'] as const;

/** Bond-policy identifier type — derived from the runtime constant. */
export type BondPolicyId = (typeof KNOWN_BOND_POLICY_IDS)[number];

/** Runtime type guard for bond-policy IDs. */
export function isBondPolicyId(value: string): value is BondPolicyId {
  return (KNOWN_BOND_POLICY_IDS as readonly string[]).includes(value);
}

/** Bond-policy metadata for reduced files. */
export interface BondPolicyV1 {
  policyId: BondPolicyId;
  cutoff: number;
  minDist: number;
}
