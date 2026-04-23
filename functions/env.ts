/**
 * Cloudflare Pages Functions environment type.
 * Shared by all Functions via PagesFunction<Env>.
 */

export interface Env {
  DB: D1Database;
  R2_BUCKET: R2Bucket;

  // Auth secrets (set in wrangler secrets / .dev.vars)
  // Canonical names match .dev.vars convention.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;

  // Dev-only bypass (set in .dev.vars, never in production)
  AUTH_DEV_USER_ID?: string;
  DEV_ADMIN_ENABLED?: string;

  // Production cron automation secret — enables a deployed cron Worker
  // to invoke admin sweep endpoints by presenting X-Cron-Secret. Never
  // expose this as a browser-visible token; set via `wrangler secret put`.
  CRON_SECRET?: string;

  /**
   * Capsule preview V1 dynamic-fallback flag (spec §7). "on" (default) →
   * poster route emits dynamically-generated PNG for accessible capsules
   * without a stored asset, and the share-page emits og:image for every
   * accessible capsule. "off" → pre-V1 behavior (stored-only).
   * Set in wrangler.toml under [vars]; rollback is one-line config + redeploy.
   */
  CAPSULE_PREVIEW_DYNAMIC_FALLBACK?: string;

  // ── Guest Quick Share ────────────────────────────────────────────
  //
  // Feature-flag and Turnstile config for the anonymous publish path.
  // Default is OFF — only "on" / "true" / "1" (case-insensitive,
  // trimmed) enables the path. Resolved exclusively through
  // `isGuestPublishEnabled(env)` in src/share/guest-publish-flag.ts.
  GUEST_PUBLISH_ENABLED?: string;

  /** Cloudflare Turnstile — public site key. Surfaced to the Lab via
   *  the session publicConfig bridge. Published through wrangler.toml
   *  [vars]; NOT a secret. */
  TURNSTILE_SITE_KEY?: string;

  /** Cloudflare Turnstile — server-side secret. Provisioned via
   *  `wrangler pages secret put TURNSTILE_SECRET_KEY`. The guest-publish
   *  endpoint fails closed (500 server_not_configured) when this is
   *  missing AND the flag is on. */
  TURNSTILE_SECRET_KEY?: string;

  /** Operator override for the guest publish per-IP quota ceiling. */
  GUEST_PUBLISH_QUOTA_MAX?: string;

  /** Operator override for the guest publish quota window length (seconds). */
  GUEST_PUBLISH_QUOTA_WINDOW_SECONDS?: string;
}

/** Extended context with authenticated user ID (set by auth middleware). */
export interface AuthenticatedEnv extends Env {
  userId: string;
}
