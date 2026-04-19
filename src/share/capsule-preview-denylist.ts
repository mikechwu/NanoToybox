/**
 * Title substring denylist used by sanitizeCapsuleTitle.
 *
 * V1 ships a small stopword/denylist guard as a stop-gap until a proper
 * moderation service is introduced (see spec §3, Phase 2+).
 *
 * All entries are lowercased and compared via a case-insensitive, NFC-normalized
 * substring test against the sanitized title. The list is intentionally short
 * and uncontroversial — it exists to shield public unfurls from obvious abuse,
 * not to act as a content policy.
 */

export const CAPSULE_TITLE_DENYLIST: ReadonlyArray<string> = [
  // slur fragments / hateful terms (minimal, extend via moderation service later)
  'nigger',
  'faggot',
  'kike',
  'chink',
  'spic',
  'tranny',
  // generic abuse phrases
  'kill yourself',
  'kys',
];

export function titleHitsDenylist(normalized: string): boolean {
  const hay = normalized.toLowerCase();
  for (const needle of CAPSULE_TITLE_DENYLIST) {
    if (needle && hay.includes(needle)) return true;
  }
  return false;
}
