/**
 * TopRightControls — shared layout container for the Lab's top-right chrome.
 *
 * Replaces two independently absolutely-positioned surfaces (AccountControl
 * and FPSDisplay) with a single flex row anchored at top:12px right:12px.
 *
 * Why a container:
 *   - each child used to carry hardcoded `right: Npx` offsets tuned to the
 *     *current* width of its sibling. Long display names, larger text
 *     tokens, or adding a future control (e.g. a keyboard-hint button)
 *     would break the arrangement.
 *   - a flex row with `gap` gives the controls a stable placement contract
 *     and automatically re-flows as widths change.
 *
 * Layout order (left → right): AccountControl, FPSDisplay.
 * FPSDisplay sits at the viewport-right edge (matching the original layout
 * contract docs) so it remains the "primary" top-right surface; the account
 * chip floats just to its left.
 */

import React from 'react';
import { AccountControl } from './AccountControl';
import { FPSDisplay } from './FPSDisplay';

export function TopRightControls() {
  return (
    <div className="topbar-right" data-testid="topbar-right">
      <AccountControl />
      <FPSDisplay />
    </div>
  );
}
