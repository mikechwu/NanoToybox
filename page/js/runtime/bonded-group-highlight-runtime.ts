/**
 * Bonded group highlight runtime — resolves selected/hovered group to renderer highlight.
 *
 * Priority: selected > hovered > none (single highlight at a time).
 * Hover preview is disabled whenever a persistent selection exists.
 *
 * Owns: highlight resolution, renderer update, topology invalidation.
 * Does NOT own: store state (UI sets selected/hovered via store actions).
 */

import { useAppStore } from '../store/app-store';
import type { BondedGroupRuntime } from './bonded-group-runtime';

export interface HighlightRenderer {
  setHighlightedAtoms(atomIndices: number[] | null, intensity?: 'selected' | 'hover'): void;
}

export interface BondedGroupHighlightRuntime {
  /** Toggle persistent selection for a group. */
  toggleSelectedGroup(id: string): void;
  /** Set hover preview (ignored if selection exists). */
  setHoveredGroup(id: string | null): void;
  /** Clear all highlight state. */
  clearHighlight(): void;
  /** Resolve current highlight and update renderer. Call after store changes. */
  syncToRenderer(): void;
  /** Clear stale selection/hover after topology update. */
  syncAfterTopologyChange(): void;
}

export function createBondedGroupHighlightRuntime(deps: {
  getBondedGroupRuntime: () => BondedGroupRuntime | null;
  getRenderer: () => HighlightRenderer | null;
}): BondedGroupHighlightRuntime {

  function resolveActiveGroupId(): { id: string | null; intensity: 'selected' | 'hover' } {
    const store = useAppStore.getState();
    if (store.selectedBondedGroupId) return { id: store.selectedBondedGroupId, intensity: 'selected' };
    if (store.hoveredBondedGroupId) return { id: store.hoveredBondedGroupId, intensity: 'hover' };
    return { id: null, intensity: 'hover' };
  }

  function syncToRenderer() {
    const renderer = deps.getRenderer();
    if (!renderer) return;

    const { id, intensity } = resolveActiveGroupId();
    if (!id) {
      renderer.setHighlightedAtoms(null);
      return;
    }

    const bgr = deps.getBondedGroupRuntime();
    const atoms = bgr?.getAtomIndicesForGroup(id) ?? null;
    renderer.setHighlightedAtoms(atoms, intensity);
  }

  function toggleSelectedGroup(id: string) {
    const store = useAppStore.getState();
    const newId = store.selectedBondedGroupId === id ? null : id;
    store.setSelectedBondedGroup(newId);
    // Clear hover when selecting (prevent stale hover after deselect)
    if (newId) store.setHoveredBondedGroup(null);
    syncToRenderer();
  }

  function setHoveredGroup(id: string | null) {
    const store = useAppStore.getState();
    // Hover preview disabled when persistent selection exists
    if (store.selectedBondedGroupId) return;
    store.setHoveredBondedGroup(id);
    syncToRenderer();
  }

  function clearHighlight() {
    useAppStore.getState().clearBondedGroupHighlightState();
    syncToRenderer();
  }

  function syncAfterTopologyChange() {
    const store = useAppStore.getState();
    const groups = store.bondedGroups;
    const groupIds = new Set(groups.map(g => g.id));
    let changed = false;

    if (store.selectedBondedGroupId && !groupIds.has(store.selectedBondedGroupId)) {
      store.setSelectedBondedGroup(null);
      changed = true;
    }
    if (store.hoveredBondedGroupId && !groupIds.has(store.hoveredBondedGroupId)) {
      store.setHoveredBondedGroup(null);
      changed = true;
    }

    if (changed) syncToRenderer();
    else {
      // Even if IDs survived, atom membership may have changed — re-resolve
      const { id } = resolveActiveGroupId();
      if (id) syncToRenderer();
    }
  }

  return { toggleSelectedGroup, setHoveredGroup, clearHighlight, syncToRenderer, syncAfterTopologyChange };
}
