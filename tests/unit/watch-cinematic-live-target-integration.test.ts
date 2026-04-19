/**
 * Two-cadence integration test for the Watch cinematic camera.
 *
 * Drives the real service + real shared helpers with a mock renderer
 * whose displayed positions drift slowly. Asserts the cadence
 * boundaries: slow selection at ~500ms, fast center at ~100ms.
 */
import { describe, it, expect, vi } from 'vitest';
import { createWatchCinematicCameraService } from '../../watch/js/view/watch-cinematic-camera';
import { DEFAULT_CINEMATIC_CONFIG, DEFAULT_CINEMATIC_CENTER_REFRESH_TUNING } from '../../src/camera/cinematic-camera';
import type { WatchBondedGroups, BondedGroupSummary } from '../../watch/js/analysis/watch-bonded-groups';
import { createWatchRendererStub } from '../helpers/watch-renderer-stub';

describe('Two-cadence integration: slow selection + fast center', () => {
  it('center updates at fast cadence between slow selections; radius stays stable', () => {
    let tick = 0;
    const indices = Array.from({ length: 10 }, (_, i) => i);
    const getIndices = vi.fn((_id: string) => indices);
    const getPosition = vi.fn((i: number) => [i + tick * 0.5, 0, 0] as [number, number, number]);
    const renderer = createWatchRendererStub({
      getDisplayedAtomWorldPosition: getPosition,
    });
    const summary: BondedGroupSummary = { id: 'g0', atomCount: 10 } as BondedGroupSummary;
    const bg: WatchBondedGroups = {
      updateForTime: vi.fn(() => [summary]),
      getSummaries: () => [summary],
      getAtomIndicesForGroup: getIndices,
      getHoveredGroupId: () => null,
      setHoveredGroupId: vi.fn(),
      resolveHighlight: () => null,
      reset: vi.fn(),
    };
    const s = createWatchCinematicCameraService();

    const framingCalls = renderer.updateCinematicFraming as ReturnType<typeof vi.fn>;

    // Drive at exact timestamps.
    // Default: slow ~500ms, fast ~100ms.

    // 0ms — slow fires (snapshot null). Record center₀.
    tick = 0;
    s.update({ dtMs: 16, nowMs: 0, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    const indicesCallsAt0 = getIndices.mock.calls.length;
    const center0 = framingCalls.mock.calls[0][1].center.slice();
    const radius0 = framingCalls.mock.calls[0][1].radius;

    // 50ms — inside fast window. No new position reads → same center.
    tick = 3;
    s.update({ dtMs: 16, nowMs: 50, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    const center50 = framingCalls.mock.calls[framingCalls.mock.calls.length - 1][1].center.slice();
    expect(center50).toEqual(center0);
    expect(getIndices.mock.calls.length).toBe(indicesCallsAt0);

    // 100ms — fast center fires. Positions drifted → center changes.
    tick = 6;
    s.update({ dtMs: 16, nowMs: 100, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    const center100 = framingCalls.mock.calls[framingCalls.mock.calls.length - 1][1].center.slice();
    expect(center100[0]).not.toBeCloseTo(center0[0], 2);
    // Slow selection NOT re-run.
    expect(getIndices.mock.calls.length).toBe(indicesCallsAt0);

    // 150ms — inside next fast window. Center = same as 100ms.
    tick = 9;
    s.update({ dtMs: 16, nowMs: 150, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    const center150 = framingCalls.mock.calls[framingCalls.mock.calls.length - 1][1].center.slice();
    expect(center150).toEqual(center100);

    // 200ms — another fast center refresh.
    tick = 12;
    s.update({ dtMs: 16, nowMs: 200, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });

    // 500ms — slow selection fires again.
    tick = 30;
    getIndices.mockClear();
    s.update({ dtMs: 16, nowMs: 500, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    expect(getIndices.mock.calls.length).toBe(1);

    // Assertions:
    // 1. Slow cadence: getAtomIndicesForGroup called at 0ms + 500ms only.
    //    (indicesCallsAt0 was 1 at t=0; cleared + 1 at t=500 above.)

    // 2. More than 1 distinct center, but far fewer than total ticks.
    const allCenters = framingCalls.mock.calls.map((c: any) => c[1].center.slice());
    const unique = new Set(allCenters.map((c: number[]) => c.join(',')));
    expect(unique.size).toBeGreaterThan(1);
    expect(unique.size).toBeLessThan(allCenters.length);

    // 3. Radius identical across ALL calls (slow cadence only).
    for (const call of framingCalls.mock.calls) {
      expect(call[1].radius).toBe(radius0);
    }
  });
});
