/**
 * Session-scoped Turnstile runtime.
 *
 * Owns Cloudflare Turnstile lifecycle (script load, widget render/remove,
 * token + solved-at timestamp, expiry/refresh scheduling, error state) for
 * the lab's guest Quick Share surfaces. Replaces the panel-local lifecycle
 * that previously lived inside `QuickShareDestinationPanel`.
 *
 * Design notes (see .reports/2026-04-26-turnstile-session-ux-implementation-report.md):
 *   - All mutable state is closure-scoped per controller instance — never
 *     module-level — so test isolation and dispose semantics stay clean.
 *   - The host element is owned imperatively (not by React). The dialog
 *     renders an empty mountpoint slot and the controller reparents its
 *     host into that slot via `ensureMounted`. This lets the same widget
 *     instance + same token survive cascade flips between Share/Trim
 *     guest surfaces.
 *   - `execution: 'execute'` separates mount cost from solve cost. Mount
 *     is cheap; solve fires deliberately via `warm()`.
 *   - Surface-active gating drives proactive refresh and expired-callback
 *     auto-rewarm so a backgrounded dialog doesn't burn cycles or leak
 *     a never-used token.
 */

export type VerificationState =
  | 'idle'
  | 'mounting'
  | 'ready'
  | 'preparing'
  | 'load-failed'
  | 'challenge-error';

export interface TurnstileSessionCallbacks {
  onStateChange: (state: VerificationState) => void;
  onTokenChange: (token: string | null) => void;
}

export interface TurnstileRenderOpts {
  sitekey: string;
  theme?: 'auto' | 'light' | 'dark';
  appearance?: 'always' | 'execute' | 'interaction-only';
  execution?: 'render' | 'execute';
  callback?: (token: string) => void;
  'error-callback'?: () => void;
  'expired-callback'?: () => void;
}

export interface TurnstileApiStub {
  render: (el: HTMLElement, opts: TurnstileRenderOpts) => string;
  remove: (id: string) => void;
  reset: (id: string) => void;
  execute: (id: string) => void;
}

export interface TurnstileSessionController {
  ensureScriptLoaded(): Promise<void>;
  ensureMounted(mountpoint: HTMLElement | null, siteKey: string): Promise<void>;
  disposeWidget(): void;
  warm(): void;
  setQuickShareSurfaceActive(active: boolean): void;
  getToken(): string | null;
  resetToken(): void;
  getState(): VerificationState;
}

const SCRIPT_MARKER_ATTR = 'data-atomdojo-turnstile';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** End-to-end budget from script-injection start to widget-ready callback. */
export const LOAD_TIMEOUT_MS = 10_000;
/** Token expires 5 minutes after solve; refresh at 4 minutes. */
const PROACTIVE_REFRESH_AT_MS = 4 * 60 * 1000;
const REFRESH_POLL_MS = 30 * 1000;
/** Cap on consecutive auto-recovery cycles inside `error-callback` so a
 *  failing Cloudflare endpoint cannot drive the widget into a tight
 *  reset → execute → error retry loop. After this many consecutive
 *  failures the runtime parks at `'challenge-error'` and waits for the
 *  user (or host warm()) to take a deliberate action. A successful
 *  `callback` resets the counter. */
const ERROR_RETRY_CAP = 3;

function readGlobalApi(): TurnstileApiStub | null {
  const api = (globalThis as unknown as { turnstile?: TurnstileApiStub }).turnstile;
  return api ?? null;
}

export function createTurnstileSession(
  cbs: TurnstileSessionCallbacks,
  api?: TurnstileApiStub,
): TurnstileSessionController {
  // ── Closure-scoped instance state — see §"State scope" in the plan. ─
  let widgetId: string | null = null;
  let storedSiteKey: string | null = null;
  let token: string | null = null;
  let solvedAt: number | null = null;
  let state: VerificationState = 'idle';
  let surfaceActive = false;
  let scriptPromise: Promise<void> | null = null;
  let loadTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let refreshIntervalHandle: ReturnType<typeof setInterval> | null = null;
  let executeInFlight = false;
  let errorRetryCount = 0;
  // Monotonic per-render token. Bumped by `disposeWidget` and by the
  // start of each `ensureMounted` site-key rotation. The render
  // closure captures its own value and ignores Cloudflare callbacks
  // (callback / error-callback / expired-callback) that fire after a
  // newer render has superseded it. This is the per-instance equivalent
  // of the prior `cancelled` flag in the panel-local effect.
  let renderEpoch = 0;
  // Separate epoch for the mount REQUEST itself. Bumped by every
  // `ensureMounted` call, including null detaches. Used to invalidate
  // an in-flight `await ensureScriptLoaded()` continuation when a
  // newer mount request (or a detach) has superseded it. Keeping
  // this distinct from `renderEpoch` is essential — detaching the
  // host MUST NOT silence callbacks from a still-alive widget.
  let mountRequestEpoch = 0;

  // The host element is created once and reparented across mountpoints.
  // It is NEVER rendered by React — see §B "Visible Host" in the plan.
  // The runtime is browser-only by design; no SSR fallback.
  const hostEl: HTMLDivElement = document.createElement('div');
  hostEl.setAttribute('data-turnstile-host', '');

  const setState = (next: VerificationState): void => {
    if (state === next) return;
    state = next;
    cbs.onStateChange(next);
  };

  const setToken = (next: string | null): void => {
    if (token === next) return;
    token = next;
    if (next === null) solvedAt = null;
    cbs.onTokenChange(next);
  };

  const clearLoadTimeout = (): void => {
    if (loadTimeoutHandle !== null) {
      clearTimeout(loadTimeoutHandle);
      loadTimeoutHandle = null;
    }
  };

  const ensureRefreshInterval = (): void => {
    if (refreshIntervalHandle !== null) return;
    refreshIntervalHandle = setInterval(() => {
      if (!surfaceActive) return;
      if (!token || !solvedAt) return;
      if (Date.now() - solvedAt < PROACTIVE_REFRESH_AT_MS) return;
      runExecute();
    }, REFRESH_POLL_MS);
  };

  const stopRefreshInterval = (): void => {
    if (refreshIntervalHandle !== null) {
      clearInterval(refreshIntervalHandle);
      refreshIntervalHandle = null;
    }
  };

  const getApi = (): TurnstileApiStub | null => api ?? readGlobalApi();

  // `executeInFlight` stays true from the moment we dispatch
  // `a.execute()` until a Cloudflare callback (callback, error-callback,
  // or a follow-up render) settles it. The only synchronous clear is
  // when execute itself THROWS — in that case the call never started,
  // so a follow-up runExecute should be allowed.
  const runExecute = (): void => {
    if (executeInFlight) return;
    if (widgetId === null) return;
    const a = getApi();
    if (!a) return;
    executeInFlight = true;
    try {
      a.execute(widgetId);
    } catch (e) {
      executeInFlight = false;
      console.warn('[turnstile-session] execute() threw:', e);
      setState('challenge-error');
    }
  };

  const installScriptIfMissing = (): void => {
    const existing = document.querySelector(`script[${SCRIPT_MARKER_ATTR}]`);
    if (existing) return;
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.defer = true;
    el.setAttribute(SCRIPT_MARKER_ATTR, '1');
    document.head.appendChild(el);
  };

  const ensureScriptLoaded = (): Promise<void> => {
    if (api) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise<void>((resolve, reject) => {
      installScriptIfMissing();
      const el = document.querySelector(
        `script[${SCRIPT_MARKER_ATTR}]`,
      ) as HTMLScriptElement | null;
      if (!el) {
        reject(new Error('turnstile-session: failed to install script'));
        return;
      }
      if (readGlobalApi()) { resolve(); return; }
      const onLoad = (): void => {
        el.removeEventListener('error', onError);
        resolve();
      };
      const onError = (): void => {
        el.removeEventListener('load', onLoad);
        reject(new Error('turnstile-session: script element fired error'));
      };
      el.addEventListener('load', onLoad, { once: true });
      el.addEventListener('error', onError, { once: true });
    });
    // Reset cached promise on rejection so retries can re-attempt the
    // load. The `load-failed` state still sticks until disposeWidget so
    // the UX surface stays consistent. Log once per failure so support
    // can distinguish "Cloudflare slow" from "script blocked".
    scriptPromise.catch((e) => {
      console.warn('[turnstile-session] script load rejected:', e);
      scriptPromise = null;
    });
    return scriptPromise;
  };

  const renderWidget = (mountpoint: HTMLElement, siteKey: string, epoch: number): void => {
    const a = getApi();
    if (!a) return;
    if (hostEl.parentNode !== mountpoint) {
      mountpoint.appendChild(hostEl);
    }
    const theme: 'auto' | 'light' | 'dark' =
      document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    try {
      const id = a.render(hostEl, {
        sitekey: siteKey,
        theme,
        appearance: 'interaction-only',
        execution: 'execute',
        callback: (tok: string) => {
          if (epoch !== renderEpoch) return;
          solvedAt = Date.now();
          executeInFlight = false;
          // A successful solve closes any active recovery loop — reset
          // the consecutive-error counter so a future error-callback
          // gets the full retry budget again.
          errorRetryCount = 0;
          setToken(tok);
          setState('ready');
          ensureRefreshInterval();
        },
        'error-callback': () => {
          if (epoch !== renderEpoch) return;
          executeInFlight = false;
          setToken(null);
          // Cloudflare leaves the widget in an unrecoverable state
          // after error-callback until reset. A failing endpoint can
          // drive a tight reset → execute → error loop, so cap retries
          // at ERROR_RETRY_CAP and surface the non-recoverable surface
          // when the cap is hit. If the inner reset() itself throws,
          // the widget is genuinely unrecoverable — log and park.
          let resetOk = true;
          try { a.reset(id); } catch (e) {
            resetOk = false;
            console.warn('[turnstile-session] reset() inside error-callback threw:', e);
          }
          if (!resetOk || !surfaceActive || errorRetryCount >= ERROR_RETRY_CAP) {
            if (errorRetryCount >= ERROR_RETRY_CAP) {
              console.warn(
                `[turnstile-session] challenge retry cap reached (${ERROR_RETRY_CAP}); parking at challenge-error`,
              );
            }
            setState('challenge-error');
            return;
          }
          errorRetryCount += 1;
          console.warn(
            `[turnstile-session] challenge errored — auto-retrying (attempt ${errorRetryCount}/${ERROR_RETRY_CAP})`,
          );
          setState('preparing');
          runExecute();
        },
        'expired-callback': () => {
          if (epoch !== renderEpoch) return;
          setToken(null);
          if (surfaceActive) {
            setState('preparing');
            runExecute();
          } else {
            setState('ready');
          }
        },
      });
      widgetId = id;
      storedSiteKey = siteKey;
      clearLoadTimeout();
      setState('ready');
    } catch (e) {
      console.warn('[turnstile-session] turnstile.render threw:', e);
      setState('load-failed');
    }
  };

  const ensureMounted = async (
    mountpoint: HTMLElement | null,
    siteKey: string,
  ): Promise<void> => {
    // Every call advances the mount-request epoch. An in-flight prior
    // call's continuation will compare its captured epoch to this one
    // after `await ensureScriptLoaded()` and abort if superseded.
    const mountEpoch = ++mountRequestEpoch;

    // Site-key rotation: an existing widget rendered with a different
    // key must be torn down so the next solve binds to the new key.
    if (widgetId !== null && storedSiteKey !== null && storedSiteKey !== siteKey) {
      renderEpoch++;
      const a = getApi();
      if (a) {
        try { a.remove(widgetId); }
        catch (e) {
          console.warn('[turnstile-session] remove() during site-key rotation threw:', e);
        }
      }
      widgetId = null;
      storedSiteKey = null;
      setToken(null);
      setState('mounting');
    }

    // No mountpoint reachable — keep the widget alive but unparented.
    // Bumping `mountRequestEpoch` above already invalidates any prior
    // pending mount continuation. If we were still in 'mounting' with
    // no widget yet (the user switched away mid-load), reset to 'idle'
    // so the next mount starts cleanly.
    if (mountpoint === null) {
      if (hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
      if (widgetId === null && state === 'mounting') {
        clearLoadTimeout();
        setState('idle');
      }
      return;
    }

    // Idempotent reparent if the widget already exists on the same key.
    if (widgetId !== null && storedSiteKey === siteKey) {
      if (hostEl.parentNode !== mountpoint) {
        mountpoint.appendChild(hostEl);
      }
      return;
    }

    setState('mounting');

    // Each fresh mount attempt advances the render epoch so callbacks
    // from a prior superseded render attempt are silently dropped.
    const epoch = ++renderEpoch;

    // 10 s end-to-end watchdog: if neither script-load nor render
    // resolves to a widget id, surface 'load-failed' so the UI stops
    // showing "Preparing…" forever.
    clearLoadTimeout();
    loadTimeoutHandle = setTimeout(() => {
      if (epoch !== renderEpoch) return;
      if (mountEpoch !== mountRequestEpoch) return;
      if (widgetId !== null) return;
      console.warn('[turnstile-session] widget failed to load within timeout');
      setState('load-failed');
    }, LOAD_TIMEOUT_MS);

    if (hostEl.parentNode !== mountpoint) {
      mountpoint.appendChild(hostEl);
    }

    try {
      await ensureScriptLoaded();
    } catch {
      if (mountEpoch !== mountRequestEpoch) return;
      if (epoch !== renderEpoch) return;
      clearLoadTimeout();
      setState('load-failed');
      return;
    }
    // After awaiting, drop the result if a newer ensureMounted call
    // (including a null-detach) has superseded this one. This is the
    // load-bearing check for the "user switches away mid-load → stale
    // async render into a detached mountpoint" failure mode.
    if (mountEpoch !== mountRequestEpoch) return;
    if (epoch !== renderEpoch) return;
    if (widgetId !== null && storedSiteKey === siteKey) {
      // A concurrent caller already rendered while we awaited the
      // script. Idempotent path.
      clearLoadTimeout();
      return;
    }
    renderWidget(mountpoint, siteKey, epoch);
  };

  const disposeWidget = (): void => {
    // Tear down the live widget but keep the controller usable — the
    // dialog can be reopened in the same page session and the next
    // `ensureMounted` should mount a fresh widget. Bumping the render
    // epoch silences any in-flight script-load tail or Cloudflare
    // callbacks scheduled before this call. All transient state
    // (surface-active flag, retry counter, in-flight execute) is
    // reset so a re-open starts from a clean slate.
    renderEpoch++;
    clearLoadTimeout();
    stopRefreshInterval();
    if (widgetId !== null) {
      const a = getApi();
      if (a) {
        try { a.remove(widgetId); }
        catch (e) {
          console.warn('[turnstile-session] remove() during disposeWidget threw:', e);
        }
      }
    }
    widgetId = null;
    storedSiteKey = null;
    if (hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    setToken(null);
    executeInFlight = false;
    surfaceActive = false;
    errorRetryCount = 0;
    setState('idle');
  };

  const warm = (): void => {
    if (widgetId === null) return;
    if (token !== null && solvedAt !== null
        && Date.now() - solvedAt < PROACTIVE_REFRESH_AT_MS) {
      // Live token still well within TTL — nothing to do.
      return;
    }
    setState('preparing');
    runExecute();
  };

  const setQuickShareSurfaceActive = (active: boolean): void => {
    if (surfaceActive === active) return;
    surfaceActive = active;
    if (active) {
      ensureRefreshInterval();
    } else {
      stopRefreshInterval();
    }
    // Note: the runtime does NOT call execute() on a flag transition.
    // The host (TimelineBar) is responsible for calling `warm()` when
    // it wants a re-solve — that keeps surface-active a pure flag
    // rather than an action trigger and makes the expired-callback
    // path the single point where the runtime issues an auto-rewarm.
  };

  const getToken = (): string | null => token;

  const resetToken = (): void => {
    setToken(null);
    if (widgetId !== null) {
      const a = getApi();
      if (a) {
        try { a.reset(widgetId); }
        catch (e) {
          console.warn('[turnstile-session] reset() inside resetToken threw:', e);
        }
      }
    }
  };

  const getState = (): VerificationState => state;

  return {
    ensureScriptLoaded,
    ensureMounted,
    disposeWidget,
    warm,
    setQuickShareSurfaceActive,
    getToken,
    resetToken,
    getState,
  };
}
