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

/** Thrown by the publish fetch when the server returned 428 Precondition
 *  Required — the authenticated user has no `age_13_plus` acceptance row.
 *  The Transfer dialog catches this the same way it catches
 *  AuthRequiredError and surfaces the inline publish-clickwrap fallback
 *  (single Publish button; clicking IS the consent). The
 *  `policyVersion` is preserved so the legacy-remediation call can
 *  record the server's current policy version. */
export class AgeConfirmationRequiredError extends Error {
  readonly kind = 'age-confirmation-required' as const;
  readonly policyVersion: string | null;
  constructor(message = 'Age confirmation required', policyVersion: string | null = null) {
    super(message);
    this.name = 'AgeConfirmationRequiredError';
    this.policyVersion = policyVersion;
  }
}

/** Shapes returned by GET /api/auth/session. The endpoint always returns
 *  200 with a status discriminator; we branch on that field instead of
 *  HTTP status so "signed out" doesn't appear as a red network error in
 *  devtools for every Lab page load.
 *
 *  `publicConfig` is optional in the wire type for forward/backward
 *  compatibility: older server builds won't emit it, and a newer server
 *  sending extra fields must not break the Lab. When missing we fall
 *  back to the default "guest publish disabled" config so the UI
 *  continues to show only the OAuth path. */
type SessionPayload =
  | {
      status: 'signed-in';
      userId: string;
      displayName: string | null;
      createdAt?: string;
      publicConfig?: SessionPublicConfig;
    }
  | { status: 'signed-out'; publicConfig?: SessionPublicConfig };

export interface SessionPublicConfig {
  guestPublish: {
    enabled: boolean;
    turnstileSiteKey: string | null;
  };
}

export const DEFAULT_PUBLIC_CONFIG: SessionPublicConfig = {
  guestPublish: { enabled: false, turnstileSiteKey: null },
};

function isSessionPublicConfig(v: unknown): v is SessionPublicConfig {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const gp = r.guestPublish as Record<string, unknown> | undefined;
  if (!gp || typeof gp !== 'object') return false;
  return (
    typeof gp.enabled === 'boolean'
    && (gp.turnstileSiteKey === null || typeof gp.turnstileSiteKey === 'string')
  );
}

function isSessionPayload(v: unknown): v is SessionPayload {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  // publicConfig is optional — when present we type-guard it; when
  // absent the server is on an older build or the field was trimmed.
  if (r.publicConfig !== undefined && !isSessionPublicConfig(r.publicConfig)) {
    return false;
  }
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

  // `publicConfig` is a state-discovery payload — apply it on every
  // successful session response, regardless of signed-in/out branch, so
  // the Lab picks up a flag flip without waiting for a sign-in state
  // change. Missing (older server) → keep whatever the store already
  // has, which is initialized to the "disabled" default at boot.
  if (payload.publicConfig && isLatest()) {
    useAppStore.getState().setPublicConfig(payload.publicConfig);
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

/** Open the popup shell synchronously inside the click handler. Returns
 *  the live Window or null when the browser blocked the open. The
 *  caller MUST navigate the popup (via `navigatePopupTo`) or close it
 *  (via `closePopupShell`) — leaking a blank popup is a UX bug.
 *
 *  Writes a minimal same-origin loading document immediately so the
 *  user doesn't see a scary blank window while the age-intent fetch
 *  is in flight. The doc.write is best-effort: if a browser blocks it
 *  (e.g. some embedded webviews), the popup still opens and the
 *  navigation kicks in once the fetch resolves — the user just sees
 *  the default blank state for the fetch duration. */
function openOAuthPopupShell(): Window | null {
  if (isViteDevHost()) {
    console.warn(
      `[auth] OAuth popup skipped — running on Vite dev host (${window.location.origin}). ` +
      'Run `npm run cf:dev` (wrangler pages dev on :8788) to exercise the popup flow.',
    );
    return null;
  }
  let popup: Window | null = null;
  try {
    popup = window.open('', 'atomdojo-auth', POPUP_FEATURES);
  } catch {
    return null;
  }
  if (!popup) return null;
  // Focus is best-effort — some browsers auto-focus the popup, others don't.
  try { popup.focus(); } catch { /* ignore */ }
  // Best-effort interim content. Same-origin so document.write is
  // permitted; if a webview blocks it the popup just stays blank for
  // the ~50-500 ms fetch window.
  try {
    popup.document.write(
      '<!doctype html>' +
      '<title>Starting sign-in\u2026</title>' +
      '<style>body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#333;padding:24px;text-align:center}</style>' +
      '<p>Starting sign-in\u2026</p>',
    );
    popup.document.close();
  } catch { /* ignore */ }
  return popup;
}

/** Best-effort failure message in the popup before close. Used so a
 *  fetch-failure isn't silent if the popup stole focus from the Lab. */
function showFailureInPopup(popup: Window): void {
  try {
    popup.document.open();
    popup.document.write(
      '<!doctype html>' +
      '<title>Sign-in failed</title>' +
      '<style>body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#333;padding:24px;text-align:center}</style>' +
      '<p>Sign-in could not start. Please return to the previous tab and try again.</p>',
    );
    popup.document.close();
  } catch { /* ignore */ }
}

/** Idempotent cleanup — safe to call on a popup that's already
 *  navigated away or already closed. */
function closePopupShell(popup: Window | null): void {
  if (!popup) return;
  try { popup.close(); } catch { /* ignore */ }
}

/** Navigate an already-opened shell to the OAuth start URL. */
function navigatePopupTo(popup: Window, provider: 'google' | 'github', ageIntent: string): void {
  const startPath = provider === 'google' ? '/auth/google/start' : '/auth/github/start';
  const params = new URLSearchParams({ returnTo: '/auth/popup-complete', ageIntent });
  popup.location.href = `${startPath}?${params.toString()}`;
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

/** Just-in-time age-intent fetch. The endpoint is unauthenticated and
 *  not user-bound — its sole purpose is to prove that the entity
 *  hitting `/auth/{provider}/start` crossed the clickwrap UI in a
 *  real browser context. Durable user-binding happens at the OAuth
 *  callback. `same-origin` is the right credential mode (consistent
 *  with the rest of Lab's same-origin fetches); `include` would
 *  falsely imply the call relies on session cookies.
 *
 *  Throws an `AgeIntentFetchError` on every failure mode so callers
 *  can map to a stable user-visible message via `messageForFetchError`. */
class AgeIntentFetchError extends Error {
  readonly kind = 'age-intent-fetch' as const;
  readonly mode: 'network' | 'server-5xx' | 'server-4xx' | 'rate-limited' | 'invalid-body';
  /** Seconds to wait before retrying, parsed from the server's
   *  `Retry-After` header on 429 responses. Only meaningful when
   *  `mode === 'rate-limited'`; `null` when the header is missing,
   *  malformed, or the mode is something else. */
  readonly retryAfterSeconds: number | null;
  constructor(mode: AgeIntentFetchError['mode'], message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'AgeIntentFetchError';
    this.mode = mode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Parse `Retry-After` as a non-negative integer number of seconds.
 *  Spec allows an HTTP-date too, but our own server only ever emits
 *  a delta-seconds integer; anything else is treated as "unknown"
 *  (null). Contract: accept ONLY a clean `^\d+$` whole-string decimal
 *  value within safe-integer range. Partial garbage (e.g. `60abc`)
 *  and fractional values (`1.5`) both fall through to null so the
 *  caller can render the generic "a moment" message. */
function parseRetryAfterSeconds(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/** Distinct from a fetch failure — the user closed the popup window
 *  while the JIT intent fetch was still in flight. Caught after the
 *  fetch resolves; `navigatePopupTo` would otherwise throw
 *  cross-origin / invalid-access on a closed window, and the generic
 *  fetch-error message would mis-tell the user "could not start"
 *  when in fact the start was abandoned by their own click. */
class PopupClosedDuringFetchError extends Error {
  readonly kind = 'popup-closed-during-fetch' as const;
  constructor() {
    super('Sign-in popup was closed before the request finished.');
    this.name = 'PopupClosedDuringFetchError';
  }
}

async function fetchAgeIntent(): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/account/age-confirmation/intent', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (err) {
    throw new AgeIntentFetchError('network', `network: ${(err as Error).message}`);
  }
  if (res.status >= 500) {
    throw new AgeIntentFetchError('server-5xx', `server ${res.status}`);
  }
  // 429 Too Many Requests is the app-level rate limiter on the intent
  // endpoint (per-isolate per-IP cap; see intent.ts). Surface it as a
  // distinct mode so the UI can render a temporary-wait message with
  // the server's retry hint, not the generic "not available here"
  // copy that the other 4xx branches use.
  if (res.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get('Retry-After'));
    throw new AgeIntentFetchError(
      'rate-limited',
      `rate limited (retry-after ${retryAfterSeconds ?? 'unknown'})`,
      retryAfterSeconds,
    );
  }
  if (!res.ok) {
    throw new AgeIntentFetchError('server-4xx', `server ${res.status}`);
  }
  let body: { ageIntent?: unknown };
  try {
    body = await res.json();
  } catch (err) {
    throw new AgeIntentFetchError('invalid-body', `body parse: ${(err as Error).message}`);
  }
  if (!body || typeof body.ageIntent !== 'string') {
    throw new AgeIntentFetchError('invalid-body', 'ageIntent missing in response');
  }
  return body.ageIntent;
}

/** Format a Retry-After seconds value as a short human phrase. 60 →
 *  "about 1 minute", 120 → "about 2 minutes", 30 → "about 30 seconds".
 *  Returns "a moment" when the value is missing. */
function formatRetryWait(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'a moment';
  if (seconds < 60) return `about ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
}

/** User-facing message keyed off the fetch-failure taxonomy. */
function messageForFetchError(err: unknown): string {
  if (err instanceof PopupClosedDuringFetchError) {
    return 'Sign-in window was closed. Click Continue with Google or GitHub to try again.';
  }
  if (err instanceof AgeIntentFetchError) {
    switch (err.mode) {
      case 'network':       return 'Sign-in unavailable — check your connection and retry.';
      case 'server-5xx':    return 'Sign-in temporarily unavailable. Please try again.';
      case 'rate-limited':  return `Too many sign-in attempts. Please wait ${formatRetryWait(err.retryAfterSeconds)} and try again.`;
      case 'server-4xx':    return 'Sign-in isn\u2019t available here.';
      case 'invalid-body':  return 'Sign-in returned an unexpected response. Please try again.';
    }
  }
  return 'Could not start sign-in. Please try again.';
}

/** Commit the destructive same-tab redirect. Only called when the user
 *  has explicitly opted in via the popup-blocked prompt — we never
 *  degrade to this path automatically. Lab's in-memory state is lost on
 *  the redirect; the boot-time resume handshake (`?authReturn=1` +
 *  sessionStorage intent) recovers the Transfer dialog + Share tab.
 *  Secondary sign-ins (top-bar) pass withAuthMarker=false so a returning
 *  page load won't auto-open the Transfer dialog unexpectedly.
 *
 *  Same-tab is allowed to await before navigation — `location.assign`
 *  doesn't require user-gesture qualification the way `window.open`
 *  does, so the JIT fetch is safe to run synchronously here. */
function beginOAuthSameTab(
  provider: 'google' | 'github',
  withAuthMarker: boolean,
  ageIntent: string,
): void {
  const startPath = provider === 'google' ? '/auth/google/start' : '/auth/github/start';
  const returnTo = withAuthMarker ? '/lab/?authReturn=1' : '/lab/';
  const params = new URLSearchParams({ returnTo, ageIntent });
  const url = `${startPath}?${params.toString()}`;
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
  // Monotonic attempt id. Any async branch captures this at the moment
  // it is scheduled and checks `attemptId === currentAttemptId` before
  // committing side effects. A new attempt bumps the id, which strands
  // any in-flight branch from an older attempt so it can't flip the
  // store into a 'failed' state or navigate the popup after a newer
  // attempt has already started. See `latestAttempt()` below.
  let currentAttemptId = 0;
  const latestAttempt = () => currentAttemptId;

  const callbacks: AuthCallbacks = {
    onSignIn: (provider, opts) => {
      const resume = Boolean(opts?.resumePublish);
      const store = useAppStore.getState();

      // Runtime-level critical section (P1 audit fix). The UI disables
      // provider buttons while `authSignInAttempt.status === 'starting'`,
      // but UI disabling is advisory: rapid double-clicks, keyboard
      // activation, or a second visible surface can still race before
      // React re-renders. Guard at the owner of the side effect so the
      // invariant (one live sign-in attempt per runtime) holds even if
      // the UI layer regresses.
      if (store.authSignInAttempt?.status === 'starting') return;

      // Bump the attempt id AFTER the idle check — any in-flight branch
      // from a prior attempt is now stranded by id comparison below.
      const attemptId = ++currentAttemptId;

      // Clear any prior popup-blocked prompt before attempting — if the
      // popup opens this turn, the stale prompt must not linger.
      store.setAuthPopupBlocked(null);
      // Mark the attempt as starting so React UIs can disable provider
      // buttons immediately. Cleared on every terminal branch below.
      store.setAuthSignInAttempt({ provider, resumePublish: resume, status: 'starting', message: null });

      // CRITICAL: open the popup shell SYNCHRONOUSLY before any await.
      // `window.open` requires a live user gesture; awaiting fetchAgeIntent
      // before this line would let the browser strip the gesture
      // qualification and trigger popup blockers — re-introducing the
      // exact problem this shell-first refactor was added to prevent.
      const popup = openOAuthPopupShell();
      if (!popup) {
        // Popup-blocked descriptor takes over. Do NOT write the resume
        // sentinel here — see "Resume-sentinel timing contract" in the
        // plan. Sentinel writes happen only at the navigation site.
        store.setAuthSignInAttempt(null);
        store.setAuthPopupBlocked({ provider, resumePublish: resume });
        return;
      }
      // Now we're free to go async — the popup is already open.
      void (async () => {
        try {
          const ageIntent = await fetchAgeIntent();
          // Stranded-attempt check. If a NEWER onSignIn has run while
          // we awaited, do not touch the store or the popup — the new
          // attempt owns both. Close this (now-orphaned) popup quietly
          // so we don't leak a blank window.
          if (attemptId !== latestAttempt()) {
            closePopupShell(popup);
            return;
          }
          // The user may have closed the popup while the fetch was in
          // flight. `popup.location.href = …` on a closed window throws
          // cross-origin / invalid-access in most browsers, and the
          // generic catch below would mis-attribute that as a fetch
          // failure. Detect explicitly so the UI can show "Sign-in
          // window was closed" instead of "could not start sign-in."
          if (popup.closed) throw new PopupClosedDuringFetchError();
          // Sentinel timing: write only after fetch success, immediately
          // before navigation. This closes the failure window where a
          // pre-fetch sentinel write could orphan into a later unrelated
          // sign-in's auto-Share-open.
          if (resume) setResumePublishIntent(provider);
          navigatePopupTo(popup, provider, ageIntent);
          useAppStore.getState().setAuthSignInAttempt(null);
        } catch (err) {
          // Stranded-attempt check on the failure branch — same rationale
          // as the success branch: a newer attempt owns the store state.
          if (attemptId !== latestAttempt()) {
            closePopupShell(popup);
            return;
          }
          // Defensive: clear any prior sentinel so a stale one from an
          // earlier attempt cannot leak past this failure.
          clearResumeIntent();
          // Only attempt the popup failure write + close when the popup
          // is still open — calling document.write/close on a closed
          // window is wasted noise (and the user already saw the popup
          // disappear when they closed it themselves).
          if (!popup.closed) {
            showFailureInPopup(popup);
            closePopupShell(popup);
          }
          useAppStore.getState().setAuthSignInAttempt({
            provider, resumePublish: resume, status: 'failed',
            message: messageForFetchError(err),
          });
        }
      })();
    },
    onSignInSameTab: () => {
      // User explicitly consented to the destructive redirect from the
      // popup-blocked prompt. Read the pending descriptor, clear it,
      // then fetch a fresh intent and navigate. `location.assign` does
      // not require user-gesture qualification, so awaiting before
      // navigation is safe here (unlike the popup path).
      const store = useAppStore.getState();
      // Same critical section as onSignIn above — refuse to start if an
      // attempt is already in flight (e.g. user clicks Continue-in-tab
      // repeatedly while the fetch is in flight).
      if (store.authSignInAttempt?.status === 'starting') return;
      const pending = store.authPopupBlocked;
      if (!pending) return;
      const attemptId = ++currentAttemptId;
      store.setAuthPopupBlocked(null);
      const provider = pending.provider;
      const resume = pending.resumePublish;
      store.setAuthSignInAttempt({ provider, resumePublish: resume, status: 'starting', message: null });
      void (async () => {
        try {
          const ageIntent = await fetchAgeIntent();
          // Stranded-attempt check — a newer onSignIn/onSignInSameTab
          // may have started while we awaited.
          if (attemptId !== latestAttempt()) return;
          // Sentinel timing: write only after fetch success, immediately
          // before navigation (see plan §3 "Resume-sentinel timing contract").
          if (resume) setResumePublishIntent(provider);
          beginOAuthSameTab(provider, resume, ageIntent);
          // No setAuthSignInAttempt(null) here — location.assign tears
          // down the page, the cleared state would never reach the user.
        } catch (err) {
          if (attemptId !== latestAttempt()) return;
          clearResumeIntent();
          useAppStore.getState().setAuthSignInAttempt({
            provider, resumePublish: resume, status: 'failed',
            message: messageForFetchError(err),
          });
        }
      })();
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
