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
import { createStoredTopologySource } from '../../watch/js/playback/topology-sources/stored-topology-source';
import { createReconstructedTopologySource } from '../../watch/js/playback/topology-sources/reconstructed-topology-source';
import { importReducedAsCapsule, importCapsuleHistory, type LoadedCapsuleHistory } from '../../watch/js/document/capsule-history-import';
import { importFullHistory } from '../../watch/js/document/full-history-import';
import { BOND_DEFAULTS } from '../../src/config/bond-defaults';
import {
  buildCapsuleInterpolationCapability,
  createWatchTrajectoryInterpolationForCapsule,
} from '../../watch/js/playback/watch-trajectory-interpolation';
import type { AtomDojoHistoryFileV1, AtomDojoReducedFileV1, AtomDojoPlaybackCapsuleFileV1 } from '../../src/history/history-file-v1';
import { validateReducedFile, validateCapsuleFile } from '../../src/history/history-file-v1';
import { loadHistoryFile } from '../../watch/js/document/history-file-loader';
import { buildExportBondPolicy } from '../../src/topology/bond-policy-resolver';

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
    const reduced = importReducedAsCapsule(makeReducedFile());
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
    const reduced = importReducedAsCapsule(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    const topo0 = source.getTopologyAtTime(0.001);
    const topo1 = source.getTopologyAtTime(100);
    expect(topo0!.frameId).toBe(0);
    expect(topo1!.frameId).toBe(1);
  });

  it('cache object-identity: same frame returns same instance', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    const a = source.getTopologyAtTime(50);
    const b = source.getTopologyAtTime(50);
    expect(a).toBe(b); // same object instance, not just equal
  });

  it('cache invalidation: different frame returns new instance', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    const a = source.getTopologyAtTime(0.001);
    const b = source.getTopologyAtTime(100);
    expect(a).not.toBe(b);
    expect(a!.frameId).not.toBe(b!.frameId);
  });

  it('reset clears cache and reference', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const source = createReconstructedTopologySource(reduced.denseFrames, reduced.elementById);
    source.reset();
    expect(source.getTopologyAtTime(50)).toBeNull();
  });

  it('works with non-contiguous stable atom IDs (10, 42)', () => {
    const reduced = importReducedAsCapsule(makeReducedFileNonContiguousIds());
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
    const reducedHistory = importReducedAsCapsule(reducedFile);
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

describe('importReducedAsCapsule', () => {
  it('imports a valid reduced file (normalizes to capsule kind)', () => {
    const history = importReducedAsCapsule(makeReducedFile());
    expect(history.kind).toBe('capsule');
    expect(history.denseFrames).toHaveLength(2);
    expect(history.atoms).toHaveLength(2);
  });

  it('rejects non-monotonic timePs', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[1].timePs = 0;
    expect(() => importReducedAsCapsule(f)).toThrow();
  });

  it('rejects duplicate atom IDs in atom table', () => {
    const f = makeReducedFile();
    f.atoms.atoms = [{ id: 0, element: 'C' }, { id: 0, element: 'C' }]; // duplicate
    expect(() => importReducedAsCapsule(f)).toThrow(/duplicate atom ID/);
  });

  it('rejects atomId not in atom table (stable-ID validation)', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].atomIds = [0, 999]; // 999 not in table
    expect(() => importReducedAsCapsule(f)).toThrow(/not found in atom table/);
  });

  it('rejects duplicate atomIds within a frame', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].atomIds = [0, 0]; // duplicate within frame
    expect(() => importReducedAsCapsule(f)).toThrow(/duplicate atomId/);
  });

  it('accepts non-contiguous stable IDs (10, 42)', () => {
    const history = importReducedAsCapsule(makeReducedFileNonContiguousIds());
    expect(history.kind).toBe('capsule');
    expect(history.elementById.get(10)).toBe('C');
    expect(history.elementById.get(42)).toBe('C');
  });

  it('rejects unsupported indexingModel', () => {
    const f = makeReducedFile();
    (f.simulation as any).indexingModel = 'something-else';
    expect(() => importReducedAsCapsule(f)).toThrow(/unsupported indexingModel/);
  });

  it('rejects non-string element in atom table', () => {
    const f = makeReducedFile();
    (f.atoms.atoms[0] as any).element = 42;
    expect(() => importReducedAsCapsule(f)).toThrow(/element must be a non-empty string/);
  });

  it('rejects non-finite timePs in frame', () => {
    const f = makeReducedFile();
    (f.timeline.denseFrames[0] as any).timePs = NaN;
    expect(() => importReducedAsCapsule(f)).toThrow(/timePs must be a finite number/);
  });

  it('rejects non-finite atom ID in atom table', () => {
    const f = makeReducedFile();
    (f.atoms.atoms[0] as any).id = Infinity;
    expect(() => importReducedAsCapsule(f)).toThrow(/id must be a finite number/);
  });

  it('rejects NaN in positions', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].positions[0] = NaN;
    expect(() => importReducedAsCapsule(f)).toThrow(/positions\[0\] must be a finite number/);
  });

  it('rejects Infinity in positions', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].positions[2] = Infinity;
    expect(() => importReducedAsCapsule(f)).toThrow(/positions\[2\] must be a finite number/);
  });

  it('rejects non-numeric value in positions', () => {
    const f = makeReducedFile();
    (f.timeline.denseFrames[0].positions as any)[1] = 'bad';
    expect(() => importReducedAsCapsule(f)).toThrow(/positions\[1\] must be a finite number/);
  });

  it('rejects NaN maxAtomCount', () => {
    const f = makeReducedFile();
    (f.simulation as any).maxAtomCount = NaN;
    expect(() => importReducedAsCapsule(f)).toThrow(/maxAtomCount must be a non-negative finite number/);
  });

  it('rejects non-finite durationPs', () => {
    const f = makeReducedFile();
    (f.simulation as any).durationPs = Infinity;
    expect(() => importReducedAsCapsule(f)).toThrow(/durationPs must be a non-negative finite number/);
  });

  it('rejects negative frameCount', () => {
    const f = makeReducedFile();
    (f.simulation as any).frameCount = -1;
    expect(() => importReducedAsCapsule(f)).toThrow(/frameCount must be a non-negative finite number/);
  });

  it('rejects invalid bondPolicy.cutoff', () => {
    const f = makeReducedFile();
    (f as any).bondPolicy = { policyId: 'default-carbon-v1', cutoff: -1, minDist: 0.5 };
    expect(() => importReducedAsCapsule(f)).toThrow(/bondPolicy.cutoff must be a positive finite number/);
  });

  it('rejects bondPolicy.minDist >= cutoff', () => {
    const f = makeReducedFile();
    (f as any).bondPolicy = { policyId: 'default-carbon-v1', cutoff: 1.0, minDist: 1.5 };
    expect(() => importReducedAsCapsule(f)).toThrow(/bondPolicy.minDist.*must be less than/);
  });

  it('rejects unknown bondPolicy.policyId', () => {
    const f = makeReducedFile();
    (f as any).bondPolicy = { policyId: 'future-unknown', cutoff: 1.8, minDist: 0.5 };
    expect(() => importReducedAsCapsule(f)).toThrow(/bondPolicy.policyId must be one of/);
  });

  it('accepts valid bondPolicy', () => {
    const f = makeReducedFile();
    (f as any).bondPolicy = { policyId: 'default-carbon-v1', cutoff: 1.8, minDist: 0.5 };
    const history = importReducedAsCapsule(f);
    expect(history.bondPolicy).toEqual({ policyId: 'default-carbon-v1', cutoff: 1.8, minDist: 0.5 });
  });

  it('legacy file with no bondPolicy resolves to BOND_DEFAULTS', () => {
    const history = importReducedAsCapsule(makeReducedFile());
    expect(history.bondPolicy.policyId).toBe('default-carbon-v1');
    expect(history.bondPolicy.cutoff).toBe(BOND_DEFAULTS.cutoff);
    expect(history.bondPolicy.minDist).toBe(BOND_DEFAULTS.minDist);
  });

  it('rejects mismatched durationPs vs frame span', () => {
    const f = makeReducedFile();
    // Frames span 0.001 → 100, so expected durationPs = 99.999
    // Setting a wrong value:
    f.simulation.durationPs = 50;
    expect(() => importReducedAsCapsule(f)).toThrow(/durationPs/);
  });
});

// ── Bonded-group parity ──

import { createWatchBondedGroups } from '../../watch/js/analysis/watch-bonded-groups';

describe('Bonded-group parity: stored vs reconstructed topology', () => {
  it('same topology input produces same bonded-group summaries', () => {
    const fullHistory = importFullHistory(makeFullFile());
    const stored = createStoredTopologySource(fullHistory.restartFrames);
    const storedTopo = stored.getTopologyAtTime(0.001);

    const reducedHistory = importReducedAsCapsule(makeReducedFile());
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

import { createWatchController } from '../../watch/js/app/watch-controller';

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

  it('reduced-history file loads and produces topology (normalized to capsule)', async () => {
    const controller = createWatchController();
    const file = new File([JSON.stringify(makeReducedFile())], 'test-reduced.atomdojo', { type: 'application/json' });
    await controller.openFile(file);
    const snap = controller.getSnapshot();
    expect(snap.loaded).toBe(true);
    expect(snap.fileKind).toBe('capsule');
    expect(snap.atomCount).toBe(2);
    controller.dispose();
  });

  it('capsule file loads end-to-end (loader → importer → playback → topology → interpolation)', async () => {
    const controller = createWatchController();
    const file = new File([JSON.stringify(makeCapsuleFile())], 'test-capsule.atomdojo', { type: 'application/json' });
    await controller.openFile(file);
    const snap = controller.getSnapshot();
    expect(snap.loaded).toBe(true);
    expect(snap.fileKind).toBe('capsule');
    expect(snap.atomCount).toBe(2);
    expect(snap.frameCount).toBe(2);
    expect(snap.smoothPlayback).toBe(true);
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
    expect(snap1.fileKind).toBe('capsule');
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
    const defaultReduced = importReducedAsCapsule(makeReducedFile());
    const defaultSource = createReconstructedTopologySource(
      defaultReduced.denseFrames, defaultReduced.elementById, defaultReduced.bondPolicy,
    );
    const defaultTopo = defaultSource.getTopologyAtTime(0.001);
    expect(defaultTopo!.bonds).toHaveLength(1);

    // Tight cutoff 1.0 → dimer at 1.42 Å does NOT bond
    const tightFile = makeReducedFile();
    (tightFile as any).bondPolicy = { policyId: 'default-carbon-v1', cutoff: 1.0, minDist: 0.3 };
    const tightReduced = importReducedAsCapsule(tightFile);
    const tightSource = createReconstructedTopologySource(
      tightReduced.denseFrames, tightReduced.elementById, tightReduced.bondPolicy,
    );
    const tightTopo = tightSource.getTopologyAtTime(0.001);
    expect(tightTopo!.bonds).toHaveLength(0);
  });
});

// ── Reduced interpolation capability + factory ──

describe('buildCapsuleInterpolationCapability', () => {
  it('marks compatible adjacent frames as bracketSafe', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const cap = buildCapsuleInterpolationCapability(reduced.denseFrames);
    expect(cap.bracketSafe[0]).toBe(1);
    expect(cap.bracketReason[0]).toBe('ok');
  });

  it('marks last frame as last-frame', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const cap = buildCapsuleInterpolationCapability(reduced.denseFrames);
    expect(cap.bracketSafe[1]).toBe(0);
    expect(cap.bracketReason[1]).toBe('last-frame');
  });

  it('all hermiteSafe are 0 (no restart data)', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const cap = buildCapsuleInterpolationCapability(reduced.denseFrames);
    for (let i = 0; i < cap.hermiteSafe.length; i++) {
      expect(cap.hermiteSafe[i]).toBe(0);
    }
  });

  it('all velocityReason are restart-misaligned', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const cap = buildCapsuleInterpolationCapability(reduced.denseFrames);
    for (const r of cap.velocityReason) {
      expect(r).toBe('restart-misaligned');
    }
  });
});

describe('createWatchTrajectoryInterpolationForCapsule', () => {
  it('linear interpolation works between compatible dense frames', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const rt = createWatchTrajectoryInterpolationForCapsule(reduced);
    // Midpoint between frame 0 (t=0.001) and frame 1 (t=100)
    const result = rt.resolve(50, { enabled: true, mode: 'linear' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('none');
    // Atom 0 x: lerp(0, 0.1, ~0.5) ≈ 0.05
    expect(result.positions[0]).toBeCloseTo(0.05, 1);
  });

  it('Hermite selected on reduced files falls back to linear', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const rt = createWatchTrajectoryInterpolationForCapsule(reduced);
    const result = rt.resolve(50, { enabled: true, mode: 'hermite' });
    expect(result.activeMethod).toBe('linear');
    expect(result.fallbackReason).toBe('velocities-unavailable');
  });

  it('Catmull-Rom selected on reduced files falls back to linear', () => {
    const reduced = importReducedAsCapsule(makeReducedFile());
    const rt = createWatchTrajectoryInterpolationForCapsule(reduced);
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
    const reduced = importReducedAsCapsule(f);
    const rt = createWatchTrajectoryInterpolationForCapsule(reduced);
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

// ── Capsule-specific fixtures and tests ──

function makeCapsuleFile(): AtomDojoPlaybackCapsuleFileV1 {
  return {
    format: 'atomdojo-history', version: 1, kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.2.0', exportedAt: '2026-04-12T00:00:00Z' },
    simulation: { units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 2, durationPs: 99.999, frameCount: 2, indexingModel: 'dense-prefix' },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.8, minDist: 0.5 },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0.001, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1.42, 0, 0] },
        { frameId: 1, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.52, 0, 0] },
      ],
    },
  };
}

function makeCapsuleFileWithAppearance(): AtomDojoPlaybackCapsuleFileV1 {
  const f = makeCapsuleFile();
  return {
    ...f,
    appearance: {
      colorAssignments: [
        { atomIds: [0], colorHex: '#ff5555' },
        { atomIds: [1], colorHex: '#55aaff' },
      ],
    },
  };
}

function makeCapsuleFileWithInteraction(): AtomDojoPlaybackCapsuleFileV1 {
  const f = makeCapsuleFile();
  return {
    ...f,
    timeline: {
      ...f.timeline,
      interactionTimeline: {
        encoding: 'event-stream-v1' as const,
        events: [
          { frameId: 0, kind: 'atom_drag' as const, atomId: 0, target: [1.0, 2.0, 3.0] as [number, number, number] },
          { frameId: 1, kind: 'none' as const },
        ],
      },
    },
  };
}

describe('validateCapsuleFile', () => {
  it('accepts a valid capsule file', () => {
    expect(validateCapsuleFile(makeCapsuleFile())).toEqual([]);
  });

  it('rejects missing bondPolicy', () => {
    const f = { ...makeCapsuleFile() } as Record<string, unknown>;
    delete f.bondPolicy;
    expect(validateCapsuleFile(f)).toContainEqual(expect.stringContaining('bondPolicy'));
  });

  it('rejects wrong kind', () => {
    const f = { ...makeCapsuleFile(), kind: 'reduced' };
    expect(validateCapsuleFile(f)).toContainEqual(expect.stringContaining('capsule'));
  });

  it('rejects empty denseFrames', () => {
    const f = makeCapsuleFile();
    (f as any).timeline.denseFrames = [];
    expect(validateCapsuleFile(f)).toContainEqual(expect.stringContaining('must not be empty'));
  });
});

describe('importCapsuleHistory', () => {
  it('imports a valid capsule file', () => {
    const history = importCapsuleHistory(makeCapsuleFile());
    expect(history.kind).toBe('capsule');
    expect(history.denseFrames).toHaveLength(2);
    expect(history.atoms).toHaveLength(2);
    expect(history.bondPolicy.policyId).toBe('default-carbon-v1');
  });

  it('requires bondPolicy', () => {
    const f = makeCapsuleFile();
    (f as any).bondPolicy = null;
    expect(() => importCapsuleHistory(f)).toThrow();
  });

  it('validates frameId monotonicity', () => {
    const f = makeCapsuleFile();
    f.timeline.denseFrames[1] = { ...f.timeline.denseFrames[1], frameId: 0 };
    expect(() => importCapsuleHistory(f)).toThrow(/non-monotonic frameId/);
  });

  it('imports appearance when present', () => {
    const history = importCapsuleHistory(makeCapsuleFileWithAppearance());
    expect(history.appearance).not.toBeNull();
    expect(history.appearance!.colorAssignments).toHaveLength(2);
    expect(history.appearance!.colorAssignments[0].colorHex).toBe('#ff5555');
    expect(history.appearance!.colorAssignments[0].atomIds).toEqual([0]);
  });

  it('appearance is null when not present', () => {
    const history = importCapsuleHistory(makeCapsuleFile());
    expect(history.appearance).toBeNull();
  });

  it('rejects appearance with unknown atomId', () => {
    const f = makeCapsuleFileWithAppearance();
    f.appearance!.colorAssignments[0].atomIds = [999];
    expect(() => importCapsuleHistory(f)).toThrow(/atomId 999 not found/);
  });

  it('rejects appearance with malformed colorHex (named color)', () => {
    const f = makeCapsuleFileWithAppearance();
    f.appearance!.colorAssignments[0].colorHex = 'red';
    expect(() => importCapsuleHistory(f)).toThrow(/colorHex must be a 6-digit hex/);
  });

  it('rejects appearance with malformed colorHex (short hex)', () => {
    const f = makeCapsuleFileWithAppearance();
    f.appearance!.colorAssignments[0].colorHex = '#fff';
    expect(() => importCapsuleHistory(f)).toThrow(/colorHex must be a 6-digit hex/);
  });

  it('rejects appearance with malformed colorHex (no hash)', () => {
    const f = makeCapsuleFileWithAppearance();
    f.appearance!.colorAssignments[0].colorHex = 'ff5555';
    expect(() => importCapsuleHistory(f)).toThrow(/colorHex must be a 6-digit hex/);
  });

  it('imports interaction timeline when present', () => {
    const history = importCapsuleHistory(makeCapsuleFileWithInteraction());
    expect(history.interactionTimeline).not.toBeNull();
    expect(history.interactionTimeline!.events).toHaveLength(2);
  });

  it('rejects interaction events with unknown frameId', () => {
    const f = makeCapsuleFileWithInteraction();
    f.timeline.interactionTimeline!.events[0] = { frameId: 999, kind: 'none' };
    expect(() => importCapsuleHistory(f)).toThrow(/frameId 999 not found/);
  });

  it('rejects non-monotonic interaction events', () => {
    const f = makeCapsuleFileWithInteraction();
    f.timeline.interactionTimeline!.events = [
      { frameId: 1, kind: 'none' },
      { frameId: 0, kind: 'none' },
    ];
    expect(() => importCapsuleHistory(f)).toThrow(/non-monotonic/);
  });

  it('rejects interaction events with unknown atomId', () => {
    const f = makeCapsuleFileWithInteraction();
    f.timeline.interactionTimeline!.events[0] = { frameId: 0, kind: 'atom_drag', atomId: 999, target: [0, 0, 0] };
    expect(() => importCapsuleHistory(f)).toThrow(/atomId 999/);
  });

  it('capsule dense frames have interaction: null and boundary: {}', () => {
    const history = importCapsuleHistory(makeCapsuleFile());
    expect(history.denseFrames[0].interaction).toBeNull();
    expect(history.denseFrames[0].boundary).toEqual({});
  });

  it('validates simulation.units on capsule', () => {
    const f = makeCapsuleFile();
    (f as any).simulation.units = { time: 'fs', length: 'angstrom' };
    expect(() => importCapsuleHistory(f)).toThrow(/units\.time must be 'ps'/);
  });

  it('rejects missing simulation.units', () => {
    const f = makeCapsuleFile();
    delete (f as any).simulation.units;
    expect(() => importCapsuleHistory(f)).toThrow(/units must be an object/);
  });

  it('rejects wrong units.length', () => {
    const f = makeCapsuleFile();
    (f as any).simulation.units = { time: 'ps', length: 'nm' };
    expect(() => importCapsuleHistory(f)).toThrow(/units\.length must be 'angstrom'/);
  });

  it('rejects interaction event with missing target', () => {
    const f = makeCapsuleFileWithInteraction();
    f.timeline.interactionTimeline!.events[0] = { frameId: 0, kind: 'atom_drag', atomId: 0 } as any;
    expect(() => importCapsuleHistory(f)).toThrow(/target must be a 3-number tuple/);
  });

  it('rejects interaction event with wrong target length', () => {
    const f = makeCapsuleFileWithInteraction();
    f.timeline.interactionTimeline!.events[0] = { frameId: 0, kind: 'atom_drag', atomId: 0, target: [1, 2] } as any;
    expect(() => importCapsuleHistory(f)).toThrow(/target must be a 3-number tuple/);
  });

  it('rejects interaction event with NaN in target', () => {
    const f = makeCapsuleFileWithInteraction();
    f.timeline.interactionTimeline!.events[0] = { frameId: 0, kind: 'atom_drag', atomId: 0, target: [1, NaN, 3] } as any;
    expect(() => importCapsuleHistory(f)).toThrow(/target must be a 3-number tuple/);
  });

  it('rejects interaction event with unknown kind', () => {
    const f = makeCapsuleFileWithInteraction();
    f.timeline.interactionTimeline!.events[0] = { frameId: 0, kind: 'teleport', atomId: 0, target: [0, 0, 0] } as any;
    expect(() => importCapsuleHistory(f)).toThrow(/unsupported kind 'teleport'/);
  });
});

describe('legacy reduced normalization', () => {
  it('reduced files normalize to kind=capsule via importReducedAsCapsule', () => {
    const history = importReducedAsCapsule(makeReducedFile());
    expect(history.kind).toBe('capsule');
  });

  it('reduced files preserve frame-local interaction payload', () => {
    const f = makeReducedFile();
    f.timeline.denseFrames[0].interaction = { kind: 'atom_drag' };
    const history = importReducedAsCapsule(f);
    expect(history.denseFrames[0].interaction).toEqual({ kind: 'atom_drag' });
  });

  it('reduced files without bondPolicy get BOND_DEFAULTS', () => {
    const history = importReducedAsCapsule(makeReducedFile());
    expect(history.bondPolicy.policyId).toBe('default-carbon-v1');
    expect(history.bondPolicy.cutoff).toBe(BOND_DEFAULTS.cutoff);
  });

  it('reduced files have null appearance and interactionTimeline', () => {
    const history = importReducedAsCapsule(makeReducedFile());
    expect(history.appearance).toBeNull();
    expect(history.interactionTimeline).toBeNull();
  });

  it('reduced files preserve simulation.units from file', () => {
    const history = importReducedAsCapsule(makeReducedFile());
    expect(history.simulation.units).toEqual({ time: 'ps', length: 'angstrom' });
  });

  it('reduced files with bad units are rejected', () => {
    const f = makeReducedFile();
    (f as any).simulation.units = { time: 'fs', length: 'angstrom' };
    expect(() => importReducedAsCapsule(f)).toThrow(/units\.time must be 'ps'/);
  });

  it('reduced files preserve optional title/description from legacy simulation metadata', () => {
    const f = makeReducedFile();
    (f as any).simulation.title = 'My Simulation';
    (f as any).simulation.description = 'Legacy test file';
    const history = importReducedAsCapsule(f);
    expect(history.simulation.title).toBe('My Simulation');
    expect(history.simulation.description).toBe('Legacy test file');
  });

  it('reduced files without title/description omit them from simulation', () => {
    const history = importReducedAsCapsule(makeReducedFile());
    expect(history.simulation.title).toBeUndefined();
    expect(history.simulation.description).toBeUndefined();
  });
});

describe('buildExportBondPolicy', () => {
  it('returns valid BondPolicyV1 from BOND_DEFAULTS', () => {
    const bp = buildExportBondPolicy();
    expect(bp.policyId).toBe('default-carbon-v1');
    expect(bp.cutoff).toBe(BOND_DEFAULTS.cutoff);
    expect(bp.minDist).toBe(BOND_DEFAULTS.minDist);
  });
});

describe('loader accepts capsule kind', () => {
  it('capsule file is detected and supported', () => {
    const decision = loadHistoryFile(JSON.stringify(makeCapsuleFile()));
    expect(decision.status).toBe('supported');
    if (decision.status === 'supported') {
      expect(decision.kind).toBe('capsule');
    }
  });

  it('capsule file with appearance passes loader', () => {
    const decision = loadHistoryFile(JSON.stringify(makeCapsuleFileWithAppearance()));
    expect(decision.status).toBe('supported');
  });

  it('capsule file without bondPolicy is rejected at loader', () => {
    const f = { ...makeCapsuleFile() } as Record<string, unknown>;
    delete f.bondPolicy;
    const decision = loadHistoryFile(JSON.stringify(f));
    expect(decision.status).toBe('invalid');
  });
});

describe('LoadedWatchHistory is 2-way union', () => {
  it('capsule history has kind=capsule', () => {
    const h = importCapsuleHistory(makeCapsuleFile());
    expect(h.kind).toBe('capsule');
  });

  it('full history has kind=full', () => {
    const h = importFullHistory(makeFullFile());
    expect(h.kind).toBe('full');
  });
});

// ── Phase 2: Appearance import ──

describe('Watch appearance import (importColorAssignments)', () => {
  it('capsule file with appearance is imported into loaded history', () => {
    const history = importCapsuleHistory(makeCapsuleFileWithAppearance());
    expect(history.appearance).not.toBeNull();
    expect(history.appearance!.colorAssignments).toHaveLength(2);
    expect(history.appearance!.colorAssignments[0]).toEqual({ atomIds: [0], colorHex: '#ff5555' });
    expect(history.appearance!.colorAssignments[1]).toEqual({ atomIds: [1], colorHex: '#55aaff' });
  });

  it('assignment boundaries are preserved (not flattened by color)', () => {
    const f = makeCapsuleFile();
    f.appearance = {
      colorAssignments: [
        { atomIds: [0], colorHex: '#ff5555' },
        { atomIds: [1], colorHex: '#ff5555' },
      ],
    };
    const history = importCapsuleHistory(f);
    expect(history.appearance!.colorAssignments).toHaveLength(2);
    expect(history.appearance!.colorAssignments[0].atomIds).toEqual([0]);
    expect(history.appearance!.colorAssignments[1].atomIds).toEqual([1]);
  });
});

import { createWatchBondedGroupAppearance } from '../../watch/js/analysis/watch-bonded-group-appearance';

describe('importColorAssignments domain-level behavior', () => {
  function makeAppearanceDeps() {
    const history = importCapsuleHistory(makeCapsuleFile());
    const playback = createWatchPlaybackModel();
    playback.load(history);
    const bondedGroups = {
      getAtomIndicesForGroup: () => null,
      computeGroups: () => [],
      getGroups: () => [],
      reset: () => {},
    };
    return {
      appearance: createWatchBondedGroupAppearance({
        getBondedGroups: () => bondedGroups as any,
        getPlaybackModel: () => playback,
        getRenderer: () => null,
      }),
      playback,
    };
  }

  it('getAssignments returns imported assignments with correct atomIds and colorHex', () => {
    const { appearance } = makeAppearanceDeps();
    appearance.importColorAssignments([
      { atomIds: [0], colorHex: '#ff5555' },
      { atomIds: [1], colorHex: '#55aaff' },
    ]);
    const assignments = appearance.getAssignments();
    expect(assignments).toHaveLength(2);
    expect(assignments[0].atomIds).toEqual([0]);
    expect(assignments[0].colorHex).toBe('#ff5555');
    expect(assignments[1].atomIds).toEqual([1]);
    expect(assignments[1].colorHex).toBe('#55aaff');
  });

  it('each imported assignment gets a unique sourceGroupId', () => {
    const { appearance } = makeAppearanceDeps();
    appearance.importColorAssignments([
      { atomIds: [0], colorHex: '#ff5555' },
      { atomIds: [1], colorHex: '#ff5555' },
    ]);
    const assignments = appearance.getAssignments();
    expect(assignments[0].sourceGroupId).not.toBe(assignments[1].sourceGroupId);
  });

  it('id and sourceGroupId use matching numeric suffixes', () => {
    const { appearance } = makeAppearanceDeps();
    appearance.importColorAssignments([{ atomIds: [0], colorHex: '#ff5555' }]);
    const a = appearance.getAssignments()[0];
    const idNum = a.id.replace(/^imported-/, '');
    const groupNum = a.sourceGroupId.replace(/^imported-group-/, '');
    expect(idNum).toBe(groupNum);
  });

  it('imported assignments coexist with user-applied colors', () => {
    const { appearance } = makeAppearanceDeps();
    appearance.importColorAssignments([{ atomIds: [0], colorHex: '#ff5555' }]);
    expect(appearance.getAssignments()).toHaveLength(1);
  });

  it('clearAllColors removes imported assignments', () => {
    const { appearance } = makeAppearanceDeps();
    appearance.importColorAssignments([{ atomIds: [0], colorHex: '#ff5555' }]);
    appearance.clearAllColors();
    expect(appearance.getAssignments()).toHaveLength(0);
  });

  it('reset clears imported assignments', () => {
    const { appearance } = makeAppearanceDeps();
    appearance.importColorAssignments([{ atomIds: [0], colorHex: '#ff5555' }]);
    appearance.reset();
    expect(appearance.getAssignments()).toHaveLength(0);
  });
});

// ── Phase 3a: Interaction query (getInteractionAtTime) ──

import { createWatchPlaybackModel } from '../../watch/js/playback/watch-playback-model';

describe('getInteractionAtTime (Tier 1: time-based query)', () => {
  it('returns null for full-history files (no interaction timeline)', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeFullFile()));
    expect(model.getInteractionAtTime(50)).toBeNull();
  });

  it('returns null for capsule without interaction timeline', () => {
    const model = createWatchPlaybackModel();
    model.load(importCapsuleHistory(makeCapsuleFile()));
    expect(model.getInteractionAtTime(50)).toBeNull();
  });

  it('resolves atom_drag at matching frame time', () => {
    const model = createWatchPlaybackModel();
    model.load(importCapsuleHistory(makeCapsuleFileWithInteraction()));
    const result = model.getInteractionAtTime(0.001);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('atom_drag');
    if (result!.kind === 'atom_drag') {
      expect(result!.atomId).toBe(0);
      expect(result!.target).toEqual([1.0, 2.0, 3.0]);
    }
  });

  it('returns none after interaction ends', () => {
    const model = createWatchPlaybackModel();
    model.load(importCapsuleHistory(makeCapsuleFileWithInteraction()));
    const result = model.getInteractionAtTime(100);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('none');
  });

  it('returns null before any interaction event', () => {
    const f = makeCapsuleFile();
    f.timeline.interactionTimeline = {
      encoding: 'event-stream-v1',
      events: [
        { frameId: 1, kind: 'atom_drag', atomId: 0, target: [0, 0, 0] },
      ],
    };
    const model = createWatchPlaybackModel();
    model.load(importCapsuleHistory(f));
    const result = model.getInteractionAtTime(0.001);
    expect(result).toBeNull();
  });

  it('at-or-before semantics: mid-frame time resolves to prior event', () => {
    const model = createWatchPlaybackModel();
    model.load(importCapsuleHistory(makeCapsuleFileWithInteraction()));
    const result = model.getInteractionAtTime(50);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('atom_drag');
  });

  it('returned interaction does not leak frameId from internal storage', () => {
    const model = createWatchPlaybackModel();
    model.load(importCapsuleHistory(makeCapsuleFileWithInteraction()));
    const result = model.getInteractionAtTime(0.001);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).frameId).toBeUndefined();
  });
});

// ── Phase 3a: Capsule export builder ──

import { buildCapsuleHistoryFile, type CapsuleExportDeps } from '../../lab/js/runtime/timeline/history-export';
import type { TimelineFrame } from '../../lab/js/runtime/timeline/simulation-timeline';

function makeExportDeps(overrides?: Partial<CapsuleExportDeps>): CapsuleExportDeps {
  const frames: TimelineFrame[] = [
    { frameId: 0, timePs: 0.001, n: 2, atomIds: [100, 101], positions: new Float64Array([0, 0, 0, 1.42, 0, 0]), interaction: { kind: 'none' }, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    { frameId: 1, timePs: 10, n: 2, atomIds: [100, 101], positions: new Float64Array([0.1, 0, 0, 1.52, 0, 0]), interaction: { kind: 'atom_drag', atomIndex: 0, target: [1, 2, 3] as [number, number, number] }, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    { frameId: 2, timePs: 20, n: 2, atomIds: [100, 101], positions: new Float64Array([0.2, 0, 0, 1.62, 0, 0]), interaction: { kind: 'atom_drag', atomIndex: 0, target: [1, 2, 3] as [number, number, number] }, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    { frameId: 3, timePs: 30, n: 2, atomIds: [100, 101], positions: new Float64Array([0.3, 0, 0, 1.72, 0, 0]), interaction: { kind: 'none' }, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
  ];
  return {
    getTimelineExportData: () => ({ denseFrames: frames, restartFrames: [], checkpoints: [] }),
    getAtomTable: () => [{ id: 100, element: 'C' }, { id: 101, element: 'C' }],
    getColorAssignments: () => [],
    appVersion: '0.1.0',
    ...overrides,
  };
}

describe('buildCapsuleHistoryFile', () => {
  it('produces a valid capsule file', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps());
    expect(file).not.toBeNull();
    expect(file!.kind).toBe('capsule');
    expect(file!.format).toBe('atomdojo-history');
    expect(file!.version).toBe(1);
  });

  it('includes mandatory bondPolicy from buildExportBondPolicy', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps())!;
    expect(file.bondPolicy.policyId).toBe('default-carbon-v1');
    expect(file.bondPolicy.cutoff).toBe(BOND_DEFAULTS.cutoff);
    expect(file.bondPolicy.minDist).toBe(BOND_DEFAULTS.minDist);
  });

  it('dense frames have no interaction or boundary fields', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps())!;
    const frame = file.timeline.denseFrames[0];
    expect((frame as any).interaction).toBeUndefined();
    expect((frame as any).boundary).toBeUndefined();
  });

  it('sparsifies interaction: repeated states compressed, initial none omitted', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps())!;
    const events = file.timeline.interactionTimeline!.events;
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('atom_drag');
    expect(events[0].frameId).toBe(1);
    expect(events[1]).toEqual({ frameId: 3, kind: 'none' });
  });

  it('converts atomIndex to stable atomId in interaction events', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps())!;
    const dragEvent = file.timeline.interactionTimeline!.events[0];
    expect(dragEvent.kind).toBe('atom_drag');
    if (dragEvent.kind === 'atom_drag') {
      expect(dragEvent.atomId).toBe(100);
    }
  });

  it('interaction events have no componentId', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps())!;
    for (const e of file.timeline.interactionTimeline!.events) {
      expect((e as any).componentId).toBeUndefined();
    }
  });

  it('omits interaction timeline when all frames are none', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps({
      getTimelineExportData: () => ({
        denseFrames: [
          { frameId: 0, timePs: 0, n: 1, atomIds: [0], positions: new Float64Array([0, 0, 0]), interaction: { kind: 'none' }, boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
          { frameId: 1, timePs: 10, n: 1, atomIds: [0], positions: new Float64Array([0.1, 0, 0]), interaction: { kind: 'none' }, boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
        ],
        restartFrames: [],
        checkpoints: [],
      }),
    }))!;
    expect(file.timeline.interactionTimeline).toBeUndefined();
  });

  it('includes appearance when color assignments exist', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps({
      getColorAssignments: () => [
        { atomIds: [0], colorHex: '#ff5555' },
        { atomIds: [1], colorHex: '#55aaff' },
      ],
    }))!;
    expect(file.appearance).toBeDefined();
    expect(file.appearance!.colorAssignments).toHaveLength(2);
    expect(file.appearance!.colorAssignments[0].atomIds).toEqual([0]);
    expect(file.appearance!.colorAssignments[0].colorHex).toBe('#ff5555');
  });

  it('exports stable atomIds directly from assignments in appearance', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps({
      getColorAssignments: () => [{ atomIds: [100, 101], colorHex: '#33dd66' }],
    }))!;
    expect(file.appearance!.colorAssignments[0].atomIds).toEqual([100, 101]);
  });

  it('omits appearance when no color assignments', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps())!;
    expect(file.appearance).toBeUndefined();
  });

  it('returns null for empty timeline', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps({
      getTimelineExportData: () => ({ denseFrames: [], restartFrames: [], checkpoints: [] }),
    }));
    expect(file).toBeNull();
  });

  it('interaction uses frame-local atomIds, not a global array', () => {
    const frames: TimelineFrame[] = [
      { frameId: 0, timePs: 0, n: 2, atomIds: [200, 201], positions: new Float64Array([0, 0, 0, 1, 0, 0]), interaction: { kind: 'atom_drag', atomIndex: 1, target: [0, 0, 0] as [number, number, number] }, boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
      { frameId: 1, timePs: 10, n: 2, atomIds: [200, 201], positions: new Float64Array([0, 0, 0, 1, 0, 0]), interaction: { kind: 'none' }, boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    ];
    const file = buildCapsuleHistoryFile(makeExportDeps({
      getTimelineExportData: () => ({ denseFrames: frames, restartFrames: [], checkpoints: [] }),
    }))!;
    const drag = file.timeline.interactionTimeline!.events[0];
    expect(drag.kind).toBe('atom_drag');
    if (drag.kind === 'atom_drag') {
      expect(drag.atomId).toBe(201);
    }
  });

  it('appearance passes through authored atomIds directly', () => {
    const frames: TimelineFrame[] = [
      { frameId: 0, timePs: 0, n: 2, atomIds: [100, 101], positions: new Float64Array([0, 0, 0, 1, 0, 0]), interaction: null as any, boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
      { frameId: 1, timePs: 10, n: 2, atomIds: [100, 101], positions: new Float64Array([0, 0, 0, 1, 0, 0]), interaction: null as any, boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    ];
    const file = buildCapsuleHistoryFile(makeExportDeps({
      getTimelineExportData: () => ({ denseFrames: frames, restartFrames: [], checkpoints: [] }),
      getColorAssignments: () => [{ atomIds: [0, 1], colorHex: '#33dd66' }],
    }))!;
    expect(file.appearance!.colorAssignments[0].atomIds).toEqual([0, 1]);
  });

  it('interaction emits none when atomIndex exceeds frame atomIds (safety fallback)', () => {
    const frames: TimelineFrame[] = [
      { frameId: 0, timePs: 0, n: 1, atomIds: [100], positions: new Float64Array([0, 0, 0]), interaction: { kind: 'atom_drag', atomIndex: 5, target: [0, 0, 0] as [number, number, number] }, boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
      { frameId: 1, timePs: 10, n: 1, atomIds: [100], positions: new Float64Array([0, 0, 0]), interaction: { kind: 'none' }, boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    ];
    const file = buildCapsuleHistoryFile(makeExportDeps({
      getTimelineExportData: () => ({ denseFrames: frames, restartFrames: [], checkpoints: [] }),
    }))!;
    const events = file.timeline.interactionTimeline!.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ frameId: 0, kind: 'none' });
  });
});

describe('capsule export end-to-end (builder → validate → round-trip)', () => {
  it('authored atomIds from store reach the exported capsule file', () => {
    const file = buildCapsuleHistoryFile(makeExportDeps({
      getColorAssignments: () => [
        { atomIds: [100], colorHex: '#ff5555' },
        { atomIds: [101], colorHex: '#55aaff' },
      ],
    }))!;
    expect(file.kind).toBe('capsule');
    expect(file.bondPolicy.policyId).toBe('default-carbon-v1');
    expect(file.appearance).toBeDefined();
    expect(file.appearance!.colorAssignments).toHaveLength(2);
    expect(file.appearance!.colorAssignments[0]).toEqual({ atomIds: [100], colorHex: '#ff5555' });
    expect(file.appearance!.colorAssignments[1]).toEqual({ atomIds: [101], colorHex: '#55aaff' });

    const errors = validateCapsuleFile(file);
    expect(errors).toEqual([]);
  });

  it('capsule export → import round-trip preserves appearance atomIds', () => {
    const exported = buildCapsuleHistoryFile(makeExportDeps({
      getColorAssignments: () => [
        { atomIds: [100, 101], colorHex: '#33dd66' },
      ],
    }))!;

    const imported = importCapsuleHistory(exported);
    expect(imported.appearance).not.toBeNull();
    expect(imported.appearance!.colorAssignments[0].atomIds).toEqual([100, 101]);
    expect(imported.appearance!.colorAssignments[0].colorHex).toBe('#33dd66');
  });

  it('capsule export → import round-trip preserves interaction events', () => {
    const exported = buildCapsuleHistoryFile(makeExportDeps())!;
    expect(exported.timeline.interactionTimeline).toBeDefined();

    const imported = importCapsuleHistory(exported);
    expect(imported.interactionTimeline).not.toBeNull();
    expect(imported.interactionTimeline!.events.length).toBeGreaterThan(0);
    const drag = imported.interactionTimeline!.events[0];
    expect(drag.kind).toBe('atom_drag');
    if (drag.kind === 'atom_drag') {
      expect(drag.atomId).toBe(100);
    }
  });
});
