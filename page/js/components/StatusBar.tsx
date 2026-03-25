/**
 * StatusBar — React-authoritative component for scene status display.
 *
 * Replaces imperative #info/#status elements. Renders the full info block
 * structure including the app title (hidden via CSS, same as imperative)
 * and reconciliation state when active.
 *
 * Hint/coachmark system remains imperative (separate #hint element).
 */

import React from 'react';
import { useAppStore } from '../store/app-store';

export function StatusBar() {
  const atomCount = useAppStore((s) => s.atomCount);
  const molecules = useAppStore((s) => s.molecules);
  const reconciliationState = useAppStore((s) => s.reconciliationState);

  const molCount = molecules.length;
  let statusText: string;
  if (atomCount === 0 || molCount === 0) {
    statusText = 'Empty playground \u2014 add a molecule';
  } else {
    const molLabel = molCount === 1 ? '1 molecule' : `${molCount} molecules`;
    statusText = `${molLabel} \u00b7 ${atomCount} atoms`;
  }

  return (
    <div className="react-info">
      <div className="title">NanoToybox</div>
      <div className="status-text">{statusText}</div>
      {reconciliationState !== 'none' && (
        <div className="reconciliation-text">
          Reconciling: {reconciliationState.replace('awaiting_', '')}
        </div>
      )}
    </div>
  );
}
