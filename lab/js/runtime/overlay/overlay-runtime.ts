/**
 * Overlay open/close policy — shared runtime used by Escape, outside-click
 * dismiss, device-mode switch, and settings actions.
 *
 * Owns: sheet open/close toggling, help-page reset on close, coachmark
 *       dismissal on overlay open, onboarding dismissal on overlay open.
 * Depends on: app-store (activeSheet, helpPageActive, openSheet/closeSheet),
 *             statusCtrl (dismissCoachmark), onboarding (dismissActive).
 * Called by: ui-bindings.ts (Escape / outside-click), settings actions, device-mode switch.
 * Teardown: stateless closures — no teardown needed. Lifetime tied to caller.
 *
 * Does NOT include store callback registration (that is ui-bindings.ts).
 * Does NOT include _updateChooserRecentRow (stays with scene helpers).
 * Does NOT attach global listeners or write to window.
 */

import { useAppStore } from '../../store/app-store';

export interface OverlayRuntime {
  open(name: 'settings' | 'chooser'): void;
  close(): void;
}

export function createOverlayRuntime(deps: {
  getStatusCtrl: () => { dismissCoachmark: (id: string) => void } | null;
  getOnboarding?: () => { dismissActive: () => void } | null;
}): OverlayRuntime {
  function close() {
    const store = useAppStore.getState();
    if (store.activeSheet === 'settings' && store.helpPageActive) {
      store.setHelpPageActive(false);
    }
    store.closeSheet();
  }

  function open(name: 'settings' | 'chooser') {
    const sc = deps.getStatusCtrl();
    if (sc) sc.dismissCoachmark('placement');
    deps.getOnboarding?.()?.dismissActive();

    const store = useAppStore.getState();
    if (store.activeSheet === name) {
      close();
    } else {
      if (name === 'settings') store.setHelpPageActive(false);
      store.openSheet(name);
    }
  }

  return { open, close };
}
