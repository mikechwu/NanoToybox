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
 * Identity model: assignments are authored by stable atomId. Both rendering
 * and export project from atomIds onto current dense slots via the identity
 * tracker. atomIndices is retained as an authoring-time snapshot for UI
 * (e.g., group chip state derivation) but does NOT drive renderer truth.
 */

import { useAppStore, type BondedGroupColorAssignment } from '../store/app-store';
import { type AtomColorOverrideMap, rebuildOverridesFromDenseIndices } from '../../../src/appearance/bonded-group-color-assignments';

export interface BondedGroupAppearanceRenderer {
  setAtomColorOverrides(overrides: Record<number, { hex: string }> | null): void;
}

export interface BondedGroupAppearanceRuntime {
  applyGroupColor(groupId: string, colorHex: string): void;
  clearGroupColor(groupId: string): void;
  clearColorAssignment(assignmentId: string): void;
  clearAllColors(): void;
  syncToRenderer(): void;
  pruneAndSync(atomCount: number): void;
}

export const rebuildOverridesFromAssignments = rebuildOverridesFromDenseIndices;

export function createBondedGroupAppearanceRuntime(deps: {
  getBondedGroupRuntime: () => { getAtomIndicesForGroup(id: string): number[] | null } | null;
  getRenderer: () => BondedGroupAppearanceRenderer | null;
  getStableAtomIds: () => number[];
  setStatusText?: (text: string | null) => void;
}): BondedGroupAppearanceRuntime {

  let nextAssignmentId = 1;

  function projectOverridesFromAtomIds(assignments: BondedGroupColorAssignment[]): AtomColorOverrideMap {
    if (assignments.length === 0) return {};
    const stableIds = deps.getStableAtomIds();
    const stableIdToSlot = new Map<number, number>();
    for (let i = 0; i < stableIds.length; i++) {
      stableIdToSlot.set(stableIds[i], i);
    }
    const projected = assignments.map(a => {
      const atomIndices: number[] = [];
      for (const id of a.atomIds) {
        const slot = stableIdToSlot.get(id);
        if (slot !== undefined) atomIndices.push(slot);
      }
      return { atomIndices, colorHex: a.colorHex };
    }).filter(a => a.atomIndices.length > 0);
    return rebuildOverridesFromDenseIndices(projected);
  }

  function applyGroupColor(groupId: string, colorHex: string): void {
    const bgr = deps.getBondedGroupRuntime();
    const atoms = bgr?.getAtomIndicesForGroup(groupId);
    if (!atoms || atoms.length === 0) return;

    const stableIds = deps.getStableAtomIds();
    const resolvedAtomIds = atoms.filter(i => i < stableIds.length).map(i => stableIds[i]);
    if (resolvedAtomIds.length !== atoms.length) {
      console.warn(`[appearance] applyGroupColor('${groupId}'): stable-ID resolution incomplete (${resolvedAtomIds.length}/${atoms.length} atoms resolved). Assignment not persisted.`);
      deps.setStatusText?.('Could not persist color — atom identity mapping is stale.');
      return;
    }
    const assignment: BondedGroupColorAssignment = {
      id: `ca${nextAssignmentId++}`,
      atomIndices: [...atoms],
      atomIds: resolvedAtomIds,
      colorHex,
      sourceGroupId: groupId,
    };

    const current = useAppStore.getState().bondedGroupColorAssignments
      .filter(a => a.sourceGroupId !== groupId);
    const updated = [...current, assignment];

    writeAssignments(updated);
  }

  function clearGroupColor(groupId: string): void {
    const current = useAppStore.getState().bondedGroupColorAssignments;
    writeAssignments(current.filter(a => a.sourceGroupId !== groupId));
  }

  function clearColorAssignment(assignmentId: string): void {
    const current = useAppStore.getState().bondedGroupColorAssignments;
    writeAssignments(current.filter(a => a.id !== assignmentId));
  }

  function clearAllColors(): void {
    writeAssignments([]);
  }

  function writeAssignments(assignments: BondedGroupColorAssignment[]): void {
    const overrides = projectOverridesFromAtomIds(assignments);
    useAppStore.setState({ bondedGroupColorAssignments: assignments, bondedGroupColorOverrides: overrides });
    applyOverridesToRenderer(overrides);
  }

  function syncToRenderer(): void {
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    const overrides = projectOverridesFromAtomIds(assignments);
    useAppStore.setState({ bondedGroupColorOverrides: overrides });
    applyOverridesToRenderer(overrides);
  }

  function applyOverridesToRenderer(overrides: AtomColorOverrideMap): void {
    const r = deps.getRenderer();
    if (!r) return;
    const hasOverrides = Object.keys(overrides).length > 0;
    r.setAtomColorOverrides(hasOverrides ? overrides : null);
  }

  function pruneAndSync(atomCount: number): void {
    const assignments = useAppStore.getState().bondedGroupColorAssignments;
    if (assignments.length === 0) { syncToRenderer(); return; }
    const stableIds = deps.getStableAtomIds();
    const liveIdSet = new Set(stableIds.slice(0, atomCount));
    // Prune by stable-ID membership only. atomIndices is an authoring-time
    // snapshot — it is not mutated here because it does not drive rendering
    // or export. Projection from atomIds handles current slot mapping.
    const pruned = assignments.map(a => ({
      ...a,
      atomIds: a.atomIds.filter(id => liveIdSet.has(id)),
    })).filter(a => a.atomIds.length > 0);
    const changed = pruned.length !== assignments.length
      || pruned.some((a, i) => a.atomIds.length !== assignments[i].atomIds.length);
    if (changed) {
      writeAssignments(pruned);
    } else {
      syncToRenderer();
    }
  }

  return { applyGroupColor, clearGroupColor, clearColorAssignment, clearAllColors, syncToRenderer, pruneAndSync };
}
