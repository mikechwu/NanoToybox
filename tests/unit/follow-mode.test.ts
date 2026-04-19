/**
 * Tests for orbit follow-mode behavior.
 *
 * - Direct toggle: Follow button enables/disables tracking
 * - Target freeze: interaction does not change target while following
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../lab/js/store/app-store';

describe('orbit follow mode store', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('defaults to disabled', () => {
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });

  it('setOrbitFollowEnabled toggles state', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);
    useAppStore.getState().setOrbitFollowEnabled(false);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });

  it('resetTransientState clears follow mode', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    useAppStore.getState().resetTransientState();
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });
});

describe('follow mode freezes target', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
    useAppStore.getState().setMolecules([
      { id: 1, name: 'C60', structureFile: 'c60.xyz', atomCount: 60, atomOffset: 0 },
      { id: 2, name: 'CNT', structureFile: 'cnt.xyz', atomCount: 100, atomOffset: 60 },
    ]);
    useAppStore.getState().setLastFocusedMoleculeId(1);
  });

  it('focusMoleculeByAtom updates target when follow is off', async () => {
    const { focusMoleculeByAtom } = await import('../../lab/js/runtime/camera/focus-runtime');
    const mockRenderer = {
      getMoleculeCentroid: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
      getMoleculeBounds: vi.fn(() => null),
      setCameraFocusTarget: vi.fn(),
      animateToFocusedObject: vi.fn(),
      camera: { position: { x: 0, y: 0, z: 15 } },
      getSceneRadius: () => 10,
    } as any;

    focusMoleculeByAtom(70, mockRenderer); // atom 70 → molecule 2
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(2);
  });

  it('focusMoleculeByAtom does NOT update target when follow is on', async () => {
    const { focusMoleculeByAtom } = await import('../../lab/js/runtime/camera/focus-runtime');
    useAppStore.getState().setOrbitFollowEnabled(true);

    const mockRenderer = {
      getMoleculeCentroid: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
      getMoleculeBounds: vi.fn(() => null),
      setCameraFocusTarget: vi.fn(),
      animateToFocusedObject: vi.fn(),
      camera: { position: { x: 0, y: 0, z: 15 } },
      getSceneRadius: () => 10,
    } as any;

    focusMoleculeByAtom(70, mockRenderer); // atom 70 → molecule 2
    // Target should NOT change — frozen while follow active
    expect(useAppStore.getState().lastFocusedMoleculeId).toBe(1);
  });
});

// ── Direct toggle (replaces old long-press gesture latch) ──

describe('follow mode direct toggle', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('toggle on: sets orbitFollowEnabled to true', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);
  });

  it('toggle off: sets orbitFollowEnabled to false', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    useAppStore.getState().setOrbitFollowEnabled(false);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });

  it('double toggle: off → on → off', () => {
    useAppStore.getState().setOrbitFollowEnabled(true);
    useAppStore.getState().setOrbitFollowEnabled(false);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });
});
