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
/** Solve-phase watchdog: budget for `turnstile.execute()` to settle via
 *  one of Cloudflare's callbacks (`callback` / `error-callback` /
 *  `expired-callback`). If no callback fires within this window — for
 *  example when Trusted Types / inline-script CSP rules block the
 *  challenge runtime inside Cloudflare's own iframe — the watchdog
 *  parks the controller at `'challenge-error'` so the UI stops
 *  showing "Preparing…" forever. See
 *  .reports/2026-04-26-turnstile-preparing-stuck-root-cause-bug-report.md.
 *  Cloudflare's challenge typically completes in <5 s; 15 s gives 3×
 *  headroom for slow networks/throttled CPUs without users abandoning. */
export const EXECUTE_TIMEOUT_MS = 15_000;
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
  let executeTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
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
  // Per-solve-attempt nonce. Each `runExecute` invocation captures a
  // fresh value (`thisSolveEpoch`) and writes it into `activeSolveEpoch`;
  // every settling path (callback success, error-callback, watchdog
  // fire, resetToken, disposeWidget, site-key rotation) nulls
  // `activeSolveEpoch`. The watchdog handler closes over its
  // captured `thisSolveEpoch` and checks `activeSolveEpoch ===
  // thisSolveEpoch` so a stale watchdog from a previous attempt
  // cannot mutate state on a fresh attempt. The Cloudflare callbacks
  // (which we register once per render — Cloudflare's API does not
  // allow re-binding callbacks per execute without re-rendering) only
  // check `activeSolveEpoch !== null`; that catches any post-settle
  // late callback (after a watchdog or manual reset). Distinct from
  // `renderEpoch` because solve identity is finer-grained than widget
  // identity.
  let solveEpochCounter = 0;
  let activeSolveEpoch: number | null = null;
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

  const clearExecuteTimeout = (): void => {
    if (executeTimeoutHandle !== null) {
      clearTimeout(executeTimeoutHandle);
      executeTimeoutHandle = null;
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
  // or a follow-up render) settles it OR the solve watchdog fires. The
  // only synchronous clear is when execute itself THROWS — in that
  // case the call never started, so a follow-up runExecute should be
  // allowed.
  const runExecute = (): void => {
    if (executeInFlight) return;
    if (widgetId === null) return;
    const a = getApi();
    if (!a) return;
    executeInFlight = true;
    // Mint a fresh per-attempt epoch. The watchdog captures its own
    // `thisSolveEpoch` and only acts when `activeSolveEpoch` still
    // matches, so a stale watchdog from a prior superseded attempt
    // cannot drive the state machine after a manual retry.
    const thisSolveEpoch = ++solveEpochCounter;
    activeSolveEpoch = thisSolveEpoch;
    try {
      a.execute(widgetId);
    } catch (e) {
      executeInFlight = false;
      activeSolveEpoch = null;
      console.warn('[turnstile-session] execute() threw:', e);
      setState('challenge-error');
      return;
    }
    // Solve watchdog: if no Cloudflare callback settles within
    // EXECUTE_TIMEOUT_MS, park at 'challenge-error' so the UI exits
    // 'preparing'. Captures the current renderEpoch + the per-attempt
    // solve epoch so a stale timer cannot mutate state on a fresh
    // widget (renderEpoch) or a fresh attempt (thisSolveEpoch).
    clearExecuteTimeout();
    const epoch = renderEpoch;
    const id = widgetId;
    executeTimeoutHandle = setTimeout(() => {
      executeTimeoutHandle = null;
      if (epoch !== renderEpoch) return;
      if (activeSolveEpoch !== thisSolveEpoch) return;
      if (!executeInFlight) return;
      console.warn(
        `[turnstile-session] execute() timed out after ${EXECUTE_TIMEOUT_MS}ms — parking at challenge-error`,
      );
      executeInFlight = false;
      activeSolveEpoch = null;
      // Reset the underlying widget so the next deliberate retry
      // (manual user action via QuickShareDestinationPanel's retry
      // button → resetToken + warm) starts from a clean state.
      try { a.reset(id); } catch (e) {
        console.warn('[turnstile-session] reset() inside execute-timeout handler threw:', e);
      }
      setToken(null);
      setState('challenge-error');
    }, EXECUTE_TIMEOUT_MS);
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
          // Drop late callbacks for already-settled solve attempts.
          // Every settling path (watchdog, error-callback parking,
          // resetToken, disposeWidget, site-key rotation) nulls
          // `activeSolveEpoch`, so this single check covers both the
          // post-watchdog window and the post-manual-reset window.
          if (activeSolveEpoch === null) return;
          clearExecuteTimeout();
          solvedAt = Date.now();
          executeInFlight = false;
          activeSolveEpoch = null;
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
          // Same late-callback guard as `callback` above.
          if (activeSolveEpoch === null) return;
          clearExecuteTimeout();
          executeInFlight = false;
          activeSolveEpoch = null;
          setToken(null);
          // Cap retries against a failing Cloudflare endpoint; the
          // user can still re-try manually after parking. Park first
          // (without the side-effect of remount) when the surface is
          // inactive or the cap has been reached so the runtime is
          // quiescent until a deliberate user action.
          if (!surfaceActive || errorRetryCount >= ERROR_RETRY_CAP) {
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
          // Auto-retry on the SAME widget render cannot fully drop
          // late callbacks from this attempt (Cloudflare-bound at
          // render time). Re-render so the next attempt's callbacks
          // close over a fresh `renderEpoch`. If the re-render fails
          // (no reachable mountpoint / no api) park at challenge-
          // error and let the user decide.
          const remounted = remountWidgetForFreshCallbacks('error-retry');
          if (!remounted) {
            setState('challenge-error');
            return;
          }
          // remount left state at 'ready'; the auto-retry's execute
          // is in flight as soon as runExecute runs, so flip the
          // user-visible state to 'preparing' first.
          setState('preparing');
          runExecute();
        },
        'expired-callback': () => {
          if (epoch !== renderEpoch) return;
          clearExecuteTimeout();
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

  /**
   * Tear down the current widget and re-render in place so the next
   * solve attempt's Cloudflare callbacks close over a fresh
   * `renderEpoch`. This is the only reliable way to invalidate stale
   * callbacks from a previous attempt — Cloudflare binds the callback
   * / error-callback / expired-callback closures at `turnstile.render`
   * time and reuses them across executes, so same-render retries
   * cannot fully distinguish stale callbacks from fresh ones.
   *
   * Used by:
   *   - `resetToken()` — the manual retry path triggered by the
   *     panel's "Try verification again" button.
   *   - `error-callback`'s auto-retry branch — the runtime-driven
   *     retry that fires on a Cloudflare-reported challenge error.
   *
   * Returns `true` when a new widget was rendered, `false` otherwise
   * (no current widget, no reachable mountpoint, or no api). The
   * caller is responsible for any post-remount step (e.g. `runExecute`
   * to dispatch the next solve attempt).
   *
   * NOTE: this helper does NOT reset `errorRetryCount` (that is the
   * caller's responsibility — `resetToken` zeroes it; the auto-retry
   * branch increments it before calling here so the cap continues to
   * apply). It also does NOT clear `executeInFlight` /
   * `activeSolveEpoch` (the caller must already have nulled those —
   * both call sites do).
   */
  const remountWidgetForFreshCallbacks = (reason: 'manual-retry' | 'error-retry'): boolean => {
    if (widgetId === null || storedSiteKey === null) return false;
    const mp = hostEl.parentNode instanceof HTMLElement ? hostEl.parentNode : null;
    const keyToReuse = storedSiteKey;
    const a = getApi();
    if (!mp || !a) return false;
    try { a.remove(widgetId); }
    catch (e) {
      console.warn(`[turnstile-session] remove() inside remount (${reason}) threw:`, e);
    }
    widgetId = null;
    storedSiteKey = null;
    renderEpoch++;
    setState('mounting');
    renderWidget(mp, keyToReuse, renderEpoch);
    return widgetId !== null;
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
    // Rotation destroys widget identity, so all solve-phase transient
    // state from the prior widget MUST be cleared — otherwise an
    // in-flight `executeInFlight = true` from the old widget would
    // gate the new widget's `runExecute` early-return, leaving the
    // controller stuck at `'preparing'` for the new widget.
    if (widgetId !== null && storedSiteKey !== null && storedSiteKey !== siteKey) {
      renderEpoch++;
      clearExecuteTimeout();
      executeInFlight = false;
      activeSolveEpoch = null;
      errorRetryCount = 0;
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
    clearExecuteTimeout();
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
    activeSolveEpoch = null;
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
    // Clear the in-flight solve watchdog, drop the active solve-attempt
    // identity, and reset the consecutive-error retry counter so a
    // manual retry (e.g. the panel's "Try verification again" button)
    // starts from a clean budget. Then re-render so the next attempt's
    // callbacks close over a fresh `renderEpoch` — see
    // `remountWidgetForFreshCallbacks` for the rationale.
    clearExecuteTimeout();
    executeInFlight = false;
    activeSolveEpoch = null;
    errorRetryCount = 0;
    setToken(null);
    if (widgetId === null) return;
    const remounted = remountWidgetForFreshCallbacks('manual-retry');
    if (!remounted) {
      // Couldn't re-render synchronously (no reachable mountpoint or
      // no api). Stay at `'challenge-error'` so the panel keeps
      // rendering the retry button and the user can try again once
      // the panel re-mounts (which restores `hostEl.parentNode`).
      // Do NOT null `widgetId` / bump `renderEpoch` here — that would
      // make a follow-up retry click see `widgetId === null` and
      // early-return without doing anything, leaving the user stuck
      // on a "Preparing…" CTA forever.
      console.warn('[turnstile-session] manual-retry remount unavailable (no mountpoint or api); staying at challenge-error');
      setState('challenge-error');
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
