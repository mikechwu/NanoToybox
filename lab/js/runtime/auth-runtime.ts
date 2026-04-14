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
 *   signed-in   → server returned 200 with `{ status: 'signed-in', ... }`
 *   signed-out  → server returned 200 with `{ status: 'signed-out' }`
 *                 (authoritative — see contract below; 401 is reserved
 *                 for protected-action endpoints, not state discovery)
 *   unverified  → transport / 5xx / malformed response AND no prior session
 *                 to preserve. UI must show a neutral "can't verify"
 *                 affordance — NOT an OAuth prompt. Treating a transport
 *                 blip as signed-out would mislead users whose cookie is
 *                 still valid server-side.
 *
 * Transition policy for hydrateAuthSession():
 *
 *   | Outcome                         | Prior state       | Next state   |
 *   |---------------------------------|-------------------|--------------|
 *   | 200 status=signed-in + shape OK | any               | signed-in    |
 *   | 200 status=signed-out           | any               | signed-out   |
 *   | network / 5xx / malformed       | loading           | unverified   |
 *   | network / 5xx / malformed       | any other         | (keep prior) |
 *
 * The endpoint /api/auth/session always returns 200; the server carries a
 * JSON `status` discriminator rather than signalling signed-out via HTTP
 * 401. This keeps a routine state probe out of the browser's red-network
 * noise and reserves 401 for protected-action endpoints (e.g. publish).
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

/** Shapes returned by GET /api/auth/session. The endpoint always returns
 *  200 with a status discriminator; we branch on that field instead of
 *  HTTP status so "signed out" doesn't appear as a red network error in
 *  devtools for every Lab page load. */
type SessionPayload =
  | { status: 'signed-in'; userId: string; displayName: string | null; createdAt?: string }
  | { status: 'signed-out' };

function isSessionPayload(v: unknown): v is SessionPayload {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.status === 'signed-out') return true;
  return (
    r.status === 'signed-in'
    && typeof r.userId === 'string'
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
      // Defense-in-depth against stale reads across popup-login / logout
      // transitions. The server also sets `Cache-Control: no-store, private`
      // + `Vary: Cookie` — this client-side flag forbids the browser from
      // satisfying the request from its own cache before the network hit.
      cache: 'no-store',
    });
  } catch (err) {
    // Transport failure — could not even reach the server. Distinct from
    // a malformed body (caught below), so logs and tests can tell them apart.
    return resolveIndeterminate(`transport failed: ${(err as Error).message}`);
  }

  // 401 on this endpoint is no longer expected — the server returns 200
  // with a status discriminator for both signed-in and signed-out. Any
  // non-ok status here is a real server/proxy error, not a state answer.
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

  if (payload.status === 'signed-out') {
    // Authoritative signed-out answer from the server. Only commit if we
    // are still the latest hydrate — a later authoritative write must win.
    if (isLatest()) useAppStore.getState().setAuthSignedOut();
    else return snapshotAuth();
    return { status: 'signed-out', session: null };
  }

  // signed-in
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

/** Popup window features — sized to fit a provider consent screen without
 *  covering the whole viewport. `noopener`/`noreferrer` are deliberately
 *  NOT set: we need `window.opener` in the popup so it can postMessage
 *  back when the callback completes. The popup and opener are same-origin
 *  (we only ever open `/auth/{provider}/start` on our own domain), so the
 *  opener-reference exposure is not a risk. */
const POPUP_FEATURES = 'popup,width=520,height=680,noopener=no,noreferrer=no';

/** Expected message shape from `/auth/popup-complete`. */
interface AuthCompleteMessage {
  type: 'atomdojo-auth-complete';
}

function isAuthCompleteMessage(v: unknown): v is AuthCompleteMessage {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'atomdojo-auth-complete';
}

/** Open a popup for the OAuth flow. Returns true on success, false if the
 *  browser blocked or otherwise refused the open. On a false return the
 *  caller does NOT auto-navigate — it surfaces the block to the user via
 *  the store so they can explicitly retry or consent to the same-tab
 *  (destructive) redirect. Every attempt is fresh: there is no sticky
 *  "popup blocker active" hint that suppresses later attempts. */
function tryOpenAuthPopup(startUrl: string): boolean {
  let popup: Window | null = null;
  try {
    popup = window.open(startUrl, 'atomdojo-auth', POPUP_FEATURES);
  } catch {
    popup = null;
  }
  if (!popup) return false;
  // Focus is best-effort — some browsers auto-focus the popup, others don't.
  try { popup.focus(); } catch { /* ignore */ }
  return true;
}

/** True when the current host looks like a Vite dev server (i.e. plain
 *  HTTP on a port other than `wrangler pages dev`'s 8788). In this mode,
 *  `/auth/{provider}/start` isn't served — a popup would load a
 *  404/SPA-index and sit forever. We surface the block via the popup-
 *  blocked UX instead so at least the user sees a diagnostic rather than
 *  a hung popup.
 *
 *  The check uses protocol + port (not `import.meta.env.DEV`) so it
 *  works identically under vitest and under a real Vite dev server:
 *    - Production (https://atomdojo.pages.dev, port "")         → false
 *    - Wrangler pages dev (http://localhost:8788)                → false
 *    - Vite dev (http://localhost:5173 and friends)              → true */
function isViteDevHost(): boolean {
  try {
    if (window.location.protocol !== 'http:') return false;
    return window.location.port !== '8788';
  } catch {
    return false;
  }
}

/** Attach a window `message` listener (and a same-origin BroadcastChannel
 *  listener, if the API is available) that handles the popup-complete
 *  handshake. Idempotent: repeated calls are no-ops. Returns a stable
 *  detach reference that truly removes the live listener — all callers
 *  receive the same reference, so a secondary caller's teardown genuinely
 *  cleans up state rather than being a silent no-op.
 *
 *  Production wires this once at Lab boot. Tests call
 *  `_resetAuthRuntimeForTest()` in `afterEach` to guarantee no handler
 *  leaks across cases. */
let messageHandler: ((event: MessageEvent) => void) | null = null;
let broadcastChannel: BroadcastChannel | null = null;

/** Stable detach callback — production never needs this (the listener
 *  lives for the Lab's lifetime), but tests and dev-mode HMR do. */
export function detachAuthCompleteListener(): void {
  if (messageHandler) {
    try { window.removeEventListener('message', messageHandler); } catch { /* ignore */ }
    messageHandler = null;
  }
  if (broadcastChannel) {
    try { broadcastChannel.close(); } catch { /* ignore */ }
    broadcastChannel = null;
  }
}

export function attachAuthCompleteListener(): () => void {
  if (messageHandler) return detachAuthCompleteListener;
  const handler = (event: MessageEvent) => {
    // Accept only same-origin messages. A malicious cross-origin opener
    // cannot forge this because postMessage delivery is origin-scoped and
    // we also gate on the message shape. Cross-origin drops are logged in
    // dev so a misconfigured local setup (Vite 5173 vs wrangler 8788) is
    // diagnosable from the console instead of silently dropped.
    if (event.origin !== window.location.origin) {
      if (isViteDevHost() && isAuthCompleteMessage(event.data)) {
        console.warn(
          `[auth] dropping auth-complete message from unexpected origin ${event.origin} ` +
          `(expected ${window.location.origin}); are Lab and popup on different dev ports?`,
        );
      }
      return;
    }
    if (!isAuthCompleteMessage(event.data)) return;
    // Defensive .catch keeps any future regression inside handleAuthComplete
    // (store setter throw, sessionStorage entry-point throw before the
    // function's internal try/catch) out of the unhandled-rejection bucket.
    handleAuthComplete().catch((err) => {
      console.error('[auth] popup-complete handler failed:', err);
    });
  };
  window.addEventListener('message', handler);
  messageHandler = handler;

  // BroadcastChannel fallback: when a Cross-Origin-Opener-Policy response
  // anywhere in the provider → callback → popup-complete chain severs
  // `window.opener`, the postMessage silently fails to deliver. The
  // popup also broadcasts to a same-origin BroadcastChannel so this tab
  // still picks up the completion. BroadcastChannel is same-origin by
  // definition, so the security envelope is unchanged.
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      broadcastChannel = new BroadcastChannel('atomdojo-auth');
      broadcastChannel.addEventListener('message', (event) => {
        if (!isAuthCompleteMessage(event.data)) return;
        handleAuthComplete().catch((err) => {
          console.error('[auth] popup-complete handler failed (broadcast):', err);
        });
      });
    }
  } catch {
    // Older browsers without BroadcastChannel degrade gracefully to the
    // postMessage-only path; the opener-severance case becomes a known
    // dead-end that the popup-complete page surfaces in its DOM.
  }

  return detachAuthCompleteListener;
}

/** Test-only reset hook. Truly removes the live listener (unlike the
 *  earlier version which only flipped a flag and left the registration
 *  dangling — which could leak handlers across test cases and produce
 *  duplicate fires under HMR). */
export function _resetAuthRuntimeForTest(): void {
  detachAuthCompleteListener();
}

/** Called when the popup reports completion. Re-hydrates the session and,
 *  if a resume-publish intent is live and the session landed signed-in,
 *  requests the Share tab open. The sessionStorage sentinel is consumed
 *  here — the same-tab `?authReturn=1` code path remains as a fallback
 *  for popup-blocker cases and uses a different consume helper. */
async function handleAuthComplete(): Promise<void> {
  let resumeWanted = false;
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isResumeIntentPayload(parsed)) {
        const age = Date.now() - parsed.iat;
        if (age >= 0 && age <= RESUME_TTL_MS) resumeWanted = true;
      }
    }
  } catch { /* ignore — resume falls through to no-op */ }
  clearResumeIntent();
  const state = await hydrateAuthSession();
  if (resumeWanted && state.status === 'signed-in') {
    useAppStore.getState().requestShareTabOpen();
  }
}

/** Try the popup path. Returns true if the popup opened; false when
 *  blocked (caller is expected to surface the block to the user rather
 *  than silently same-tab-navigate).
 *
 *  Dev-mode guard: when the Lab is running on a Vite dev host (not
 *  `wrangler pages dev` on 8788), `/auth/{provider}/start` isn't served
 *  — the popup would load a 404/SPA-index and hang. We return false
 *  (same as "blocked") so the user sees the popup-blocked UX with a
 *  Continue-in-tab option instead of a silently-broken popup. A
 *  single-line console warning tells the developer why. */
function tryBeginOAuthPopup(provider: 'google' | 'github'): boolean {
  if (isViteDevHost()) {
    console.warn(
      `[auth] OAuth popup skipped — running on Vite dev host (${window.location.origin}). ` +
      'Run `npm run cf:dev` (wrangler pages dev on :8788) to exercise the popup flow.',
    );
    return false;
  }
  const startPath = provider === 'google' ? '/auth/google/start' : '/auth/github/start';
  // Popup always uses the popup-complete landing as its returnTo — the
  // popup doesn't reload the Lab, so no `?authReturn=1` handshake.
  const popupReturnTo = '/auth/popup-complete';
  const popupUrl = `${startPath}?returnTo=${encodeURIComponent(popupReturnTo)}`;
  return tryOpenAuthPopup(popupUrl);
}

/** Commit the destructive same-tab redirect. Only called when the user
 *  has explicitly opted in via the popup-blocked prompt — we never
 *  degrade to this path automatically. Lab's in-memory state is lost on
 *  the redirect; the boot-time resume handshake (`?authReturn=1` +
 *  sessionStorage intent) recovers the Transfer dialog + Share tab.
 *  Secondary sign-ins (top-bar) pass withAuthMarker=false so a returning
 *  page load won't auto-open the Transfer dialog unexpectedly. */
function beginOAuthSameTab(provider: 'google' | 'github', withAuthMarker: boolean): void {
  const startPath = provider === 'google' ? '/auth/google/start' : '/auth/github/start';
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
      // Clear any prior popup-blocked prompt before attempting — if the
      // popup opens this turn, the stale prompt must not linger.
      useAppStore.getState().setAuthPopupBlocked(null);
      // Set the resume intent BEFORE any navigation attempt so both the
      // popup-complete handshake and the same-tab handshake see it.
      if (resume) setResumePublishIntent(provider);
      if (tryBeginOAuthPopup(provider)) return;
      // Popup blocked — do NOT silently navigate. Surface the block via
      // the store so the UI can offer an explicit Retry / Continue-in-tab
      // choice. The pending descriptor preserves the original `resume`
      // choice so the same-tab commit uses the right `authReturn` marker.
      useAppStore.getState().setAuthPopupBlocked({ provider, resumePublish: resume });
    },
    onSignInSameTab: () => {
      // User explicitly consented to the destructive redirect from the
      // popup-blocked prompt. Read the pending descriptor, clear it,
      // then navigate. If nothing is pending (stale click, concurrent
      // cancel), no-op rather than randomly navigating.
      const pending = useAppStore.getState().authPopupBlocked;
      if (!pending) return;
      useAppStore.getState().setAuthPopupBlocked(null);
      beginOAuthSameTab(pending.provider, pending.resumePublish);
    },
    onDismissPopupBlocked: () => {
      // User backed out of the popup-blocked prompt. Clear the pending
      // descriptor — and if the abandoned flow was a publish-initiated
      // sign-in (resumePublish:true), also clear the sessionStorage
      // resume-publish sentinel. Otherwise a later unrelated sign-in
      // (e.g. top-bar) would see the still-fresh sentinel in its popup-
      // complete handshake and auto-open Share unexpectedly.
      const pending = useAppStore.getState().authPopupBlocked;
      useAppStore.getState().setAuthPopupBlocked(null);
      if (pending?.resumePublish) {
        clearResumeIntent();
        // Verify the clear actually took effect — sessionStorage.removeItem
        // can throw silently in some private-browsing modes (Safari ITP
        // lockdown, third-party storage partitioning). If the sentinel
        // persists, a later unrelated sign-in will still auto-open Share,
        // so surface the divergence as a structured error for bug reports.
        try {
          if (sessionStorage.getItem(RESUME_KEY) !== null) {
            console.error(
              '[auth] resume-intent sentinel persists after clear — ' +
              'a later sign-in may spuriously auto-open the Share tab',
            );
          }
        } catch {
          // getItem itself threw — storage is unreadable, so whether the
          // sentinel persists is unobservable. No user-visible leak
          // because the subsequent handleAuthComplete will also fail the
          // same getItem and treat resumeWanted as false.
        }
      }
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
