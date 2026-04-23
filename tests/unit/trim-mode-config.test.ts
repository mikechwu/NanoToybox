/**
 * Trim-mode configuration invariants.
 *
 * These are product-policy constants used by the Capsule Publish
 * trim UX. The tests below lock the invariants that downstream
 * code relies on so a future contributor tuning these values is
 * forced to review the ripple-effects.
 */
import { describe, it, expect } from 'vitest';
import {
  TRIM_TARGET_BYTES,
  MAX_SEARCH_ITERATIONS,
  FRAME_FALLBACK_SUFFIX,
  TRIM_KEYBOARD_PREPARE_DEBOUNCE_MS,
  TRIM_HANDLE_PULSE_MS,
  TRIM_HANDLE_PULSE_ITERATION_MS,
  TRIM_HANDLE_PULSE_ITERATION_COUNT,
} from '../../lab/js/components/timeline/trim-mode-config';
import { MAX_PUBLISH_BYTES } from '../../src/share/constants';

describe('trim-mode-config', () => {
  it('TRIM_TARGET_BYTES sits strictly below MAX_PUBLISH_BYTES so close-to-limit has headroom', () => {
    // Plan §Width and Byte-Gate Separation: the soft target exists
    // specifically to leave room for manual adjustments above the
    // entry-time search result. If this flipped to >= the cap, the
    // "close-to-limit" status bucket would vanish and every fit
    // would land in "over-limit" the moment the user widens.
    expect(TRIM_TARGET_BYTES).toBeLessThan(MAX_PUBLISH_BYTES);
    // And not absurdly below it — 80% or less would force the
    // entry search to return pessimistic suffixes.
    expect(TRIM_TARGET_BYTES).toBeGreaterThan(MAX_PUBLISH_BYTES * 0.8);
  });

  it('MAX_SEARCH_ITERATIONS terminates even under pathological frame sizes', () => {
    // 2^16 = 65_536 > any reasonable dense-frame budget. The
    // chunked search uses bisect, so log2(N) iterations suffice.
    expect(MAX_SEARCH_ITERATIONS).toBeGreaterThanOrEqual(10);
    expect(MAX_SEARCH_ITERATIONS).toBeLessThan(32);
  });

  it('FRAME_FALLBACK_SUFFIX is a positive, modest, cadence-independent frame count', () => {
    // Intentionally NOT expressed as a duration — plan §Terminology
    // forbids seconds/minutes framing across trim mode because
    // record cadence and playback speed are user-adjustable. The
    // value exists purely so the kept-region band has a visible
    // non-zero width while the async default-selection search
    // settles, and so the fallback prepare stays cheap.
    expect(FRAME_FALLBACK_SUFFIX).toBeGreaterThan(0);
    expect(FRAME_FALLBACK_SUFFIX).toBeLessThan(600);
  });

  it('debounce windows are tuned to user-perceptible timings', () => {
    // Too short → every keystroke fires a prepare. Too long →
    // users feel the UI lag behind their edits.
    expect(TRIM_KEYBOARD_PREPARE_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
    expect(TRIM_KEYBOARD_PREPARE_DEBOUNCE_MS).toBeLessThanOrEqual(500);
  });

  it('pulse animation is brief enough not to annoy, long enough to notice', () => {
    expect(TRIM_HANDLE_PULSE_MS).toBeGreaterThanOrEqual(600);
    expect(TRIM_HANDLE_PULSE_MS).toBeLessThanOrEqual(3000);
  });

  it('pulse total is derived from iteration × count — the three constants cannot drift', () => {
    // Regression for the prior divergence where JS waited 1500 ms
    // but the CSS animation was `1.2s ... 2` (2400 ms total). Any
    // future tuning must pass through the derived identity to keep
    // the JS timeout and the CSS animation lifecycle aligned.
    expect(TRIM_HANDLE_PULSE_MS).toBe(TRIM_HANDLE_PULSE_ITERATION_MS * TRIM_HANDLE_PULSE_ITERATION_COUNT);
    expect(TRIM_HANDLE_PULSE_ITERATION_COUNT).toBeGreaterThanOrEqual(1);
    expect(TRIM_HANDLE_PULSE_ITERATION_MS).toBeGreaterThan(0);
  });
});
