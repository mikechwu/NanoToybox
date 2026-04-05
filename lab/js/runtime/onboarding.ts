/**
 * Onboarding controller — owns coachmark scheduling, pacing, and persistence.
 *
 * Extracted from main.ts (Phase 4A). StatusController remains the rendering
 * surface (#hint element); this module owns when and what to show.
 *
 * Responsibilities:
 * - Idle-gated coachmark scheduling with cancel-on-interaction
 * - localStorage persistence for one-time coachmarks
 * - Max-one-per-session pacing rule
 * - Mode-aware coachmark selection (Orbit vs Free-Look)
 * - Achievement flag tracking for progressive coachmarks (Phase 4B)
 *
 * Does NOT own the #hint DOM element — StatusController does.
 * Does NOT own placement coachmarks — scene-runtime does.
 *
 * @module onboarding
 *
 * Owns:        Coachmark scheduling timers, session pacing state, achievement
 *              flags, localStorage persistence for one-time coachmarks.
 * Depends on:  app-store (cameraMode read), CONFIG / getDebugParam,
 *              CoachmarkSurface (showCoachmark, hideCoachmark, dismissCoachmark),
 *              OnboardingRendererSurface (pulseTriad).
 * Called by:   main lifecycle (scheduleInitialCoachmarks after init),
 *              input-bindings / interaction layer (recordAchievement on user actions),
 *              overlay open (dismissActive).
 * Teardown:    destroy() — clears all pending timers and active display timeouts.
 */

import { useAppStore } from '../store/app-store';
import { CONFIG, getDebugParam } from '../config';


/** Rendering surface provided by StatusController. */
export interface CoachmarkSurface {
  showCoachmark(opts: { id: string; text: string }): void;
  hideCoachmark(id: string): void;
  dismissCoachmark(id: string): void;
}

/** Renderer surface for visual cues. */
export interface OnboardingRendererSurface {
  pulseTriad(): void;
}

export interface OnboardingDeps {
  getSurface: () => CoachmarkSurface | null;
  getRenderer: () => OnboardingRendererSurface | null;
  isAppRunning: () => boolean;
}

export interface OnboardingController {
  /** Schedule initial coachmarks (called once after init). */
  scheduleInitialCoachmarks(): void;
  /** Record an achievement and potentially trigger a progressive coachmark. */
  recordAchievement(key: AchievementKey): void;
  /** Dismiss any active or pending onboarding coachmark (called on overlay open). */
  dismissActive(): void;
  /** Tear down timers and listeners. */
  destroy(): void;
}

// ── Achievement keys (Phase 4B) ──

export type AchievementKey =
  | 'orbit-drag'       // user dragged to orbit (triad or background)
  | 'axis-snap'        // user tapped an axis endpoint to snap
  | 'view-reset'       // user double-tapped center to reset
  | 'mode-entry';      // user entered Free-Look for the first time

// ── Coachmark definitions ──

interface CoachmarkDef {
  key: string;           // localStorage key
  id: string;            // coachmark ID for show/hide
  text: string;
  delayMs: number;
  displayMs: number;
  pulse?: boolean;       // pulse the triad on show
}

const ORBIT_V1: CoachmarkDef = {
  key: 'mobile-orbit-v1',
  id: 'mobile-orbit',
  text: 'Drag triad to rotate view',
  delayMs: 3000,
  displayMs: 4000,
  pulse: true,
};

const ORBIT_V2: CoachmarkDef = {
  key: 'mobile-orbit-v2',
  id: 'mobile-orbit-v2',
  text: 'Drag triad anytime \u00B7 Drag clear background when available',
  delayMs: 5000,
  displayMs: 5000,
};

// Progressive coachmarks (Phase 4B) — triggered by achievements
const PROGRESSIVE: Array<{
  /** Achievement that triggers this coachmark. */
  trigger: AchievementKey;
  /** Only show if this localStorage key is not set. */
  def: CoachmarkDef;
}> = [
  {
    trigger: 'orbit-drag',
    def: {
      key: 'coachmark-snap-hint',
      id: 'snap-hint',
      text: 'Tap an axis end on the triad to snap to that view',
      delayMs: 2000,
      displayMs: 4000,
    },
  },
  {
    trigger: 'axis-snap',
    def: {
      key: 'coachmark-reset-hint',
      id: 'reset-hint',
      text: 'Double-tap the triad center to reset your view',
      delayMs: 2000,
      displayMs: 4000,
    },
  },
  {
    trigger: 'mode-entry',
    def: {
      key: 'coachmark-freelook-target',
      id: 'freelook-target',
      text: 'Tap a molecule to mark it as your orbit target',
      delayMs: 3000,
      displayMs: 4000,
    },
  },
];

export function createOnboardingController(deps: OnboardingDeps): OnboardingController {
  let _showTimer: ReturnType<typeof setTimeout> | null = null;
  let _hideTimer: ReturnType<typeof setTimeout> | null = null;
  let _cancelListeners: Array<() => void> = [];
  let _sessionCoachmarkShown = false; // max-one-per-session pacing
  let _activeCoachmarkId: string | null = null; // currently visible coachmark

  /** Check if app is in a clean "teach now" state. */
  function isIdle(): boolean {
    if (!deps.isAppRunning()) return false;
    if (!CONFIG.isTouchInteraction()) return false;
    const s = useAppStore.getState();
    if (s.activeSheet !== null) return false;
    if (s.placementActive) return false;
    if (s.atomCount === 0) return false;
    return true;
  }

  /** Cancel any pending show/hide timers. */
  function clearTimers() {
    if (_showTimer) { clearTimeout(_showTimer); _showTimer = null; }
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  }

  /** Remove any active cancel listeners. */
  function clearCancelListeners() {
    for (const remove of _cancelListeners) remove();
    _cancelListeners = [];
  }

  /**
   * Schedule a one-time coachmark with shared lifecycle:
   * - Cancels if user interacts before display
   * - Checks isIdle() before showing
   * - Respects max-one-per-session pacing (at scheduling AND display time)
   * - Clears any pending coachmark before scheduling a new one
   *
   * Replacement policy (intentional): if a new coachmark is scheduled while
   * another is pending, the new one replaces the old. This is last-write-wins
   * by design — achievement events fire in user-action order, so the most
   * recent achievement is the most relevant teaching moment.
   */
  function scheduleCoachmark(def: CoachmarkDef): void {
    if (localStorage.getItem(def.key)) return;
    if (_sessionCoachmarkShown) return;

    // Clear any pending coachmark — only one can be queued at a time
    clearTimers();
    clearCancelListeners();

    let cancelled = false;
    const cancel = () => { cancelled = true; };
    document.addEventListener('pointerdown', cancel, { once: true });
    document.addEventListener('touchstart', cancel, { once: true });
    _cancelListeners.push(
      () => { document.removeEventListener('pointerdown', cancel); },
      () => { document.removeEventListener('touchstart', cancel); },
    );

    _showTimer = setTimeout(() => {
      _showTimer = null;
      clearCancelListeners();
      if (cancelled || _sessionCoachmarkShown) return;
      if (!isIdle()) return;

      const surface = deps.getSurface();
      if (!surface) return;

      surface.showCoachmark({ id: def.id, text: def.text });
      localStorage.setItem(def.key, '1');
      _sessionCoachmarkShown = true;
      _activeCoachmarkId = def.id;

      if (def.pulse) {
        deps.getRenderer()?.pulseTriad();
      }

      _hideTimer = setTimeout(() => {
        _hideTimer = null;
        _activeCoachmarkId = null;
        deps.getSurface()?.hideCoachmark(def.id);
      }, def.displayMs);
    }, def.delayMs);
  }

  return {
    scheduleInitialCoachmarks() {
      // v1: first mobile session — teaches triad drag
      if (!localStorage.getItem(ORBIT_V1.key)) {
        scheduleCoachmark(ORBIT_V1);
      }
      // v2: returning users (v1 dismissed in a prior session) — teaches background orbit
      else if (!localStorage.getItem(ORBIT_V2.key)) {
        scheduleCoachmark(ORBIT_V2);
      }
    },

    recordAchievement(key: AchievementKey) {
      // Only trigger progressive coachmarks on mobile
      if (!CONFIG.isTouchInteraction()) return;

      for (const entry of PROGRESSIVE) {
        if (entry.trigger === key) {
          scheduleCoachmark(entry.def);
          break; // max one per achievement event
        }
      }
    },

    dismissActive() {
      clearTimers();
      clearCancelListeners();
      if (_activeCoachmarkId) {
        // Use dismissCoachmark (not hideCoachmark) — clears the hint surface
        // entirely instead of restoring generic hint text underneath.
        deps.getSurface()?.dismissCoachmark(_activeCoachmarkId);
        _activeCoachmarkId = null;
      }
    },

    destroy() {
      clearTimers();
      clearCancelListeners();
    },
  };
}

// ── Page-load onboarding overlay gate (reactive) ──
// Onboarding shows on every page load (page-lifetime dismissal).
// Dismissed via in-memory Zustand state, reappears on reload.

/**
 * Check whether onboarding overlay is eligible to show.
 * Pure readiness check — no side effects.
 * Suppressed by ?e2e=1 (see getDebugParam in config.ts for approved debug params).
 */
export function isOnboardingEligible(): boolean {
  if (getDebugParam('e2e') === '1') return false;
  const s = useAppStore.getState();
  if (s.activeSheet !== null) return false;
  if (s.placementActive) return false;
  if (s.timelineMode === 'review') return false;
  if (s.atomCount === 0) return false;
  if (s.onboardingPhase !== 'dismissed') return false; // already showing or exiting
  return true;
}

/**
 * Subscribe to store and show onboarding when the app reaches ready state.
 * Page-lifetime: fires at most once per page load (once-only flag).
 * Returns unsubscribe function for teardown.
 */
export function subscribeOnboardingReadiness(): () => void {
  // Check immediately (may already be ready)
  if (isOnboardingEligible()) {
    useAppStore.getState().setOnboardingPhase('visible');
    return () => {};
  }

  let _fired = false;
  const unsub = useAppStore.subscribe(() => {
    if (_fired) return;
    if (isOnboardingEligible()) {
      _fired = true;
      useAppStore.getState().setOnboardingPhase('visible');
      unsub();
    }
  });
  return unsub;
}
