/**
 * Tests for src/share/share-code.ts
 *
 * Covers: generation, normalization (all input shapes), validation, display formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  generateShareCode,
  normalizeShareInput,
  isValidShareCode,
  formatShareCode,
} from '../../src/share/share-code';

describe('generateShareCode', () => {
  it('generates a 12-character code', () => {
    const code = generateShareCode();
    expect(code).toHaveLength(12);
  });

  it('uses only Crockford Base32 characters', () => {
    const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;
    for (let i = 0; i < 50; i++) {
      expect(generateShareCode()).toMatch(CROCKFORD);
    }
  });

  it('generates unique codes', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add(generateShareCode());
    expect(codes.size).toBe(100);
  });
});

describe('isValidShareCode', () => {
  it('accepts valid 12-char Crockford code', () => {
    expect(isValidShareCode('7M4K2D8Q9T1V')).toBe(true);
  });

  it('rejects too-short codes', () => {
    expect(isValidShareCode('7M4K2D8Q')).toBe(false);
  });

  it('rejects too-long codes', () => {
    expect(isValidShareCode('7M4K2D8Q9T1VA')).toBe(false);
  });

  it('rejects codes with excluded characters (I, L, O, U)', () => {
    expect(isValidShareCode('7M4K2D8Q9TIV')).toBe(false); // I
    expect(isValidShareCode('7M4K2D8Q9TLV')).toBe(false); // L
    expect(isValidShareCode('7M4K2D8Q9TOV')).toBe(false); // O
    expect(isValidShareCode('7M4K2D8Q9TUV')).toBe(false); // U
  });

  it('rejects lowercase', () => {
    expect(isValidShareCode('7m4k2d8q9t1v')).toBe(false);
  });
});

describe('formatShareCode', () => {
  it('groups into 4-4-4 with hyphens', () => {
    expect(formatShareCode('7M4K2D8Q9T1V')).toBe('7M4K-2D8Q-9T1V');
  });

  it('returns input unchanged if not 12 chars', () => {
    expect(formatShareCode('SHORT')).toBe('SHORT');
  });
});

describe('normalizeShareInput', () => {
  // Raw code
  it('normalizes a raw uppercase code', () => {
    expect(normalizeShareInput('7M4K2D8Q9T1V')).toBe('7M4K2D8Q9T1V');
  });

  it('normalizes a lowercase raw code', () => {
    expect(normalizeShareInput('7m4k2d8q9t1v')).toBe('7M4K2D8Q9T1V');
  });

  // Grouped code
  it('strips hyphens from grouped code', () => {
    expect(normalizeShareInput('7M4K-2D8Q-9T1V')).toBe('7M4K2D8Q9T1V');
  });

  // Crockford decode: O → 0, I/L → 1
  it('applies Crockford decoding (O → 0, I → 1, L → 1)', () => {
    // Replace first char '7' with 'O' (should become '0')
    expect(normalizeShareInput('OM4K2D8Q9T1V')).toBe('0M4K2D8Q9T1V');
    expect(normalizeShareInput('IM4K2D8Q9T10')).toBe('1M4K2D8Q9T10');
    expect(normalizeShareInput('LM4K2D8Q9T10')).toBe('1M4K2D8Q9T10');
  });

  // Share URL
  it('extracts code from full share URL', () => {
    expect(normalizeShareInput('https://atomdojo.pages.dev/c/7M4K2D8Q9T1V')).toBe('7M4K2D8Q9T1V');
  });

  // Watch URL
  it('extracts code from Watch URL with ?c= param', () => {
    expect(normalizeShareInput('https://atomdojo.pages.dev/watch/?c=7M4K2D8Q9T1V')).toBe('7M4K2D8Q9T1V');
  });

  // Relative paths
  it('extracts code from relative /c/ path', () => {
    expect(normalizeShareInput('/c/7M4K2D8Q9T1V')).toBe('7M4K2D8Q9T1V');
  });

  it('extracts code from relative /watch/?c= path', () => {
    expect(normalizeShareInput('/watch/?c=7M4K2D8Q9T1V')).toBe('7M4K2D8Q9T1V');
  });

  // Trimming
  it('trims whitespace', () => {
    expect(normalizeShareInput('  7M4K2D8Q9T1V  ')).toBe('7M4K2D8Q9T1V');
  });

  // Invalid inputs
  it('returns null for empty input', () => {
    expect(normalizeShareInput('')).toBeNull();
    expect(normalizeShareInput('  ')).toBeNull();
  });

  it('returns null for gibberish', () => {
    expect(normalizeShareInput('not-a-code')).toBeNull();
  });

  it('returns null for valid URL with no code', () => {
    expect(normalizeShareInput('https://atomdojo.pages.dev/lab/')).toBeNull();
  });
});
