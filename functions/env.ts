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
}

/** Extended context with authenticated user ID (set by auth middleware). */
export interface AuthenticatedEnv extends Env {
  userId: string;
}
