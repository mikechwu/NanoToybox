/**
 * StatusBar — message-only status surface.
 *
 * Renders only when there is an active statusError or statusText message.
 * Returns null otherwise — no persistent scene summary.
 *
 * Precedence: statusError > statusText > null.
 */

import React from 'react';
import { useAppStore } from '../store/app-store';

export function StatusBar() {
  const statusError = useAppStore((s) => s.statusError);
  const statusText = useAppStore((s) => s.statusText);

  const displayText = statusError ?? statusText;
  if (!displayText) return null;

  return (
    <div className="react-info" data-status-root>
      <span className="status-text">{displayText}</span>
    </div>
  );
}
