/**
 * AgeGateCheckbox — shared component for the signed-out auth surfaces.
 *
 * Required above the provider buttons in BOTH the Transfer dialog's
 * signed-out panel AND the AccountControl signed-out menu, per the
 * plan's "Policy-link placement contract" (one sentence, one component,
 * so the two consent points cannot drift).
 *
 * Contract:
 *   - Renders a labeled checkbox + link-carrying consent sentence.
 *   - When checked, fetches a signed age-intent nonce from
 *     `/api/account/age-confirmation/intent`. The fetched nonce is
 *     surfaced via `onAgeIntent` so the caller can pass it to the
 *     OAuth start URL.
 *   - The caller is expected to disable its provider buttons until
 *     `checked && ageIntent` are both truthy.
 *
 * Nonce freshness: the server-issued intent has a 5-minute TTL. A user
 * who checks the box, then leaves the menu open while reading policy
 * text, would otherwise hit a raw 400 ("Invalid age confirmation
 * nonce: expired") on click. To avoid that, this component:
 *
 *   - Fetches once on tick.
 *   - Sets a refresh interval that re-mints the nonce every
 *     `REFRESH_INTERVAL_MS` (4 min — well inside the 5-min server TTL)
 *     while the box stays checked.
 *   - Surfaces an inline `age-gate__error` paragraph if the fetch
 *     fails so the caller knows the buttons are disabled for a real
 *     reason, not a silent network blip.
 */

import React, { useCallback, useEffect, useState } from 'react';

/** Refresh interval. Server TTL is 5 min; we refresh at 4 min so the
 *  nonce is always at least one window away from expiry on click. */
const REFRESH_INTERVAL_MS = 4 * 60 * 1000;

/** Caller-side staleness threshold. Mirrors the refresh interval —
 *  exported so click handlers can run the same age check without
 *  duplicating the constant. */
export const AGE_INTENT_STALE_AFTER_MS = REFRESH_INTERVAL_MS;

export interface AgeGateCheckboxProps {
  /** Controlled checked state. */
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /**
   * Called with the latest signed intent token + the wall-clock ms
   * the token was received. Null when cleared / on fetch failure /
   * before the first fetch completes. The caller is expected to use
   * `mintedAt` to gate click handlers on freshness — see
   * `AGE_INTENT_STALE_AFTER_MS`.
   */
  onAgeIntent: (token: string | null, mintedAt: number | null) => void;
  /**
   * Imperative refresh trigger. Increment from the consumer to force a
   * fresh fetch outside the periodic interval and the visibility-change
   * listener — used when a click handler detects a stale token and
   * needs the recovery path to actually run, not just clear local
   * state. Any change to this number (in either direction) re-runs the
   * fetch effect.
   */
  refreshNonce?: number;
  /**
   * Reports the in-flight fetch state to the consumer so it can render
   * a truthful "Refreshing…" note alongside its own controls. The
   * built-in note inside this component is too narrow when the
   * consumer needs to gate provider buttons or its own action labels
   * on the same signal.
   */
  onFetchingChange?: (fetching: boolean) => void;
  /** Unique id suffix so two instances can co-exist on one page. */
  idSuffix: string;
  /** Optional tweak for compact contexts. */
  compact?: boolean;
}

export function AgeGateCheckbox({
  checked,
  onCheckedChange,
  onAgeIntent,
  refreshNonce = 0,
  onFetchingChange,
  idSuffix,
  compact,
}: AgeGateCheckboxProps) {
  const id = `age-gate-${idSuffix}`;
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Mirror the local fetching state up to the consumer so a single
  // boolean drives both this component's note and the consumer's
  // button labels / disabled state.
  useEffect(() => {
    onFetchingChange?.(fetching);
  }, [fetching, onFetchingChange]);

  useEffect(() => {
    if (!checked) {
      // Drop any in-flight fetch state synchronously. Without this, an
      // unchecked-while-refreshing transition leaves `fetching=true`
      // stuck (the in-flight `.finally()` is skipped under `cancelled`),
      // which propagates to the consumer's onFetchingChange and keeps
      // a "Refreshing sign-in…" note on screen forever.
      setFetching(false);
      onAgeIntent(null, null);
      setFetchError(null);
      return;
    }
    let cancelled = false;

    // Single fetch helper. Each call clears any prior error so the
    // visible state matches the latest attempt.
    const refresh = () => {
      if (cancelled) return;
      setFetching(true);
      setFetchError(null);
      fetch('/api/account/age-confirmation/intent', {
        method: 'POST',
        credentials: 'include',
      })
        .then((res) => {
          if (!res.ok) throw new Error(`intent ${res.status}`);
          return res.json();
        })
        .then((data: { ageIntent: string }) => {
          if (!cancelled) onAgeIntent(data.ageIntent, Date.now());
        })
        .catch((err: unknown) => {
          // Always log — the inline DOM message is for the user; ops
          // visibility (Sentry / Pages logs / devtools console) needs
          // its own breadcrumb so we know how often the intent
          // endpoint fails for real users.
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[age-gate] intent fetch failed: ${message}`);
          if (!cancelled) {
            setFetchError(message);
            // Null out the stale token + timestamp so the caller's
            // button stays disabled until a refresh succeeds.
            onAgeIntent(null, null);
          }
        })
        .finally(() => {
          if (!cancelled) setFetching(false);
        });
    };

    refresh();
    // Periodic refresh handles foreground tabs.
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    // Visibility refresh handles background-throttle and sleep/resume:
    // setInterval can pause for minutes when the tab isn't visible, so
    // when the tab becomes visible again we mint a fresh token
    // immediately rather than wait for the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // `refreshNonce` is intentionally a dependency: any change re-runs
    // the effect, which immediately fires a fresh `refresh()` and
    // restarts the timer. That is the consumer-side recovery hook for
    // the click-time stale-token path — without it, clearing local
    // token state in the consumer would leave the component idle until
    // the next 4-min tick or visibilitychange.
  }, [checked, onAgeIntent, refreshNonce]);

  const handleToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => onCheckedChange(e.target.checked),
    [onCheckedChange],
  );

  return (
    <div className={`age-gate${compact ? ' age-gate--compact' : ''}`}>
      <label htmlFor={id} className="age-gate__label">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={handleToggle}
          data-testid={`age-gate-checkbox-${idSuffix}`}
        />
        <span>
          I confirm that I am at least 13 years old and have read the{' '}
          <a href="/privacy/" target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>{' '}
          and{' '}
          <a href="/terms/" target="_blank" rel="noopener noreferrer">
            Terms
          </a>
          .
        </span>
      </label>
      {fetching ? (
        <p className="age-gate__note" aria-live="polite">
          Preparing sign-in…
        </p>
      ) : null}
      {fetchError ? (
        <p className="age-gate__error" role="alert">
          Could not prepare sign-in: {fetchError}
        </p>
      ) : null}
    </div>
  );
}
