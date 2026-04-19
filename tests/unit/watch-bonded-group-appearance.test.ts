/**
 * @vitest-environment jsdom
 */
/**
 * Tests for watch bonded-group appearance runtime.
 *
 * Covers:
 *   - Stable atomId-based assignment (not dense slot indices)
 *   - Per-frame projection: atomIds → dense slots → renderer overrides
 *   - Correct atom tracking across frames with different atomId orderings
 *   - Silent skip of missing atomIds
 *   - Clear group color / clear all colors
 *   - Reset on file load
 *   - Renderer detach does NOT clear assignments
 *   - Controller lifecycle wiring
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWatchBondedGroupAppearance } from '../../watch/js/analysis/watch-bonded-group-appearance';

// ── Mock dependencies ──

function createMockDeps() {
  const groupAtoms: Record<string, number[]> = {
    'g1': [0, 1],
    'g2': [2, 3],
  };

  let currentTimePs = 0;
  // Frame 0: atomIds = [100, 101, 102, 103]
  // Frame 1: atomIds = [102, 100, 101, 103] — reordered
  const frames: Record<number, { n: number; atomIds: number[]; positions: Float64Array }> = {
    0: { n: 4, atomIds: [100, 101, 102, 103], positions: new Float64Array(12) },
    1: { n: 4, atomIds: [102, 100, 101, 103], positions: new Float64Array(12) },
  };

  const mockRenderer = {
    setAtomColorOverrides: vi.fn(),
  };

  return {
    bondedGroups: {
      getAtomIndicesForGroup: (id: string) => groupAtoms[id] ?? null,
      getSummaries: () => [],
      getHoveredGroupId: () => null,
      setHoveredGroupId: () => {},
      resolveHighlight: () => null,
      updateForTime: () => {},
      reset: () => {},
    },
    playback: {
      getCurrentTimePs: () => currentTimePs,
      getDisplayPositionsAtTime: (t: number) => frames[t] ?? frames[0],
      isLoaded: () => true,
      isPlaying: () => false,
      getStartTimePs: () => 0,
      getEndTimePs: () => 100,
      advance: () => {},
      startPlayback: () => {},
      pausePlayback: () => {},
      seekTo: (t: number) => { currentTimePs = t; },
      load: () => {},
      unload: () => {},
      setCurrentTimePs: (t: number) => { currentTimePs = t; },
      getLoadedHistory: () => null,
      getTopologyAtTime: () => null,
      getConfigAtTime: () => null,
      getBoundaryAtTime: () => null,
    },
    renderer: mockRenderer,
    setTime: (t: number) => { currentTimePs = t; },
  };
}

// ── Tests ──

describe('WatchBondedGroupAppearance', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let appearance: ReturnType<typeof createWatchBondedGroupAppearance>;

  beforeEach(() => {
    deps = createMockDeps();
    appearance = createWatchBondedGroupAppearance({
      getBondedGroups: () => deps.bondedGroups as any,
      getPlaybackModel: () => deps.playback as any,
      getRenderer: () => deps.renderer as any,
    });
  });

  it('initial state: no assignments, default color state', () => {
    expect(appearance.getAssignments()).toHaveLength(0);
    expect(appearance.getGroupColorState('g1')).toEqual({ kind: 'default' });
  });

  it('applyGroupColor freezes stable atomIds, not dense slots', () => {
    appearance.applyGroupColor('g1', '#ff5555');
    const assignments = appearance.getAssignments();
    expect(assignments).toHaveLength(1);
    // Group g1 has dense slots [0, 1] → atomIds [100, 101]
    expect(assignments[0].atomIds).toEqual([100, 101]);
    expect(assignments[0].colorHex).toBe('#ff5555');
    expect(assignments[0].sourceGroupId).toBe('g1');
  });

  it('per-frame projection maps atomIds to current dense slots', () => {
    appearance.applyGroupColor('g1', '#ff5555');
    // Frame 0: atomIds = [100, 101, 102, 103] → slots 0, 1
    appearance.projectAndSync(0);
    const call0 = deps.renderer.setAtomColorOverrides.mock.calls;
    const overrides0 = call0[call0.length - 1][0];
    expect(overrides0[0]).toEqual({ hex: '#ff5555' }); // slot 0 = atom 100
    expect(overrides0[1]).toEqual({ hex: '#ff5555' }); // slot 1 = atom 101
    expect(overrides0[2]).toBeUndefined();

    // Frame 1: atomIds = [102, 100, 101, 103] → atoms 100, 101 are at slots 1, 2
    deps.renderer.setAtomColorOverrides.mockClear();
    appearance.projectAndSync(1);
    const call1 = deps.renderer.setAtomColorOverrides.mock.calls;
    const overrides1 = call1[call1.length - 1][0];
    expect(overrides1[0]).toBeUndefined(); // slot 0 = atom 102 (not colored)
    expect(overrides1[1]).toEqual({ hex: '#ff5555' }); // slot 1 = atom 100
    expect(overrides1[2]).toEqual({ hex: '#ff5555' }); // slot 2 = atom 101
  });

  it('silently skips atomIds not present in current frame', () => {
    // Frame with only atoms 100, 101 (3-atom frame, no 102/103)
    const shortFrame = { n: 2, atomIds: [100, 101], positions: new Float64Array(6) };
    (deps.playback as any).getDisplayPositionsAtTime = () => shortFrame;

    // Color group g2 (atoms at slots 2, 3 → atomIds 102, 103)
    // But override getDisplayPositionsAtTime for assignment time to return full frame
    const fullFrame = { n: 4, atomIds: [100, 101, 102, 103], positions: new Float64Array(12) };
    let returnFull = true;
    (deps.playback as any).getDisplayPositionsAtTime = (t: number) => returnFull ? fullFrame : shortFrame;

    appearance.applyGroupColor('g2', '#00ff00');
    returnFull = false; // now projection uses short frame

    deps.renderer.setAtomColorOverrides.mockClear();
    appearance.projectAndSync(0);
    // Atoms 102, 103 not in short frame → silently skipped → null override
    const calls = deps.renderer.setAtomColorOverrides.mock.calls;
    expect(calls[calls.length - 1][0]).toBeNull();
  });

  it('clearGroupColor removes assignments for that group', () => {
    appearance.applyGroupColor('g1', '#ff5555');
    appearance.applyGroupColor('g2', '#00ff00');
    expect(appearance.getAssignments()).toHaveLength(2);

    appearance.clearGroupColor('g1');
    expect(appearance.getAssignments()).toHaveLength(1);
    expect(appearance.getAssignments()[0].sourceGroupId).toBe('g2');
  });

  it('clearAllColors resets everything and passes null to renderer', () => {
    appearance.applyGroupColor('g1', '#ff5555');
    deps.renderer.setAtomColorOverrides.mockClear();
    appearance.clearAllColors();
    expect(appearance.getAssignments()).toHaveLength(0);
    expect(deps.renderer.setAtomColorOverrides).toHaveBeenCalledWith(null);
  });

  it('reset clears assignments (called on file load)', () => {
    appearance.applyGroupColor('g1', '#ff5555');
    appearance.reset();
    expect(appearance.getAssignments()).toHaveLength(0);
    expect(appearance.getGroupColorState('g1')).toEqual({ kind: 'default' });
  });

  it('getGroupColorState reflects current overrides', () => {
    appearance.applyGroupColor('g1', '#ff5555');
    const state = appearance.getGroupColorState('g1');
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.hex).toBe('#ff5555');
    }
  });

  it('replacing color for same group replaces prior assignment', () => {
    appearance.applyGroupColor('g1', '#ff5555');
    appearance.applyGroupColor('g1', '#00ff00');
    expect(appearance.getAssignments()).toHaveLength(1);
    expect(appearance.getAssignments()[0].colorHex).toBe('#00ff00');
  });
});

// ── Renderer display-aware atom count (regression for review-mode color application) ──

describe('Renderer _getDisplayedAtomCount regression', () => {
  it('renderer.ts _getDisplayedAtomCount uses _reviewAtomCount in review mode', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lab/js/renderer.ts', 'utf-8');
    // The helper must exist and use _displaySource + _reviewAtomCount
    expect(source).toContain('_getDisplayedAtomCount');
    expect(source).toContain("this._displaySource === 'review' ? this._reviewAtomCount : this._atomCount");
  });

  it('_applyAtomColorOverrides uses _getDisplayedAtomCount, not _atomCount directly', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lab/js/renderer.ts', 'utf-8');
    // Find the _applyAtomColorOverrides method body
    const match = source.match(/_applyAtomColorOverrides\(\)[\s\S]*?const n = this\._getDisplayedAtomCount\(\)/);
    expect(match).not.toBeNull();
  });

  it('updateReviewFrame re-applies authored overrides at end', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lab/js/renderer.ts', 'utf-8');
    // updateReviewFrame should call _applyAtomColorOverrides after updating count/matrices
    const reviewFn = source.match(/updateReviewFrame[\s\S]*?^\s{2}\}/m)?.[0] ?? '';
    expect(reviewFn).toContain('_applyAtomColorOverrides');
  });
});

// ── Controller lifecycle wiring ──

describe('Controller lifecycle wiring', () => {
  it('controller imports and creates appearance domain', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/app/watch-controller.ts', 'utf-8');
    expect(source).toContain('createWatchBondedGroupAppearance');
    expect(source).toContain('appearance.reset()');
    expect(source).toContain('appearance.projectAndSync');
  });

  it('appearance.reset() is called in openFile, not detachRenderer', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/app/watch-controller.ts', 'utf-8');
    // Reset in openFile
    expect(source).toContain('appearance.reset()');
    // detachRenderer does NOT clear appearance
    const detachFn = source.match(/function detachRenderer[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(detachFn).not.toContain('appearance');
  });
});
