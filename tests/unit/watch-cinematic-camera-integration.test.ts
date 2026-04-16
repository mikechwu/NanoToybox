/**
 * @vitest-environment jsdom
 */
/**
 * Behavioral integration test for Watch's custom camera input +
 * cinematic service.
 *
 * **Scope — lower-level seam only.** This test wires the real
 * `createWatchCameraInput` + real `createWatchCinematicCameraService`
 * together with the same callback shape the controller uses. It
 * proves the two services interoperate correctly when wired
 * correctly. It does NOT prove the production controller
 * (`watch/js/watch-controller.ts`) wires them the same way at
 * runtime — that is covered by
 * `watch-cinematic-camera-controller.test.ts`, which runs against
 * the real controller with mocked factories.
 *
 * Renderer instantiation is skipped (requires WebGL). DOM events
 * on the jsdom canvas drive the phase-propagation path end-to-end
 * through production code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatchCameraInput } from '../../watch/js/watch-camera-input';
import { createWatchCinematicCameraService } from '../../watch/js/watch-cinematic-camera';
import type { WatchBondedGroups, BondedGroupSummary } from '../../watch/js/watch-bonded-groups';
import { createWatchRendererStub } from '../helpers/watch-renderer-stub';

function makeBondedGroups(): WatchBondedGroups {
  const summary: BondedGroupSummary = { id: 'g0', atomCount: 10 } as BondedGroupSummary;
  return {
    updateForTime: vi.fn(() => [summary]),
    getSummaries: () => [summary],
    getAtomIndicesForGroup: () => Array.from({ length: 10 }, (_, i) => i),
    getHoveredGroupId: () => null,
    setHoveredGroupId: vi.fn(),
    resolveHighlight: () => null,
    reset: vi.fn(),
  };
}

describe('WatchCameraInput + WatchCinematicCameraService phase integration', () => {
  // Force desktop pointer path — matchMedia defaults may detect
  // the jsdom env as coarse touch otherwise. Scoped to this
  // describe via beforeEach/afterEach so future tests in this file
  // don't inherit the mutation silently.
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (q: string) => ({ matches: q === '(hover: hover)', media: q, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it('held pointer drag keeps cinematic paused beyond the 1500ms cooldown window', () => {
    const renderer = createWatchRendererStub();
    const bondedGroups = makeBondedGroups();
    const service = createWatchCinematicCameraService();

    // `markUserCameraInteraction`'s default `nowMs` uses
    // `performance.now()`. Spy it so the camera-input's 'start'/'end'
    // timestamps share the same clock as the synthetic `nowMs` we
    // feed to `service.update(...)`. Without this, jsdom's real
    // `performance.now()` (~milliseconds since page load) would
    // drift from the synthetic frame time and make the cooldown
    // math meaningless.
    const perfNow = vi.spyOn(performance, 'now');

    // Wire camera-input the SAME way the controller does (phase-
    // forwarding). The bug this test locks in place was forwarding
    // a zero-arg callback instead of the phase.
    //
    // Record phases as they flow through so a failure can tell us
    // whether the issue is event emission (wrong phase string),
    // service state (phase correct but state transition wrong), or
    // update gating (state correct but cooldown math broken).
    const phases: string[] = [];
    const cameraInput = createWatchCameraInput(renderer, {
      onUserCameraInteraction: (phase) => {
        phases.push(phase);
        service.markUserCameraInteraction(phase);
      },
    });

    try {
      document.body.appendChild(renderer._canvas);

      // Baseline: before any interaction, update() runs.
      perfNow.mockReturnValue(1000);
      const baselineRan = service.update({
        dtMs: 16, nowMs: 1000, playbackSpeed: 1, renderer, bondedGroups, manualFollowActive: false,
      });
      expect(baselineRan).toBe(true);
      (renderer.updateCinematicFraming as ReturnType<typeof vi.fn>).mockClear();

      // Pointer-down on background → 'start' → _userGestureActive=true.
      perfNow.mockReturnValue(1000);
      renderer._canvas.dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 }),
      );

      // Simulate 3 seconds elapsing with NO pointerup and NO motion.
      // Default cooldown is 1500ms — timestamp-only logic would
      // have long expired. Held-gesture logic must keep pause.
      perfNow.mockReturnValue(4000);
      const ranDuringHold = service.update({
        dtMs: 16, nowMs: 4000, playbackSpeed: 1, renderer, bondedGroups, manualFollowActive: false,
      });
      expect(ranDuringHold).toBe(false);
      expect(service.getState().pausedForUserInput).toBe(true);
      expect(renderer.updateCinematicFraming).not.toHaveBeenCalled();

      // User releases. Cooldown window starts from the 'end' timestamp.
      perfNow.mockReturnValue(4000);
      renderer._canvas.dispatchEvent(
        new PointerEvent('pointerup', { button: 0, pointerId: 1 }),
      );

      // 500ms after release — still inside the cooldown window.
      perfNow.mockReturnValue(4500);
      const ranDuringCooldown = service.update({
        dtMs: 16, nowMs: 4500, playbackSpeed: 1, renderer, bondedGroups, manualFollowActive: false,
      });
      expect(ranDuringCooldown).toBe(false);
      expect(service.getState().pausedForUserInput).toBe(true);

      // 2.5s after release — past cooldown; cinematic resumes.
      perfNow.mockReturnValue(6500);
      const ranAfterCooldown = service.update({
        dtMs: 16, nowMs: 6500, playbackSpeed: 1, renderer, bondedGroups, manualFollowActive: false,
      });
      expect(ranAfterCooldown).toBe(true);
      expect(service.getState().pausedForUserInput).toBe(false);
      expect(renderer.updateCinematicFraming).toHaveBeenCalled();

      // Full phase trace: a no-motion pointerdown/pointerup sequence
      // must produce exactly 'start' then 'end'. If a regression
      // collapses phases to 'change', the cooldown expectations
      // above would still hold in some orderings — this assertion
      // localizes the failure to the emission layer.
      expect(phases).toEqual(['start', 'end']);
    } finally {
      perfNow.mockRestore();
      cameraInput.destroy();
      renderer._canvas.remove();
    }
  });
});
