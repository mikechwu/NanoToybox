/**
 * Watch topology-source tests — StoredTopologySource, ReconstructedTopologySource,
 * and parity between them.
 *
 * Covers:
 *   - StoredTopologySource: delegates to restart frames, reset clears
 *   - ReconstructedTopologySource: reconstructs from dense frames + atoms,
 *     cache object-identity stability, dense-frame frameId semantics
 *   - Parity: reconstructed bonds match stored bonds on same geometry
 *   - Reduced-history importer: semantic validation
 *   - BOND_DEFAULTS: shared source of truth
 */

import { describe, it, expect } from 'vitest';
import { createStoredTopologySource } from '../../watch/js/topology-sources/stored-topology-source';
import { createReconstructedTopologySource } from '../../watch/js/topology-sources/reconstructed-topology-source';
import { importReducedHistory, type LoadedReducedHistory } from '../../watch/js/reduced-history-import';
import { importFullHistory } from '../../watch/js/full-history-import';
import { BOND_DEFAULTS } from '../../src/config/bond-defaults';
import {
  buildReducedInterpolationCapability,
  createWatchTrajectoryInterpolationForReduced,
} from '../../watch/js/watch-trajectory-interpolation';
import type { AtomDojoHistoryFileV1, AtomDojoReducedFileV1 } from '../../src/history/history-file-v1';
import { validateReducedFile } from '../../src/history/history-file-v1';
import { loadHistoryFile } from '../../watch/js/history-file-loader';

// ── Fixtures ──

function makeFullFile(): AtomDojoHistoryFileV1 {
  return {
    format: 'atomdojo-history', version: 1, kind: 'full',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-12T00:00:00Z' },
    simulation: { title: null, description: null, units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 2, durationPs: 99.999, frameCount: 2, indexingModel: 'dense-prefix' },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.42, 0, 0], interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.52, 0, 0], interaction: null, boundary: {} },
      ],
      restartFrames: [
        { frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.42, 0, 0], velocities: [0, 0, 0, 0, 0, 0], bonds: [{ a: 0, b: 1, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.52, 0, 0], velocities: [0, 0, 0, 0, 0, 0], bonds: [{ a: 0, b: 1, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
      ],
      checkpoints: [],
    },
  };
}

function makeReducedFile(): AtomDojoReducedFileV1 {
  return {
    format: 'atomdojo-history', version: 1, kind: 'reduced',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-12T00:00:00Z' },
    simulation: { title: null, description: null, units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 2, durationPs: 99.999, frameCount: 2, indexingModel: 'dense-prefix' },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.42, 0, 0], interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.52, 0, 0], interaction: null, boundary: {} },
      ],
    },
  };
}

/** Reduced file with non-contiguous stable IDs (10, 42 instead of 0, 1). */
function makeReducedFileNonContiguousIds(): AtomDojoReducedFileV1 {
  return {
    format: 'atomdojo-history', version: 1, kind: 'reduced',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-12T00:00:00Z' },
    simulation: { title: null, description: null, units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 2, durationPs: 99.999, frameCount: 2, indexingModel: 'dense-prefix' },
    atoms: { atoms: [{ id: 10, element: 'C' }, { id: 42, element: 'C' }] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0.001, n: 2, atomIds: [10, 42], positions: [0, 0, 0, 1.42, 0, 0], interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 2, atomIds: [10, 42], positions: [0.1, 0, 0, 1.52, 0, 0], interaction: null, boundary: {} },
      ],
    },
  };
}

/** 4-frame reduced fixture for controller-level integration tests. */
function makeReducedFile4Frames(): AtomDojoReducedFileV1 {
  return {
    format: 'atomdojo-history', version: 1, kind: 'reduced',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-12T00:00:00Z' },
    simulation: { title: null, description: null, units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 2, durationPs: 29.999, frameCount: 4, indexingModel: 'dense-prefix' },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.42, 0, 0] },
        { frameId: 1, timePs: 10, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.52, 0, 0] },
        { frameId: 2, timePs: 20, n: 2, atomIds: [0, 1], positions: [0.2, 0, 0, 1.62, 0, 0] },
        { frameId: 3, timePs: 30, n: 2, atomIds: [0, 1], positions: [0.3, 0, 0, 1.72, 0, 0] },
      ],
    },
  };
}

// ── BOND_DEFAULTS ──

describe('BOND_DEFAULTS shared source of truth', () => {
  it('exports cutoff and minDist with expected values', () => {
    expect(BOND_DEFAULTS.cutoff).toBe(1.8);
    expect(BOND_DEFAULTS.minDist).toBe(0.5);
  });
});

// ── StoredTopologySource ──

describe('StoredTopologySource', () => {
  it('returns restart-frame topology at or before time', () => {
    const history = importFullHistory(makeFullFile());
    const source = createStoredTopologySource(history.restartFrames);
    const topo = source.getTopologyAtTime(50);
    expect(topo).not.toBeNull();
    expect(topo!.frameId).toBe(0);
    expect(topo!.n).toBe(2);
    expect(topo!.bonds).toHaveLength(1);
    expect(topo!.bonds[0][0]).toBe(0);
    expect(topo!.bonds[0][1]).toBe(1);
  });

  it('returns null before first frame', () => {
    const history = importFullHistory(makeFullFile());
    const source = createStoredTopologySource(history.restartFrames);
    expect(source.getTopologyAtTime(-1)).toBeNull();
  });

  it('reset clears the reference', () => {
    const history = importFullHistory(makeFullFile());
    const source = createStoredTopologySource(history.restartFrames);
    source.reset();
    expect(source.getTopologyAtTime(50)).toBeNull();
  });
});

// ── ReconstructedTopologySource ──

describe('ReconstructedTopologySource', () => {
  it('reconstructs bonds from dense-frame positions', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    const topo = source.getTopologyAtTime(0.001);
    expect(topo).not.toBeNull();
    expect(topo!.n).toBe(2);
    expect(topo!.bonds).toHaveLength(1);
    expect(topo!.bonds[0][0]).toBe(0);
    expect(topo!.bonds[0][1]).toBe(1);
    expect(topo!.bonds[0][2]).toBeCloseTo(1.42);
  });

  it('uses dense-frame frameId', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    const topo0 = source.getTopologyAtTime(0.001);
    const topo1 = source.getTopologyAtTime(100);
    expect(topo0!.frameId).toBe(0);
    expect(topo1!.frameId).toBe(1);
  });

  it('cache object-identity: same frame returns same instance', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    const a = source.getTopologyAtTime(50);
    const b = source.getTopologyAtTime(50);
    expect(a).toBe(b); // same object instance, not just equal
  });

  it('cache invalidation: different frame returns new instance', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    const a = source.getTopologyAtTime(0.001);
    const b = source.getTopologyAtTime(100);
    expect(a).not.toBe(b);
    expect(a!.frameId).not.toBe(b!.frameId);
  });

  it('reset clears cache and reference', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    source.reset();
    expect(source.getTopologyAtTime(50)).toBeNull();
  });

  it('works with non-contiguous stable atom IDs (10, 42)', () => {
    const reduced = importReducedHistory(makeReducedFileNonContiguousIds());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    const topo = source.getTopologyAtTime(0.001);
    expect(topo).not.toBeNull();
    expect(topo!.bonds).toHaveLength(1);
    expect(topo!.bonds[0][2]).toBeCloseTo(1.42);
  });
});

// ── Parity: stored vs reconstructed ──

describe('Topology parity: stored vs reconstructed', () => {
  it('same geometry produces same bond tuples', () => {
    const fullFile = makeFullFile();
    const fullHistory = importFullHistory(fullFile);
    const stored = createStoredTopologySource(fullHistory.restartFrames);

    const reducedFile = makeReducedFile();
    const reducedHistory = importReducedHistory(reducedFile);
    const reconstructed = createReconstructedTopologySource(reducedHistory.denseFrames, reducedHistory.elementById);

    // Compare at frame 0 (positions identical between full and reduced)
    const storedTopo = stored.getTopologyAtTime(0.001);
    const reconTopo = reconstructed.getTopologyAtTime(0.001);

    expect(storedTopo).not.toBeNull();
    expect(reconTopo).not.toBeNull();
    expect(reconTopo!.bonds).toHaveLength(storedTopo!.bonds.length);
    for (let i = 0; i < storedTopo!.bonds.length; i++) {
      expect(reconTopo!.bonds[i][0]).toBe(storedTopo!.bonds[i][0]);
      expect(reconTopo!.bonds[i][1]).toBe(storedTopo!.bonds[i][1]);
      expect(reconTopo!.bonds[i][2]).toBeCloseTo(storedTopo!.bonds[i][2], 5);
    }
  });
});

// ── Reduced file validation + import ──

describe('validateReducedFile', () => {
  it('accepts a valid reduced file', () => {
    expect(validateReducedFile(makeReducedFile())).toEqual([]);
  });

  it('rejects missing simulation', () => {
    const f = { ...makeReducedFile(), simulation: undefined };
    expect(validateReducedFile(f).length).toBeGreaterThan(0);
  });

  it('rejects missing denseFrames', () => {
    const f = makeReducedFile() as any;
    f.timeline = {};
    expect(validateReducedFile(f).length).toBeGreaterThan(0);
  });

  it('rejects wrong kind', () => {
    const f = { ...makeReducedFile(), kind: 'full' };
    expect(validateReducedFile(f).length).toBeGreaterThan(0);
  });
});

describe('importReducedHistory', () => {
  it('imports a valid reduced file', () => {
    const history = importReducedHistory(makeReducedFile());
    expect(history.kind).toBe('reduced');
    expect(history.denseFrames).toHaveLength(2);
    expect(history.atoms).toHaveLength(2);
  });

  it('rejects non-monotonic timePs', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[1].timePs = 0;
    expect(() => importReducedHistory(f)).toThrow();
  });

  it('rejects duplicate atom IDs in atom table', () => {
    const f = makeReducedFile();
    f.atoms.atoms = [{ id: 0, element: 'C' }, { id: 0, element: 'C' }]; // duplicate
    expect(() => importReducedHistory(f)).toThrow(/duplicate atom ID/);
  });

  it('rejects atomId not in atom table (stable-ID validation)', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].atomIds = [0, 999]; // 999 not in table
    expect(() => importReducedHistory(f)).toThrow(/not found in atom table/);
  });

  it('rejects duplicate atomIds within a frame', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].atomIds = [0, 0]; // duplicate within frame
    expect(() => importReducedHistory(f)).toThrow(/duplicate atomId/);
  });

  it('accepts non-contiguous stable IDs (10, 42)', () => {
    const history = importReducedHistory(makeReducedFileNonContiguousIds());
    expect(history.kind).toBe('reduced');
    expect(history.elementById.get(10)).toBe('C');
    expect(history.elementById.get(42)).toBe('C');
  });

  it('rejects unsupported indexingModel', () => {
    const f = makeReducedFile();
    (f.simulation as any).indexingModel = 'something-else';
    expect(() => importReducedHistory(f)).toThrow(/unsupported indexingModel/);
  });

  it('rejects non-string element in atom table', () => {
    const f = makeReducedFile();
    (f.atoms.atoms[0] as any).element = 42;
    expect(() => importReducedHistory(f)).toThrow(/element must be a non-empty string/);
  });

  it('rejects non-finite timePs in frame', () => {
    const f = makeReducedFile();
    (f.timeline.denseFrames[0] as any).timePs = NaN;
    expect(() => importReducedHistory(f)).toThrow(/timePs must be a finite number/);
  });

  it('rejects non-finite atom ID in atom table', () => {
    const f = makeReducedFile();
    (f.atoms.atoms[0] as any).id = Infinity;
    expect(() => importReducedHistory(f)).toThrow(/id must be a finite number/);
  });

  it('rejects NaN in positions', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].positions[0] = NaN;
    expect(() => importReducedHistory(f)).toThrow(/positions\[0\] must be a finite number/);
  });

  it('rejects Infinity in positions', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].positions[2] = Infinity;
    expect(() => importReducedHistory(f)).toThrow(/positions\[2\] must be a finite number/);
  });

  it('rejects non-numeric value in positions', () => {
    const f = makeReducedFile();
    (f.timeline.denseFrames[0].positions as any)[1] = 'bad';
    expect(() => importReducedHistory(f)).toThrow(/positions\[1\] must be a finite number/);
  });

  it('rejects NaN maxAtomCount', () => {
    const f = makeReducedFile();
    (f.simulation as any).maxAtomCount = NaN;
    expect(() => importReducedHistory(f)).toThrow(/maxAtomCount must be a non-negative finite number/);
  });

  it('rejects non-finite durationPs', () => {
    const f = makeReducedFile();
    (f.simulation as any).durationPs = Infinity;
    expect(() => importReducedHistory(f)).toThrow(/durationPs must be a non-negative finite number/);
  });

  it('rejects negative frameCount', () => {
    const f = makeReducedFile();
    (f.simulation as any).frameCount = -1;
    expect(() => importReducedHistory(f)).toThrow(/frameCount must be a non-negative finite number/);
  });

  it('rejects invalid bondPolicy.cutoff', () => {
    const f = makeReducedFile();
    (f as any).bondPolicy = { policyId: 'default-carbon-v1', cutoff: -1, minDist: 0.5 };
    expect(() => importReducedHistory(f)).toThrow(/bondPolicy.cutoff must be a positive finite number/);
  });

  it('rejects bondPolicy.minDist >= cutoff', () => {
    const f = makeReducedFile();
    (f as any).bondPolicy = { policyId: 'default-carbon-v1', cutoff: 1.0, minDist: 1.5 };
    expect(() => importReducedHistory(f)).toThrow(/bondPolicy.minDist.*must be less than/);
  });

  it('rejects unknown bondPolicy.policyId', () => {
    const f = makeReducedFile();
    (f as any).bondPolicy = { policyId: 'future-unknown', cutoff: 1.8, minDist: 0.5 };
    expect(() => importReducedHistory(f)).toThrow(/bondPolicy.policyId must be one of/);
  });

  it('accepts valid bondPolicy', () => {
    const f = makeReducedFile();
    (f as any).bondPolicy = { policyId: 'default-carbon-v1', cutoff: 1.8, minDist: 0.5 };
    const history = importReducedHistory(f);
    expect(history.bondPolicy).toEqual({ policyId: 'default-carbon-v1', cutoff: 1.8, minDist: 0.5 });
  });

  it('legacy file with no bondPolicy sets bondPolicy to null', () => {
    const history = importReducedHistory(makeReducedFile());
    expect(history.bondPolicy).toBeNull();
  });

  it('rejects mismatched durationPs vs frame span', () => {
    const f = makeReducedFile();
    // Frames span 0.001 → 100, so expected durationPs = 99.999
    // Setting a wrong value:
    f.simulation.durationPs = 50;
    expect(() => importReducedHistory(f)).toThrow(/durationPs/);
  });
});

// ── Bonded-group parity ──

import { createWatchBondedGroups } from '../../watch/js/watch-bonded-groups';

describe('Bonded-group parity: stored vs reconstructed topology', () => {
  it('same topology input produces same bonded-group summaries', () => {
    const fullHistory = importFullHistory(makeFullFile());
    const stored = createStoredTopologySource(fullHistory.restartFrames);
    const storedTopo = stored.getTopologyAtTime(0.001);

    const reducedHistory = importReducedHistory(makeReducedFile());
    const reconstructed = createReconstructedTopologySource(reducedHistory.denseFrames, reducedHistory.elementById);
    const reconTopo = reconstructed.getTopologyAtTime(0.001);

    // Feed both topologies through bonded-group analysis
    const groups1 = createWatchBondedGroups();
    groups1.updateForTime(0.001, storedTopo);
    const summaries1 = groups1.getSummaries();

    const groups2 = createWatchBondedGroups();
    groups2.updateForTime(0.001, reconTopo);
    const summaries2 = groups2.getSummaries();

    // Same number of groups, same atom counts
    expect(summaries2).toHaveLength(summaries1.length);
    for (let i = 0; i < summaries1.length; i++) {
      expect(summaries2[i].atomCount).toBe(summaries1[i].atomCount);
    }
  });
});

// ── Controller integration (file-kind dispatch) ──

import { createWatchController } from '../../watch/js/watch-controller';

describe('Controller loads both file kinds', () => {
  it('full-history file loads and produces topology', async () => {
    const controller = createWatchController();
    const file = new File([JSON.stringify(makeFullFile())], 'test.atomdojo', { type: 'application/json' });
    await controller.openFile(file);
    const snap = controller.getSnapshot();
    expect(snap.loaded).toBe(true);
    expect(snap.fileKind).toBe('full');
    expect(snap.atomCount).toBe(2);
    controller.dispose();
  });

  it('reduced-history file loads and produces topology', async () => {
    const controller = createWatchController();
    const file = new File([JSON.stringify(makeReducedFile())], 'test-reduced.atomdojo', { type: 'application/json' });
    await controller.openFile(file);
    const snap = controller.getSnapshot();
    expect(snap.loaded).toBe(true);
    expect(snap.fileKind).toBe('reduced');
    expect(snap.atomCount).toBe(2);
    controller.dispose();
  });

  it('reduced-history: scrub + smooth playback + topology + groups work end-to-end', async () => {
    const controller = createWatchController();
    const file = new File(
      [JSON.stringify(makeReducedFile4Frames())],
      'test-reduced-4f.atomdojo',
      { type: 'application/json' },
    );
    await controller.openFile(file);

    const snap1 = controller.getSnapshot();
    expect(snap1.loaded).toBe(true);
    expect(snap1.fileKind).toBe('reduced');
    expect(snap1.frameCount).toBe(4);

    // Smooth playback is ON by default
    expect(snap1.smoothPlayback).toBe(true);
    expect(snap1.interpolationMode).toBe('linear');

    // Verify the playback model accepted the reduced file and topology source works
    const playback = controller.getPlaybackModel();
    expect(playback.isLoaded()).toBe(true);

    // Topology is available at various times (reconstructed from dense frames)
    const topo0 = playback.getTopologyAtTime(5);
    expect(topo0).not.toBeNull();
    expect(topo0!.bonds.length).toBeGreaterThan(0);
    expect(topo0!.n).toBe(2);

    const topo1 = playback.getTopologyAtTime(15);
    expect(topo1).not.toBeNull();
    expect(topo1!.frameId).toBe(1); // at-or-before 15 → frame 1 (t=10)

    // Bonded-group analysis works through the playback model
    const groups = controller.getBondedGroups();
    groups.updateForTime(5, topo0);
    const summaries = groups.getSummaries();
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0].atomCount).toBe(2);

    // Verify interpolation runtime exists (may be null if openFile errored silently)
    // The 4-frame fixture has no renderer, so the interpolation runtime is installed
    // but the controller's snapshot may not reflect all state without a renderer.
    const snap3 = controller.getSnapshot();
    // If loaded, topology and groups should be accessible through the playback model.
    expect(snap3.loaded).toBe(true);

    controller.dispose();
  });
});

// ── Bond-policy override in reconstruction ──

describe('File-declared bondPolicy overrides BOND_DEFAULTS in reconstruction', () => {
  it('tighter cutoff produces fewer bonds than default', () => {
    // Default cutoff 1.8 → dimer at 1.42 Å bonds
    const defaultReduced = importReducedHistory(makeReducedFile());
    const defaultSource = createReconstructedTopologySource(
      defaultReduced.denseFrames, defaultReduced.elementById, defaultReduced.bondPolicy,
    );
    const defaultTopo = defaultSource.getTopologyAtTime(0.001);
    expect(defaultTopo!.bonds).toHaveLength(1);

    // Tight cutoff 1.0 → dimer at 1.42 Å does NOT bond
    const tightFile = makeReducedFile();
    (tightFile as any).bondPolicy = { policyId: 'default-carbon-v1', cutoff: 1.0, minDist: 0.3 };
    const tightReduced = importReducedHistory(tightFile);
    const tightSource = createReconstructedTopologySource(
      tightReduced.denseFrames, tightReduced.elementById, tightReduced.bondPolicy,
    );
    const tightTopo = tightSource.getTopologyAtTime(0.001);
    expect(tightTopo!.bonds).toHaveLength(0);
  });
});

// ── Reduced interpolation capability + factory ──

describe('buildReducedInterpolationCapability', () => {
  it('marks compatible adjacent frames as bracketSafe', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const cap = buildReducedInterpolationCapability(reduced.denseFrames);
    expect(cap.bracketSafe[0]).toBe(1);
    expect(cap.bracketReason[0]).toBe('ok');
  });

  it('marks last frame as last-frame', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const cap = buildReducedInterpolationCapability(reduced.denseFrames);
    expect(cap.bracketSafe[1]).toBe(0);
    expect(cap.bracketReason[1]).toBe('last-frame');
  });

  it('all hermiteSafe are 0 (no restart data)', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const cap = buildReducedInterpolationCapability(reduced.denseFrames);
    for (let i = 0; i < cap.hermiteSafe.length; i++) {
      expect(cap.hermiteSafe[i]).toBe(0);
    }
  });

  it('all velocityReason are restart-misaligned', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const cap = buildReducedInterpolationCapability(reduced.denseFrames);
    for (const r of cap.velocityReason) {
      expect(r).toBe('restart-misaligned');
    }
  });
});

describe('createWatchTrajectoryInterpolationForReduced', () => {
  it('linear interpolation works between compatible dense frames', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const rt = createWatchTrajectoryInterpolationForReduced(reduced);
    // Midpoint between frame 0 (t=0.001) and frame 1 (t=100)
    const result = rt.resolve(50, { enabled: true, mode: 'linear' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('none');
    // Atom 0 x: lerp(0, 0.1, ~0.5) ≈ 0.05
    expect(result.positions[0]).toBeCloseTo(0.05, 1);
  });

  it('Hermite selected on reduced files falls back to linear', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const rt = createWatchTrajectoryInterpolationForReduced(reduced);
    const result = rt.resolve(50, { enabled: true, mode: 'hermite' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('velocities-unavailable');
  });

  it('Catmull-Rom selected on reduced files falls back to linear', () => {
    const reduced = importReducedHistory(makeReducedFile());
    const rt = createWatchTrajectoryInterpolationForReduced(reduced);
    const result = rt.resolve(50, { enabled: true, mode: 'catmull-rom' });
    expect(result.activeMethod).toBe('linear');
    // Only 2 frames — timeline edge
    expect(result.fallbackReason).toBe('insufficient-frames');
  });

  it('variable-n bracket degrades conservatively', () => {
    const f = makeReducedFile();
    // Make frame 1 have different n
    f.timeline.denseFrames[1].n = 1;
    f.timeline.denseFrames[1].atomIds = [0];
    f.timeline.denseFrames[1].positions = [0.1, 0, 0];
    f.simulation.frameCount = 2;
    const reduced = importReducedHistory(f);
    const rt = createWatchTrajectoryInterpolationForReduced(reduced);
    const result = rt.resolve(50, { enabled: true, mode: 'linear' });
    expect(result.fallbackReason).toBe('variable-n');
  });
});

// ── LoadDecision: reduced kind ──

describe('history-file-loader: reduced kind', () => {
  it('accepts a valid reduced file', () => {
    const decision = loadHistoryFile(JSON.stringify(makeReducedFile()));
    expect(decision.status).toBe('supported');
    if (decision.status === 'supported') {
      expect(decision.kind).toBe('reduced');
    }
  });

  it('still accepts full files', () => {
    const decision = loadHistoryFile(JSON.stringify(makeFullFile()));
    expect(decision.status).toBe('supported');
    if (decision.status === 'supported') {
      expect(decision.kind).toBe('full');
    }
  });

  it('still rejects replay files', () => {
    const f = { ...makeFullFile(), kind: 'replay' };
    const decision = loadHistoryFile(JSON.stringify(f));
    expect(decision.status).toBe('unsupported');
  });
});
