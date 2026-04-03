/**
 * Bonded group follow actions — shared toggle logic for follow on/off.
 *
 * Used by main.ts (onFollowGroup callback) and tests. Single source of
 * truth for the follow toggle contract.
 */

import { useAppStore } from '../store/app-store';

export interface BondedGroupFollowDeps {
  getGroupAtoms: (id: string) => number[] | null;
  centerCurrentTarget: () => void;
}

/**
 * Toggle orbit-follow for a bonded group.
 * - If already following: turns off follow, clears frozen target + stale bonded-group camera target.
 * - Otherwise: freezes the group's current atom indices, enables follow, centers once.
 */
export function handleBondedGroupFollowToggle(
  groupId: string,
  deps: BondedGroupFollowDeps,
): void {
  const store = useAppStore.getState();

  // Toggle off if already following
  if (store.orbitFollowEnabled && store.orbitFollowTargetRef) {
    store.setOrbitFollowEnabled(false);
    store.setOrbitFollowTargetRef(null);
    if (store.cameraTargetRef?.kind === 'bonded-group') {
      store.setCameraTargetRef(null);
    }
    return;
  }

  // Freeze current atom set at click time — no volatile label
  const atoms = deps.getGroupAtoms(groupId);
  if (!atoms || atoms.length === 0) return;
  store.setOrbitFollowTargetRef({ kind: 'atom-set', atomIndices: [...atoms] });
  store.setCameraTargetRef({ kind: 'bonded-group', groupId });
  store.setOrbitFollowEnabled(true);
  deps.centerCurrentTarget();
}
