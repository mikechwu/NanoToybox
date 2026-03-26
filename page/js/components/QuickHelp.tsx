/**
 * QuickHelp — compact gesture reference card near the triad.
 *
 * Mode-aware: shows Orbit controls now, Free-Look added in Phase 3.
 * Opened by the "?" glyph on the camera mode chip.
 * Mutually exclusive with sheets (opening help closes any open sheet).
 */

import React from 'react';
import { useAppStore } from '../store/app-store';

export function QuickHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cameraMode = useAppStore((s) => s.cameraMode);
  if (!open) return null;

  return (
    <div
      className="quick-help-card"
      onClick={(e) => e.stopPropagation()} // prevent backdrop dismiss
    >
      <div className="quick-help-header">
        <span>Camera Controls</span>
        <button className="quick-help-close" onClick={onClose} aria-label="Close help">
          &#x2715;
        </button>
      </div>
      <div className="quick-help-body">
        {cameraMode === 'orbit' && (
          <>
            <div className="quick-help-section">Orbit Mode</div>
            <div className="quick-help-row"><b>Rotate</b> Drag triad or background</div>
            <div className="quick-help-row"><b>Snap View</b> Tap axis end (±X/Y/Z)</div>
            <div className="quick-help-row"><b>Reset</b> Double-tap triad center</div>
            <div className="quick-help-row"><b>Center</b> Tap ⊕ button</div>
            <div className="quick-help-row"><b>Zoom</b> 2-finger pinch / scroll</div>
            <div className="quick-help-row"><b>Pan</b> 2-finger drag</div>
          </>
        )}
        {cameraMode === 'freelook' && (
          <>
            <div className="quick-help-section">Free-Look Mode</div>
            <div className="quick-help-row"><b>Look Around</b> Drag background / right-drag</div>
            <div className="quick-help-row"><b>Mark Target</b> Tap molecule / click molecule</div>
            <div className="quick-help-row"><b>Zoom</b> Scroll wheel (desktop)</div>
            <div className="quick-help-row"><b>Translate</b> WASD (desktop)</div>
            <div className="quick-help-row"><b>Level Camera</b> R (desktop)</div>
            <div className="quick-help-row"><b>Return</b> Double-tap center / Esc / mode chip</div>
          </>
        )}
      </div>
    </div>
  );
}
