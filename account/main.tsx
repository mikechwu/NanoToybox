/**
 * Account page (Phase C/D/E of 2026-04-14 plan).
 *
 * Single-file React page so the account route has no cross-dependency
 * on the Lab store. Fetches `/api/account/me` and `/api/account/capsules`
 * on mount; renders four sections:
 *
 *   - Profile        → display name + provider + sign out
 *   - Uploads        → paginated list w/ copy-link / open / delete
 *   - Privacy & Data → links out, delete-all, delete-account
 *   - Support & Policies → Privacy + Terms links
 *
 * Deletion flows call the corresponding /api/account/* endpoints; each
 * destructive action uses a confirm dialog (typed "DELETE ACCOUNT" for
 * account-wide deletion).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

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

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

async function loadAll(): Promise<LoadState> {
  try {
    const [meRes, capRes] = await Promise.all([
      fetch('/api/account/me', { credentials: 'include' }),
      fetch('/api/account/capsules', { credentials: 'include' }),
    ]);
    if (meRes.status === 401) return { status: 'signed-out' };
    if (!meRes.ok) {
      return { status: 'error', message: `me: ${meRes.status}` };
    }
    if (!capRes.ok) {
      return { status: 'error', message: `capsules: ${capRes.status}` };
    }
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
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function loadMoreCapsules(cursor: string): Promise<CapsulesPage> {
  const url = new URL('/api/account/capsules', window.location.origin);
  url.searchParams.set('cursor', cursor);
  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) throw new Error(`capsules: ${res.status}`);
  return (await res.json()) as CapsulesPage;
}

function SignedOutView() {
  return (
    <>
      <header className="policy-header">
        <h1>Account</h1>
        <nav className="policy-nav" aria-label="Policy navigation">
          <a href="/privacy/">Privacy</a>
          <a href="/terms/">Terms</a>
          <a href="/lab/">Lab</a>
        </nav>
      </header>
      <section>
        <h2>Sign in required</h2>
        <p>Please sign in from Lab to manage your account.</p>
        <p>
          <a href="/lab/">Go to Lab</a>
        </p>
      </section>
    </>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <>
      <header className="policy-header">
        <h1>Account</h1>
      </header>
      <section>
        <h2>Could not load</h2>
        <p>{message}</p>
        <button type="button" onClick={onRetry} className="btn btn-secondary">
          Retry
        </button>
      </section>
    </>
  );
}

function AccountApp() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [deletingCode, setDeletingCode] = useState<string | null>(null);
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [batchCapHit, setBatchCapHit] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleteAccountConfirm, setDeleteAccountConfirm] = useState('');
  const [banner, setBanner] = useState<string | null>(null);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    loadAll().then(setState);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onDeleteCapsule = useCallback(
    async (code: string) => {
      setDeletingCode(code);
      try {
        const res = await fetch(`/api/account/capsules/${code}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) {
          setBanner(`Delete failed (${res.status}).`);
        } else {
          setBanner(`Deleted ${code}.`);
          reload();
        }
      } catch (err) {
        setBanner(err instanceof Error ? err.message : String(err));
      } finally {
        setDeletingCode(null);
      }
    },
    [reload],
  );

  const onDeleteAll = useCallback(async () => {
    // Server caps each call at BATCH_LIMIT (200). For larger accounts,
    // loop until `moreAvailable` is false, aggregating totals so the
    // banner stays truthful for every account size.
    setBulkDeleting(true);
    let succeededTotal = 0;
    let failedTotal = 0;
    let attemptedTotal = 0;
    let batchIndex = 0;
    // Distinguishes "nothing left to delete" (success summary) from
    // "client-side cap reached while moreAvailable was still true"
    // (partial-result banner + Continue option). Without this we'd
    // render a success summary for accounts >MAX_BATCHES * 200, and
    // the user would think the destructive action had completed.
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
        if (!data.moreAvailable) {
          exitReason = 'drained';
          break;
        }
        // Last allowed batch and server still says more remain →
        // record cap-hit so the post-loop banner stays truthful.
        if (batchIndex >= MAX_BATCHES) {
          exitReason = 'cap-hit';
        }
      }

      if (exitReason === 'cap-hit') {
        setBatchCapHit(true);
        setBanner(
          `Deleted ${succeededTotal} uploads so far` +
            (failedTotal > 0 ? ` (${failedTotal} failed)` : '') +
            '. More uploads remain — choose "Continue deleting" to remove the rest.',
        );
        // Keep the confirmation surface open AND refresh the list so
        // the new totals are visible while the user decides whether
        // to continue.
        reload();
        return;
      }

      setBatchCapHit(false);
      setBanner(
        `Deleted ${succeededTotal} of ${attemptedTotal}` +
          (failedTotal > 0 ? `; ${failedTotal} failed.` : '.'),
      );
      reload();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkDeleting(false);
      // Only close the confirmation surface when the action genuinely
      // finished (drained, errored, or threw). On cap-hit we leave it
      // open so the Continue button stays in front of the user.
      if (exitReason !== 'cap-hit') setDeleteAllConfirm(false);
    }
  }, [reload]);

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
      // surface to ops + devtools so an outage isn't silent. The
      // cookie may still authenticate the user on /lab/ — they'll see
      // themselves still signed in until the session expires.
      console.warn(
        `[account] logout failed; cookie may persist: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    window.location.href = '/lab/';
  }, []);

  if (state.status === 'loading') {
    return (
      <>
        <header className="policy-header">
          <h1>Account</h1>
        </header>
        <section>
          <p>Loading…</p>
        </section>
      </>
    );
  }
  if (state.status === 'signed-out') return <SignedOutView />;
  if (state.status === 'error')
    return <ErrorView message={state.message} onRetry={reload} />;

  const { me, capsules, hasMore } = state;
  return (
    <>
      <header className="policy-header">
        <h1>Account</h1>
        <nav className="policy-nav" aria-label="Policy navigation">
          <a href="/privacy/">Privacy</a>
          <a href="/terms/">Terms</a>
          <a href="/lab/">Lab</a>
        </nav>
      </header>

      {banner ? (
        <div role="status" aria-live="polite" className="banner">
          {banner}
        </div>
      ) : null}

      <section aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile</h2>
        <p>
          {me.displayName ?? '(no name)'}{' '}
          <span className="muted">· {me.provider ?? 'unknown provider'}</span>
        </p>
        <button type="button" onClick={onSignOut} className="btn">
          Sign out
        </button>
      </section>

      <section aria-labelledby="uploads-heading">
        <h2 id="uploads-heading">
          Uploads ({capsules.length}
          {hasMore ? '+' : ''})
        </h2>
        {capsules.length === 0 ? (
          <p>
            You have not published any capsules yet. Publish from{' '}
            <a href="/lab/">Lab</a> to create a share link.
          </p>
        ) : (
          <ul className="uploads-list">
            {capsules.map((c) => (
              <li key={c.shareCode} className="upload-row">
                <div className="upload-meta">
                  <strong>{c.title ?? c.shareCode}</strong>
                  <span className="muted">
                    {formatDate(c.createdAt)} · {formatBytes(c.sizeBytes)}
                  </span>
                </div>
                <div className="upload-actions">
                  <a
                    className="btn btn-secondary"
                    href={`/c/${c.shareCode}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open
                  </a>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      navigator.clipboard?.writeText(
                        `${window.location.origin}/c/${c.shareCode}`,
                      );
                      setBanner('Link copied.');
                    }}
                  >
                    Copy link
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={deletingCode === c.shareCode}
                    onClick={() => {
                      if (
                        confirm(
                          `Delete ${c.title ?? c.shareCode}? The public link will stop working.`,
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
            ))}
          </ul>
        )}
        {hasMore ? (
          <div className="uploads-load-more">
            <button
              type="button"
              className="btn"
              onClick={onLoadMore}
              disabled={loadingMore}
              data-testid="account-uploads-load-more"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="privacy-heading" className="danger-zone">
        <h2 id="privacy-heading">Privacy &amp; Data</h2>
        <p>
          Read the <a href="/privacy/">Privacy Policy</a>. Deletion takes
          effect immediately — public links stop resolving.
        </p>
        <div className="danger-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setDeleteAllConfirm(true)}
            disabled={capsules.length === 0 || bulkDeleting}
          >
            Delete all uploaded capsules
          </button>
          {deleteAllConfirm ? (
            <div className="confirm-inline">
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
                className="btn btn-danger"
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
                className="btn"
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
        </div>

        <hr className="rule" />

        <h3>Delete account</h3>
        <p>
          This deletes your account, revokes sessions, removes your uploaded
          capsules, and stops all public share links. Pseudonymous audit
          records (hashed IP, event type) may be retained for up to 180 days
          for abuse prevention.
        </p>
        <p>
          Type <code>DELETE ACCOUNT</code> to confirm:
        </p>
        <input
          type="text"
          value={deleteAccountConfirm}
          onChange={(e) => setDeleteAccountConfirm(e.target.value)}
          className="confirm-input"
          aria-label="Type DELETE ACCOUNT to confirm"
        />
        <button
          type="button"
          className="btn btn-danger"
          disabled={deleteAccountConfirm !== 'DELETE ACCOUNT'}
          onClick={onDeleteAccount}
        >
          Delete account
        </button>
      </section>

      <section aria-labelledby="support-heading">
        <h2 id="support-heading">Support &amp; Policies</h2>
        <p>
          <a href="/privacy/">Privacy Policy</a> ·{' '}
          <a href="/terms/">Terms</a>
        </p>
      </section>
    </>
  );
}

const rootEl = document.getElementById('account-root');
if (rootEl) {
  createRoot(rootEl).render(<AccountApp />);
}
