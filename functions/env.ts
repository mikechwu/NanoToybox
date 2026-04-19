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
}

/** Extended context with authenticated user ID (set by auth middleware). */
export interface AuthenticatedEnv extends Env {
  userId: string;
}
