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

vi.mock('../../watch/js/view/watch-renderer', async () => {
  const { createWatchRendererStub } = await vi.importActual<typeof import('../helpers/watch-renderer-stub')>('../helpers/watch-renderer-stub');
  return {
    createWatchRenderer: vi.fn(() => createWatchRendererStub()),
  };
});

vi.mock('../../watch/js/view/watch-camera-input', () => ({
  createWatchCameraInput: vi.fn((_renderer, opts) => {
    capturedCameraInputOpts = opts;
    return { destroy: vi.fn() };
  }),
}));

// Stub cinematic service — we want a spy on markUserCameraInteraction
// so we can assert the phase forwarded by the controller.
const createServiceSpy = vi.fn();
vi.mock('../../watch/js/view/watch-cinematic-camera', () => ({
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
vi.mock('../../watch/js/view/watch-overlay-layout', () => ({
  createWatchOverlayLayout: vi.fn(() => ({ destroy: vi.fn() })),
}));

import { createWatchController } from '../../watch/js/app/watch-controller';

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

  it('snapshot.cinematicCameraStatus reflects service status when not following', () => {
    const ctrl = createWatchController();
    const service = createServiceSpy.mock.calls[0][0] as {
      getState: ReturnType<typeof vi.fn>;
      setEnabled: ReturnType<typeof vi.fn>;
    };

    // Service reports waiting_topology.
    service.getState.mockReturnValue({
      enabled: true, active: false, pausedForUserInput: false,
      eligibleClusterCount: 2, status: 'waiting_topology',
    });
    // Force a snapshot rebuild.
    ctrl.setCinematicCameraEnabled(true);
    expect(ctrl.getSnapshot().cinematicCameraStatus).toBe('waiting_topology');

    // Switch to tracking.
    service.getState.mockReturnValue({
      enabled: true, active: true, pausedForUserInput: false,
      eligibleClusterCount: 2, status: 'tracking',
    });
    ctrl.setCinematicCameraEnabled(true);
    expect(ctrl.getSnapshot().cinematicCameraStatus).toBe('tracking');

    // Switch to paused.
    service.getState.mockReturnValue({
      enabled: true, active: false, pausedForUserInput: true,
      eligibleClusterCount: 1, status: 'paused',
    });
    ctrl.setCinematicCameraEnabled(true);
    expect(ctrl.getSnapshot().cinematicCameraStatus).toBe('paused');

    ctrl.dispose();
  });

  it('deriveCinematicCameraStatus overrides all non-off statuses when following', async () => {
    // Behavioral test of the extracted pure helper — tests the actual
    // function the controller calls in buildSnapshot, not source text.
    const { deriveCinematicCameraStatus } = await import('../../watch/js/app/watch-controller');

    // Not following: all statuses pass through.
    expect(deriveCinematicCameraStatus('tracking', false)).toBe('tracking');
    expect(deriveCinematicCameraStatus('paused', false)).toBe('paused');
    expect(deriveCinematicCameraStatus('waiting_topology', false)).toBe('waiting_topology');
    expect(deriveCinematicCameraStatus('waiting_major_clusters', false)).toBe('waiting_major_clusters');
    expect(deriveCinematicCameraStatus('off', false)).toBe('off');

    // Following: every non-off status becomes suppressed_by_follow.
    expect(deriveCinematicCameraStatus('tracking', true)).toBe('suppressed_by_follow');
    expect(deriveCinematicCameraStatus('paused', true)).toBe('suppressed_by_follow');
    expect(deriveCinematicCameraStatus('waiting_topology', true)).toBe('suppressed_by_follow');
    expect(deriveCinematicCameraStatus('waiting_major_clusters', true)).toBe('suppressed_by_follow');

    // Following + off stays off (cinematic disabled by user).
    expect(deriveCinematicCameraStatus('off', true)).toBe('off');
  });

  it('snapshotChanged fires when only status changes', () => {
    const ctrl = createWatchController();
    const service = createServiceSpy.mock.calls[0][0] as {
      getState: ReturnType<typeof vi.fn>;
    };
    const listener = vi.fn();
    ctrl.subscribe(listener);

    service.getState.mockReturnValue({
      enabled: true, active: true, pausedForUserInput: false,
      eligibleClusterCount: 2, status: 'tracking',
    });
    // Force a snapshot rebuild by toggling cinematic (which publishes).
    ctrl.setCinematicCameraEnabled(true);
    listener.mockClear();

    // Now change ONLY the status.
    service.getState.mockReturnValue({
      enabled: true, active: false, pausedForUserInput: true,
      eligibleClusterCount: 2, status: 'paused',
    });
    ctrl.setCinematicCameraEnabled(true); // triggers publishSnapshot
    expect(listener).toHaveBeenCalled();

    ctrl.dispose();
  });
});
