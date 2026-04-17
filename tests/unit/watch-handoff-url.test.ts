/**
 * @vitest-environment jsdom
 *
 * Shared URL predicate for the Watch → Lab handoff boot signal.
 * Consumed by both `lab/js/main.ts` (boot gate) and
 * `lab/js/runtime/onboarding.ts` (onboarding suppression gate).
 */
import { describe, it, expect } from 'vitest';
import { isWatchHandoffBoot } from '../../src/watch-lab-handoff/watch-handoff-url';

describe('isWatchHandoffBoot', () => {
  it('true when both ?from=watch and ?handoff=<token> are present', () => {
    expect(isWatchHandoffBoot({ search: '?from=watch&handoff=abc-123' })).toBe(true);
  });

  it('true regardless of parameter order', () => {
    expect(isWatchHandoffBoot({ search: '?handoff=tok&from=watch' })).toBe(true);
  });

  it('true when additional unknown params are present', () => {
    expect(isWatchHandoffBoot({ search: '?from=watch&handoff=t&debug=1' })).toBe(true);
  });

  it('false when ?from is missing', () => {
    expect(isWatchHandoffBoot({ search: '?handoff=abc-123' })).toBe(false);
  });

  it('false when ?handoff is missing', () => {
    expect(isWatchHandoffBoot({ search: '?from=watch' })).toBe(false);
  });

  it('false when ?handoff is empty string', () => {
    expect(isWatchHandoffBoot({ search: '?from=watch&handoff=' })).toBe(false);
  });

  it('false when ?from is a different value', () => {
    expect(isWatchHandoffBoot({ search: '?from=share&handoff=abc' })).toBe(false);
  });

  it('false on empty query string', () => {
    expect(isWatchHandoffBoot({ search: '' })).toBe(false);
  });

  it('false when loc is undefined (non-browser environment)', () => {
    expect(isWatchHandoffBoot(undefined)).toBe(false);
  });

  it('defaults to window.location when called with no argument', () => {
    // jsdom default location has no query string — should be false.
    expect(isWatchHandoffBoot()).toBe(false);
  });
});
