/**
 * StatusBar — React-authoritative component for scene status display.
 *
 * Replaces imperative #info/#status elements. Renders the full info block
 * structure including the app title (hidden via CSS, same as imperative)
 * and reconciliation state when active.
 *
 * Render precedence: statusError > statusText > normal scene summary.
 * Hint/coachmark system remains imperative (separate #hint element).
 */

import React from 'react';
import { useAppStore } from '../store/app-store';

export function StatusBar() {
  const atomCount = useAppStore((s) => s.atomCount);
  const molecules = useAppStore((s) => s.molecules);
  const reconciliationState = useAppStore((s) => s.reconciliationState);
  const statusError = useAppStore((s) => s.statusError);
  const statusText = useAppStore((s) => s.statusText);

  let displayText: string;
  if (statusError) {
    displayText = statusError;
  } else if (statusText) {
    displayText = statusText;
  } else {
    const molCount = molecules.length;
    if (atomCount === 0 || molCount === 0) {
      displayText = 'Empty playground \u2014 add a molecule';
    } else {
      const molLabel = molCount === 1 ? '1 molecule' : `${molCount} molecules`;
      displayText = `${molLabel} \u00b7 ${atomCount} atoms`;
    }
  }

  return (
    <div className="react-info">
      <div className="title">NanoToybox</div>
      <div className="status-text">{displayText}</div>
      {reconciliationState !== 'none' && (
        <div className="reconciliation-text">
          Reconciling: {reconciliationState.replace('awaiting_', '')}
        </div>
      )}
    </div>
  );
}
