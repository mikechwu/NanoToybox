/**
 * Watch playback model — separated sampling channels for positions, topology, config, boundary.
 *
 * v1: all channels return exact recorded data (stepwise from nearest frame at or before timePs).
 * v2: only position sampling may become interpolated; topology/config/boundary remain stepwise.
 */

import type { LoadedFullHistory, NormalizedDenseFrame, NormalizedRestartFrame } from './full-history-import';

export interface WatchPlaybackModel {
  load(file: LoadedFullHistory): void;
  unload(): void;
  isLoaded(): boolean;
  getLoadedHistory(): LoadedFullHistory | null;
  setPlaying(playing: boolean): void;
  isPlaying(): boolean;
  setCurrentTimePs(timePs: number): void;
  getCurrentTimePs(): number;
  getDurationPs(): number;
  getStartTimePs(): number;
  getEndTimePs(): number;

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

export function createWatchPlaybackModel(): WatchPlaybackModel {
  let _history: LoadedFullHistory | null = null;
  let _currentTimePs = 0;
  let _playing = false;

  return {
    load(file) {
      _history = file;
      _currentTimePs = file.denseFrames[0]?.timePs ?? 0;
      _playing = false;
    },

    unload() {
      _history = null;
      _currentTimePs = 0;
      _playing = false;
    },

    isLoaded: () => _history !== null,
    getLoadedHistory: () => _history,
    setPlaying(playing) { _playing = playing; },
    isPlaying: () => _playing,
    setCurrentTimePs(timePs) {
      if (!_history || _history.denseFrames.length === 0) { _currentTimePs = 0; return; }
      const start = _history.denseFrames[0].timePs;
      const end = _history.denseFrames[_history.denseFrames.length - 1].timePs;
      _currentTimePs = Math.max(start, Math.min(end, Number.isFinite(timePs) ? timePs : start));
    },
    getCurrentTimePs: () => _currentTimePs,
    getDurationPs: () => _history?.simulation.durationPs ?? 0,
    getStartTimePs: () => _history?.denseFrames[0]?.timePs ?? 0,
    getEndTimePs() {
      if (!_history || _history.denseFrames.length === 0) return 0;
      return _history.denseFrames[_history.denseFrames.length - 1].timePs;
    },

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
