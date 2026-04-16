/**
 * WatchCinematicCameraToggle — compact pill between the info panel
 * and the bonded-clusters panel.
 *
 * The label is always "Cinematic Camera". The status line swaps
 * based on the (enabled, pausedForUserInput, eligibleClusterCount)
 * triple:
 *   - pausedForUserInput → "Paused while you adjust the camera"
 *   - eligibleClusterCount === 0 → "Waiting for major clusters"
 *   - otherwise → "Keeps major clusters framed"
 *
 * When `enabled === false` the status line reads "Off" so the
 * panel's collapsed state is self-explanatory. `active` is surfaced
 * as `data-active` for test hooks and (future) CSS animations.
 */

import React from 'react';

interface Props {
  enabled: boolean;
  active: boolean;
  pausedForUserInput: boolean;
  eligibleClusterCount: number;
  onToggle: () => void;
}

function statusText(p: Props): string {
  if (!p.enabled) return 'Off';
  if (p.pausedForUserInput) return 'Paused while you adjust the camera';
  if (p.eligibleClusterCount === 0) return 'Waiting for major clusters';
  return 'Keeps major clusters framed';
}

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
      data-paused={props.pausedForUserInput}
    >
      <div className="watch-cinematic-camera-toggle__copy">
        <div className="watch-cinematic-camera-toggle__label">{label}</div>
        <div className="watch-cinematic-camera-toggle__status">{statusText(props)}</div>
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
