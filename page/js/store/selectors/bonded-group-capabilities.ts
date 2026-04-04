/**
 * Bonded group capabilities selector — determines what bonded-group actions
 * are available based on the current app mode (live vs review).
 *
 * All bonded-group features (inspection, targeting, color editing) are shipped.
 * Only canMutateSimulation is mode-gated (disabled in review).
 * Color editing uses the annotation model (Option B): global overrides,
 * not part of timeline history.
 */

import type { AppStore } from '../app-store';
import { useAppStore } from '../app-store';

export interface BondedGroupCapabilities {
  /** Can the user see and browse the bonded-group panel? */
  canInspectBondedGroups: boolean;
  /** Can the user set a bonded group as camera target (Center/Follow)? */
  canTargetBondedGroups: boolean;
  /** Can the user edit bonded-group colors? Requires inspection capability. */
  canEditBondedGroupColor: boolean;
  /** Can the user mutate the live simulation (add/remove/drag atoms)? */
  canMutateSimulation: boolean;
}

/** Full capability object. Prefer primitive selectors in React components. */
export function selectBondedGroupCapabilities(s: AppStore): BondedGroupCapabilities {
  const isReview = s.timelineMode === 'review';
  // All bonded-group features shipped (Phases 1-10 complete).
  // Only canMutateSimulation is mode-gated.
  return {
    canInspectBondedGroups: true,
    canTargetBondedGroups: true,
    canEditBondedGroupColor: true,
    canMutateSimulation: !isReview,
  };
}

/** Primitive selector: true when bonded groups can be inspected. React-stable (boolean).
 *  Derives from the full capability object for single-source policy. */
export function selectCanInspectBondedGroups(s: AppStore): boolean {
  return selectBondedGroupCapabilities(s).canInspectBondedGroups;
}

/** Primitive selector: true when bonded groups can be camera-targeted. React-stable (boolean). */
export function selectCanTargetBondedGroups(s: AppStore): boolean {
  return selectBondedGroupCapabilities(s).canTargetBondedGroups;
}

/** Primitive selector: true when bonded-group color editing is available. */
export function selectCanEditBondedGroupColor(s: AppStore): boolean {
  return selectBondedGroupCapabilities(s).canEditBondedGroupColor;
}

/** Imperative check: reads current store for runtime guards. */
export function canInspectBondedGroupsNow(): boolean {
  return selectCanInspectBondedGroups(useAppStore.getState());
}
