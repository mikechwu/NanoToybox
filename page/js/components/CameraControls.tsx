/**
 * CameraControls — Object View panel with Center and Follow actions.
 *
 * Positioned by CSS custom properties set by overlay-layout.ts.
 * Desktop: hover/focus tooltips via ActionHint.
 * Mobile: inline .camera-action-hint secondary text.
 *
 * Store is sole authority for orbitFollowEnabled.
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { CONFIG } from '../config';
import { IconCenter, IconFollow, IconFreeze, IconReturn } from './Icons';
import { ActionHint } from './ActionHint';

export function CameraControls() {
  const cameraMode = useAppStore((s) => s.cameraMode);
  const orbitFollowEnabled = useAppStore((s) => s.orbitFollowEnabled);
  const flightActive = useAppStore((s) => s.flightActive);
  const farDrift = useAppStore((s) => s.farDrift);
  const cameraCallbacks = useAppStore((s) => s.cameraCallbacks);

  const handleCenterObject = useCallback(() => {
    cameraCallbacks?.onCenterObject?.();
  }, [cameraCallbacks]);

  const handleFollowToggle = useCallback(() => {
    const store = useAppStore.getState();
    if (store.orbitFollowEnabled) {
      store.setOrbitFollowEnabled(false);
    } else {
      const resolved = cameraCallbacks?.onEnableFollow?.() ?? false;
      if (resolved) {
        store.setOrbitFollowEnabled(true);
      }
    }
  }, [cameraCallbacks]);

  const handleModeToggle = useCallback(() => {
    const store = useAppStore.getState();
    store.setCameraMode(store.cameraMode === 'orbit' ? 'freelook' : 'orbit');
  }, []);

  const followHintText = orbitFollowEnabled
    ? 'Following current molecule. Tap to stop.'
    : 'Keep the current molecule centered as it moves.';

  return (
    <div className="camera-controls" data-camera-controls>
      {/* Mode toggle — only when Free-Look is enabled */}
      {CONFIG.camera.freeLookEnabled && (
        <button
          className="camera-action"
          onClick={handleModeToggle}
          aria-label={`Switch to ${cameraMode === 'orbit' ? 'Free-Look' : 'Orbit'}`}
        >
          {cameraMode === 'orbit' ? 'Free' : 'Orbit'}
        </button>
      )}

      {/* Orbit mode: Center + Follow */}
      {cameraMode === 'orbit' && (
        <>
          <ActionHint text="Frame the current molecule once." placement="right">
            <button
              className="camera-action"
              onClick={handleCenterObject}
              aria-label="Center Object"
            >
              <IconCenter />
              <span className="camera-action-label">
                Center
                <span className="camera-action-hint">Frame molecule</span>
              </span>
            </button>
          </ActionHint>
          <ActionHint text={followHintText} placement="right">
            <button
              className={`camera-action${orbitFollowEnabled ? ' camera-action-active' : ''}`}
              onClick={handleFollowToggle}
              aria-label={orbitFollowEnabled ? 'Following target (tap to stop)' : 'Follow'}
            >
              <IconFollow />
              <span className="camera-action-label">
                Follow
                <span className="camera-action-hint">{orbitFollowEnabled ? 'Tap to stop' : 'Track molecule'}</span>
              </span>
            </button>
          </ActionHint>
        </>
      )}

      {/* Free-Look actions (gated by feature flag) */}
      {CONFIG.camera.freeLookEnabled && cameraMode === 'freelook' && flightActive && (
        <button
          className="camera-action"
          onClick={() => cameraCallbacks?.onFreeze?.()}
          aria-label="Freeze"
        >
          <IconFreeze />
        </button>
      )}
      {CONFIG.camera.freeLookEnabled && cameraMode === 'freelook' && (
        <button
          className={`camera-action${farDrift ? ' camera-action-pulse' : ''}`}
          onClick={() => {
            cameraCallbacks?.onReturnToObject?.();
          }}
          aria-label="Return to Object"
        >
          <IconReturn />
        </button>
      )}
    </div>
  );
}
