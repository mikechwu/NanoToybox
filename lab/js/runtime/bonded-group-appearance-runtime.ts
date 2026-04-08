/**
 * Bonded group appearance runtime — translates group-level color edits
 * into atom-level color overrides applied via the renderer.
 *
 * Owns: frozen-atom-set color assignments, renderer sync for authored colors.
 * Does not: own highlight overlays, manage topology, or decide persistence.
 * Called by: BondedGroupsPanel preset color swatch editor (onApplyGroupColor, onClearGroupColor).
 *
 * Color edits use the annotation model (Option B): they are global overrides
 * that persist across live/review modes and are not part of timeline history.
 *
 * Frozen atom ownership: when a user colors a group, the exact atom indices
 * at that moment are frozen into a BondedGroupColorAssignment. Topology
 * changes (merges, splits, new bonds) never expand color ownership.
 * Only atom removal can shrink the visible colored set.
 */

import { useAppStore, type BondedGroupColorAssignment } from '../store/app-store';
import { type AtomColorOverrideMap, rebuildOverridesFromDenseIndices } from '../../../src/appearance/bonded-group-color-assignments';

export interface BondedGroupAppearanceRenderer {
  setAtomColorOverrides(overrides: Record<number, { hex: string }> | null): void;
}

export interface BondedGroupAppearanceRuntime {
  /** Apply a color to all atoms in the given bonded group (freezes atom set). */
  applyGroupColor(groupId: string, colorHex: string): void;
  /** Clear color assignments whose sourceGroupId matches. */
  clearGroupColor(groupId: string): void;
  /** Clear a specific color assignment by its unique id. */
  clearColorAssignment(assignmentId: string): void;
  /** Clear all authored color assignments and overrides. */
  clearAllColors(): void;
  /** Sync current authored overrides to the renderer. */
  syncToRenderer(): void;
  /** Prune assignments for atom indices that no longer exist, then rebuild + sync.
   *  Call after scene mutations that remove atoms (clearPlayground, wall removal). */
  pruneAndSync(atomCount: number): void;
}

/** Re-export shared projection under the old name for existing lab consumers. */
export const rebuildOverridesFromAssignments = rebuildOverridesFromDenseIndices;

export function createBondedGroupAppearanceRuntime(deps: {
  getBondedGroupRuntime: () => { getAtomIndicesForGroup(id: string): number[] | null } | null;
  getRenderer: () => BondedGroupAppearanceRenderer | null;
}): BondedGroupAppearanceRuntime {

  let nextAssignmentId = 1;

  function applyGroupColor(groupId: string, colorHex: string): void {
    const bgr = deps.getBondedGroupRuntime();
    const atoms = bgr?.getAtomIndicesForGroup(groupId);
    if (!atoms || atoms.length === 0) return;

    // Freeze atom indices — clone so future topology changes cannot mutate ownership
    const assignment: BondedGroupColorAssignment = {
      id: `ca${nextAssignmentId++}`,
      atomIndices: [...atoms],
      colorHex,
      sourceGroupId: groupId,
    };

    // Replace any prior assignment for the same source group, then append
    const current = useAppStore.getState().bondedGroupColorAssignments
      .filter(a => a.sourceGroupId !== groupId);
    const updated = [...current, assignment];

    writeAssignments(updated);
  }

  function clearGroupColor(groupId: string): void {
    const current = useAppStore.getState().bondedGroupColorAssignments;
    const updated = current.filter(a => a.sourceGroupId !== groupId);
    writeAssignments(updated);
  }

  function clearColorAssignment(assignmentId: string): void {
    const current = useAppStore.getState().bondedGroupColorAssignments;
    const updated = current.filter(a => a.id !== assignmentId);
    writeAssignments(updated);
  }

  function clearAllColors(): void {
    writeAssignments([]);
  }

  /** Write assignments to store, rebuild derived overrides, sync renderer.
   *  Uses a single setState call to avoid intermediate inconsistency. */
  function writeAssignments(assignments: BondedGroupColorAssignment[]): void {
    const overrides = rebuildOverridesFromAssignments(assignments);
    useAppStore.setState({ bondedGroupColorAssignments: assignments, bondedGroupColorOverrides: overrides });
    syncToRenderer();
  }

  function syncToRenderer(): void {
    const r = deps.getRenderer();
    if (!r) return;
    const overrides = useAppStore.getState().bondedGroupColorOverrides;
    const hasOverrides = Object.keys(overrides).length > 0;
    r.setAtomColorOverrides(hasOverrides ? overrides : null);
  }

  /** Prune assignments for atom indices that no longer exist, then rebuild + sync.
   *
   *  Contract: atom removal compacts active atoms to 0..atomCount-1.
   *  Indices >= atomCount are guaranteed invalid (owned by PhysicsEngine compaction).
   *  This is the main lifecycle guard for post-mutation color safety — if atom
   *  indexing rules ever change, this function must be updated to match. */
  function pruneAndSync(atomCount: number): void {
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    if (assignments.length === 0) { syncToRenderer(); return; }
    // Filter out atom indices >= atomCount (removed atoms)
    const pruned = assignments.map(a => ({
      ...a,
      atomIndices: a.atomIndices.filter(idx => idx < atomCount),
    })).filter(a => a.atomIndices.length > 0);
    const changed = pruned.length !== assignments.length
      || pruned.some((a, i) => a.atomIndices.length !== assignments[i].atomIndices.length);
    if (changed) {
      writeAssignments(pruned); // rebuilds overrides + syncs renderer
    } else {
      syncToRenderer(); // no-change recovery sync
    }
  }

  return { applyGroupColor, clearGroupColor, clearColorAssignment, clearAllColors, syncToRenderer, pruneAndSync };
}
