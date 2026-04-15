/**
 * PlaybackSpeedControl — dock column with a log-mapped speed slider on
 * top and a centered "Speed · 1.0x" meta row below. The meta row
 * reads as the dock's label row (matching Back / Play / Fwd / Repeat
 * / Settings) so the whole dock is a consistent grid of labelled
 * columns. The "1.0x" portion is still the reset-to-1x button —
 * styled as a subtle interactive sibling of the "Speed" descriptor.
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
  const isAtDefault = speed === SPEED_DEFAULT;
  return (
    <div className="watch-dock__speed">
      {/* Slider row — fixed at 18 px (the .dock-icon glyph box) with
          the slider centered inside. Native <input type="range">
          renders at platform-dependent heights (16–24 px); centering
          the input inside an 18 px row aligns its thumb centerline
          with icon centers in neighboring columns regardless of
          browser. Visual overflow on Safari is invisible thanks to
          the parent's natural vertical slack. */}
      <div className="watch-dock__speed-slider-row">
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
      </div>
      {/* Meta row — "Speed · 1.0x" centered under the slider.
          The label is static; the value is the click-to-reset button.
          Disabled at default so the no-op click is visually honest. */}
      <div className="watch-dock__speed-meta">
        <span className="watch-dock__speed-label" aria-hidden="true">Speed</span>
        <span className="watch-dock__speed-sep" aria-hidden="true">·</span>
        <button
          className="watch-dock__speed-value"
          onClick={() => onSpeedChange(SPEED_DEFAULT)}
          disabled={isAtDefault}
          title={isAtDefault ? 'Already at 1x' : 'Reset to 1x'}
          aria-label={
            isAtDefault
              ? `${formatSpeed(speed)} — already at default`
              : `${formatSpeed(speed)} — click to reset to 1x`
          }
          type="button"
        >
          {formatSpeed(speed)}
        </button>
      </div>
    </div>
  );
}
