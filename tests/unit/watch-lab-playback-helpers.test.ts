/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { createWatchPlaybackModel } from '../../watch/js/watch-playback-model';
import { canBuildWatchLabSceneSeed } from '../../watch/js/watch-lab-seed';
import { importCapsuleHistory } from '../../watch/js/capsule-history-import';
import * as topologyModule from '../../src/topology/build-bond-topology';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../../src/history/history-file-v1';

function makeCapsule(numFrames: number): AtomDojoPlaybackCapsuleFileV1 {
  const denseFrames = [];
  for (let i = 0; i < numFrames; i++) {
    denseFrames.push({
      frameId: i,
      timePs: i * 0.1,
      n: 2,
      atomIds: [0, 1],
      positions: [0, 0, 0, 1 + i * 0.01, 0, 0],
    });
  }
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: 't', exportedAt: new Date().toISOString() },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: numFrames <= 1 ? 0 : (numFrames - 1) * 0.1,
      frameCount: numFrames,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.9, minDist: 1.1 },
    timeline: { denseFrames },
  } as unknown as AtomDojoPlaybackCapsuleFileV1;
}

describe('WatchPlaybackModel PR-2 cheap helpers', () => {
  it('getDisplayFrameIndexAtTime returns valid index', () => {
    const pm = createWatchPlaybackModel();
    pm.load(importCapsuleHistory(makeCapsule(5)));
    expect(pm.getDisplayFrameIndexAtTime(0)).toBe(0);
    expect(pm.getDisplayFrameIndexAtTime(0.21)).toBe(2);
    expect(pm.getDisplayFrameIndexAtTime(10)).toBe(4); // clamped to last
  });

  it('canApproximateVelocityAtDisplayFrame: capsule with >= 2 frames returns true', () => {
    const pm = createWatchPlaybackModel();
    pm.load(importCapsuleHistory(makeCapsule(3)));
    expect(pm.canApproximateVelocityAtDisplayFrame(0)).toBe(true);
    expect(pm.canApproximateVelocityAtDisplayFrame(2)).toBe(true);
    expect(pm.canApproximateVelocityAtDisplayFrame(10)).toBe(false);
  });

  it('canApproximateVelocityAtDisplayFrame: singleton capsule returns false', () => {
    const pm = createWatchPlaybackModel();
    pm.load(importCapsuleHistory(makeCapsule(1)));
    expect(pm.canApproximateVelocityAtDisplayFrame(0)).toBe(false);
  });

  it('getNeighborDenseFrameIndices returns nulls at edges', () => {
    const pm = createWatchPlaybackModel();
    pm.load(importCapsuleHistory(makeCapsule(3)));
    expect(pm.getNeighborDenseFrameIndices(0)).toEqual({ prev: null, next: 1 });
    expect(pm.getNeighborDenseFrameIndices(1)).toEqual({ prev: 0, next: 2 });
    expect(pm.getNeighborDenseFrameIndices(2)).toEqual({ prev: 1, next: null });
  });

  it('canBuildWatchLabSceneSeed is true for capsule with >= 2 frames', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule(3));
    pm.load(history);
    expect(canBuildWatchLabSceneSeed({ history, timePs: 0.1, playback: pm })).toBe(true);
  });

  it('canBuildWatchLabSceneSeed is false for singleton capsule', () => {
    const pm = createWatchPlaybackModel();
    const history = importCapsuleHistory(makeCapsule(1));
    pm.load(history);
    expect(canBuildWatchLabSceneSeed({ history, timePs: 0, playback: pm })).toBe(false);
  });

  it('getTopologyFrameIdAtTime does NOT trigger bond reconstruction (capsule)', () => {
    // Spy on the heavy bond-reconstruction builder — it must NOT be called
    // from the cheap predicate path (rev 6 follow-up P1.1).
    const spy = vi.spyOn(topologyModule, 'buildBondTopologyFromPositions');
    try {
      const pm = createWatchPlaybackModel();
      const history = importCapsuleHistory(makeCapsule(5));
      pm.load(history);
      // Reach for the topology frame id without the predicate allocating bonds.
      expect(pm.getTopologyFrameIdAtTime(0.21)).not.toBeNull();
      expect(canBuildWatchLabSceneSeed({ history, timePs: 0.21, playback: pm })).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
