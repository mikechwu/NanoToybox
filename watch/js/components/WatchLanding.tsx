/**
 * WatchLanding — file-open landing page with drag-and-drop + share-code input.
 */

import React, { useState, useCallback, useRef } from 'react';

interface WatchLandingProps {
  onOpenFile: () => void;
  onDrop: (file: File) => void;
  onOpenShareCode: (input: string) => void;
  loadingShareCode: string | null;
}

export function WatchLanding({ onOpenFile, onDrop, onOpenShareCode, loadingShareCode }: WatchLandingProps) {
  const [dragActive, setDragActive] = useState(false);
  const [shareInput, setShareInput] = useState('');
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

  const handleShareSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = shareInput.trim();
    if (trimmed) {
      onOpenShareCode(trimmed);
      setShareInput('');
    }
  }, [shareInput, onOpenShareCode]);

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

      <div className="watch-share-input-section">
        <p className="watch-share-input-label">Open Share Link or Code</p>
        <form className="watch-share-input-form" onSubmit={handleShareSubmit}>
          <input
            className="watch-share-input"
            type="text"
            placeholder="Paste share code or URL"
            value={shareInput}
            onChange={(e) => setShareInput(e.target.value)}
            disabled={loadingShareCode !== null}
          />
          <button
            className="watch-btn"
            type="submit"
            disabled={!shareInput.trim() || loadingShareCode !== null}
          >
            {loadingShareCode ? 'Loading\u2026' : 'Open'}
          </button>
        </form>
      </div>
    </div>
  );
}
