/**
 * Tests for src/share/guest-publish-flag.ts
 *
 * Pins the allow-list semantics: only "on" / "true" / "1" (case-
 * insensitive, trimmed) enable; anything else — including unset,
 * "off", "false", "0", typos, whitespace — disables. Default OFF.
 */

import { describe, it, expect } from 'vitest';
import { isGuestPublishEnabled } from '../../src/share/guest-publish-flag';

describe('isGuestPublishEnabled', () => {
  it('returns false when flag is undefined', () => {
    expect(isGuestPublishEnabled({})).toBe(false);
  });

  it.each(['on', 'true', '1', 'On', 'ON', 'TRUE', '  on  ', '\ttrue\n'])(
    'returns true for %p',
    (v) => {
      expect(isGuestPublishEnabled({ GUEST_PUBLISH_ENABLED: v })).toBe(true);
    },
  );

  it.each([
    'off', 'false', '0', 'no', 'disabled', 'enabled', 'yes',
    '', '   ', '2', 'on!', 'true​',
  ])('returns false for %p', (v) => {
    expect(isGuestPublishEnabled({ GUEST_PUBLISH_ENABLED: v })).toBe(false);
  });
});
