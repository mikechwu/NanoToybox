/**
 * WatchLanding — file-open landing page with drag-and-drop.
 */

import React, { useState, useCallback, useRef } from 'react';

interface WatchLandingProps {
  onOpenFile: () => void;
  onDrop: (file: File) => void;
}

export function WatchLanding({ onOpenFile, onDrop }: WatchLandingProps) {
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current++;
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (e.dataTransfer?.files[0]) onDrop(e.dataTransfer.files[0]);
  }, [onDrop]);

  return (
    <div className="watch-landing">
      <h1>Watch History</h1>
      <p>Open a .atomdojo history file exported from Lab</p>
      <div
        className={`watch-drop-zone${dragActive ? ' watch-drop-zone--active' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <button className="watch-btn" onClick={onOpenFile}>Open File</button>
        <p>or drag and drop here</p>
      </div>
      <p className="watch-support-note">Supports Full History now &middot; Replay support coming next</p>
    </div>
  );
}
