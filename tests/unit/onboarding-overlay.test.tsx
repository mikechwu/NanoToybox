/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for the OnboardingOverlay component and page-load onboarding gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { useAppStore } from '../../lab/js/store/app-store';
import { OnboardingOverlay, finalizeDismissAction, SINK_DURATION_MS, FALLBACK_MARGIN_MS } from '../../lab/js/components/OnboardingOverlay';
import { isOnboardingEligible, subscribeOnboardingReadiness } from '../../lab/js/runtime/onboarding';

describe('subscribeOnboardingReadiness', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().resetTransientState();
  });

  it('fires immediately when already eligible', () => {
    useAppStore.getState().updateAtomCount(60);
    subscribeOnboardingReadiness();
    expect(useAppStore.getState().onboardingPhase).toBe('visible');
  });

  it('fires when scene becomes ready (not-ready → ready)', () => {
    // Start with 0 atoms — not ready
    const unsub = subscribeOnboardingReadiness();
    expect(useAppStore.getState().onboardingPhase).toBe('dismissed');

    // Scene loads atoms — triggers readiness
    useAppStore.getState().updateAtomCount(60);
    expect(useAppStore.getState().onboardingPhase).toBe('visible');
    unsub();
  });

  it('fires only once even with further store changes', () => {
    const unsub = subscribeOnboardingReadiness();
    useAppStore.getState().updateAtomCount(60); // triggers
    expect(useAppStore.getState().onboardingPhase).toBe('visible');

    // Dismiss and change store — should NOT re-trigger
    useAppStore.getState().setOnboardingPhase('dismissed');
    useAppStore.getState().updateAtomCount(120);
    expect(useAppStore.getState().onboardingPhase).toBe('dismissed');
    unsub();
  });

  it('unsubscribe prevents later firing', () => {
    const unsub = subscribeOnboardingReadiness();
    expect(useAppStore.getState().onboardingPhase).toBe('dismissed');

    unsub(); // unsubscribe before atoms arrive
    useAppStore.getState().updateAtomCount(60);
    expect(useAppStore.getState().onboardingPhase).toBe('dismissed');
  });

  it('does not fire when blocked by sheet', () => {
    useAppStore.getState().openSheet('settings');
    const unsub = subscribeOnboardingReadiness();
    useAppStore.getState().updateAtomCount(60);
    expect(useAppStore.getState().onboardingPhase).toBe('dismissed');
    unsub();
  });
});

describe('isOnboardingEligible', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useAppStore.getState().resetTransientState();
    useAppStore.getState().updateAtomCount(60); // scene ready
  });

  it('returns true on page load with scene ready', () => {
    expect(isOnboardingEligible()).toBe(true);
  });

  it('returns false when scene has no atoms', () => {
    useAppStore.getState().updateAtomCount(0);
    expect(isOnboardingEligible()).toBe(false);
  });

  it('returns false when a sheet is open', () => {
    useAppStore.getState().openSheet('settings');
    expect(isOnboardingEligible()).toBe(false);
  });

  it('returns false when placement is active', () => {
    useAppStore.getState().setPlacementActive(true);
    expect(isOnboardingEligible()).toBe(false);
  });

  it('returns false during review mode', () => {
    useAppStore.getState().setTimelineMode('review');
    expect(isOnboardingEligible()).toBe(false);
  });

  // Watch → Lab handoff suppression. The shared `isWatchHandoffBoot`
  // predicate reads `window.location.search`, so tests stub location.
  describe('Watch → Lab handoff boot suppression', () => {
    const ORIGINAL_SEARCH = window.location.search;
    afterEach(() => {
      // Restore original search so cross-test state doesn't leak.
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: ORIGINAL_SEARCH },
        writable: true,
        configurable: true,
      });
    });

    function setSearch(search: string): void {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search },
        writable: true,
        configurable: true,
      });
    }

    it('returns false when URL has ?from=watch&handoff=<token> (Continue flow)', () => {
      setSearch('?from=watch&handoff=abc-123');
      expect(isOnboardingEligible()).toBe(false);
    });

    it('returns true for direct /lab/ open (no handoff params)', () => {
      setSearch('');
      expect(isOnboardingEligible()).toBe(true);
    });

    it('returns true when only `from=watch` is present (missing handoff token)', () => {
      // Defense-in-depth: a malformed URL with `from=watch` but no token
      // is not a real handoff boot — show onboarding normally so the
      // user isn't silently gated out of the welcome.
      setSearch('?from=watch');
      expect(isOnboardingEligible()).toBe(true);
    });

    it('returns true when only `handoff=` is present (missing from param)', () => {
      setSearch('?handoff=abc-123');
      expect(isOnboardingEligible()).toBe(true);
    });

    // Regression lock for the production race (found in prod):
    // `consumeWatchToLabHandoffFromLocation` calls
    // `history.replaceState(null, '', cleanedURL)` to strip the handoff
    // token from the URL. The readiness gate evaluates AFTER hydrate
    // completes (atomCount > 0), by which time the URL has been
    // scrubbed. If the gate relied ONLY on the live URL, onboarding
    // would re-show. The boot-time `markOnboardingDismissed()` call
    // in main.ts is the authoritative fix — this test verifies the
    // sessionStorage sentinel path holds suppression even after scrub.
    it('stays suppressed after URL scrub when dismissed-in-session sentinel was set at boot', async () => {
      setSearch('?from=watch&handoff=abc-123');
      const { markOnboardingDismissed } = await import('../../lab/js/runtime/onboarding');
      markOnboardingDismissed(); // what main.ts does at boot for handoff
      setSearch(''); // simulate the consume's history.replaceState scrub
      expect(isOnboardingEligible()).toBe(false);
    });
  });
});

describe('OnboardingOverlay rendering', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().resetTransientState();
  });
  afterEach(() => {
    cleanup();
  });

  it('does not render when onboardingVisible is false', () => {
    const { container } = render(<OnboardingOverlay />);
    expect(container.querySelector('[data-onboarding]')).toBeNull();
  });

  it('renders when onboardingPhase is visible', () => {
    useAppStore.getState().setOnboardingPhase('visible');
    const { container } = render(<OnboardingOverlay />);
    expect(container.querySelector('[data-onboarding]')).not.toBeNull();
    expect(container.textContent).toContain('Atom Simulation Studio');
  });

  it('dismiss on backdrop click transitions to exiting phase', () => {
    useAppStore.getState().setOnboardingPhase('visible');
    const { container } = render(<OnboardingOverlay />);
    const backdrop = container.querySelector('[data-onboarding]')!;
    fireEvent.click(backdrop);
    expect(useAppStore.getState().onboardingPhase).toBe('exiting');
  });

  it('card click also dismisses (tap anywhere to start)', () => {
    useAppStore.getState().setOnboardingPhase('visible');
    const { container } = render(<OnboardingOverlay />);
    const card = container.querySelector('.onboarding-card')!;
    fireEvent.click(card);
    expect(useAppStore.getState().onboardingPhase).toBe('exiting');
  });

  it('dismiss adds highlight class and sink vars to settings button', () => {
    useAppStore.getState().setOnboardingPhase('visible');
    const settingsBtn = document.createElement('button');
    settingsBtn.setAttribute('data-dock-settings', '');
    document.body.appendChild(settingsBtn);

    const { container } = render(<OnboardingOverlay />);
    fireEvent.click(container.querySelector('[data-onboarding]')!);

    expect(settingsBtn.classList.contains('onboarding-sink-target')).toBe(true);
    const card = container.querySelector('.onboarding-card') as HTMLElement;
    expect(card.style.getPropertyValue('--sink-x')).toBeTruthy();
    expect(card.style.getPropertyValue('--sink-y')).toBeTruthy();

    document.body.removeChild(settingsBtn);
  });

  it('fallback timer dismisses overlay and clears highlight', () => {
    vi.useFakeTimers();
    useAppStore.getState().setOnboardingPhase('visible');
    const settingsBtn = document.createElement('button');
    settingsBtn.setAttribute('data-dock-settings', '');
    document.body.appendChild(settingsBtn);

    const { rerender } = render(<OnboardingOverlay />);
    fireEvent.click(document.querySelector('[data-onboarding]')!);
    expect(useAppStore.getState().onboardingPhase).toBe('exiting');
    expect(settingsBtn.classList.contains('onboarding-sink-target')).toBe(true);

    // Advance past fallback timer (950ms + 100ms margin)
    act(() => { vi.advanceTimersByTime(SINK_DURATION_MS + FALLBACK_MARGIN_MS + 50); });

    expect(useAppStore.getState().onboardingPhase).toBe('dismissed');
    expect(useAppStore.getState().onboardingVisible).toBe(false);
    expect(settingsBtn.classList.contains('onboarding-sink-target')).toBe(false);

    rerender(<OnboardingOverlay />);
    expect(document.querySelector('[data-onboarding]')).toBeNull();

    document.body.removeChild(settingsBtn);
    vi.useRealTimers();
  });

  it('finalizeDismissAction transitions exiting → dismissed (pure state)', () => {
    useAppStore.getState().setOnboardingPhase('exiting');
    finalizeDismissAction();
    expect(useAppStore.getState().onboardingPhase).toBe('dismissed');
    expect(useAppStore.getState().onboardingVisible).toBe(false);
  });

  it('finalizeDismissAction is no-op when not in exiting phase', () => {
    useAppStore.getState().setOnboardingPhase('visible');
    finalizeDismissAction();
    expect(useAppStore.getState().onboardingPhase).toBe('visible');
  });

  it('unmount removes onboarding-sink-target from settings button', () => {
    vi.useFakeTimers();
    useAppStore.getState().setOnboardingPhase('visible');
    const settingsBtn = document.createElement('button');
    settingsBtn.setAttribute('data-dock-settings', '');
    document.body.appendChild(settingsBtn);

    const { unmount } = render(<OnboardingOverlay />);
    fireEvent.click(document.querySelector('[data-onboarding]')!);
    expect(settingsBtn.classList.contains('onboarding-sink-target')).toBe(true);

    // Unmount during exiting (before fallback fires) — should clean up highlight
    unmount();
    expect(settingsBtn.classList.contains('onboarding-sink-target')).toBe(false);
    document.body.removeChild(settingsBtn);
    vi.useRealTimers();
  });

  it('no pointer lockup: overlay disappears after dismiss completes', () => {
    vi.useFakeTimers();
    useAppStore.getState().setOnboardingPhase('visible');
    const { container, rerender } = render(<OnboardingOverlay />);
    fireEvent.click(container.querySelector('[data-onboarding]')!);
    expect(useAppStore.getState().onboardingPhase).toBe('exiting');

    act(() => { vi.advanceTimersByTime(SINK_DURATION_MS + FALLBACK_MARGIN_MS + 50); });
    expect(useAppStore.getState().onboardingVisible).toBe(false);

    rerender(<OnboardingOverlay />);
    expect(container.querySelector('[data-onboarding]')).toBeNull();
    vi.useRealTimers();
  });
});
