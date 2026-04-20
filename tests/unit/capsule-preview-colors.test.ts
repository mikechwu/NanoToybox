/**
 * Tests for src/share/capsule-preview-colors.ts — spec §capsule-preview-colors.
 */

import { describe, it, expect } from 'vitest';
import {
  ELEMENT_COLORS,
  NEUTRAL_GREY,
  resolveAtomColors,
} from '../../src/share/capsule-preview-colors';

describe('resolveAtomColors', () => {
  it('falls back to CPK element table when no appearance', () => {
    const out = resolveAtomColors(
      [
        { id: 0, element: 'C' },
        { id: 1, element: 'O' },
        { id: 2, element: 'H' },
      ],
      undefined,
    );
    expect(out.get(0)).toBe(ELEMENT_COLORS.C);
    expect(out.get(1)).toBe(ELEMENT_COLORS.O);
    expect(out.get(2)).toBe(ELEMENT_COLORS.H);
  });

  it('falls back to NEUTRAL_GREY for unknown elements', () => {
    const out = resolveAtomColors(
      [{ id: 0, element: 'Uuu' }],
      undefined,
    );
    expect(out.get(0)).toBe(NEUTRAL_GREY);
  });

  it('applies per-group assignments (fan-out, not per-atom map)', () => {
    const out = resolveAtomColors(
      [
        { id: 0, element: 'C' },
        { id: 1, element: 'C' },
        { id: 2, element: 'C' },
      ],
      {
        colorAssignments: [
          { atomIds: [0, 1], colorHex: '#ff00ff' },
        ],
      },
    );
    expect(out.get(0)).toBe('#ff00ff');
    expect(out.get(1)).toBe('#ff00ff');
    // Atom 2 wasn't in any group → element fallback.
    expect(out.get(2)).toBe(ELEMENT_COLORS.C);
  });

  it('last-write-wins when the same atom id appears in multiple groups', () => {
    const out = resolveAtomColors(
      [{ id: 0, element: 'C' }],
      {
        colorAssignments: [
          { atomIds: [0], colorHex: '#ff00ff' },
          { atomIds: [0], colorHex: '#00ff00' },
        ],
      },
    );
    expect(out.get(0)).toBe('#00ff00');
  });

  it('ignores malformed assignments gracefully', () => {
    const out = resolveAtomColors(
      [{ id: 0, element: 'C' }],
      {
        colorAssignments: [null as any, { atomIds: null as any, colorHex: '#ff00ff' }],
      },
    );
    expect(out.get(0)).toBe(ELEMENT_COLORS.C);
  });
});
