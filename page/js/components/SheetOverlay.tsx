/**
 * SheetOverlay — React-authoritative backdrop for sheet overlays.
 *
 * Replaces imperative #sheet-backdrop element. Renders a div.sheet-backdrop
 * with .visible class when any sheet is open. Clicks on the backdrop
 * close the active sheet via the synchronized closeOverlay gateway.
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../store/app-store';

export function SheetOverlay() {
  const activeSheet = useAppStore((s) => s.activeSheet);
  const closeOverlay = useAppStore((s) => s.closeOverlay);

  const handleClick = useCallback(() => {
    closeOverlay?.();
  }, [closeOverlay]);

  const className = activeSheet
    ? 'sheet-backdrop visible'
    : 'sheet-backdrop';

  return <div className={className} onClick={handleClick} />;
}
