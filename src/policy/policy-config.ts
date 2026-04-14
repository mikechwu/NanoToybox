/**
 * Single source of truth for the public policy surfaces (/privacy, /terms).
 *
 * The 2026-04-14 plan structures the policy text as gated SEGMENTS, each
 * tied to a backing engineering phase (A descriptive, B age-gate, D
 * per-capsule delete, E account/bulk delete, F audit retention sweeper).
 * The constants here drive THREE consumers:
 *
 *   1. The Vite build plugin (`src/policy/vite-policy-plugin.ts`)
 *      injects `POLICY_VERSION` + `ACTIVE_POLICY_SEGMENTS` into
 *      privacy/terms HTML at build time so the page text never drifts
 *      from the shipped behavior.
 *   2. `scripts/deploy-smoke.sh` reads the injected
 *      `<meta name="policy-active-segments">` tag at smoke time and
 *      asserts that EVERY listed segment appears in markup AND no
 *      unlisted segment does.
 *   3. `tests/e2e/policy-routes.spec.ts` reads the same meta tag and
 *      mirrors the smoke assertions, so a future phase ships by editing
 *      this file alone — no test surgery required.
 *
 * The server-side `POLICY_VERSION` re-export from
 * `src/share/constants.ts` points at the value here, so user
 * `user_policy_acceptance` rows record the exact same version string
 * the policy page rendered with.
 */

/**
 * Monotonic version label for the Privacy Policy + Terms copy and the
 * 13+ age-gate acknowledgment. Bumped any time visible policy text or
 * the active-segment list changes. Format: `YYYY-MM-DD.N` (the date of
 * the change plus a same-day minor counter).
 */
export const POLICY_VERSION = '2026-04-14.3';

/**
 * Phase letters whose policy copy is allowed to render today. A segment
 * appears in this list if AND ONLY IF the engineering phase that backs
 * it is deployed and exercised by users.
 *
 * The plan's "Policy text gating across phases" table is the editorial
 * authority; this constant is the build-time enforcement of it.
 */
export const ACTIVE_POLICY_SEGMENTS = ['A', 'B', 'D', 'E', 'F'] as const;

export type PolicySegment = (typeof ACTIVE_POLICY_SEGMENTS)[number];

/**
 * Boolean feature flags that the policy text references. Used by the
 * HTML build to swap "rolling out / will be available" wording for
 * "available now" wording without manually editing two pages.
 */
export const POLICY_FEATURES = {
  /** Phase D + E: per-capsule delete + bulk + account-wide delete. */
  deletionControlsLive: true,
  /** Phase B: server-authoritative 13+ gate at sign-in + publish. */
  ageGateLive: true,
  /** Phase F: weekly cron-driven scrub + bounded delete of audit rows. */
  auditRetentionSweeperLive: true,
  /**
   * `placeholder` → "channel will be published before public launch"
   * `mailbox`     → display the published mailbox address
   * `form`        → /privacy-request route is live
   *
   * The `/privacy-request` form route shipped with Phase 7 Option B
   * (POST endpoint, signed-intent CSRF nonce, per-IP rate limit,
   * D1-backed inbox, sweeper-managed retention). Flipping this back
   * to `placeholder` later requires hiding the route AND the form
   * link from `/privacy`.
   */
  privacyContactMode: 'form' as 'placeholder' | 'mailbox' | 'form',
} as const;

/** Comma-separated segment list for embedding in a `<meta>` tag. */
export function activeSegmentsCsv(): string {
  return ACTIVE_POLICY_SEGMENTS.join(',');
}
