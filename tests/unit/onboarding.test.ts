/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for the onboarding controller (Phase 4).
 *
 * Tests scheduling, pacing, persistence, and achievement-triggered coachmarks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock matchMedia before importing onboarding (uses CONFIG.isTouchInteraction)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: query === '(pointer: coarse)', // simulate touch device
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

import { createOnboardingController, type OnboardingController } from '../../page/js/runtime/onboarding';
import { useAppStore } from '../../page/js/store/app-store';

function makeSurface() {
  return {
    showCoachmark: vi.fn(),
    hideCoachmark: vi.fn(),
    dismissCoachmark: vi.fn(),
  };
}

function makeRenderer() {
  return {
    pulseTriad: vi.fn(),
  };
}

describe('onboarding controller', () => {
  let surface: ReturnType<typeof makeSurface>;
  let renderer: ReturnType<typeof makeRenderer>;
  let controller: OnboardingController;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    useAppStore.getState().resetTransientState();
    // Set atomCount > 0 so isIdle() passes
    useAppStore.getState().updateAtomCount(10);
    surface = makeSurface();
    renderer = makeRenderer();
  });

  afterEach(() => {
    controller?.destroy();
    vi.useRealTimers();
  });

  function createController() {
    controller = createOnboardingController({
      getSurface: () => surface,
      getRenderer: () => renderer,
      isAppRunning: () => true,
    });
    return controller;
  }

  // ── Phase 4A: Initial coachmarks ──

  describe('initial coachmarks', () => {
    it('schedules v1 coachmark on first mobile session', () => {
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(3000);
      expect(surface.showCoachmark).toHaveBeenCalledWith({
        id: 'mobile-orbit',
        text: 'Drag triad to rotate view',
      });
      expect(renderer.pulseTriad).toHaveBeenCalled();
      expect(localStorage.getItem('mobile-orbit-v1')).toBe('1');
    });

    it('schedules v2 coachmark when v1 already shown', () => {
      localStorage.setItem('mobile-orbit-v1', '1');
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(5000);
      expect(surface.showCoachmark).toHaveBeenCalledWith({
        id: 'mobile-orbit-v2',
        text: 'Drag triad anytime \u00B7 Drag clear background when available',
      });
    });

    it('does not schedule when both already shown', () => {
      localStorage.setItem('mobile-orbit-v1', '1');
      localStorage.setItem('mobile-orbit-v2', '1');
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(10000);
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });

    it('auto-hides after displayMs', () => {
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(3000); // show
      expect(surface.showCoachmark).toHaveBeenCalled();

      vi.advanceTimersByTime(4000); // hide after displayMs
      expect(surface.hideCoachmark).toHaveBeenCalledWith('mobile-orbit');
    });

    it('cancels if user interacts before delay', () => {
      createController();
      controller.scheduleInitialCoachmarks();

      // Simulate user interaction before delay
      document.dispatchEvent(new Event('pointerdown'));
      vi.advanceTimersByTime(5000);

      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });

    it('does not show when placement is active', () => {
      useAppStore.getState().setPlacementActive(true);
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(5000);
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });

    it('does not show when atom count is 0', () => {
      useAppStore.getState().updateAtomCount(0);
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(5000);
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });
  });

  // ── Phase 4B: Achievement-triggered coachmarks ──

  describe('achievement-triggered coachmarks', () => {
    it('orbit-drag achievement triggers snap hint', () => {
      localStorage.setItem('mobile-orbit-v1', '1');
      localStorage.setItem('mobile-orbit-v2', '1');
      createController();

      controller.recordAchievement('orbit-drag');
      vi.advanceTimersByTime(2000);

      expect(surface.showCoachmark).toHaveBeenCalledWith({
        id: 'snap-hint',
        text: 'Tap an axis end on the triad to snap to that view',
      });
      expect(localStorage.getItem('coachmark-snap-hint')).toBe('1');
    });

    it('axis-snap achievement triggers reset hint', () => {
      createController();
      controller.recordAchievement('axis-snap');
      vi.advanceTimersByTime(2000);

      expect(surface.showCoachmark).toHaveBeenCalledWith({
        id: 'reset-hint',
        text: 'Double-tap the triad center to reset your view',
      });
    });

    it('mode-entry achievement triggers focus-select hint', () => {
      createController();
      controller.recordAchievement('mode-entry');
      vi.advanceTimersByTime(3000);

      expect(surface.showCoachmark).toHaveBeenCalledWith({
        id: 'freelook-target',
        text: 'Tap a molecule to mark it as your orbit target',
      });
    });

    it('max-one-per-session pacing: second achievement does not schedule', () => {
      createController();

      controller.recordAchievement('orbit-drag');
      vi.advanceTimersByTime(2000);
      expect(surface.showCoachmark).toHaveBeenCalledTimes(1);

      surface.showCoachmark.mockClear();
      controller.recordAchievement('axis-snap');
      vi.advanceTimersByTime(5000);
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });

    it('does not schedule if coachmark already shown (localStorage)', () => {
      localStorage.setItem('coachmark-snap-hint', '1');
      createController();

      controller.recordAchievement('orbit-drag');
      vi.advanceTimersByTime(5000);
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });
  });

  // ── Pacing race: multiple achievements before first fires ──

  describe('pacing race prevention', () => {
    it('second achievement before first timer fires only queues one coachmark', () => {
      createController();

      controller.recordAchievement('orbit-drag'); // queues snap-hint at 2000ms
      vi.advanceTimersByTime(500);
      controller.recordAchievement('axis-snap');   // should replace pending snap-hint with reset-hint

      vi.advanceTimersByTime(2000);
      // Only the second (reset-hint) should fire, not both
      expect(surface.showCoachmark).toHaveBeenCalledTimes(1);
      expect(surface.showCoachmark).toHaveBeenCalledWith({
        id: 'reset-hint',
        text: 'Double-tap the triad center to reset your view',
      });
    });
  });

  // ── Idle gate: camera help and pick-focus ──

  describe('idle gate for camera UI states', () => {
    it('does not show when cameraHelpOpen is true', () => {
      useAppStore.getState().setCameraHelpOpen(true);
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(5000);
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });

    it('does not show when pickFocusActive is true', () => {
      useAppStore.getState().setPickFocusActive(true);
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(5000);
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });
  });

  // ── Overlay dismiss ──

  describe('dismissActive', () => {
    it('dismisses an active onboarding coachmark', () => {
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(3000); // show v1
      expect(surface.showCoachmark).toHaveBeenCalled();

      controller.dismissActive();
      // Uses dismissCoachmark (not hideCoachmark) — clears hint entirely
      expect(surface.dismissCoachmark).toHaveBeenCalledWith('mobile-orbit');
      expect(surface.hideCoachmark).not.toHaveBeenCalledWith('mobile-orbit');
    });

    it('clears pending timer before it fires', () => {
      createController();
      controller.scheduleInitialCoachmarks();

      vi.advanceTimersByTime(1000); // pending, not yet shown
      controller.dismissActive();

      vi.advanceTimersByTime(5000); // should not fire
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });
  });

  // ── Teardown ──

  describe('destroy', () => {
    it('clears pending timers', () => {
      createController();
      controller.scheduleInitialCoachmarks();
      controller.destroy();

      vi.advanceTimersByTime(10000);
      expect(surface.showCoachmark).not.toHaveBeenCalled();
    });
  });
});

// ── Achievement source wiring (input-bindings seam) ──
// Tests that the triad source wrappers in input-bindings emit achievements
// with correct mode-gating. Uses the real createInputBindings with mocked deps.

import { createInputBindings } from '../../page/js/runtime/input-bindings';
import { CONFIG } from '../../page/js/config';
import * as THREE from 'three';

describe('achievement source wiring (input-bindings)', () => {
  let achievementLog: string[];
  const savedFlag = CONFIG.camera.freeLookEnabled;

  beforeEach(() => {
    (CONFIG.camera as any).freeLookEnabled = true; // enable for Free-Look tests
    vi.useRealTimers();
    localStorage.clear();
    useAppStore.getState().resetTransientState();
    achievementLog = [];
  });

  afterEach(() => {
    (CONFIG.camera as any).freeLookEnabled = savedFlag;
  });

  function makeBindingsDeps() {
    return {
      getRenderer: () => ({
        getCanvas: () => document.createElement('canvas'),
        camera: new THREE.PerspectiveCamera(),
        isInsideTriad: () => false,
        applyOrbitDelta: vi.fn(),
        applyFreeLookDelta: vi.fn(),
        applyFreeLookZoom: vi.fn(),
        applyFreeLookTranslate: vi.fn(),
        startBackgroundOrbitCue: vi.fn(),
        endBackgroundOrbitCue: vi.fn(),
        getNearestAxisEndpoint: vi.fn(() => null),
        snapToAxis: vi.fn(),
        animatedResetView: vi.fn(),
        showAxisHighlight: vi.fn(),
        resetOrientation: vi.fn(),
        getMoleculeCentroid: vi.fn(() => null),
        setCameraFocusTarget: vi.fn(),
      }) as any,
      getPlacement: () => null,
      getStateMachine: () => ({ onPointerOverAtom: vi.fn(), onPointerOutAtom: vi.fn() }) as any,
      getSessionInteractionMode: () => 'atom',
      dispatch: vi.fn(),
      onAchievement: (key: any) => { achievementLog.push(key); },
    };
  }

  it('background orbit end in Orbit records orbit-drag', () => {
    useAppStore.getState().setCameraMode('orbit');
    const deps = makeBindingsDeps();
    const bindings = createInputBindings(deps);
    bindings.sync(); // creates manager + wires triad source
    const manager = bindings.getManager()!;

    // Simulate background orbit end via the triad source
    manager._triadSource?.onBackgroundOrbitEnd?.();

    expect(achievementLog).toContain('orbit-drag');
    bindings.destroy();
  });

  it('background orbit end in Free-Look does NOT record orbit-drag', () => {
    useAppStore.getState().setCameraMode('freelook');
    const deps = makeBindingsDeps();
    const bindings = createInputBindings(deps);
    bindings.sync();
    const manager = bindings.getManager()!;

    manager._triadSource?.onBackgroundOrbitEnd?.();

    expect(achievementLog).not.toContain('orbit-drag');
    bindings.destroy();
  });

  it('triad drag end in Orbit records orbit-drag', () => {
    useAppStore.getState().setCameraMode('orbit');
    const deps = makeBindingsDeps();
    const bindings = createInputBindings(deps);
    bindings.sync();
    const manager = bindings.getManager()!;

    manager._triadSource?.onTriadDragEnd?.();

    expect(achievementLog).toContain('orbit-drag');
    bindings.destroy();
  });

  it('triad drag end in Free-Look does NOT record orbit-drag', () => {
    useAppStore.getState().setCameraMode('freelook');
    const deps = makeBindingsDeps();
    const bindings = createInputBindings(deps);
    bindings.sync();
    const manager = bindings.getManager()!;

    manager._triadSource?.onTriadDragEnd?.();

    expect(achievementLog).not.toContain('orbit-drag');
    bindings.destroy();
  });
});
