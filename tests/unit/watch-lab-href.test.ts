/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { buildLabHref, readE2EBoolean, readE2ENumber } from '../../watch/js/watch-lab-href';

describe('buildLabHref', () => {
  it('returns a path with BASE_URL prefix and trailing slash', () => {
    const href = buildLabHref();
    // vite test default sets BASE_URL to '/'.
    expect(href.endsWith('/lab/')).toBe(true);
  });

  it('appends query string when provided', () => {
    const href = buildLabHref({ from: 'watch', handoff: 'abc-123' });
    expect(href).toContain('/lab/?');
    expect(href).toContain('from=watch');
    expect(href).toContain('handoff=abc-123');
  });

  it('skips null/undefined values', () => {
    const href = buildLabHref({ from: 'watch', handoff: null as unknown as string });
    expect(href).toContain('from=watch');
    expect(href).not.toContain('handoff');
  });
});

describe('readE2EBoolean / readE2ENumber', () => {
  it('accepts "1" and "true" for booleans', () => {
    const fakeLoc = { search: '?e2eResetLabHints=1' } as Location;
    expect(readE2EBoolean('e2eResetLabHints', fakeLoc)).toBe(true);
    const fakeLoc2 = { search: '?e2eResetLabHints=true' } as Location;
    expect(readE2EBoolean('e2eResetLabHints', fakeLoc2)).toBe(true);
  });

  it('returns false for any other value', () => {
    const fakeLoc = { search: '?e2eResetLabHints=0' } as Location;
    expect(readE2EBoolean('e2eResetLabHints', fakeLoc)).toBe(false);
    const fakeLoc2 = { search: '' } as Location;
    expect(readE2EBoolean('e2eResetLabHints', fakeLoc2)).toBe(false);
  });

  it('parses positive integers for numbers, rejects others', () => {
    expect(readE2ENumber('e2eHintDismissMs', { search: '?e2eHintDismissMs=500' } as Location)).toBe(500);
    expect(readE2ENumber('e2eHintDismissMs', { search: '?e2eHintDismissMs=0' } as Location)).toBeNull();
    expect(readE2ENumber('e2eHintDismissMs', { search: '?e2eHintDismissMs=-1' } as Location)).toBeNull();
    expect(readE2ENumber('e2eHintDismissMs', { search: '?e2eHintDismissMs=abc' } as Location)).toBeNull();
    expect(readE2ENumber('e2eHintDismissMs', { search: '' } as Location)).toBeNull();
  });
});
