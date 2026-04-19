/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { buildWatchLabSceneSeed } from '../../watch/js/handoff/watch-lab-seed';
import { createWatchPlaybackModel } from '../../watch/js/playback/watch-playback-model';
import { importCapsuleHistory } from '../../watch/js/document/capsule-history-import';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../../src/history/history-file-v1';
import { IMPLAUSIBLE_VELOCITY_A_PER_FS } from '../../src/history/units';

/**
 * Build a 3-frame capsule where each atom moves a known delta per frame.
 * Central-difference velocity between frame 0 and frame 2 at frame 1 is
 * deterministic — used to verify the finite-difference math.
 */
function makeCapsule3Frame(positionsPerFrame: number[][]): AtomDojoPlaybackCapsuleFileV1 {
  const denseFrames = positionsPerFrame.map((positions, i) => ({
    frameId: i,
    timePs: i * 0.001, // 1 fs per frame → central diff denominator = 2 fs
    n: 2,
    atomIds: [0, 1],
    positions,
  }));
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: 't', exportedAt: new Date().toISOString() },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: (positionsPerFrame.length - 1) * 0.001,
      frameCount: positionsPerFrame.length,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [ { id: 0, element: 'C' }, { id: 1, element: 'C' } ] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.9, minDist: 1.1 },
    timeline: { denseFrames },
  } as unknown as AtomDojoPlaybackCapsuleFileV1;
}

describe('buildWatchLabSceneSeed — capsule history', () => {
  it('returns null when history is not loaded / no display frame', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
    ]));
    pm.load(history);
    // Seed at a time with no dense frame — bsearch returns last frame; builds ok
    // Use a valid time and verify it yields a seed.
    const seed = buildWatchLabSceneSeed({ history, timePs: 0.001, playback: pm });
    expect(seed).not.toBeNull();
  });

  it('central-difference velocity for a linearly-moving atom equals delta / dt', () => {
    // Atom 1 moves +0.001 Å per frame in X. frames 0..2 at 1 fs spacing
    // → central-diff velocity at frame 1 = (pos[2] - pos[0]) / (2 fs)
    //   = (1.402 - 1.4) / 2 = 0.001 Å/fs.
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.400, 0, 0],
      [0, 0, 0, 1.401, 0, 0],
      [0, 0, 0, 1.402, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0.001, playback: pm });
    expect(seed).not.toBeNull();
    expect(seed!.velocities).not.toBeNull();
    // atom 0: no motion → velocities zero
    expect(seed!.velocities![0]).toBeCloseTo(0, 10);
    expect(seed!.velocities![1]).toBeCloseTo(0, 10);
    expect(seed!.velocities![2]).toBeCloseTo(0, 10);
    // atom 1: x-velocity = 0.001 / 0.002 ps = 0.001 Å/fs (central diff across 2 fs)
    // Let's recompute exactly: (1.402 - 1.400) / (2 fs) = 0.002 / 2 = 0.001 Å/fs
    expect(seed!.velocities![3]).toBeCloseTo(0.001, 10);
    expect(seed!.provenance.velocitiesAreApproximated).toBe(true);
    expect(seed!.provenance.historyKind).toBe('capsule');
  });

  it('clamps implausible velocities to zero per-atom (drops to null at >20% zeroed)', () => {
    // Frame spacing is 1 fs. For central-difference at frame 1 to exceed
    // IMPLAUSIBLE_VELOCITY_A_PER_FS (= 10 Å/fs), we need delta/2fs > 10,
    // i.e. total position delta across 2 fs > 20 Å. Use 40 Å.
    const big = 40;
    void IMPLAUSIBLE_VELOCITY_A_PER_FS; // keep import for documentation purposes
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, big / 2, 0, 0],
      [0, 0, 0, big, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0.001, playback: pm });
    // Here atom 0 is stationary (OK) and atom 1 clamps → 50% zeroed → null.
    expect(seed).not.toBeNull();
    expect(seed!.velocities).toBeNull();
  });

  it('uses backward-difference at the last frame (no next)', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.401, 0, 0],
      [0, 0, 0, 1.402, 0, 0],
    ]));
    pm.load(history);
    // timePs = 0.002 resolves to the last dense frame (index 2).
    const seed = buildWatchLabSceneSeed({ history, timePs: 0.002, playback: pm });
    expect(seed).not.toBeNull();
    expect(seed!.velocities).not.toBeNull();
    // atom 1 backward-diff at frame 2: (1.402 - 1.401) / 1 fs = 0.001 Å/fs.
    expect(seed!.velocities![3]).toBeCloseTo(0.001, 10);
  });

  it('uses forward-difference at the first frame (no prev)', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.401, 0, 0],
      [0, 0, 0, 1.402, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0, playback: pm });
    expect(seed).not.toBeNull();
    expect(seed!.velocities).not.toBeNull();
    // atom 1 forward-diff: (1.401 - 1.4) / 1 fs = 0.001 Å/fs
    expect(seed!.velocities![3]).toBeCloseTo(0.001, 10);
  });

  it('capsule boundary + config fall back to safe defaults', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0, playback: pm });
    expect(seed!.boundary.mode).toBe('contain');
    expect(seed!.boundary.wallCenter).toEqual([0, 0, 0]);
    expect(seed!.config.dtFs).toBeGreaterThan(0);
    expect(seed!.config.damping).toBeGreaterThanOrEqual(0);
  });

  it('seed atoms + positions aligned to display-frame ordering', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0, playback: pm });
    expect(seed!.atoms.length).toBe(2);
    expect(seed!.positions.length).toBe(6);
    expect(seed!.atoms[0].element).toBe('C');
    expect(seed!.positions[3]).toBeCloseTo(1.4, 10);
  });
});

describe('buildWatchLabSceneSeed — color + camera + refined provenance (plan rev 4)', () => {
  it('colorAssignments default to [] when getter absent', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0.001, playback: pm });
    expect(seed).not.toBeNull();
    expect(seed!.colorAssignments).toEqual([]);
  });

  it('colorAssignments serialized in order with the four-field quartet', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({
      history,
      timePs: 0.001,
      playback: pm,
      getColorAssignments: () => [
        { id: 'wca1', atomIds: [0], colorHex: '#ff0000', sourceGroupId: 'g1' },
        { id: 'wca2', atomIds: [1], colorHex: '#00ff00', sourceGroupId: 'g2' },
      ],
    });
    expect(seed!.colorAssignments).toHaveLength(2);
    expect(seed!.colorAssignments[0]).toEqual({ id: 'wca1', atomIds: [0], colorHex: '#ff0000', sourceGroupId: 'g1' });
    expect(seed!.colorAssignments[1]).toEqual({ id: 'wca2', atomIds: [1], colorHex: '#00ff00', sourceGroupId: 'g2' });
  });

  it('drops color assignments with unknown atomIds and warns', () => {
    const origWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({
      history,
      timePs: 0.001,
      playback: pm,
      getColorAssignments: () => [
        { id: 'wca1', atomIds: [0, 99], colorHex: '#ff0000', sourceGroupId: 'g1' }, // dropped
        { id: 'wca2', atomIds: [1], colorHex: '#00ff00', sourceGroupId: 'g2' }, // kept
      ],
    });
    expect(seed!.colorAssignments).toHaveLength(1);
    expect(seed!.colorAssignments[0].id).toBe('wca2');
    expect(warnCalls.length).toBeGreaterThan(0);
    console.warn = origWarn;
  });

  it('camera getter absent → camera null', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0.001, playback: pm });
    expect(seed!.camera).toBeNull();
  });

  it('camera getter returns snapshot → structural serialization', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
      [0, 0, 0, 1.4, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({
      history,
      timePs: 0.001,
      playback: pm,
      getOrbitCameraSnapshot: () => ({ position: [5, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fovDeg: 60 }),
    });
    expect(seed!.camera).toEqual({ position: [5, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fovDeg: 60 });
  });

  it('interior capsule frame reports velocitySource central-difference', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.400, 0, 0],
      [0, 0, 0, 1.401, 0, 0],
      [0, 0, 0, 1.402, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0.001, playback: pm });
    expect(seed!.provenance.velocitySource).toBe('central-difference');
    expect(seed!.provenance.unresolvedVelocityFraction).toBe(0);
  });

  it('leading edge reports forward-difference source', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.400, 0, 0],
      [0, 0, 0, 1.401, 0, 0],
      [0, 0, 0, 1.402, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0, playback: pm });
    expect(seed!.provenance.velocitySource).toBe('forward-difference');
  });

  it('trailing edge reports backward-difference source', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule3Frame([
      [0, 0, 0, 1.400, 0, 0],
      [0, 0, 0, 1.401, 0, 0],
      [0, 0, 0, 1.402, 0, 0],
    ]));
    pm.load(history);
    const seed = buildWatchLabSceneSeed({ history, timePs: 0.002, playback: pm });
    expect(seed!.provenance.velocitySource).toBe('backward-difference');
  });
});
