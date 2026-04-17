/**
 * @vitest-environment jsdom
 */
/**
 * Unit tests for the Lab arrival pill (plan §7.2).
 *
 * Covers:
 *   - All four copy variants from the §9.5 copy table (shared × local,
 *     exact × approximated velocities)
 *   - frameId elision when the source didn't resolve a dense-frame index
 *   - Auto-dismiss after 8000 ms
 *   - Explicit close button clears the slot AND persists session
 *     suppression (so a refresh doesn't re-show)
 *   - Suppression key already set → pill is immediately hidden
 *   - Secrecy invariants: raw fileName / shareCode never appear in the
 *     rendered DOM (§7.2 non-disclosure rule)
 *   - ARIA wiring (role=status + aria-live=polite + aria-atomic=true)
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import {
  WatchHandoffProvenancePill,
  formatProvenancePillCopy,
} from '../../lab/js/components/WatchHandoffProvenancePill';
import { useAppStore } from '../../lab/js/store/app-store';

const SUPPRESS_KEY_PREFIX = 'atomdojo.watchHandoffPillDismissed:';

function clearSuppressionKeys(): void {
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const k = sessionStorage.key(i);
    if (k && k.startsWith(SUPPRESS_KEY_PREFIX)) sessionStorage.removeItem(k);
  }
}

describe('formatProvenancePillCopy — §9.5 copy table', () => {
  // Rendered `frame N` is 1-based ordinal; stored `frameId` is the
  // zero-based internal dense-frame index. So `frameId: 411` renders
  // as "frame 412" (matching the plan's §9.5 example).
  it('local + exact: "From Watch · frame 412 · 3.42 ps"', () => {
    expect(formatProvenancePillCopy({
      isSharedScene: false, timePs: 3.42, frameId: 411, velocitiesAreApproximated: false,
    })).toBe('From Watch · frame 412 · 3.42 ps');
  });

  it('local + approximated: appends " · creative seed"', () => {
    expect(formatProvenancePillCopy({
      isSharedScene: false, timePs: 3.42, frameId: 411, velocitiesAreApproximated: true,
    })).toBe('From Watch · frame 412 · 3.42 ps · creative seed');
  });

  it('shared + exact: "From shared scene · frame 412 · 3.42 ps"', () => {
    expect(formatProvenancePillCopy({
      isSharedScene: true, timePs: 3.42, frameId: 411, velocitiesAreApproximated: false,
    })).toBe('From shared scene · frame 412 · 3.42 ps');
  });

  it('shared + approximated: appends " · creative seed"', () => {
    expect(formatProvenancePillCopy({
      isSharedScene: true, timePs: 3.42, frameId: 411, velocitiesAreApproximated: true,
    })).toBe('From shared scene · frame 412 · 3.42 ps · creative seed');
  });

  it('frame numbering is 1-based ordinal (stored zero-based `frameId: 0` renders as "frame 1")', () => {
    // This is the explicit convention regression test. "frame 0" in
    // an arrival pill would read as "before playback started" and
    // mislead a user who just clicked Remix on the very first frame.
    expect(formatProvenancePillCopy({
      isSharedScene: false, timePs: 0, frameId: 0, velocitiesAreApproximated: false,
    })).toBe('From Watch · frame 1 · 0.00 ps');
    expect(formatProvenancePillCopy({
      isSharedScene: false, timePs: 0.001, frameId: 1, velocitiesAreApproximated: false,
    })).toBe('From Watch · frame 2 · 0.00 ps');
  });

  it('null frameId elides the "frame N" segment (never renders "frame null" / "frame ?")', () => {
    const s = formatProvenancePillCopy({
      isSharedScene: false, timePs: 1.23, frameId: null, velocitiesAreApproximated: false,
    });
    expect(s).toBe('From Watch · 1.23 ps');
    expect(s).not.toMatch(/frame/);
  });

  it('timePs always renders with two-decimal precision', () => {
    expect(formatProvenancePillCopy({
      isSharedScene: false, timePs: 1, frameId: 0, velocitiesAreApproximated: false,
    })).toBe('From Watch · frame 1 · 1.00 ps');
    expect(formatProvenancePillCopy({
      isSharedScene: false, timePs: 0.0049, frameId: 0, velocitiesAreApproximated: false,
    })).toBe('From Watch · frame 1 · 0.00 ps');
  });
});

describe('WatchHandoffProvenancePill component', () => {
  beforeEach(() => {
    clearSuppressionKeys();
    // Reset store slot between tests.
    useAppStore.getState().setWatchHandoffProvenance(null);
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    clearSuppressionKeys();
    useAppStore.getState().setWatchHandoffProvenance(null);
  });

  it('renders nothing when provenance is null (plain Lab boot path)', () => {
    const { container } = render(<WatchHandoffProvenancePill />);
    expect(container.querySelector('[data-handoff-provenance-root]')).toBeNull();
  });

  it('renders with the correct variant copy when provenance is set', () => {
    const { container } = render(<WatchHandoffProvenancePill />);
    act(() => {
      useAppStore.getState().setWatchHandoffProvenance({
        isSharedScene: true,
        timePs: 2.71,
        // Stored zero-based → rendered 1-based ordinal.
        frameId: 99,
        velocitiesAreApproximated: true,
        token: 'tok-1',
      });
    });
    const root = container.querySelector('[data-handoff-provenance-root]');
    expect(root).not.toBeNull();
    expect(root?.textContent).toContain('From shared scene · frame 100 · 2.71 ps · creative seed');
  });

  it('has role=status + aria-live=polite + aria-atomic=true', () => {
    const { container } = render(<WatchHandoffProvenancePill />);
    act(() => {
      useAppStore.getState().setWatchHandoffProvenance({
        isSharedScene: false, timePs: 1, frameId: 0, velocitiesAreApproximated: false, token: 'tok-aria',
      });
    });
    const root = container.querySelector('[data-handoff-provenance-root]') as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root!.getAttribute('role')).toBe('status');
    expect(root!.getAttribute('aria-live')).toBe('polite');
    expect(root!.getAttribute('aria-atomic')).toBe('true');
  });

  it('auto-dismisses after 8000 ms', () => {
    const { container } = render(<WatchHandoffProvenancePill />);
    act(() => {
      useAppStore.getState().setWatchHandoffProvenance({
        isSharedScene: false, timePs: 1, frameId: 0, velocitiesAreApproximated: false, token: 'tok-auto',
      });
    });
    expect(container.querySelector('[data-handoff-provenance-root]')).not.toBeNull();
    // Just before the boundary — still visible.
    act(() => { vi.advanceTimersByTime(7999); });
    expect(container.querySelector('[data-handoff-provenance-root]')).not.toBeNull();
    // Cross the boundary — gone.
    act(() => { vi.advanceTimersByTime(2); });
    expect(container.querySelector('[data-handoff-provenance-root]')).toBeNull();
  });

  it('auto-dismiss does NOT set the session-suppression flag (only explicit close does)', () => {
    render(<WatchHandoffProvenancePill />);
    act(() => {
      useAppStore.getState().setWatchHandoffProvenance({
        isSharedScene: false, timePs: 1, frameId: 0, velocitiesAreApproximated: false, token: 'tok-auto-no-suppress',
      });
    });
    act(() => { vi.advanceTimersByTime(8001); });
    expect(sessionStorage.getItem(`${SUPPRESS_KEY_PREFIX}tok-auto-no-suppress`)).toBeNull();
  });

  it('explicit close button clears the slot AND persists session suppression', () => {
    const { container } = render(<WatchHandoffProvenancePill />);
    act(() => {
      useAppStore.getState().setWatchHandoffProvenance({
        isSharedScene: false, timePs: 1, frameId: 0, velocitiesAreApproximated: false, token: 'tok-close',
      });
    });
    const btn = container.querySelector('.watch-handoff-provenance-pill__close') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-label')).toBe('Dismiss notice');
    act(() => { btn!.click(); });
    expect(container.querySelector('[data-handoff-provenance-root]')).toBeNull();
    expect(sessionStorage.getItem(`${SUPPRESS_KEY_PREFIX}tok-close`)).toBe('1');
  });

  it('previously-dismissed token is immediately cleared without rendering', () => {
    // Pre-seed the suppression flag — simulates a refresh after the
    // user explicitly closed the pill earlier in the same session.
    sessionStorage.setItem(`${SUPPRESS_KEY_PREFIX}tok-already-closed`, '1');
    const { container } = render(<WatchHandoffProvenancePill />);
    act(() => {
      useAppStore.getState().setWatchHandoffProvenance({
        isSharedScene: false, timePs: 1, frameId: 0, velocitiesAreApproximated: false, token: 'tok-already-closed',
      });
    });
    // The effect clears the slot on next tick; after flush, nothing rendered.
    act(() => { vi.advanceTimersByTime(0); });
    expect(container.querySelector('[data-handoff-provenance-root]')).toBeNull();
    // And the slot is null now.
    expect(useAppStore.getState().watchHandoffProvenance).toBeNull();
  });

  it('secrecy: rendered DOM must NOT echo the raw token, share code, or filename (§7.2)', () => {
    const { container } = render(<WatchHandoffProvenancePill />);
    act(() => {
      useAppStore.getState().setWatchHandoffProvenance({
        isSharedScene: true,
        timePs: 1,
        frameId: 0,
        velocitiesAreApproximated: false,
        token: 'secret-token-deadbeef',
      });
    });
    const dom = container.innerHTML;
    expect(dom).not.toMatch(/secret-token-deadbeef/);
    // The copy never renders the shareCode or fileName since we only
    // store a boolean (`isSharedScene`) — sanity check the pill info
    // shape is not widened in the future without a test update.
    expect(dom).not.toMatch(/shareCode/i);
    expect(dom).not.toMatch(/fileName/i);
  });

  it('sessionStorage throwing does not break dismissal (private-mode resilience)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('insecure', 'SecurityError');
    });
    const { container } = render(<WatchHandoffProvenancePill />);
    act(() => {
      useAppStore.getState().setWatchHandoffProvenance({
        isSharedScene: false, timePs: 1, frameId: 0, velocitiesAreApproximated: false, token: 'tok-no-storage',
      });
    });
    const btn = container.querySelector('.watch-handoff-provenance-pill__close') as HTMLButtonElement;
    // Click must not throw even though sessionStorage.setItem is unavailable.
    act(() => { btn.click(); });
    expect(container.querySelector('[data-handoff-provenance-root]')).toBeNull();
    setItemSpy.mockRestore();
  });
});
