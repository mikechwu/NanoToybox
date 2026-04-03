/**
 * Bonded group appearance runtime — translates group-level color edits
 * into atom-level color overrides applied via the renderer.
 *
 * Owns: group-to-atom color mapping, renderer sync for authored colors.
 * Does not: own highlight overlays, manage topology, or decide persistence.
 * Called by: future bonded-group UI (color wheel actions).
 *
 * Color edits use the annotation model (Option B): they are global overrides
 * that persist across live/review modes and are not part of timeline history.
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
  /** Clear all authored color overrides. */
  clearAllColors(): void;
  /** Sync current authored overrides to the renderer. */
  syncToRenderer(): void;
}

export function createBondedGroupAppearanceRuntime(deps: {
  getBondedGroupRuntime: () => { getAtomIndicesForGroup(id: string): number[] | null } | null;
  getRenderer: () => BondedGroupAppearanceRenderer | null;
}): BondedGroupAppearanceRuntime {

  function applyGroupColor(groupId: string, colorHex: string): void {
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

  function clearGroupColor(groupId: string): void {
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

  function clearAllColors(): void {
    useAppStore.getState().clearBondedGroupColorOverrides();
    const r = deps.getRenderer();
    if (r) r.setAtomColorOverrides(null);
  }

  function syncToRenderer(): void {
    const r = deps.getRenderer();
    if (!r) return;
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    const hasOverrides = Object.keys(overrides).length > 0;
    r.setAtomColorOverrides(hasOverrides ? overrides : null);
  }

  return { applyGroupColor, clearGroupColor, clearAllColors, syncToRenderer };
}
