/**
 * CameraControls — React-owned camera control cluster near the triad.
 *
 * Positioned above the triad via CSS custom properties set by overlay-layout.ts.
 * Contains: mode chip (with embedded ?) + action slot (Center Object).
 *
 * Ownership: React-owned overlay. Triad stays renderer-owned (WebGL scissor).
 * Store is sole authority for cameraMode and cameraHelpOpen.
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import { CONFIG } from '../config';
import { QuickHelp } from './QuickHelp';

/** Session flag to show "Coming soon" only once. */
let _comingSoonShown = false;

export function CameraControls() {
  const cameraMode = useAppStore((s) => s.cameraMode);
  const cameraHelpOpen = useAppStore((s) => s.cameraHelpOpen);
  const pickFocusActive = useAppStore((s) => s.pickFocusActive);
  const flightActive = useAppStore((s) => s.flightActive);
  const farDrift = useAppStore((s) => s.farDrift);
  const cameraCallbacks = useAppStore((s) => s.cameraCallbacks);

  // Chip body tap: toggle camera mode
  const handleChipTap = useCallback(() => {
    const store = useAppStore.getState();
    if (store.cameraMode === 'orbit') {
      store.setCameraMode('freelook');
      // Show first-use tutorial once
      if (!localStorage.getItem('freelook-tutorial-shown')) {
        localStorage.setItem('freelook-tutorial-shown', '1');
        const hint = document.getElementById('hint');
        if (hint) {
          hint.textContent = 'Free-Look: drag to look · WASD to fly (drifts!) · tap molecule to mark target · ↩ to return';
          hint.style.display = '';
          hint.classList.remove('fade');
          setTimeout(() => {
            hint.classList.add('fade');
            setTimeout(() => { hint.style.display = 'none'; }, 2000);
          }, 3000);
        }
      }
    } else {
      // Return to Orbit
      store.setCameraMode('orbit');
    }
  }, []);

  // Help via store state (mutual exclusivity enforced by store)
  const handleHelpOpen = useCallback(() => {
    useAppStore.getState().setCameraHelpOpen(true);
  }, []);

  const handleHelpClose = useCallback(() => {
    useAppStore.getState().setCameraHelpOpen(false);
  }, []);

  // Center Object: dispatched through registered callback
  const handleCenterObject = useCallback(() => {
    cameraCallbacks?.onCenterObject?.();
  }, [cameraCallbacks]);

  return (
    <>
      <div className="camera-controls" data-camera-controls>
        {/* Mode chip with embedded ? */}
        <div className="camera-chip">
          {CONFIG.camera.freeLookEnabled ? (
            <button
              className="camera-chip-body"
              onClick={handleChipTap}
              aria-label={`Camera mode: ${cameraMode === 'orbit' ? 'Orbit' : 'Free-Look'}`}
            >
              {cameraMode === 'orbit' ? 'Orbit' : 'Free'}
            </button>
          ) : (
            <span className="camera-chip-body" aria-label="Camera mode: Orbit">
              Orbit
            </span>
          )}
          <button
            className="camera-chip-help"
            onClick={handleHelpOpen}
            aria-label="Open camera controls help"
          >
            ?
          </button>
        </div>

        {/* Action slot — mode-dependent */}
        {cameraMode === 'orbit' && (
          <button
            className={`camera-action${pickFocusActive ? ' camera-action-pick' : ''}`}
            onClick={handleCenterObject}
            aria-label={pickFocusActive ? 'Tap molecule to center' : 'Center Object'}
          >
            {pickFocusActive ? 'Tap molecule' : '⊕'}
          </button>
        )}
        {/* Free-Look actions (gated by feature flag) */}
        {CONFIG.camera.freeLookEnabled && cameraMode === 'freelook' && flightActive && (
          <button
            className="camera-action"
            onClick={() => cameraCallbacks?.onFreeze?.()}
            aria-label="Freeze"
          >
            ✕
          </button>
        )}
        {CONFIG.camera.freeLookEnabled && cameraMode === 'freelook' && (
          <button
            className={`camera-action${farDrift ? ' camera-action-pulse' : ''}`}
            onClick={() => {
              // Single-entry: onReturnToObject owns animation + mode switch
              cameraCallbacks?.onReturnToObject?.();
            }}
            aria-label="Return to Object"
          >
            ↩
          </button>
        )}
      </div>

      {/* Help card (store-driven, mutually exclusive with sheets) */}
      <QuickHelp open={cameraHelpOpen} onClose={handleHelpClose} />
    </>
  );
}
