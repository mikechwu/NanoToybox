/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);
import {
  WatchLabEntryControl,
  LAB_ENTRY_PRIMARY_LABEL,
  LAB_ENTRY_SECONDARY_TITLE,
  LAB_ENTRY_CARET_LABEL,
  LAB_ENTRY_PRIMARY_DISABLED_REASON,
} from '../../watch/js/components/WatchLabEntryControl';

function makeProps(overrides: Partial<React.ComponentProps<typeof WatchLabEntryControl>> = {}) {
  return {
    enabled: true,
    currentFrameAvailable: false,
    plainLabHref: '/lab/',
    currentFrameLabHref: null,
    onOpenCurrentFrameLab: vi.fn(),
    ...overrides,
  };
}

// Open the caret popover so the secondary menu item becomes queryable.
function openMenu(): void {
  const caret = screen.getByRole('button', { name: LAB_ENTRY_CARET_LABEL });
  fireEvent.click(caret);
}

describe('WatchLabEntryControl — primary pill + caret menu', () => {
  it(`renders primary "${LAB_ENTRY_PRIMARY_LABEL}" and caret toggle when enabled`, () => {
    render(<WatchLabEntryControl {...makeProps({ currentFrameAvailable: true, currentFrameLabHref: '/lab/?x=1' })} />);
    expect(screen.getByLabelText(LAB_ENTRY_PRIMARY_LABEL)).toBeTruthy();
    expect(screen.getByRole('button', { name: LAB_ENTRY_CARET_LABEL })).toBeTruthy();
    // Secondary is gated behind the caret — not in DOM until menu opens.
    expect(screen.queryByText(LAB_ENTRY_SECONDARY_TITLE)).toBeNull();
  });

  it('renders nothing when disabled', () => {
    const { container } = render(<WatchLabEntryControl {...makeProps({ enabled: false })} />);
    expect(container.querySelector('.watch-lab-entry')).toBeNull();
  });

  it('group wrapper is role="group" with aria-label', () => {
    render(<WatchLabEntryControl {...makeProps({ currentFrameAvailable: true, currentFrameLabHref: '/lab/?x=1' })} />);
    const group = screen.getByRole('group');
    expect(group.getAttribute('aria-label')).toBe('Lab entry');
  });

  // ── Caret menu toggle ──

  it('clicking the caret reveals a disclosure popover + the secondary anchor', () => {
    // The popover is a disclosure (`aria-haspopup="true"` + `role="group"`),
    // NOT a menu — we deliberately don't commit to the full APG menu
    // keyboard model for a single-item dropdown.
    render(<WatchLabEntryControl {...makeProps({ currentFrameAvailable: true, currentFrameLabHref: '/lab/?x=1' })} />);
    const caret = screen.getByRole('button', { name: LAB_ENTRY_CARET_LABEL });
    expect(caret.getAttribute('aria-haspopup')).toBe('true');
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(LAB_ENTRY_SECONDARY_TITLE)).toBeTruthy();
    // The popover is labelled so SR users hear the caret's "More ways…"
    // as the group name when they tab into the disclosed content.
    const popover = screen.getByRole('group', { name: LAB_ENTRY_CARET_LABEL });
    expect(popover).toBeTruthy();
    // No `role="menu"` / `role="menuitem"` commitment.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('clicking the caret again closes the menu', () => {
    render(<WatchLabEntryControl {...makeProps({ currentFrameAvailable: true, currentFrameLabHref: '/lab/?x=1' })} />);
    const caret = screen.getByRole('button', { name: LAB_ENTRY_CARET_LABEL });
    fireEvent.click(caret);
    fireEvent.click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(LAB_ENTRY_SECONDARY_TITLE)).toBeNull();
  });

  it('Escape key closes the menu (focus returns to caret)', () => {
    render(<WatchLabEntryControl {...makeProps({ currentFrameAvailable: true, currentFrameLabHref: '/lab/?x=1' })} />);
    const caret = screen.getByRole('button', { name: LAB_ENTRY_CARET_LABEL });
    fireEvent.click(caret);
    expect(screen.queryByText(LAB_ENTRY_SECONDARY_TITLE)).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(LAB_ENTRY_SECONDARY_TITLE)).toBeNull();
  });

  it('outside-click closes the menu', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      render(<WatchLabEntryControl {...makeProps({ currentFrameAvailable: true, currentFrameLabHref: '/lab/?x=1' })} />);
      openMenu();
      expect(screen.queryByText(LAB_ENTRY_SECONDARY_TITLE)).not.toBeNull();
      fireEvent.pointerDown(outside);
      expect(screen.queryByText(LAB_ENTRY_SECONDARY_TITLE)).toBeNull();
    } finally {
      document.body.removeChild(outside);
    }
  });

  // ── Secondary ("New Empty Lab") — anchor-native navigation ──

  it('secondary anchor (inside menu) has the plain Lab href', () => {
    render(<WatchLabEntryControl {...makeProps({ plainLabHref: '/preview-xyz/lab/' })} />);
    openMenu();
    const anchor = screen.getByText(LAB_ENTRY_SECONDARY_TITLE).closest('a')!;
    expect(anchor.getAttribute('href')).toBe('/preview-xyz/lab/');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toMatch(/noopener.*noreferrer|noreferrer.*noopener/);
  });

  it('plain left-click on secondary: anchor-native (no preventDefault)', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    openMenu();
    const anchor = screen.getByText(LAB_ENTRY_SECONDARY_TITLE).closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('plain left-click on secondary: optional side-effect hook fires, still no preventDefault', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    openMenu();
    const anchor = screen.getByText(LAB_ENTRY_SECONDARY_TITLE).closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(ev);
    expect(onOpenPlainLab).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('⌘-click on secondary: no intercept (browser owns)', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    openMenu();
    const anchor = screen.getByText(LAB_ENTRY_SECONDARY_TITLE).closest('a')!;
    fireEvent.click(anchor, { metaKey: true, button: 0 });
    expect(onOpenPlainLab).not.toHaveBeenCalled();
  });

  it('middle-click on secondary: no intercept', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    openMenu();
    const anchor = screen.getByText(LAB_ENTRY_SECONDARY_TITLE).closest('a')!;
    fireEvent.click(anchor, { button: 1 });
    expect(onOpenPlainLab).not.toHaveBeenCalled();
  });

  // ── Primary ("Interact From Here") — controller-owned plain-click ──

  it('primary renders as ENABLED anchor with the current-frame href when frame is seedable', () => {
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?from=watch&handoff=t1',
        })}
      />,
    );
    const primary = screen.getByLabelText(LAB_ENTRY_PRIMARY_LABEL).closest('a, button')!;
    expect(primary.tagName).toBe('A');
    expect(primary.getAttribute('href')).toBe('/lab/?from=watch&handoff=t1');
    expect(primary.getAttribute('target')).toBe('_blank');
  });

  it('primary renders as DISABLED button with tooltip reason when frame is not seedable', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    const primary = screen.getByLabelText(new RegExp(LAB_ENTRY_PRIMARY_LABEL, 'i')).closest('a, button')!;
    expect(primary.tagName).toBe('BUTTON');
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    const expectedFragment = LAB_ENTRY_PRIMARY_DISABLED_REASON.slice(0, 12); // robust to copy tweaks
    expect(primary.getAttribute('title')).toContain(expectedFragment);
    expect(primary.getAttribute('aria-label')).toContain(expectedFragment);
  });

  it('plain left-click on primary: controller is SOLE nav owner (preventDefault + callback)', () => {
    const onOpenCurrentFrameLab = vi.fn();
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?x=1',
          onOpenCurrentFrameLab,
        })}
      />,
    );
    const primary = screen.getByLabelText(LAB_ENTRY_PRIMARY_LABEL).closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    primary.dispatchEvent(ev);
    expect(onOpenCurrentFrameLab).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('regression: plain-click on primary never produces two navigators', () => {
    const onOpenCurrentFrameLab = vi.fn();
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?x=1',
          onOpenCurrentFrameLab,
        })}
      />,
    );
    const primary = screen.getByLabelText(LAB_ENTRY_PRIMARY_LABEL).closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    primary.dispatchEvent(ev);
    expect(onOpenCurrentFrameLab).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('⌘-click on primary: native browser new-tab (cached href, no controller intercept)', () => {
    const onOpenCurrentFrameLab = vi.fn();
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?x=1',
          onOpenCurrentFrameLab,
        })}
      />,
    );
    const primary = screen.getByLabelText(LAB_ENTRY_PRIMARY_LABEL).closest('a')!;
    fireEvent.click(primary, { metaKey: true, button: 0 });
    expect(onOpenCurrentFrameLab).not.toHaveBeenCalled();
  });

  // ── Mint-on-intent: hover/focus fires onContinueIntent ──

  it('pointerenter on primary calls onContinueIntent when frame is seedable', () => {
    const onContinueIntent = vi.fn();
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?x=1',
          onContinueIntent,
        })}
      />,
    );
    const primary = screen.getByLabelText(LAB_ENTRY_PRIMARY_LABEL).closest('a')!;
    fireEvent.pointerEnter(primary);
    expect(onContinueIntent).toHaveBeenCalledTimes(1);
  });

  it('focus on primary calls onContinueIntent (keyboard intent)', () => {
    const onContinueIntent = vi.fn();
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?x=1',
          onContinueIntent,
        })}
      />,
    );
    const primary = screen.getByLabelText(LAB_ENTRY_PRIMARY_LABEL).closest('a')!;
    fireEvent.focus(primary);
    expect(onContinueIntent).toHaveBeenCalledTimes(1);
  });

  it('pointerleave on primary calls onContinueIdle (debounced cache invalidation)', () => {
    const onContinueIdle = vi.fn();
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?x=1',
          onContinueIdle,
        })}
      />,
    );
    const primary = screen.getByLabelText(LAB_ENTRY_PRIMARY_LABEL).closest('a')!;
    fireEvent.pointerLeave(primary);
    expect(onContinueIdle).toHaveBeenCalledTimes(1);
  });

  it('disabled primary does NOT fire onContinueIntent on hover (no mint when gated)', () => {
    const onContinueIntent = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onContinueIntent })} />);
    const primary = screen.getByLabelText(new RegExp(LAB_ENTRY_PRIMARY_LABEL, 'i')).closest('button')!;
    fireEvent.pointerEnter(primary);
    expect(onContinueIntent).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
//   Auto-cue (timeline halfway / end milestones)
// ──────────────────────────────────────────────────────────────────────
//
// `primaryAutoCueToken` flows from `WatchApp.tsx` → `useTimedCue` →
// `data-auto-cue` on the tooltip. Mobile visibility relies entirely
// on this attribute (see `watch/css/watch.css`'s coarse-pointer
// rule). These tests pin the DOM-state contract; CSS visibility on
// real devices is exercised by the Playwright spec.

describe('WatchLabEntryControl — auto-cue DOM state', () => {
  // Tooltip carries `role="tooltip"` (from JSX); accessing via role is
  // the idiomatic Testing-Library accessor and avoids a class-string cast.
  const getTooltip = () => screen.getByRole('tooltip');

  it('tooltip exists with role="tooltip" once the primary is enabled (idle = no data-auto-cue)', () => {
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?x=1',
          primaryAutoCueToken: 0,
        })}
      />,
    );
    // `getByRole('tooltip')` proves both presence and the role attribute.
    expect(getTooltip().hasAttribute('data-auto-cue')).toBe(false);
  });

  it('bumping primaryAutoCueToken sets data-auto-cue="true"; clears after the cue window', () => {
    vi.useFakeTimers();
    try {
      const props = makeProps({
        currentFrameAvailable: true,
        currentFrameLabHref: '/lab/?x=1',
        primaryAutoCueToken: 0,
      });
      const { rerender } = render(<WatchLabEntryControl {...props} />);
      expect(getTooltip().getAttribute('data-auto-cue')).toBeNull();

      // Distinct token → cue fires.
      act(() => {
        rerender(<WatchLabEntryControl {...props} primaryAutoCueToken={1} />);
      });
      expect(getTooltip().getAttribute('data-auto-cue')).toBe('true');

      // Window closes after the 5 s duration. Advance past it.
      act(() => { vi.advanceTimersByTime(6000); });
      expect(getTooltip().hasAttribute('data-auto-cue')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opening the caret menu during a cue suppresses data-auto-cue (one-popover-at-a-time)', () => {
    vi.useFakeTimers();
    try {
      const props = makeProps({
        currentFrameAvailable: true,
        currentFrameLabHref: '/lab/?x=1',
        primaryAutoCueToken: 0,
      });
      const { rerender } = render(<WatchLabEntryControl {...props} />);
      act(() => {
        rerender(<WatchLabEntryControl {...props} primaryAutoCueToken={1} />);
      });
      expect(getTooltip().getAttribute('data-auto-cue')).toBe('true');

      // Open the menu — same single instance the cue lives on, no
      // second WatchLabEntryControl rendered. The cue MUST be
      // suppressed so the tooltip and the menu cannot both show.
      act(() => { openMenu(); });
      expect(getTooltip().hasAttribute('data-auto-cue')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire on mount even when token is non-zero (parents may default-initialize)', () => {
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?x=1',
          primaryAutoCueToken: 7,
        })}
      />,
    );
    expect(getTooltip().hasAttribute('data-auto-cue')).toBe(false);
  });
});
