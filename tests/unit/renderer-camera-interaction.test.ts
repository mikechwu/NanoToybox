/**
 * Camera-interaction gate contract tests.
 *
 * Locks the invariant that fixes the cinematic-camera self-cooldown
 * loop: programmatic `controls.update()` calls wrapped in
 * `runSilently()` must NOT wake `onCameraInteraction` subscribers.
 * Only real OrbitControls user gestures (start → change → end) do.
 *
 * These tests import the ACTUAL gate module the renderer uses
 * (`src/camera/camera-interaction-gate.ts`), so a future edit that
 * breaks the attribution logic surfaces here — no test-local
 * re-implementation to drift from production.
 *
 * We don't stand up the real `Renderer` class (WebGL + DOM overhead).
 * The OrbitControls event surface is modeled via a THREE
 * `EventDispatcher` subclass — the same base class OrbitControls
 * extends — so event semantics match the real thing.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventDispatcher } from 'three';
import { createCameraInteractionGate } from '../../src/camera/camera-interaction-gate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class FakeControls extends (EventDispatcher as any) {
  /** Simulates OrbitControls.update() — fires 'change' unconditionally. */
  update() {
    (this as any).dispatchEvent({ type: 'change' });
  }
  beginUserGesture() {
    (this as any).dispatchEvent({ type: 'start' });
  }
  driveUserGestureTick() {
    (this as any).dispatchEvent({ type: 'change' });
  }
  endUserGesture() {
    (this as any).dispatchEvent({ type: 'end' });
  }
  /** Expose for direct dispatch (damping tail test). */
  dispatchRaw(type: 'start' | 'change' | 'end') {
    (this as any).dispatchEvent({ type });
  }
}

/** Wire the real gate to a fake OrbitControls. Mirrors the production
 *  renderer constructor at `lab/js/renderer.ts`. */
function wire(controls: FakeControls, emit: () => void) {
  const gate = createCameraInteractionGate(emit);
  (controls as any).addEventListener('start', () => gate.onStart());
  (controls as any).addEventListener('change', () => gate.onChange());
  (controls as any).addEventListener('end', () => gate.onEnd());
  return gate;
}

describe('createCameraInteractionGate', () => {
  it('runSilently does NOT fire the emit callback', () => {
    const controls = new FakeControls();
    const emit = vi.fn();
    const gate = wire(controls, emit);

    gate.runSilently(() => controls.update());
    gate.runSilently(() => controls.update());
    gate.runSilently(() => controls.update());

    expect(emit).not.toHaveBeenCalled();
  });

  it('real user gesture emits start + change(s) + end with phases', () => {
    const controls = new FakeControls();
    const emit = vi.fn();
    wire(controls, emit);

    controls.beginUserGesture();
    controls.driveUserGestureTick();
    controls.driveUserGestureTick();
    controls.endUserGesture();

    const phases = emit.mock.calls.map(c => c[0]);
    expect(phases).toEqual(['start', 'change', 'change', 'end']);
  });

  it('phantom end (no preceding start) does NOT emit', () => {
    const controls = new FakeControls();
    const emit = vi.fn();
    wire(controls, emit);

    controls.endUserGesture();
    expect(emit).not.toHaveBeenCalled();
  });

  it('programmatic update INTERLEAVED with user gesture: only gesture events emit', () => {
    const controls = new FakeControls();
    const emit = vi.fn();
    const gate = wire(controls, emit);

    gate.runSilently(() => controls.update());
    expect(emit).not.toHaveBeenCalled();

    controls.beginUserGesture();
    expect(emit).toHaveBeenCalledTimes(1);

    // Mid-gesture programmatic update — suppress must win even
    // though userActive is true.
    gate.runSilently(() => controls.update());
    expect(emit).toHaveBeenCalledTimes(1);

    controls.driveUserGestureTick();
    expect(emit).toHaveBeenCalledTimes(2);

    controls.endUserGesture();
    // 'end' fires when releasing a previously-active gesture.
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[2][0]).toBe('end');

    // Post-gesture programmatic updates — silent again.
    gate.runSilently(() => controls.update());
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('stray change without a preceding start is ignored (e.g. damping tail)', () => {
    const controls = new FakeControls();
    const emit = vi.fn();
    wire(controls, emit);

    controls.dispatchRaw('change');
    expect(emit).not.toHaveBeenCalled();
  });

  it('suppress counter nests — inner silent call does not leak', () => {
    const controls = new FakeControls();
    const emit = vi.fn();
    const gate = wire(controls, emit);

    controls.beginUserGesture();
    emit.mockClear();

    gate.runSilently(() => {
      gate.runSilently(() => {
        controls.update();
      });
      controls.update(); // still inside outer suppression
    });

    expect(emit).not.toHaveBeenCalled();
  });

  it('runSilently returns the inner function result', () => {
    const controls = new FakeControls();
    const gate = wire(controls, () => {});
    const result = gate.runSilently(() => {
      controls.update();
      return 42;
    });
    expect(result).toBe(42);
  });

  it('_updateControlsSilently behavior: warns + skips update when gate is null AND listeners present', async () => {
    // Behavior test — invokes the ACTUAL `Renderer.prototype` method
    // against a synthetic `this` so we exercise the production code
    // body without needing WebGL. This confirms the exact failure
    // mode that previously reintroduced the self-cooldown loop
    // cannot execute.
    const { Renderer } = await import('../../lab/js/renderer');
    const controlsUpdate = vi.fn();
    // Spy in try/finally so a failing assertion below can't leak
    // the mockImplementation into later tests' console.warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Gate-missing + listener attached → must warn, must NOT update.
      const fakeThisWithListener = {
        _cameraInteractionGate: null,
        _cameraInteractionListeners: new Set<() => void>([() => {}]),
        controls: { update: controlsUpdate },
      };
      (Renderer.prototype as any)._updateControlsSilently.call(fakeThisWithListener);
      expect(controlsUpdate).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('camera interaction gate is not attached'),
      );

      // Gate-missing + NO listeners → silent skip, no warn, no update.
      warn.mockClear();
      const fakeThisNoListener = {
        _cameraInteractionGate: null,
        _cameraInteractionListeners: new Set<() => void>(),
        controls: { update: controlsUpdate },
      };
      (Renderer.prototype as any)._updateControlsSilently.call(fakeThisNoListener);
      expect(controlsUpdate).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      // Gate present → update runs, routed through runSilently.
      const runSilently = vi.fn((fn: () => void) => fn());
      const fakeThisWithGate = {
        _cameraInteractionGate: { runSilently },
        _cameraInteractionListeners: new Set<() => void>(),
        controls: { update: controlsUpdate },
      };
      controlsUpdate.mockClear();
      (Renderer.prototype as any)._updateControlsSilently.call(fakeThisWithGate);
      expect(runSilently).toHaveBeenCalledTimes(1);
      expect(controlsUpdate).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('_updateControlsSilently fails CLOSED when gate is missing', async () => {
    // Source-level assertion: the helper must NOT call
    // `this.controls.update()` in the gate-missing fallback. Emitting
    // an unsuppressed update would reintroduce the self-cooldown
    // loop for any listener still attached.
    const fs = await import('fs');
    const source = fs.readFileSync('lab/js/renderer.ts', 'utf-8');
    const helper = source.match(/_updateControlsSilently\(\):\s*void\s*\{[\s\S]*?\n  \}/);
    expect(helper).not.toBeNull();
    const body = helper![0];
    // Body must guard on gate presence before calling update.
    expect(body).toMatch(/if \(!?this\._cameraInteractionGate/);
    expect(body).toContain('runSilently');
    // The gate-missing branch must NOT call `this.controls.update()`.
    // The only call in the helper body lives inside the
    // `runSilently(() => this.controls.update())` callback, which
    // executes only when the gate is present.
    const callCount = (body.match(/this\.controls\.update\(\)/g) ?? []).length;
    expect(
      callCount,
      'fail-closed invariant: _updateControlsSilently must not call controls.update() outside runSilently',
    ).toBe(1); // the one inside the runSilently callback
  });

  it('Renderer actually wires the shared gate (no test-local copy)', async () => {
    // **Intentionally brittle** source-text guard. Locks the
    // production wiring for cases where `new Renderer(...)` cannot
    // run in a unit test (requires WebGL + DOM — see
    // renderer-append.test.ts:4–8). A failure here does NOT mean
    // the gate behavior is broken — the semantic tests above cover
    // that. It means the renderer's TEXTUAL import / callsite
    // pattern changed, and the new form needs a fresh check so the
    // self-cooldown loop cannot silently return.
    const fs = await import('fs');
    const source = fs.readFileSync('lab/js/renderer.ts', 'utf-8');

    expect(
      source,
      'renderer must import the shared camera-interaction-gate module',
    ).toContain("from '../../src/camera/camera-interaction-gate'");

    expect(
      source,
      'renderer must instantiate the gate via createCameraInteractionGate()',
    ).toContain('createCameraInteractionGate');

    expect(
      source,
      'renderer must route programmatic controls.update() through gate.runSilently()',
    ).toContain('runSilently');

    // All direct `this.controls.update()` callsites must route
    // through the silent helper. Exactly one remains — inside
    // `_updateControlsSilently()`'s `runSilently(() => ...)` callback
    // (no semicolon). Count `this.controls.update(` — catches both
    // the statement form and the expression form. Excludes the
    // JSDoc reference at line 1620 via the open-paren match.
    // Docstring mentions `this.controls.update()` inside a string
    // comment, so split on code-vs-comment to count only in code.
    const codeOnly = source
      .split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    const callCount = (codeOnly.match(/this\.controls\.update\(/g) ?? []).length;
    expect(
      callCount,
      `expected exactly one \`this.controls.update(\` call site (inside _updateControlsSilently's runSilently callback), found ${callCount}. ` +
        'Every new programmatic update must go through the silent helper to preserve the source-attribution invariant.',
    ).toBe(1);
  });

  it('reset() puts the gate back to idle', () => {
    const controls = new FakeControls();
    const emit = vi.fn();
    const gate = wire(controls, emit);

    controls.beginUserGesture(); // userActive=true
    emit.mockClear();
    gate.reset();

    // After reset, a stray change should NOT emit (userActive was cleared).
    controls.dispatchRaw('change');
    expect(emit).not.toHaveBeenCalled();
  });
});
