/**
 * Bonded group display source — resolves the current topology source for
 * bonded-group projection (live physics or review historical data).
 *
 * Owns: display-source resolution logic.
 * Does not: own topology data, project groups, or manage store state.
 * Called by: bonded-group-runtime (via dependency injection).
 */

export interface BondedGroupComponent {
  atoms: number[];
  size: number;
}

export interface BondedGroupDisplaySource {
  kind: 'live' | 'review';
  atomCount: number;
  components: BondedGroupComponent[];
}

export interface BondedGroupDisplaySourceDeps {
  getPhysics: () => { n: number; components: { atoms: number[]; size: number }[] | null } | null;
  getTimelineReviewComponents: () => { atomCount: number; components: BondedGroupComponent[] } | null;
  getTimelineMode: () => 'live' | 'review';
}

/**
 * Resolve the current bonded-group topology source.
 * In review mode, uses historical topology if available.
 * In live mode, uses physics connected components.
 * Returns null if no valid source exists.
 */
export function resolveBondedGroupDisplaySource(
  deps: BondedGroupDisplaySourceDeps,
): BondedGroupDisplaySource | null {
  const mode = deps.getTimelineMode();

  if (mode === 'review') {
    // Strict review: never fall back to live physics. If historical topology is
    // unavailable, return null so the panel honestly shows no groups.
    const review = deps.getTimelineReviewComponents();
    if (review && review.components.length > 0) {
      return { kind: 'review', atomCount: review.atomCount, components: review.components };
    }
    return null;
  }

  const physics = deps.getPhysics();
  if (!physics || physics.n === 0 || !physics.components || physics.components.length === 0) {
    return null;
  }

  return {
    kind: 'live',
    atomCount: physics.n,
    components: physics.components,
  };
}
