/**
 * WatchCinematicCameraToggle — "Cinematic Camera" label with a
 * toggle-switch icon. Fixed-width layout so on/off states don't
 * shift the toolbar.
 */

import React from 'react';
import type { SnapshotCinematicCameraStatus } from '../watch-cinematic-camera';

interface Props {
  enabled: boolean;
  active: boolean;
  status: SnapshotCinematicCameraStatus;
  onToggle: () => void;
}

export function WatchCinematicCameraToggle(props: Props) {
  const ariaLabel = props.enabled
    ? 'Turn Cinematic Camera off'
    : 'Turn Cinematic Camera on';

  return (
    <button
      type="button"
      className="watch-cinematic-toggle"
      data-testid="watch-cinematic-camera-toggle"
      data-enabled={props.enabled}
      data-active={props.active}
      data-status={props.status}
      aria-pressed={props.enabled}
      aria-label={ariaLabel}
      onClick={props.onToggle}
    >
      <span className="watch-cinematic-toggle__label watch-cinematic-toggle__label--full">Cinematic Camera</span>
      <span className="watch-cinematic-toggle__label watch-cinematic-toggle__label--short">Cinema</span>
      {/* CSS-only toggle switch track + thumb */}
      <span className="watch-cinematic-toggle__switch" aria-hidden="true">
        <span className="watch-cinematic-toggle__thumb" />
      </span>
    </button>
  );
}
