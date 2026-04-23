/**
 * Canonical share-result discriminated union. Single import path for both
 * account and guest publish flows — the module exists so neither the
 * UI layer nor the runtime can re-declare its own slightly-different
 * shape and drift.
 *
 * Scope guardrail (§Frontend Result Contract in the implementation
 * plan): v1 keeps the prepared publisher strictly account-mode and uses
 * `ShareResultAccount` for its return type. `ShareResultGuest` is
 * produced only by the new `onConfirmGuestShare` store callback and
 * consumed by `TimelineBar.shareResult: ShareResult | null` for UI
 * branching.
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
