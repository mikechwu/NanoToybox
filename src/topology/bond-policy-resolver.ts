/**
 * Bond-policy resolution — resolves BondPolicyV1 to BondRuleSet.
 *
 * Owns:        resolveBondPolicy, policy resolver registry
 * Depends on:  BondPolicyV1/BondPolicyId from src/history/bond-policy-v1 (neutral),
 *              BondRuleSet/createBondRules from src/topology/bond-rules,
 *              BOND_DEFAULTS from src/config/bond-defaults
 * Used by:     Watch reconstruction, future Lab reduced export
 */

import type { BondPolicyV1, BondPolicyId } from '../history/bond-policy-v1';
import { createBondRules, type BondRuleSet } from './bond-rules';
import { BOND_DEFAULTS } from '../config/bond-defaults';

/** Registry of policy resolvers keyed by policyId. The Record<BondPolicyId, ...>
 *  type enforces exhaustiveness: adding a new ID to KNOWN_BOND_POLICY_IDS without
 *  a resolver entry (or vice versa) is a compile-time error. */
const BOND_POLICY_RESOLVERS: Record<BondPolicyId, (p: BondPolicyV1) => BondRuleSet> = {
  'default-carbon-v1': (p) => createBondRules({ minDist: p.minDist, cutoff: p.cutoff }),
};

/** Resolve a file-declared bond policy (or null for legacy) to a BondRuleSet.
 *  Uses the policy registry. Throws on unknown policyId. */
export function resolveBondPolicy(policy: BondPolicyV1 | null): BondRuleSet {
  if (!policy) {
    return createBondRules({ minDist: BOND_DEFAULTS.minDist, cutoff: BOND_DEFAULTS.cutoff });
  }
  const resolver = BOND_POLICY_RESOLVERS[policy.policyId];
  if (!resolver) {
    throw new Error(`Unknown bond policy ID: ${policy.policyId}`);
  }
  return resolver(policy);
}
