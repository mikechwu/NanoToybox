/**
 * Canonical share-result discriminated union. Single import path for both
 * account and guest publish flows — the module exists so neither the
 * UI layer nor the runtime can re-declare its own slightly-different
 * shape and drift.
 *
 * Scope: after the Phase 1 architecture trim, the prepared-capsule
 * service is mode-neutral. `ShareResultAccount` is produced by the
 * `publishPreparedAccountCapsule` / full-account callbacks;
 * `ShareResultGuest` is produced by the `publishPreparedGuestCapsule` /
 * full-guest callbacks. `TimelineBar.shareResult: ShareResult | null`
 * branches the success UI on the discriminator.
 */

export type ShareResultAccount = {
  mode: 'account';
  shareCode: string;
  shareUrl: string;
  warnings?: string[];
};

export type ShareResultGuest = {
  mode: 'guest';
  shareCode: string;
  shareUrl: string;
  /** ISO timestamp — when the guest link stops resolving. */
  expiresAt: string;
  warnings?: string[];
};

export type ShareResult = ShareResultAccount | ShareResultGuest;
