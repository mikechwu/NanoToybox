/**
 * Bonded group coordinator — single entry point for all bonded-group lifecycle.
 *
 * Owns the invariant: group projection + highlight reconciliation always happen together.
 * Also owns the complete teardown path: highlight → callbacks → projection runtime.
 *
 * No other code should call projectNow() or syncAfterTopologyChange() independently.
 *
 * @module bonded-group-coordinator
 *
 * Owns:        Coordinated update sequencing (project then reconcile),
 *              complete teardown ordering (highlight → callbacks → projection).
 * Depends on:  bonded-group-runtime (projectNow, reset),
 *              bonded-group-highlight-runtime (syncAfterTopologyChange, clearHighlight),
 *              app-store (setBondedGroupCallbacks).
 * Called by:   scene-runtime / main lifecycle (update after topology change, teardown on clear).
 * Teardown:    teardown() — clears highlight, nulls store callbacks, resets projection runtime.
 */

import { useAppStore } from '../../store/app-store';
import type { BondedGroupRuntime } from './bonded-group-runtime';
import type { BondedGroupHighlightRuntime } from './bonded-group-highlight-runtime';

export interface BondedGroupCoordinator {
  /** Project groups from physics then reconcile highlight. Call after any topology change. */
  update(): void;
  /** Complete teardown: clear highlight, clear callbacks, reset projection runtime. */
  teardown(): void;
}

export function createBondedGroupCoordinator(deps: {
  getBondedGroupRuntime: () => BondedGroupRuntime | null;
  getBondedGroupHighlightRuntime: () => BondedGroupHighlightRuntime | null;
}): BondedGroupCoordinator {

  function update() {
    deps.getBondedGroupRuntime()?.projectNow();
    deps.getBondedGroupHighlightRuntime()?.syncAfterTopologyChange();
  }

  function teardown() {
    deps.getBondedGroupHighlightRuntime()?.clearHighlight();
    useAppStore.getState().setBondedGroupCallbacks(null);
    deps.getBondedGroupRuntime()?.reset();
  }

  return { update, teardown };
}
