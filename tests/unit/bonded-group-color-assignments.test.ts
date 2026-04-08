/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the shared pure color-assignment module.
 *
 * Covers:
 *   - rebuildOverridesFromDenseIndices (override projection)
 *   - computeGroupColorState (chip state derivation)
 *   - chipBackgroundValue (CSS background helper)
 *   - computeHexGeometry (honeycomb math)
 *   - GROUP_COLOR_OPTIONS (palette)
 *   - buildGroupColorLayout (layout split)
 *   - No framework/store dependency
 */

import { describe, it, expect } from 'vitest';
import {
  rebuildOverridesFromDenseIndices,
  computeGroupColorState,
  GROUP_COLOR_OPTIONS,
  buildGroupColorLayout,
  computeHexGeometry,
  SWATCH_DIAMETER,
  ACTIVE_SCALE,
  RING_GAP,
  type AtomColorOverrideMap,
} from '../../src/appearance/bonded-group-color-assignments';
import { chipBackgroundValue } from '../../src/ui/bonded-group-chip-style';

// ── rebuildOverridesFromDenseIndices ──

describe('rebuildOverridesFromDenseIndices', () => {
  it('produces empty map from empty assignments', () => {
    expect(rebuildOverridesFromDenseIndices([])).toEqual({});
  });

  it('maps atom indices to colors', () => {
    const result = rebuildOverridesFromDenseIndices([
      { atomIndices: [0, 1], colorHex: '#ff0000' },
    ]);
    expect(result[0]).toEqual({ hex: '#ff0000' });
    expect(result[1]).toEqual({ hex: '#ff0000' });
    expect(result[2]).toBeUndefined();
  });

  it('later assignments win for overlapping indices', () => {
    const result = rebuildOverridesFromDenseIndices([
      { atomIndices: [0, 1], colorHex: '#ff0000' },
      { atomIndices: [1, 2], colorHex: '#00ff00' },
    ]);
    expect(result[0]).toEqual({ hex: '#ff0000' });
    expect(result[1]).toEqual({ hex: '#00ff00' }); // overwritten
    expect(result[2]).toEqual({ hex: '#00ff00' });
  });
});

// ── computeGroupColorState ──

describe('computeGroupColorState', () => {
  it('returns default for empty atom list', () => {
    expect(computeGroupColorState([], {})).toEqual({ kind: 'default' });
  });

  it('returns default when no overrides match', () => {
    expect(computeGroupColorState([0, 1], {})).toEqual({ kind: 'default' });
  });

  it('returns single when all atoms have same color', () => {
    const overrides: AtomColorOverrideMap = { 0: { hex: '#ff0000' }, 1: { hex: '#ff0000' } };
    expect(computeGroupColorState([0, 1], overrides)).toEqual({ kind: 'single', hex: '#ff0000' });
  });

  it('returns multi when atoms have different colors', () => {
    const overrides: AtomColorOverrideMap = { 0: { hex: '#ff0000' }, 1: { hex: '#00ff00' } };
    const result = computeGroupColorState([0, 1], overrides);
    expect(result.kind).toBe('multi');
    if (result.kind === 'multi') {
      expect(result.hexes).toContain('#ff0000');
      expect(result.hexes).toContain('#00ff00');
      expect(result.hasDefault).toBe(false);
    }
  });

  it('returns multi with hasDefault when some atoms are uncolored', () => {
    const overrides: AtomColorOverrideMap = { 0: { hex: '#ff0000' } };
    const result = computeGroupColorState([0, 1], overrides);
    expect(result.kind).toBe('multi');
    if (result.kind === 'multi') {
      expect(result.hasDefault).toBe(true);
    }
  });

  it('caps to 4 unique colors', () => {
    const overrides: AtomColorOverrideMap = {
      0: { hex: '#a' }, 1: { hex: '#b' }, 2: { hex: '#c' }, 3: { hex: '#d' }, 4: { hex: '#e' },
    };
    const result = computeGroupColorState([0, 1, 2, 3, 4], overrides);
    if (result.kind === 'multi') {
      expect(result.hexes.length).toBe(4);
    }
  });
});

// ── chipBackgroundValue ──

describe('chipBackgroundValue', () => {
  it('returns undefined for default state', () => {
    expect(chipBackgroundValue({ kind: 'default' })).toBeUndefined();
  });

  it('returns hex for single color', () => {
    expect(chipBackgroundValue({ kind: 'single', hex: '#ff0000' })).toBe('#ff0000');
  });

  it('returns conic-gradient for multi color', () => {
    const result = chipBackgroundValue({ kind: 'multi', hexes: ['#ff0000', '#00ff00'], hasDefault: false });
    expect(result).toContain('conic-gradient');
    expect(result).toContain('#ff0000');
    expect(result).toContain('#00ff00');
  });

  it('includes atom-base-color fallback when hasDefault is true', () => {
    const result = chipBackgroundValue({ kind: 'multi', hexes: ['#ff0000'], hasDefault: true });
    expect(result).toContain('--atom-base-color');
  });

  it('returns string, not React.CSSProperties', () => {
    const result = chipBackgroundValue({ kind: 'single', hex: '#ff0000' });
    expect(typeof result).toBe('string');
  });
});

// ── computeHexGeometry ──

describe('computeHexGeometry', () => {
  it('returns non-zero radius for 6 items', () => {
    const { radius, containerSize } = computeHexGeometry(6, SWATCH_DIAMETER, ACTIVE_SCALE, RING_GAP);
    expect(radius).toBeGreaterThan(0);
    expect(containerSize).toBeGreaterThan(SWATCH_DIAMETER);
  });

  it('returns zero radius for 0 or 1 items', () => {
    expect(computeHexGeometry(0, 20, 1.3, 4).radius).toBe(0);
    expect(computeHexGeometry(1, 20, 1.3, 4).radius).toBe(0);
  });
});

// ── GROUP_COLOR_OPTIONS + buildGroupColorLayout ──

describe('GROUP_COLOR_OPTIONS', () => {
  it('has 7 options (1 default + 6 presets)', () => {
    expect(GROUP_COLOR_OPTIONS).toHaveLength(7);
    expect(GROUP_COLOR_OPTIONS[0].kind).toBe('default');
    expect(GROUP_COLOR_OPTIONS.filter(o => o.kind === 'preset')).toHaveLength(6);
  });
});

describe('buildGroupColorLayout', () => {
  it('splits default into primary, presets into secondary', () => {
    const layout = buildGroupColorLayout(GROUP_COLOR_OPTIONS);
    expect(layout.primary?.kind).toBe('default');
    expect(layout.secondary).toHaveLength(6);
    expect(layout.secondary.every(o => o.kind === 'preset')).toBe(true);
  });
});

// ── No framework dependency ──

describe('shared module purity', () => {
  it('shared module does not import React or Zustand', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('src/appearance/bonded-group-color-assignments.ts', 'utf-8');
    expect(source).not.toContain("from 'react'");
    expect(source).not.toContain("from 'zustand'");
    expect(source).not.toContain('React.');
  });

  it('chip-style helper does not import React', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('src/ui/bonded-group-chip-style.ts', 'utf-8');
    expect(source).not.toContain("from 'react'");
    expect(source).not.toContain("import React");
  });
});
