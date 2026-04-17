/**
 * Unit tests for Phase 1B focus-aware pivot.
 *
 * Part A: Store contract tests (setters, reset).
 * Part B: Behavioral tests (handleCommand calls focusMoleculeForAtom on all start modes).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../lab/js/store/app-store';
import { handleCommand } from '../../lab/js/interaction';

describe('Focus-aware pivot — store contract', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('lastFocusedMoleculeId defaults to null', () => {
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });

  it('setLastFocusedMoleculeId sets the id', () => {
    useAppStore.getState().setLastFocusedMoleculeId(42);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(42);
  });

  it('setLastFocusedMoleculeId can clear to null', () => {
    useAppStore.getState().setLastFocusedMoleculeId(7);
    useAppStore.getState().setLastFocusedMoleculeId(null);
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });

  it('resetTransientState clears lastFocusedMoleculeId', () => {
    useAppStore.getState().setLastFocusedMoleculeId(99);
    useAppStore.getState().resetTransientState();
    expect(useAppStore.getState().lastFocusedMoleculeId).toBeNull();
  });
});

describe('Focus-aware pivot — handleCommand behavior', () => {
  function makeMockDeps() {
    const focusMoleculeForAtom = vi.fn();
    return {
      physics: {
        startDrag: vi.fn(),
        startTranslate: vi.fn(),
        startRotateDrag: vi.fn(),
        updateDrag: vi.fn(),
        endDrag: vi.fn(),
        applyImpulse: vi.fn(),
      } as any,
      renderer: {
        setHighlight: vi.fn(),
        showForceLine: vi.fn(),
        clearFeedback: vi.fn(),
        getAtomWorldPosition: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
      } as any,
      stateMachine: {
        getSelectedAtom: vi.fn(() => 0),
      } as any,
      inputManager: {
        screenToWorldOnAtomPlane: vi.fn(() => [0, 0, 0]),
      } as any,
      updateStatus: vi.fn(),
      updateSceneStatus: vi.fn(),
      focusMoleculeForAtom,
    };
  }

  it('startDrag calls focusMoleculeForAtom with the atom index', () => {
    const deps = makeMockDeps();
    handleCommand({ action: 'startDrag', atom: 5 } as any, undefined, undefined, deps);
    expect(deps.focusMoleculeForAtom).toHaveBeenCalledWith(5);
  });

  it('startMove calls focusMoleculeForAtom with the atom index', () => {
    const deps = makeMockDeps();
    handleCommand({ action: 'startMove', atom: 12 } as any, undefined, undefined, deps);
    expect(deps.focusMoleculeForAtom).toHaveBeenCalledWith(12);
  });

  it('startRotate calls focusMoleculeForAtom with the atom index', () => {
    const deps = makeMockDeps();
    handleCommand({ action: 'startRotate', atom: 30 } as any, undefined, undefined, deps);
    expect(deps.focusMoleculeForAtom).toHaveBeenCalledWith(30);
  });

  it('endDrag does NOT call focusMoleculeForAtom', () => {
    const deps = makeMockDeps();
    handleCommand({ action: 'endDrag' } as any, undefined, undefined, deps);
    expect(deps.focusMoleculeForAtom).not.toHaveBeenCalled();
  });

  it('highlight does NOT call focusMoleculeForAtom', () => {
    const deps = makeMockDeps();
    handleCommand({ action: 'highlight', atom: 0 } as any, undefined, undefined, deps);
    expect(deps.focusMoleculeForAtom).not.toHaveBeenCalled();
  });
});
