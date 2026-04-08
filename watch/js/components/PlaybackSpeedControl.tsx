/**
 * PlaybackSpeedControl — compact log-mapped speed slider + readout.
 *
 * Used by WatchDock. Owns logarithmic slider plumbing + reset-to-1x readout.
 */

import React from 'react';
import {
  SPEED_DEFAULT,
  sliderToSpeed, speedToSlider, formatSpeed,
} from '../../../src/config/playback-speed-constants';

interface PlaybackSpeedControlProps {
  speed: number;
  onSpeedChange: (speed: number) => void;
}

export function PlaybackSpeedControl({ speed, onSpeedChange }: PlaybackSpeedControlProps) {
  return (
    <div className="watch-dock__speed">
      <input
        className="watch-dock__speed-slider"
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={speedToSlider(speed)}
        onChange={(e) => onSpeedChange(sliderToSpeed(parseFloat(e.target.value)))}
        aria-label="Playback speed"
      />
      <button
        className="watch-dock__speed-label"
        onClick={() => onSpeedChange(SPEED_DEFAULT)}
        title="Reset to 1x"
        aria-label={`Speed ${formatSpeed(speed)} — click to reset to 1x`}
        type="button"
      >
        {formatSpeed(speed)}
      </button>
    </div>
  );
}
