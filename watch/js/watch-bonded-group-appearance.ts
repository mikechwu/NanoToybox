/**
 * Watch bonded-group appearance runtime — authored color assignments using stable atomIds.
 *
 * Watch stores assignments keyed by stable atomIds (from history file frames),
 * not dense slot indices. Each frame, stable atomIds are projected to current
 * dense slot indices before passing to the renderer.
 *
 * Owns: authored color assignments, per-frame projection, renderer sync.
 * Does NOT own: hover highlight, follow state, color editor UI state.
 */

import type { WatchRenderer } from './watch-renderer';
import type { WatchBondedGroups } from './watch-bonded-groups';
import type { WatchPlaybackModel } from './watch-playback-model';
import {
  type AtomColorOverrideMap,
  type GroupColorState,
  rebuildOverridesFromDenseIndices,
  computeGroupColorState,
} from '../../src/appearance/bonded-group-color-assignments';

// ── Watch-specific assignment type (stable atomIds, not dense slot indices) ──

export interface WatchColorAssignment {
  id: string;
  atomIds: number[];          // Stable atomIds from history file — frozen at assignment time
  colorHex: string;
  sourceGroupId: string;
}

export interface WatchBondedGroupAppearance {
  /** Apply a color to all atoms in the given group (freezes stable atomIds). */
  applyGroupColor(groupId: string, colorHex: string): void;
  /** Clear color assignments for the given group. */
  clearGroupColor(groupId: string): void;
  /** Clear all authored color assignments. */
  clearAllColors(): void;
  /** Project current assignments to dense slot indices and sync to renderer. */
  projectAndSync(timePs: number): void;
  /** Get current chip color state for a group (for UI). */
  getGroupColorState(groupId: string): GroupColorState;
  /** Get all current assignments (for snapshot/rollback). */
  getAssignments(): readonly WatchColorAssignment[];
  /** Restore previously saved assignments (for rollback after failed file load). */
  restoreAssignments(assignments: WatchColorAssignment[]): void;
  /** Get the current dense-index override map (for chip state derivation). */
  getOverrideMap(): AtomColorOverrideMap;
  /** Import color assignments from a capsule file (creates synthetic WatchColorAssignments). */
  importColorAssignments(assignments: { atomIds: number[]; colorHex: string }[]): void;
  /** Reset all state (called on file load). */
  reset(): void;
}

export function createWatchBondedGroupAppearance(deps: {
  getBondedGroups: () => WatchBondedGroups;
  getPlaybackModel: () => WatchPlaybackModel;
  getRenderer: () => WatchRenderer | null;
}): WatchBondedGroupAppearance {

  let _assignments: WatchColorAssignment[] = [];
  let _overrides: AtomColorOverrideMap = {};
  let _nextId = 1;

  /**
   * Freeze stable atomIds at assignment time.
   * Algorithm: group dense slots → current frame atomIds → stable atomIds.
   */
  function applyGroupColor(groupId: string, colorHex: string): void {
    const groups = deps.getBondedGroups();
    const groupSlots = groups.getAtomIndicesForGroup(groupId);
    if (!groupSlots || groupSlots.length === 0) return;

    const playback = deps.getPlaybackModel();
    const timePs = playback.getCurrentTimePs();
    const frameData = playback.getDisplayPositionsAtTime(timePs);
    if (!frameData) return;

    // Convert dense slot indices → stable atomIds
    const atomIds = groupSlots
      .filter(i => i < frameData.atomIds.length)
      .map(i => frameData.atomIds[i]);
    if (atomIds.length === 0) return;

    const assignment: WatchColorAssignment = {
      id: `wca${_nextId++}`,
      atomIds: [...atomIds],
      colorHex,
      sourceGroupId: groupId,
    };

    // Replace any prior assignment for the same source group, then append
    _assignments = _assignments.filter(a => a.sourceGroupId !== groupId);
    _assignments.push(assignment);

    // Immediate projection + sync
    projectAndSync(timePs);
  }

  function clearGroupColor(groupId: string): void {
    _assignments = _assignments.filter(a => a.sourceGroupId !== groupId);
    const playback = deps.getPlaybackModel();
    projectAndSync(playback.getCurrentTimePs());
  }

  function clearAllColors(): void {
    _assignments = [];
    _overrides = {};
    const r = deps.getRenderer();
    if (r) r.setAtomColorOverrides(null);
  }

  /**
   * Per-frame projection: stable atomIds → current dense slot indices → renderer overrides.
   *
   * 1. Get current frame's atomIds[]
   * 2. Build atomId→slot lookup
   * 3. For each assignment, map atomIds → dense slots (skip missing)
   * 4. Build override map via shared rebuildOverridesFromDenseIndices
   * 5. Sync to renderer
   */
  function projectAndSync(timePs: number): void {
    const r = deps.getRenderer();
    if (_assignments.length === 0) {
      _overrides = {};
      if (r) r.setAtomColorOverrides(null);
      return;
    }

    const playback = deps.getPlaybackModel();
    const frameData = playback.getDisplayPositionsAtTime(timePs);
    if (!frameData) {
      _overrides = {};
      if (r) r.setAtomColorOverrides(null);
      return;
    }

    // Build atomId→slot lookup for current frame
    const atomIdToSlot = new Map<number, number>();
    for (let i = 0; i < frameData.atomIds.length; i++) {
      atomIdToSlot.set(frameData.atomIds[i], i);
    }

    // Project each assignment's stable atomIds to current dense slots
    const projected = _assignments.map(a => {
      const atomIndices: number[] = [];
      for (const id of a.atomIds) {
        const slot = atomIdToSlot.get(id);
        if (slot !== undefined) atomIndices.push(slot);
      }
      return { atomIndices, colorHex: a.colorHex };
    }).filter(a => a.atomIndices.length > 0);

    _overrides = rebuildOverridesFromDenseIndices(projected);
    const hasOverrides = Object.keys(_overrides).length > 0;
    if (r) r.setAtomColorOverrides(hasOverrides ? _overrides : null);
  }

  function getGroupColorState(groupId: string): GroupColorState {
    const groups = deps.getBondedGroups();
    const atomIndices = groups.getAtomIndicesForGroup(groupId);
    if (!atomIndices || atomIndices.length === 0) return { kind: 'default' };
    return computeGroupColorState(atomIndices, _overrides);
  }

  function reset(): void {
    _assignments = [];
    _overrides = {};
    _nextId = 1;
    const r = deps.getRenderer();
    if (r) r.setAtomColorOverrides(null);
  }

  function importColorAssignments(assignments: { atomIds: number[]; colorHex: string }[]): void {
    for (const a of assignments) {
      const assignmentId = _nextId++;
      _assignments.push({
        id: `imported-${assignmentId}`,
        atomIds: [...a.atomIds],
        colorHex: a.colorHex,
        sourceGroupId: `imported-group-${assignmentId}`,
      });
    }
  }

  return {
    applyGroupColor,
    clearGroupColor,
    clearAllColors,
    projectAndSync,
    getGroupColorState,
    importColorAssignments,
    getAssignments: () => _assignments,
    restoreAssignments(assignments: WatchColorAssignment[]) {
      _assignments = [...assignments];
      _nextId = assignments.reduce((max, a) => {
        const stripped = a.id.replace(/^(wca|imported-)/, '');
        const n = parseInt(stripped, 10);
        return isNaN(n) ? max : Math.max(max, n + 1);
      }, _nextId);
    },
    getOverrideMap: () => _overrides,
    reset,
  };
}
