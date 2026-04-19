/**
 * Watch playback model — separated sampling channels for positions, topology, config, boundary.
 *
 * Round 5 additions: speed multiplier (0.5x–20x), repeat (modulo wrap),
 * step forward/backward (dense frame boundaries), gap clamp.
 *
 * Topology reconstruction: topology sampling delegates to a WatchTopologySource.
 * Full-history files use StoredTopologySource; reduced files use ReconstructedTopologySource.
 */

import type { LoadedFullHistory, NormalizedDenseFrame, NormalizedRestartFrame } from '../document/full-history-import';
import type { LoadedCapsuleHistory, NormalizedInteractionState } from '../document/capsule-history-import';
import { VIEWER_DEFAULTS } from '../../../src/config/viewer-defaults';
import { SPEED_MIN, SPEED_MAX, SPEED_DEFAULT, PLAYBACK_GAP_CLAMP_MS } from '../../../src/config/playback-speed-constants';
import { bsearchAtOrBefore, bsearchIndexAtOrBefore } from './frame-search';
import { createStoredTopologySource } from './topology-sources/stored-topology-source';
import { createReconstructedTopologySource } from './topology-sources/reconstructed-topology-source';

/** Canonical x1 playback rate: ps advanced per real ms. */
const PS_PER_MS_AT_1X = VIEWER_DEFAULTS.baseSimRatePsPerSecond / 1000;

/** Watch-local topology provider abstraction. The playback model delegates
 *  getTopologyAtTime() to the active source. */
export interface WatchTopologySource {
  reset(): void;
  getTopologyAtTime(timePs: number): { bonds: [number, number, number][]; n: number; frameId: number } | null;
  /**
   * Cheap O(log n) — returns just the frame id at `timePs` without
   * materializing bonds. Exists so UI availability checks (like
   * snap-to-nearest-seedable scan) can probe frame identity WITHOUT
   * triggering reconstructed-topology bond building on a cache miss.
   * Every implementation MUST avoid the heavy path that
   * `getTopologyAtTime` takes.
   */
  getTopologyFrameIdAtTime(timePs: number): number | null;
}

/** Discriminated union of loaded history kinds. Legacy 'reduced' files
 *  normalize to LoadedCapsuleHistory at import time. */
export type LoadedWatchHistory = LoadedFullHistory | LoadedCapsuleHistory;

export interface WatchPlaybackModel {
  load(file: LoadedWatchHistory): void;
  unload(): void;
  isLoaded(): boolean;
  getLoadedHistory(): LoadedWatchHistory | null;
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
  getInteractionAtTime(timePs: number): import('../document/capsule-history-import').NormalizedInteractionState | null;

  // ── PR 2 foundation: cheap primitives for the seed predicate ──
  /** O(log n) binary search — returns the dense-frame index whose
   *  positions are displayed at `timePs`, or null if none resolves. */
  getDisplayFrameIndexAtTime(timePs: number): number | null;
  /** Returns the topology frame id at `timePs` without materializing
   *  the bond array. For full histories this is driven by restart-
   *  frame alignment; for capsule histories it mirrors the dense-
   *  frame id. */
  getTopologyFrameIdAtTime(timePs: number): number | null;
  /** For capsule histories: returns true iff the given dense-frame
   *  index has at least one neighbor (prev or next) resolvable so
   *  velocity approximation has an input. For full histories always
   *  true when the index is valid. Does NOT run the approximation. */
  canApproximateVelocityAtDisplayFrame(index: number): boolean;
  /** Returns the neighbor dense-frame indices (prev/next) for use by
   *  the seed builder. Returns {prev: null, next: null} at singletons. */
  getNeighborDenseFrameIndices(index: number): { prev: number | null; next: number | null };
  /**
   * For full histories, returns the nearest restart-frame's frameId
   * at-or-before `timePs`. This is what the seed builder uses to
   * source config + boundary + velocities, so the cache key must
   * track it — two different timePs values inside the same display
   * frame can resolve to different restart frames. Returns null for
   * capsule histories (no restart frames) OR when no restart frame
   * covers `timePs`.
   */
  getNearestRestartFrameIdAtTime(timePs: number): number | null;
  /** Snap `timePs` to the nearest dense frame that can produce a valid
   *  Lab seed (display positions + topology frame + velocity approximation
   *  all resolvable at that frame). Returns null ONLY when the file
   *  contains no seedable frame at all — e.g., a single-frame capsule
   *  history where finite-difference velocity has no neighbor.
   *
   *  This powers the "Continue button never goes unavailable during
   *  playback" contract: the UI stays enabled on any loaded file with
   *  seedable frames, and the click-path builds the handoff from the
   *  snapped frame even when the continuous playback time lands between
   *  frames or before the topology source's first covered time. */
  findNearestSeedableTimePs(timePs: number): number | null;
}

// Binary search helpers shared across watch/ — see frame-search.ts

export function createWatchPlaybackModel(): WatchPlaybackModel {
  let _history: LoadedWatchHistory | null = null;
  let _topologySource: WatchTopologySource | null = null;
  let _currentTimePs = 0;
  // Single source of truth: 0=paused, 1=forward, -1=backward.
  // isPlaying() is derived from this. No separate _playing boolean.
  let _playDirection: 1 | -1 | 0 = 0;
  let _speedMultiplier = SPEED_DEFAULT;
  let _repeat = true;

  function clampTime(timePs: number): number {
    if (!_history || _history.denseFrames.length === 0) return 0;
    const start = _history.denseFrames[0].timePs;
    const end = _history.denseFrames[_history.denseFrames.length - 1].timePs;
    return Math.max(start, Math.min(end, Number.isFinite(timePs) ? timePs : start));
  }

  return {
    load(file) {
      if (_topologySource) { _topologySource.reset(); _topologySource = null; }
      _history = file;
      _currentTimePs = file.denseFrames[0]?.timePs ?? 0;
      _playDirection = 0;
      _speedMultiplier = SPEED_DEFAULT;
      _repeat = true;
      // Select topology source based on file kind
      if (file.kind === 'full') {
        _topologySource = createStoredTopologySource(file.restartFrames);
      } else {
        _topologySource = createReconstructedTopologySource(file.denseFrames, file.elementById, file.bondPolicy);
      }
    },

    unload() {
      if (_topologySource) { _topologySource.reset(); _topologySource = null; }
      _history = null;
      _currentTimePs = 0;
      _playDirection = 0;
      _speedMultiplier = SPEED_DEFAULT;
      _repeat = true;
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
      if (!_topologySource) return null;
      return _topologySource.getTopologyAtTime(timePs);
    },

    getConfigAtTime(timePs: number) {
      if (!_history || _history.kind !== 'full') return null;
      const frame = bsearchAtOrBefore<NormalizedRestartFrame>(_history.restartFrames, timePs);
      return frame?.config ?? null;
    },

    getBoundaryAtTime(timePs: number) {
      if (!_history) return null;
      const frame = bsearchAtOrBefore<NormalizedDenseFrame>(_history.denseFrames, timePs);
      return frame?.boundary ?? null;
    },

    getInteractionAtTime(timePs: number): NormalizedInteractionState | null {
      if (!_history || _history.kind !== 'capsule') return null;
      const { interactionTimeline } = _history;
      if (!interactionTimeline || interactionTimeline.events.length === 0) return null;
      const denseFrame = bsearchAtOrBefore<NormalizedDenseFrame>(_history.denseFrames, timePs);
      if (!denseFrame) return null;
      const events = interactionTimeline.events;
      let lo = 0, hi = events.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (events[mid].frameId <= denseFrame.frameId) lo = mid; else hi = mid - 1;
      }
      if (events[lo].frameId > denseFrame.frameId) return null;
      const e = events[lo];
      if (e.kind === 'none') return { kind: 'none' };
      return { kind: e.kind, atomId: (e as { atomId: number }).atomId, target: (e as { target: [number, number, number] }).target };
    },

    // ── Cheap primitives for the snap-to-nearest-seedable helper ──

    getDisplayFrameIndexAtTime(timePs: number): number | null {
      if (!_history) return null;
      const i = bsearchIndexAtOrBefore(_history.denseFrames, timePs);
      if (i < 0 || i >= _history.denseFrames.length) return null;
      return i;
    },

    getTopologyFrameIdAtTime(timePs: number): number | null {
      if (!_topologySource) return null;
      // Use the dedicated cheap probe — never `getTopologyAtTime`, which
      // would trigger bond reconstruction for capsule sources on a cache
      // miss. See WatchTopologySource docstring + rev 6 follow-up P1.1.
      return _topologySource.getTopologyFrameIdAtTime(timePs);
    },

    canApproximateVelocityAtDisplayFrame(index: number): boolean {
      if (!_history) return false;
      if (index < 0 || index >= _history.denseFrames.length) return false;
      // Full histories: velocities are available from restart-frame
      // alignment, so any valid display frame qualifies.
      if (_history.kind === 'full') return true;
      // Capsule: need at least one neighbor frame to do finite-
      // difference velocity approximation.
      return _history.denseFrames.length >= 2;
    },

    getNeighborDenseFrameIndices(index: number): { prev: number | null; next: number | null } {
      if (!_history) return { prev: null, next: null };
      const n = _history.denseFrames.length;
      if (index < 0 || index >= n) return { prev: null, next: null };
      return {
        prev: index > 0 ? index - 1 : null,
        next: index < n - 1 ? index + 1 : null,
      };
    },

    getNearestRestartFrameIdAtTime(timePs: number): number | null {
      if (!_history || _history.kind !== 'full') return null;
      const frames = _history.restartFrames;
      if (frames.length === 0) return null;
      // Linear walk — restart frames are typically few (<100). Fine.
      let candidate: NormalizedRestartFrame | null = null;
      for (const rf of frames) {
        if (rf.timePs <= timePs) candidate = rf;
        else break;
      }
      return candidate ? candidate.frameId : null;
    },

    findNearestSeedableTimePs(timePs: number): number | null {
      // Runs on the click path only (once per Continue click). Dense
      // frames are O(10²–10⁴); a linear scan here costs microseconds
      // and avoids carrying a parallel "seedable-index" array. If this
      // ever lands on a hot path, swap for a two-pointer outward walk
      // from `bsearchIndexAtOrBefore` — same semantics, O(log n + gap).
      if (!_history) return null;
      const frames = _history.denseFrames;
      const n = frames.length;
      if (n === 0) return null;
      // Capsule histories need ≥2 frames for finite-difference velocity.
      // A lone-frame capsule is genuinely unseedable; return null so
      // the caller keeps the button disabled.
      if (_history.kind !== 'full' && n < 2) return null;
      let bestTimePs: number | null = null;
      let bestDelta = Infinity;
      for (let i = 0; i < n; i++) {
        const t = frames[i].timePs;
        // A frame is seedable iff the topology source resolves at
        // `t`. (Display frame existence is implicit — we're iterating
        // the dense array. Velocity-approximability is a file-level
        // property already gated above.)
        if (_topologySource && _topologySource.getTopologyFrameIdAtTime(t) == null) continue;
        const d = Math.abs(t - timePs);
        if (d < bestDelta) {
          bestDelta = d;
          bestTimePs = t;
          // Early-out: an exact hit can't be beaten. `bestDelta === 0`
          // happens on every click that lands on a frame boundary
          // (playback paused on a frame, scrub snapped to one, etc.).
          if (d === 0) return bestTimePs;
        }
      }
      return bestTimePs;
    },
  };
}
