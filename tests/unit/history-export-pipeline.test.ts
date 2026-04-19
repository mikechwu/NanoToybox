/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the history export pipeline:
 *   - atom identity tracker (append/compaction/capture)
 *   - atom metadata registry
 *   - history file builder (full envelope)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTimelineAtomIdentityTracker } from '../../lab/js/runtime/timeline/timeline-atom-identity';
import { createAtomMetadataRegistry } from '../../lab/js/runtime/timeline/atom-metadata-registry';
import { buildFullHistoryFile, validateFullHistoryFile } from '../../lab/js/runtime/timeline/history-export';
import type { TimelineExportData } from '../../lab/js/runtime/timeline/history-export';

// ── Atom identity tracker ──

describe('TimelineAtomIdentityTracker', () => {
  let tracker: ReturnType<typeof createTimelineAtomIdentityTracker>;
  beforeEach(() => { tracker = createTimelineAtomIdentityTracker(); });

  it('auto-assigns IDs for initial atoms on first capture', () => {
    const ids = tracker.captureForCurrentState(3);
    expect(ids).toEqual([0, 1, 2]);
  });

  it('assigns new IDs on append', () => {
    tracker.captureForCurrentState(2); // initial: [0, 1]
    const newIds = tracker.handleAppend(2, 3); // append 3 atoms at offset 2
    expect(newIds).toEqual([2, 3, 4]);
    const allIds = tracker.captureForCurrentState(5);
    expect(allIds).toEqual([0, 1, 2, 3, 4]);
  });

  it('updates mapping on compaction', () => {
    tracker.captureForCurrentState(4); // [0, 1, 2, 3]
    // Remove atoms at index 1 and 3 (keep 0 and 2)
    tracker.handleCompaction([0, 2]);
    const ids = tracker.captureForCurrentState(2);
    expect(ids).toEqual([0, 2]); // stable IDs preserved
  });

  it('assigns fresh IDs after compaction + new append', () => {
    tracker.captureForCurrentState(3); // [0, 1, 2]
    tracker.handleCompaction([0, 2]); // keep slots 0,2 → IDs [0, 2]
    const newIds = tracker.handleAppend(2, 1); // append 1 atom at offset 2
    expect(newIds).toEqual([3]); // next fresh ID
    const all = tracker.captureForCurrentState(3);
    expect(all).toEqual([0, 2, 3]);
  });

  it('reset clears all state', () => {
    tracker.captureForCurrentState(3);
    tracker.reset();
    expect(tracker.getTotalAssigned()).toBe(0);
    const ids = tracker.captureForCurrentState(2);
    expect(ids).toEqual([0, 1]); // fresh numbering
  });
});

// ── Atom metadata registry ──

describe('AtomMetadataRegistry', () => {
  let registry: ReturnType<typeof createAtomMetadataRegistry>;
  beforeEach(() => { registry = createAtomMetadataRegistry(); });

  it('registers and retrieves atom metadata', () => {
    registry.registerAppendedAtoms([0, 1], [{ element: 'C' }, { element: 'C' }]);
    const table = registry.getAtomTable();
    expect(table).toEqual([
      { id: 0, element: 'C' },
      { id: 1, element: 'C' },
    ]);
  });

  it('returns table sorted by id', () => {
    registry.registerAppendedAtoms([5, 2], [{ element: 'H' }, { element: 'O' }]);
    const table = registry.getAtomTable();
    expect(table[0].id).toBe(2);
    expect(table[1].id).toBe(5);
  });

  it('reset clears all entries', () => {
    registry.registerAppendedAtoms([0], [{ element: 'C' }]);
    registry.reset();
    expect(registry.getAtomTable()).toEqual([]);
  });
});

// ── Full history file builder ──

describe('buildFullHistoryFile', () => {
  function makeDeps(overrides?: Partial<Parameters<typeof buildFullHistoryFile>[0]>) {
    const defaultData: TimelineExportData = {
      denseFrames: [{
        frameId: 0, timePs: 0, n: 2, atomIds: [0, 1],
        positions: new Float64Array([0, 0, 0, 1, 0, 0]),
        interaction: null,
        boundary: { mode: 'contain', wallRadius: 12, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 } as any,
      }, {
        frameId: 1, timePs: 100, n: 2, atomIds: [0, 1],
        positions: new Float64Array([0.1, 0, 0, 1.1, 0, 0]),
        interaction: null,
        boundary: { mode: 'contain', wallRadius: 12, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 } as any,
      }],
      restartFrames: [{
        frameId: 0, timePs: 0, n: 2, atomIds: [0, 1],
        positions: new Float64Array([0, 0, 0, 1, 0, 0]),
        velocities: new Float64Array([0, 0, 0, 0, 0, 0]),
        bonds: [[0, 1, 1.42] as [number, number, number]],
        config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 },
        interaction: null,
        boundary: { mode: 'contain', wallRadius: 12, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 } as any,
      }],
      checkpoints: [],
    };
    return {
      getTimelineExportData: () => defaultData,
      getAtomTable: () => [{ id: 0, element: 'C' }, { id: 1, element: 'C' }],
      appVersion: '0.1.0',
      ...overrides,
    };
  }

  it('builds a valid v1 full envelope', () => {
    const file = buildFullHistoryFile(makeDeps());
    expect(file).not.toBeNull();
    expect(file!.format).toBe('atomdojo-history');
    expect(file!.version).toBe(1);
    expect(file!.kind).toBe('full');
  });

  it('computes correct simulation metadata', () => {
    const file = buildFullHistoryFile(makeDeps())!;
    expect(file.simulation.frameCount).toBe(2);
    expect(file.simulation.durationPs).toBe(100);
    expect(file.simulation.maxAtomCount).toBe(2);
    expect(file.simulation.indexingModel).toBe('dense-prefix');
  });

  it('converts Float64Array to number[]', () => {
    const file = buildFullHistoryFile(makeDeps())!;
    const positions = file.timeline.denseFrames[0].positions;
    expect(Array.isArray(positions)).toBe(true);
    expect(positions.length).toBe(6);
  });

  it('converts bond tuples to objects', () => {
    const file = buildFullHistoryFile(makeDeps())!;
    const bonds = file.timeline.restartFrames[0].bonds;
    expect(bonds[0]).toEqual({ a: 0, b: 1, distance: 1.42 });
  });

  it('includes atomIds in frames', () => {
    const file = buildFullHistoryFile(makeDeps())!;
    expect(file.timeline.denseFrames[0].atomIds).toEqual([0, 1]);
    expect(file.timeline.restartFrames[0].atomIds).toEqual([0, 1]);
  });

  it('includes dtFs and dampingRefDurationFs in config', () => {
    const file = buildFullHistoryFile(makeDeps())!;
    expect(file.timeline.restartFrames[0].config.dtFs).toBe(0.5);
    expect(file.timeline.restartFrames[0].config.dampingRefDurationFs).toBe(2.0);
  });

  it('strips boundary damping from exported frames', () => {
    const file = buildFullHistoryFile(makeDeps())!;
    const boundary = file.timeline.denseFrames[0].boundary as Record<string, unknown>;
    expect(boundary).not.toHaveProperty('damping');
    expect(boundary).toHaveProperty('mode');
  });

  it('returns null when no dense frames exist', () => {
    const file = buildFullHistoryFile(makeDeps({
      getTimelineExportData: () => ({ denseFrames: [], restartFrames: [], checkpoints: [] }),
    }));
    expect(file).toBeNull();
  });

  it('builds atom table from registry', () => {
    const file = buildFullHistoryFile(makeDeps())!;
    expect(file.atoms.atoms).toEqual([
      { id: 0, element: 'C', isotope: null, charge: null, label: null },
      { id: 1, element: 'C', isotope: null, charge: null, label: null },
    ]);
  });
});

// ── End-to-end: stop → restart → export validates ──

describe('full export after stop → restart lifecycle', () => {
  it('produces a valid file after stop and restart recording', async () => {
    const { createTimelineSubsystem } = await import('../../lab/js/runtime/timeline/timeline-subsystem');
    const { useAppStore } = await import('../../lab/js/store/app-store');
    const { vi } = await import('vitest');

    useAppStore.getState().resetTransientState();

    const n = 10;
    const pos = new Float64Array(n * 3);
    const vel = new Float64Array(n * 3);
    for (let i = 0; i < pos.length; i++) { pos[i] = i * 0.1; vel[i] = i * 0.01; }

    const physics = {
      n, pos, vel,
      dragAtom: -1, isRotateMode: false, isTranslateMode: false,
      activeComponent: -1, dragTarget: [0, 0, 0],
      getBonds: () => [] as number[][],
      getDamping: () => 0, getDragStrength: () => 2, getRotateStrength: () => 5,
      getWallMode: () => 'contain',
      getDtFs: () => 0.5,
      getBoundarySnapshot: () => ({
        mode: 'contain' as const, wallRadius: 50,
        wallCenter: [0, 0, 0] as [number, number, number],
        wallCenterSet: true, removedCount: 0, damping: 0,
      }),
      restoreBoundarySnapshot: vi.fn(),
      createCheckpoint: function () { return { n: this.n, pos: new Float64Array(this.pos), vel: new Float64Array(this.vel), bonds: [] }; },
      restoreCheckpoint: vi.fn(),
      setDamping: vi.fn(), setDragStrength: vi.fn(), setRotateStrength: vi.fn(),
      endDrag: vi.fn(), computeForces: vi.fn(), refreshTopology: vi.fn(),
      updateBondList: vi.fn(), rebuildComponents: vi.fn(),
      setPhysicsRef: vi.fn(),
    } as any;

    const molecules = [{
      atomOffset: 0, atomCount: n,
      localAtoms: Array.from({ length: n }, () => ({ element: 'C' })),
      structureFile: 'c60.xyz', name: 'C60',
    }];

    const sub = createTimelineSubsystem({
      getPhysics: () => physics,
      getRenderer: () => ({
        getAtomCount: () => n, setAtomCount: vi.fn(),
        updateFromSnapshot: vi.fn(), updateReviewFrame: vi.fn(),
        setPhysicsRef: vi.fn(), clearFeedback: vi.fn(),
      }) as any,
      pause: vi.fn(), resume: vi.fn(), isPaused: () => false,
      reinitWorker: vi.fn(async () => {}), isWorkerActive: () => false,
      forceRender: vi.fn(),
      clearBondedGroupHighlight: vi.fn(), clearRendererFeedback: vi.fn(),
      syncBondedGroupsForDisplayFrame: vi.fn(),
      getSceneMolecules: () => molecules,
      exportHistory: vi.fn(async () => 'saved' as const),
      exportCapabilities: { full: true, capsule: true },
    });

    // Cycle 1: start, record, stop
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);
    sub.turnRecordingOff();

    // Cycle 2: restart, record
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    sub.recordAfterReconciliation(4);

    // Build and validate
    const snapshot = sub.getTimelineExportSnapshot();
    const atomTable = sub.getAtomMetadataRegistry().getAtomTable();
    expect(atomTable.length).toBeGreaterThan(0);

    const file = buildFullHistoryFile({
      getTimelineExportData: () => snapshot,
      getAtomTable: () => atomTable,
      appVersion: '0.1.0',
    });

    expect(file).not.toBeNull();
    const errors = validateFullHistoryFile(file!);
    expect(errors).toEqual([]);
  });

  it('validates with multiple molecules in shuffled order', async () => {
    const { createTimelineSubsystem } = await import('../../lab/js/runtime/timeline/timeline-subsystem');
    const { useAppStore } = await import('../../lab/js/store/app-store');
    const { vi } = await import('vitest');

    useAppStore.getState().resetTransientState();

    // Two molecules: 4 atoms at offset 0, 3 atoms at offset 4 → total 7
    const n = 7;
    const pos = new Float64Array(n * 3);
    const vel = new Float64Array(n * 3);
    for (let i = 0; i < pos.length; i++) { pos[i] = i * 0.1; vel[i] = i * 0.01; }

    const physics = {
      n, pos, vel,
      dragAtom: -1, isRotateMode: false, isTranslateMode: false,
      activeComponent: -1, dragTarget: [0, 0, 0],
      getBonds: () => [] as number[][],
      getDamping: () => 0, getDragStrength: () => 2, getRotateStrength: () => 5,
      getWallMode: () => 'contain',
      getDtFs: () => 0.5,
      getBoundarySnapshot: () => ({
        mode: 'contain' as const, wallRadius: 50,
        wallCenter: [0, 0, 0] as [number, number, number],
        wallCenterSet: true, removedCount: 0, damping: 0,
      }),
      restoreBoundarySnapshot: vi.fn(),
      createCheckpoint: function () { return { n: this.n, pos: new Float64Array(this.pos), vel: new Float64Array(this.vel), bonds: [] }; },
      restoreCheckpoint: vi.fn(),
      setDamping: vi.fn(), setDragStrength: vi.fn(), setRotateStrength: vi.fn(),
      endDrag: vi.fn(), computeForces: vi.fn(), refreshTopology: vi.fn(),
      updateBondList: vi.fn(), rebuildComponents: vi.fn(),
      setPhysicsRef: vi.fn(),
    } as any;

    // Intentionally shuffled: second molecule listed first
    const molecules = [
      {
        atomOffset: 4, atomCount: 3,
        localAtoms: [{ element: 'H' }, { element: 'H' }, { element: 'O' }],
        structureFile: 'water.xyz', name: 'Water',
      },
      {
        atomOffset: 0, atomCount: 4,
        localAtoms: [{ element: 'C' }, { element: 'C' }, { element: 'C' }, { element: 'C' }],
        structureFile: 'methane.xyz', name: 'Methane',
      },
    ];

    const sub = createTimelineSubsystem({
      getPhysics: () => physics,
      getRenderer: () => ({
        getAtomCount: () => n, setAtomCount: vi.fn(),
        updateFromSnapshot: vi.fn(), updateReviewFrame: vi.fn(),
        setPhysicsRef: vi.fn(), clearFeedback: vi.fn(),
      }) as any,
      pause: vi.fn(), resume: vi.fn(), isPaused: () => false,
      reinitWorker: vi.fn(async () => {}), isWorkerActive: () => false,
      forceRender: vi.fn(),
      clearBondedGroupHighlight: vi.fn(), clearRendererFeedback: vi.fn(),
      syncBondedGroupsForDisplayFrame: vi.fn(),
      getSceneMolecules: () => molecules,
      exportHistory: vi.fn(async () => 'saved' as const),
      exportCapabilities: { full: true, capsule: true },
    });

    // Stop → restart cycle
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);
    sub.turnRecordingOff();
    sub.startRecordingNow();
    sub.recordAfterReconciliation(4);

    // Validate atom table
    const atomTable = sub.getAtomMetadataRegistry().getAtomTable();
    expect(atomTable).toHaveLength(7);
    // Elements should reflect both molecules
    const elements = atomTable.map(e => e.element).sort();
    expect(elements).toEqual(['C', 'C', 'C', 'C', 'H', 'H', 'O']);

    // Build and validate full file
    const snapshot = sub.getTimelineExportSnapshot();
    const file = buildFullHistoryFile({
      getTimelineExportData: () => snapshot,
      getAtomTable: () => atomTable,
      appVersion: '0.1.0',
    });

    expect(file).not.toBeNull();
    const errors = validateFullHistoryFile(file!);
    expect(errors).toEqual([]);

    // Frame atomIds should all be in the atom table
    const tableIdSet = new Set(atomTable.map(e => e.id));
    for (const frame of file!.timeline.denseFrames) {
      for (const id of frame.atomIds) {
        expect(tableIdSet.has(id)).toBe(true);
      }
    }
  });
});
