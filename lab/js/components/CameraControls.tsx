/**
 * CameraControls — Free-Look mode actions only.
 *
 * Center/Follow for molecules and bonded groups have moved to
 * BondedGroupsPanel (Phase 10 legacy cleanup). This component
 * now only renders Free-Look controls (Freeze, Return to Object,
 * mode toggle) when the Free-Look feature gate is enabled.
 *
 * Positioned by CSS custom properties set by overlay-layout.ts.
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { CONFIG } from '../config';
import { IconFreeze, IconReturn } from './Icons';

export function CameraControls() {
  const cameraMode = useAppStore((s) => s.cameraMode);
  const flightActive = useAppStore((s) => s.flightActive);
  const farDrift = useAppStore((s) => s.farDrift);
  const cameraCallbacks = useAppStore((s) => s.cameraCallbacks);

  const handleModeToggle = useCallback(() => {
    const store = useAppStore.getState();
    store.setCameraMode(store.cameraMode === 'orbit' ? 'freelook' : 'orbit');
  }, []);

  // Only render when Free-Look is enabled
  if (!CONFIG.camera.freeLookEnabled) return null;

  return (
    <div className="camera-controls" data-camera-controls>
      {/* Mode toggle */}
      <button
        className="camera-action"
        onClick={handleModeToggle}
        aria-label={`Switch to ${cameraMode === 'orbit' ? 'Free-Look' : 'Orbit'}`}
      >
        {cameraMode === 'orbit' ? 'Free' : 'Orbit'}
      </button>

      {/* Free-Look actions */}
      {cameraMode === 'freelook' && flightActive && (
        <button
          className="camera-action"
          onClick={() => cameraCallbacks?.onFreeze?.()}
          aria-label="Freeze"
        >
          <IconFreeze />
        </button>
      )}
      {cameraMode === 'freelook' && (
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
