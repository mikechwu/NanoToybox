/**
 * Dock — React-authoritative component for the primary navigation dock.
 *
 * Replaces imperative #dock element and DockController. Renders the full
 * dock markup with same CSS classes for visual parity. Click handlers are
 * provided by main.ts via dockCallbacks in the Zustand store.
 *
 * Placement mode swaps Add→Place, shows Cancel, disables Pause/Settings.
 * Mode segmented control dispatches interaction mode changes.
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../store/app-store';

const MODES = ['atom', 'move', 'rotate'] as const;

export function Dock() {
  const interactionMode = useAppStore((s) => s.interactionMode);
  const paused = useAppStore((s) => s.paused);
  const placementActive = useAppStore((s) => s.placementActive);
  const dockCallbacks = useAppStore((s) => s.dockCallbacks);

  const handleAdd = useCallback(() => dockCallbacks?.onAdd(), [dockCallbacks]);
  const handlePause = useCallback(() => dockCallbacks?.onPause(), [dockCallbacks]);
  const handleSettings = useCallback(() => dockCallbacks?.onSettings(), [dockCallbacks]);
  const handleCancel = useCallback(() => dockCallbacks?.onCancel(), [dockCallbacks]);
  const handleMode = useCallback(
    (mode: string) => dockCallbacks?.onModeChange(mode),
    [dockCallbacks],
  );

  const dockClass = `dock${placementActive ? ' placement' : ''}`;
  const activeIdx = MODES.indexOf(interactionMode as typeof MODES[number]);

  return (
    <nav
      className={dockClass}
      style={{ '--seg-count': 3, '--seg-active': activeIdx } as React.CSSProperties}
    >
      {/* Add / Place button */}
      <button className="dock-item dock-add-btn" onClick={handleAdd}>
        <span className="dock-icon">{placementActive ? '✓' : '+'}</span>
        <span className="dock-label">{placementActive ? 'Place' : 'Add'}</span>
      </button>

      {/* Mode segmented control */}
      <div
        className="segmented dock-mode"
        style={{ '--seg-count': 3, '--seg-active': activeIdx } as React.CSSProperties}
      >
        {MODES.map((mode) => (
          <label
            key={mode}
            data-mode={mode}
            className={interactionMode === mode ? 'active' : ''}
            onClick={() => handleMode(mode)}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </label>
        ))}
      </div>

      {/* Cancel button (visible only in placement mode via CSS) */}
      <button className="dock-item dock-cancel" onClick={handleCancel}>
        <span className="dock-icon">&#x2715;</span>
        <span className="dock-label">Cancel</span>
      </button>

      {/* Pause / Resume */}
      <button
        className="dock-item dock-text-only"
        onClick={handlePause}
        disabled={placementActive}
      >
        <span className="dock-label">{paused ? 'Resume' : 'Pause'}</span>
      </button>

      {/* Settings */}
      <button
        className="dock-item dock-text-only"
        onClick={handleSettings}
        disabled={placementActive}
      >
        <span className="dock-label">Settings</span>
      </button>
    </nav>
  );
}
