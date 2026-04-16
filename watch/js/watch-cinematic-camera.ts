/**
 * Watch Cinematic Camera — adapter around the shared pure module
 * (`src/camera/cinematic-camera.ts`) wired into Watch's renderer +
 * bonded-groups services.
 *
 * Responsibilities:
 *   - Own Watch-specific enabled flag, last user camera interaction
 *     timestamp, last target refresh timestamp, cached resolved target.
 *   - Recompute target at `cinematicSpeedProfile(playbackSpeed).
 *     targetRefreshIntervalMs`; apply smoothing every RAF tick when
 *     not paused.
 *   - Snapshot `{ enabled, active, pausedForUserInput, eligibleClusterCount }`.
 *   - Two lifecycles: `attachRenderer` (per-renderer) and
 *     `resetForFile` (per-file, preserves subscription). `dispose()`
 *     is final teardown.
 *
 * Manual Follow wins: controller does NOT call `update()` when
 * `viewService.isFollowing()`. Defense-in-depth: if called anyway,
 * the service early-returns without mutating state.
 */

import {
  cinematicSpeedProfile,
  resolveCinematicTarget,
  isUserInputCooldownActive,
  DEFAULT_CINEMATIC_CONFIG,
  type CinematicCameraConfig,
  type CinematicFramingTarget,
} from '../../src/camera/cinematic-camera';
import type { CameraInteractionPhase } from '../../src/camera/camera-interaction-gate';
import type { WatchRenderer } from './watch-renderer';
import type { WatchBondedGroups } from './watch-bonded-groups';

export interface WatchCinematicCameraState {
  enabled: boolean;
  active: boolean;
  pausedForUserInput: boolean;
  eligibleClusterCount: number;
}

export interface CinematicUpdateArgs {
  dtMs: number;
  nowMs: number;
  playbackSpeed: number;
  renderer: WatchRenderer;
  bondedGroups: WatchBondedGroups;
  manualFollowActive: boolean;
}

export interface WatchCinematicCameraService {
  getState(): WatchCinematicCameraState;
  setEnabled(enabled: boolean): void;
  /**
   * Record user camera activity. `phase` tracks whether the gesture
   * is currently held ('start' / 'change' keep the cinematic camera
   * paused as long as the gesture is active — even if the user
   * stops moving mid-hold) or released ('end' starts the
   * configured cooldown window from now). Defaults to 'change' for
   * discrete actions (single taps, programmatic commands) that
   * should simply refresh the cooldown timer.
   */
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
  let _lastTargetRefreshAt = 0;
  let _cachedTarget: CinematicFramingTarget | null = null;
  let _eligibleClusterCount = 0;
  let _pausedForUserInput = false;
  /** True while a user camera gesture is currently held (OrbitControls
   *  'start' fired, 'end' not yet). Keeps cinematic paused even when
   *  the user holds without moving — the cooldown timestamp alone
   *  would expire inside a still hold. Set by phase-aware
   *  `markUserCameraInteraction`. */
  let _userGestureActive = false;

  let _rendererDisposer: (() => void) | null = null;

  function getState(): WatchCinematicCameraState {
    return {
      enabled: _enabled,
      active: _enabled && !_pausedForUserInput && _eligibleClusterCount > 0,
      pausedForUserInput: _pausedForUserInput,
      eligibleClusterCount: _eligibleClusterCount,
    };
  }

  function markUserCameraInteraction(
    phase: CameraInteractionPhase = 'change',
    nowMs: number = performance.now(),
  ): void {
    _lastUserInteractionAt = nowMs;
    if (phase === 'start') _userGestureActive = true;
    else if (phase === 'end') _userGestureActive = false;
    // 'change' leaves `_userGestureActive` untouched: for discrete
    // taps / programmatic commands the flag stays false and only
    // the cooldown applies; for mid-gesture changes the flag was
    // already set by the preceding 'start'.
  }

  function update(args: CinematicUpdateArgs): boolean {
    const { dtMs, nowMs, playbackSpeed, renderer, bondedGroups, manualFollowActive } = args;

    // Defense-in-depth: controller already branches on manualFollow,
    // but if called anyway we early-return without touching state.
    if (manualFollowActive) {
      return false;
    }
    if (!_enabled) {
      _pausedForUserInput = false;
      return false;
    }

    // Pause while the user is actively interacting OR within the
    // wall-clock cooldown window following the release. Gesture-
    // active beats cooldown: a still-held gesture must never time
    // out into cinematic motion mid-hold.
    const cooldownActive = isUserInputCooldownActive(_lastUserInteractionAt, nowMs, config);
    const gestureActive = _userGestureActive || cooldownActive;
    _pausedForUserInput = gestureActive;
    if (gestureActive) {
      return false;
    }

    const profile = cinematicSpeedProfile(
      playbackSpeed,
      config.speedTuning,
      config.userIdleResumeMs,
    );

    // Target recompute at speed-profile interval. A mid-cycle drop
    // (resolver returns null) clears the cache — caller idle-holds
    // this tick rather than coasting on stale data.
    const shouldRefresh =
      nowMs - _lastTargetRefreshAt >= profile.targetRefreshIntervalMs || _cachedTarget === null;
    if (shouldRefresh) {
      const summaries = bondedGroups.getSummaries();
      const candidates = summaries.map(s => ({ id: s.id, atomCount: s.atomCount }));
      const result = resolveCinematicTarget(
        candidates,
        (id) => bondedGroups.getAtomIndicesForGroup(id),
        (i) => renderer.getDisplayedAtomWorldPosition(i),
        config,
      );
      _lastTargetRefreshAt = nowMs;
      _cachedTarget = result.target;
      // Report the eligible count unconditionally — a UI consumer
      // can distinguish "no major clusters yet" (count === 0) from
      // "clusters present but unreconciled this tick" (count > 0 &&
      // target === null) without reaching into the resolver.
      _eligibleClusterCount = result.eligibleClusterCount;
    }

    if (!_cachedTarget) {
      return false;
    }

    renderer.updateCinematicFraming(
      dtMs,
      { center: [..._cachedTarget.center] as [number, number, number], radius: _cachedTarget.radius },
      profile.smoothing,
    );
    return true;
  }

  function attachRenderer(renderer: WatchRenderer): void {
    // try/finally so a throwing prior disposer can't leave us with a
    // still-referenced old subscription AND no new one — that would
    // make the service silently deaf to future camera interactions.
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
    // Preserves _enabled and the renderer subscription. Clears
    // per-file target cache + cooldown so a new file starts fresh.
    _lastUserInteractionAt = null;
    _lastTargetRefreshAt = 0;
    _cachedTarget = null;
    _eligibleClusterCount = 0;
    _pausedForUserInput = false;
    _userGestureActive = false;
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
    _lastTargetRefreshAt = 0;
    _cachedTarget = null;
    _eligibleClusterCount = 0;
    _pausedForUserInput = false;
    _userGestureActive = false;
  }

  return {
    getState,
    setEnabled(enabled: boolean) {
      _enabled = enabled;
      if (!enabled) {
        // Clear BOTH gating flags. Without clearing
        // `_userGestureActive`, a toggle-off mid-gesture would leave
        // the flag stuck true; re-enabling later (with no fresh
        // 'end' ever delivered) would keep the service paused
        // indefinitely because `gestureActive = _userGestureActive
        // || cooldownActive`.
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
