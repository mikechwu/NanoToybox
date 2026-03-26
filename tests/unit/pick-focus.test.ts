/**
 * Unit tests for pick-focus mode behavior.
 *
 * Tests: entering pick-focus, clearing on overlay close, clearing on help/sheet open,
 * and store-level pick-focus state management.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../page/js/store/app-store';

describe('Pick-focus mode store behavior', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('defaults to false', () => {
    expect(useAppStore.getState().pickFocusActive).toBe(false);
  });

  it('setPickFocusActive sets the flag', () => {
    useAppStore.getState().setPickFocusActive(true);
    expect(useAppStore.getState().pickFocusActive).toBe(true);
  });

  it('resetTransientState clears pick-focus', () => {
    useAppStore.getState().setPickFocusActive(true);
    useAppStore.getState().resetTransientState();
    expect(useAppStore.getState().pickFocusActive).toBe(false);
  });

  it('openSheet clears pick-focus', () => {
    useAppStore.getState().setPickFocusActive(true);
    useAppStore.getState().openSheet('settings');
    expect(useAppStore.getState().pickFocusActive).toBe(false);
  });

  it('setCameraHelpOpen(true) clears pick-focus', () => {
    useAppStore.getState().setPickFocusActive(true);
    useAppStore.getState().setCameraHelpOpen(true);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
  });

  it('setCameraHelpOpen(false) clears pick-focus', () => {
    useAppStore.getState().setPickFocusActive(true);
    useAppStore.getState().setCameraHelpOpen(false);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
  });

  it('openSheet closes camera help AND clears pick-focus', () => {
    useAppStore.getState().setCameraHelpOpen(true);
    useAppStore.getState().setPickFocusActive(true);
    useAppStore.getState().openSheet('chooser');
    expect(useAppStore.getState().cameraHelpOpen).toBe(false);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
    expect(useAppStore.getState().activeSheet).toBe('chooser');
  });

  it('setCameraHelpOpen(true) closes active sheet AND clears pick-focus', () => {
    useAppStore.getState().openSheet('settings');
    useAppStore.getState().setPickFocusActive(true);
    useAppStore.getState().setCameraHelpOpen(true);
    expect(useAppStore.getState().activeSheet).toBeNull();
    expect(useAppStore.getState().cameraHelpOpen).toBe(true);
    expect(useAppStore.getState().pickFocusActive).toBe(false);
  });
});
