/**
 * Bonded group appearance runtime — translates group-level color edits
 * into atom-level color overrides applied via the renderer.
 *
 * Owns: group-to-atom color mapping, renderer sync for authored colors.
 * Does not: own highlight overlays, manage topology, or decide persistence.
 * Called by: BondedGroupsPanel preset color swatch editor (onApplyGroupColor, onClearGroupColor).
 *
 * Color edits use the annotation model (Option B): they are global overrides
 * that persist across live/review modes and are not part of timeline history.
 *
 * Group color intents: when a user colors a group, the intent is stored by
 * group ID. After each topology projection, syncGroupIntents() re-applies
 * intents to atoms that have NO existing override — filling in newly joined
 * atoms while preserving colors from other merged groups (multi-color safe).
 *
 * Wiring: callers must invoke syncGroupIntents() after every projectNow()
 * call so that topology changes (merges, splits, new bonds) are reflected
 * in atom colors. The frame-runtime orchestrates this at each projection
 * trigger point.
 */

import { useAppStore, type AtomColorOverrideMap } from '../store/app-store';

export interface BondedGroupAppearanceRenderer {
  setAtomColorOverrides(overrides: Record<number, { hex: string }> | null): void;
}

export interface BondedGroupAppearanceRuntime {
  /** Apply a color to all atoms in the given bonded group. */
  applyGroupColor(groupId: string, colorHex: string): void;
  /** Clear the color override for all atoms in the given bonded group. */
  clearGroupColor(groupId: string): void;
  /** Clear all authored color overrides and group intents. */
  clearAllColors(): void;
  /** Sync current authored overrides to the renderer. */
  syncToRenderer(): void;
  /** Re-apply group color intents after topology projection.
   *  Call after projectNow() so newly joined atoms inherit group colors. */
  syncGroupIntents(): void;
}

export function createBondedGroupAppearanceRuntime(deps: {
  getBondedGroupRuntime: () => { getAtomIndicesForGroup(id: string): number[] | null } | null;
  getRenderer: () => BondedGroupAppearanceRenderer | null;
}): BondedGroupAppearanceRuntime {

  /** Group-level color intent — survives topology changes. */
  const groupColorIntents = new Map<string, string>();

  /** Store a color intent for the group and immediately apply it to all current atoms. */
  function applyGroupColor(groupId: string, colorHex: string): void {
    groupColorIntents.set(groupId, colorHex);
    applyIntentToAtoms(groupId, colorHex);
  }

  /** Remove the group's color intent and delete overrides from its current atoms. */
  function clearGroupColor(groupId: string): void {
    groupColorIntents.delete(groupId);
    const bgr = deps.getBondedGroupRuntime();
    const atoms = bgr?.getAtomIndicesForGroup(groupId);
    if (!atoms || atoms.length === 0) return;

    const current = { ...useAppStore.getState().bondedGroupColorOverrides };
    for (const idx of atoms) {
      delete current[idx];
    }
    useAppStore.getState().setBondedGroupColorOverrides(current);
    syncToRenderer();
  }

  /** Clear every group intent and all atom color overrides, then null out renderer overrides. */
  function clearAllColors(): void {
    groupColorIntents.clear();
    useAppStore.getState().clearBondedGroupColorOverrides();
    const r = deps.getRenderer();
    if (r) r.setAtomColorOverrides(null);
  }

  /** Apply a single group's intent to its current atoms. */
  function applyIntentToAtoms(groupId: string, colorHex: string): void {
    const bgr = deps.getBondedGroupRuntime();
    const atoms = bgr?.getAtomIndicesForGroup(groupId);
    if (!atoms || atoms.length === 0) return;

    const current = { ...useAppStore.getState().bondedGroupColorOverrides };
    for (const idx of atoms) {
      current[idx] = { hex: colorHex };
    }
    useAppStore.getState().setBondedGroupColorOverrides(current);
    syncToRenderer();
  }

  /**
   * Re-apply stored group color intents after a topology projection.
   * Fills only uncolored atoms — existing overrides from other groups are
   * preserved, keeping multi-color appearance after merges intact.
   * Prunes intents whose groups no longer exist.
   */
  function syncGroupIntents(): void {
    if (groupColorIntents.size === 0) return;
    const bgr = deps.getBondedGroupRuntime();
    if (!bgr) return;

    // Prune intents for groups that no longer exist
    for (const [groupId] of groupColorIntents) {
      const atoms = bgr.getAtomIndicesForGroup(groupId);
      if (!atoms || atoms.length === 0) {
        groupColorIntents.delete(groupId);
      }
    }
    if (groupColorIntents.size === 0) return;

    // Re-apply intents only to atoms that have NO existing override.
    // This fills in newly joined atoms without overwriting colors from
    // other merged groups (preserves multi-color after group merges).
    const current = { ...useAppStore.getState().bondedGroupColorOverrides };
    let changed = false;
    for (const [groupId, hex] of groupColorIntents) {
      const atoms = bgr.getAtomIndicesForGroup(groupId);
      if (!atoms) continue;
      for (const idx of atoms) {
        if (!current[idx]) {
          current[idx] = { hex };
          changed = true;
        }
      }
    }
    if (changed) {
      useAppStore.getState().setBondedGroupColorOverrides(current);
      syncToRenderer();
    }
  }

  /** Push the current authored color overrides to the renderer (null if empty). */
  function syncToRenderer(): void {
    const r = deps.getRenderer();
    if (!r) return;
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    const hasOverrides = Object.keys(overrides).length > 0;
    r.setAtomColorOverrides(hasOverrides ? overrides : null);
  }

  return { applyGroupColor, clearGroupColor, clearAllColors, syncToRenderer, syncGroupIntents };
}
