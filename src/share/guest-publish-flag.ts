/**
 * Single source of truth for the guest-publish feature flag.
 *
 * Every layer (endpoint gate, client-config bridge, tests) must call
 * {@link isGuestPublishEnabled}; inline string compares against
 * `env.GUEST_PUBLISH_ENABLED` are forbidden so the semantic cannot
 * drift across call sites.
 *
 * Allow-list semantics: only the explicit truthy strings "on", "true",
 * "1" (case-insensitive, trimmed) enable guest publish. Anything else
 * — including unset, "off", "false", "0", typos, whitespace — disables.
 * Default OFF, opposite of {@link isDynamicPreviewFallbackEnabled}.
 *
 * Owns:        feature-flag resolver for Quick Share rollout
 * Depends on:  nothing (pure function of env)
 * Called by:   functions/api/capsules/guest-publish.ts (404 gate),
 *              functions/api/auth/session.ts (publicConfig.guestPublish.enabled),
 *              tests asserting the matrix of flag states.
 *
 * Rollout policy lives in the implementation plan §Rollout and the
 * wrangler.toml comment. Emergency off-switch is `GUEST_PUBLISH_ENABLED=off`
 * + redeploy.
 */

export function isGuestPublishEnabled(env: {
  GUEST_PUBLISH_ENABLED?: string;
}): boolean {
  const raw = env.GUEST_PUBLISH_ENABLED;
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1';
}
