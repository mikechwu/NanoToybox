/**
 * Unit tests for pick-focus mode store state.
 *
 * pickFocusActive is fully dormant — no active runtime code consults it.
 * These tests verify the store field still functions for potential future use.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../page/js/store/app-store';

describe('Pick-focus mode store behavior (dormant)', () => {
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

  // Note: openSheet and setCameraHelpOpen no longer clear pickFocusActive.
  // The field is fully dormant — no active runtime code consults it.
});
