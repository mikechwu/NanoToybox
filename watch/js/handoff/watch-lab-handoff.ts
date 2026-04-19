/**
 * Watch-side handoff writer. PR 2 foundation.
 *
 * Writes a `WatchToLabHandoffPayload` to localStorage under a fresh
 * UUID token. Sweeps stale entries (older than `HANDOFF_TTL_MS_DEFAULT`)
 * before the write so orphan accumulation is bounded. Retries once on
 * `QuotaExceededError` by clearing all handoff entries; if still failing,
 * throws so the caller can fall back to plain Lab.
 *
 * Rev 7: storage is `localStorage` (not sessionStorage) because
 * `window.open(..., '_blank', 'noopener,noreferrer')` creates a fresh
 * session-storage namespace in the new tab. localStorage is origin-
 * scoped and therefore visible to the newly-opened Lab tab.
 */

import {
  HANDOFF_STORAGE_PREFIX,
  HANDOFF_TTL_MS_DEFAULT,
  serializePayload,
  type WatchToLabHandoffPayload,
} from '../../../src/watch-lab-handoff/watch-lab-handoff-shared';

/**
 * Typed failure the writer raises so the Watch controller can surface
 * mode-specific user copy (§10). Two kinds we can actually distinguish
 * in the browser. Classification covers every storage-touching operation
 * in the write flow — read/iteration (`localStorage.length`, `.key()`,
 * `.getItem()`), write (`setItem`), and retry — not just the final
 * `setItem`:
 *   - `storage-unavailable` — `localStorage` is undefined OR any
 *     read/write access throws a non-quota exception (private mode on
 *     some browsers, site data disabled, policy-blocked origin). The
 *     user's remedies are to reopen in a normal window or use plain
 *     `Open in Lab`.
 *   - `quota-exceeded` — any storage-touching operation failed with a
 *     quota-shaped exception (`QuotaExceededError`,
 *     `NS_ERROR_DOM_QUOTA_REACHED`, or an equivalent `DOMException` on
 *     either a read or a write step) AND the full-sweep retry couldn't
 *     recover. The user's remedy is to free space / clear site data.
 *
 * Kind detection uses both the `DOMException.name`/`code` and a
 * substring check on `.message` so Firefox's
 * `NS_ERROR_DOM_QUOTA_REACHED` shape is handled alongside Chrome/Safari's
 * `QuotaExceededError` name.
 */
export type WatchHandoffWriteErrorKind = 'storage-unavailable' | 'quota-exceeded';
export class WatchHandoffWriteError extends Error {
  readonly kind: WatchHandoffWriteErrorKind;
  constructor(kind: WatchHandoffWriteErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'WatchHandoffWriteError';
    this.kind = kind;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function isQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'QuotaExceededError') return true;
  // Firefox legacy signal
  if (e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  // Legacy code numbers: 22 (Chrome/Safari), 1014 (Firefox)
  if (e.code === 22 || e.code === 1014) return true;
  // Last-resort substring check — robust against engines whose name
  // string drifts (the spec is permissive here) while still narrow
  // enough to avoid swallowing unrelated DOMExceptions.
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return msg.includes('quota');
}

/**
 * Wraps any storage-touching failure in a typed `WatchHandoffWriteError`
 * so the writer's callers see one classified surface regardless of which
 * step (length/key/getItem/setItem/removeItem) actually threw. The
 * classification is based on the *specific* exception passed in, so a
 * retry that fails with a different reason than the initial call
 * reports its own kind (avoids the "always quota" misdiagnosis when
 * storage transitions between full → blocked between attempts).
 */
function classifyWriteFailure(err: unknown): WatchHandoffWriteError {
  if (isQuotaExceeded(err)) {
    return new WatchHandoffWriteError(
      'quota-exceeded',
      'localStorage quota exceeded',
      err,
    );
  }
  return new WatchHandoffWriteError(
    'storage-unavailable',
    err instanceof Error ? err.message : String(err),
    err,
  );
}

/** Session-local monotonic counter feeding the last-resort fallback when
 *  neither `crypto.randomUUID` nor `crypto.getRandomValues` is available.
 *  Collision-free within a tab without relying on Math.random. */
let _fallbackCounter = 0;

/**
 * Exported for unit tests only. Accepts an optional `crypto` override so
 * tests can exercise the fallback branch without monkey-patching
 * `globalThis.crypto`.
 */
export function mintToken(cryptoOverride?: Crypto | null): string {
  const c = cryptoOverride === undefined
    ? (globalThis as { crypto?: Crypto }).crypto
    : cryptoOverride;
  try {
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      const bytes = c.getRandomValues(new Uint8Array(16));
      let hex = '';
      for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
      return hex;
    }
  } catch { /* fallthrough */ }
  // Last-resort fallback: modern browsers all expose crypto; this branch
  // is for exotic / test / legacy environments only. Uses high-res time
  // (or Date.now) combined with a monotonic session-local counter so
  // consecutive calls within the same millisecond still produce distinct
  // tokens WITHOUT leaning on Math.random.
  const t = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? Math.floor(performance.now() * 1000)
    : Date.now();
  _fallbackCounter = (_fallbackCounter + 1) >>> 0;
  return `fallback-${t.toString(36)}-${_fallbackCounter.toString(36)}`;
}

/** Iterate localStorage's handoff-prefixed keys. Does NOT catch its own
 *  exceptions — `localStorage.length` and `localStorage.key()` can throw
 *  `SecurityError` on blocked-storage origins (Safari private mode, site-
 *  data disabled), and we want that exception to propagate so the
 *  surrounding writer flow can classify it with
 *  `classifyWriteFailure`. Swallowing here would mask a real failure
 *  and report an empty key list as if storage were available. */
function iterateHandoffKeys(): string[] {
  if (typeof localStorage === 'undefined') return [];
  const keys: string[] = [];
  const len = localStorage.length;
  for (let i = 0; i < len; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(HANDOFF_STORAGE_PREFIX)) keys.push(k);
  }
  return keys;
}

function sweepStaleEntries(nowMs: number, ttlMs: number): void {
  if (typeof localStorage === 'undefined') return;
  const drop: string[] = [];
  for (const key of iterateHandoffKeys()) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) { drop.push(key); continue; }
      // Cheap check: parse only the createdAt top-level. Full validation
      // lives in the consume path; here we just avoid a stale backlog.
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) { drop.push(key); continue; }
      const createdAt = (parsed as { createdAt?: unknown }).createdAt;
      if (typeof createdAt !== 'number' || nowMs - createdAt > ttlMs) drop.push(key);
    } catch {
      drop.push(key);
    }
  }
  for (const k of drop) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

function clearAllHandoffEntries(): void {
  if (typeof localStorage === 'undefined') return;
  for (const key of iterateHandoffKeys()) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}

export interface WriteOptions {
  /** Override for tests / e2e. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Override for tests / e2e. Defaults to `HANDOFF_TTL_MS_DEFAULT`. */
  ttlMs?: number;
}

/**
 * Write a handoff payload to localStorage and return the minted token.
 * The token is suitable for composing a `?handoff=<token>` URL param.
 *
 * Throws `WatchHandoffWriteError` on any storage failure. The `kind`
 * is classified uniformly across every storage touch — read-path
 * iteration (`localStorage.length` / `.key()` / `.getItem()`) during
 * the pre-write sweep, the initial `setItem`, and the post-sweep
 * `setItem` retry — from the specific exception that actually threw at
 * that step:
 *   - `kind='storage-unavailable'` — localStorage missing, or any
 *     read/write access threw a non-quota error (Safari private-mode
 *     `SecurityError`, site-data disabled, InvalidStateError).
 *   - `kind='quota-exceeded'` — any storage-touching operation raised a
 *     quota-shaped exception (`QuotaExceededError` /
 *     `NS_ERROR_DOM_QUOTA_REACHED`), on either a read step or a write
 *     step, and the full-sweep retry couldn't recover.
 *
 * The classifier runs on the exception that *actually* failed, so a
 * quota → storage-unavailable transition between the initial setItem
 * and the retry is reported as `storage-unavailable` (accurate remedy:
 * "try a normal window", not "free space"). Callers catch by `kind` to
 * surface mode-specific user copy (§10).
 */
export function writeWatchToLabHandoff(
  payload: WatchToLabHandoffPayload,
  opts: WriteOptions = {},
): string {
  if (typeof localStorage === 'undefined') {
    throw new WatchHandoffWriteError(
      'storage-unavailable',
      'localStorage is not available in this context',
    );
  }
  const now = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? HANDOFF_TTL_MS_DEFAULT;
  const token = mintToken();
  const storageKey = `${HANDOFF_STORAGE_PREFIX}${token}`;
  const body = serializePayload(payload);

  // Pre-write sweep is best-effort over individual keys (already
  // swallows per-key parse / getItem failures), BUT the iteration-level
  // access (`localStorage.length` / `localStorage.key()`) can throw
  // SecurityError on blocked storage. Classify any escape so the typed
  // surface holds end-to-end.
  try {
    sweepStaleEntries(now, ttl);
  } catch (err) {
    throw classifyWriteFailure(err);
  }

  try {
    localStorage.setItem(storageKey, body);
    return token;
  } catch (err) {
    if (!isQuotaExceeded(err)) {
      // Non-quota failure on first write — Safari private mode raises
      // SecurityError, other engines surface InvalidStateError. No
      // retry would help; the user needs a non-blocked storage context.
      throw classifyWriteFailure(err);
    }
    // Quota on first write — clear every handoff entry and retry once.
    // If the retry still fails, reclassify based on the retry's actual
    // exception rather than assuming quota. Storage state can drift
    // between attempts (quota → blocked is rare but possible, and the
    // remedy differs), so the surfaced kind must match the current
    // failure, not the original one.
    try {
      clearAllHandoffEntries();
    } catch {
      // Clearing failed (iteration-level read threw). Don't surface
      // yet — the retry setItem below will throw a fresh, equally
      // classifiable exception and that's the authoritative signal.
    }
    try {
      localStorage.setItem(storageKey, body);
      return token;
    } catch (retryErr) {
      throw classifyWriteFailure(retryErr);
    }
  }
}

/** Best-effort removal — used by the cache-invalidation path. */
export function removeWatchToLabHandoff(token: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(`${HANDOFF_STORAGE_PREFIX}${token}`);
  } catch { /* ignore */ }
}
