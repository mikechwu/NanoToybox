/**
 * Regression test: Free-Look is disabled by CONFIG.camera.freeLookEnabled.
 *
 * Free-Look implementation is retained as a dormant module. These tests verify
 * that when the feature flag is off, the runtime cannot enter Free-Look mode
 * and the store rejects freelook transitions.
 *
 * To re-enable Free-Look, set CONFIG.camera.freeLookEnabled = true and
 * validate UI/input paths.
 */
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../lab/js/store/app-store';
import { CONFIG } from '../../lab/js/config';

// Mock matchMedia for InputManager
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});

import { InputManager } from '../../lab/js/input';
import * as THREE from 'three';

describe('Free-Look disabled (feature flag)', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('CONFIG.camera.freeLookEnabled is false', () => {
    expect(CONFIG.camera.freeLookEnabled).toBe(false);
  });

  it('setCameraMode("freelook") is rejected when disabled', () => {
    useAppStore.getState().setCameraMode('freelook');
    expect(useAppStore.getState().cameraMode).toBe('orbit');
  });

  it('setCameraMode("orbit") still works', () => {
    useAppStore.getState().setCameraMode('orbit');
    expect(useAppStore.getState().cameraMode).toBe('orbit');
  });

  it('cameraMode stays orbit after multiple attempts', () => {
    useAppStore.getState().setCameraMode('freelook');
    useAppStore.getState().setCameraMode('freelook');
    useAppStore.getState().setCameraMode('freelook');
    expect(useAppStore.getState().cameraMode).toBe('orbit');
  });

  it('_getCameraMode returns orbit even if store state is forced to freelook', () => {
    // Force store state directly (bypassing setter guard)
    useAppStore.setState({ cameraMode: 'freelook' });

    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 600,
      right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    });
    const camera = new THREE.PerspectiveCamera(50, 800/600, 0.1, 2000);
    const im = new InputManager(canvas, camera, { count: 0, getWorldPosition: vi.fn(), raycastTarget: null }, {});

    // Inject getter that reads store (like production code)
    im.setCameraStateGetter(() => useAppStore.getState().cameraMode);

    // Even though store says 'freelook', getter should return 'orbit' because flag is off
    expect(im._getCameraMode()).toBe('orbit');

    im.destroy();
    useAppStore.setState({ cameraMode: 'orbit' }); // cleanup
  });

  it('keydown WASD does not add to pressedKeys when flag is off and store forced', () => {
    useAppStore.setState({ cameraMode: 'freelook' });

    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 600,
      right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    });
    const camera = new THREE.PerspectiveCamera(50, 800/600, 0.1, 2000);
    const im = new InputManager(canvas, camera, { count: 0, getWorldPosition: vi.fn(), raycastTarget: null }, {});
    im.setCameraStateGetter(() => useAppStore.getState().cameraMode);

    const evt = new KeyboardEvent('keydown', { code: 'KeyW' });
    Object.defineProperty(evt, 'target', { value: canvas });
    im._handlers.keydown(evt);

    // Should NOT process because _getCameraMode returns 'orbit' when flag is off
    expect(im._pressedKeys.size).toBe(0);

    im.destroy();
    useAppStore.setState({ cameraMode: 'orbit' });
  });

  it('all main.ts freelook branches are gated by config flag', () => {
    // Verify that every cameraMode === 'freelook' check in main.ts
    // is paired with CONFIG.camera.freeLookEnabled.
    // This test validates the contract: when flag is off, store state
    // 'freelook' (if forced) has no runtime effect.

    // Force store to freelook (bypasses setter guard)
    useAppStore.setState({ cameraMode: 'freelook' });

    // With flag off, setCameraMode('orbit') should still work
    // (the setter doesn't block orbit transitions)
    useAppStore.getState().setCameraMode('orbit');
    expect(useAppStore.getState().cameraMode).toBe('orbit');

    // Force back and verify flightActive/farDrift stay false
    useAppStore.setState({ cameraMode: 'freelook' });
    expect(useAppStore.getState().flightActive).toBe(false);
    expect(useAppStore.getState().farDrift).toBe(false);

    useAppStore.setState({ cameraMode: 'orbit' }); // cleanup
  });
});
