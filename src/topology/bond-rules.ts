/**
 * Bond rule contract — shared policy for bond-topology computation.
 *
 * Pure module: no lab/ dependencies, no CONFIG imports.
 * Lab-side callers pass CONFIG.bonds.* values when constructing rules.
 *
 * Owns:        BondRuleSet interface, createBondRules() factory
 * Does NOT own: BondTuple (lives in src/types/interfaces.ts)
 * Depends on:  nothing
 */

/** Bond-distance rules for topology computation. Precomputes squared values
 *  for the hot-path inner loop (avoids per-pair Math.sqrt). */
export interface BondRuleSet {
  minDist: number;
  minDist2: number;

  /** Global cutoff — used when per-atom element data is unavailable. The
   *  accelerated builder reads these scalars directly in the inner loop. */
  globalMaxDist: number;
  globalMaxDist2: number;

  /** Per-element-pair cutoff for future multi-element support. Not called
   *  in the accelerated builder's inner loop when elements is null. */
  maxPairDistance(elementA: string, elementB: string): number;
}

/** Create a BondRuleSet from explicit distance values. Pure — no CONFIG import. */
export function createBondRules(opts: { minDist: number; cutoff: number }): BondRuleSet {
  const { minDist, cutoff } = opts;
  return {
    minDist,
    minDist2: minDist * minDist,
    globalMaxDist: cutoff,
    globalMaxDist2: cutoff * cutoff,
    maxPairDistance: () => cutoff,
  };
}
