/**
 * Account page — laboratory-editorial redesign.
 *
 * Single-file React page so the account route has no cross-dependency
 * on the Lab store. Fetches `/api/account/me` and `/api/account/capsules`
 * on mount; renders four sections:
 *
 *   01 · Profile        → identity card + sign out
 *   02 · Uploads        → cursor-paginated list, copy-link / open / delete
 *   03 · Privacy & Data → delete-all (with cap-hit Continue), delete-account
 *   04 · Support        → policy links
 *
 * Deletion flows call the corresponding /api/account/* endpoints; each
 * destructive action uses an inline confirmation surface (typed
 * "DELETE ACCOUNT" for account-wide deletion).
 *
 * Layout: asymmetric grid with a sticky section rail (desktop) /
 * scrollable nav (mobile). Every state hook, callback, endpoint, and
 * data-testid from the previous revision is preserved — the rewrite
 * is markup + presentation, not behaviour.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PreviewThumbV1 } from '../src/share/capsule-preview-scene-store';
import { ACCOUNT_THUMB_SIZE } from '../src/share/capsule-preview-thumb-size';
import { CurrentThumbSvg } from '../src/share/capsule-preview-current-thumb';

interface AccountMe {
  userId: string;
  displayName: string | null;
  createdAt: string;
  provider: string | null;
  ageConfirmedAt: string | null;
  policyVersion: string | null;
}

interface CapsuleSummary {
  shareCode: string;
  createdAt: string;
  sizeBytes: number;
  frameCount: number;
  atomCount: number;
  title: string | null;
  kind: string;
  status: string;
  previewStatus: string;
  /** V2 compact preview payload — atoms-only, ≤ ROW_ATOM_CAP atoms.
   *  Null when the row has no usable scene (pre-V2 rows not yet backfilled,
   *  kind ≠ 'capsule', etc.) — the client renders {@link PlaceholderThumb}. */
  previewThumb: PreviewThumbV1 | null;
}

interface CapsulesPage {
  capsules: CapsuleSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Share codes the server has nominated for background preview rebake
   *  this request. Optional so older clients reading newer responses
   *  (or vice versa) degrade cleanly. The account page renders a
   *  shimmer overlay on these rows and, on page 1 only, schedules an
   *  8 s follow-up refresh so the shimmer clears once the rebake lands.
   *
   *  See ADR D135 follow-up (2026-04-21) in `docs/decisions.md`. */
  previewPending?: string[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      me: AccountMe;
      capsules: CapsuleSummary[];
      hasMore: boolean;
      nextCursor: string | null;
    };

// ── Scheduler seam (injectable for tests) ──────────────────────────
//
// `scheduleRefreshIn` delegates here instead of calling `setTimeout`
// directly so AccountApp-level tests can swap in a deterministic
// scheduler (e.g., trigger-on-demand) without monkey-patching
// `window.setTimeout` per test. Production inlines `setTimeout`.
//
// The override shape returns a cancel function so the caller can
// tear down pending callbacks. Tests using
// {@link setAccountSchedulerOverride} must restore the default
// (pass `null`) in an `afterEach` — otherwise the override leaks
// into later tests' boots.

type AccountScheduler = (fn: () => void, ms: number) => () => void;

const defaultScheduler: AccountScheduler = (fn, ms) => {
  const handle = window.setTimeout(fn, ms);
  return () => window.clearTimeout(handle);
};

let accountScheduler: AccountScheduler = defaultScheduler;

/** Test-only hook. Replace the scheduler used by
 *  {@link AccountApp}'s 8 s follow-up path (via `scheduleRefreshIn`).
 *  Pass `null` to restore the default `setTimeout`-based scheduler.
 *
 *  Callers MUST restore in an `afterEach` — the override is module
 *  state and leaks into subsequent tests in the same run if left
 *  installed. Production code never calls this. */
export function setAccountSchedulerOverride(
  override: AccountScheduler | null,
): void {
  accountScheduler = override ?? defaultScheduler;
}

// ── Formatting helpers ──────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ── Capsule preview thumbnail (V2 — frame-projected atoms) ─────────────────
//
// V2 contract (spec §Account Integration §5, D138 cluster-selection,
// D138 follow-up path-batched renderer): the component consumes the
// `previewThumb: PreviewThumbV1` payload from the account API verbatim
// — no client-side projection, no downsampling. Server is the single
// point of downsampling on the read path (AC #26).
//
// Two regimes, now backed by the path-batched `CurrentThumbSvg`:
//   - ATOMS-ONLY: up to ROW_ATOM_CAP_ATOMS_ONLY (18) atom glyphs,
//     rendered as one or more batched `<path>` elements grouped by
//     `(color, effectiveRadius)`. Chosen when the source scene has no
//     storage bonds, isn't dense enough, or when the derivation's
//     visibility filter rejected too many bonds.
//   - BONDS-AWARE: up to ROW_ATOM_CAP_WITH_BONDS (24) atom glyphs +
//     up to ROW_BOND_CAP (24) bonds, rendered as two stacked batched
//     bond `<path>` elements (black border under, white fill on top)
//     plus the atom paths. Paint order is bonds-border → bonds-fill
//     → atoms. Only chosen when the server confirms at least
//     MIN_ACCEPTABLE_BONDS bonds survive visibility filtering.
//
// DOM cost is O(unique (color, radius) pairs + 2 bond passes), NOT
// O(atoms + bonds), so raising the caps from 12/6 to 24/24 did NOT
// cost a bigger DOM budget. The old ≤20 element budget is retired.
//
// Visual constants (atom radius, bond stroke widths, style preset)
// live in `src/share/capsule-preview-thumb-render.ts` +
// `capsule-preview-current-thumb.tsx` — the same modules the server-
// side visibility filter reads from, so the "bond visible after
// subtracting endpoint radii" calculation stays correct.
//
// Decorative: aria-hidden="true" — the row's code/title text is the
// authoritative label.

// `.acct__upload-thumb` in public/account-layout.css mirrors
// ACCOUNT_THUMB_SIZE (CSS can't import from TS). Update the TS
// constant and the CSS rule together.
const THUMB_SIZE = ACCOUNT_THUMB_SIZE;

export function CapsulePreviewThumb({
  thumb,
}: {
  thumb: PreviewThumbV1;
}): React.ReactElement {
  // Thin shim over the shared `CurrentThumbSvg`. The SVG body lives in
  // `src/share/capsule-preview-current-thumb` so the audit workbench
  // renders against byte-identical production output. Radius and stroke
  // constants still come from `capsule-preview-thumb-render` (inside
  // the shared module) so the server-side visibility filter stays in
  // lockstep with the rendered geometry.
  //
  // DOM cost under the path-batched renderer is O(1) in atom/bond
  // count: svg + rect + 2 bond paths (border + fill) + K atom paths
  // (K = unique (color, radius) groups, typically 1).
  return (
    <CurrentThumbSvg
      thumb={thumb}
      size={THUMB_SIZE}
      className="acct__upload-thumb"
    />
  );
}

/** Row-thumb shell. Owns the wrapper `<div>` that carries the grid
 *  slot, the shimmer overlay (when the server is rebaking this row's
 *  preview scene), and the inner thumb/placeholder. The inner SVG keeps
 *  its own `.acct__upload-thumb` class — the shell is purely a layout
 *  and animation host. See ADR D135 follow-up (`docs/decisions.md`). */
export function UploadThumbShell({
  thumb,
  shareCode,
  pending,
}: {
  thumb: PreviewThumbV1 | null;
  shareCode: string;
  pending: boolean;
}): React.ReactElement {
  const className = pending
    ? 'acct__upload-thumb-shell acct__upload-thumb-shell--pending'
    : 'acct__upload-thumb-shell';
  return (
    <div className={className} data-share-code={shareCode} aria-hidden="true">
      {thumb ? <CapsulePreviewThumb thumb={thumb} /> : <PlaceholderThumb />}
    </div>
  );
}

/** Neutral placeholder thumb for rows without a usable preview scene
 *  (pre-V2 rows not yet backfilled, kind ≠ 'capsule', etc.). 3
 *  elements total; visually quiet so the CSS grid track does not
 *  collapse. */
export function PlaceholderThumb(): React.ReactElement {
  return (
    <svg
      className="acct__upload-thumb"
      width={THUMB_SIZE}
      height={THUMB_SIZE}
      viewBox="0 0 100 100"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x={0} y={0} width={100} height={100} rx={12}
        fill="currentColor" fillOpacity={0.10}
      />
      <circle cx={50} cy={50} r={4} fill="currentColor" fillOpacity={0.30} />
    </svg>
  );
}

function monogramOf(me: AccountMe): string {
  const src = me.displayName?.trim() || me.userId;
  return (src[0] ?? '·').toUpperCase();
}

// ── Data ────────────────────────────────────────────────────────────

/** Shared capsule-list fetcher — used by `loadAll`, `refreshCapsules`,
 *  `doRefresh`, and `loadMoreCapsules`. Throws on non-ok responses so
 *  each caller decides how to reconcile (the error surface varies:
 *  `loadAll` maps 401 → signed-out; `doRefresh` silently retries;
 *  `refreshCapsules` returns null on failure). */
async function fetchCapsulesPageShared(
  cursor: string | null,
  signal: AbortSignal | undefined,
): Promise<CapsulesPage> {
  const url = new URL('/api/account/capsules', window.location.origin);
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await fetch(url.toString(), { credentials: 'include', signal });
  if (!res.ok) throw new Error(`capsules: ${res.status}`);
  return (await res.json()) as CapsulesPage;
}

interface LoadAllResult {
  state: LoadState;
  capsulesPage: CapsulesPage | null;
}

async function loadAll(signal: AbortSignal | undefined): Promise<LoadAllResult> {
  try {
    const [meRes, capRes] = await Promise.all([
      fetch('/api/account/me', { credentials: 'include', signal }),
      fetch('/api/account/capsules', { credentials: 'include', signal }),
    ]);
    if (meRes.status === 401) return { state: { status: 'signed-out' }, capsulesPage: null };
    if (!meRes.ok) return { state: { status: 'error', message: `me: ${meRes.status}` }, capsulesPage: null };
    if (!capRes.ok) return { state: { status: 'error', message: `capsules: ${capRes.status}` }, capsulesPage: null };
    const me = (await meRes.json()) as AccountMe;
    const capsData = (await capRes.json()) as CapsulesPage;
    return {
      state: {
        status: 'ready',
        me,
        capsules: capsData.capsules,
        hasMore: capsData.hasMore ?? false,
        nextCursor: capsData.nextCursor ?? null,
      },
      capsulesPage: capsData,
    };
  } catch (err) {
    return {
      state: { status: 'error', message: err instanceof Error ? err.message : String(err) },
      capsulesPage: null,
    };
  }
}

async function loadMoreCapsules(cursor: string): Promise<CapsulesPage> {
  return fetchCapsulesPageShared(cursor, undefined);
}

// ── Shared chrome ───────────────────────────────────────────────────

function TopBar() {
  return (
    <header className="acct__topbar">
      <a href="/lab/" className="acct__wordmark" aria-label="Back to Lab">atomdojo</a>
      <div className="acct__crumbs"><span>Account</span></div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="acct__footer">
      <span>© atomdojo</span>
      <span><a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a></span>
    </footer>
  );
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div role="status" aria-live="polite" className="acct__toast">
      <span>{text}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss notice">×</button>
    </div>
  );
}

// ── State views ─────────────────────────────────────────────────────

function LoadingView() {
  return (
    <>
      <TopBar />
      <main className="acct__shell" aria-busy="true">
        <div className="acct__state">
          <p className="acct__state-mark">Loading account…</p>
        </div>
      </main>
    </>
  );
}

function SignedOutView() {
  return (
    <>
      <TopBar />
      <main className="acct__shell">
        <div className="acct__state">
          <h1>Sign in required</h1>
          <p>Account management is only available when signed in. Head back to Lab to continue.</p>
          <p>
            <a className="acct-btn acct-btn--accent" href="/lab/">Go to Lab</a>
          </p>
        </div>
        <Footer />
      </main>
    </>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <>
      <TopBar />
      <main className="acct__shell">
        <div className="acct__state">
          <h1>Could not load account</h1>
          <p>{message}</p>
          <p>
            <button type="button" onClick={onRetry} className="acct-btn">Retry</button>
          </p>
        </div>
        <Footer />
      </main>
    </>
  );
}

// ── Section rail ────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'uploads', label: 'Uploads' },
  { id: 'privacy', label: 'Privacy & Data' },
  { id: 'support', label: 'Support' },
] as const;

function Rail({ active }: { active: string }) {
  return (
    <nav className="acct__rail" aria-label="Account sections">
      <ul className="acct__rail-list">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="acct__rail-link"
              aria-current={active === s.id ? 'true' : undefined}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ── Main app ────────────────────────────────────────────────────────

function AccountApp() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [deletingCode, setDeletingCode] = useState<string | null>(null);
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [batchCapHit, setBatchCapHit] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleteAccountConfirm, setDeleteAccountConfirm] = useState('');
  const [banner, setBanner] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>('profile');

  // ── Lazy-rebake feedback loop refs (ADR D135 follow-up) ─────────────
  //
  // `pendingShareCodes` drives the shimmer overlay on rows whose
  // preview scene the server is rebaking in the background. Populated
  // from `CapsulesPage.previewPending`, cleared either by a follow-up
  // refresh that returns an empty `previewPending`, by `onLoadMore`
  // (pagination supersedes the page-1 convergence loop), or by
  // `reload()` (new session of work).
  //
  // The refs model invariants the `LoadState` discriminated union can't
  // express: reload sequence guard (latest reload wins), in-flight
  // refresh controller (new refresh aborts the prior), visibility
  // hidden-since timestamp (30 s threshold), pagination-mode latch
  // (`hasLoadedMoreRef` — once true, auto-refresh is suppressed so a
  // timer-driven page-1 fetch can't collapse the user's loaded page 2),
  // and `doRefreshRef` (breaks the scheduleRefreshIn → doRefresh hook
  // cycle; see D6 in `.reports/…__plan.md`).
  const [pendingShareCodes, setPendingShareCodes] = useState<Set<string>>(new Set());
  const refreshInFlightRef = useRef<AbortController | null>(null);
  const visibilityHiddenSinceRef = useRef<number | null>(null);
  const hasLoadedMoreRef = useRef(false);
  const reloadSeqRef = useRef(0);
  const reloadAbortRef = useRef<AbortController | null>(null);
  const doRefreshRef = useRef<() => void>(() => {});

  const refreshTimerCancelRef = useRef<(() => void) | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerCancelRef.current !== null) {
      refreshTimerCancelRef.current();
      refreshTimerCancelRef.current = null;
    }
  }, []);

  // scheduleRefreshIn reads through `doRefreshRef` instead of closing
  // over `doRefresh` directly — that's what breaks the hook cycle
  // (scheduleRefreshIn → doRefresh → applyCapsulesPage → scheduleRefreshIn).
  // Routes through the injectable `accountScheduler` module seam so
  // tests can drive the follow-up path deterministically via
  // `setAccountSchedulerOverride` instead of monkey-patching
  // `window.setTimeout` in each test.
  const scheduleRefreshIn = useCallback((ms: number) => {
    clearRefreshTimer();
    refreshTimerCancelRef.current = accountScheduler(() => {
      refreshTimerCancelRef.current = null;
      doRefreshRef.current();
    }, ms);
  }, [clearRefreshTimer]);

  /** Pure state update — commits a fresh `CapsulesPage` into `ready`
   *  state and syncs `pendingShareCodes` from `previewPending`. Returns
   *  the pending count so callers decide whether to reschedule the 8 s
   *  follow-up loop. No refresh scheduling happens here — keeping this
   *  pure is what lets the hook dependency graph stay acyclic. */
  const applyCapsulesPage = useCallback((data: CapsulesPage): number => {
    setState(prev =>
      prev.status === 'ready'
        ? {
            ...prev,
            capsules: data.capsules,
            hasMore: data.hasMore ?? false,
            nextCursor: data.nextCursor ?? null,
          }
        : prev,
    );
    const pending = new Set(data.previewPending ?? []);
    setPendingShareCodes(pending);
    return pending.size;
  }, []);

  /** The ONLY transition in/out of `'loading'`. Sequence-guarded via
   *  `reloadSeqRef` so a slow prior load cannot overwrite a newer
   *  reload with stale data. Also resets the pagination latch — a
   *  reload is a fresh session in every respect. */
  const reload = useCallback(() => {
    const seq = ++reloadSeqRef.current;
    clearRefreshTimer();
    refreshInFlightRef.current?.abort();
    reloadAbortRef.current?.abort();
    const ctrl = new AbortController();
    reloadAbortRef.current = ctrl;
    hasLoadedMoreRef.current = false;
    setPendingShareCodes(new Set());
    setState({ status: 'loading' });
    void loadAll(ctrl.signal).then(({ state: next, capsulesPage }) => {
      // Stale-response guard: only the LATEST reload commits. Without
      // this, two fast Retry clicks could land in reversed order and
      // show the older error state.
      if (reloadSeqRef.current !== seq) return;
      setState(next);
      if (next.status === 'ready' && capsulesPage) {
        const pending = new Set(capsulesPage.previewPending ?? []);
        setPendingShareCodes(pending);
        if (pending.size > 0) scheduleRefreshIn(8_000);
      }
    });
  }, [clearRefreshTimer, scheduleRefreshIn]);

  /** Capsules-only refresh — awaitable, stays in the `ready` state.
   *  Returns the refreshed capsule list, or null on failure.
   *  Used by post-delete reconciliation so the page doesn't flash
   *  to the global loading screen.
   *
   *  Pagination: intentionally resets to page 1 (no cursor). After a
   *  destructive operation the server-side ordering may have shifted,
   *  and stale cursors can produce gaps or duplicates. Accepting the
   *  reset-to-page-1 tradeoff is the simplest correct behavior. We
   *  also clear `hasLoadedMoreRef` here — post-delete the user is back
   *  on page 1, so auto-refresh convergence is valid again. */
  const refreshCapsules = useCallback(async (): Promise<CapsuleSummary[] | null> => {
    try {
      const data = await fetchCapsulesPageShared(null, undefined);
      hasLoadedMoreRef.current = false;
      const pendingCount = applyCapsulesPage(data);
      // Restart the 8 s follow-up loop when the refreshed page carries
      // pending rebakes. Without this, post-delete convergence silently
      // drops: the response knows about a pending rebake but nothing
      // arms the timer to chase it.
      if (pendingCount > 0) scheduleRefreshIn(8_000);
      return data.capsules;
    } catch (err) {
      console.error('[account] capsule refresh failed:', err);
      return null;
    }
  }, [applyCapsulesPage, scheduleRefreshIn]);

  /** Background page-1 refresh — the 8 s timer and the visibility
   *  listener both route through here. Ready-only AND first-page-only:
   *  once `onLoadMore()` has fired, `hasLoadedMoreRef` is true and any
   *  further auto-refresh is suppressed, since a timer-driven page-1
   *  refetch would wipe the user's loaded page 2/3. */
  const doRefresh = useCallback(async () => {
    if (state.status !== 'ready') return;
    if (hasLoadedMoreRef.current) return;
    refreshInFlightRef.current?.abort();
    const ctrl = new AbortController();
    refreshInFlightRef.current = ctrl;
    try {
      const data = await fetchCapsulesPageShared(null, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const pendingCount = applyCapsulesPage(data);
      if (pendingCount > 0) scheduleRefreshIn(8_000);
    } catch (err) {
      if (!ctrl.signal.aborted) {
        console.warn(
          `[account] refresh-failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      if (refreshInFlightRef.current === ctrl) refreshInFlightRef.current = null;
    }
  }, [state.status, applyCapsulesPage, scheduleRefreshIn]);

  // Keep `doRefreshRef` synced so `scheduleRefreshIn` can call the
  // latest `doRefresh` without closing over it directly. This is the
  // load-bearing effect that severs the hook dependency cycle.
  useEffect(() => {
    doRefreshRef.current = doRefresh;
  }, [doRefresh]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Visibility trigger — same first-page + ready gate as `doRefresh`
  // (enforced inside `doRefresh`, so we just call through). Fires when
  // the tab has been hidden for ≥ 30 s and becomes visible again, so a
  // user returning to a long-lived tab sees freshly-rebaked rows.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        visibilityHiddenSinceRef.current = Date.now();
        return;
      }
      const hiddenSince = visibilityHiddenSinceRef.current;
      visibilityHiddenSinceRef.current = null;
      if (hiddenSince !== null && Date.now() - hiddenSince >= 30_000) {
        doRefreshRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Unmount cleanup — cancel timers and outstanding fetches so tests
  // (and any future SPA navigation) don't leak requests past unmount.
  useEffect(() => () => {
    clearRefreshTimer();
    refreshInFlightRef.current?.abort();
    reloadAbortRef.current?.abort();
  }, [clearRefreshTimer]);

  useEffect(() => {
    if (!banner) return;
    const handle = window.setTimeout(() => setBanner(null), 5000);
    return () => window.clearTimeout(handle);
  }, [banner]);

  // Scroll-spy for the section rail. Uses IntersectionObserver against
  // the section anchors; the most-visible section becomes active. The
  // typeof guard keeps jsdom (no IntersectionObserver) happy in unit
  // tests — degrades to a fixed active section, which is harmless.
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (typeof IntersectionObserver === 'undefined') return;
    const targets = SECTIONS
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActiveSection(visible.target.id);
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [state.status]);

  const onDeleteCapsule = useCallback(
    async (code: string) => {
      setDeletingCode(code);
      try {
        let httpOk = false;
        let httpStatus = 0;
        try {
          const res = await fetch(`/api/account/capsules/${code}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          httpOk = res.ok;
          httpStatus = res.status;
        } catch (err) {
          // Network error (offline, CORS, DNS). httpOk stays false
          // and the downstream reconciliation branch drives the
          // user-visible banner. Log so ops can distinguish
          // "browser couldn't reach the endpoint" from "endpoint
          // returned a server error" — both land in the same UX
          // fork but have very different root causes.
          console.warn(`[account] delete-request-threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Reconcile: refresh capsules list (stays in ready state).
        const refreshed = await refreshCapsules();
        const rowGone = refreshed ? !refreshed.some(c => c.shareCode === code) : null;

        const statusLabel = httpStatus > 0 ? String(httpStatus) : 'network error';
        if (rowGone === null && httpOk) {
          setBanner('Delete request succeeded, but the list could not be refreshed. Please reload to confirm.');
        } else if (rowGone === null && !httpOk) {
          setBanner(`Delete failed (${statusLabel}). The list could not be refreshed.`);
        } else if (httpOk && rowGone) {
          setBanner(`Deleted ${code}.`);
        } else if (!httpOk && rowGone) {
          setBanner('Delete may have completed despite a server error.');
        } else if (!httpOk && !rowGone) {
          setBanner(`Delete failed (${statusLabel}).`);
        } else {
          setBanner('Delete reported success but the capsule is still listed.');
        }
      } finally {
        setDeletingCode(null);
      }
    },
    [refreshCapsules],
  );

  const onDeleteAll = useCallback(async () => {
    setBulkDeleting(true);
    let succeededTotal = 0;
    let failedTotal = 0;
    let attemptedTotal = 0;
    let batchIndex = 0;
    let exitReason: 'drained' | 'cap-hit' | 'http-error' = 'drained';
    try {
      const MAX_BATCHES = 100;
      while (batchIndex < MAX_BATCHES) {
        batchIndex++;
        setBanner(
          batchIndex === 1
            ? 'Deleting uploads…'
            : `Deleting uploads… batch ${batchIndex}, ${succeededTotal} removed so far`,
        );
        const res = await fetch('/api/account/capsules/delete-all', {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          exitReason = 'http-error';
          // Reconcile on HTTP error before showing failure.
          await refreshCapsules();
          setBanner(`Bulk delete failed at batch ${batchIndex} (${res.status}).`);
          return;
        }
        const data = (await res.json()) as {
          totalAttempted: number;
          succeeded: number;
          failed: unknown[];
          moreAvailable?: boolean;
        };
        attemptedTotal += data.totalAttempted;
        succeededTotal += data.succeeded;
        failedTotal += data.failed.length;
        // Per-batch reconciliation on failures.
        if (data.failed.length > 0) {
          await refreshCapsules();
        }
        if (!data.moreAvailable) {
          exitReason = 'drained';
          break;
        }
        if (batchIndex >= MAX_BATCHES) {
          exitReason = 'cap-hit';
        }
      }

      // Terminal reconciliation — derive banner from refresh state.
      const terminalRefresh = await refreshCapsules();
      const remainingCount = terminalRefresh?.length ?? null;

      if (exitReason === 'cap-hit') {
        setBatchCapHit(true);
        setBanner(
          `Deleted ${succeededTotal} uploads so far` +
            (failedTotal > 0 ? ` (${failedTotal} failed)` : '') +
            '. More uploads remain — choose "Continue deleting" to remove the rest.',
        );
        return;
      }

      setBatchCapHit(false);
      if (terminalRefresh === null) {
        // Refresh failed — fall back to counts, note the gap.
        setBanner(
          `Deleted ${succeededTotal} of ${attemptedTotal}` +
            (failedTotal > 0 ? `; ${failedTotal} failed` : '') +
            '. The list could not be refreshed — please reload to confirm.',
        );
      } else if (failedTotal > 0 && remainingCount === 0) {
        setBanner(
          `Deleted ${succeededTotal} uploads. Some cleanup reported errors, but the list has been refreshed.`,
        );
      } else if (failedTotal > 0) {
        setBanner(
          `Deleted ${succeededTotal} uploads. ${failedTotal} could not be deleted.`,
        );
      } else {
        setBanner(`Deleted ${succeededTotal} uploads.`);
      }
    } catch (err) {
      console.error('[account] bulk delete error:', err);
      setBanner('Bulk delete encountered an unexpected error. Please reload.');
    } finally {
      setBulkDeleting(false);
      if (exitReason !== 'cap-hit') setDeleteAllConfirm(false);
    }
  }, [refreshCapsules]);

  const onDeleteAccount = useCallback(async () => {
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setBanner(`Account delete failed (${res.status}).`);
      } else {
        window.location.href = '/';
      }
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onLoadMore = useCallback(async () => {
    if (state.status !== 'ready' || !state.nextCursor) return;
    const cursor = state.nextCursor;
    // Latch auto-refresh OFF at click time, not after the page-2
    // response lands. The user has expressed pagination intent — any
    // subsequent timer or visibility refresh must be suppressed
    // starting NOW, because `doRefresh` only consults
    // `hasLoadedMoreRef` at the START of the function. Without this,
    // a 8 s timer that fires during the page-2 request window still
    // sees the latch as `false`, kicks off a page-1 refetch, and its
    // `applyCapsulesPage` later collapses the paginated list.
    //
    // If the page-2 fetch ultimately fails, we restore the latch so
    // the user is back in the page-1 regime with auto-refresh
    // re-armed (otherwise a failed Load more would silently disable
    // convergence for the rest of the session).
    hasLoadedMoreRef.current = true;
    clearRefreshTimer();
    refreshInFlightRef.current?.abort();
    const previousPending = pendingShareCodes;
    setPendingShareCodes(new Set());
    setLoadingMore(true);
    try {
      const next = await loadMoreCapsules(cursor);
      setState((prev) => {
        if (prev.status !== 'ready') return prev;
        return {
          ...prev,
          capsules: [...prev.capsules, ...next.capsules],
          hasMore: next.hasMore,
          nextCursor: next.nextCursor,
        };
      });
    } catch (err) {
      // Pagination failed — user is still on page 1. Restore the
      // first-page regime so auto-refresh and the shimmer overlay
      // resume their normal behavior.
      hasLoadedMoreRef.current = false;
      setPendingShareCodes(previousPending);
      if (previousPending.size > 0) scheduleRefreshIn(8_000);
      setBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [state, clearRefreshTimer, pendingShareCodes, scheduleRefreshIn]);

  const onSignOut = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        console.warn(`[account] logout returned ${res.status}; cookie may persist on next load`);
      }
    } catch (err) {
      // Network failure: redirect anyway so the UX completes, but
      // surface to ops + devtools so an outage isn't silent.
      console.warn(
        `[account] logout failed; cookie may persist: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    window.location.href = '/lab/';
  }, []);

  const copyTimerRef = useRef<number | null>(null);
  const onCopyLink = useCallback((shareCode: string) => {
    const url = `${window.location.origin}/c/${shareCode}`;
    const writer = navigator.clipboard?.writeText(url);
    if (!writer) {
      // Either `navigator.clipboard` is absent (`?.` short-circuited
      // to `undefined`) or a polyfill returned a non-Promise value.
      // The Clipboard API spec mandates a Promise return, so this
      // branch is only reachable in unusual environments — log so
      // ops can correlate if a new browser variant ships a broken
      // polyfill.
      console.warn('[account] clipboard-unavailable: writeText did not return a Promise');
      setBanner('Could not copy link — clipboard API unavailable.');
      return;
    }
    writer.then(
      () => {
        setCopiedCode(shareCode);
        setBanner('Link copied to clipboard.');
        if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopiedCode(null), 1500);
      },
      (err: unknown) => {
        // Permission denied, insecure context, or user gesture
        // required — surface so the user doesn't see a false
        // "copied" confirmation. The console.warn gives ops an
        // actionable signal (browser variant, not a server bug).
        console.warn(`[account] clipboard-write-failed: ${err instanceof Error ? err.message : String(err)}`);
        setBanner('Could not copy link — your browser blocked clipboard access.');
      },
    );
  }, []);

  const ageStatus = useMemo(() => {
    if (state.status !== 'ready') return null;
    return state.me.ageConfirmedAt
      ? { label: '13+ confirmed', value: formatDate(state.me.ageConfirmedAt) }
      : { label: '13+ confirmation', value: 'pending' };
  }, [state]);

  if (state.status === 'loading') return <LoadingView />;
  if (state.status === 'signed-out') return <SignedOutView />;
  if (state.status === 'error') return <ErrorView message={state.message} onRetry={reload} />;

  const { me, capsules, hasMore } = state;

  return (
    <>
      <TopBar />
      {banner ? <Toast text={banner} onClose={() => setBanner(null)} /> : null}

      <main className="acct__shell">
        {/* Header — the user's name IS the title. Provider + join date
          * live inside the Profile section's metric grid where they're
          * discoverable but don't shout on every visit. The user id
          * is hidden everywhere — it's an opaque DB key, not user-
          * facing information. */}
        <div className="acct__head">
          <h1 className="acct__title">{me.displayName ?? 'Account'}</h1>
        </div>
        <hr className="acct__rule" />

        <div className="acct__layout">
          <Rail active={activeSection} />

          <div className="acct__main">
            {/* Profile */}
            <section
              id="profile"
              className="acct__section"
              aria-labelledby="profile-heading"
            >
              <h2 className="acct__h2" id="profile-heading">Profile</h2>
              <div className="acct__identity">
                <span className="acct__monogram" aria-hidden="true">{monogramOf(me)}</span>
                <div className="acct__name-row">
                  <span className="acct__name">{me.displayName ?? '(no display name)'}</span>
                  <span className="acct__sub">Signed in via {me.provider ?? 'unknown'}</span>
                </div>
              </div>

              {/* User-id deliberately omitted — it's an opaque server key
                * with no value to the person looking at this page. */}
              <div className="acct__metric-row">
                <div className="acct__metric">
                  <span className="acct__metric-key">Joined</span>
                  <span className="acct__metric-val">{formatDate(me.createdAt)}</span>
                </div>
                {ageStatus ? (
                  <div className="acct__metric">
                    <span className="acct__metric-key">{ageStatus.label}</span>
                    <span className={`acct__metric-val${me.ageConfirmedAt ? ' acct__metric-val--ok' : ''}`}>
                      {ageStatus.value}
                    </span>
                  </div>
                ) : null}
                {me.policyVersion ? (
                  <div className="acct__metric">
                    <span className="acct__metric-key">Policy version</span>
                    <span className="acct__metric-val acct__metric-val--mono">{me.policyVersion}</span>
                  </div>
                ) : null}
              </div>

              <button type="button" onClick={onSignOut} className="acct-btn">
                Sign out
              </button>
            </section>

            {/* Uploads */}
            <section
              id="uploads"
              className="acct__section"
              aria-labelledby="uploads-heading"
            >
              <h2 className="acct__h2" id="uploads-heading">Uploads</h2>
              <div className="acct__uploads-meta">
                <span>
                  <strong>{capsules.length}{hasMore ? '+' : ''}</strong>{' '}
                  capsule{capsules.length === 1 ? '' : 's'} published
                </span>
                <span>Public links remain live until you delete them.</span>
              </div>

              {capsules.length === 0 ? (
                <p className="acct__empty">
                  No capsules yet. Publish from <a href="/lab/">Lab</a> to create a share link.
                </p>
              ) : (
                // The uploads list drives its grid track + thumb
                // dimension from a single CSS custom property. We
                // set the property here from ACCOUNT_THUMB_SIZE so
                // the TS constant is the authoritative source — no
                // CSS/TS mirror to keep in sync. CSS has a
                // pre-hydration fallback for SSR.
                <ul
                  className="acct__uploads-list"
                  style={{
                    '--account-thumb-size': `${ACCOUNT_THUMB_SIZE}px`,
                  } as React.CSSProperties}
                >
                  {capsules.map((c, i) => {
                    const title = c.title?.trim();
                    // Row identifier used by delete-confirm + action
                    // aria-labels. `||` (not `??`) so whitespace-only
                    // titles fall through to the shareCode — otherwise
                    // the confirm prompt would render "Delete ?".
                    const rowName = title || c.shareCode;
                    // V2 preview thumbnail (spec §Account Integration §5):
                    // consume the server-derived `previewThumb` verbatim.
                    // Null rows render a neutral placeholder instead of
                    // synthesizing a fake figure.
                    const isPending = pendingShareCodes.has(c.shareCode);
                    return (
                    <li key={c.shareCode} className="acct__upload">
                      <UploadThumbShell
                        thumb={c.previewThumb}
                        shareCode={c.shareCode}
                        pending={isPending}
                      />
                      <div className="acct__upload-meta">
                        {title ? (
                          <>
                            <div className="acct__upload-title">{title}</div>
                            <code className="acct__upload-code">{c.shareCode}</code>
                          </>
                        ) : (
                          // Index continues across paginated "Load more" (append in place).
                          <div className="acct__upload-title acct__upload-title--code">
                            <span className="acct__upload-index">#{i + 1}</span>
                            <code>{c.shareCode}</code>
                          </div>
                        )}
                      </div>
                      <div className="acct__upload-stats">
                        <span><strong>{formatBytes(c.sizeBytes)}</strong></span>
                        <span>{formatDate(c.createdAt)}</span>
                      </div>
                      <div className="acct__upload-actions">
                        <a
                          className="acct-btn acct-btn--ghost"
                          href={`/c/${c.shareCode}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Open ${rowName} (opens in new tab)`}
                        >
                          Open
                        </a>
                        <button
                          type="button"
                          className="acct-btn acct-btn--ghost"
                          onClick={() => onCopyLink(c.shareCode)}
                          aria-label={`Copy share link for ${rowName}`}
                        >
                          {copiedCode === c.shareCode ? 'Copied' : 'Copy link'}
                        </button>
                        <button
                          type="button"
                          className="acct-btn acct-btn--danger"
                          disabled={deletingCode === c.shareCode}
                          aria-label={`Delete ${rowName}`}
                          onClick={() => {
                            if (
                              confirm(
                                `Delete ${rowName}? The public link will stop working.`,
                              )
                            ) {
                              onDeleteCapsule(c.shareCode);
                            }
                          }}
                        >
                          {deletingCode === c.shareCode ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}

              {hasMore ? (
                <div className="acct__load-more">
                  <button
                    type="button"
                    className="acct-btn"
                    onClick={onLoadMore}
                    disabled={loadingMore}
                    data-testid="account-uploads-load-more"
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              ) : null}
            </section>

            {/* Privacy & Data */}
            <section
              id="privacy"
              className="acct__section"
              aria-labelledby="privacy-heading"
            >
              <h2 className="acct__h2" id="privacy-heading">Privacy &amp; Data</h2>
              <p className="acct__p">
                Read the <a href="/privacy/">Privacy Policy</a>. Deletion takes
                effect immediately — public links stop resolving.
              </p>

              <div className="acct__danger">
                <h3 className="acct__h3">Bulk delete</h3>
                <p className="acct__p">
                  Removes every capsule you have published. Your account remains.
                </p>
                <button
                  type="button"
                  className="acct-btn acct-btn--accent"
                  onClick={() => setDeleteAllConfirm(true)}
                  disabled={capsules.length === 0 || bulkDeleting}
                >
                  Delete all uploaded capsules
                </button>

                {deleteAllConfirm ? (
                  <div className="acct__confirm">
                    {batchCapHit ? (
                      <p>
                        <strong>More uploads remain.</strong> The previous run
                        removed as many as a single request can safely handle —
                        click <em>Continue deleting</em> to remove the rest.
                      </p>
                    ) : (
                      <p>
                        <strong>This removes every capsule you have published.</strong>{' '}
                        Your account remains.
                      </p>
                    )}
                    <button
                      type="button"
                      className="acct-btn acct-btn--danger"
                      onClick={onDeleteAll}
                      disabled={bulkDeleting}
                      data-testid="account-delete-all-confirm"
                    >
                      {bulkDeleting
                        ? 'Deleting…'
                        : batchCapHit
                          ? 'Continue deleting'
                          : 'Yes, delete all'}
                    </button>
                    <button
                      type="button"
                      className="acct-btn acct-btn--ghost"
                      onClick={() => {
                        setDeleteAllConfirm(false);
                        setBatchCapHit(false);
                      }}
                      disabled={bulkDeleting}
                    >
                      {batchCapHit ? 'Stop' : 'Cancel'}
                    </button>
                  </div>
                ) : null}

                <hr className="acct__danger-divider" />

                <h3 className="acct__h3">Close account</h3>
                <p className="acct__p">
                  This deletes your account, revokes sessions, removes your uploaded
                  capsules, and stops all public share links. Pseudonymous audit
                  records (hashed IP, event type) may be retained for up to 180 days
                  for abuse prevention.
                </p>
                <p className="acct__p">
                  Type <code>DELETE ACCOUNT</code> to confirm:
                </p>
                <input
                  type="text"
                  value={deleteAccountConfirm}
                  onChange={(e) => setDeleteAccountConfirm(e.target.value)}
                  className="acct__input"
                  aria-label="Type DELETE ACCOUNT to confirm"
                  spellCheck={false}
                  autoCapitalize="characters"
                  autoComplete="off"
                />
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="acct-btn acct-btn--danger"
                    disabled={deleteAccountConfirm !== 'DELETE ACCOUNT'}
                    onClick={onDeleteAccount}
                  >
                    Delete account
                  </button>
                </div>
              </div>
            </section>

            {/* Support */}
            <section
              id="support"
              className="acct__section"
              aria-labelledby="support-heading"
            >
              <h2 className="acct__h2" id="support-heading">Support &amp; Policies</h2>
              <div className="acct__links">
                <a href="/privacy/">Privacy Policy</a>
                <a href="/terms/">Terms</a>
                <a href="/privacy-request/">Send a privacy request</a>
                <a href="/lab/">Back to Lab</a>
              </div>
            </section>

            <Footer />
          </div>
        </div>
      </main>
    </>
  );
}

/** Mount `AccountApp` onto an existing root element and return the
 *  React root handle. Production code calls it at the module tail
 *  with `document.getElementById('account-root')`. AccountApp-level
 *  tests import this helper directly and keep the returned root in
 *  test scope so they can unmount between runs — cross-test timer
 *  and event-listener leaks are reclaimed without shipping any
 *  window-mutation hooks in the production bundle. */
export function mountAccountApp(rootEl: HTMLElement): ReturnType<typeof createRoot> {
  const root = createRoot(rootEl);
  root.render(<AccountApp />);
  return root;
}

const rootEl = document.getElementById('account-root');
if (rootEl) {
  mountAccountApp(rootEl);
}
