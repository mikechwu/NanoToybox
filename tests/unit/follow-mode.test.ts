/**
 * Tests for orbit follow-mode latch behavior.
 *
 * - Short tap → one-shot center (follow stays off)
 * - Long press → follow enabled after release (latch)
 * - Next tap → follow disabled
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useAppStore } from '../../page/js/store/app-store';
import { CONFIG } from '../../page/js/config';

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
    const { focusMoleculeByAtom } = await import('../../page/js/runtime/focus-runtime');
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
    const { focusMoleculeByAtom } = await import('../../page/js/runtime/focus-runtime');
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

// ── Gesture latch logic (mirrors CameraControls pointer behavior) ──

describe('follow mode gesture latch', () => {
  let wasLongPress: boolean;
  let activatedByCurrentPress: boolean;
  let centerCalled: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.getState().resetTransientState();
    wasLongPress = false;
    activatedByCurrentPress = false;
    centerCalled = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Mirror the CameraControls pointer logic as a pure state machine
  function pointerDown() {
    activatedByCurrentPress = false;
    if (useAppStore.getState().orbitFollowEnabled) return; // already active
    wasLongPress = false;
    // Start long-press timer
    setTimeout(() => {
      wasLongPress = true;
      activatedByCurrentPress = true;
      useAppStore.getState().setOrbitFollowEnabled(true);
    }, CONFIG.camera.followLongPressMs);
  }

  function pointerUp() {
    vi.clearAllTimers(); // cancel any pending timer
    if (activatedByCurrentPress) {
      activatedByCurrentPress = false;
      return; // latch: don't disable on same gesture
    }
    if (useAppStore.getState().orbitFollowEnabled) {
      useAppStore.getState().setOrbitFollowEnabled(false);
      return;
    }
    if (!wasLongPress) {
      centerCalled = true;
    }
  }

  it('short tap → center, follow stays off', () => {
    pointerDown();
    vi.advanceTimersByTime(100); // well below threshold
    pointerUp();

    expect(centerCalled).toBe(true);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });

  it('long press → follow enabled, release does NOT disable', () => {
    pointerDown();
    vi.advanceTimersByTime(CONFIG.camera.followLongPressMs + 50);
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);

    pointerUp(); // same gesture — latch prevents disable
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);
    expect(centerCalled).toBe(false);
  });

  it('next tap after long-press → follow disabled', () => {
    // First: enable via long press
    pointerDown();
    vi.advanceTimersByTime(CONFIG.camera.followLongPressMs + 50);
    pointerUp();
    expect(useAppStore.getState().orbitFollowEnabled).toBe(true);

    // Second: tap to disable
    pointerDown();
    pointerUp();
    expect(useAppStore.getState().orbitFollowEnabled).toBe(false);
  });
});
