/**
 * OnboardingOverlay — welcome card shown on each page load.
 *
 * Dismissal scope: sessionStorage-lifetime. Dismissed once per browser
 * session (NOT localStorage) so a full browser restart restores the
 * fresh-load experience, while a same-tab OAuth redirect that lands
 * back on /lab/ does not re-show the overlay. See runtime/onboarding.ts
 * `markOnboardingDismissed` / `isOnboardingEligible` for the gate.
 *
 * Visibility is driven by a reactive readiness gate in runtime/onboarding.ts
 * (subscribeOnboardingReadiness) that waits for scene content + no blockers.
 *
 * Dismissed by tap/click anywhere (backdrop or card).
 * Exit animation: two-phase sink toward Settings button (~1s) to teach
 * that guidance lives in Settings. Fallback timeout ensures dismiss
 * completes even if animationend doesn't fire.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { markOnboardingDismissed } from '../runtime/onboarding';

/** Sink animation duration in ms — must match CSS @keyframes onboarding-sink. */
export const SINK_DURATION_MS = 950;
/** Extra margin after animation before fallback dismiss fires. */
export const FALLBACK_MARGIN_MS = 100;

/**
 * Finalize onboarding dismiss: transition exiting → dismissed and persist
 * the dismissal for the rest of the browser session so a same-tab OAuth
 * redirect doesn't re-show the overlay on return. Pure state logic plus
 * the one-line sessionStorage write — DOM cleanup is the caller's
 * responsibility.
 */
export function finalizeDismissAction(): void {
  if (useAppStore.getState().onboardingPhase === 'exiting') {
    useAppStore.getState().setOnboardingPhase('dismissed');
    markOnboardingDismissed();
  }
}

/** Remove sink highlight from settings button (DOM cleanup). */
function clearSinkHighlight(): void {
  document.querySelector('[data-dock-settings]')?.classList.remove('onboarding-sink-target');
}

export function OnboardingOverlay() {
  const show = useAppStore((s) => s.onboardingVisible);
  const phase = useAppStore((s) => s.onboardingPhase);

  const cardRef = useRef<HTMLDivElement>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finalizeDismiss = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    clearSinkHighlight();
    finalizeDismissAction();
  }, []);

  const handleDismiss = useCallback(() => {
    const store = useAppStore.getState();
    if (store.onboardingPhase !== 'visible') return;
    // Compute sink target toward Settings button
    const card = cardRef.current;
    const settingsBtn = document.querySelector('[data-dock-settings]') as HTMLElement | null;
    if (card && settingsBtn) {
      const cardRect = card.getBoundingClientRect();
      const btnRect = settingsBtn.getBoundingClientRect();
      const dx = (btnRect.left + btnRect.width / 2) - (cardRect.left + cardRect.width / 2);
      const dy = (btnRect.top + btnRect.height / 2) - (cardRect.top + cardRect.height / 2);
      card.style.setProperty('--sink-x', `${dx}px`);
      card.style.setProperty('--sink-y', `${dy}px`);
    }

    // Add highlight to settings button during sink
    if (settingsBtn) {
      settingsBtn.classList.add('onboarding-sink-target');
    }

    store.setOnboardingPhase('exiting');

    // Fallback: if animationend doesn't fire, dismiss after duration + margin
    fallbackTimerRef.current = setTimeout(finalizeDismiss, SINK_DURATION_MS + FALLBACK_MARGIN_MS);
  }, [finalizeDismiss]);

  // Keyboard dismiss (Escape)
  useEffect(() => {
    if (!show) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleDismiss();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [show, handleDismiss]);

  // Cleanup fallback timer and sticky highlight on unmount
  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      clearSinkHighlight();
    };
  }, []);

  // Sync CSS custom property from JS constant (single source of truth for timing)
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--onboarding-sink-duration', `${SINK_DURATION_MS / 1000}s`
    );
  }, []);

  if (!show) return null;

  return (
    <div
      className={`onboarding-backdrop${phase === 'exiting' ? ' onboarding-exit' : ''}`}
      onClick={handleDismiss}
      data-onboarding
    >
      <div
        ref={cardRef}
        className={`onboarding-card${phase === 'exiting' ? ' onboarding-card-exit' : ''}`}
        onAnimationEnd={finalizeDismiss}
      >
        <div className="onboarding-title">Atom Simulation Studio</div>
        <div className="onboarding-body">
          <div>Touch and drag atoms to begin</div>
          <div>Use <b>Add</b> for more structures</div>
          <div>This guide moves to <b>Settings</b></div>
        </div>
        <div className="onboarding-hint">Tap anywhere to start</div>
      </div>
    </div>
  );
}

