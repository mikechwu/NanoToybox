/**
 * App lifecycle tests — guards the teardown sequence ordering.
 *
 * Verifies:
 * - All subsystem teardowns are called in dependency order
 * - Subscriptions are unsubscribed
 * - Stateless helpers are deactivated/reset before nulling
 * - resetRuntimeState is called last
 */
import { describe, it, expect, vi } from 'vitest';
import { teardownAllSubsystems, type TeardownSurface } from '../../lab/js/app/app-lifecycle';

function makeTeardownSurface(): { surface: TeardownSurface; order: string[] } {
  const order: string[] = [];
  return {
    order,
    surface: {
      stopFrameLoop: vi.fn(() => order.push('stopFrameLoop')),
      removeAllGlobalListeners: vi.fn(() => order.push('removeGlobalListeners')),
      cleanupDebugHooks: vi.fn(() => order.push('cleanupDebugHooks')),
      timelineSub: { teardown: vi.fn(() => order.push('timeline.teardown')) },
      onboarding: { destroy: vi.fn(() => order.push('onboarding.destroy')) },
      unsubOnboardingOverlay: vi.fn(() => order.push('unsubOnboarding')),
      atomInteractionHint: { destroy: vi.fn(() => order.push('atomHint.destroy')) },
      unsubAtomHintReadiness: vi.fn(() => order.push('unsubAtomHint')),
      unsubCameraMode: vi.fn(() => order.push('unsubCameraMode')),
      bondedGroupCoordinator: { teardown: vi.fn(() => order.push('bondedGroup.teardown')) },
      overlayLayout: { destroy: vi.fn(() => order.push('overlay.destroy')) },
      placement: { destroy: vi.fn(() => order.push('placement.destroy')) },
      statusCtrl: { destroy: vi.fn(() => order.push('status.destroy')) },
      inputBindings: { destroy: vi.fn(() => order.push('input.destroy')) },
      workerRuntime: { destroy: vi.fn(() => order.push('worker.destroy')) },
      renderer: { destroy: vi.fn(() => order.push('renderer.destroy')) },
      dragRefresh: { deactivate: vi.fn(() => order.push('dragRefresh.deactivate')) },
      snapshotReconciler: { reset: vi.fn(() => order.push('reconciler.reset')) },
      resetRuntimeState: vi.fn(() => order.push('resetState')),
    },
  };
}

describe('teardownAllSubsystems', () => {
  it('calls all subsystem teardowns in the exact documented sequence', () => {
    const { surface, order } = makeTeardownSurface();
    teardownAllSubsystems(surface);

    // Full 17-step sequence matching the contract in app-lifecycle.ts
    expect(order).toEqual([
      'stopFrameLoop',
      'removeGlobalListeners',
      'cleanupDebugHooks',
      'timeline.teardown',
      'onboarding.destroy',
      'unsubOnboarding',
      'atomHint.destroy',
      'unsubAtomHint',
      'unsubCameraMode',
      'bondedGroup.teardown',
      'overlay.destroy',
      'placement.destroy',
      'status.destroy',
      'input.destroy',
      'worker.destroy',
      'renderer.destroy',
      'dragRefresh.deactivate',
      'reconciler.reset',
      'resetState',
    ]);
  });

  it('unsubscribes all tracked subscriptions', () => {
    const { surface } = makeTeardownSurface();
    teardownAllSubsystems(surface);

    expect(surface.unsubOnboardingOverlay).toHaveBeenCalledOnce();
    expect(surface.unsubCameraMode).toHaveBeenCalledOnce();
  });

  it('calls resetRuntimeState after all subsystem teardowns', () => {
    const { surface, order } = makeTeardownSurface();
    teardownAllSubsystems(surface);

    expect(order[order.length - 1]).toBe('resetState');
  });

  it('handles null subsystems gracefully (partial init)', () => {
    const order: string[] = [];
    const surface: TeardownSurface = {
      stopFrameLoop: vi.fn(() => order.push('stop')),
      removeAllGlobalListeners: vi.fn(),
      cleanupDebugHooks: vi.fn(),
      timelineSub: null,
      onboarding: null,
      unsubOnboardingOverlay: null,
      atomInteractionHint: null,
      unsubAtomHintReadiness: null,
      unsubCameraMode: null,
      bondedGroupCoordinator: null,
      overlayLayout: null,
      placement: null,
      statusCtrl: null,
      inputBindings: null,
      workerRuntime: null,
      renderer: null,
      dragRefresh: null,
      snapshotReconciler: null,
      resetRuntimeState: vi.fn(() => order.push('reset')),
    };

    expect(() => teardownAllSubsystems(surface)).not.toThrow();
    expect(order).toEqual(['stop', 'reset']);
  });
});
