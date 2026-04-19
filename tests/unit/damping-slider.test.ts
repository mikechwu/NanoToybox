/**
 * Tests for `src/ui/damping-slider` — the single source of truth for
 * the Lab Settings damping slider ↔ physical damping coefficient
 * mapping. Verifies:
 *
 *  - the cubic forward/inverse pair round-trips for every valid
 *    integer slider position (no floating-point drift at the boundary)
 *  - known reference points (0, midpoint, max) agree with the
 *    cubic-scale contract
 *  - the label formatter handles the three documented ranges
 *    (None / scientific / fixed)
 */

import { describe, it, expect } from 'vitest';
import {
  DAMPING_SLIDER_MAX,
  DAMPING_CUBIC_SCALE,
  dampingToSliderValue,
  sliderValueToDamping,
  formatDampingFromSliderValue,
} from '../../src/ui/damping-slider';

describe('damping-slider constants', () => {
  it('slider max is an integer > 0', () => {
    expect(DAMPING_SLIDER_MAX).toBeGreaterThan(0);
    expect(Number.isInteger(DAMPING_SLIDER_MAX)).toBe(true);
  });
  it('cubic scale is a positive finite number', () => {
    expect(DAMPING_CUBIC_SCALE).toBeGreaterThan(0);
    expect(Number.isFinite(DAMPING_CUBIC_SCALE)).toBe(true);
  });
});

describe('sliderValueToDamping', () => {
  it('maps 0 → 0 exactly', () => {
    expect(sliderValueToDamping(0)).toBe(0);
  });
  it('maps max → DAMPING_CUBIC_SCALE', () => {
    expect(sliderValueToDamping(DAMPING_SLIDER_MAX)).toBe(DAMPING_CUBIC_SCALE);
  });
  it('is monotonically increasing', () => {
    let prev = -1;
    for (let v = 0; v <= DAMPING_SLIDER_MAX; v++) {
      const d = sliderValueToDamping(v);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });
  it('is cubic at the midpoint', () => {
    // t = 0.5 ⇒ d = DAMPING_CUBIC_SCALE · 0.125
    const mid = DAMPING_SLIDER_MAX / 2;
    expect(sliderValueToDamping(mid)).toBeCloseTo(DAMPING_CUBIC_SCALE * 0.125, 12);
  });
});

describe('dampingToSliderValue', () => {
  it('maps 0 → 0 exactly', () => {
    expect(dampingToSliderValue(0)).toBe(0);
  });
  it('clamps negatives to 0 (defensive)', () => {
    expect(dampingToSliderValue(-0.1)).toBe(0);
  });
  it('clamps NaN and Infinity to 0 so corrupt configs cannot poison the store slider', () => {
    expect(dampingToSliderValue(Number.NaN)).toBe(0);
    expect(dampingToSliderValue(Number.POSITIVE_INFINITY)).toBe(0);
    expect(dampingToSliderValue(Number.NEGATIVE_INFINITY)).toBe(0);
  });
  it('maps DAMPING_CUBIC_SCALE → max exactly', () => {
    expect(dampingToSliderValue(DAMPING_CUBIC_SCALE)).toBe(DAMPING_SLIDER_MAX);
  });
  it('returns an integer for every coefficient', () => {
    for (let v = 0; v <= DAMPING_SLIDER_MAX; v++) {
      const d = sliderValueToDamping(v);
      expect(Number.isInteger(dampingToSliderValue(d))).toBe(true);
    }
  });
});

describe('round trip', () => {
  it('dampingToSliderValue(sliderValueToDamping(v)) === v for every integer v in [0, max]', () => {
    for (let v = 0; v <= DAMPING_SLIDER_MAX; v++) {
      const d = sliderValueToDamping(v);
      expect(dampingToSliderValue(d)).toBe(v);
    }
  });
});

describe('formatDampingFromSliderValue', () => {
  it('reports "None" at zero', () => {
    expect(formatDampingFromSliderValue(0)).toBe('None');
  });
  it('uses scientific notation below 1e-3', () => {
    // pick a slider value whose damping lands in the scientific band
    let picked = -1;
    for (let v = 1; v <= DAMPING_SLIDER_MAX; v++) {
      if (sliderValueToDamping(v) < 0.001) picked = v;
      else break;
    }
    if (picked > 0) {
      expect(formatDampingFromSliderValue(picked)).toMatch(/e/i);
    }
  });
  it('uses fixed three-decimal notation at the max', () => {
    expect(formatDampingFromSliderValue(DAMPING_SLIDER_MAX)).toBe(
      DAMPING_CUBIC_SCALE.toFixed(3),
    );
  });
});
