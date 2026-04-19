/**
 * @vitest-environment jsdom
 */
/**
 * Focused tests for the `measureSync` User Timing helper used by
 * TimelineBar's transfer flow.
 *
 * Contract:
 *   - Returns the callback's value unchanged.
 *   - Rethrows the callback's error unchanged.
 *   - Emits `performance.measure(name, ...)` on both success and throw.
 *   - Falls back to plain `work()` when the User Timing API is absent.
 *   - If instrumentation itself throws (mark/measure/clearMarks), the
 *     helper is invisible: `work()`'s result or error passes through.
 *
 * Why its own test file: the helper is shared by export-estimate and
 * transfer-pause measurement. Component tests exercise it only
 * indirectly. Any regression here affects both instrumentation sites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { measureSync } from '../../lab/js/components/timeline/timeline-performance';

type MarkFn = typeof performance.mark;
type MeasureFn = typeof performance.measure;
type ClearMarksFn = typeof performance.clearMarks;

interface PerformanceSnapshot {
  mark: MarkFn | undefined;
  measure: MeasureFn | undefined;
  clearMarks: ClearMarksFn | undefined;
}

function snapshot(): PerformanceSnapshot {
  return {
    mark: performance.mark?.bind(performance),
    measure: performance.measure?.bind(performance),
    clearMarks: performance.clearMarks?.bind(performance),
  };
}

function restore(s: PerformanceSnapshot) {
  if (s.mark) (performance as any).mark = s.mark;
  else delete (performance as any).mark;
  if (s.measure) (performance as any).measure = s.measure;
  else delete (performance as any).measure;
  if (s.clearMarks) (performance as any).clearMarks = s.clearMarks;
  else delete (performance as any).clearMarks;
}

describe('measureSync — success path', () => {
  let original: PerformanceSnapshot;
  beforeEach(() => {
    original = snapshot();
    // Clear any lingering measures from other tests so per-name counts
    // are deterministic.
    performance.clearMeasures?.();
  });
  afterEach(() => { restore(original); });

  it('returns the callback value', () => {
    const out = measureSync('test-return', () => 42);
    expect(out).toBe(42);
  });

  it('returns complex objects by reference', () => {
    const obj = { a: 1 };
    const out = measureSync('test-ref', () => obj);
    expect(out).toBe(obj);
  });

  it('emits a performance.measure entry named after the label', () => {
    measureSync('test-success-measure', () => 'x');
    const entries = performance.getEntriesByName('test-success-measure');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1].entryType).toBe('measure');
  });

  it('clears contributing marks so they do not accumulate', () => {
    measureSync('test-clear-marks', () => 1);
    expect(performance.getEntriesByName('test-clear-marks-start').length).toBe(0);
    expect(performance.getEntriesByName('test-clear-marks-end').length).toBe(0);
  });
});

describe('measureSync — failure path', () => {
  let original: PerformanceSnapshot;
  beforeEach(() => {
    original = snapshot();
    performance.clearMeasures?.();
  });
  afterEach(() => { restore(original); });

  it('rethrows the original error from work()', () => {
    const original = new Error('builder crashed');
    expect(() => measureSync('test-throw', () => { throw original; })).toThrow(original);
  });

  it('emits a performance.measure entry even when work() throws', () => {
    expect(() => measureSync('test-throw-measure', () => { throw new Error('x'); })).toThrow();
    const entries = performance.getEntriesByName('test-throw-measure');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1].entryType).toBe('measure');
  });

  it('clears contributing marks even when work() throws', () => {
    expect(() => measureSync('test-throw-clear', () => { throw new Error('x'); })).toThrow();
    expect(performance.getEntriesByName('test-throw-clear-start').length).toBe(0);
    expect(performance.getEntriesByName('test-throw-clear-end').length).toBe(0);
  });
});

describe('measureSync — API-missing fallback', () => {
  let original: PerformanceSnapshot;
  beforeEach(() => { original = snapshot(); });
  afterEach(() => { restore(original); });

  it('falls back to plain work() when performance.mark is missing', () => {
    delete (performance as any).mark;
    const out = measureSync('test-no-mark', () => 'ok');
    expect(out).toBe('ok');
  });

  it('falls back to plain work() when performance.measure is missing', () => {
    delete (performance as any).measure;
    const out = measureSync('test-no-measure', () => 'ok');
    expect(out).toBe('ok');
  });

  it('fallback still rethrows errors from work()', () => {
    delete (performance as any).measure;
    const err = new Error('fallback throw');
    expect(() => measureSync('test-fallback-throw', () => { throw err; })).toThrow(err);
  });
});

describe('measureSync — instrumentation failures must not affect app behavior', () => {
  let original: PerformanceSnapshot;
  beforeEach(() => {
    original = snapshot();
    performance.clearMeasures?.();
  });
  afterEach(() => { restore(original); });

  it('returns work() value when performance.mark(start) throws', () => {
    (performance as any).mark = vi.fn(() => { throw new Error('mark blew up'); });
    const out = measureSync('test-mark-throws', () => 'survived');
    expect(out).toBe('survived');
  });

  it('rethrows work() error when performance.mark(start) throws', () => {
    (performance as any).mark = vi.fn(() => { throw new Error('mark blew up'); });
    const workErr = new Error('real error');
    expect(() => measureSync('test-mark-throws-2', () => { throw workErr; })).toThrow(workErr);
  });

  it('returns work() value when performance.measure throws', () => {
    (performance as any).measure = vi.fn(() => { throw new Error('measure blew up'); });
    const out = measureSync('test-measure-throws', () => 'survived');
    expect(out).toBe('survived');
  });

  it('rethrows the work() error (not the instrumentation error) when both throw', () => {
    (performance as any).measure = vi.fn(() => { throw new Error('instrumentation error'); });
    const workErr = new Error('real business error');
    try {
      measureSync('test-both-throw', () => { throw workErr; });
      throw new Error('should have thrown');
    } catch (e) {
      // The caller must see the ORIGINAL business error, not the
      // instrumentation error. This is the invariant that protects the
      // export/share UI from having its real error replaced.
      expect(e).toBe(workErr);
    }
  });

  it('returns work() value when clearMarks throws', () => {
    (performance as any).clearMarks = vi.fn(() => { throw new Error('clear blew up'); });
    const out = measureSync('test-clear-throws', () => 'survived');
    expect(out).toBe('survived');
  });
});
