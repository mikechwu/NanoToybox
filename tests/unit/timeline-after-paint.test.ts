/**
 * @vitest-environment jsdom
 */
/**
 * Focused tests for the after-paint scheduler used by the Transfer
 * dialog's estimate effect.
 *
 * Component tests (timeline-bar-lifecycle.test.tsx, export-download-ux
 * .test.tsx) intentionally mock `scheduleAfterNextPaint` to run
 * synchronously — that decouples them from jsdom rAF timing. These
 * tests exercise the real helper: rAF→setTimeout ordering, cancellation
 * at each stage, and paired rAF/cAF selection under partial globals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduleAfterNextPaint } from '../../lab/js/components/timeline-after-paint';

type RafHandler = (time: number) => void;

interface RafHarness {
  readonly handlers: Map<number, RafHandler>;
  readonly flushRaf: (id?: number) => void;
  readonly restore: () => void;
  rafCalls: number;
  cafCalls: number[];
}

function installRaf(): RafHarness {
  const handlers = new Map<number, RafHandler>();
  const cafCalls: number[] = [];
  let nextId = 1;
  let rafCalls = 0;

  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;

  (globalThis as any).requestAnimationFrame = (cb: RafHandler) => {
    rafCalls++;
    const id = nextId++;
    handlers.set(id, cb);
    return id;
  };
  (globalThis as any).cancelAnimationFrame = (id: number) => {
    cafCalls.push(id);
    handlers.delete(id);
  };

  return {
    handlers,
    flushRaf: (id?: number) => {
      if (id !== undefined) {
        const cb = handlers.get(id);
        handlers.delete(id);
        cb?.(performance.now());
        return;
      }
      for (const [handlerId, cb] of Array.from(handlers.entries())) {
        handlers.delete(handlerId);
        cb(performance.now());
      }
    },
    restore: () => {
      (globalThis as any).requestAnimationFrame = originalRaf;
      (globalThis as any).cancelAnimationFrame = originalCaf;
    },
    get rafCalls() { return rafCalls; },
    cafCalls,
  };
}

describe('scheduleAfterNextPaint', () => {
  let harness: RafHarness;

  beforeEach(() => {
    // Fake timers first — vitest's default toFake list includes
    // requestAnimationFrame/cancelAnimationFrame, which would clobber
    // our stub. We exclude them from toFake and install our own
    // controllable rAF harness afterward. setTimeout/clearTimeout
    // remain on the fake timer so we can advance the nested
    // setTimeout(work, 0) explicitly.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    harness = installRaf();
  });

  afterEach(() => {
    vi.useRealTimers();
    harness.restore();
  });

  it('does not run work synchronously — returns before work fires', () => {
    const work = vi.fn();
    scheduleAfterNextPaint(work);
    // Synchronous return path must not invoke work.
    expect(work).not.toHaveBeenCalled();
    // Even after draining microtasks, work is still behind rAF + timeout.
    return Promise.resolve().then(() => {
      expect(work).not.toHaveBeenCalled();
    });
  });

  it('runs work only after rAF fires AND the nested setTimeout flushes', () => {
    const work = vi.fn();
    scheduleAfterNextPaint(work);
    expect(work).not.toHaveBeenCalled();

    // Fire the rAF — this schedules setTimeout but does NOT run work.
    // Work running here would mean the browser never got a paint.
    harness.flushRaf();
    expect(work).not.toHaveBeenCalled();

    // Advance past the setTimeout(work, 0) — now work fires.
    vi.advanceTimersByTime(0);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('cancelling before rAF prevents work from running', () => {
    const work = vi.fn();
    const cancel = scheduleAfterNextPaint(work);

    cancel();
    // cancelAnimationFrame must have been called with the rAF id.
    expect(harness.cafCalls.length).toBe(1);

    // Even if we now try to fire the rAF handler, it was deleted by
    // the stub's cafCalls path and no work is scheduled.
    harness.flushRaf();
    vi.advanceTimersByTime(1);
    expect(work).not.toHaveBeenCalled();
  });

  it('cancelling between rAF and setTimeout prevents work from running', () => {
    const work = vi.fn();
    const cancel = scheduleAfterNextPaint(work);

    // Fire rAF — the nested setTimeout is now queued, but not yet fired.
    harness.flushRaf();
    expect(work).not.toHaveBeenCalled();

    // Cancel now — must clearTimeout the pending task.
    cancel();

    // Advancing timers must not invoke the cancelled task.
    vi.advanceTimersByTime(16);
    expect(work).not.toHaveBeenCalled();
  });

  it('cancelling after work has already fired is a harmless no-op', () => {
    const work = vi.fn();
    const cancel = scheduleAfterNextPaint(work);

    harness.flushRaf();
    vi.advanceTimersByTime(0);
    expect(work).toHaveBeenCalledTimes(1);

    // Cancel after the fact must not throw and must not re-invoke work.
    expect(() => cancel()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('requests exactly one rAF per schedule call', () => {
    scheduleAfterNextPaint(() => {});
    scheduleAfterNextPaint(() => {});
    scheduleAfterNextPaint(() => {});
    expect(harness.rafCalls).toBe(3);
  });
});

describe('scheduleAfterNextPaint — partial-global environments', () => {
  let originalRaf: typeof globalThis.requestAnimationFrame | undefined;
  let originalCaf: typeof globalThis.cancelAnimationFrame | undefined;

  beforeEach(() => {
    // Same toFake carve-out as the main suite: we want to control
    // rAF/cAF ourselves (here by deleting them) while keeping
    // setTimeout/clearTimeout on the fake timer.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalRaf) (globalThis as any).requestAnimationFrame = originalRaf;
    else delete (globalThis as any).requestAnimationFrame;
    if (originalCaf) (globalThis as any).cancelAnimationFrame = originalCaf;
    else delete (globalThis as any).cancelAnimationFrame;
  });

  it('falls back to setTimeout/clearTimeout as a pair when rAF is missing', () => {
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;

    const work = vi.fn();
    const cancel = scheduleAfterNextPaint(work);

    // Under fallback, work is queued behind two timers (~16ms + 0ms).
    expect(work).not.toHaveBeenCalled();
    // Drain recursively — the first setTimeout fires and schedules the
    // nested setTimeout(work, 0); runAllTimers advances through both.
    vi.runAllTimers();
    expect(work).toHaveBeenCalledTimes(1);

    // Cancel after completion must still be a no-op.
    expect(() => cancel()).not.toThrow();
  });

  it('uses fallback path atomically when only one of rAF/cAF is present', () => {
    // Simulate a partial environment: rAF exists but cAF does not.
    // The pair-selection must bail to setTimeout/clearTimeout for both
    // rather than scheduling via rAF and being unable to cancel.
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      // This stub must NOT be called — the pair selection should fall
      // back to setTimeout because cAF is missing.
      cb(0);
      return 999;
    });
    (globalThis as any).requestAnimationFrame = rafSpy;
    delete (globalThis as any).cancelAnimationFrame;

    const work = vi.fn();
    const cancel = scheduleAfterNextPaint(work);

    // rAF must not have been used.
    expect(rafSpy).not.toHaveBeenCalled();

    // Cancel before any timer fires → work must never run.
    cancel();
    vi.advanceTimersByTime(100);
    expect(work).not.toHaveBeenCalled();
  });
});
