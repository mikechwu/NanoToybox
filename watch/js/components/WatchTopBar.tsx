/**
 * WatchTopBar — file badge + title + open-file action.
 * Uses review-parity CSS classes for visual alignment with lab.
 */

import React from 'react';

interface WatchTopBarProps {
  fileKind: string | null;
  fileName: string | null;
  onOpenFile: () => void;
}

export function WatchTopBar({ fileKind, fileName, onOpenFile }: WatchTopBarProps) {
  return (
    <div className="review-topbar">
      {fileKind && <span className="review-topbar__badge">{fileKind === 'full' ? 'Full History' : fileKind}</span>}
      {fileName && <span className="review-topbar__filename">{fileName}</span>}
      <span className="review-topbar__title">atomdojo — Watch</span>
      <button className="review-topbar__action" onClick={onOpenFile}>Open File</button>
    </div>
  );
}
