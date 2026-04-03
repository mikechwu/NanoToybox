/**
 * Bonded group capabilities selector — determines what bonded-group actions
 * are available based on the current app mode (live vs review).
 *
 * Replaces hardcoded timelineMode === 'review' blocks in:
 * - BondedGroupsPanel.tsx (panel visibility via selectCanInspectBondedGroups)
 * - bonded-group-highlight-runtime.ts (select/hover via canInspectBondedGroupsNow)
 *
 * Review-mode bonded-group capabilities are disabled until:
 * 1. Historical topology source exists (getTimelineReviewComponents)
 * 2. Review renderer stops suppressing highlight meshes
 * Once both are ready, flip canInspectBondedGroups to true in review.
 *
 * Color-edit follows Option B (annotation model) but is gated on inspection —
 * users cannot edit colors for groups they cannot see/select.
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
  const canInspect = !isReview;
  return {
    canInspectBondedGroups: canInspect,
    canTargetBondedGroups: canInspect,
    canEditBondedGroupColor: canInspect, // gated on inspection — no surface to edit without panel
    canMutateSimulation: !isReview,
  };
}

/** Primitive selector: true when bonded groups can be inspected. React-stable (boolean).
 *  Derives from the full capability object for single-source policy. */
export function selectCanInspectBondedGroups(s: AppStore): boolean {
  return selectBondedGroupCapabilities(s).canInspectBondedGroups;
}

/** Imperative check: reads current store for runtime guards. */
export function canInspectBondedGroupsNow(): boolean {
  return selectCanInspectBondedGroups(useAppStore.getState());
}
