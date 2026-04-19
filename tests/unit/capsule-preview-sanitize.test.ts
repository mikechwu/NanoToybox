/**
 * Tests for sanitizeCapsuleTitle (spec §3).
 *
 * The sanitizer is the SOLE owner of non-Latin fallback for V1 — these tests
 * are the safety contract for everything downstream that renders the title
 * into a poster image or alt text.
 */

import { describe, it, expect } from 'vitest';
import {
  CAPSULE_TITLE_FALLBACK,
  sanitizeCapsuleTitle,
} from '../../src/share/capsule-preview';

describe('sanitizeCapsuleTitle', () => {
  it('null / undefined → fallback', () => {
    expect(sanitizeCapsuleTitle(null)).toBe(CAPSULE_TITLE_FALLBACK);
    expect(sanitizeCapsuleTitle(undefined)).toBe(CAPSULE_TITLE_FALLBACK);
  });

  it('empty / whitespace-only → fallback', () => {
    expect(sanitizeCapsuleTitle('')).toBe(CAPSULE_TITLE_FALLBACK);
    expect(sanitizeCapsuleTitle('   \t\n')).toBe(CAPSULE_TITLE_FALLBACK);
  });

  it('strips control chars', () => {
    expect(sanitizeCapsuleTitle('a\u0001b\u001fc\u007fd')).toBe('abcd');
  });

  it('strips bidi overrides', () => {
    expect(sanitizeCapsuleTitle('safe\u202etrailing')).toBe('safetrailing');
    expect(sanitizeCapsuleTitle('a\u2066b\u2069c')).toBe('abc');
  });

  it('collapses ZWJ runs ≥2 to a single joiner', () => {
    const raw = 'a\u200d\u200d\u200db';
    expect(sanitizeCapsuleTitle(raw)).toBe('a\u200db');
  });

  it('NFC-normalizes', () => {
    // 'e' + combining acute → composed 'é'
    const raw = 'cafe\u0301';
    const out = sanitizeCapsuleTitle(raw);
    expect(out).toBe('café');
  });

  it('hard-truncates to 60 NFC code points with U+2026 ellipsis', () => {
    const long = 'a'.repeat(120);
    const out = sanitizeCapsuleTitle(long);
    expect([...out].length).toBe(60);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('denylist hit → fallback', () => {
    expect(sanitizeCapsuleTitle('this contains kys substring')).toBe(CAPSULE_TITLE_FALLBACK);
  });

  it('non-Latin code points → fallback (CJK)', () => {
    expect(sanitizeCapsuleTitle('日本語タイトル')).toBe(CAPSULE_TITLE_FALLBACK);
  });

  it('non-Latin code points → fallback (Arabic)', () => {
    expect(sanitizeCapsuleTitle('عنوان')).toBe(CAPSULE_TITLE_FALLBACK);
  });

  it('non-Latin code points → fallback (emoji)', () => {
    expect(sanitizeCapsuleTitle('cool 🚀 capsule')).toBe(CAPSULE_TITLE_FALLBACK);
  });

  it('latin-extended titles pass through', () => {
    expect(sanitizeCapsuleTitle('Crystallographer’s café — naïve façade')).toBe(
      'Crystallographer’s café — naïve façade',
    );
  });
});
