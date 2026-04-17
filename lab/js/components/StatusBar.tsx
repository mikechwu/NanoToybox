/**
 * StatusBar — message-only status surface.
 *
 * Renders only when there is an active statusError or statusText message.
 * Returns null otherwise — no persistent scene summary.
 *
 * Precedence: statusError > statusText > null.
 *
 * Accessibility (rev 6 Ax11 / pre-PR 2 audit): the mounted element is a
 * `role="status"` live region with `aria-live="polite"` so screen
 * readers announce §10 failure toasts (stale handoff, hydrate failure,
 * etc.) the moment `useAppStore().setStatusError` fires. `aria-atomic`
 * ensures the entire message is read as one unit rather than being
 * split across prev/next announcements when the string changes.
 */

import React from 'react';
import { useAppStore } from '../store/app-store';

export function StatusBar() {
  const statusError = useAppStore((s) => s.statusError);
  const statusText = useAppStore((s) => s.statusText);

  const displayText = statusError ?? statusText;
  if (!displayText) return null;

  return (
    <div
      className="react-info"
      data-status-root
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="status-text">{displayText}</span>
    </div>
  );
}
