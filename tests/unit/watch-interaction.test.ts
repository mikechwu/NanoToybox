/**
 * @vitest-environment jsdom
 */
/**
 * Tests for Watch Round 2: review interaction parity.
 *   - Analysis interaction state (hover, select, highlight priority)
 *   - View service (center, follow, follow-failure)
 *   - Controller interaction commands
 */

import { describe, it, expect, vi } from 'vitest';
import { createWatchBondedGroups } from '../../watch/js/watch-bonded-groups';
import { createWatchViewService } from '../../watch/js/watch-view-service';
import { createWatchController } from '../../watch/js/watch-controller';
import { importFullHistory } from '../../watch/js/full-history-import';

// ── Fixtures ──

function makeValidFileText(): string {
  return JSON.stringify({
    format: 'atomdojo-history', version: 1, kind: 'full',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-07T00:00:00Z' },
    simulation: { title: null, description: null, units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 4, durationPs: 99.999, frameCount: 2, indexingModel: 'dense-prefix' },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }, { id: 2, element: 'C' }, { id: 3, element: 'C' }] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0.001, n: 4, atomIds: [0, 1, 2, 3], positions: [0, 0, 0, 1, 0, 0, 3, 0, 0, 4, 0, 0], interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 4, atomIds: [0, 1, 2, 3], positions: [0.1, 0, 0, 1.1, 0, 0, 3.1, 0, 0, 4.1, 0, 0], interaction: null, boundary: {} },
      ],
      restartFrames: [
        { frameId: 0, timePs: 0.001, n: 4, atomIds: [0, 1, 2, 3], positions: [0, 0, 0, 1, 0, 0, 3, 0, 0, 4, 0, 0], velocities: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bonds: [{ a: 0, b: 1, distance: 1.42 }, { a: 2, b: 3, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
        { frameId: 1, timePs: 100, n: 4, atomIds: [0, 1, 2, 3], positions: [0.1, 0, 0, 1.1, 0, 0, 3.1, 0, 0, 4.1, 0, 0], velocities: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bonds: [{ a: 0, b: 1, distance: 1.42 }, { a: 2, b: 3, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
      ],
      checkpoints: [],
    },
  });
}

// ── Analysis interaction state ──

describe('WatchBondedGroups interaction state', () => {
  function loadGroups() {
    const bg = createWatchBondedGroups();
    bg.updateForTime(0.001, { bonds: [[0, 1, 1.42], [2, 3, 1.42]], n: 4, frameId: 0 });
    return bg;
  }

  it('exposes getAtomIndicesForGroup', () => {
    const bg = loadGroups();
    const summaries = bg.getSummaries();
    expect(summaries).toHaveLength(2);
    const atoms = bg.getAtomIndicesForGroup(summaries[0].id);
    expect(atoms).not.toBeNull();
    expect(atoms!.length).toBe(2);
  });

  it('supports hover state', () => {
    const bg = loadGroups();
    expect(bg.getHoveredGroupId()).toBeNull();
    const id = bg.getSummaries()[0].id;
    bg.setHoveredGroupId(id);
    expect(bg.getHoveredGroupId()).toBe(id);
    bg.setHoveredGroupId(null);
    expect(bg.getHoveredGroupId()).toBeNull();
  });

  it('auto-clears stale hover state when groups disappear', () => {
    const bg = createWatchBondedGroups();
    bg.updateForTime(0.001, { bonds: [[0, 1, 1.42]], n: 2, frameId: 0 });
    const id = bg.getSummaries()[0].id;
    bg.setHoveredGroupId(id);
    expect(bg.getHoveredGroupId()).toBe(id);

    // Empty topology — hover must be cleared
    bg.updateForTime(0.001, null);
    expect(bg.getHoveredGroupId()).toBeNull();
  });

  it('rejects invalid hover group IDs', () => {
    const bg = loadGroups();
    bg.setHoveredGroupId('nonexistent');
    expect(bg.getHoveredGroupId()).toBeNull();
  });

  it('reset clears hover state', () => {
    const bg = loadGroups();
    bg.setHoveredGroupId(bg.getSummaries()[0].id);
    bg.reset();
    expect(bg.getHoveredGroupId()).toBeNull();
  });
});

// ── Highlight (hover-only, matching lab parity — persistent selection highlight is gated OFF) ──

describe('Highlight (hover-only, lab parity)', () => {
  function loadGroups() {
    const bg = createWatchBondedGroups();
    bg.updateForTime(0.001, { bonds: [[0, 1, 1.42], [2, 3, 1.42]], n: 4, frameId: 0 });
    return bg;
  }

  it('returns null when nothing is hovered', () => {
    const bg = loadGroups();
    expect(bg.resolveHighlight()).toBeNull();
  });

  it('returns hover highlight when hovered', () => {
    const bg = loadGroups();
    bg.setHoveredGroupId(bg.getSummaries()[0].id);
    const result = bg.resolveHighlight();
    expect(result).not.toBeNull();
    expect(result!.intensity).toBe('hover');
    expect(result!.atomIndices!.length).toBe(2);
  });

  it('no persistent selection highlight (parity: gated OFF in lab)', () => {
    // The analysis domain has no selectedGroupId — only hover drives highlight
    const bg = loadGroups();
    // No setSelectedGroupId method — verify only hover works
    expect(bg.resolveHighlight()).toBeNull();
    bg.setHoveredGroupId(bg.getSummaries()[0].id);
    expect(bg.resolveHighlight()!.intensity).toBe('hover');
    bg.setHoveredGroupId(null);
    expect(bg.resolveHighlight()).toBeNull();
  });
});

// ── View service (lab-parity follow model) ──

describe('WatchViewService (lab-parity)', () => {
  // Mock renderer for follow tests
  const positions: Record<number, [number, number, number]> = {
    0: [0, 0, 0], 1: [1, 0, 0], 2: [3, 0, 0], 3: [4, 0, 0],
  };
  const mockRenderer = {
    getDisplayedAtomWorldPosition: (idx: number) => positions[idx] ?? null,
    updateOrbitFollow: vi.fn(),
    animateToFramedTarget: vi.fn(),
  } as any;

  function mockAnalysis() {
    const bg = createWatchBondedGroups();
    bg.updateForTime(0.001, { bonds: [[0, 1, 1.42], [2, 3, 1.42]], n: 4, frameId: 0 });
    return bg;
  }

  it('initial state: no target, not following', () => {
    const vs = createWatchViewService();
    expect(vs.getTargetRef()).toBeNull();
    expect(vs.isFollowing()).toBe(false);
    expect(vs.getFollowAtomIndices()).toBeNull();
  });

  it('followGroup freezes atom membership at start time (lab parity)', () => {
    const vs = createWatchViewService();
    const analysis = mockAnalysis();
    const groupId = analysis.getSummaries()[0].id;
    const originalAtoms = analysis.getAtomIndicesForGroup(groupId);

    vs.followGroup(groupId, mockRenderer, analysis);
    expect(vs.isFollowing()).toBe(true);
    expect(vs.getFollowAtomIndices()).toEqual(originalAtoms);
  });

  it('followGroup centers camera once when enabled (lab parity)', () => {
    const vs = createWatchViewService();
    mockRenderer.animateToFramedTarget.mockClear();
    vs.followGroup(mockAnalysis().getSummaries()[0].id, mockRenderer, mockAnalysis());
    expect(mockRenderer.animateToFramedTarget).toHaveBeenCalledTimes(1);
  });

  it('unfollowGroup clears follow target + camera target ref (lab parity)', () => {
    const vs = createWatchViewService();
    vs.followGroup(mockAnalysis().getSummaries()[0].id, mockRenderer, mockAnalysis());
    expect(vs.isFollowing()).toBe(true);
    expect(vs.getTargetRef()).not.toBeNull();

    vs.unfollowGroup();
    expect(vs.isFollowing()).toBe(false);
    expect(vs.getFollowAtomIndices()).toBeNull();
    expect(vs.getTargetRef()).toBeNull();
  });

  it('updateFollow uses frozen atom set, not live group-id', () => {
    const vs = createWatchViewService();
    const analysis = mockAnalysis();
    mockRenderer.updateOrbitFollow.mockClear();
    vs.followGroup(analysis.getSummaries()[0].id, mockRenderer, analysis);

    // updateFollow does NOT take analysis — uses frozen atoms
    const result = vs.updateFollow(16, mockRenderer);
    expect(result).toBe(true);
    expect(mockRenderer.updateOrbitFollow).toHaveBeenCalledTimes(1);
  });

  it('updateFollow disables follow when frozen atoms are unresolvable', () => {
    const vs = createWatchViewService();
    const analysis = mockAnalysis();
    vs.followGroup(analysis.getSummaries()[0].id, mockRenderer, analysis);

    // Renderer that returns null for all positions (simulating atoms removed)
    const brokenRenderer = {
      getDisplayedAtomWorldPosition: () => null,
      updateOrbitFollow: vi.fn(),
    } as any;

    const result = vs.updateFollow(16, brokenRenderer);
    expect(result).toBe(false);
    expect(vs.isFollowing()).toBe(false);
    expect(vs.getFollowAtomIndices()).toBeNull();
  });

  it('reset clears everything', () => {
    const vs = createWatchViewService();
    vs.followGroup(mockAnalysis().getSummaries()[0].id, mockRenderer, mockAnalysis());
    vs.reset();
    expect(vs.isFollowing()).toBe(false);
    expect(vs.getTargetRef()).toBeNull();
    expect(vs.getFollowAtomIndices()).toBeNull();
  });
});

// ── Controller interaction commands ──

describe('WatchController interaction commands', () => {
  it('hoverGroup updates snapshot', async () => {
    const ctrl = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await ctrl.openFile(file);

    const groups = ctrl.getSnapshot().groups;
    ctrl.hoverGroup(groups[0].id);
    expect(ctrl.getSnapshot().hoveredGroupId).toBe(groups[0].id);

    ctrl.hoverGroup(null);
    expect(ctrl.getSnapshot().hoveredGroupId).toBeNull();
    ctrl.dispose();
  });

  it('followGroup requires renderer (no-op without it)', async () => {
    const ctrl = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await ctrl.openFile(file);

    // No renderer created — followGroup should be a no-op
    ctrl.followGroup(ctrl.getSnapshot().groups[0].id);
    expect(ctrl.getSnapshot().following).toBe(false);
    ctrl.dispose();
  });

  it('unfollowGroup clears follow state completely (lab parity)', async () => {
    const ctrl = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await ctrl.openFile(file);

    ctrl.unfollowGroup();
    expect(ctrl.getSnapshot().following).toBe(false);
    expect(ctrl.getSnapshot().followedGroupId).toBeNull();
    ctrl.dispose();
  });

  it('snapshot has no selectedGroupId (parity: persistent selection gated OFF)', async () => {
    const ctrl = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await ctrl.openFile(file);

    const snap = ctrl.getSnapshot();
    expect(snap).not.toHaveProperty('selectedGroupId');
    expect(snap).toHaveProperty('followedGroupId');
    expect(snap).toHaveProperty('following');
    expect(snap).toHaveProperty('hoveredGroupId');
    ctrl.dispose();
  });

  it('file replacement clears follow state', async () => {
    const ctrl = createWatchController();
    const file = new File([makeValidFileText()], 'test.atomdojo');
    await ctrl.openFile(file);

    // Open second file — clears interaction state
    const file2 = new File([makeValidFileText()], 'test2.atomdojo');
    await ctrl.openFile(file2);
    expect(ctrl.getSnapshot().following).toBe(false);
    expect(ctrl.getSnapshot().followedGroupId).toBeNull();
    ctrl.dispose();
  });
});
