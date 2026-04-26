/**
 * Share-publish auth + config contract types.
 *
 * Dependency-free home for the small set of UI/runtime contract types
 * the publish layer reads (auth status, public config). Lives outside
 * the Zustand store module so that runtime modules — particularly
 * `trim-submit-coordinator.ts` — can consume the same shapes without
 * importing from the store layer.
 *
 * Layering rule: this module imports nothing from the project. The
 * store re-exports these types as its public surface; runtime
 * coordinators import them directly from here.
 */

/**
 * Lab-side auth-UX state machine discriminator.
 *
 *   - `loading`    — initial /api/auth/session fetch is in flight.
 *   - `signed-in`  — server returned 200 with a valid session payload.
 *   - `signed-out` — server returned 401 (authoritative "you are not
 *                    authenticated"). UI may prompt for OAuth sign-in.
 *   - `unverified` — we could NOT reach a definitive answer. Covers
 *                    network failure, 5xx, or malformed response with
 *                    no prior session to preserve. UI should render a
 *                    neutral retry affordance, NOT an OAuth prompt —
 *                    falsely asserting signed-out during a transport
 *                    blip would mislead the user.
 */
export type AuthStatus = 'loading' | 'signed-in' | 'signed-out' | 'unverified';

/**
 * Public, non-sensitive config surfaced by the session-endpoint
 * bridge. Guest publish UI keys off `guestPublish.enabled` + a
 * non-null `guestPublish.turnstileSiteKey` together; either falsy →
 * hide the Quick Share block.
 */
export interface PublicConfig {
  guestPublish: {
    enabled: boolean;
    turnstileSiteKey: string | null;
  };
}
