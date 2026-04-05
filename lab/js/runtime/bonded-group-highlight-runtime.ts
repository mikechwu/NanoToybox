/**
 * Bonded group highlight runtime — persistent atom tracking + hover preview.
 *
 * Two distinct highlight sources (persistent is currently feature-gated off):
 * 1. Persistent: _trackedAtoms (frozen at click time, gated by canTrackBondedGroupHighlight)
 * 2. Temporary: hoveredBondedGroupId (always live group membership, always active)
 *
 * Priority: tracked atoms > hover preview > none.
 * Hover entry disabled when tracked set exists; hover clearing always allowed.
 * Invalid atom indices (>= physics.n) are filtered before rendering.
 *
 * The persistent tracking path is retained for future re-enablement — all store
 * fields, methods, and priority resolution remain intact.
 *
 * Store owns lightweight UI flags only (hasTrackedBondedHighlight: boolean).
 * Heavy atom arrays stay in this runtime, never in the store.
 *
 * @module bonded-group-highlight-runtime
 *
 * Owns:        _trackedAtoms (persistent highlight atom set),
 *              highlight priority resolution (tracked > hover > none),
 *              renderer setHighlightedAtoms calls.
 * Depends on:  bonded-group-runtime (getAtomIndicesForGroup for ID→atoms lookup),
 *              app-store (hoveredBondedGroupId read, hasTrackedBondedHighlight write),
 *              physics.n (for invalid-index filtering),
 *              HighlightRenderer (setHighlightedAtoms).
 * Called by:   bonded-group-coordinator (syncAfterTopologyChange, clearHighlight),
 *              store callbacks (toggleSelectedGroup, setHoveredGroup via UI).
 * Teardown:    clearHighlight() — nulls _trackedAtoms, clears store flag, clears renderer.
 */

import { useAppStore } from '../store/app-store';
import { canInspectBondedGroupsNow, canTrackBondedGroupHighlightNow } from '../store/selectors/bonded-group-capabilities';
import type { BondedGroupRuntime } from './bonded-group-runtime';

export interface HighlightRenderer {
  setHighlightedAtoms(atomIndices: number[] | null, intensity?: 'selected' | 'hover'): void;
}

export interface BondedGroupHighlightRuntime {
  toggleSelectedGroup(id: string): void;
  setHoveredGroup(id: string | null): void;
  clearHighlight(): void;
  syncToRenderer(): void;
  syncAfterTopologyChange(): void;
}

export function createBondedGroupHighlightRuntime(deps: {
  getBondedGroupRuntime: () => BondedGroupRuntime | null;
  getRenderer: () => HighlightRenderer | null;
  getPhysics: () => { n: number } | null;
}): BondedGroupHighlightRuntime {
  // Heavy atom array owned by runtime, not store
  let _trackedAtoms: number[] | null = null;

  function filterValidIndices(indices: number[]): number[] {
    const physics = deps.getPhysics();
    if (!physics) return [];
    const n = physics.n;
    return indices.filter(i => i >= 0 && i < n);
  }

  /** Set tracked atoms and sync the store boolean. Uses setState directly
   *  because hasTrackedBondedHighlight is not exposed as a public store action —
   *  this runtime is the sole writer. */
  function setTracked(atoms: number[] | null) {
    _trackedAtoms = atoms;
    useAppStore.setState({ hasTrackedBondedHighlight: atoms != null && atoms.length > 0 });
  }

  /** Self-heal: if tracked highlight is feature-gated off but stale tracked
   *  state exists (e.g., from hot reload, prior session, or non-UI setup),
   *  clear it so hover preview isn't permanently suppressed. */
  function clearTrackedIfFeatureDisabled(): void {
    if (canTrackBondedGroupHighlightNow()) return;
    const store = useAppStore.getState();
    if (!_trackedAtoms && !store.hasTrackedBondedHighlight && !store.selectedBondedGroupId) return;
    _trackedAtoms = null;
    useAppStore.setState({
      selectedBondedGroupId: null,
      hasTrackedBondedHighlight: false,
    });
  }

  function syncToRenderer() {
    const renderer = deps.getRenderer();
    if (!renderer) return;
    clearTrackedIfFeatureDisabled();
    const store = useAppStore.getState();

    // Priority 1: persistent tracked atoms (frozen at selection time)
    if (_trackedAtoms && _trackedAtoms.length > 0) {
      const valid = filterValidIndices(_trackedAtoms);
      if (valid.length > 0) {
        renderer.setHighlightedAtoms(valid, 'selected');
      } else {
        // All tracked atoms are now invalid — auto-clear
        setTracked(null);
        store.setSelectedBondedGroup(null);
        renderer.setHighlightedAtoms(null);
      }
      return;
    }

    // Priority 2: hover preview (live group membership)
    if (store.hoveredBondedGroupId) {
      const bgr = deps.getBondedGroupRuntime();
      const atoms = bgr?.getAtomIndicesForGroup(store.hoveredBondedGroupId) ?? null;
      renderer.setHighlightedAtoms(atoms, 'hover');
      return;
    }

    // Priority 3: no highlight
    renderer.setHighlightedAtoms(null);
  }

  /** Toggle persistent tracked highlight for a bonded group.
   *  Two guards: canInspectBondedGroupsNow (inspection must be available)
   *  and canTrackBondedGroupHighlightNow (persistent tracking feature gate).
   *  Currently a no-op because the tracking gate is off. */
  function toggleSelectedGroup(id: string) {
    if (!canInspectBondedGroupsNow()) return;
    if (!canTrackBondedGroupHighlightNow()) return;
    const store = useAppStore.getState();
    if (store.selectedBondedGroupId === id) {
      // Deselect: clear everything
      store.setSelectedBondedGroup(null);
      setTracked(null);
    } else {
      // Select: freeze current atom membership (guard: only if atoms exist)
      const bgr = deps.getBondedGroupRuntime();
      const atoms = bgr?.getAtomIndicesForGroup(id);
      if (!atoms || atoms.length === 0) return; // no-op if group can't resolve
      store.setSelectedBondedGroup(id);
      setTracked([...atoms]);
      store.setHoveredBondedGroup(null);
    }
    syncToRenderer();
  }

  function setHoveredGroup(id: string | null) {
    if (!canInspectBondedGroupsNow()) return;
    const store = useAppStore.getState();
    const hasTracked = _trackedAtoms != null && _trackedAtoms.length > 0;
    // Block hover ENTRY when tracked highlight exists, but always allow CLEARING
    if (id !== null && hasTracked) return;
    store.setHoveredBondedGroup(id);
    if (!hasTracked) syncToRenderer();
  }

  function clearHighlight() {
    setTracked(null);
    // Clear all highlight-related store state — this runtime is the sole owner
    useAppStore.setState({
      selectedBondedGroupId: null,
      hoveredBondedGroupId: null,
      hasTrackedBondedHighlight: false,
    });
    syncToRenderer();
  }

  function syncAfterTopologyChange() {
    clearTrackedIfFeatureDisabled();
    const store = useAppStore.getState();
    const groups = store.bondedGroups;
    const groupIds = new Set(groups.map(g => g.id));

    // Clear stale selected row ID (but keep tracked atoms!)
    if (store.selectedBondedGroupId && !groupIds.has(store.selectedBondedGroupId)) {
      store.setSelectedBondedGroup(null);
    }
    if (store.hoveredBondedGroupId && !groupIds.has(store.hoveredBondedGroupId)) {
      store.setHoveredBondedGroup(null);
    }

    syncToRenderer();
  }

  return { toggleSelectedGroup, setHoveredGroup, clearHighlight, syncToRenderer, syncAfterTopologyChange };
}
