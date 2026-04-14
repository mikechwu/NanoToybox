/**
 * WatchTopBar — file badge + title + open-file action + share-code input.
 * Uses review-parity CSS classes for visual alignment with lab.
 */

import React, { useState, useCallback } from 'react';

interface WatchTopBarProps {
  fileKind: string | null;
  fileName: string | null;
  onOpenFile: () => void;
  onOpenShareCode: (input: string) => void;
}

export function WatchTopBar({ fileKind, fileName, onOpenFile, onOpenShareCode }: WatchTopBarProps) {
  const [shareInput, setShareInput] = useState('');
  const [showShareInput, setShowShareInput] = useState(false);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = shareInput.trim();
    if (trimmed) {
      onOpenShareCode(trimmed);
      setShareInput('');
      setShowShareInput(false);
    }
  }, [shareInput, onOpenShareCode]);

  return (
    <div className="review-topbar">
      {fileKind && <span className="review-topbar__badge">{fileKind === 'full' ? 'Full History' : fileKind}</span>}
      {fileName && <span className="review-topbar__filename">{fileName}</span>}
      <span className="review-topbar__title">atomdojo — Watch</span>
      {showShareInput ? (
        <form className="review-topbar__share-form" onSubmit={handleSubmit}>
          <input
            className="review-topbar__share-input"
            type="text"
            placeholder="Code or URL"
            value={shareInput}
            onChange={(e) => setShareInput(e.target.value)}
            autoFocus
          />
          <button className="review-topbar__action" type="submit" disabled={!shareInput.trim()}>Open</button>
          <button className="review-topbar__action" type="button" onClick={() => setShowShareInput(false)}>Cancel</button>
        </form>
      ) : (
        <>
          <button className="review-topbar__action" onClick={() => setShowShareInput(true)}>Open Share</button>
          <button className="review-topbar__action" onClick={onOpenFile}>Open File</button>
        </>
      )}
    </div>
  );
}
