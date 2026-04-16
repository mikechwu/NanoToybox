/**
 * @vitest-environment jsdom
 */
/**
 * Controller-level behavioral test for Watch's cinematic camera
 * wiring.
 *
 * **Scope — the production controller only.** This test runs the
 * real `createWatchController` with three downstream factories
 * mocked (`watch-renderer`, `watch-camera-input`,
 * `watch-cinematic-camera`) so we can observe the exact opts the
 * controller passes to each. It proves the controller wires
 * `onUserCameraInteraction` to forward phases into the cinematic
 * service — NOT just that the source text matches a regex.
 *
 * A regression that reverts the wiring to `() => mark()` (the
 * original bug, which collapsed phases to default 'change' and
 * let held gestures expire cooldown mid-hold) would cause the
 * `markUserCameraInteraction` spy to be called without a phase
 * argument and this test to fail immediately.
 *
 * Companion test:
 * `watch-cinematic-camera-integration.test.ts` covers the lower-
 * level services-only seam.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (hoisted by vi.mock) ──

// Capture the opts the controller passes to createWatchCameraInput
// so we can invoke its `onUserCameraInteraction` callback and
// observe what flows into the cinematic service.
let capturedCameraInputOpts: { onUserCameraInteraction?: (p: any) => void } | undefined;

vi.mock('../../watch/js/watch-renderer', async () => {
  const { createWatchRendererStub } = await vi.importActual<typeof import('../helpers/watch-renderer-stub')>('../helpers/watch-renderer-stub');
  return {
    createWatchRenderer: vi.fn(() => createWatchRendererStub()),
  };
});

vi.mock('../../watch/js/watch-camera-input', () => ({
  createWatchCameraInput: vi.fn((_renderer, opts) => {
    capturedCameraInputOpts = opts;
    return { destroy: vi.fn() };
  }),
}));

// Stub cinematic service — we want a spy on markUserCameraInteraction
// so we can assert the phase forwarded by the controller.
const createServiceSpy = vi.fn();
vi.mock('../../watch/js/watch-cinematic-camera', () => ({
  createWatchCinematicCameraService: (..._args: any[]) => {
    const service = {
      getState: vi.fn(() => ({
        enabled: true,
        active: false,
        pausedForUserInput: false,
        eligibleClusterCount: 0,
      })),
      setEnabled: vi.fn(),
      markUserCameraInteraction: vi.fn(),
      update: vi.fn(() => false),
      attachRenderer: vi.fn(),
      resetForFile: vi.fn(),
      dispose: vi.fn(),
    };
    createServiceSpy(service);
    return service;
  },
}));

// Overlay layout is a side-dependency of createRenderer — stub so
// we don't need to build a full DOM layout harness.
vi.mock('../../watch/js/watch-overlay-layout', () => ({
  createWatchOverlayLayout: vi.fn(() => ({ destroy: vi.fn() })),
}));

import { createWatchController } from '../../watch/js/watch-controller';

// ── Test ──

describe('WatchController cinematic wiring (real controller, mocked factories)', () => {
  beforeEach(() => {
    capturedCameraInputOpts = undefined;
    createServiceSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards each phase received from createWatchCameraInput into cinematicCamera.markUserCameraInteraction", () => {
    const ctrl = createWatchController();
    const container = document.createElement('div');

    ctrl.createRenderer(container);

    // The controller should have constructed one cinematic service
    // (at createWatchController time) and passed our opts through
    // createWatchCameraInput (at createRenderer time).
    expect(createServiceSpy).toHaveBeenCalledTimes(1);
    expect(capturedCameraInputOpts).toBeDefined();
    expect(typeof capturedCameraInputOpts!.onUserCameraInteraction).toBe('function');

    const service = createServiceSpy.mock.calls[0][0] as {
      markUserCameraInteraction: ReturnType<typeof vi.fn>;
      attachRenderer: ReturnType<typeof vi.fn>;
    };

    // Drive each phase through the controller's captured callback
    // and assert it arrives at the service unchanged. The prior bug
    // passed `() => mark()` — which would call mark with no args
    // and collapse every phase to default 'change'.
    capturedCameraInputOpts!.onUserCameraInteraction!('start');
    expect(service.markUserCameraInteraction).toHaveBeenLastCalledWith('start');

    capturedCameraInputOpts!.onUserCameraInteraction!('change');
    expect(service.markUserCameraInteraction).toHaveBeenLastCalledWith('change');

    capturedCameraInputOpts!.onUserCameraInteraction!('end');
    expect(service.markUserCameraInteraction).toHaveBeenLastCalledWith('end');

    // Also verify attachRenderer was called (separate lifecycle
    // that the controller handles at the same seam).
    expect(service.attachRenderer).toHaveBeenCalledTimes(1);

    ctrl.dispose();
  });
});
