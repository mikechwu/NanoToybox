/**
 * Watch playback model — separated sampling channels for positions, topology, config, boundary.
 *
 * Round 5 additions: speed multiplier (0.5x–20x), repeat (modulo wrap),
 * step forward/backward (dense frame boundaries), gap clamp.
 */

import type { LoadedFullHistory, NormalizedDenseFrame, NormalizedRestartFrame } from './full-history-import';
import { VIEWER_DEFAULTS } from '../../src/config/viewer-defaults';
import { SPEED_MIN, SPEED_MAX, SPEED_DEFAULT, PLAYBACK_GAP_CLAMP_MS } from '../../src/config/playback-speed-constants';

/** Canonical x1 playback rate: ps advanced per real ms. */
const PS_PER_MS_AT_1X = VIEWER_DEFAULTS.baseSimRatePsPerSecond / 1000;

export interface WatchPlaybackModel {
  load(file: LoadedFullHistory): void;
  unload(): void;
  isLoaded(): boolean;
  getLoadedHistory(): LoadedFullHistory | null;
  /** Derived from playDirection !== 0. No separate setPlaying — use start/stop/pause. */
  isPlaying(): boolean;
  setCurrentTimePs(timePs: number): void;
  getCurrentTimePs(): number;
  getDurationPs(): number;
  getStartTimePs(): number;
  getEndTimePs(): number;

  // ── Playback policy commands ──
  advance(dtMs: number): void;
  startPlayback(): void;
  pausePlayback(): void;
  seekTo(timePs: number): void;

  // ── Round 5: speed, repeat, step, direction ──
  setSpeed(multiplier: number): void;
  getSpeed(): number;
  setRepeat(enabled: boolean): void;
  getRepeat(): boolean;
  stepForward(): void;
  stepBackward(): void;
  /** Start directional playback (1=forward, -1=backward). */
  startDirectionalPlayback(direction: 1 | -1): void;
  /** Stop directional playback (pause). */
  stopDirectionalPlayback(): void;
  /** Current playback direction: 1=forward, -1=backward, 0=paused. */
  getPlaybackDirection(): 1 | -1 | 0;

  // Separated sampling channels
  getDisplayPositionsAtTime(timePs: number): { n: number; atomIds: number[]; positions: Float64Array } | null;
  getTopologyAtTime(timePs: number): { bonds: [number, number, number][]; n: number; frameId: number } | null;
  getConfigAtTime(timePs: number): unknown | null;
  getBoundaryAtTime(timePs: number): unknown | null;
}

// ── Binary search: find frame at or before timePs ──

function bsearchAtOrBefore<T extends { timePs: number }>(frames: T[], timePs: number): T | null {
  if (frames.length === 0) return null;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (frames[mid].timePs <= timePs) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo].timePs <= timePs ? frames[lo] : null;
}

/** Binary search returning the INDEX of the frame at or before timePs. Returns -1 if none. */
function bsearchIndexAtOrBefore<T extends { timePs: number }>(frames: T[], timePs: number): number {
  if (frames.length === 0) return -1;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (frames[mid].timePs <= timePs) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo].timePs <= timePs ? lo : -1;
}

export function createWatchPlaybackModel(): WatchPlaybackModel {
  let _history: LoadedFullHistory | null = null;
  let _currentTimePs = 0;
  // Single source of truth: 0=paused, 1=forward, -1=backward.
  // isPlaying() is derived from this. No separate _playing boolean.
  let _playDirection: 1 | -1 | 0 = 0;
  let _speedMultiplier = SPEED_DEFAULT;
  let _repeat = false;

  function clampTime(timePs: number): number {
    if (!_history || _history.denseFrames.length === 0) return 0;
    const start = _history.denseFrames[0].timePs;
    const end = _history.denseFrames[_history.denseFrames.length - 1].timePs;
    return Math.max(start, Math.min(end, Number.isFinite(timePs) ? timePs : start));
  }

  return {
    load(file) {
      _history = file;
      _currentTimePs = file.denseFrames[0]?.timePs ?? 0;
      _playDirection = 0;
      _speedMultiplier = SPEED_DEFAULT;
      _repeat = false;
    },

    unload() {
      _history = null;
      _currentTimePs = 0;
      _playDirection = 0;
      _speedMultiplier = SPEED_DEFAULT;
      _repeat = false;
    },

    isLoaded: () => _history !== null,
    getLoadedHistory: () => _history,
    isPlaying: () => _playDirection !== 0,
    setCurrentTimePs(timePs) { _currentTimePs = clampTime(timePs); },
    getCurrentTimePs: () => _currentTimePs,
    getDurationPs: () => _history?.simulation.durationPs ?? 0,
    getStartTimePs: () => _history?.denseFrames[0]?.timePs ?? 0,
    getEndTimePs() {
      if (!_history || _history.denseFrames.length === 0) return 0;
      return _history.denseFrames[_history.denseFrames.length - 1].timePs;
    },

    // ── Playback policy commands ──

    advance(dtMs: number) {
      if (_playDirection === 0 || !_history) return;
      if (!Number.isFinite(dtMs) || dtMs <= 0) return;
      const clampedDt = Math.min(dtMs, PLAYBACK_GAP_CLAMP_MS);
      const dtPs = clampedDt * PS_PER_MS_AT_1X * _speedMultiplier * _playDirection;
      const start = _history.denseFrames[0]?.timePs ?? 0;
      const end = _history.denseFrames[_history.denseFrames.length - 1]?.timePs ?? 0;
      const duration = end - start;
      let next = _currentTimePs + dtPs;

      if (_playDirection > 0) {
        // Forward
        if (_repeat && duration > 0 && next >= end) {
          next = start + ((next - start) % duration);
        } else if (next >= end) {
          next = end;
          _playDirection = 0;
        }
      } else {
        // Backward
        if (_repeat && duration > 0 && next <= start) {
          next = end - ((start - next) % duration);
        } else if (next <= start) {
          next = start;
          _playDirection = 0;
        }
      }
      _currentTimePs = next;
    },

    startPlayback() {
      if (!_history || _history.denseFrames.length === 0) return;
      const end = _history.denseFrames[_history.denseFrames.length - 1]?.timePs ?? 0;
      if (_currentTimePs >= end) {
        _currentTimePs = _history.denseFrames[0]?.timePs ?? 0;
      }
      _playDirection = 1;
    },

    pausePlayback() {
      _playDirection = 0;
    },

    seekTo(timePs: number) {
      _currentTimePs = clampTime(timePs);
      _playDirection = 0;
    },

    // ── Round 5: speed, repeat, step ──

    setSpeed(multiplier: number) {
      _speedMultiplier = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Number.isFinite(multiplier) ? multiplier : SPEED_DEFAULT));
    },
    getSpeed: () => _speedMultiplier,

    setRepeat(enabled: boolean) { _repeat = enabled; },
    getRepeat: () => _repeat,

    stepForward() {
      if (!_history || _history.denseFrames.length === 0) return;
      const i = bsearchIndexAtOrBefore(_history.denseFrames, _currentTimePs);
      if (i < 0 || i + 1 >= _history.denseFrames.length) return;
      _currentTimePs = _history.denseFrames[i + 1].timePs;
      _playDirection = 0;
    },

    stepBackward() {
      if (!_history || _history.denseFrames.length === 0) return;
      const i = bsearchIndexAtOrBefore(_history.denseFrames, _currentTimePs);
      if (i <= 0) return;
      _currentTimePs = _history.denseFrames[i - 1].timePs;
      _playDirection = 0;
    },

    startDirectionalPlayback(direction: 1 | -1) {
      if (!_history || _history.denseFrames.length === 0) return;
      _playDirection = direction;
    },

    stopDirectionalPlayback() {
      _playDirection = 0;
    },

    getPlaybackDirection: () => _playDirection,

    // ── Sampling channels ──

    getDisplayPositionsAtTime(timePs: number) {
      if (!_history) return null;
      const frame = bsearchAtOrBefore<NormalizedDenseFrame>(_history.denseFrames, timePs);
      if (!frame) return null;
      return { n: frame.n, atomIds: frame.atomIds, positions: frame.positions };
    },

    getTopologyAtTime(timePs: number) {
      if (!_history) return null;
      const frame = bsearchAtOrBefore<NormalizedRestartFrame>(_history.restartFrames, timePs);
      if (!frame) return null;
      return { bonds: frame.bonds, n: frame.n, frameId: frame.frameId };
    },

    getConfigAtTime(timePs: number) {
      if (!_history) return null;
      const frame = bsearchAtOrBefore<NormalizedRestartFrame>(_history.restartFrames, timePs);
      return frame?.config ?? null;
    },

    getBoundaryAtTime(timePs: number) {
      if (!_history) return null;
      const frame = bsearchAtOrBefore<NormalizedDenseFrame>(_history.denseFrames, timePs);
      return frame?.boundary ?? null;
    },
  };
}
