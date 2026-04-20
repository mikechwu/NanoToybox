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
import {
  ATOM_HALO_WIDTH,
  resolveAtomsOnlyRadius,
  resolveBondStrokeWidth,
  resolveBondedAtomRadius,
} from '../src/share/capsule-preview-thumb-render';

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
// V2 contract (spec §Account Integration §5 + follow-up bonds-in-thumb):
// the component consumes the `previewThumb: PreviewThumbV1` payload from
// the account API verbatim — no client-side projection, no downsampling.
// Server is the single point of downsampling on the read path (AC #26).
//
// Two regimes, both capped at 20 DOM elements:
//   - ATOMS-ONLY: up to 18 `<circle>` glyphs. Chosen when the source
//     scene has no storage bonds, isn't dense enough, or when the
//     derivation's visibility filter rejected too many bonds.
//   - BONDS-AWARE: up to 12 `<circle>` glyphs + up to 6 `<line>`
//     bonds, rendered bonds-under-atoms. Only chosen when the server
//     confirms at least `MIN_ACCEPTABLE_BONDS` bonds survive
//     visibility filtering.
//
// Visual constants (atom radius, bond stroke width) come from
// `src/share/capsule-preview-thumb-render.ts` — the same module the
// server-side visibility filter reads from, so the "bond visible
// after subtracting endpoint radii" calculation stays correct.
//
// Decorative: aria-hidden="true" — the row's code/title text is the
// authoritative label.

// Matches the `.acct__upload-thumb` track width in public/account-layout.css.
// Keep these in sync so the SVG renders 1:1 (no DPR upscaling smear).
const THUMB_SIZE = 40;

export function CapsulePreviewThumb({
  thumb,
}: {
  thumb: PreviewThumbV1;
}): React.ReactElement {
  // Radius + connectivity strategy at 40×40 (viewBox 100). Constants
  // come from `capsule-preview-thumb-render` so the derivation's
  // visibility filter stays in lockstep with the actual rendered
  // geometry; adjusting either side without the other silently drops
  // visible bonds or clips glyphs against the cell edge.
  //
  // DOM budget: svg(1) + rect(1) + up to 12 circles + up to 6 lines = 20.
  const n = thumb.atoms.length;
  const hasBonds = !!(thumb.bonds && thumb.bonds.length > 0);
  const densityRadius = hasBonds
    ? resolveBondedAtomRadius(n)
    : resolveAtomsOnlyRadius(n);
  const bondWidth = resolveBondStrokeWidth(n);
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
        fill="currentColor" fillOpacity={0.06}
      />
      {hasBonds && thumb.bonds!.map((b, i) => {
        const a = thumb.atoms[b.a];
        const c = thumb.atoms[b.b];
        if (!a || !c) return null;
        return (
          <line
            key={`l${i}`}
            x1={a.x * 100}
            y1={a.y * 100}
            x2={c.x * 100}
            y2={c.y * 100}
            // Darker neutral so the 2.5-viewBox stroke reads as a line,
            // not a ghost. Using `currentColor` or a lighter grey makes
            // the stroke disappear at 1-physical-pixel on the light page.
            stroke="rgba(55,65,80,0.90)"
            strokeWidth={bondWidth}
            strokeLinecap="round"
          />
        );
      })}
      {thumb.atoms.map((a, i) => {
        // In bonded mode the density radius is deliberately tight so
        // the atom glyphs don't swallow the bond strokes between them —
        // we pin atoms to that tighter value regardless of the stored
        // scaling. In atoms-only mode, the stored radius may exceed the
        // floor (sparse scenes get chunkier dots), so we take the
        // larger. `Number.isFinite` guards a crafted-NaN payload.
        const scaled = Number.isFinite(a.r) ? a.r * 100 : 0;
        const r = hasBonds ? densityRadius : Math.max(densityRadius, scaled);
        return (
          <circle
            key={`c${i}`}
            cx={a.x * 100}
            cy={a.y * 100}
            r={r}
            fill={a.c}
            fillOpacity={0.95}
            // Explicit light halo (not `currentColor`) — currentColor
            // on a light theme resolves to the dark body text, which
            // has almost no contrast against the #222222 carbon fill
            // and failed to separate adjacent atoms. A soft white
            // stroke reliably reads as a halo on both themes without
            // eating the bond stroke. Width sourced from the shared
            // render-constants module so the derivation's fit-glyph
            // margin accounts for it.
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={ATOM_HALO_WIDTH}
          />
        );
      })}
    </svg>
  );
}

/** Neutral placeholder thumb for rows without a usable preview scene
 *  (pre-V2 rows not yet backfilled, kind ≠ 'capsule', etc.). 3 elements
 *  total — well under the 20-element budget and visually quiet so the
 *  CSS grid track does not collapse. */
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

async function loadAll(): Promise<LoadState> {
  try {
    const [meRes, capRes] = await Promise.all([
      fetch('/api/account/me', { credentials: 'include' }),
      fetch('/api/account/capsules', { credentials: 'include' }),
    ]);
    if (meRes.status === 401) return { status: 'signed-out' };
    if (!meRes.ok) return { status: 'error', message: `me: ${meRes.status}` };
    if (!capRes.ok) return { status: 'error', message: `capsules: ${capRes.status}` };
    const me = (await meRes.json()) as AccountMe;
    const capsData = (await capRes.json()) as CapsulesPage;
    return {
      status: 'ready',
      me,
      capsules: capsData.capsules,
      hasMore: capsData.hasMore ?? false,
      nextCursor: capsData.nextCursor ?? null,
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function loadMoreCapsules(cursor: string): Promise<CapsulesPage> {
  const url = new URL('/api/account/capsules', window.location.origin);
  url.searchParams.set('cursor', cursor);
  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) throw new Error(`capsules: ${res.status}`);
  return (await res.json()) as CapsulesPage;
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

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    loadAll().then(setState);
  }, []);

  /** Capsules-only refresh — awaitable, stays in the `ready` state.
   *  Returns the refreshed capsule list, or null on failure.
   *  Used by post-delete reconciliation so the page doesn't flash
   *  to the global loading screen.
   *
   *  Pagination: intentionally resets to page 1 (no cursor). After a
   *  destructive operation the server-side ordering may have shifted,
   *  and stale cursors can produce gaps or duplicates. Accepting the
   *  reset-to-page-1 tradeoff is the simplest correct behavior. */
  const refreshCapsules = useCallback(async (): Promise<CapsuleSummary[] | null> => {
    try {
      const res = await fetch('/api/account/capsules', { credentials: 'include' });
      if (!res.ok) return null;
      const data = (await res.json()) as CapsulesPage;
      setState(prev =>
        prev.status === 'ready'
          ? { ...prev, capsules: data.capsules, hasMore: data.hasMore ?? false, nextCursor: data.nextCursor ?? null }
          : prev,
      );
      return data.capsules;
    } catch (err) {
      console.error('[account] capsule refresh failed:', err);
      return null;
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-dismiss the toast banner after 5s — keeps confirmations from
  // lingering while still surfacing them long enough to read.
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
        } catch {
          // Network error — httpOk stays false.
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
      setBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [state]);

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
    navigator.clipboard?.writeText(url);
    setCopiedCode(shareCode);
    setBanner('Link copied to clipboard.');
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopiedCode(null), 1500);
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
                <ul className="acct__uploads-list">
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
                    return (
                    <li key={c.shareCode} className="acct__upload">
                      {c.previewThumb ? (
                        <CapsulePreviewThumb thumb={c.previewThumb} />
                      ) : (
                        <PlaceholderThumb />
                      )}
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

const rootEl = document.getElementById('account-root');
if (rootEl) {
  createRoot(rootEl).render(<AccountApp />);
}
