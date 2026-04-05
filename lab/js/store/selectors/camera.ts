/**
 * Camera mode selector — reads the store-authoritative camera mode.
 *
 * Store is the sole authority for camera mode. Renderer and input are
 * consumers only. UI toggle and recovery actions are the only writers.
 */

import type { AppStore } from '../app-store';

export type CameraMode = 'orbit' | 'freelook';

export function selectCameraMode(s: AppStore): CameraMode {
  return s.cameraMode;
}
