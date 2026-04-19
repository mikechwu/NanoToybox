/**
 * Watch view service — camera target, follow state, center/follow commands.
 *
 * Follow model matches lab: follow freezes the atom membership at click time
 * and tracks those specific atoms, not the live group-id projection.
 * This prevents follow from drifting when group IDs or memberships change.
 *
 * Owns:        camera target ref, follow target (frozen atom set), center/follow commands.
 * Does NOT own: playback timing, analysis state, renderer lifecycle.
 */

import type { WatchRenderer, FramedTarget } from './watch-renderer';
import type { WatchBondedGroups } from '../analysis/watch-bonded-groups';
import { VIEWER_DEFAULTS } from '../../../src/config/viewer-defaults';

// ── Target types ──

/** Camera target ref for UI context (e.g., which group is targeted). */
export type WatchCameraTargetRef =
  | { kind: 'bonded-group'; groupId: string };

/** Follow target — frozen atom set captured at follow-start time. */
interface FollowTarget {
  atomIndices: number[];
}

export interface WatchViewService {
  getTargetRef(): WatchCameraTargetRef | null;
  isFollowing(): boolean;
  getFollowAtomIndices(): number[] | null;

  /** Center camera on a bonded group (animated). */
  centerOnGroup(groupId: string, renderer: WatchRenderer, analysis: WatchBondedGroups): void;
  /** Start following a bonded group: freeze atom membership, center once, then follow. */
  followGroup(groupId: string, renderer: WatchRenderer, analysis: WatchBondedGroups): void;
  /** Stop following. Clears follow target and camera target ref (matches lab). */
  unfollowGroup(): void;

  /** Per-frame follow update using frozen atom set. Returns false if follow was disabled. */
  updateFollow(dtMs: number, renderer: WatchRenderer): boolean;

  /** Clear all view state. */
  reset(): void;
}

/** Compute framed target from atom indices + renderer positions. */
function resolveAtomSetTarget(
  atomIndices: number[],
  renderer: WatchRenderer,
): FramedTarget | null {
  if (atomIndices.length === 0) return null;

  let cx = 0, cy = 0, cz = 0;
  let count = 0;
  for (const idx of atomIndices) {
    const pos = renderer.getDisplayedAtomWorldPosition(idx);
    if (!pos) continue;
    cx += pos[0]; cy += pos[1]; cz += pos[2];
    count++;
  }
  if (count === 0) return null;
  cx /= count; cy /= count; cz /= count;

  let maxDist = 0;
  for (const idx of atomIndices) {
    const pos = renderer.getDisplayedAtomWorldPosition(idx);
    if (!pos) continue;
    const dx = pos[0] - cx, dy = pos[1] - cy, dz = pos[2] - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDist) maxDist = dist;
  }

  return {
    center: [cx, cy, cz],
    radius: maxDist + VIEWER_DEFAULTS.atomVisualRadius,
  };
}

export function createWatchViewService(): WatchViewService {
  let _targetRef: WatchCameraTargetRef | null = null;
  let _followTarget: FollowTarget | null = null;
  let _following = false;

  return {
    getTargetRef: () => _targetRef,
    isFollowing: () => _following,
    getFollowAtomIndices: () => _followTarget?.atomIndices ?? null,

    centerOnGroup(groupId, renderer, analysis) {
      const atoms = analysis.getAtomIndicesForGroup(groupId);
      if (!atoms || atoms.length === 0) {
        console.warn(`[watch] centerOnGroup: no atoms found for group "${groupId}"`);
        return;
      }
      const target = resolveAtomSetTarget(atoms, renderer);
      if (!target) return;
      // Only update _targetRef if not following — avoid overwriting follow's target context
      if (!_following) {
        _targetRef = { kind: 'bonded-group', groupId };
      }
      renderer.animateToFramedTarget(target);
    },

    followGroup(groupId, renderer, analysis) {
      // 1. Freeze atom membership at click time (matches lab)
      const atoms = analysis.getAtomIndicesForGroup(groupId);
      if (!atoms || atoms.length === 0) {
        console.warn(`[watch] followGroup: no atoms found for group "${groupId}" — group may no longer exist`);
        return;
      }
      _followTarget = { atomIndices: [...atoms] };
      _targetRef = { kind: 'bonded-group', groupId };
      _following = true;

      // 2. Center once when follow starts (matches lab)
      const target = resolveAtomSetTarget(atoms, renderer);
      if (target) {
        renderer.animateToFramedTarget(target);
      }
    },

    unfollowGroup() {
      // Match lab: clear follow target + camera target ref (not just _following flag)
      _following = false;
      _followTarget = null;
      _targetRef = null;
    },

    updateFollow(dtMs, renderer) {
      if (!_following || !_followTarget) return false;
      const target = resolveAtomSetTarget(_followTarget.atomIndices, renderer);
      if (!target) {
        // Follow-failure: frozen atoms no longer resolvable
        console.warn('[watch] follow-failure: frozen atom set unresolvable');
        _following = false;
        _followTarget = null;
        _targetRef = null;
        return false;
      }
      renderer.updateOrbitFollow(dtMs, target);
      return true;
    },

    reset() {
      _targetRef = null;
      _followTarget = null;
      _following = false;
    },
  };
}
