/**
 * Watch Cinematic Camera — adapter around the shared pure module
 * (`src/camera/cinematic-camera.ts`) wired into Watch's renderer +
 * bonded-groups services.
 *
 * Two-cadence model:
 *   - Slow cadence (selection): full bonded-cluster membership
 *     resolution + authoritative radius, at
 *     `cinematicSpeedProfile(speed).targetRefreshIntervalMs`.
 *   - Fast cadence (center): re-read displayed atom positions for
 *     the already-selected atom set and recompute only the center,
 *     at `cinematicCenterRefreshProfile(speed).centerRefreshIntervalMs`.
 *   - Radius stays on the slow cadence in phase 1.
 *
 * Manual Follow wins: controller does NOT call `update()` when
 * `viewService.isFollowing()`. Defense-in-depth: if called anyway,
 * the service early-returns without mutating state.
 */

import {
  cinematicSpeedProfile,
  cinematicCenterRefreshProfile,
  resolveCinematicSelectionSnapshot,
  computeCinematicCenterFromAtomIndices,
  isUserInputCooldownActive,
  DEFAULT_CINEMATIC_CONFIG,
  type CinematicCameraConfig,
  type CinematicSelectionSnapshot,
} from '../../src/camera/cinematic-camera';
import type { CameraInteractionPhase } from '../../src/camera/camera-interaction-gate';
import type { WatchRenderer } from './watch-renderer';
import type { WatchBondedGroups } from './watch-bonded-groups';

/** Service-owned runtime status — the service can only emit these. */
export type ServiceCinematicCameraStatus =
  | 'off'
  | 'paused'
  | 'waiting_major_clusters'
  | 'waiting_topology'
  | 'tracking';

/** Controller-widened status for the public snapshot. The controller
 *  is the only layer that can know Follow is suppressing cinematic,
 *  so `'suppressed_by_follow'` only exists at this level. */
export type SnapshotCinematicCameraStatus =
  | ServiceCinematicCameraStatus
  | 'suppressed_by_follow';

export interface WatchCinematicCameraState {
  enabled: boolean;
  active: boolean;
  pausedForUserInput: boolean;
  eligibleClusterCount: number;
  status: ServiceCinematicCameraStatus;
}

export interface CinematicUpdateArgs {
  dtMs: number;
  nowMs: number;
  playbackSpeed: number;
  renderer: WatchRenderer;
  bondedGroups: WatchBondedGroups;
  manualFollowActive: boolean;
}

interface CinematicLiveTarget {
  center: readonly [number, number, number];
  radius: number;
}

export interface WatchCinematicCameraService {
  getState(): WatchCinematicCameraState;
  setEnabled(enabled: boolean): void;
  markUserCameraInteraction(phase?: CameraInteractionPhase, nowMs?: number): void;
  update(args: CinematicUpdateArgs): boolean;
  attachRenderer(renderer: WatchRenderer): void;
  resetForFile(): void;
  dispose(): void;
}

export function createWatchCinematicCameraService(
  config: CinematicCameraConfig = DEFAULT_CINEMATIC_CONFIG,
): WatchCinematicCameraService {
  let _enabled = config.enabledByDefault;
  let _lastUserInteractionAt: number | null = null;
  let _pausedForUserInput = false;
  let _userGestureActive = false;

  // Slow cadence: cluster membership + authoritative radius.
  let _selectionSnapshot: CinematicSelectionSnapshot | null = null;
  let _lastSelectionRefreshAt = 0;
  let _eligibleClusterCount = 0;

  // Fast cadence: live center refreshed from snapshot atom set.
  let _liveTarget: CinematicLiveTarget | null = null;
  let _lastCenterRefreshAt = 0;

  let _rendererDisposer: (() => void) | null = null;

  function getState(): WatchCinematicCameraState {
    const active = _enabled && !_pausedForUserInput && _eligibleClusterCount > 0 && _liveTarget !== null;
    let status: ServiceCinematicCameraStatus;
    if (!_enabled) status = 'off';
    else if (_pausedForUserInput) status = 'paused';
    else if (_eligibleClusterCount === 0) status = 'waiting_major_clusters';
    else if (_liveTarget === null) status = 'waiting_topology';
    else status = 'tracking';

    return {
      enabled: _enabled,
      active,
      pausedForUserInput: _pausedForUserInput,
      eligibleClusterCount: _eligibleClusterCount,
      status,
    };
  }

  function markUserCameraInteraction(
    phase: CameraInteractionPhase = 'change',
    nowMs: number = performance.now(),
  ): void {
    _lastUserInteractionAt = nowMs;
    if (phase === 'start') _userGestureActive = true;
    else if (phase === 'end') _userGestureActive = false;
  }

  // ── Slow cadence: full selection refresh ──

  function refreshSelectionSnapshot(
    nowMs: number,
    renderer: WatchRenderer,
    bondedGroups: WatchBondedGroups,
  ): void {
    const summaries = bondedGroups.getSummaries();
    const candidates = summaries.map(s => ({ id: s.id, atomCount: s.atomCount }));
    const result = resolveCinematicSelectionSnapshot(
      candidates,
      (id) => bondedGroups.getAtomIndicesForGroup(id),
      (i) => renderer.getDisplayedAtomWorldPosition(i),
      config,
    );
    _lastSelectionRefreshAt = nowMs;
    _eligibleClusterCount = result.eligibleClusterCount;

    if (result.snapshot) {
      _selectionSnapshot = result.snapshot;
      _liveTarget = {
        center: result.snapshot.center,
        radius: result.snapshot.radius,
      };
      _lastCenterRefreshAt = nowMs;
    } else {
      _selectionSnapshot = null;
      _liveTarget = null;
    }
  }

  // ── Fast cadence: center-only refresh ──

  function refreshLiveCenter(
    nowMs: number,
    renderer: WatchRenderer,
  ): void {
    if (!_selectionSnapshot) return;
    const newCenter = computeCinematicCenterFromAtomIndices(
      _selectionSnapshot.atomIndices,
      (i) => renderer.getDisplayedAtomWorldPosition(i),
      _selectionSnapshot.minFastStableResolvedCount,
    );
    _lastCenterRefreshAt = nowMs;
    if (newCenter) {
      _liveTarget = {
        center: newCenter,
        radius: _selectionSnapshot.radius,
      };
    }
    // On null: coast on prior _liveTarget (failure policy §6).
  }

  // ── Main update loop ──

  function update(args: CinematicUpdateArgs): boolean {
    const { dtMs, nowMs, playbackSpeed, renderer, bondedGroups, manualFollowActive } = args;

    if (manualFollowActive) return false;
    if (!_enabled) {
      _pausedForUserInput = false;
      return false;
    }

    const cooldownActive = isUserInputCooldownActive(_lastUserInteractionAt, nowMs, config);
    const gestureActive = _userGestureActive || cooldownActive;
    _pausedForUserInput = gestureActive;
    if (gestureActive) return false;

    const selectionProfile = cinematicSpeedProfile(
      playbackSpeed, config.speedTuning, config.userIdleResumeMs,
    );
    const centerProfile = cinematicCenterRefreshProfile(
      playbackSpeed, config.centerRefreshTuning,
    );

    // Stage 1: slow selection refresh if needed.
    const shouldRefreshSelection =
      _selectionSnapshot === null
      || nowMs - _lastSelectionRefreshAt >= selectionProfile.targetRefreshIntervalMs;
    if (shouldRefreshSelection) {
      refreshSelectionSnapshot(nowMs, renderer, bondedGroups);
    }

    // Stage 2: fast center refresh if selection exists and cadence
    // elapsed (skip if slow selection just ran — it already set the
    // initial center).
    if (!shouldRefreshSelection && _selectionSnapshot !== null) {
      const shouldRefreshCenter =
        nowMs - _lastCenterRefreshAt >= centerProfile.centerRefreshIntervalMs;
      if (shouldRefreshCenter) {
        refreshLiveCenter(nowMs, renderer);
      }
    }

    // Stage 3: feed renderer if we have a live target.
    if (!_liveTarget) return false;

    renderer.updateCinematicFraming(
      dtMs,
      { center: [..._liveTarget.center] as [number, number, number], radius: _liveTarget.radius },
      selectionProfile.smoothing,
    );
    return true;
  }

  function attachRenderer(renderer: WatchRenderer): void {
    if (_rendererDisposer) {
      const prev = _rendererDisposer;
      _rendererDisposer = null;
      try {
        prev();
      } catch (err) {
        console.error('[cinematic] prior renderer disposer threw:', err);
      }
    }
    _rendererDisposer = renderer.onCameraInteraction((phase) => markUserCameraInteraction(phase));
  }

  function resetForFile(): void {
    _lastUserInteractionAt = null;
    _pausedForUserInput = false;
    _userGestureActive = false;
    _selectionSnapshot = null;
    _liveTarget = null;
    _lastSelectionRefreshAt = 0;
    _lastCenterRefreshAt = 0;
    _eligibleClusterCount = 0;
  }

  function dispose(): void {
    if (_rendererDisposer) {
      const prev = _rendererDisposer;
      _rendererDisposer = null;
      try {
        prev();
      } catch (err) {
        console.error('[cinematic] renderer disposer threw during dispose:', err);
      }
    }
    _lastUserInteractionAt = null;
    _pausedForUserInput = false;
    _userGestureActive = false;
    _selectionSnapshot = null;
    _liveTarget = null;
    _lastSelectionRefreshAt = 0;
    _lastCenterRefreshAt = 0;
    _eligibleClusterCount = 0;
  }

  return {
    getState,
    setEnabled(enabled: boolean) {
      _enabled = enabled;
      if (!enabled) {
        _pausedForUserInput = false;
        _userGestureActive = false;
      }
    },
    markUserCameraInteraction,
    update,
    attachRenderer,
    resetForFile,
    dispose,
  };
}
