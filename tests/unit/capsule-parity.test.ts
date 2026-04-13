/**
 * Phase 4: Golden parity tests — full vs capsule behavioral equivalence.
 *
 * Creates paired full + capsule fixtures for representative scenarios and
 * verifies same topology, same colors, same interaction semantics.
 *
 * Fixture geometry: 4 atoms in 2 pairs. Pair (0,1) drifts apart across
 * frames, crossing the bond cutoff between frame 2 and 3 (d=1.75→2.1).
 * This tests real topology evolution, not trivially static bonds.
 */

import { describe, it, expect } from 'vitest';
import { importFullHistory } from '../../watch/js/full-history-import';
import { importCapsuleHistory } from '../../watch/js/capsule-history-import';
import { createWatchPlaybackModel } from '../../watch/js/watch-playback-model';
import { createWatchBondedGroups } from '../../watch/js/watch-bonded-groups';
import { buildCapsuleHistoryFile, type CapsuleExportDeps } from '../../lab/js/runtime/history-export';
import { validateCapsuleFile } from '../../src/history/history-file-v1';
import type { AtomDojoHistoryFileV1, AtomDojoPlaybackCapsuleFileV1 } from '../../src/history/history-file-v1';
import type { TimelineFrame } from '../../lab/js/runtime/simulation-timeline';

// ── Shared geometry: 4 atoms, pair (0,1) drifts apart ──

const ATOMS = [
  { id: 0, element: 'C' },
  { id: 1, element: 'C' },
  { id: 2, element: 'C' },
  { id: 3, element: 'C' },
];

// Pair (0,1): d=1.42, bonded. Pair (2,3): d=1.42, bonded.
const FRAME_0_POS = [0, 0, 0, 1.42, 0, 0, 5, 0, 0, 6.42, 0, 0];
// Pair (0,1): d=1.52, bonded. Pair (2,3): d=1.42, bonded.
const FRAME_1_POS = [0, 0, 0, 1.52, 0, 0, 5, 0, 0, 6.42, 0, 0];
// Pair (0,1): d=1.75, bonded (still < 1.8 cutoff). Pair (2,3): d=1.42.
const FRAME_2_POS = [0, 0, 0, 1.75, 0, 0, 5, 0, 0, 6.42, 0, 0];
// Pair (0,1): d=2.1, UNBONDED (> 1.8 cutoff). Pair (2,3): d=1.42.
const FRAME_3_POS = [0, 0, 0, 2.1, 0, 0, 5, 0, 0, 6.42, 0, 0];

const CUTOFF = 1.8;
const MIN_DIST = 0.5;

// ── Scenario 1: Dimer drag with topology change ──

function makeFullDimerDrag(): AtomDojoHistoryFileV1 {
  return {
    format: 'atomdojo-history', version: 1, kind: 'full',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-12T00:00:00Z' },
    simulation: {
      title: null, description: null,
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 4, durationPs: 30, frameCount: 4, indexingModel: 'dense-prefix',
    },
    atoms: { atoms: ATOMS },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_0_POS, interaction: { kind: 'none' }, boundary: {} },
        { frameId: 1, timePs: 10, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_1_POS, interaction: { kind: 'atom_drag', atomIndex: 1, target: [2, 0, 0] }, boundary: {} },
        { frameId: 2, timePs: 20, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_2_POS, interaction: { kind: 'atom_drag', atomIndex: 1, target: [2, 0, 0] }, boundary: {} },
        { frameId: 3, timePs: 30, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_3_POS, interaction: { kind: 'none' }, boundary: {} },
      ],
      restartFrames: [
        { frameId: 0, timePs: 0, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_0_POS, velocities: new Array(12).fill(0), bonds: [{ a: 0, b: 1, distance: 1.42 }, { a: 2, b: 3, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: { kind: 'none' }, boundary: {} },
        { frameId: 3, timePs: 30, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_3_POS, velocities: new Array(12).fill(0), bonds: [{ a: 2, b: 3, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: { kind: 'none' }, boundary: {} },
      ],
      checkpoints: [],
    },
  };
}

function makeCapsuleDimerDrag(): AtomDojoPlaybackCapsuleFileV1 {
  return {
    format: 'atomdojo-history', version: 1, kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-12T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 4, durationPs: 30, frameCount: 4, indexingModel: 'dense-prefix',
    },
    atoms: { atoms: ATOMS },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: CUTOFF, minDist: MIN_DIST },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_0_POS },
        { frameId: 1, timePs: 10, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_1_POS },
        { frameId: 2, timePs: 20, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_2_POS },
        { frameId: 3, timePs: 30, n: 4, atomIds: [0, 1, 2, 3], positions: FRAME_3_POS },
      ],
      interactionTimeline: {
        encoding: 'event-stream-v1',
        events: [
          { frameId: 1, kind: 'atom_drag', atomId: 1, target: [2, 0, 0] as [number, number, number] },
          { frameId: 3, kind: 'none' },
        ],
      },
    },
  };
}

// ── Scenario 2: Move group with full pair ──

function makeFullMoveGroup(): AtomDojoHistoryFileV1 {
  const base = makeFullDimerDrag();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      denseFrames: base.timeline.denseFrames.map((f, i) => ({
        ...f,
        interaction: i === 1 || i === 2
          ? { kind: 'move_group', atomIndex: 0, componentId: 0, target: [1, 0, 0] }
          : { kind: 'none' },
      })),
    },
  };
}

function makeCapsuleMoveGroup(): AtomDojoPlaybackCapsuleFileV1 {
  return {
    ...makeCapsuleDimerDrag(),
    timeline: {
      denseFrames: makeCapsuleDimerDrag().timeline.denseFrames,
      interactionTimeline: {
        encoding: 'event-stream-v1',
        events: [
          { frameId: 1, kind: 'move_group' as const, atomId: 0, target: [1, 0, 0] as [number, number, number] },
          { frameId: 3, kind: 'none' as const },
        ],
      },
    },
  };
}

// ── Scenario 3: Rotate group with full pair ──

function makeFullRotateGroup(): AtomDojoHistoryFileV1 {
  const base = makeFullDimerDrag();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      denseFrames: base.timeline.denseFrames.map((f, i) => ({
        ...f,
        interaction: i === 2
          ? { kind: 'rotate_group', atomIndex: 2, componentId: 1, target: [0, 1, 0] }
          : { kind: 'none' },
      })),
    },
  };
}

function makeCapsuleRotateGroup(): AtomDojoPlaybackCapsuleFileV1 {
  return {
    ...makeCapsuleDimerDrag(),
    timeline: {
      denseFrames: makeCapsuleDimerDrag().timeline.denseFrames,
      interactionTimeline: {
        encoding: 'event-stream-v1',
        events: [
          { frameId: 2, kind: 'rotate_group' as const, atomId: 2, target: [0, 1, 0] as [number, number, number] },
          { frameId: 3, kind: 'none' as const },
        ],
      },
    },
  };
}

// ── Scenario 4: Colored atoms with full pair ──

function makeFullColored(): AtomDojoHistoryFileV1 {
  const base = makeFullDimerDrag();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      denseFrames: base.timeline.denseFrames.map(f => ({
        ...f, interaction: { kind: 'none' },
      })),
    },
  };
}

function makeCapsuleColored(): AtomDojoPlaybackCapsuleFileV1 {
  const base = makeCapsuleDimerDrag();
  return {
    ...base,
    appearance: {
      colorAssignments: [
        { atomIds: [0, 1], colorHex: '#ff5555' },
        { atomIds: [2, 3], colorHex: '#55aaff' },
      ],
    },
    timeline: { denseFrames: base.timeline.denseFrames },
  };
}

// ── Helper ──

function getGroupsAtTime(model: ReturnType<typeof createWatchPlaybackModel>, timePs: number) {
  const groups = createWatchBondedGroups();
  const topology = model.getTopologyAtTime(timePs);
  return groups.updateForTime(timePs, topology);
}

function sortedGroupSizes(groups: { atomCount: number }[]) {
  return groups.map(g => g.atomCount).sort((a, b) => a - b);
}

// ── Topology parity (exercises real bond-breaking) ──

describe('Phase 4: topology parity (full vs capsule)', () => {
  it('same group count at all frame times (including topology change at frame 3)', () => {
    const fullModel = createWatchPlaybackModel();
    fullModel.load(importFullHistory(makeFullDimerDrag()));
    const capsuleModel = createWatchPlaybackModel();
    capsuleModel.load(importCapsuleHistory(makeCapsuleDimerDrag()));

    for (const t of [0, 10, 20, 30]) {
      const fg = getGroupsAtTime(fullModel, t);
      const cg = getGroupsAtTime(capsuleModel, t);
      expect(cg.length).toBe(fg.length);
    }
  });

  it('same group sizes at all frame times', () => {
    const fullModel = createWatchPlaybackModel();
    fullModel.load(importFullHistory(makeFullDimerDrag()));
    const capsuleModel = createWatchPlaybackModel();
    capsuleModel.load(importCapsuleHistory(makeCapsuleDimerDrag()));

    for (const t of [0, 10, 20, 30]) {
      expect(sortedGroupSizes(getGroupsAtTime(capsuleModel, t)))
        .toEqual(sortedGroupSizes(getGroupsAtTime(fullModel, t)));
    }
  });

  it('topology changes at frame 3: pair (0,1) unbonds', () => {
    const capsuleModel = createWatchPlaybackModel();
    capsuleModel.load(importCapsuleHistory(makeCapsuleDimerDrag()));

    const groupsAt20 = getGroupsAtTime(capsuleModel, 20);
    expect(groupsAt20).toHaveLength(2);
    expect(sortedGroupSizes(groupsAt20)).toEqual([2, 2]);

    const groupsAt30 = getGroupsAtTime(capsuleModel, 30);
    expect(groupsAt30).toHaveLength(3);
    expect(sortedGroupSizes(groupsAt30)).toEqual([1, 1, 2]);
  });

  it('same atom count at each frame', () => {
    const fullModel = createWatchPlaybackModel();
    fullModel.load(importFullHistory(makeFullDimerDrag()));
    const capsuleModel = createWatchPlaybackModel();
    capsuleModel.load(importCapsuleHistory(makeCapsuleDimerDrag()));

    for (const t of [0, 10, 20, 30]) {
      const fp = fullModel.getDisplayPositionsAtTime(t)!;
      const cp = capsuleModel.getDisplayPositionsAtTime(t)!;
      expect(cp.n).toBe(fp.n);
      expect(cp.atomIds).toEqual(fp.atomIds);
    }
  });
});

// ── Appearance parity ──

describe('Phase 4: appearance round-trip parity', () => {
  it('capsule preserves exact assignment boundaries', () => {
    const h = importCapsuleHistory(makeCapsuleColored());
    expect(h.appearance!.colorAssignments).toHaveLength(2);
    expect(h.appearance!.colorAssignments[0]).toEqual({ atomIds: [0, 1], colorHex: '#ff5555' });
    expect(h.appearance!.colorAssignments[1]).toEqual({ atomIds: [2, 3], colorHex: '#55aaff' });
  });

  it('export → import round-trip preserves atomIds exactly', () => {
    const file = buildCapsuleHistoryFile({
      getTimelineExportData: () => ({ denseFrames: makeDenseTimelineFrames(), restartFrames: [], checkpoints: [] }),
      getAtomTable: () => ATOMS.map(a => ({ id: a.id, element: a.element })),
      getColorAssignments: () => [
        { atomIds: [0, 1], colorHex: '#ff5555' },
        { atomIds: [2, 3], colorHex: '#55aaff' },
      ],
      appVersion: '0.1.0',
    })!;
    const imported = importCapsuleHistory(file);
    expect(imported.appearance!.colorAssignments[0]).toEqual({ atomIds: [0, 1], colorHex: '#ff5555' });
    expect(imported.appearance!.colorAssignments[1]).toEqual({ atomIds: [2, 3], colorHex: '#55aaff' });
  });

  it('two groups with same color remain independent after round-trip', () => {
    const file = buildCapsuleHistoryFile({
      getTimelineExportData: () => ({ denseFrames: makeDenseTimelineFrames(), restartFrames: [], checkpoints: [] }),
      getAtomTable: () => ATOMS.map(a => ({ id: a.id, element: a.element })),
      getColorAssignments: () => [
        { atomIds: [0, 1], colorHex: '#ff5555' },
        { atomIds: [2, 3], colorHex: '#ff5555' },
      ],
      appVersion: '0.1.0',
    })!;
    const imported = importCapsuleHistory(file);
    expect(imported.appearance!.colorAssignments).toHaveLength(2);
    expect(imported.appearance!.colorAssignments[0].atomIds).toEqual([0, 1]);
    expect(imported.appearance!.colorAssignments[1].atomIds).toEqual([2, 3]);
  });

  it('full and capsule produce same topology for colored-atom scenario', () => {
    const fullModel = createWatchPlaybackModel();
    fullModel.load(importFullHistory(makeFullColored()));
    const capsuleModel = createWatchPlaybackModel();
    capsuleModel.load(importCapsuleHistory(makeCapsuleColored()));

    for (const t of [0, 10, 20, 30]) {
      expect(sortedGroupSizes(getGroupsAtTime(capsuleModel, t)))
        .toEqual(sortedGroupSizes(getGroupsAtTime(fullModel, t)));
    }
  });
});

// ── Interaction parity (full payload comparison) ──

describe('Phase 4: interaction parity', () => {
  it('atom_drag: kind + atomId + target match at every frame boundary', () => {
    const fullHistory = importFullHistory(makeFullDimerDrag());
    const capsuleHistory = importCapsuleHistory(makeCapsuleDimerDrag());
    const capsuleModel = createWatchPlaybackModel();
    capsuleModel.load(capsuleHistory);

    for (const f of fullHistory.denseFrames) {
      const fullI = f.interaction as { kind: string; atomIndex?: number; target?: number[] } | null;
      const capsuleI = capsuleModel.getInteractionAtTime(f.timePs);
      const fullKind = fullI?.kind ?? 'none';
      const capsuleKind = capsuleI?.kind ?? 'none';
      expect(capsuleKind).toBe(fullKind);

      if (fullKind !== 'none' && capsuleKind !== 'none') {
        const ci = capsuleI as { atomId: number; target: number[] };
        expect(ci.atomId).toBe(f.atomIds[fullI!.atomIndex!]);
        expect(ci.target).toEqual(fullI!.target);
      }
    }
  });

  it('move_group: paired full vs capsule kind match at every frame', () => {
    const fullHistory = importFullHistory(makeFullMoveGroup());
    const capsuleHistory = importCapsuleHistory(makeCapsuleMoveGroup());
    const capsuleModel = createWatchPlaybackModel();
    capsuleModel.load(capsuleHistory);

    for (const f of fullHistory.denseFrames) {
      const fullI = f.interaction as { kind: string; atomIndex?: number; target?: number[] } | null;
      const capsuleI = capsuleModel.getInteractionAtTime(f.timePs);
      const fullKind = fullI?.kind ?? 'none';
      const capsuleKind = capsuleI?.kind ?? 'none';
      expect(capsuleKind).toBe(fullKind);

      if (fullKind !== 'none' && capsuleKind !== 'none') {
        const ci = capsuleI as { atomId: number; target: number[] };
        expect(ci.atomId).toBe(f.atomIds[fullI!.atomIndex!]);
        expect(ci.target).toEqual(fullI!.target);
      }
    }
  });

  it('rotate_group: paired full vs capsule kind match at every frame', () => {
    const fullHistory = importFullHistory(makeFullRotateGroup());
    const capsuleHistory = importCapsuleHistory(makeCapsuleRotateGroup());
    const capsuleModel = createWatchPlaybackModel();
    capsuleModel.load(capsuleHistory);

    for (const f of fullHistory.denseFrames) {
      const fullI = f.interaction as { kind: string; atomIndex?: number; target?: number[] } | null;
      const capsuleI = capsuleModel.getInteractionAtTime(f.timePs);
      const fullKind = fullI?.kind ?? 'none';
      const capsuleKind = capsuleI?.kind ?? 'none';
      expect(capsuleKind).toBe(fullKind);

      if (fullKind !== 'none' && capsuleKind !== 'none') {
        const ci = capsuleI as { atomId: number; target: number[] };
        expect(ci.atomId).toBe(f.atomIds[fullI!.atomIndex!]);
        expect(ci.target).toEqual(fullI!.target);
      }
    }
  });

  it('no componentId in capsule interaction wire format', () => {
    for (const capsule of [makeCapsuleMoveGroup(), makeCapsuleRotateGroup()]) {
      for (const e of capsule.timeline.interactionTimeline!.events) {
        expect((e as Record<string, unknown>).componentId).toBeUndefined();
      }
    }
  });
});

// ── Sparsification correctness ──

describe('Phase 4: sparsification correctness', () => {
  it('repeated same-state frames produce exactly 2 events (drag + none)', () => {
    const file = buildCapsuleHistoryFile({
      getTimelineExportData: () => ({ denseFrames: makeDenseTimelineFrames(), restartFrames: [], checkpoints: [] }),
      getAtomTable: () => ATOMS.map(a => ({ id: a.id, element: a.element })),
      getColorAssignments: () => [],
      appVersion: '0.1.0',
    })!;
    const events = file.timeline.interactionTimeline!.events;
    expect(events).toHaveLength(2);
    expect(events[0].frameId).toBe(1);
    expect(events[0].kind).toBe('atom_drag');
    expect(events[1]).toEqual({ frameId: 3, kind: 'none' });
  });

  it('move_group export drops componentId', () => {
    const frames = makeDenseTimelineFrames();
    frames[1] = { ...frames[1], interaction: { kind: 'move_group', atomIndex: 0, componentId: 0, target: [1, 0, 0] as [number, number, number] } };
    frames[2] = { ...frames[2], interaction: { kind: 'move_group', atomIndex: 0, componentId: 0, target: [1, 0, 0] as [number, number, number] } };
    const file = buildCapsuleHistoryFile({
      getTimelineExportData: () => ({ denseFrames: frames, restartFrames: [], checkpoints: [] }),
      getAtomTable: () => ATOMS.map(a => ({ id: a.id, element: a.element })),
      getColorAssignments: () => [],
      appVersion: '0.1.0',
    })!;
    const moveEvent = file.timeline.interactionTimeline!.events[0];
    expect(moveEvent.kind).toBe('move_group');
    expect((moveEvent as Record<string, unknown>).componentId).toBeUndefined();
  });

  it('all-none interaction produces no interactionTimeline', () => {
    const frames = makeDenseTimelineFrames().map(f => ({ ...f, interaction: { kind: 'none' as const } }));
    const file = buildCapsuleHistoryFile({
      getTimelineExportData: () => ({ denseFrames: frames, restartFrames: [], checkpoints: [] }),
      getAtomTable: () => ATOMS.map(a => ({ id: a.id, element: a.element })),
      getColorAssignments: () => [],
      appVersion: '0.1.0',
    })!;
    expect(file.timeline.interactionTimeline).toBeUndefined();
  });
});

// ── File size: payload isolation ──
// Capsule always includes bondPolicy (mandatory), so the baseline IS positions + bondPolicy.
// Three variants isolate the contribution of appearance and interaction.

describe('Phase 4: file size (payload isolation)', () => {
  function buildVariant(overrides: Partial<CapsuleExportDeps> = {}) {
    return buildCapsuleHistoryFile({
      getTimelineExportData: () => ({ denseFrames: makeDenseTimelineFrames().map(f => ({ ...f, interaction: { kind: 'none' as const } })), restartFrames: [], checkpoints: [] }),
      getAtomTable: () => ATOMS.map(a => ({ id: a.id, element: a.element })),
      getColorAssignments: () => [],
      appVersion: '0.1.0',
      ...overrides,
    })!;
  }

  // Baseline: positions + bondPolicy (mandatory) — no optional sections
  const baseline = buildVariant();
  // + appearance
  const withAppearance = buildVariant({
    getColorAssignments: () => [
      { atomIds: [0, 1], colorHex: '#ff5555' },
      { atomIds: [2, 3], colorHex: '#55aaff' },
    ],
  });
  // + sparse interaction
  const withInteraction = buildCapsuleHistoryFile({
    getTimelineExportData: () => ({ denseFrames: makeDenseTimelineFrames(), restartFrames: [], checkpoints: [] }),
    getAtomTable: () => ATOMS.map(a => ({ id: a.id, element: a.element })),
    getColorAssignments: () => [],
    appVersion: '0.1.0',
  })!;

  const sizeBaseline = JSON.stringify(baseline).length;
  const sizeAppearance = JSON.stringify(withAppearance).length;
  const sizeInteraction = JSON.stringify(withInteraction).length;
  const sizeFull = JSON.stringify(makeFullDimerDrag()).length;
  const deltaAppearance = sizeAppearance - sizeBaseline;
  const deltaInteraction = sizeInteraction - sizeBaseline;

  it('baseline capsule (positions + bondPolicy) is materially smaller than full', () => {
    expect(sizeBaseline).toBeLessThan(sizeFull);
  });

  it('appearance adds positive delta over baseline', () => {
    expect(deltaAppearance).toBeGreaterThan(0);
  });

  it('sparse interaction adds positive delta over baseline', () => {
    expect(deltaInteraction).toBeGreaterThan(0);
  });

  it('size ordering: baseline ≤ +appearance ≤ full, baseline ≤ +interaction ≤ full', () => {
    expect(sizeBaseline).toBeLessThanOrEqual(sizeAppearance);
    expect(sizeAppearance).toBeLessThan(sizeFull);
    expect(sizeBaseline).toBeLessThanOrEqual(sizeInteraction);
    expect(sizeInteraction).toBeLessThan(sizeFull);
  });

  it('golden byte counts (regression guard)', () => {
    expect(sizeBaseline).toBe(1044);
    expect(deltaAppearance).toBe(114);
    expect(deltaInteraction).toBe(153);
    expect(sizeFull).toBe(1755);
  });

  it('all golden fixtures validate cleanly', () => {
    for (const f of [makeCapsuleDimerDrag(), makeCapsuleColored(), makeCapsuleMoveGroup(), makeCapsuleRotateGroup()]) {
      expect(validateCapsuleFile(f)).toEqual([]);
    }
  });
});

// ── Helper ──

function makeDenseTimelineFrames(): TimelineFrame[] {
  return [
    { frameId: 0, timePs: 0, n: 4, atomIds: [0, 1, 2, 3], positions: new Float64Array(FRAME_0_POS), interaction: { kind: 'none' }, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    { frameId: 1, timePs: 10, n: 4, atomIds: [0, 1, 2, 3], positions: new Float64Array(FRAME_1_POS), interaction: { kind: 'atom_drag', atomIndex: 1, target: [2, 0, 0] as [number, number, number] }, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    { frameId: 2, timePs: 20, n: 4, atomIds: [0, 1, 2, 3], positions: new Float64Array(FRAME_2_POS), interaction: { kind: 'atom_drag', atomIndex: 1, target: [2, 0, 0] as [number, number, number] }, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
    { frameId: 3, timePs: 30, n: 4, atomIds: [0, 1, 2, 3], positions: new Float64Array(FRAME_3_POS), interaction: { kind: 'none' }, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: false, removedCount: 0, damping: 0 } },
  ];
}
