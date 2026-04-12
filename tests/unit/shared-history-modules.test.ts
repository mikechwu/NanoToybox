/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the shared history modules:
 *   - src/history/history-file-v1.ts (detection + validation)
 *   - src/history/connected-components.ts
 *   - src/history/bonded-group-projection.ts
 *
 * Also tests watch-side modules:
 *   - watch/js/history-file-loader.ts (load decision)
 *   - watch/js/full-history-import.ts (normalization)
 *   - watch/js/watch-playback-model.ts (sampling)
 *   - watch/js/watch-bonded-groups.ts (group tracking)
 */

import { describe, it, expect } from 'vitest';
import { detectHistoryFile, validateFullHistoryFile, type AtomDojoHistoryFileV1 } from '../../src/history/history-file-v1';
import { computeConnectedComponents } from '../../src/history/connected-components';
import { createBondedGroupProjection } from '../../src/history/bonded-group-projection';
import { loadHistoryFile } from '../../watch/js/history-file-loader';
import { importFullHistory } from '../../watch/js/full-history-import';
import { createWatchPlaybackModel } from '../../watch/js/watch-playback-model';
import { createWatchBondedGroups } from '../../watch/js/watch-bonded-groups';

// ── Fixtures ──

function makeMinimalFullFile(overrides?: Partial<AtomDojoHistoryFileV1>): AtomDojoHistoryFileV1 {
  return {
    format: 'atomdojo-history',
    version: 1,
    kind: 'full',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-06T00:00:00Z' },
    simulation: {
      title: null, description: null,
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2, durationPs: 100, frameCount: 2, indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0], interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.1, 0, 0, 1.1, 0, 0], interaction: null, boundary: {} },
      ],
      restartFrames: [
        {
          frameId: 0, timePs: 0, n: 2, atomIds: [0, 1],
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
    ...overrides,
  };
}

// ── detectHistoryFile ──

describe('detectHistoryFile', () => {
  it('detects a valid full file', () => {
    const result = detectHistoryFile(makeMinimalFullFile());
    expect(result.format).toBe('atomdojo-history');
    if (result.format === 'atomdojo-history') {
      expect(result.version).toBe(1);
      expect(result.kind).toBe('full');
    }
  });

  it('rejects non-object', () => {
    expect(detectHistoryFile('hello').format).toBe('unknown');
    expect(detectHistoryFile(null).format).toBe('unknown');
  });

  it('rejects wrong format', () => {
    const result = detectHistoryFile({ format: 'other', version: 1, kind: 'full' });
    expect(result.format).toBe('unknown');
  });
});

// ── validateFullHistoryFile ──

describe('validateFullHistoryFile (shared)', () => {
  it('validates a correct minimal file', () => {
    expect(validateFullHistoryFile(makeMinimalFullFile())).toEqual([]);
  });

  it('catches maxAtomCount > atom table', () => {
    const file = makeMinimalFullFile();
    file.simulation.maxAtomCount = 10;
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('maxAtomCount'))).toBe(true);
  });
});

// ── computeConnectedComponents ──

describe('computeConnectedComponents', () => {
  it('returns singletons when no bonds', () => {
    const result = computeConnectedComponents(3, []);
    expect(result).toHaveLength(3);
    expect(result.every(c => c.size === 1)).toBe(true);
  });

  it('groups bonded atoms', () => {
    const result = computeConnectedComponents(4, [[0, 1, 1.0], [2, 3, 1.0]]);
    expect(result).toHaveLength(2);
    const sizes = result.map(c => c.size).sort();
    expect(sizes).toEqual([2, 2]);
  });

  it('handles a single connected component', () => {
    const result = computeConnectedComponents(3, [[0, 1, 1.0], [1, 2, 1.0]]);
    expect(result).toHaveLength(1);
    expect(result[0].size).toBe(3);
  });

  it('returns empty for n=0', () => {
    expect(computeConnectedComponents(0, [])).toEqual([]);
  });
});

// ── createBondedGroupProjection ──

describe('createBondedGroupProjection', () => {
  it('projects components into summaries', () => {
    const proj = createBondedGroupProjection();
    const result = proj.project({
      components: [
        { atoms: [0, 1, 2], size: 3 },
        { atoms: [3, 4], size: 2 },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0].atomCount).toBe(3); // largest first
    expect(result[1].atomCount).toBe(2);
    expect(result[0].displayIndex).toBe(1);
    expect(result[1].displayIndex).toBe(2);
  });

  it('reconciles stable IDs across projections', () => {
    const proj = createBondedGroupProjection();
    const first = proj.project({ components: [{ atoms: [0, 1, 2], size: 3 }] });
    const id1 = first[0].id;
    // Same component — should keep same ID
    const second = proj.project({ components: [{ atoms: [0, 1, 2], size: 3 }] });
    expect(second[0].id).toBe(id1);
  });

  it('returns atom indices for groups', () => {
    const proj = createBondedGroupProjection();
    proj.project({ components: [{ atoms: [5, 6, 7], size: 3 }] });
    const atoms = proj.getAtomIndicesForGroup(proj.project({ components: [{ atoms: [5, 6, 7], size: 3 }] })[0].id);
    expect(atoms).toEqual([5, 6, 7]);
  });
});

// ── loadHistoryFile (watch loader) ──

describe('loadHistoryFile', () => {
  it('supports a valid full file', () => {
    const result = loadHistoryFile(JSON.stringify(makeMinimalFullFile()));
    expect(result.status).toBe('supported');
    if (result.status === 'supported') {
      expect(result.kind).toBe('full');
    }
  });

  it('rejects invalid JSON', () => {
    const result = loadHistoryFile('not json');
    expect(result.status).toBe('invalid');
  });

  it('rejects unknown format', () => {
    const result = loadHistoryFile(JSON.stringify({ format: 'other' }));
    expect(result.status).toBe('invalid');
  });

  it('reports replay as unsupported', () => {
    const file = makeMinimalFullFile();
    (file as any).kind = 'replay';
    const result = loadHistoryFile(JSON.stringify(file));
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.kind).toBe('replay');
    }
  });

  it('reports version 2 as unsupported', () => {
    const file = makeMinimalFullFile();
    (file as any).version = 2;
    const result = loadHistoryFile(JSON.stringify(file));
    expect(result.status).toBe('unsupported');
  });
});

// ── importFullHistory ──

describe('importFullHistory', () => {
  it('converts positions to Float64Array', () => {
    const history = importFullHistory(makeMinimalFullFile());
    expect(history.denseFrames[0].positions).toBeInstanceOf(Float64Array);
    expect(history.restartFrames[0].positions).toBeInstanceOf(Float64Array);
    expect(history.restartFrames[0].velocities).toBeInstanceOf(Float64Array);
  });

  it('converts bonds to tuple form', () => {
    const history = importFullHistory(makeMinimalFullFile());
    expect(history.restartFrames[0].bonds[0]).toEqual([0, 1, 1.42]);
  });

  it('computes restartAlignedToDense correctly', () => {
    const history = importFullHistory(makeMinimalFullFile());
    expect(history.restartAlignedToDense).toBe(true);
  });

  it('sets restartAlignedToDense false when counts differ', () => {
    const file = makeMinimalFullFile();
    file.timeline.restartFrames = [file.timeline.restartFrames[0]]; // only 1 restart vs 2 dense
    const history = importFullHistory(file);
    expect(history.restartAlignedToDense).toBe(false);
  });
});

// ── createWatchPlaybackModel ──

describe('createWatchPlaybackModel', () => {
  it('returns null when not loaded', () => {
    const model = createWatchPlaybackModel();
    expect(model.getDisplayPositionsAtTime(0)).toBeNull();
    expect(model.getTopologyAtTime(0)).toBeNull();
  });

  it('returns frame data after load', () => {
    const model = createWatchPlaybackModel();
    const history = importFullHistory(makeMinimalFullFile());
    model.load(history);
    const pos = model.getDisplayPositionsAtTime(0);
    expect(pos).not.toBeNull();
    expect(pos!.n).toBe(2);
    expect(pos!.positions).toBeInstanceOf(Float64Array);
  });

  it('returns stepwise nearest frame at or before time', () => {
    const model = createWatchPlaybackModel();
    const history = importFullHistory(makeMinimalFullFile());
    model.load(history);
    // At time 50, should return frame at time 0 (no frame at 50)
    const pos = model.getDisplayPositionsAtTime(50);
    expect(pos).not.toBeNull();
    // At time 100, should return frame at time 100
    const pos2 = model.getDisplayPositionsAtTime(100);
    expect(pos2).not.toBeNull();
  });

  it('returns topology from restart frames', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    const topo = model.getTopologyAtTime(0);
    expect(topo).not.toBeNull();
    expect(topo!.bonds).toEqual([[0, 1, 1.42]]);
  });

  it('unload clears state', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    model.unload();
    expect(model.getDisplayPositionsAtTime(0)).toBeNull();
  });
});

// ── createWatchBondedGroups ──

describe('createWatchBondedGroups', () => {
  it('computes groups from topology', () => {
    const groups = createWatchBondedGroups();
    const summaries = groups.updateForTime(0, { bonds: [[0, 1, 1.42]], n: 2, frameId: 0 });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].atomCount).toBe(2);
  });

  it('returns empty for null topology', () => {
    const groups = createWatchBondedGroups();
    const summaries = groups.updateForTime(0, null);
    expect(summaries).toHaveLength(0);
  });

  it('reconciles IDs across updates', () => {
    const groups = createWatchBondedGroups();
    const s1 = groups.updateForTime(0, { bonds: [[0, 1, 1.42]], n: 2, frameId: 0 });
    const id1 = s1[0].id;
    const s2 = groups.updateForTime(1, { bonds: [[0, 1, 1.42]], n: 2, frameId: 0 });
    expect(s2[0].id).toBe(id1);
  });
});

// ── Additional edge cases (from coverage audit) ──

describe('bsearchAtOrBefore edge cases', () => {
  it('returns null for time before first frame', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    expect(model.getDisplayPositionsAtTime(-1)).toBeNull();
    expect(model.getTopologyAtTime(-1)).toBeNull();
  });

  it('returns last frame for time after last frame', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    const pos = model.getDisplayPositionsAtTime(999);
    expect(pos).not.toBeNull();
    expect(pos!.positions[0]).toBeCloseTo(0.1); // frame at time 100
  });

  it('getConfigAtTime returns config from restart frames', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    const config = model.getConfigAtTime(0) as any;
    expect(config).not.toBeNull();
    expect(config.damping).toBe(0.995);
    expect(config.dtFs).toBe(0.5);
  });

  it('getBoundaryAtTime returns boundary from dense frames', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    const boundary = model.getBoundaryAtTime(0);
    expect(boundary).not.toBeNull();
  });

  it('stepwise returns correct frame (time 50 → frame at 0)', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    const pos = model.getDisplayPositionsAtTime(50);
    expect(pos).not.toBeNull();
    expect(pos!.positions[0]).toBeCloseTo(0); // frame at time 0, not time 100
  });
});

describe('validateFullHistoryFile additional error paths', () => {
  it('catches frameCount mismatch', () => {
    const file = makeMinimalFullFile();
    file.simulation.frameCount = 99;
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('frameCount'))).toBe(true);
  });

  it('catches positions length mismatch', () => {
    const file = makeMinimalFullFile();
    file.timeline.denseFrames[0].positions = [0, 0]; // should be n*3 = 6
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('positions.length'))).toBe(true);
  });

  it('catches non-monotonic timePs', () => {
    const file = makeMinimalFullFile();
    file.timeline.denseFrames[1].timePs = -1; // before frame 0
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('timePs'))).toBe(true);
  });
});

describe('detectHistoryFile edge cases', () => {
  it('handles missing version/kind fields', () => {
    const result = detectHistoryFile({ format: 'atomdojo-history' });
    expect(result.format).toBe('atomdojo-history');
    if (result.format === 'atomdojo-history') {
      expect(result.version).toBe(-1);
      expect(result.kind).toBe('unknown');
    }
  });
});

describe('computeConnectedComponents edge cases', () => {
  it('ignores out-of-range bond indices', () => {
    const result = computeConnectedComponents(2, [[0, 5, 1.0]]);
    expect(result).toHaveLength(2);
    expect(result.every(c => c.size === 1)).toBe(true);
  });
});

describe('projection and bonded-groups reset', () => {
  it('projection reset clears previous groups so reconciliation starts fresh', () => {
    const proj = createBondedGroupProjection();
    // Project two groups
    proj.project({ components: [{ atoms: [0, 1], size: 2 }, { atoms: [2, 3], size: 2 }] });
    // After reset, getAtomIndicesForGroup should return null
    proj.reset();
    expect(proj.getAtomIndicesForGroup('g1')).toBeNull();
    expect(proj.getAtomIndicesForGroup('g2')).toBeNull();
    // New projection should work cleanly
    const after = proj.project({ components: [{ atoms: [5, 6, 7], size: 3 }] });
    expect(after).toHaveLength(1);
    expect(after[0].atomCount).toBe(3);
  });

  it('watchBondedGroups reset clears summaries', () => {
    const groups = createWatchBondedGroups();
    groups.updateForTime(0, { bonds: [[0, 1, 1.0]], n: 2, frameId: 0 });
    expect(groups.getSummaries()).toHaveLength(1);
    groups.reset();
    expect(groups.getSummaries()).toHaveLength(0);
  });

  it('watchBondedGroups handles n=0 topology', () => {
    const groups = createWatchBondedGroups();
    const summaries = groups.updateForTime(0, { bonds: [], n: 0, frameId: 0 });
    expect(summaries).toHaveLength(0);
  });
});

describe('validateFullHistoryFile per-frame shape guard', () => {
  it('rejects malformed dense frame entries without throwing', () => {
    const file = makeMinimalFullFile();
    (file.timeline.denseFrames as any)[0] = 'not an object';
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('denseFrame[0] is not an object'))).toBe(true);
  });

  it('rejects dense frame with missing positions array', () => {
    const file = makeMinimalFullFile();
    (file.timeline.denseFrames[0] as any).positions = 'not-array';
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('positions must be an array'))).toBe(true);
  });

  it('rejects checkpoint with missing physics', () => {
    const file = makeMinimalFullFile();
    file.timeline.checkpoints = [{ checkpointId: 0, timePs: 0 } as any];
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('missing physics'))).toBe(true);
  });

  it('rejects malformed bond entries without throwing', () => {
    const file = makeMinimalFullFile();
    (file.timeline.restartFrames[0].bonds as any) = ['not-an-object', null, 42];
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('bond[0] is not an object'))).toBe(true);
  });

  it('handles malformed entry followed by valid entry (prev tracking)', () => {
    const file = makeMinimalFullFile();
    // Insert a malformed entry before the valid ones
    (file.timeline.denseFrames as any).unshift('garbage');
    file.simulation.frameCount = 3;
    const errors = validateFullHistoryFile(file);
    // Should report the malformed entry but not crash on monotonic checks for the next entry
    expect(errors.some(e => e.includes('denseFrame[0] is not an object'))).toBe(true);
    // The valid entries after should still be validated (no cascade crash)
    expect(() => validateFullHistoryFile(file)).not.toThrow();
  });
});

describe('validateFullHistoryFile simulation + atom guards', () => {
  it('rejects non-numeric simulation fields', () => {
    const file = makeMinimalFullFile();
    (file.simulation as any).maxAtomCount = 'x';
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('maxAtomCount must be a finite number'))).toBe(true);
  });

  it('rejects malformed atom table entries', () => {
    const file = makeMinimalFullFile();
    (file.atoms.atoms as any)[0] = null;
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('atoms.atoms[0] is not an object'))).toBe(true);
  });

  it('rejects atom entry with non-number id', () => {
    const file = makeMinimalFullFile();
    (file.atoms.atoms[0] as any).id = 'bad';
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('id must be a number'))).toBe(true);
  });

  it('rejects atom entry with non-string element', () => {
    const file = makeMinimalFullFile();
    (file.atoms.atoms[0] as any).element = 42;
    const errors = validateFullHistoryFile(file);
    expect(errors.some(e => e.includes('element must be a string'))).toBe(true);
  });
});

describe('playback model time clamping', () => {
  it('clamps time to valid range', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    const start = model.getStartTimePs();
    const end = model.getEndTimePs();

    model.setCurrentTimePs(-999);
    expect(model.getCurrentTimePs()).toBe(start);

    model.setCurrentTimePs(999999);
    expect(model.getCurrentTimePs()).toBe(end);
  });

  it('handles NaN gracefully', () => {
    const model = createWatchPlaybackModel();
    model.load(importFullHistory(makeMinimalFullFile()));
    model.setCurrentTimePs(NaN);
    expect(Number.isFinite(model.getCurrentTimePs())).toBe(true);
  });
});

describe('validateFullHistoryFile structural guard', () => {
  it('rejects malformed envelope without crashing', () => {
    const errors = validateFullHistoryFile({ format: 'atomdojo-history', version: 1, kind: 'full' } as any);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('missing'))).toBe(true);
  });

  it('rejects null input', () => {
    const errors = validateFullHistoryFile(null as any);
    expect(errors).toEqual(['file is not an object']);
  });
});

describe('loadHistoryFile handles malformed file gracefully', () => {
  it('returns invalid for structurally malformed full file (missing internals)', () => {
    const malformed = { format: 'atomdojo-history', version: 1, kind: 'full' };
    const result = loadHistoryFile(JSON.stringify(malformed));
    expect(result.status).toBe('invalid');
  });

  it('returns invalid instead of throwing for null internals', () => {
    const malformed = JSON.stringify({
      format: 'atomdojo-history',
      version: 1,
      kind: 'full',
      atoms: null,
      timeline: null,
      simulation: null,
    });
    expect(() => loadHistoryFile(malformed)).not.toThrow();
    const result = loadHistoryFile(malformed);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors.some(e => e.includes('missing'))).toBe(true);
    }
  });

  it('returns invalid for partial internals (atoms present but timeline missing)', () => {
    const malformed = JSON.stringify({
      format: 'atomdojo-history',
      version: 1,
      kind: 'full',
      simulation: { maxAtomCount: 2, durationPs: 0, frameCount: 0, indexingModel: 'dense-prefix', units: { time: 'ps', length: 'angstrom' } },
      atoms: { atoms: [{ id: 0, element: 'C' }] },
      timeline: { denseFrames: 'not-an-array' },
    });
    const result = loadHistoryFile(malformed);
    expect(result.status).toBe('invalid');
  });
});

describe('loadHistoryFile validation failure path', () => {
  it('returns invalid when file passes detection but fails validation', () => {
    const file = makeMinimalFullFile();
    file.simulation.maxAtomCount = 999;
    const result = loadHistoryFile(JSON.stringify(file));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors[0]).toContain('maxAtomCount');
    }
  });
});

describe('importFullHistory checkpoint normalization', () => {
  it('normalizes checkpoint positions to Float64Array and bonds to tuples', () => {
    const file = makeMinimalFullFile();
    file.timeline.checkpoints = [{
      checkpointId: 0, timePs: 0,
      physics: {
        n: 2, atomIds: [0, 1],
        positions: [0, 0, 0, 1, 0, 0],
        velocities: [0, 0, 0, 0, 0, 0],
        bonds: [{ a: 0, b: 1, distance: 1.42 }],
      },
      config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 },
      interaction: null, boundary: {},
    }];
    const history = importFullHistory(file);
    expect(history.checkpoints).toHaveLength(1);
    expect(history.checkpoints[0].physics.positions).toBeInstanceOf(Float64Array);
    expect(history.checkpoints[0].physics.velocities).toBeInstanceOf(Float64Array);
    expect(history.checkpoints[0].physics.bonds[0]).toEqual([0, 1, 1.42]);
  });
});

describe('importFullHistory restartAlignedToDense time mismatch', () => {
  it('sets false when counts match but timestamps differ', () => {
    const file = makeMinimalFullFile();
    file.timeline.restartFrames[0].timePs = 50; // differs from dense frame 0 at time 0
    const history = importFullHistory(file);
    expect(history.restartAlignedToDense).toBe(false);
  });
});

// ── End-to-end: full pipeline ──

describe('end-to-end: load → import → playback → groups', () => {
  it('full pipeline produces valid playback with groups', () => {
    const text = JSON.stringify(makeMinimalFullFile());

    // Load
    const decision = loadHistoryFile(text);
    expect(decision.status).toBe('supported');
    if (decision.status !== 'supported' || decision.kind !== 'full') return;

    // Import
    const history = importFullHistory(decision.file);
    expect(history.denseFrames).toHaveLength(2);
    expect(history.restartFrames).toHaveLength(2);

    // Playback model
    const model = createWatchPlaybackModel();
    model.load(history);

    // Sample at time 0
    const pos = model.getDisplayPositionsAtTime(0);
    expect(pos).not.toBeNull();
    expect(pos!.n).toBe(2);

    const topo = model.getTopologyAtTime(0);
    expect(topo).not.toBeNull();
    expect(topo!.bonds).toHaveLength(1);

    // Bonded groups
    const groups = createWatchBondedGroups();
    const summaries = groups.updateForTime(0, topo);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].atomCount).toBe(2);

    // Sample at time 100
    const pos2 = model.getDisplayPositionsAtTime(100);
    expect(pos2).not.toBeNull();
    expect(pos2!.positions[0]).toBeCloseTo(0.1);
  });
});
