/**
 * Auth runtime — Lab-side wiring for the capsule share auth UX (Phase 6).
 *
 * Responsibilities:
 *   - Fetch the current session from `/api/auth/session` on boot.
 *   - Expose `signIn(provider, opts)` and `signOut()` callbacks that the
 *     AccountControl and TransferDialog components consume via the store.
 *   - Persist a lightweight "resume publish" intent across the OAuth redirect
 *     so returning users land back in the Transfer → Share tab, ready to
 *     publish, instead of a blank Lab screen.
 *
 * ── State-machine contract ────────────────────────────────────────────────
 *
 * The store's `auth.status` carries four discrete states:
 *
 *   loading     → initial fetch in flight; UI renders neutral chrome
 *   signed-in   → server returned 200 with a valid session payload
 *   signed-out  → server returned 401 (authoritative)
 *   unverified  → transport / 5xx / malformed response AND no prior session
 *                 to preserve. UI must show a neutral "can't verify"
 *                 affordance — NOT an OAuth prompt. Treating a transport
 *                 blip as signed-out would mislead users whose cookie is
 *                 still valid server-side.
 *
 * Transition policy for hydrateAuthSession():
 *
 *   | Outcome                       | Prior state          | Next state     |
 *   |-------------------------------|----------------------|----------------|
 *   | 200 + valid shape             | any                  | signed-in      |
 *   | 401                           | any                  | signed-out     |
 *   | network/5xx/malformed         | loading              | unverified     |
 *   | network/5xx/malformed         | any other            | (keep prior)   |
 *
 * Preserving non-`loading` prior states on indeterminate outcomes is the
 * key invariant: a late/concurrent fetch must not clobber an authoritative
 * signed-in or signed-out answer with the weaker `unverified` state.
 *
 * The Lab must work for unauthenticated users; this runtime never blocks
 * boot on the session fetch. Watch and local download stay fully public.
 */

import { useAppStore, type AuthCallbacks, type AuthState } from '../store/app-store';

/** Sentinel key for the resume-publish intent in sessionStorage. */
const RESUME_KEY = 'atomdojo.resumePublish';

/** Resume intents older than this are ignored — covers the "user started
 *  OAuth, abandoned it, came back hours later already signed in" leak case. */
const RESUME_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Query marker appended to returnTo so the callback lands us at a URL that
 *  *proves* this page load followed an OAuth round-trip. Without this marker
 *  we treat the sessionStorage sentinel as stale and ignore it. */
export const AUTH_RETURN_QUERY = 'authReturn';

/** Typed error used by Lab-side protected-action callers (publish) when the
 *  server returns 401. Consumers flip the store's auth state to signed-out
 *  so the Transfer dialog's Share panel re-renders as the in-context auth
 *  prompt rather than a generic "publish failed" error. */
export class AuthRequiredError extends Error {
  readonly kind = 'auth-required' as const;
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** Shape returned by GET /api/auth/session on success (200). */
interface SessionPayload {
  userId: string;
  displayName: string | null;
  createdAt: string;
}

function isSessionPayload(v: unknown): v is SessionPayload {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.userId === 'string'
    && (r.displayName === null || typeof r.displayName === 'string')
  );
}

/** Monotonic counter used to drop late hydrate writes.
 *
 *  Without this, a stale `/api/auth/session` response can land *after* a
 *  more-authoritative state change (e.g. a 401 from `/publish`, or an
 *  explicit logout) and clobber it. Concrete race:
 *
 *    1. Dialog opens → opportunistic hydrateA() fires; fetch queued.
 *    2. User clicks Publish → 401 → setAuthSignedOut().
 *    3. hydrateA's pre-revocation 200 finally arrives → would set
 *       signed-in, undoing step 2.
 *
 *  Each call increments the counter at entry and only commits its result
 *  when it is still the latest. The indeterminate branches were already
 *  safe via the "preserve non-loading prior state" rule; this adds the
 *  same protection to the authoritative 200 / 401 branches. */
let hydrateSeq = 0;

/** Snapshot helper — returns a shallow copy so callers cannot mutate the
 *  store's live AuthState reference. */
function snapshotAuth(): AuthState {
  return { ...useAppStore.getState().auth } as AuthState;
}

/** One-shot session fetch. Never throws. Settles `auth.status` per the
 *  transition table in this module's header.
 *
 *  Concurrency: late writes are dropped via the `hydrateSeq` token (see
 *  comment above). The function is safe to call from anywhere (boot,
 *  dialog open, retry button) without ordering coordination. */
export async function hydrateAuthSession(): Promise<AuthState> {
  const mySeq = ++hydrateSeq;
  const isLatest = () => mySeq === hydrateSeq;

  /** Resolve an indeterminate-outcome branch (network / 5xx / malformed).
   *
   *  An indeterminate result is strictly weaker than the state we already
   *  have, so it must never clobber a more-authoritative answer:
   *
   *    - signed-in  → preserve. The cookie is still valid server-side; only
   *                   our ability to read it was broken.
   *    - signed-out → preserve. A 401 (or an explicit sign-out) is the
   *                   server's / user's authoritative statement.
   *    - unverified → no-op (already the weak state).
   *    - loading    → advance to `unverified` so the UI exits the neutral
   *                   "checking" spinner without falsely asserting the
   *                   user is signed out. */
  const resolveIndeterminate = (reason: string): AuthState => {
    const current = useAppStore.getState().auth;
    if (current.status !== 'loading') {
      if (reason) console.warn(`[auth] session fetch ${reason} → keep ${current.status}`);
      return snapshotAuth();
    }
    // prior state was 'loading' — advance to 'unverified' unless a newer
    // hydrate has already committed something more authoritative, in which
    // case we return the store's current snapshot instead of overwriting.
    if (!isLatest()) return snapshotAuth();
    useAppStore.getState().setAuthUnverified();
    if (reason) console.warn(`[auth] session fetch ${reason} → unverified`);
    return { status: 'unverified', session: null };
  };

  let res: Response;
  try {
    res = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
    });
  } catch (err) {
    // Transport failure — could not even reach the server. Distinct from
    // a malformed body (caught below), so logs and tests can tell them apart.
    return resolveIndeterminate(`transport failed: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    // Authoritative signed-out answer from the server. Only commit if we
    // are still the latest hydrate — a later authoritative write must win.
    if (isLatest()) useAppStore.getState().setAuthSignedOut();
    else return snapshotAuth();
    return { status: 'signed-out', session: null };
  }
  if (!res.ok) {
    return resolveIndeterminate(`unexpected status ${res.status}`);
  }

  // Body parse is its own failure class — a 200 with HTML/garbage means the
  // server *answered* but what it said is unusable. Routing this through the
  // transport bucket would mask CDN/proxy misconfiguration in logs.
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    return resolveIndeterminate(`body parse failed: ${(err as Error).message}`);
  }
  if (!isSessionPayload(payload)) {
    return resolveIndeterminate('returned unexpected shape');
  }

  const session = { userId: payload.userId, displayName: payload.displayName };
  if (isLatest()) useAppStore.getState().setAuthSignedIn(session);
  else return snapshotAuth();
  return { status: 'signed-in', session };
}

/** Structured resume intent payload persisted in sessionStorage across the
 *  OAuth round-trip. `iat` is epoch ms at set-time — used to drop stale
 *  intents. `provider` is informational (could be used for future UI hints
 *  like "continuing sign-in with Google…"). */
interface ResumeIntentPayload {
  kind: 'resumePublish';
  provider: 'google' | 'github';
  iat: number;
}

function isResumeIntentPayload(v: unknown): v is ResumeIntentPayload {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  // `iat` must be a positive finite number — guards against NaN / Infinity
  // / negative timestamps which would otherwise pass `typeof === 'number'`
  // and skew the freshness check.
  return (
    r.kind === 'resumePublish'
    && (r.provider === 'google' || r.provider === 'github')
    && typeof r.iat === 'number'
    && Number.isFinite(r.iat)
    && r.iat > 0
  );
}

/** Best-effort sessionStorage clear of the resume-intent sentinel. Logs
 *  once if removeItem actually throws — private-browsing typically only
 *  blocks setItem, so a removeItem failure signals real storage trouble
 *  worth surfacing. Centralizes the previously-scattered try/catch blocks. */
function clearResumeIntent(): void {
  try {
    sessionStorage.removeItem(RESUME_KEY);
  } catch (err) {
    console.warn('[auth] resume-intent clear failed:', err);
  }
}

/** Redirect the browser to the provider's OAuth start endpoint. */
function beginOAuth(provider: 'google' | 'github', withAuthMarker: boolean): void {
  const startPath = provider === 'google' ? '/auth/google/start' : '/auth/github/start';
  // Only attach the `authReturn=1` marker when we genuinely want to resume
  // the publish flow — secondary sign-ins (top-bar) skip the flag so a
  // returning page load won't auto-open the Transfer dialog unexpectedly.
  const returnTo = withAuthMarker ? '/lab/?authReturn=1' : '/lab/';
  const url = `${startPath}?returnTo=${encodeURIComponent(returnTo)}`;
  window.location.assign(url);
}

/** Stash a structured, timestamped resume-publish intent. Silent-degrades
 *  to "no resume" in private-browsing modes that block sessionStorage
 *  writes — the share CTA stays where it is in that case. */
function setResumePublishIntent(provider: 'google' | 'github'): void {
  try {
    const payload: ResumeIntentPayload = {
      kind: 'resumePublish',
      provider,
      iat: Date.now(),
    };
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(payload));
  } catch {
    // Intentional silent degrade — see docstring.
  }
}

/** Delay (ms) before re-checking the session after a failed logout.
 *  Long enough to absorb a brief network blip; short enough that a user
 *  watching the chip will see it correct itself within a few seconds. */
const LOGOUT_RECONCILE_DELAY_MS = 3000;

/** Read + clear the resume-publish intent, validating freshness and the
 *  query-marker handshake. Returns true only when ALL hold:
 *    - the URL has `?authReturn=1` (navigation actually followed an OAuth
 *      callback, not an unrelated reload)
 *    - the stored payload parses and matches the expected shape
 *    - `iat` is fresh (0 ≤ age ≤ RESUME_TTL_MS)
 *  When the marker is present, the intent is always cleared so a single
 *  callback cannot auto-open the dialog on every subsequent reload.
 *  The query marker itself is cleaned up via `history.replaceState` so the
 *  user-visible URL stays at /lab/ without the ephemeral flag. */
export function consumeResumePublishIntent(): boolean {
  const hasMarker = (() => {
    try {
      const p = new URLSearchParams(window.location.search);
      return p.get(AUTH_RETURN_QUERY) === '1';
    } catch {
      return false;
    }
  })();
  if (!hasMarker) {
    // No genuine callback handshake — do NOT touch the sentinel. It may be
    // a pending OAuth round-trip still in progress (user opened a new tab).
    return false;
  }

  // Clean up the query marker regardless — it has served its purpose and
  // keeping it in the URL would confuse bookmark/share flows.
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(AUTH_RETURN_QUERY);
    const qs = url.searchParams.toString();
    const cleaned = `${url.pathname}${qs ? `?${qs}` : ''}${url.hash}`;
    window.history.replaceState(window.history.state, '', cleaned);
  } catch {
    // History API unavailable in some test harnesses — safe to ignore;
    // sentinel cleanup below is the load-bearing step.
  }

  // Always clear once we've seen the marker — a stale payload must not
  // persist past one consume attempt, regardless of whether it ends up
  // being honored. clearResumeIntent runs before the freshness check so
  // a malformed/expired payload still leaves storage clean.
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(RESUME_KEY); } catch { /* ignore */ }
  clearResumeIntent();
  if (!raw) return false;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!isResumeIntentPayload(parsed)) return false;

  const age = Date.now() - parsed.iat;
  return age >= 0 && age <= RESUME_TTL_MS;
}

/** Factory — returns store-shaped callbacks + a hydrator.
 *  Callers wire these into the store and invoke hydrate on mount. */
export function createAuthRuntime(): { callbacks: AuthCallbacks; hydrate: () => Promise<AuthState> } {
  const callbacks: AuthCallbacks = {
    onSignIn: (provider, opts) => {
      const resume = Boolean(opts?.resumePublish);
      if (resume) setResumePublishIntent(provider);
      // Only attach the auth-return marker when we actually need to resume —
      // secondary sign-ins (from the top-bar) don't need the query flag.
      beginOAuth(provider, resume);
    },
    onSignOut: async () => {
      // Sign-out is an authoritative user intent — flip the UI to signed-out
      // immediately so the user sees their action take effect, regardless
      // of server outcome. We track whether the request actually succeeded
      // so we can reconcile if it didn't (server cookie still live).
      let serverConfirmed = false;
      try {
        const res = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
        });
        serverConfirmed = res.ok;
        if (!res.ok) {
          console.warn(`[auth] logout returned ${res.status}; will reconcile`);
        }
      } catch (err) {
        console.warn('[auth] logout transport failed; will reconcile:', err);
      }
      useAppStore.getState().setAuthSignedOut();
      // If the server didn't confirm the logout, the cookie may still be
      // valid — schedule a delayed reconciliation hydrate so the chip
      // self-corrects within a few seconds rather than leaving the UI
      // stuck on a false "signed out" state until the next protected
      // action surfaces the divergence.
      if (!serverConfirmed) {
        setTimeout(() => { void hydrateAuthSession(); }, LOGOUT_RECONCILE_DELAY_MS);
      }
    },
  };
  return { callbacks, hydrate: hydrateAuthSession };
}
