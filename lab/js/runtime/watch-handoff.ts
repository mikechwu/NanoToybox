/**
 * Lab-side handoff consumer. PR 2 foundation.
 *
 * Reads `?from=watch&handoff=<token>` off the current URL, loads + removes
 * the matching localStorage entry, validates the payload, and returns a
 * `ConsumedWatchHandoff` or null. Always strips the `from`/`handoff`
 * params from the URL (even on null/rejected) so a refresh cannot replay.
 *
 * Rev 7: backing store is `localStorage` (not sessionStorage). The
 * Watch side opens Lab via `window.open('_blank', 'noopener,noreferrer')`,
 * which creates a fresh session-storage namespace in this tab, so a
 * sessionStorage-based token would be invisible. localStorage is
 * origin-scoped and preserves the handoff across the new-tab boundary.
 *
 * The hydrate call site (`scene-runtime.hydrateFromWatchSeed`) is the
 * follow-up work that consumes `payload.seed` transactionally across
 * the main-thread physics, worker runtime, renderer, scene registry, and
 * store projection. This file stops at produce-the-validated-payload.
 */

import {
  HANDOFF_STORAGE_PREFIX,
  HANDOFF_TTL_MS_DEFAULT,
  deserializeAndValidate,
  type ConsumeReason,
  type WatchToLabHandoffPayload,
} from '../../../src/watch-lab-handoff/watch-lab-handoff-shared';

/**
 * Outcome of a boot-time handoff consume attempt. Three states so the
 * boot caller can distinguish:
 *   - `none`       — no `?from=watch` in the URL at all. Lab boots
 *                    normally with no signal to the user.
 *   - `ready`      — valid payload ready to hand to hydrate.
 *   - `rejected`   — `?from=watch` was present but the handoff was
 *                    invalid for the reason given. The boot decides
 *                    which reasons warrant a user-visible toast (per
 *                    plan §10): only `stale` does, because it reflects
 *                    a user-attempted remix that just arrived too
 *                    late. Malformed / unknown-version / wrong-source
 *                    / wrong-mode are tampering or schema-drift
 *                    signals — scaring users with a toast on a
 *                    coincidental backend update is worse than a
 *                    quiet fallback, so those stay silent (the
 *                    console.warn inside this module is the
 *                    diagnostic surface).
 */
export type ConsumeOutcome =
  | { status: 'none' }
  | {
      status: 'ready';
      payload: WatchToLabHandoffPayload;
      /** The URL-scoped token that produced this payload. Carried on the
       *  outcome so boot callers can use it as a stable key — the
       *  §7.2 arrival pill uses it as its session-dismissal
       *  suppression key. NOT put on the outcome when rejected:
       *  rejected payloads have nothing to acknowledge. */
      token: string;
    }
  | { status: 'rejected'; reason: ConsumeReason };

/** @deprecated Use `ConsumeOutcome`. Retained for type-import back-
 *  compat during the migration; new callers should discriminate on
 *  `status` directly. */
export interface ConsumedWatchHandoff {
  status: 'ready';
  payload: WatchToLabHandoffPayload;
}

/** URL params that belong to this runtime; cleaned up on every consume attempt. */
const OUR_PARAMS = ['from', 'handoff'] as const;

function scrubUrlParams(location: Location, history: History): void {
  try {
    const url = new URL(location.href);
    let mutated = false;
    for (const k of OUR_PARAMS) {
      if (url.searchParams.has(k)) {
        url.searchParams.delete(k);
        mutated = true;
      }
    }
    if (mutated) {
      const search = url.searchParams.toString();
      const next = url.pathname + (search ? `?${search}` : '') + url.hash;
      history.replaceState(null, '', next);
    }
  } catch { /* ignore */ }
}

function readTtlOverride(location: Location): number {
  try {
    const v = new URLSearchParams(location.search).get('e2eHandoffTtlMs');
    if (v == null) return HANDOFF_TTL_MS_DEFAULT;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : HANDOFF_TTL_MS_DEFAULT;
  } catch {
    return HANDOFF_TTL_MS_DEFAULT;
  }
}

function logRejection(reason: ConsumeReason): void {
  // Per §10: `stale` + `missing-entry` are user-visible (boot surfaces a
  // toast) AND console.warn'd for ops diagnostics. Tampering / schema-
  // drift reasons (malformed, wrong*, parse-error) are silent to the
  // user but still console.warn'd. `missing-token` is the one exception:
  // `?from=watch` with no `?handoff` param is crafted-URL territory, not
  // a normal user flow — stay fully silent so we don't pollute logs with
  // probe noise.
  if (reason === 'missing-token') return;
  // eslint-disable-next-line no-console
  console.warn(`[lab.boot] watch handoff rejected: ${reason}`);
}

/**
 * Parses the URL, loads + removes the localStorage entry (even on
 * parse failure so a poisoned token cannot replay), validates the
 * payload against the §5 validation contract, and returns the outcome
 * as a discriminated union. ALWAYS strips `from`/`handoff` from the
 * URL before returning.
 *
 * Boot code inspects `status` to decide: `ready` → hydrate, `rejected`
 * → optionally surface a user-facing error based on `reason`,
 * `none` → silent normal boot.
 */
export function consumeWatchToLabHandoffFromLocation(
  location: Location,
  history: History = window.history,
): ConsumeOutcome {
  let token: string | null = null;
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('from') !== 'watch') {
      // No URL signal → silently "none"; nothing to log.
      scrubUrlParams(location, history);
      return { status: 'none' };
    }
    token = params.get('handoff');
  } catch {
    scrubUrlParams(location, history);
    return { status: 'none' };
  }

  if (!token) {
    logRejection('missing-token');
    scrubUrlParams(location, history);
    return { status: 'rejected', reason: 'missing-token' };
  }

  const storageKey = `${HANDOFF_STORAGE_PREFIX}${token}`;
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
  } catch { raw = null; }

  // Consume even on parse failure — prevents a poisoned token replaying.
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(storageKey);
  } catch { /* ignore */ }

  if (raw == null) {
    logRejection('missing-entry');
    scrubUrlParams(location, history);
    return { status: 'rejected', reason: 'missing-entry' };
  }

  const ttl = readTtlOverride(location);
  const now = Date.now();
  const result = deserializeAndValidate(raw, now, ttl);
  scrubUrlParams(location, history);

  if (result.status !== 'ready' || !result.payload) {
    const reason: ConsumeReason = result.reason ?? 'parse-error';
    logRejection(reason);
    return { status: 'rejected', reason };
  }

  return { status: 'ready', payload: result.payload, token };
}
