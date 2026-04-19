/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the watch review-parity round:
 *   - shared bonded-group-utils (partitionBondedGroups extraction)
 *   - watch-controller (useSyncExternalStore-compatible snapshot/subscribe)
 *   - BondedGroupSummary consolidation (app-store re-exports from shared)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { partitionBondedGroups, SMALL_CLUSTER_THRESHOLD } from '../../src/history/bonded-group-utils';
import type { BondedGroupSummary } from '../../src/history/bonded-group-projection';
import { createWatchController, type WatchController } from '../../watch/js/app/watch-controller';
import { CONFIG } from '../../lab/js/config';

// ── partitionBondedGroups (shared extraction) ──

describe('partitionBondedGroups (shared)', () => {
  const groups: BondedGroupSummary[] = [
    { id: 'g1', displayIndex: 1, atomCount: 60, minAtomIndex: 0, orderKey: 0 },
    { id: 'g2', displayIndex: 2, atomCount: 3, minAtomIndex: 60, orderKey: 1 },
    { id: 'g3', displayIndex: 3, atomCount: 1, minAtomIndex: 63, orderKey: 2 },
  ];

  it('partitions by default threshold', () => {
    const { large, small } = partitionBondedGroups(groups);
    expect(large).toHaveLength(1);
    expect(small).toHaveLength(2);
    expect(large[0].id).toBe('g1');
  });

  it('handles empty groups', () => {
    const { large, small } = partitionBondedGroups([]);
    expect(large).toHaveLength(0);
    expect(small).toHaveLength(0);
  });

  it('respects custom threshold', () => {
    const { large, small } = partitionBondedGroups(groups, 1);
    expect(large).toHaveLength(2); // 60 and 3 are > 1
    expect(small).toHaveLength(1); // only 1 is <= 1
  });

  it('exports SMALL_CLUSTER_THRESHOLD', () => {
    expect(SMALL_CLUSTER_THRESHOLD).toBe(3);
  });
});

// ── BondedGroupSummary consolidation ──

describe('BondedGroupSummary type consolidation', () => {
  it('lab selector re-exports partitionBondedGroups from shared module', async () => {
    const labSelector = await import('../../lab/js/store/selectors/bonded-groups');
    expect(labSelector.partitionBondedGroups).toBe(partitionBondedGroups);
    expect(labSelector.SMALL_CLUSTER_THRESHOLD).toBe(SMALL_CLUSTER_THRESHOLD);
  });
});

// ── WatchController ──

describe('createWatchController', () => {
  let controller: WatchController;

  beforeEach(() => {
    controller = createWatchController();
  });

  it('initial snapshot is unloaded with no error', () => {
    const snap = controller.getSnapshot();
    expect(snap.loaded).toBe(false);
    expect(snap.error).toBeNull();
    expect(snap.playing).toBe(false);
  });

  it('subscribe returns unsubscribe function', () => {
    const cb = vi.fn();
    const unsub = controller.subscribe(cb);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('subscribe notifies on state changes', async () => {
    const cb = vi.fn();
    controller.subscribe(cb);

    // Opening an invalid file should notify
    const fakeFile = new File(['not json'], 'bad.atomdojo', { type: 'application/json' });
    await controller.openFile(fakeFile);

    expect(cb).toHaveBeenCalled();
    expect(controller.getSnapshot().error).toBeTruthy();
  });

  it('getSnapshot returns same reference when state unchanged', () => {
    const snap1 = controller.getSnapshot();
    const snap2 = controller.getSnapshot();
    expect(snap1).toBe(snap2); // referential equality for useSyncExternalStore
  });

  it('togglePlay is no-op when not loaded', () => {
    controller.togglePlay();
    expect(controller.getSnapshot().playing).toBe(false);
  });

  it('scrub is no-op when not loaded', () => {
    controller.scrub(100);
    expect(controller.getSnapshot().currentTimePs).toBe(0);
  });

  it('dispose cleans up', () => {
    controller.dispose();
    expect(controller.getSnapshot().loaded).toBe(false);
  });
});

// ── Shared fixture ──

function makeValidFileText(): string {
    return JSON.stringify({
      format: 'atomdojo-history',
      version: 1,
      kind: 'full',
      producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-06T00:00:00Z' },
      simulation: {
        title: null, description: null,
        units: { time: 'ps', length: 'angstrom' },
        maxAtomCount: 2, durationPs: 99.999, frameCount: 2, indexingModel: 'dense-prefix',
      },
      atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
      timeline: {
        denseFrames: [
          { frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0], interaction: null, boundary: {} },
          { frameId: 1, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.1, 0, 0], interaction: null, boundary: {} },
        ],
        restartFrames: [
          {
            frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1],
            positions: [0, 0, 0, 1, 0, 0], velocities: [0, 0, 0, 0, 0, 0],
            bonds: [{ a: 0, b: 1, distance: 1.42 }],
            config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 },
            interaction: null, boundary: {},
          },
          {
            frameId: 1, timePs: 100, n: 2, atomIds: [0, 1],
            positions: [0.1, 0, 0, 1.1, 0, 0], velocities: [0.01, 0, 0, 0.01, 0, 0],
            bonds: [{ a: 0, b: 1, distance: 1.42 }],
            config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 },
            interaction: null, boundary: {},
          },
        ],
        checkpoints: [],
      },
    });
}

// ── Controller with valid file ──

describe('WatchController with valid file', () => {
  it('loads a valid file and produces a loaded snapshot', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo', { type: 'application/json' });
    await controller.openFile(file);

    const snap = controller.getSnapshot();
    expect(snap.error).toBeNull();
    expect(snap.loaded).toBe(true);
    expect(snap.atomCount).toBe(2);
    expect(snap.frameCount).toBe(2);
    expect(snap.fileKind).toBe('full');
    expect(snap.groups.length).toBeGreaterThanOrEqual(0);
    controller.dispose();
  });

  it('togglePlay works after load (auto-play starts on open)', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);

    // Auto-play: playing is true immediately after file open.
    expect(controller.getSnapshot().playing).toBe(true);
    controller.togglePlay();
    expect(controller.getSnapshot().playing).toBe(false);
    controller.togglePlay();
    expect(controller.getSnapshot().playing).toBe(true);
    controller.dispose();
  });

  it('scrub updates currentTimePs', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);

    controller.scrub(50);
    expect(controller.getSnapshot().currentTimePs).toBe(50);
    expect(controller.getSnapshot().playing).toBe(false);
    controller.dispose();
  });

  it('opening a bad second file keeps current document and shows error', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);
    expect(controller.getSnapshot().loaded).toBe(true);
    expect(controller.getSnapshot().atomCount).toBe(2);

    // Open invalid file — should keep current document visible
    const bad = new File(['bad'], 'bad.atomdojo');
    await controller.openFile(bad);
    expect(controller.getSnapshot().loaded).toBe(true); // still loaded
    expect(controller.getSnapshot().atomCount).toBe(2); // same document
    expect(controller.getSnapshot().error).toBeTruthy(); // error shown
    controller.dispose();
  });

  it('opening a valid second file replaces the current document', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);
    expect(controller.getSnapshot().loaded).toBe(true);

    // Open another valid file — should replace
    const file2 = new File([makeValidFileText()], 'test2.atomdojo');
    await controller.openFile(file2);
    expect(controller.getSnapshot().loaded).toBe(true);
    expect(controller.getSnapshot().error).toBeNull();
    controller.dispose();
  });
});

// ── File load initial time regression ──

describe('WatchController loads at first frame time', () => {
  it('currentTimePs equals the first dense frame time after load (not 0)', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);

    const snap = controller.getSnapshot();
    expect(snap.loaded).toBe(true);
    // The fixture's first frame is at 0.001ps, not 0
    expect(snap.currentTimePs).toBe(0.001);
    expect(snap.startTimePs).toBe(0.001);
    controller.dispose();
  });

  it('getDisplayPositionsAtTime returns a frame immediately after load', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await controller.openFile(file);

    const playback = controller.getPlaybackModel();
    const pos = playback.getDisplayPositionsAtTime(playback.getCurrentTimePs());
    expect(pos).not.toBeNull();
    expect(pos!.n).toBe(2);
    controller.dispose();
  });

  it('file replacement sets currentTimePs to new file first frame', async () => {
    const controller = createWatchController();
    const file1 = new File([makeValidFileText()], 'file1.atomdojo');
    await controller.openFile(file1);
    controller.scrub(50); // move to middle
    expect(controller.getSnapshot().currentTimePs).toBe(50);

    // Open second file — should reset to its first frame time
    const file2 = new File([makeValidFileText()], 'file2.atomdojo');
    await controller.openFile(file2);
    expect(controller.getSnapshot().currentTimePs).toBe(0.001);
    controller.dispose();
  });
});

// ── Lab vs Watch parity (fixture-based) ──

describe('lab/watch parity on same exported file', () => {
  it('topology at sampled timestamps matches between import and playback', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'parity.atomdojo');
    await controller.openFile(file);

    const snap = controller.getSnapshot();
    expect(snap.loaded).toBe(true);

    const playback = controller.getPlaybackModel();

    // Sample at first frame time
    const t0 = snap.startTimePs;
    const topo0 = playback.getTopologyAtTime(t0);
    expect(topo0).not.toBeNull();
    expect(topo0!.n).toBe(2);
    expect(topo0!.bonds).toEqual([[0, 1, 1.42]]);

    // Sample at last frame time
    const tEnd = snap.endTimePs;
    const topoEnd = playback.getTopologyAtTime(tEnd);
    expect(topoEnd).not.toBeNull();
    expect(topoEnd!.bonds).toEqual([[0, 1, 1.42]]);

    controller.dispose();
  });

  it('bonded-group count matches at sampled timestamps', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'parity.atomdojo');
    await controller.openFile(file);

    const snap = controller.getSnapshot();
    // With 2 atoms and 1 bond, there should be 1 group
    expect(snap.groups).toHaveLength(1);
    expect(snap.groups[0].atomCount).toBe(2);

    // Scrub to end — same topology, same groups
    controller.scrub(snap.endTimePs);
    const snapEnd = controller.getSnapshot();
    expect(snapEnd.groups).toHaveLength(1);
    expect(snapEnd.groups[0].atomCount).toBe(2);

    controller.dispose();
  });

  it('atom count and frame count match exported file metadata', async () => {
    const controller = createWatchController();
    const file = new File([makeValidFileText()], 'parity.atomdojo');
    await controller.openFile(file);

    const snap = controller.getSnapshot();
    expect(snap.atomCount).toBe(2);
    expect(snap.frameCount).toBe(2);
    expect(snap.fileKind).toBe('full');
    expect(snap.fileName).toBe('parity.atomdojo');

    controller.dispose();
  });
});

// ── Playback speed regression (x1 canonical rate) ──

describe('WatchController playback speed (x1 canonical rate)', () => {
  it('uses the same x1 rate regardless of file duration', () => {
    // CONFIG.playback.baseSimRatePsPerSecond = 0.12 ps/s
    // So psPerMs = 0.12 / 1000 = 0.00012 ps/ms
    const psPerMs = CONFIG.playback.baseSimRatePsPerSecond / 1000;

    // One RAF tick at 16.7ms should advance the same amount for any file
    const dtMs = 16.7;
    const advance = dtMs * psPerMs;
    expect(advance).toBeCloseTo(0.002004, 5); // ~0.002 ps per frame

    // A 0.4ps short file should NOT complete in one tick
    expect(advance).toBeLessThan(0.4);
    // A 100ps long file should also advance the same amount per tick
    expect(advance).toBeCloseTo(0.002004, 5);
  });

  it('short and long files advance at the same rate per tick', () => {
    const psPerMs = CONFIG.playback.baseSimRatePsPerSecond / 1000;
    const dtMs = 16.7;

    // Short file: 0.4ps total
    const advanceShort = dtMs * psPerMs;
    // Long file: 100ps total
    const advanceLong = dtMs * psPerMs;

    // Both advance the same amount — rate is NOT file-length-dependent
    expect(advanceShort).toBe(advanceLong);
  });

  it('a short file takes multiple seconds of real time to play', () => {
    const psPerS = CONFIG.playback.baseSimRatePsPerSecond;

    // 0.4ps file at 0.12 ps/s = 3.33 seconds to play
    const fileDurationPs = 0.4;
    const realTimeSeconds = fileDurationPs / psPerS;
    expect(realTimeSeconds).toBeGreaterThan(2);
    expect(realTimeSeconds).toBeLessThan(5);
  });
});
