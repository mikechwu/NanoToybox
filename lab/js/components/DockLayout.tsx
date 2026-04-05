/**
 * DockLayout — neutral layout container for the bottom-control region.
 *
 * Owns the measurement root ([data-dock-root]) that overlay-layout.ts reads
 * for hint clearance and triad positioning. Children are passed in by the
 * caller (react-root.tsx today, future DockSurfaceHost later).
 *
 * DockLayout is a PURE STRUCTURAL CONTAINER:
 * - No useState, useEffect, or store subscriptions
 * - No surface selection, exclusivity logic, or adaptive decisions
 * - Measurement root only — overlay-layout.ts ResizeObserver attaches here
 * - No direct dependency on DockBar or any specific child component
 *
 * Layout guardrails:
 * 1. Phone bar: 4 control slots, 6 visible tap targets (grandfathered baseline).
 *    No new bar controls until expansion freeze is lifted (see plan report).
 * 2. Contextual controls go in surfaces (tray/overflow), not the bar.
 * 3. All direct children must be in normal document flow (no position: absolute/fixed).
 *    This guarantees getBoundingClientRect() on [data-dock-root] reflects total height.
 * 4. Measured element is this container, not DockBar.
 */

import React from 'react';

export function DockLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dock-region" data-dock-root>
      {children}
    </div>
  );
}
