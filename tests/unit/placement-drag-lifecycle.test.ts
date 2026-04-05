/**
 * Placement drag lifecycle — controller-path regression tests.
 *
 * Exercises the real PlacementController listener handlers through a canvas
 * mock with pointer capture tracking. Verifies:
 * - pointer capture acquired on pointerdown
 * - isDraggingPreview survives pointerleave
 * - pointerup releases capture and ends drag
 * - pointercancel releases capture and aborts drag
 * - updateDragFromLatestPointer still runs while drag remains active
 * - capture failure fallback: pointerleave aborts drag
 */
import { describe, it, expect, vi } from 'vitest';
import { PlacementController } from '../../lab/js/placement';

// ── Test infrastructure ──

/** Build a minimal canvas mock that records pointer capture and dispatches events. */
function mockCanvas() {
  let capturedId: number | null = null;
  const listeners: Record<string, ((e: any) => void)[]> = {};

  return {
    setPointerCapture: vi.fn((id: number) => { capturedId = id; }),
    releasePointerCapture: vi.fn((id: number) => { if (capturedId === id) capturedId = null; }),
    get capturedPointerId() { return capturedId; },
    addEventListener: vi.fn((type: string, fn: any) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    }),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => {} }),
    dispatch(type: string, event: any) {
      for (const fn of listeners[type] || []) fn(event);
    },
  };
}

/** Build a minimal renderer mock for PlacementController. */
function mockRenderer(canvas: ReturnType<typeof mockCanvas>) {
  return {
    getCanvas: () => canvas,
    getCameraState: () => ({
      position: [0, 0, 20] as [number, number, number],
      direction: [0, 0, -1] as [number, number, number],
      up: [0, 1, 0] as [number, number, number],
    }),
    getPreviewWorldCenter: () => [5, 0, 0],
    raycastPreview: vi.fn(() => ({ hit: true, worldPoint: [6, 1, 0] })),
    screenPointToRay: vi.fn(() => ({
      origin: [0, 0, 20] as [number, number, number],
      direction: [0.3, 0.05, -1] as [number, number, number],
    })),
    showPreview: vi.fn(),
    hidePreview: vi.fn(),
    updatePreviewOffset: vi.fn(),
    clearFeedback: vi.fn(),
    projectToNDC: () => [0, 0, 0] as [number, number, number],
  };
}

function syntheticPointerEvent(type: string, opts: Partial<PointerEvent> = {}): any {
  return {
    type, button: 0,
    pointerId: opts.pointerId ?? 1,
    clientX: opts.clientX ?? 400,
    clientY: opts.clientY ?? 300,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    ...opts,
  };
}

/**
 * Prepare a controller in "active placement with preview visible" state.
 * Centralizes all private-state seeding so individual tests don't touch internals.
 */
function setupActivePlacement(opts?: { canvasSetup?: (c: ReturnType<typeof mockCanvas>) => void }) {
  const canvas = mockCanvas();
  if (opts?.canvasSetup) opts.canvasSetup(canvas);
  const renderer = mockRenderer(canvas);
  const ctrl = new PlacementController({
    renderer: renderer as any,
    physics: { n: 0, pos: new Float64Array(0), getPosition: () => [0, 0, 0] } as any,
    stateMachine: {} as any,
    inputManager: { updateAtomSource: vi.fn() } as any,
    loadStructure: vi.fn(async () => ({ atoms: [], bonds: [] })),
    commands: {
      setDockPlacementMode: vi.fn(),
      commitToScene: vi.fn(),
      updateStatus: vi.fn(),
      updateSceneStatus: vi.fn(),
      forceIdle: vi.fn(),
      forceRender: vi.fn(),
      buildAtomSource: vi.fn(() => ({ count: 0, getWorldPosition: vi.fn(), raycastTarget: null })),
      getSceneMolecules: vi.fn(() => []),
    },
  });

  // Seed "active placement" state through one shared path
  (ctrl as any)._state.active = true;
  (ctrl as any)._state.basePreviewCenter = [5, 0, 0];
  (ctrl as any)._registerListeners();

  return { canvas, renderer, ctrl };
}

// ── Tests ──

describe('PlacementController drag lifecycle (controller-path)', () => {
  it('pointerdown acquires pointer capture', () => {
    const { canvas, ctrl } = setupActivePlacement();

    canvas.dispatch('pointerdown', syntheticPointerEvent('pointerdown', { pointerId: 42 }));

    expect(ctrl.isDraggingPreview).toBe(true);
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(42);
    expect(canvas.capturedPointerId).toBe(42);
  });

  it('pointerleave during drag does NOT clear isDraggingPreview', () => {
    const { canvas, ctrl } = setupActivePlacement();

    canvas.dispatch('pointerdown', syntheticPointerEvent('pointerdown', { pointerId: 1 }));
    expect(ctrl.isDraggingPreview).toBe(true);

    canvas.dispatch('pointerleave', syntheticPointerEvent('pointerleave'));

    expect(ctrl.isDraggingPreview).toBe(true);
    expect((ctrl as any)._state.lastPointerScreen).not.toBeNull();
  });

  it('pointerup releases capture and ends drag', () => {
    const { canvas, ctrl } = setupActivePlacement();

    canvas.dispatch('pointerdown', syntheticPointerEvent('pointerdown', { pointerId: 7 }));
    expect(ctrl.isDraggingPreview).toBe(true);
    expect(canvas.capturedPointerId).toBe(7);

    canvas.dispatch('pointerup', syntheticPointerEvent('pointerup', { pointerId: 7 }));
    expect(ctrl.isDraggingPreview).toBe(false);
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(canvas.capturedPointerId).toBeNull();
  });

  it('pointercancel releases capture and aborts drag', () => {
    const { canvas, ctrl } = setupActivePlacement();

    canvas.dispatch('pointerdown', syntheticPointerEvent('pointerdown', { pointerId: 3 }));
    expect(ctrl.isDraggingPreview).toBe(true);

    canvas.dispatch('pointercancel', syntheticPointerEvent('pointercancel', { pointerId: 3 }));
    expect(ctrl.isDraggingPreview).toBe(false);
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(3);
    expect(canvas.capturedPointerId).toBeNull();
  });

  it('updateDragFromLatestPointer runs while drag active', () => {
    const { canvas, renderer, ctrl } = setupActivePlacement();

    canvas.dispatch('pointerdown', syntheticPointerEvent('pointerdown', { pointerId: 1, clientX: 400, clientY: 300 }));
    canvas.dispatch('pointermove', syntheticPointerEvent('pointermove', { clientX: 410, clientY: 305 }));

    renderer.updatePreviewOffset.mockClear();
    ctrl.updateDragFromLatestPointer();
    expect(renderer.updatePreviewOffset).toHaveBeenCalledTimes(1);
  });

  it('capture failure: pointerleave aborts drag when setPointerCapture throws', () => {
    const { canvas, ctrl } = setupActivePlacement({
      canvasSetup: (c) => { c.setPointerCapture = vi.fn(() => { throw new Error('NotSupportedError'); }); },
    });

    canvas.dispatch('pointerdown', syntheticPointerEvent('pointerdown', { pointerId: 1 }));
    expect(ctrl.isDraggingPreview).toBe(true);
    expect((ctrl as any)._state.hasPointerCapture).toBe(false);
    expect((ctrl as any)._state.activePointerId).toBeNull();

    canvas.dispatch('pointerleave', syntheticPointerEvent('pointerleave'));
    expect(ctrl.isDraggingPreview).toBe(false);
  });

  it('capture success: pointerleave does NOT abort drag', () => {
    const { canvas, ctrl } = setupActivePlacement();

    canvas.dispatch('pointerdown', syntheticPointerEvent('pointerdown', { pointerId: 1 }));
    expect(ctrl.isDraggingPreview).toBe(true);
    expect((ctrl as any)._state.hasPointerCapture).toBe(true);

    canvas.dispatch('pointerleave', syntheticPointerEvent('pointerleave'));
    expect(ctrl.isDraggingPreview).toBe(true);
  });
});
