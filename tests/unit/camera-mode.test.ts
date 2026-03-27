/**
 * Unit tests for camera mode store state.
 * Note: Free-Look is currently feature-disabled but implementation is retained.
 * These tests temporarily enable the flag to verify internal behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useAppStore } from '../../page/js/store/app-store';
import { selectCameraMode } from '../../page/js/store/selectors/camera';
import { CONFIG } from '../../page/js/config';

describe('Camera mode store', () => {
  const savedFlag = CONFIG.camera.freeLookEnabled;
  beforeEach(() => {
    (CONFIG.camera as any).freeLookEnabled = true;
    useAppStore.getState().resetTransientState();
  });
  afterEach(() => {
    (CONFIG.camera as any).freeLookEnabled = savedFlag;
  });

  it('defaults to orbit mode', () => {
    expect(useAppStore.getState().cameraMode).toBe('orbit');
  });

  it('setCameraMode switches to freelook', () => {
    useAppStore.getState().setCameraMode('freelook');
    expect(useAppStore.getState().cameraMode).toBe('freelook');
  });

  it('setCameraMode switches back to orbit', () => {
    useAppStore.getState().setCameraMode('freelook');
    useAppStore.getState().setCameraMode('orbit');
    expect(useAppStore.getState().cameraMode).toBe('orbit');
  });

  it('resetTransientState restores orbit mode', () => {
    useAppStore.getState().setCameraMode('freelook');
    useAppStore.getState().resetTransientState();
    expect(useAppStore.getState().cameraMode).toBe('orbit');
  });

  it('selectCameraMode returns current mode', () => {
    expect(selectCameraMode(useAppStore.getState())).toBe('orbit');
    useAppStore.getState().setCameraMode('freelook');
    expect(selectCameraMode(useAppStore.getState())).toBe('freelook');
  });
});
