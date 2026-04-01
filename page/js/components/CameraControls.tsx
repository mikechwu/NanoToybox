/**
 * CameraControls — Object View panel with Center and Follow actions.
 *
 * Phase 1: Replaces old Orbit chip + ? + ⊕ cluster with explicit buttons.
 * Positioned by CSS custom properties set by overlay-layout.ts.
 *
 * - Center: one-shot camera animate to best focus target
 * - Follow: toggle orbit-follow tracking on/off
 *
 * No onboarding or help surface — guidance lives in Settings > Controls.
 * Store is sole authority for orbitFollowEnabled.
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { CONFIG } from '../config';
import { IconCenter, IconFollow, IconFreeze, IconReturn } from './Icons';

export function CameraControls() {
  const cameraMode = useAppStore((s) => s.cameraMode);
  const orbitFollowEnabled = useAppStore((s) => s.orbitFollowEnabled);
  const flightActive = useAppStore((s) => s.flightActive);
  const farDrift = useAppStore((s) => s.farDrift);
  const cameraCallbacks = useAppStore((s) => s.cameraCallbacks);

  // Center Object: dispatched through registered callback
  const handleCenterObject = useCallback(() => {
    cameraCallbacks?.onCenterObject?.();
  }, [cameraCallbacks]);

  // Follow toggle: resolve target first, then enable
  const handleFollowToggle = useCallback(() => {
    const store = useAppStore.getState();
    if (store.orbitFollowEnabled) {
      store.setOrbitFollowEnabled(false);
    } else {
      // ensureFollowTarget resolves a target and centers; only enable if successful
      const resolved = cameraCallbacks?.onEnableFollow?.() ?? false;
      if (resolved) {
        store.setOrbitFollowEnabled(true);
      }
    }
  }, [cameraCallbacks]);

  // Mode toggle: only shown when Free-Look feature flag is enabled
  const handleModeToggle = useCallback(() => {
    const store = useAppStore.getState();
    store.setCameraMode(store.cameraMode === 'orbit' ? 'freelook' : 'orbit');
  }, []);

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
          <button
            className="camera-action"
            onClick={handleCenterObject}
            aria-label="Center Object"
            title="Frame focused molecule"
          >
            <IconCenter />
            <span className="camera-action-label">
              Center
              <span className="camera-action-hint">Frame molecule</span>
            </span>
          </button>
          <button
            className={`camera-action${orbitFollowEnabled ? ' camera-action-active' : ''}`}
            onClick={handleFollowToggle}
            aria-label={orbitFollowEnabled ? 'Following target (tap to stop)' : 'Follow'}
            title={orbitFollowEnabled ? 'Tap to stop tracking' : 'Track focused molecule'}
          >
            <IconFollow />
            <span className="camera-action-label">
              Follow
              <span className="camera-action-hint">{orbitFollowEnabled ? 'Tap to stop' : 'Track molecule'}</span>
            </span>
          </button>
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
