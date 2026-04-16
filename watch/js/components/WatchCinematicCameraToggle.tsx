/**
 * WatchCinematicCameraToggle — compact pill between the info panel
 * and the bonded-clusters panel.
 *
 * Status text is driven by the controller-owned `status` enum so the
 * component doesn't re-derive status logic from individual booleans.
 */

import React from 'react';
import type { SnapshotCinematicCameraStatus } from '../watch-cinematic-camera';

interface Props {
  enabled: boolean;
  active: boolean;
  status: SnapshotCinematicCameraStatus;
  onToggle: () => void;
}

const STATUS_TEXT: Record<SnapshotCinematicCameraStatus, string> = {
  off: 'Off',
  paused: 'Paused while you adjust the camera',
  waiting_major_clusters: 'Waiting for major clusters',
  waiting_topology: 'Waiting for topology',
  tracking: 'Keeps major clusters framed',
  suppressed_by_follow: 'Off while Follow is active',
};

export function WatchCinematicCameraToggle(props: Props) {
  const label = 'Cinematic Camera';
  const ariaLabel = props.enabled
    ? 'Turn Cinematic Camera off'
    : 'Turn Cinematic Camera on';

  return (
    <div
      className="watch-cinematic-camera-toggle"
      data-testid="watch-cinematic-camera-toggle"
      data-enabled={props.enabled}
      data-active={props.active}
      data-status={props.status}
    >
      <div className="watch-cinematic-camera-toggle__copy">
        <div className="watch-cinematic-camera-toggle__label">{label}</div>
        <div className="watch-cinematic-camera-toggle__status">
          {STATUS_TEXT[props.status]}
        </div>
      </div>
      <button
        type="button"
        className="watch-cinematic-camera-toggle__btn"
        aria-pressed={props.enabled}
        aria-label={ariaLabel}
        onClick={props.onToggle}
      >
        {props.enabled ? 'On' : 'Off'}
      </button>
    </div>
  );
}
