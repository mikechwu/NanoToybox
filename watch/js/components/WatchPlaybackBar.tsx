/**
 * WatchPlaybackBar — review-parity playback controls.
 * Uses review-parity CSS + shared formatTime + Icons.
 */

import React from 'react';
import { formatTime } from '../../../lab/js/components/timeline-format';
import { IconPause, IconResume } from '../../../lab/js/components/Icons';

interface WatchPlaybackBarProps {
  currentTimePs: number;
  startTimePs: number;
  endTimePs: number;
  playing: boolean;
  canPlay: boolean;
  onTogglePlay: () => void;
  onScrub: (timePs: number) => void;
  onOpenFile: () => void;
}

export function WatchPlaybackBar({
  currentTimePs, startTimePs, endTimePs, playing, canPlay,
  onTogglePlay, onScrub, onOpenFile,
}: WatchPlaybackBarProps) {
  const duration = endTimePs - startTimePs;
  const step = duration > 0 ? duration / 100 : 1;

  return (
    <div className="review-playback-bar" data-watch-playback-bar>
      <button
        onClick={onTogglePlay}
        disabled={!canPlay}
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <IconPause size={16} /> : <IconResume size={16} />}
      </button>
      <span className="review-playback-bar__time">{formatTime(currentTimePs)}</span>
      <input
        className="review-playback-bar__scrubber"
        type="range"
        min={startTimePs}
        max={endTimePs}
        step={step}
        value={currentTimePs}
        onChange={(e) => onScrub(parseFloat(e.target.value))}
      />
      <span className="review-playback-bar__time">{formatTime(endTimePs)}</span>
      <button className="review-playback-bar__action" onClick={onOpenFile}>Open File</button>
    </div>
  );
}
