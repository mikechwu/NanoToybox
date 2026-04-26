/**
 * Trim submit coordinator — single seam that resolves the publish
 * submit target AND clears guest preflight (Turnstile token readiness)
 * BEFORE any executor callback is dispatched.
 *
 * Architectural rule (§H of the Phase 1 architecture report): the
 * publish layer resolves an explicit `TrimSubmitTarget` exactly once
 * per submit, in this single named seam, before any executor is
 * invoked. Executors do not infer target, do not import
 * `AuthStatus` or `PublicConfig`, and do not branch on auth.
 *
 * This module owns:
 *   - submit-target resolution from (action, authStatus, publicConfig)
 *   - guest submit preflight (Turnstile token readiness)
 *   - the unavailability taxonomy that TimelineBar maps to in-context
 *     prompt copy
 *
 * This module DOES NOT own:
 *   - prepared-capsule preparation (that is the service in
 *     `prepared-capsule-service.ts`)
 *   - the actual POST or its error mapping (those live in the
 *     per-mode helpers and the prepared-publish executors)
 *   - any UI state — TimelineBar gathers raw inputs and dispatches
 *     based on the resolved value; the resolution does not persist
 *     across submits.
 */

// Imported from the dependency-free runtime contract module so the
// publish coordinator does not depend on the Zustand store layer.
// The store re-exports these types, so existing UI code that imports
// `AuthStatus`/`PublicConfig` from `app-store` continues to work.
import type { AuthStatus, PublicConfig } from './share-auth-types';

/** Which Share button the user invoked.
 *
 *   - `share-account` — the signed-in "Share to my account" path. In
 *     Phase 2 a signed-in user may still pick a Quick Share, but the
 *     handler picks this action when the explicit Share button is the
 *     submit source.
 *   - `quick-share`   — the anonymous "Quick Share" / guest path. In
 *     Phase 2 this is also available to signed-in users who explicitly
 *     opt for a guest share.
 */
export type TrimSubmitAction = 'share-account' | 'quick-share';

export type TrimSubmitTarget = 'account' | 'guest';

/** Reasons a target may be unavailable. TimelineBar maps each to an
 *  in-context prompt slot. */
export type TrimSubmitUnavailableReason =
  /** Action requires signed-in; authStatus is signed-out. */
  | 'auth-required'
  /** publicConfig.guestPublish.enabled === false. */
  | 'guest-disabled'
  /** authStatus === 'unverified' for an action that needs a definitive answer. */
  | 'unverified'
  /** Guest action but turnstileSiteKey is null. */
  | 'config-missing'
  /** Guest action but no live turnstileToken yet. */
  | 'verification-required';

export type ResolvedTrimSubmit =
  | { kind: 'ok'; target: 'account' }
  | { kind: 'ok'; target: 'guest'; turnstileToken: string }
  | { kind: 'unavailable'; reason: TrimSubmitUnavailableReason };

export interface TrimSubmitInput {
  action: TrimSubmitAction;
  authStatus: AuthStatus;
  publicConfig: PublicConfig;
  /** Current value from the dialog's Turnstile controller, or null when
   *  no live token is solved. The seam reads this snapshot — it never
   *  re-fetches the token from a ref. */
  turnstileToken: string | null;
}

/**
 * Resolve target + verify guest preflight in a single call.
 *
 * Pure function. Same inputs → same outputs. Auth/config/token reads
 * are made by the caller before invocation; this never reaches into
 * the store, refs, or globals.
 */
export function resolveTrimSubmitTarget(
  input: TrimSubmitInput,
): ResolvedTrimSubmit {
  const { action, authStatus, publicConfig, turnstileToken } = input;

  if (action === 'share-account') {
    if (authStatus === 'unverified') {
      return { kind: 'unavailable', reason: 'unverified' };
    }
    if (authStatus !== 'signed-in') {
      return { kind: 'unavailable', reason: 'auth-required' };
    }
    return { kind: 'ok', target: 'account' };
  }

  // quick-share — guest target.
  if (!publicConfig.guestPublish.enabled) {
    return { kind: 'unavailable', reason: 'guest-disabled' };
  }
  if (publicConfig.guestPublish.turnstileSiteKey === null) {
    return { kind: 'unavailable', reason: 'config-missing' };
  }
  if (!turnstileToken) {
    return { kind: 'unavailable', reason: 'verification-required' };
  }
  return { kind: 'ok', target: 'guest', turnstileToken };
}
