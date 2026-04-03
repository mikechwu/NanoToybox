/**
 * Bonded group capabilities selector — determines what bonded-group actions
 * are available based on the current app mode (live vs review).
 *
 * Replaces hardcoded timelineMode === 'review' blocks in:
 * - BondedGroupsPanel.tsx (panel visibility via selectCanInspectBondedGroups)
 * - bonded-group-highlight-runtime.ts (select/hover via canInspectBondedGroupsNow)
 *
 * Current phased rollout state:
 * - Review inspection: ENABLED (historical topology + review highlight rendering ready)
 * - Review targeting: ENABLED (panel Center/Follow buttons shipped)
 * - Review color editing: DEFERRED (callbacks wired, panel color UI not yet shipped)
 *
 * Color-edit follows Option B (annotation model) but is gated on panel UI shipping.
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
/**
 * Phased rollout flags — centralized here, not scattered across modules.
 * Each flag should be true only when the full stack (runtime + UI) is shipped.
 * TODO: derive from real readiness seams once rollout stabilizes.
 */
/**
 * Phased rollout flags. Each flag = true only when the full stack is shipped.
 * Flip: update the flag here + add/update the corresponding test in bonded-group-prefeature.test.ts.
 *
 * reviewInspect → requires: simulation-timeline.ts historical topology, renderer review highlight
 * panelTargetUI → requires: BondedGroupsPanel.tsx Center/Follow buttons, main.ts callbacks
 * colorEditUI   → requires: BondedGroupsPanel.tsx color picker UI, main.ts onApplyGroupColor wiring
 */
const ROLLOUT = {
  reviewInspect: true,   // Phase 3: topology + highlight rendering shipped
  panelTargetUI: true,   // Phase 5: Center/Follow buttons + handleBondedGroupFollowToggle shipped
  colorEditUI: false,    // Phase 8: color picker UI not yet built
} as const;

export function selectBondedGroupCapabilities(s: AppStore): BondedGroupCapabilities {
  const _isReview = s.timelineMode === 'review';
  return {
    canInspectBondedGroups: ROLLOUT.reviewInspect,
    canTargetBondedGroups: ROLLOUT.panelTargetUI,
    canEditBondedGroupColor: ROLLOUT.colorEditUI,
    canMutateSimulation: !_isReview,
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

/** Imperative check: reads current store for runtime guards. */
export function canInspectBondedGroupsNow(): boolean {
  return selectCanInspectBondedGroups(useAppStore.getState());
}
