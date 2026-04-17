/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createWatchLabDiscoveryRuntime,
  computeHintDismissMs,
} from '../../watch/js/watch-lab-discovery';

function progress(runtime: ReturnType<typeof createWatchLabDiscoveryRuntime>, fraction: number, opts?: { scrub?: boolean; docKey?: string; nowMs?: number }) {
  runtime.onPlaybackProgress({
    loaded: true,
    currentTimePs: fraction * 10,
    startTimePs: 0,
    endTimePs: 10,
    documentKey: opts?.docKey ?? 'file:abc:100',
    isScrubbing: opts?.scrub ?? false,
  });
}

describe('watch-lab-discovery runtime', () => {
  beforeEach(() => {
    // Clear per-test session state.
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('atomdojo.watchLabHint:')) sessionStorage.removeItem(k);
    }
  });

  it('fires timeline_halfway once on incremental play', () => {
    const runtime = createWatchLabDiscoveryRuntime({ now: () => 1_000_000 });
    // Gesture grace window: make lastGestureEndMs stale
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.0);
    progress(runtime, 0.1);
    progress(runtime, 0.45);
    expect(runtime.getState().activeHint).toBeNull();
    progress(runtime, 0.51);
    expect(runtime.getState().activeHint).toMatchObject({ id: 'timeline_halfway' });
    // Second crossing does nothing — already fired
    runtime.dismissActiveHint();
    progress(runtime, 0.55);
    expect(runtime.getState().activeHint).toBeNull();
  });

  it('advancement gate: a seek from 0 to 0.99 fires NEITHER halfway nor completed', () => {
    const runtime = createWatchLabDiscoveryRuntime({ now: () => 1_000_000 });
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.0);
    // Simulate a scrub via onPlaybackProgress — but via isScrubbing: false
    // and a large delta. The large delta alone should disqualify both.
    progress(runtime, 0.99);
    expect(runtime.getState().activeHint).toBeNull();
  });

  it('does not fire during explicit scrub', () => {
    const runtime = createWatchLabDiscoveryRuntime({ now: () => 1_000_000 });
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.49, { scrub: false });
    progress(runtime, 0.55, { scrub: true });
    expect(runtime.getState().activeHint).toBeNull();
  });

  it('fires timeline_completed once on incremental play after halfway', () => {
    const runtime = createWatchLabDiscoveryRuntime({ now: () => 1_000_000 });
    runtime.notifyGestureEnd(0);
    // Walk progress forward in small steps through halfway and completed
    for (let p = 0; p <= 0.99; p += 0.05) progress(runtime, p);
    expect(runtime.getState().activeHint).toMatchObject({ id: 'timeline_completed' });
    runtime.dismissActiveHint();
    progress(runtime, 1.0);
    expect(runtime.getState().activeHint).toBeNull();
  });

  it('grace window: crossing during grace is deferred, fires on first non-scrub tick after grace clears', () => {
    let nowMs = 1_000_000;
    const runtime = createWatchLabDiscoveryRuntime({ now: () => nowMs });
    progress(runtime, 0.49);
    // User gesture ends right now → grace begins.
    runtime.notifyGestureEnd(nowMs);
    // Progress advances past halfway DURING grace (within 600 ms).
    nowMs += 100;
    progress(runtime, 0.51);
    // Still within grace: no hint yet, but the crossing must not be lost.
    expect(runtime.getState().activeHint).toBeNull();
    // Grace window has cleared. Progress advances slightly further —
    // crucially, `prev >= threshold` now, so the fresh-crossing path
    // can no longer fire. The deferred path is the only way the hint
    // can appear. Rev 6 follow-up P1.
    nowMs += 700;
    progress(runtime, 0.53);
    expect(runtime.getState().activeHint).toMatchObject({ id: 'timeline_halfway' });
  });

  it('grace defer does not leak across a document reset', () => {
    let nowMs = 1_000_000;
    const runtime = createWatchLabDiscoveryRuntime({ now: () => nowMs });
    progress(runtime, 0.49);
    runtime.notifyGestureEnd(nowMs);
    nowMs += 100;
    progress(runtime, 0.51);
    // Document reset BEFORE grace clears: pending trigger must be discarded.
    runtime.resetForDocument('file:other:200');
    nowMs += 700;
    progress(runtime, 0.53, { docKey: 'file:other:200' });
    // The new document has `prev` reset to 0, so 0.53 is a large delta
    // and the advancement gate rejects it. Crucially, the pending from
    // the PREVIOUS document must not fire against the NEW document.
    expect(runtime.getState().activeHint).toBeNull();
  });

  it('already-fired trigger does not re-pend during a later grace', () => {
    let nowMs = 1_000_000;
    const runtime = createWatchLabDiscoveryRuntime({ now: () => nowMs });
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.49);
    progress(runtime, 0.51);
    // Halfway already fired + dismissed.
    expect(runtime.getState().activeHint).toMatchObject({ id: 'timeline_halfway' });
    runtime.dismissActiveHint();
    // A fresh gesture triggers grace while progress lingers past halfway.
    nowMs += 10_000;
    runtime.notifyGestureEnd(nowMs);
    nowMs += 100;
    progress(runtime, 0.6);
    nowMs += 700;
    progress(runtime, 0.61);
    // Halfway must NOT re-pend (already in firedSet).
    expect(runtime.getState().activeHint).toBeNull();
  });

  it('two thresholds cross during one grace: later threshold wins', () => {
    let nowMs = 1_000_000;
    const runtime = createWatchLabDiscoveryRuntime({ now: () => nowMs });
    // Pre-grace: sit just before halfway.
    progress(runtime, 0.49);
    runtime.notifyGestureEnd(nowMs);
    // During grace, the user is still consuming playback in small
    // steps that cross halfway AND completed within the same 600 ms
    // window (very short file). Each incremental step is within the
    // advancement-delta gate.
    nowMs += 50;
    progress(runtime, 0.55); // crosses halfway → pending=halfway
    nowMs += 50;
    progress(runtime, 0.65);
    nowMs += 50;
    progress(runtime, 0.78);
    nowMs += 50;
    progress(runtime, 0.92);
    nowMs += 50;
    progress(runtime, 0.98); // crosses completed → pending=completed (overwrites)
    // Grace clears and the next non-scrub tick should fire completed,
    // NOT halfway. Halfway remains un-fired AND un-suppressed — a
    // deliberate v1 trade-off documented in the runtime comments.
    nowMs += 600;
    progress(runtime, 0.99);
    expect(runtime.getState().activeHint).toMatchObject({ id: 'timeline_completed' });
  });

  it('dismiss suppresses a still-pending deferred trigger', () => {
    let nowMs = 1_000_000;
    const runtime = createWatchLabDiscoveryRuntime({ now: () => nowMs });
    progress(runtime, 0.49);
    runtime.notifyGestureEnd(nowMs);
    nowMs += 100;
    progress(runtime, 0.51); // pending
    runtime.dismissActiveHint(); // no active hint, but dismissal also clears pending
    nowMs += 700;
    progress(runtime, 0.53);
    expect(runtime.getState().activeHint).toBeNull();
  });

  it('persists per-document suppression across instances via sessionStorage', () => {
    const a = createWatchLabDiscoveryRuntime({ now: () => 1_000_000 });
    a.notifyGestureEnd(0);
    progress(a, 0.0);
    progress(a, 0.1);
    progress(a, 0.45);
    progress(a, 0.51);
    expect(a.getState().activeHint).toMatchObject({ id: 'timeline_halfway' });
    a.destroy();
    // New runtime, same document key — hint should be suppressed.
    const b = createWatchLabDiscoveryRuntime({ now: () => 2_000_000 });
    b.notifyGestureEnd(0);
    progress(b, 0.0);
    progress(b, 0.45);
    progress(b, 0.51);
    expect(b.getState().activeHint).toBeNull();
  });

  it('bypassPersistedSuppression clears sessionStorage and re-fires', () => {
    // Pre-seed a suppression key.
    sessionStorage.setItem('atomdojo.watchLabHint:file:abc:100:timeline_halfway', '1000');
    const runtime = createWatchLabDiscoveryRuntime({
      now: () => 1_000_000,
      bypassPersistedSuppression: true,
    });
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.0);
    progress(runtime, 0.1);
    progress(runtime, 0.45);
    progress(runtime, 0.51);
    expect(runtime.getState().activeHint).toMatchObject({ id: 'timeline_halfway' });
  });

  it('produces a fresh object reference on each transition', () => {
    const runtime = createWatchLabDiscoveryRuntime({ now: () => 1_000_000 });
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.0);
    progress(runtime, 0.45);
    progress(runtime, 0.51);
    const a = runtime.getState().activeHint;
    runtime.dismissActiveHint();
    const b = runtime.getState().activeHint;
    expect(a).not.toBe(b);
    expect(b).toBeNull();
  });

  it('auto-dismisses after the reading-speed scaled interval', () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const runtime = createWatchLabDiscoveryRuntime({
      now: () => now,
      setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as unknown as typeof setTimeout,
      clearTimeout: ((t: ReturnType<typeof setTimeout>) => clearTimeout(t)) as unknown as typeof clearTimeout,
      e2eDismissMsOverride: null,
    });
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.0);
    progress(runtime, 0.45);
    progress(runtime, 0.51);
    const msg = runtime.getState().activeHint!.message;
    expect(runtime.getState().activeHint).toBeTruthy();
    const dismissMs = computeHintDismissMs(msg);
    vi.advanceTimersByTime(dismissMs - 1);
    expect(runtime.getState().activeHint).toBeTruthy();
    vi.advanceTimersByTime(2);
    expect(runtime.getState().activeHint).toBeNull();
    vi.useRealTimers();
  });

  it('e2eDismissMsOverride forces deterministic auto-dismiss', () => {
    vi.useFakeTimers();
    const runtime = createWatchLabDiscoveryRuntime({
      now: () => 1_000_000,
      e2eDismissMsOverride: 50,
    });
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.0);
    progress(runtime, 0.45);
    progress(runtime, 0.51);
    expect(runtime.getState().activeHint).toBeTruthy();
    vi.advanceTimersByTime(49);
    expect(runtime.getState().activeHint).toBeTruthy();
    vi.advanceTimersByTime(2);
    expect(runtime.getState().activeHint).toBeNull();
    vi.useRealTimers();
  });

  it('resetForDocument clears current hint and document state', () => {
    const runtime = createWatchLabDiscoveryRuntime({ now: () => 1_000_000 });
    runtime.notifyGestureEnd(0);
    progress(runtime, 0.45);
    progress(runtime, 0.51);
    expect(runtime.getState().activeHint).toBeTruthy();
    runtime.resetForDocument('file:other:999');
    expect(runtime.getState().activeHint).toBeNull();
  });
});

describe('computeHintDismissMs', () => {
  it('applies the 3500ms floor and 9000ms ceiling', () => {
    expect(computeHintDismissMs('x')).toBe(3500);
    const long = 'x'.repeat(200);
    expect(computeHintDismissMs(long)).toBe(9000);
  });

  it('honors the e2e override when positive', () => {
    expect(computeHintDismissMs('hello', 42)).toBe(42);
    expect(computeHintDismissMs('hello', 0)).not.toBe(0);
    expect(computeHintDismissMs('hello', null)).toBeGreaterThan(0);
  });
});
