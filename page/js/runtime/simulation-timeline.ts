/**
 * Simulation timeline — runtime module for recording, review, and restart.
 *
 * Three data layers:
 *  1. Dense review frames (~10 Hz) — positions only, for smooth scrub playback
 *  2. Dense restart frames (~10 Hz) — positions + velocities, for restart-to-viewed-state
 *  3. Sparse full checkpoints (~1/sec) — complete physics state, fallback for restart
 *
 * Review frames and restart frames are recorded at the same cadence but stored
 * separately: review frames are lightweight (no velocities), restart frames
 * carry enough state for physically consistent continuation.
 *
 * Does NOT own: raw physics stepping, renderer internals, worker bridge, React.
 */

import type { PhysicsCheckpoint } from '../../../src/types/interfaces';
import type {
  TimelineInteractionState,
  TimelineBoundaryState,
} from './timeline-context-capture';

// ── Data model ──

/** Review-only frame — positions for smooth visual scrubbing. */
export interface TimelineFrame {
  frameId: number;
  timePs: number;
  n: number;
  positions: Float64Array;
  interaction: TimelineInteractionState | null;
  boundary: TimelineBoundaryState;
}

/** Physics coefficients at the time of recording — needed for force-field reproduction. */
export interface TimelinePhysicsConfig {
  damping: number;
  kDrag: number;
  kRotate: number;
}

/**
 * RestartState — the single authoritative contract for rewindable simulation state.
 *
 * This type defines every input needed to reproduce a trajectory from a past
 * point. It is the shared contract between:
 *   - timeline storage (restart frames and checkpoints produce this)
 *   - main-thread restore (coordinator consumes this)
 *   - worker restore (worker init receives the same fields)
 *
 * It does NOT include derived state (forces, neighbor lists) because those
 * are deterministically recomputed from the fields here.
 */
export interface RestartState {
  timePs: number;
  n: number;
  positions: Float64Array;
  velocities: Float64Array;
  bonds: [number, number, number][];
  config: TimelinePhysicsConfig;
  interaction: TimelineInteractionState | null;
  boundary: TimelineBoundaryState;
}

/** Restart-grade frame — full force-defining state for physically consistent restart. */
export interface TimelineRestartFrame {
  frameId: number;
  timePs: number;
  n: number;
  positions: Float64Array;
  velocities: Float64Array;
  /** Bond topology snapshot — [i, j, distance] tuples. */
  bonds: [number, number, number][];
  /** Physics coefficients at recording time. */
  config: TimelinePhysicsConfig;
  interaction: TimelineInteractionState | null;
  boundary: TimelineBoundaryState;
}

/** Full checkpoint — complete physics state including bonds/topology. */
export interface TimelineCheckpoint {
  checkpointId: number;
  timePs: number;
  physics: PhysicsCheckpoint;
  /** Physics coefficients at recording time. */
  config: TimelinePhysicsConfig;
  interaction: TimelineInteractionState | null;
  boundary: TimelineBoundaryState;
}

// ── Configuration ──

export interface TimelineConfig {
  /** Target dense frame recording interval in ms. Default 100 (10 Hz). */
  denseIntervalMs: number;
  /** Target sparse checkpoint interval in ms. Default 1000 (1/sec). */
  checkpointIntervalMs: number;
  /** Max dense review frames retained. Default 600 (~60s at 10 Hz). */
  maxDenseFrames: number;
  /** Max dense restart frames retained. Default 600 (~60s at 10 Hz). */
  maxRestartFrames: number;
  /** Max full checkpoints retained. Default 120 (~2 min at 1/sec). */
  maxCheckpoints: number;
}

const DEFAULT_CONFIG: TimelineConfig = {
  denseIntervalMs: 100,
  checkpointIntervalMs: 1000,
  maxDenseFrames: 600,
  maxRestartFrames: 600,
  maxCheckpoints: 120,
};

// ── Timeline state ──

export type TimelineMode = 'live' | 'review';

export interface TimelineState {
  mode: TimelineMode;
  currentTimePs: number;
  reviewTimePs: number | null;
  /** Available range for scrubber. Frozen at entry during review. */
  rangePs: { start: number; end: number } | null;
  canReturnToLive: boolean;
  canRestart: boolean;
  /** The time restart will actually use (from restart frame or checkpoint). Null if no target. */
  restartTargetPs: number | null;
}

// ── Public interface ──

export interface SimulationTimeline {
  // ── Recording ──
  recordFrame(frame: Omit<TimelineFrame, 'frameId'>): void;
  recordRestartFrame(frame: Omit<TimelineRestartFrame, 'frameId'>): void;
  recordCheckpoint(cp: Omit<TimelineCheckpoint, 'checkpointId'>): void;
  shouldRecordFrame(): boolean;
  shouldRecordCheckpoint(): boolean;

  // ── Review ──
  enterReview(timePs: number): TimelineFrame | null;
  scrubTo(timePs: number): TimelineFrame | null;
  returnToLive(): void;

  // ── Restart ──
  /** Find the best restart source at or before the given time.
   *  Prefers restart frames (positions + velocities) over sparse checkpoints. */
  findRestartSource(timePs: number): { kind: 'restartFrame'; frame: TimelineRestartFrame } | { kind: 'checkpoint'; checkpoint: TimelineCheckpoint } | null;
  /** Find the nearest full checkpoint at or before the given time (for bond topology). */
  findCheckpointAtOrBefore(timePs: number): TimelineCheckpoint | null;
  findFrameAtOrBefore(timePs: number): TimelineFrame | null;
  /** Extract a RestartState from the best available source at or before the given time.
   *  Returns null if no restart source exists. */
  getRestartState(timePs: number): RestartState | null;
  /** Truncate all history after the given time. Called on restart to keep
   *  a single monotonic timeline — new recording continues from the restart point. */
  truncateAfter(timePs: number): void;

  // ── State ──
  getState(): TimelineState;
  getCurrentReviewFrame(): TimelineFrame | null;

  // ── Lifecycle ──
  clear(): void;
  getFrameCount(): number;
  getCheckpointCount(): number;
  getRestartFrameCount(): number;
}

// ── Factory ──

export function createSimulationTimeline(
  config: Partial<TimelineConfig> = {},
): SimulationTimeline {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const _frames: TimelineFrame[] = [];
  const _restartFrames: TimelineRestartFrame[] = [];
  const _checkpoints: TimelineCheckpoint[] = [];
  let _nextFrameId = 0;
  let _nextRestartFrameId = 0;
  let _nextCheckpointId = 0;

  let _lastFrameRecordTs = 0;
  let _lastCheckpointRecordTs = 0;

  let _mode: TimelineMode = 'live';
  let _reviewTimePs: number | null = null;
  let _currentReviewFrame: TimelineFrame | null = null;
  let _frozenRange: { start: number; end: number } | null = null;

  // ── Binary search helper ──

  function _bsearchAtOrBefore<T extends { timePs: number }>(arr: T[], timePs: number): T | null {
    if (arr.length === 0) return null;
    let lo = 0, hi = arr.length - 1;
    let best: T | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].timePs <= timePs) { best = arr[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  function _getLiveRange(): { start: number; end: number } | null {
    if (_frames.length === 0) return null;
    return { start: _frames[0].timePs, end: _frames[_frames.length - 1].timePs };
  }

  function _liveTimePs(): number {
    return _frames.length > 0 ? _frames[_frames.length - 1].timePs : 0;
  }

  // ── Recording ──

  function shouldRecordFrame(): boolean {
    return performance.now() - _lastFrameRecordTs >= cfg.denseIntervalMs;
  }

  function shouldRecordCheckpoint(): boolean {
    return performance.now() - _lastCheckpointRecordTs >= cfg.checkpointIntervalMs;
  }

  function recordFrame(frame: Omit<TimelineFrame, 'frameId'>): void {
    _frames.push({ ...frame, frameId: _nextFrameId++, positions: new Float64Array(frame.positions) });
    _lastFrameRecordTs = performance.now();
    while (_frames.length > cfg.maxDenseFrames) _frames.shift();
  }

  function recordRestartFrame(frame: Omit<TimelineRestartFrame, 'frameId'>): void {
    _restartFrames.push({
      ...frame,
      frameId: _nextRestartFrameId++,
      positions: new Float64Array(frame.positions),
      velocities: new Float64Array(frame.velocities),
      bonds: frame.bonds.map(b => [...b] as [number, number, number]),
    });
    while (_restartFrames.length > cfg.maxRestartFrames) _restartFrames.shift();
  }

  function recordCheckpoint(cp: Omit<TimelineCheckpoint, 'checkpointId'>): void {
    _checkpoints.push({
      ...cp,
      checkpointId: _nextCheckpointId++,
      physics: {
        n: cp.physics.n,
        pos: new Float64Array(cp.physics.pos),
        vel: new Float64Array(cp.physics.vel),
        bonds: cp.physics.bonds.map(b => [...b] as [number, number, number]),
      },
    });
    _lastCheckpointRecordTs = performance.now();
    while (_checkpoints.length > cfg.maxCheckpoints) _checkpoints.shift();
  }

  // ── Review ──

  function enterReview(timePs: number): TimelineFrame | null {
    _mode = 'review';
    _reviewTimePs = timePs;
    _frozenRange = _getLiveRange();
    _currentReviewFrame = _bsearchAtOrBefore(_frames, timePs);
    return _currentReviewFrame;
  }

  function scrubTo(timePs: number): TimelineFrame | null {
    if (_mode !== 'review') return null;
    _reviewTimePs = timePs;
    _currentReviewFrame = _bsearchAtOrBefore(_frames, timePs);
    return _currentReviewFrame;
  }

  function returnToLive(): void {
    _mode = 'live';
    _reviewTimePs = null;
    _currentReviewFrame = null;
    _frozenRange = null;
  }

  // ── Restart ──

  function findRestartSource(timePs: number): { kind: 'restartFrame'; frame: TimelineRestartFrame } | { kind: 'checkpoint'; checkpoint: TimelineCheckpoint } | null {
    // Prefer restart frame (positions + velocities, denser) over sparse checkpoint
    const rf = _bsearchAtOrBefore(_restartFrames, timePs);
    const cp = _bsearchAtOrBefore(_checkpoints, timePs);

    if (rf && cp) {
      // Use whichever is closer to the target time
      return rf.timePs >= cp.timePs
        ? { kind: 'restartFrame', frame: rf }
        : { kind: 'checkpoint', checkpoint: cp };
    }
    if (rf) return { kind: 'restartFrame', frame: rf };
    if (cp) return { kind: 'checkpoint', checkpoint: cp };
    return null;
  }

  function getRestartState(timePs: number): RestartState | null {
    const source = findRestartSource(timePs);
    if (!source) return null;
    if (source.kind === 'restartFrame') {
      const rf = source.frame;
      return {
        timePs: rf.timePs, n: rf.n,
        positions: rf.positions, velocities: rf.velocities, bonds: rf.bonds,
        config: rf.config, interaction: rf.interaction, boundary: rf.boundary,
      };
    }
    const cp = source.checkpoint;
    return {
      timePs: cp.timePs, n: cp.physics.n,
      positions: cp.physics.pos, velocities: cp.physics.vel,
      bonds: cp.physics.bonds as [number, number, number][],
      config: cp.config,
      interaction: cp.interaction, boundary: cp.boundary,
    };
  }

  // ── State ──

  function getState(): TimelineState {
    const range = _mode === 'review' ? _frozenRange : _getLiveRange();
    const currentTimePs = _mode === 'review' ? (_reviewTimePs ?? 0) : _liveTimePs();

    let restartTargetPs: number | null = null;
    if (_mode === 'review' && _reviewTimePs !== null) {
      const src = findRestartSource(_reviewTimePs);
      if (src) {
        restartTargetPs = src.kind === 'restartFrame' ? src.frame.timePs : src.checkpoint.timePs;
      }
    }

    return {
      mode: _mode,
      currentTimePs,
      reviewTimePs: _reviewTimePs,
      rangePs: range,
      canReturnToLive: _mode === 'review',
      canRestart: _mode === 'review' && restartTargetPs !== null,
      restartTargetPs,
    };
  }

  function getCurrentReviewFrame(): TimelineFrame | null {
    return _mode === 'review' ? _currentReviewFrame : null;
  }

  // ── Truncation (for restart — preserves monotonic timeline) ──

  function truncateAfter(timePs: number): void {
    // Remove all entries with timePs > cutoff to maintain a single monotonic history.
    // After restart, new frames will be recorded starting from the restart time.
    while (_frames.length > 0 && _frames[_frames.length - 1].timePs > timePs) _frames.pop();
    while (_restartFrames.length > 0 && _restartFrames[_restartFrames.length - 1].timePs > timePs) _restartFrames.pop();
    while (_checkpoints.length > 0 && _checkpoints[_checkpoints.length - 1].timePs > timePs) _checkpoints.pop();
  }

  // ── Lifecycle ──

  function clear(): void {
    _frames.length = 0;
    _restartFrames.length = 0;
    _checkpoints.length = 0;
    _nextFrameId = 0;
    _nextRestartFrameId = 0;
    _nextCheckpointId = 0;
    _lastFrameRecordTs = 0;
    _lastCheckpointRecordTs = 0;
    _mode = 'live';
    _reviewTimePs = null;
    _currentReviewFrame = null;
    _frozenRange = null;
  }

  return {
    recordFrame,
    recordRestartFrame,
    recordCheckpoint,
    shouldRecordFrame,
    shouldRecordCheckpoint,
    enterReview,
    scrubTo,
    returnToLive,
    findRestartSource,
    findCheckpointAtOrBefore: (timePs) => _bsearchAtOrBefore(_checkpoints, timePs),
    findFrameAtOrBefore: (timePs) => _bsearchAtOrBefore(_frames, timePs),
    getRestartState,
    truncateAfter,
    getState,
    getCurrentReviewFrame,
    clear,
    getFrameCount: () => _frames.length,
    getCheckpointCount: () => _checkpoints.length,
    getRestartFrameCount: () => _restartFrames.length,
  };
}
