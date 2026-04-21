/**
 * Single source of truth for how the account API derives preview
 * thumbs from stored `preview_scene_v1` JSON.
 *
 * Shared between:
 *   - `functions/api/account/capsules/index.ts` (production read path)
 *   - `preview-audit/main.tsx` (the "ACCOUNT FALLBACK (stale-row
 *     path)" panel — so divergence between audit and production is
 *     visible instead of hidden)
 *   - `tests/unit/capsule-preview-audit-account-parity.test.ts`
 *     (regression lock that asserts byte-equivalence between the two
 *     surfaces on stale-row + fresh-row fixtures)
 *
 * The silhouette-preserving sampler is the load-bearing choice: it
 * keeps a structure's visual envelope intact when atoms-only fallback
 * downsamples below the bonded-thumb threshold. Without this override,
 * the default `sampleEvenly` would pick nearly-indistinguishable
 * neighbors on dense scenes (every fourth atom in scan order), losing
 * the silhouette that makes the thumb recognizable.
 *
 * Pure module; no DOM, no Cloudflare APIs.
 */

import {
  derivePreviewThumbV1,
  ROW_ATOM_CAP_ATOMS_ONLY,
  ROW_ATOM_CAP_WITH_BONDS,
  ROW_BOND_CAP,
  type PreviewSceneAtomV1,
  type PreviewThumbV1,
} from './capsule-preview-scene-store';
import { sampleForSilhouette } from './capsule-preview-sampling';

/** Options bundle for {@link derivePreviewThumbV1} that matches the
 *  account API exactly. Exported for tests + the audit-page parity
 *  panel; the account route reuses this via {@link deriveAccountThumb}. */
export const ACCOUNT_THUMB_DERIVE_OPTIONS: Parameters<typeof derivePreviewThumbV1>[1] = {
  atomCap: ROW_ATOM_CAP_ATOMS_ONLY,
  bondsAwareAtomCap: ROW_ATOM_CAP_WITH_BONDS,
  bondCap: ROW_BOND_CAP,
  sampler: (atoms, target) => sampleForSilhouette<PreviewSceneAtomV1>(
    atoms,
    target,
    (a) => a.x,
    (a) => a.y,
  ),
};

/** Derive a `PreviewThumbV1` exactly as the account list endpoint
 *  would. Both the production account route and the audit-page
 *  parity panel call this so they cannot drift. */
export function deriveAccountThumb(
  raw: string | null | undefined,
): PreviewThumbV1 | null {
  return derivePreviewThumbV1(raw, ACCOUNT_THUMB_DERIVE_OPTIONS);
}
