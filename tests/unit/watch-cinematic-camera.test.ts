/**
 * Watch cinematic-camera SERVICE tests — exercises the adapter's
 * mode-gating, cooldown, target refresh at the speed-profile
 * interval, and attach/reset/dispose lifecycle.
 *
 * Pure module math (speed profile, resolver) is covered in
 * cinematic-camera.test.ts — do not duplicate those here.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWatchCinematicCameraService } from '../../watch/js/watch-cinematic-camera';
import type { WatchRenderer } from '../../watch/js/watch-renderer';
import type { WatchBondedGroups } from '../../watch/js/watch-bonded-groups';
import type { BondedGroupSummary } from '../../watch/js/watch-bonded-groups';
import {
  DEFAULT_CINEMATIC_CONFIG,
  DEFAULT_CINEMATIC_SPEED_TUNING,
} from '../../src/camera/cinematic-camera';
import { createWatchRendererStub } from '../helpers/watch-renderer-stub';

function makeRenderer(overrides: Partial<WatchRenderer> = {}): WatchRenderer {
  return createWatchRendererStub(overrides);
}

function makeBondedGroups(
  summaries: BondedGroupSummary[],
  indicesByGroup: Record<string, number[] | null>,
): WatchBondedGroups {
  return {
    updateForTime: vi.fn(() => summaries),
    getSummaries: () => summaries,
    getAtomIndicesForGroup: (id: string) => indicesByGroup[id] ?? null,
    getHoveredGroupId: () => null,
    setHoveredGroupId: vi.fn(),
    resolveHighlight: () => null,
    reset: vi.fn(),
  };
}

describe('WatchCinematicCameraService: state + gating', () => {
  it('defaults to enabled=true, active=false (no target yet)', () => {
    const s = createWatchCinematicCameraService();
    const st = s.getState();
    expect(st.enabled).toBe(true);
    expect(st.active).toBe(false);
    expect(st.pausedForUserInput).toBe(false);
    expect(st.eligibleClusterCount).toBe(0);
  });

  it('setEnabled(false) clears pause and blocks update()', () => {
    const s = createWatchCinematicCameraService();
    const renderer = makeRenderer();
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    );
    s.setEnabled(false);
    const ran = s.update({
      dtMs: 16, nowMs: 1000, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false,
    });
    expect(ran).toBe(false);
    expect(renderer.updateCinematicFraming).not.toHaveBeenCalled();
  });

  it('manualFollowActive: early-returns without mutating state', () => {
    const s = createWatchCinematicCameraService();
    const renderer = makeRenderer();
    const bg = makeBondedGroups([], {});
    const ran = s.update({
      dtMs: 16, nowMs: 1000, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: true,
    });
    expect(ran).toBe(false);
    expect(renderer.updateCinematicFraming).not.toHaveBeenCalled();
  });

  it('cooldown: pausedForUserInput=true within 1500ms of mark', () => {
    const s = createWatchCinematicCameraService();
    const renderer = makeRenderer();
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: Array.from({ length: 10 }, (_, i) => i) },
    );
    s.markUserCameraInteraction('change', 1_000_000);
    const ran = s.update({
      dtMs: 16, nowMs: 1_000_500, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false,
    });
    expect(ran).toBe(false);
    expect(s.getState().pausedForUserInput).toBe(true);
    expect(renderer.updateCinematicFraming).not.toHaveBeenCalled();
  });

  it('cooldown resumes after 1500ms and calls updateCinematicFraming', () => {
    const s = createWatchCinematicCameraService();
    const renderer = makeRenderer();
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: Array.from({ length: 10 }, (_, i) => i) },
    );
    s.markUserCameraInteraction('change', 1_000_000);
    const ran = s.update({
      dtMs: 16, nowMs: 1_002_000, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false,
    });
    expect(ran).toBe(true);
    expect(s.getState().pausedForUserInput).toBe(false);
    expect(renderer.updateCinematicFraming).toHaveBeenCalled();
    expect(s.getState().active).toBe(true);
    expect(s.getState().eligibleClusterCount).toBe(1);
  });
});

describe('WatchCinematicCameraService: target refresh cadence', () => {
  it('refreshes at cinematicSpeedProfile(1×) ~500ms baseline, reuses cache in-between', () => {
    const s = createWatchCinematicCameraService();
    const indices = Array.from({ length: 10 }, (_, i) => i);
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: indices },
    );
    const getPosition = vi.fn((i: number) => [i, 0, 0] as [number, number, number]);
    const renderer = makeRenderer({ getDisplayedAtomWorldPosition: getPosition });

    // t=0: first update forces a refresh (cache is null).
    s.update({ dtMs: 16, nowMs: 0, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    const afterFirst = getPosition.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // t=100ms: well inside 500ms window → cache reused, no new resolver walk.
    s.update({ dtMs: 16, nowMs: 100, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    expect(getPosition.mock.calls.length).toBe(afterFirst);

    // t=600ms: crossed the 500ms window → second walk.
    s.update({ dtMs: 16, nowMs: 600, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    expect(getPosition.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('mid-cycle target drop (resolver returns null) → no framing call this tick', () => {
    const s = createWatchCinematicCameraService();
    const bg = makeBondedGroups(
      // atomCount at threshold boundary — 3 is NOT eligible (> threshold).
      [{ id: 'g0', atomCount: 1 } as BondedGroupSummary],
      { g0: [0] },
    );
    const renderer = makeRenderer();
    const ran = s.update({
      dtMs: 16, nowMs: 1000, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false,
    });
    expect(ran).toBe(false);
    expect(renderer.updateCinematicFraming).not.toHaveBeenCalled();
    expect(s.getState().eligibleClusterCount).toBe(0);
  });
});

describe('WatchCinematicCameraService: setEnabled clears gesture state', () => {
  it("setEnabled(false) clears _userGestureActive — toggle off mid-hold does not stick paused on re-enable", () => {
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: Array.from({ length: 10 }, (_, i) => i) },
    );
    const renderer = makeRenderer();
    const s = createWatchCinematicCameraService();

    // User begins held gesture → _userGestureActive=true.
    s.markUserCameraInteraction('start', 1_000_000);

    // User toggles cinematic OFF while gesture still held.
    s.setEnabled(false);
    // Toggle back ON (simulating user flipping the UI switch).
    s.setEnabled(true);

    // Well past the cooldown window — with no fresh 'end' arriving,
    // a stuck `_userGestureActive` flag would pin gestureActive=true
    // forever. It must NOT.
    const ran = s.update({
      dtMs: 16, nowMs: 1_010_000, playbackSpeed: 1,
      renderer, bondedGroups: bg, manualFollowActive: false,
    });
    expect(ran).toBe(true);
    expect(s.getState().pausedForUserInput).toBe(false);
  });
});

describe('WatchCinematicCameraService: gesture phase gating', () => {
  it("held gesture keeps pause beyond cooldown window — 'start' without 'end'", () => {
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: Array.from({ length: 10 }, (_, i) => i) },
    );
    const renderer = makeRenderer();
    const s = createWatchCinematicCameraService();

    // User begins a gesture and holds without moving — no 'change',
    // no 'end'. Timestamp-only cooldown would expire after 1.5s.
    s.markUserCameraInteraction('start', 1_000_000);
    // 5s later — well past the 1.5s cooldown.
    const ran = s.update({
      dtMs: 16, nowMs: 1_005_000, playbackSpeed: 1,
      renderer, bondedGroups: bg, manualFollowActive: false,
    });
    expect(ran).toBe(false);
    expect(s.getState().pausedForUserInput).toBe(true);
  });

  it("'end' releases gestureActive and cooldown window runs from release", () => {
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: Array.from({ length: 10 }, (_, i) => i) },
    );
    const renderer = makeRenderer();
    const s = createWatchCinematicCameraService();

    s.markUserCameraInteraction('start', 1_000_000);
    s.markUserCameraInteraction('end', 1_010_000); // 10s hold

    // 500ms after end — inside cooldown.
    expect(
      s.update({ dtMs: 16, nowMs: 1_010_500, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false }),
    ).toBe(false);
    expect(s.getState().pausedForUserInput).toBe(true);

    // 2s after end — past 1.5s cooldown.
    expect(
      s.update({ dtMs: 16, nowMs: 1_012_000, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false }),
    ).toBe(true);
    expect(s.getState().pausedForUserInput).toBe(false);
  });

  it("default 'change' phase does NOT set gestureActive — cooldown-only semantics", () => {
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: Array.from({ length: 10 }, (_, i) => i) },
    );
    const renderer = makeRenderer();
    const s = createWatchCinematicCameraService();

    // Discrete action (centerOnGroup / triad tap) marks with default phase.
    s.markUserCameraInteraction(undefined, 1_000_000);

    // Well past the cooldown — cinematic should resume.
    expect(
      s.update({ dtMs: 16, nowMs: 1_002_000, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false }),
    ).toBe(true);
    expect(s.getState().pausedForUserInput).toBe(false);
  });
});

describe('WatchCinematicCameraService: continuity (no self-cooldown loop)', () => {
  it('runs back-to-back frames without pausing itself — programmatic framing MUST NOT trigger cooldown', () => {
    // Regression: a pre-fix implementation forwarded every
    // OrbitControls 'change' event to `onCameraInteraction` listeners
    // — including the one fired by the renderer's OWN programmatic
    // controls.update() inside updateCinematicFraming. That made the
    // service mark itself interacted on every frame, pause for 1.5s,
    // resume, move once, pause again → observable stutter.
    //
    // This test stands in for real browser behavior: the renderer
    // mock here does NOT invoke the onCameraInteraction listener
    // from updateCinematicFraming, which is the contract the
    // renderer's source-separated event wiring must honor. The
    // companion renderer-level test
    // (tests/unit/renderer-camera-interaction.test.ts) locks the
    // contract at the renderer boundary.
    let interactionListener: (() => void) | null = null;
    const renderer = makeRenderer({
      onCameraInteraction: vi.fn((listener: () => void) => {
        interactionListener = listener;
        return () => { interactionListener = null; };
      }),
      // A buggy renderer WOULD call this listener from inside
      // updateCinematicFraming. The fixed contract is that it must
      // not — so this mock simply calls the update and nothing else.
      updateCinematicFraming: vi.fn(),
    });
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: Array.from({ length: 10 }, (_, i) => i) },
    );
    const s = createWatchCinematicCameraService();
    s.attachRenderer(renderer);

    // 100 consecutive frames, 16ms apart. If the service ever pauses
    // itself from its own framing call, `active` would flip false.
    let ran = 0;
    for (let i = 0; i < 100; i++) {
      const did = s.update({
        dtMs: 16, nowMs: 1000 + i * 16, playbackSpeed: 1,
        renderer, bondedGroups: bg, manualFollowActive: false,
      });
      if (did) ran++;
    }
    expect(ran).toBeGreaterThan(90); // allow a few frames where cache-refresh is skipped but framing still ran
    expect(s.getState().pausedForUserInput).toBe(false);
    // Sanity: ensure the mock subscription was actually captured.
    expect(interactionListener).not.toBeNull();
  });
});

describe('WatchCinematicCameraService: config propagation', () => {
  it('custom speedTuning changes target refresh cadence', () => {
    // Default 1× → 500 ms interval. Custom baselineRefreshHz=8 →
    // 8 Hz → 125 ms interval. Verify the service actually uses this
    // instead of a hard-coded constant.
    const indices = Array.from({ length: 10 }, (_, i) => i);
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: indices },
    );
    const getPosition = vi.fn((i: number) => [i, 0, 0] as [number, number, number]);
    const renderer = makeRenderer({ getDisplayedAtomWorldPosition: getPosition });

    const service = createWatchCinematicCameraService({
      ...DEFAULT_CINEMATIC_CONFIG,
      speedTuning: {
        ...DEFAULT_CINEMATIC_SPEED_TUNING,
        baselineRefreshHz: 8,
      },
    });

    // First tick seeds cache; second tick at 130 ms crosses the
    // 125 ms custom interval; with default tuning it would still
    // be inside the 500 ms baseline and re-use cache.
    service.update({ dtMs: 16, nowMs: 0, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    const afterFirst = getPosition.mock.calls.length;
    service.update({ dtMs: 16, nowMs: 130, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    expect(getPosition.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('custom userIdleResumeMs lengthens cooldown window', () => {
    const indices = Array.from({ length: 10 }, (_, i) => i);
    const bg = makeBondedGroups(
      [{ id: 'g0', atomCount: 10 } as BondedGroupSummary],
      { g0: indices },
    );
    const renderer = makeRenderer();

    const service = createWatchCinematicCameraService({
      ...DEFAULT_CINEMATIC_CONFIG,
      userIdleResumeMs: 5000,
    });

    service.markUserCameraInteraction('change', 1_000_000);
    // At +3s: default cooldown (1.5s) would have expired, but custom
    // 5s cooldown keeps us paused.
    const ran = service.update({
      dtMs: 16, nowMs: 1_003_000, playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false,
    });
    expect(ran).toBe(false);
    expect(service.getState().pausedForUserInput).toBe(true);
  });
});

describe('WatchCinematicCameraService: lifecycle', () => {
  it('attachRenderer subscribes; disposer flips to interaction mark', () => {
    let captured: (() => void) | null = null;
    const renderer = makeRenderer({
      onCameraInteraction: vi.fn((listener: () => void) => {
        captured = listener;
        return () => { captured = null; };
      }),
    });
    const s = createWatchCinematicCameraService();
    s.attachRenderer(renderer);
    expect(renderer.onCameraInteraction).toHaveBeenCalledTimes(1);

    // Listener invocation must advance the cooldown.
    captured!();
    expect(s.getState().pausedForUserInput).toBe(false);
    // Next update() call should set pausedForUserInput true because
    // the interaction just happened.
    const bg = makeBondedGroups([], {});
    s.update({ dtMs: 16, nowMs: performance.now(), playbackSpeed: 1, renderer, bondedGroups: bg, manualFollowActive: false });
    expect(s.getState().pausedForUserInput).toBe(true);
  });

  it('attachRenderer is idempotent on swap — old subscription disposed', () => {
    const disposeA = vi.fn();
    const rendererA = makeRenderer({
      onCameraInteraction: vi.fn(() => disposeA),
    });
    const rendererB = makeRenderer({
      onCameraInteraction: vi.fn(() => vi.fn()),
    });
    const s = createWatchCinematicCameraService();
    s.attachRenderer(rendererA);
    s.attachRenderer(rendererB);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(rendererB.onCameraInteraction).toHaveBeenCalledTimes(1);
  });

  it('resetForFile preserves enabled + subscription, clears cache/cooldown', () => {
    const dispose = vi.fn();
    const renderer = makeRenderer({
      onCameraInteraction: vi.fn(() => dispose),
    });
    const s = createWatchCinematicCameraService();
    s.attachRenderer(renderer);
    s.markUserCameraInteraction('change', performance.now());
    s.resetForFile();
    expect(dispose).not.toHaveBeenCalled();
    expect(s.getState().enabled).toBe(true);
    expect(s.getState().pausedForUserInput).toBe(false);
  });

  it('dispose releases the subscription and clears state', () => {
    const dispose = vi.fn();
    const renderer = makeRenderer({
      onCameraInteraction: vi.fn(() => dispose),
    });
    const s = createWatchCinematicCameraService();
    s.attachRenderer(renderer);
    s.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
