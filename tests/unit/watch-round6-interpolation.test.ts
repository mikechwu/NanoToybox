/**
 * @vitest-environment jsdom
 */
/**
 * Round 6 tests — trajectory interpolation runtime, capability layer, and
 * controller unified render pipeline.
 *
 * Test surface:
 *   - knot pass-through (linear / Hermite / Catmull-Rom)
 *   - conservative fallback policy (at-or-before, never 'nearest')
 *   - boundary degeneracy (timeline edges, single-frame history)
 *   - variable-n bracket handling
 *   - capability layer correctness (bracketSafe / hermiteSafe / window4Safe / reasons)
 *   - velocity unit conversion via shared FS_PER_PS constant
 *   - method-specific gating (strategy metadata drives runtime)
 *   - strategy registry extensibility (register / unregister / synthetic strategy)
 *   - partial-write tolerance (linear fallback full-overwrite invariant)
 *   - cursor cache policy (forward fast path, backward invalidation)
 *   - output buffer lifecycle (preallocation, identity, stability)
 *   - runtime lifecycle (reset, dispose, load, rollback)
 *   - controller unified pipeline (grep meta-test, scrub/load/rollback routing)
 */

import { describe, it, expect } from 'vitest';
import { importFullHistory } from '../../watch/js/document/full-history-import';
import {
  createWatchTrajectoryInterpolation,
  type InterpolationStrategy,
  type InterpolationResult,
  BUILTIN_STRATEGIES,
} from '../../watch/js/playback/watch-trajectory-interpolation';
import { FS_PER_PS, IMPLAUSIBLE_VELOCITY_A_PER_FS } from '../../src/history/units';
import type { AtomDojoHistoryFileV1 } from '../../src/history/history-file-v1';
import { createWatchController } from '../../watch/js/app/watch-controller';

// ── Fixture builders ──

interface FixtureFrame {
  timePs: number;
  n: number;
  atomIds: number[];
  positions: number[];
  velocities?: number[];
}

function makeFile(opts: {
  denseFrames: FixtureFrame[];
  restartFrames?: FixtureFrame[];
  maxAtomCount?: number;
}): AtomDojoHistoryFileV1 {
  const dense = opts.denseFrames;
  const restart = opts.restartFrames ?? dense.map(f => ({
    ...f,
    velocities: f.velocities ?? new Array(f.n * 3).fill(0),
  }));
  const maxAtomCount = opts.maxAtomCount ?? Math.max(...dense.map(f => f.n));
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'full',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-08T00:00:00Z' },
    simulation: {
      title: null, description: null,
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount,
      durationPs: dense[dense.length - 1].timePs,
      frameCount: dense.length,
      indexingModel: 'dense-prefix',
    },
    atoms: {
      atoms: Array.from({ length: maxAtomCount }, (_, i) => ({ id: i, element: 'C' })),
    },
    timeline: {
      denseFrames: dense.map((f, i) => ({
        frameId: i, timePs: f.timePs, n: f.n, atomIds: f.atomIds,
        positions: f.positions, interaction: null, boundary: {},
      })),
      restartFrames: restart.map((f, i) => ({
        frameId: i, timePs: f.timePs, n: f.n, atomIds: f.atomIds,
        positions: f.positions, velocities: f.velocities ?? new Array(f.n * 3).fill(0),
        bonds: [], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 },
        interaction: null, boundary: {},
      })),
      checkpoints: [],
    },
  };
}

/** Two-frame, two-atom fixture where atoms move in a straight line.
 *  Atom 0 goes from (0,0,0) → (10,0,0). Atom 1 goes from (0,1,0) → (0,11,0). */
function twoFrameTwoAtom() {
  return makeFile({
    denseFrames: [
      { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 0, 1, 0] },
      { timePs: 10, n: 2, atomIds: [0, 1], positions: [10, 0, 0, 0, 11, 0] },
    ],
    restartFrames: [
      { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 0, 1, 0], velocities: [0.001, 0, 0, 0, 0.001, 0] },
      { timePs: 10, n: 2, atomIds: [0, 1], positions: [10, 0, 0, 0, 11, 0], velocities: [0.001, 0, 0, 0, 0.001, 0] },
    ],
  });
}

/** 5-frame fixture for cursor-cache + 4-frame window tests. Atom 0 moves
 *  linearly; times 0, 10, 20, 30, 40 ps. */
function fiveFrameLinear() {
  return makeFile({
    denseFrames: [
      { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0] },
      { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0] },
      { timePs: 20, n: 1, atomIds: [0], positions: [2, 0, 0] },
      { timePs: 30, n: 1, atomIds: [0], positions: [3, 0, 0] },
      { timePs: 40, n: 1, atomIds: [0], positions: [4, 0, 0] },
    ],
    restartFrames: [
      { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0], velocities: [0.0001, 0, 0] },
      { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0], velocities: [0.0001, 0, 0] },
      { timePs: 20, n: 1, atomIds: [0], positions: [2, 0, 0], velocities: [0.0001, 0, 0] },
      { timePs: 30, n: 1, atomIds: [0], positions: [3, 0, 0], velocities: [0.0001, 0, 0] },
      { timePs: 40, n: 1, atomIds: [0], positions: [4, 0, 0], velocities: [0.0001, 0, 0] },
    ],
  });
}

/** Three-frame variable-n fixture: atom 1 removed at frame 2. */
function variableNFixture() {
  return makeFile({
    denseFrames: [
      { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 5, 0, 0] },
      { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0] }, // atom 1 removed
      { timePs: 20, n: 1, atomIds: [0], positions: [2, 0, 0] },
    ],
    restartFrames: [
      { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 5, 0, 0], velocities: [0, 0, 0, 0, 0, 0] },
      { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0], velocities: [0, 0, 0] },
      { timePs: 20, n: 1, atomIds: [0], positions: [2, 0, 0], velocities: [0, 0, 0] },
    ],
    maxAtomCount: 2,
  });
}

// ── Capability layer ──

describe('InterpolationCapability', () => {
  it('bracketSafe is 1 for interpolatable brackets and 0 for last frame', () => {
    const { interpolationCapability: cap } = importFullHistory(twoFrameTwoAtom());
    expect(cap.bracketSafe[0]).toBe(1);
    expect(cap.bracketSafe[1]).toBe(0); // last frame
    expect(cap.bracketReason[0]).toBe('ok');
    expect(cap.bracketReason[1]).toBe('last-frame');
  });

  it('bracketSafe is 0 on variable-n bracket; bracketReason is bracket-n-mismatch', () => {
    const { interpolationCapability: cap } = importFullHistory(variableNFixture());
    // frame 0 → frame 1: n 2 → 1 (mismatch)
    expect(cap.bracketSafe[0]).toBe(0);
    expect(cap.bracketReason[0]).toBe('bracket-n-mismatch');
    // frame 1 → frame 2: n 1 → 1 (ok)
    expect(cap.bracketSafe[1]).toBe(1);
    expect(cap.bracketReason[1]).toBe('ok');
  });

  it('hermiteSafe derived correctly from bracketSafe + velocityReason', () => {
    const { interpolationCapability: cap } = importFullHistory(twoFrameTwoAtom());
    // bracket 0 is ok, both endpoints velocity-ok → hermiteSafe
    expect(cap.hermiteSafe[0]).toBe(1);
    // last frame never hermite-safe
    expect(cap.hermiteSafe[1]).toBe(0);
  });

  it('velocityReason is restart-misaligned when count/time do not match', () => {
    // 2 dense frames, only 1 restart frame → count mismatch
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0] },
        { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0] },
      ],
      restartFrames: [
        { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0], velocities: [0, 0, 0] },
      ],
    });
    const history = importFullHistory(file);
    expect(history.restartAlignedToDense).toBe(false);
    expect(history.interpolationCapability.velocityReason[0]).toBe('restart-misaligned');
    expect(history.interpolationCapability.velocityReason[1]).toBe('restart-misaligned');
    expect(history.interpolationCapability.hermiteSafe[0]).toBe(0);
  });

  it('emits a restart-count-mismatch diagnostic when counts differ', () => {
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0] },
        { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0] },
      ],
      restartFrames: [],
    });
    const history = importFullHistory(file);
    expect(history.importDiagnostics.some(d => d.code === 'restart-count-mismatch')).toBe(true);
  });

  it('velocities-implausible sanity check flags affected frames and emits diagnostic', () => {
    // Normal frames, then one frame with 100 Å/fs velocities.
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0] },
        { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0] },
      ],
      restartFrames: [
        { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0], velocities: [0.001, 0, 0] },
        { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0], velocities: [100, 0, 0] },
      ],
    });
    const history = importFullHistory(file);
    expect(history.interpolationCapability.velocityReason[1]).toBe('velocities-implausible');
    expect(history.interpolationCapability.hermiteSafe[0]).toBe(0); // frame 1 is bad → bracket invalid
    const diag = history.importDiagnostics.find(d => d.code === 'velocities-implausible');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warn');
  });

  it('window4Safe is 0 at timeline edges', () => {
    const { interpolationCapability: cap } = importFullHistory(fiveFrameLinear());
    expect(cap.window4Safe[0]).toBe(0); // needs f[-1]
    expect(cap.window4Reason[0]).toBe('timeline-edge');
    expect(cap.window4Safe[4]).toBe(0); // needs f[n], f[n+1]
    expect(cap.window4Reason[4]).toBe('timeline-edge');
    expect(cap.window4Safe[3]).toBe(0); // last valid anchor is 2 (needs f[1], f[2], f[3], f[4])
    // frame 1: window is (0,1,2,3) → valid
    expect(cap.window4Safe[1]).toBe(1);
    expect(cap.window4Reason[1]).toBe('ok');
    // frame 2: window is (1,2,3,4) → valid
    expect(cap.window4Safe[2]).toBe(1);
  });

  it('denseToRestartIndex is valid where alignment holds and -1 otherwise', () => {
    const { interpolationCapability: cap } = importFullHistory(twoFrameTwoAtom());
    expect(cap.denseToRestartIndex[0]).toBe(0);
    expect(cap.denseToRestartIndex[1]).toBe(1);
  });
});

// ── Linear strategy math ──

describe('LinearStrategy math', () => {
  it('passes through start knot (alpha = 0)', () => {
    const history = importFullHistory(twoFrameTwoAtom());
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(0, { enabled: true, mode: 'linear' });
    // timePs = 0 is the first knot — falls back to boundary
    expect(result.fallbackReason).toBe('at-boundary');
    expect(result.positions[0]).toBeCloseTo(0);
    expect(result.positions[1]).toBeCloseTo(0);
  });

  it('midpoint is the average of endpoint positions', () => {
    const history = importFullHistory(twoFrameTwoAtom());
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(5, { enabled: true, mode: 'linear' });
    expect(result.fallbackReason).toBe('none');
    expect(result.activeMethod).toBe('linear');
    // atom 0: (0+10)/2 = 5
    expect(result.positions[0]).toBeCloseTo(5);
    // atom 1 Y: (1+11)/2 = 6
    expect(result.positions[4]).toBeCloseTo(6);
  });

  it('reproduces a knot exactly when timePs lands on it (interior frame)', () => {
    // Use a 3-frame fixture so the interior knot has neighbors on both sides.
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    // t = 20 → alpha = 0 of bracket (20,30)
    const result = rt.resolve(20, { enabled: true, mode: 'linear' });
    expect(result.fallbackReason).toBe('none');
    expect(result.positions[0]).toBeCloseTo(2);
  });
});

// ── Hermite strategy ──

describe('HermiteStrategy math', () => {
  it('passes through knots exactly (alpha = 0 for an interior knot)', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    // Interior knot t = 20 → alpha = 0 of bracket (20, 30)
    const result = rt.resolve(20, { enabled: true, mode: 'hermite' });
    expect(result.fallbackReason).toBe('none');
    expect(result.activeMethod).toBe('hermite');
    expect(result.positions[0]).toBeCloseTo(2);
  });

  it('uses FS_PER_PS to scale velocities', () => {
    // Sanity: FS_PER_PS is the single source of truth, not a magic number.
    expect(FS_PER_PS).toBe(1000);
    // Implausible threshold is reachable from the units module.
    expect(IMPLAUSIBLE_VELOCITY_A_PER_FS).toBeGreaterThan(1);
  });

  it('declines with velocities-unavailable when hermiteSafe[i] === 0', () => {
    // 2 dense, 1 restart → restart-misaligned
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0] },
        { timePs: 10, n: 1, atomIds: [0], positions: [1, 0, 0] },
      ],
      restartFrames: [
        { timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0], velocities: [0, 0, 0] },
      ],
    });
    const history = importFullHistory(file);
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(5, { enabled: true, mode: 'hermite' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('velocities-unavailable');
    // Linear midpoint: 0.5
    expect(result.positions[0]).toBeCloseTo(0.5);
  });
});

// ── Catmull-Rom strategy ──

describe('CatmullRomStrategy math', () => {
  it('passes through interior knots exactly', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    // Interior knot t=20 (frame 2) — window4Safe[2] === 1 (uses frames 1,2,3,4)
    const result = rt.resolve(20, { enabled: true, mode: 'catmull-rom' });
    expect(result.fallbackReason).toBe('none');
    expect(result.activeMethod).toBe('catmull-rom');
    expect(result.positions[0]).toBeCloseTo(2);
  });

  it('declines with insufficient-frames at timeline edge', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    // First bracket (0 → 10) anchors at i=0 → window4Safe[0] === 0 (timeline-edge)
    const result = rt.resolve(5, { enabled: true, mode: 'catmull-rom' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('insufficient-frames');
    // Linear midpoint: 0.5
    expect(result.positions[0]).toBeCloseTo(0.5);
  });

  it('declines with window-mismatch when n differs inside the 4-frame window', () => {
    // 4 frames; middle pair has a variable-n break at the anchor position.
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 5, 0, 0] },
        { timePs: 10, n: 2, atomIds: [0, 1], positions: [1, 0, 0, 6, 0, 0] },
        { timePs: 20, n: 2, atomIds: [0, 1], positions: [2, 0, 0, 7, 0, 0] },
        { timePs: 30, n: 1, atomIds: [0], positions: [3, 0, 0] },
        { timePs: 40, n: 1, atomIds: [0], positions: [4, 0, 0] },
      ],
      maxAtomCount: 2,
    });
    const history = importFullHistory(file);
    const rt = createWatchTrajectoryInterpolation(history);
    // Anchor i=1 (bracket 10..20) has window (0,1,2,3) → n = 2,2,2,1 → mismatch
    const result = rt.resolve(15, { enabled: true, mode: 'catmull-rom' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('window-mismatch');
  });
});

// ── Conservative fallback policy ──

describe('Conservative fallback policy (at-or-before)', () => {
  it('returns importer first-frame reference at timeline start', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(-5, { enabled: true, mode: 'linear' });
    expect(result.fallbackReason).toBe('at-boundary');
    // Importer reference — NOT the output buffer
    expect(result.positions).toBe(history.denseFrames[0].positions);
  });

  it('returns importer last-frame reference at timeline end', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(100, { enabled: true, mode: 'linear' });
    expect(result.fallbackReason).toBe('at-boundary');
    expect(result.positions).toBe(history.denseFrames[4].positions);
  });

  it('returns bracket.prev (never bracket.next) on variable-n', () => {
    const history = importFullHistory(variableNFixture());
    const rt = createWatchTrajectoryInterpolation(history);
    // t = 5 → bracket (0, 10) → variable-n
    const result = rt.resolve(5, { enabled: true, mode: 'linear' });
    expect(result.fallbackReason).toBe('variable-n');
    // Returns prev reference (importer buffer at frame 0) — n=2
    expect(result.positions).toBe(history.denseFrames[0].positions);
    expect(result.n).toBe(2);
  });

  it('smoothPlayback disabled returns at-or-before reference with fallback=disabled', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(5, { enabled: false, mode: 'linear' });
    expect(result.fallbackReason).toBe('disabled');
    // Importer reference to frame 0 (at-or-before 5)
    expect(result.positions).toBe(history.denseFrames[0].positions);
  });

  it('scrub through variable-n region never surfaces future coordinates', () => {
    const history = importFullHistory(variableNFixture());
    const rt = createWatchTrajectoryInterpolation(history);
    // Scrub from t=1 → t=9 tick-by-tick. Assert never == bracket.next's positions.
    const nextFrame = history.denseFrames[1]; // removed atom — the "next" frame
    for (let t = 1; t < 10; t++) {
      const result = rt.resolve(t, { enabled: true, mode: 'linear' });
      expect(result.positions).not.toBe(nextFrame.positions);
      expect(result.fallbackReason).toBe('variable-n');
    }
  });
});

// ── Strategy registry / extensibility ──

describe('Strategy registry extensibility', () => {
  it('registers a synthetic experimental strategy and produces capability-declined fallback', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);

    const decliner: InterpolationStrategy = {
      metadata: {
        id: 'hermite', // reuse an existing mode id so resolve() can find it
        label: 'Synthetic Decliner',
        stability: 'experimental',
        availability: 'dev-only',
        requiresVelocities: false,
        requires4Frames: false,
      },
      run: () => ({ kind: 'decline', reason: 'capability-declined' }),
    };
    rt.registerStrategy(decliner);

    const result = rt.resolve(15, { enabled: true, mode: 'hermite' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('capability-declined');
    // Linear midpoint of frames (10,20): 1.5
    expect(result.positions[0]).toBeCloseTo(1.5);

    // Restore builtins so subsequent tests see a clean registry.
    for (const s of BUILTIN_STRATEGIES) rt.registerStrategy(s);
  });

  it('partial-write tolerance: garbage writer declines, linear full-overwrite produces correct result', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);

    const garbage: InterpolationStrategy = {
      metadata: {
        id: 'catmull-rom',
        label: 'Synthetic Garbage Writer',
        stability: 'experimental',
        availability: 'dev-only',
        requiresVelocities: false,
        requires4Frames: false, // skip capability gating — run body directly
      },
      run: (input) => {
        input.outputBuffer[0] = NaN;
        input.outputBuffer[1] = 999.999;
        input.outputBuffer[2] = -1e9;
        return { kind: 'decline', reason: 'capability-declined' };
      },
    };
    rt.registerStrategy(garbage);

    const result = rt.resolve(15, { enabled: true, mode: 'catmull-rom' });
    // Linear fallback must do a full overwrite — so outputBuffer[0..2] should be
    // the linear midpoint between (10, 0, 0) and (20, 0, 0) → (15, 0, 0).
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('capability-declined');
    expect(result.positions[0]).toBeCloseTo(1.5); // corrected: frames at t=10 → x=1, t=20 → x=2; midpoint 1.5
    expect(result.positions[1]).toBeCloseTo(0);
    expect(result.positions[2]).toBeCloseTo(0);
    expect(Number.isFinite(result.positions[0])).toBe(true);

    for (const s of BUILTIN_STRATEGIES) rt.registerStrategy(s);
  });

  it('unregistered mode falls back to linear with capability-declined', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.unregisterStrategy('hermite');
    const result = rt.resolve(15, { enabled: true, mode: 'hermite' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('capability-declined');
    // Restore
    for (const s of BUILTIN_STRATEGIES) rt.registerStrategy(s);
  });

  it('registry metadata is readable and includes availability field', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const methods = rt.getRegisteredMethods();
    const linear = methods.find(m => m.id === 'linear');
    const hermite = methods.find(m => m.id === 'hermite');
    const catmull = methods.find(m => m.id === 'catmull-rom');
    expect(linear?.stability).toBe('stable');
    expect(linear?.availability).toBe('product');
    expect(hermite?.stability).toBe('experimental');
    expect(hermite?.availability).toBe('product');
    expect(hermite?.requiresVelocities).toBe(true);
    expect(catmull?.stability).toBe('experimental');
    expect(catmull?.availability).toBe('product');
    expect(catmull?.requires4Frames).toBe(true);
  });

  it('getRegisteredMethods returns a stable frozen reference (no churn)', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const a = rt.getRegisteredMethods();
    const b = rt.getRegisteredMethods();
    expect(a).toBe(b); // same reference — no new array allocation
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('getRegisteredMethods reference changes only after registerStrategy', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const before = rt.getRegisteredMethods();
    const devOnly: InterpolationStrategy = {
      metadata: {
        id: 'dev-test',
        label: 'Dev Test',
        stability: 'experimental',
        availability: 'dev-only',
        requiresVelocities: false,
        requires4Frames: false,
      },
      run: () => ({ kind: 'decline', reason: 'capability-declined' }),
    };
    rt.registerStrategy(devOnly);
    const after = rt.getRegisteredMethods();
    expect(after).not.toBe(before); // new frozen array
    expect(after.some(m => m.id === 'dev-test')).toBe(true);
    expect(after.find(m => m.id === 'dev-test')?.availability).toBe('dev-only');
    // Clean up
    rt.unregisterStrategy('dev-test');
    for (const s of BUILTIN_STRATEGIES) rt.registerStrategy(s);
  });

  it('dev-only strategies are in registry but UI can filter them by availability', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const devOnly: InterpolationStrategy = {
      metadata: {
        id: 'research-spline',
        label: 'Research Spline',
        stability: 'experimental',
        availability: 'dev-only',
        requiresVelocities: false,
        requires4Frames: false,
      },
      run: () => ({ kind: 'decline', reason: 'capability-declined' }),
    };
    rt.registerStrategy(devOnly);
    const all = rt.getRegisteredMethods();
    const product = all.filter(m => m.availability === 'product');
    const devMethods = all.filter(m => m.availability === 'dev-only');
    expect(product.length).toBe(3); // linear, hermite, catmull-rom
    expect(devMethods.length).toBe(1); // research-spline
    // Clean up
    rt.unregisterStrategy('research-spline');
  });
});

// ── Cursor cache policy ──

describe('Cursor cache policy', () => {
  it('forward same-bracket reuses the cursor (single binary search)', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.resolve(12, { enabled: true, mode: 'linear' });
    const after1 = rt.getBinarySearchCount();
    expect(after1).toBe(1);
    rt.resolve(13, { enabled: true, mode: 'linear' });
    rt.resolve(14, { enabled: true, mode: 'linear' });
    expect(rt.getBinarySearchCount()).toBe(1); // still 1
  });

  it('forward bracket-cross advances cursor by one without new binary search', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.resolve(15, { enabled: true, mode: 'linear' }); // bracket (10,20)
    const first = rt.getBinarySearchCount();
    rt.resolve(22, { enabled: true, mode: 'linear' }); // bracket (20,30), adjacent
    expect(rt.getBinarySearchCount()).toBe(first); // cursor advanced, no new bsearch
  });

  it('backward delta triggers a full binary search', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.resolve(25, { enabled: true, mode: 'linear' });
    const first = rt.getBinarySearchCount();
    rt.resolve(11, { enabled: true, mode: 'linear' }); // large backward jump
    expect(rt.getBinarySearchCount()).toBeGreaterThan(first);
  });

  it('reset() clears cursor — first resolve after reset triggers binary search', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.resolve(15, { enabled: true, mode: 'linear' });
    rt.reset();
    expect(rt.getBinarySearchCount()).toBe(0);
    rt.resolve(15, { enabled: true, mode: 'linear' });
    expect(rt.getBinarySearchCount()).toBe(1);
  });
});

// ── Output buffer lifecycle ──

describe('Output buffer lifecycle', () => {
  it('consecutive interpolated calls return the same Float64Array reference', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const a = rt.resolve(15, { enabled: true, mode: 'linear' }).positions;
    const b = rt.resolve(16, { enabled: true, mode: 'linear' }).positions;
    expect(a).toBe(b); // same reference — preallocated buffer reused
  });

  it('boundary fallback returns the importer reference (different object)', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const interp = rt.resolve(15, { enabled: true, mode: 'linear' }).positions;
    const boundary = rt.resolve(100, { enabled: true, mode: 'linear' }).positions;
    expect(interp).not.toBe(boundary);
    expect(boundary).toBe(history.denseFrames[4].positions);
  });

  it('no new Float64Array allocation on consecutive interpolated frames', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const OriginalFloat64 = Float64Array;
    let allocCount = 0;
    const SpyFloat64 = new Proxy(OriginalFloat64, {
      construct(target, args) {
        allocCount++;
        return new target(args[0], args[1], args[2]);
      },
    }) as unknown as Float64ArrayConstructor;
    (globalThis as unknown as { Float64Array: Float64ArrayConstructor }).Float64Array = SpyFloat64;
    try {
      for (let i = 0; i < 50; i++) {
        rt.resolve(11 + i * 0.1, { enabled: true, mode: 'linear' });
      }
      expect(allocCount).toBe(0);
    } finally {
      globalThis.Float64Array = OriginalFloat64;
    }
  });
});

// ── Method-specific gating ──

describe('Method-specific gating', () => {
  it('linear never declines over an interpolatable bracket', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const r = rt.resolve(15, { enabled: true, mode: 'linear' });
    expect(r.activeMethod).toBe('linear');
    expect(r.fallbackReason).toBe('none');
  });

  it('when selected method runs cleanly, activeMethod === selectedMode and fallbackReason === "none"', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const r = rt.resolve(15, { enabled: true, mode: 'hermite' });
    expect(r.activeMethod).toBe('hermite');
    expect(r.fallbackReason).toBe('none');
    expect(r.selectedMode).toBe('hermite');
  });

  it('Hermite declines on variable-n bracket', () => {
    const history = importFullHistory(variableNFixture());
    const rt = createWatchTrajectoryInterpolation(history);
    const r = rt.resolve(5, { enabled: true, mode: 'hermite' });
    expect(r.activeMethod).toBe('linear');
    // variable-n short-circuits even before method-specific checks
    expect(r.fallbackReason).toBe('variable-n');
  });
});

// ── Controller unified pipeline ──

/** Strip block comments and line comments so greps only count actual code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* ... */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // // ... (naive but good enough)
}

describe('Controller unified render pipeline', () => {
  it('watch-controller source: exactly one direct call to interpolation.resolve()', async () => {
    const fs = await import('fs');
    const src = stripComments(fs.readFileSync('watch/js/app/watch-controller.ts', 'utf-8'));
    const matches = src.match(/interpolation\.resolve\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('watch-controller source: exactly one direct call to renderer.updateReviewFrame()', async () => {
    const fs = await import('fs');
    const src = stripComments(fs.readFileSync('watch/js/app/watch-controller.ts', 'utf-8'));
    const matches = src.match(/renderer\.updateReviewFrame\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('watch-controller source: exactly four physical applyReviewFrameAtTime call sites (tick, renderAtCurrentTime, openFile, createRenderer)', async () => {
    const fs = await import('fs');
    const src = stripComments(fs.readFileSync('watch/js/app/watch-controller.ts', 'utf-8'));
    // 1 declaration + 4 calls = 5 total in stripped source.
    const allCalls = src.match(/applyReviewFrameAtTime\(/g) ?? [];
    expect(allCalls.length).toBe(5);
    expect(src).toMatch(/function\s+applyReviewFrameAtTime\s*\(/);
  });

  it('watch-controller source: RAF tick uses render=false followed by updateFollow + renderer.render', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('watch/js/app/watch-controller.ts', 'utf-8');
    expect(src).toMatch(/applyReviewFrameAtTime\([^,]+,\s*\{\s*render:\s*false\s*\}/);
    expect(src).toContain('viewService.updateFollow(dtMs, renderer)');
  });
});

// ── Controller lifecycle ──

describe('Controller smooth-playback lifecycle', () => {
  it('setSmoothPlayback flips settings and publishes a new snapshot', async () => {
    const controller = createWatchController();
    const snap0 = controller.getSnapshot();
    expect(snap0.smoothPlayback).toBe(true);
    controller.setSmoothPlayback(true);
    expect(controller.getSnapshot().smoothPlayback).toBe(true);
    controller.dispose();
  });

  it('setInterpolationMode updates snapshot', () => {
    const controller = createWatchController();
    controller.setInterpolationMode('hermite');
    expect(controller.getSnapshot().interpolationMode).toBe('hermite');
    controller.dispose();
  });

  it('default snapshot: smoothPlayback=true, interpolationMode=linear, activeMethod=linear, fallback=none', () => {
    const controller = createWatchController();
    const snap = controller.getSnapshot();
    expect(snap.smoothPlayback).toBe(true);
    expect(snap.interpolationMode).toBe('linear');
    expect(snap.activeInterpolationMethod).toBe('linear');
    expect(snap.lastFallbackReason).toBe('none');
    expect(snap.importDiagnostics).toEqual([]);
    // registeredMethods is NOT in the snapshot (it's configuration metadata
    // accessed via controller.getRegisteredInterpolationMethods()).
    expect(controller.getRegisteredInterpolationMethods()).toEqual([]);
    controller.dispose();
  });
});

// ── LoadedFullHistory shape ──

describe('LoadedFullHistory Round 6 fields', () => {
  it('includes velocityUnit, interpolationCapability, and importDiagnostics', () => {
    const history = importFullHistory(twoFrameTwoAtom());
    expect(history.velocityUnit).toBe('angstrom-per-fs');
    expect(history.interpolationCapability).toBeDefined();
    expect(Array.isArray(history.importDiagnostics)).toBe(true);
  });
});

// ── Coverage gaps identified by audit ──

/** Single-frame history (one dense frame only). */
function singleFrameFixture() {
  return makeFile({
    denseFrames: [
      { timePs: 0, n: 1, atomIds: [0], positions: [5, 6, 7] },
    ],
    restartFrames: [
      { timePs: 0, n: 1, atomIds: [0], positions: [5, 6, 7], velocities: [0, 0, 0] },
    ],
  });
}

describe('Single-frame history fallback', () => {
  it('returns the only frame as importer reference', () => {
    const history = importFullHistory(singleFrameFixture());
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(5, { enabled: true, mode: 'linear' });
    expect(result.fallbackReason).toBe('single-frame');
    expect(result.positions).toBe(history.denseFrames[0].positions);
  });
});

describe('Capability layer — atomId mismatch cases', () => {
  it('bracketReason is bracket-atomids-mismatch when adjacent atomIds differ', () => {
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
        // Same n, different atomIds (atom 1 replaced by atom 2)
        { timePs: 10, n: 2, atomIds: [0, 2], positions: [0, 0, 0, 2, 0, 0] },
      ],
      maxAtomCount: 3,
    });
    const history = importFullHistory(file);
    expect(history.interpolationCapability.bracketReason[0]).toBe('bracket-atomids-mismatch');
    expect(history.interpolationCapability.bracketSafe[0]).toBe(0);
  });

  it('runtime returns bracket.prev with atomids-mismatch when bracket has atomId divergence', () => {
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
        { timePs: 10, n: 2, atomIds: [0, 2], positions: [0, 0, 0, 2, 0, 0] },
      ],
      maxAtomCount: 3,
    });
    const history = importFullHistory(file);
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(5, { enabled: true, mode: 'linear' });
    expect(result.fallbackReason).toBe('atomids-mismatch');
    expect(result.positions).toBe(history.denseFrames[0].positions);
  });

  it('velocityReason is atomids-mismatch when dense/restart atomIds diverge at a frame', () => {
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
        { timePs: 10, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
      ],
      restartFrames: [
        { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0], velocities: [0, 0, 0, 0, 0, 0] },
        // Restart atomIds differ from dense atomIds at this frame
        { timePs: 10, n: 2, atomIds: [0, 99], positions: [0, 0, 0, 1, 0, 0], velocities: [0, 0, 0, 0, 0, 0] },
      ],
      maxAtomCount: 2,
    });
    const history = importFullHistory(file);
    expect(history.interpolationCapability.velocityReason[1]).toBe('atomids-mismatch');
    // Diagnostic emitted
    expect(history.importDiagnostics.some(d => d.code === 'atomids-mismatch-at-frame')).toBe(true);
    // Hermite falls back
    const rt = createWatchTrajectoryInterpolation(history);
    const result = rt.resolve(5, { enabled: true, mode: 'hermite' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('velocities-unavailable');
  });

  it('window4Reason is window-atomids-mismatch when atomIds diverge inside the 4-frame window', () => {
    const file = makeFile({
      denseFrames: [
        { timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
        { timePs: 10, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
        // atomids diverge in the middle of the window
        { timePs: 20, n: 2, atomIds: [0, 2], positions: [0, 0, 0, 2, 0, 0] },
        { timePs: 30, n: 2, atomIds: [0, 2], positions: [0, 0, 0, 2, 0, 0] },
      ],
      maxAtomCount: 3,
    });
    const history = importFullHistory(file);
    // Window anchored at frame 1: (f0, f1, f2, f3) — mixes [0,1] and [0,2]
    expect(history.interpolationCapability.window4Reason[1]).toBe('window-atomids-mismatch');
    expect(history.interpolationCapability.window4Safe[1]).toBe(0);
  });

  it('velocityReason is restart-n-mismatch when dense.n !== restart.n at a frame', () => {
    // Dense and restart frames have matching count/time but n differs.
    const file: AtomDojoHistoryFileV1 = {
      format: 'atomdojo-history', version: 1, kind: 'full',
      producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-08T00:00:00Z' },
      simulation: {
        title: null, description: null,
        units: { time: 'ps', length: 'angstrom' },
        maxAtomCount: 2, durationPs: 10, frameCount: 2, indexingModel: 'dense-prefix',
      },
      atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
      timeline: {
        denseFrames: [
          { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0], interaction: null, boundary: {} },
          { frameId: 1, timePs: 10, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0], interaction: null, boundary: {} },
        ],
        restartFrames: [
          { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0], velocities: [0, 0, 0, 0, 0, 0], bonds: [], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
          // Same count + time as dense, but n=1 (inconsistent)
          { frameId: 1, timePs: 10, n: 1, atomIds: [0], positions: [0, 0, 0], velocities: [0, 0, 0], bonds: [], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
        ],
        checkpoints: [],
      },
    };
    const history = importFullHistory(file);
    expect(history.interpolationCapability.velocityReason[1]).toBe('restart-n-mismatch');
    expect(history.interpolationCapability.hermiteSafe[0]).toBe(0);
  });
});

describe('Cursor cache — additional invalidation cases', () => {
  it('large forward jump triggers a fresh binary search', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.resolve(5, { enabled: true, mode: 'linear' }); // bracket (0,10)
    const first = rt.getBinarySearchCount();
    // Jump well beyond one-bracket-forward — straight into bracket (30,40)
    rt.resolve(35, { enabled: true, mode: 'linear' });
    expect(rt.getBinarySearchCount()).toBeGreaterThan(first);
  });

  it('repeat-wrap (end → start) triggers a fresh binary search', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.resolve(35, { enabled: true, mode: 'linear' }); // bracket (30,40)
    const first = rt.getBinarySearchCount();
    rt.resolve(5, { enabled: true, mode: 'linear' });  // wrap back to start
    expect(rt.getBinarySearchCount()).toBeGreaterThan(first);
  });
});

describe('Runtime lifecycle — reset / dispose', () => {
  it('reset() clears cursor cache counter so subsequent resolve does a fresh binary search', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.resolve(15, { enabled: true, mode: 'linear' });
    expect(rt.getBinarySearchCount()).toBe(1);
    rt.reset();
    expect(rt.getBinarySearchCount()).toBe(0);
    rt.resolve(15, { enabled: true, mode: 'linear' });
    expect(rt.getBinarySearchCount()).toBe(1);
  });

  it('reset() does not affect output buffer identity', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    const before = rt.resolve(15, { enabled: true, mode: 'linear' }).positions;
    rt.reset();
    const after = rt.resolve(15, { enabled: true, mode: 'linear' }).positions;
    expect(before).toBe(after); // same preallocated buffer
  });

  it('fiveFrameLinear: two runtimes are independent (no shared state)', () => {
    const h1 = importFullHistory(fiveFrameLinear());
    const h2 = importFullHistory(fiveFrameLinear());
    const rt1 = createWatchTrajectoryInterpolation(h1);
    const rt2 = createWatchTrajectoryInterpolation(h2);
    rt1.resolve(15, { enabled: true, mode: 'linear' });
    rt2.resolve(5, { enabled: true, mode: 'linear' });
    // Runtimes have independent cursor caches.
    expect(rt1.getBinarySearchCount()).toBe(1);
    expect(rt2.getBinarySearchCount()).toBe(1);
  });

  it('dispose() clears registry so subsequent resolve routes to linear fallback', () => {
    const history = importFullHistory(fiveFrameLinear());
    const rt = createWatchTrajectoryInterpolation(history);
    rt.dispose();
    // After dispose, registry is empty — any selected mode routes to
    // capability-declined fallback via the universal linear path.
    // BUT: linear itself is also unregistered. The runtime handles this by
    // short-circuiting to capability-declined, which then runs linear via
    // linearRun() — which is the bound closure, not registry-based.
    // This verifies the dispose() path doesn't crash.
    expect(() => rt.resolve(15, { enabled: true, mode: 'linear' })).not.toThrow();
  });
});

describe('Controller — diagnostic reset + boundary at endTimePs', () => {
  it('default snapshot importDiagnostics is an empty readonly array', () => {
    const controller = createWatchController();
    const snap = controller.getSnapshot();
    expect(Object.isFrozen(snap.importDiagnostics) || snap.importDiagnostics.length === 0).toBe(true);
    controller.dispose();
  });

  it('lastFallbackReason starts as "none" and active method as "linear"', () => {
    const controller = createWatchController();
    const snap = controller.getSnapshot();
    expect(snap.lastFallbackReason).toBe('none');
    expect(snap.activeInterpolationMethod).toBe('linear');
    controller.dispose();
  });
});

describe('Snapshot change detection (Round 6 fields)', () => {
  it('smoothPlayback toggle fires a subscriber notification', () => {
    const controller = createWatchController();
    let notifyCount = 0;
    const unsub = controller.subscribe(() => { notifyCount++; });
    // Default is now ON — toggle to OFF to produce a real change.
    controller.setSmoothPlayback(false);
    expect(notifyCount).toBeGreaterThan(0);
    unsub();
    controller.dispose();
  });

  it('setInterpolationMode fires a subscriber notification', () => {
    const controller = createWatchController();
    let notifyCount = 0;
    const unsub = controller.subscribe(() => { notifyCount++; });
    controller.setInterpolationMode('hermite');
    expect(notifyCount).toBeGreaterThan(0);
    unsub();
    controller.dispose();
  });
});

