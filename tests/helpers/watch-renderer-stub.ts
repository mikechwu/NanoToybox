/**
 * Shared WatchRenderer test stub — used by cinematic-camera service
 * tests, integration tests, and controller-wiring tests so they stay
 * in sync when the WatchRenderer interface grows.
 *
 * Accepts an optional jsdom canvas (for tests that dispatch real DOM
 * events) and per-method overrides.
 */
import { vi } from 'vitest';
import type { WatchRenderer } from '../../watch/js/view/watch-renderer';

export function createWatchRendererStub(
  overrides: Partial<WatchRenderer> & { _canvas?: HTMLCanvasElement } = {},
): WatchRenderer & { _canvas: HTMLCanvasElement } {
  const canvas = overrides._canvas ?? (() => {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.setPointerCapture = vi.fn();
      c.releasePointerCapture = vi.fn();
      c.hasPointerCapture = vi.fn(() => false);
      return c;
    }
    // Minimal mock for Node-only test environments (no jsdom).
    return {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as HTMLCanvasElement;
  })();

  return {
    _canvas: canvas,
    getCanvas: () => canvas,
    applyTheme: vi.fn(),
    initForPlayback: vi.fn(),
    updateReviewFrame: vi.fn(),
    fitCamera: vi.fn(),
    render: vi.fn(),
    destroy: vi.fn(),
    setGroupHighlight: vi.fn(),
    clearGroupHighlight: vi.fn(),
    getDisplayedAtomWorldPosition: vi.fn(() => [0, 0, 0] as [number, number, number]),
    getSceneRadius: vi.fn(() => 10),
    animateToFramedTarget: vi.fn(),
    updateOrbitFollow: vi.fn(),
    isInsideTriad: vi.fn(() => false),
    applyOrbitDelta: vi.fn(),
    getNearestAxisEndpoint: vi.fn(() => null),
    snapToAxis: vi.fn(),
    animatedResetView: vi.fn(),
    showAxisHighlight: vi.fn(),
    startBackgroundOrbitCue: vi.fn(),
    endBackgroundOrbitCue: vi.fn(),
    cancelCameraAnimation: vi.fn(),
    setOverlayLayout: vi.fn(),
    setAtomColorOverrides: vi.fn(),
    updateCinematicFraming: vi.fn(),
    onCameraInteraction: vi.fn(() => () => {}),
    getOrbitCameraSnapshot: vi.fn(() => null),
    ...overrides,
  } as WatchRenderer & { _canvas: HTMLCanvasElement };
}
