/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { WatchLabEntryControl } from '../../watch/js/components/WatchLabEntryControl';

function makeProps(overrides: Partial<React.ComponentProps<typeof WatchLabEntryControl>> = {}) {
  return {
    enabled: true,
    currentFrameAvailable: false,
    plainLabHref: '/lab/',
    currentFrameLabHref: null,
    // onOpenPlainLab is OPTIONAL in production (primary anchor navigates
    // natively). Tests that want to observe the side-effect hook pass
    // a spy via overrides; default fixture leaves it unset so the
    // common-case assertion mirrors production wiring.
    onOpenCurrentFrameLab: vi.fn(),
    ...overrides,
  };
}

describe('WatchLabEntryControl — inline paired pills', () => {
  it('renders both primary (accessible name "Continue this frame in Lab") and secondary "Open Lab" when enabled', () => {
    render(<WatchLabEntryControl {...makeProps({ currentFrameAvailable: true, currentFrameLabHref: '/lab/?x=1' })} />);
    // Primary surfaces visually as the compact label "Continue" but the
    // accessible name is the full "Continue this frame in Lab" (via aria-label).
    expect(screen.getByLabelText(/continue this frame in lab/i)).toBeTruthy();
    expect(screen.getByText('Open Lab')).toBeTruthy();
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

  // ── Secondary: "Open Lab" — anchor-native navigation ──

  it('secondary anchor has the plain Lab href', () => {
    render(<WatchLabEntryControl {...makeProps({ plainLabHref: '/preview-xyz/lab/' })} />);
    const anchor = screen.getByText('Open Lab').closest('a')!;
    expect(anchor.getAttribute('href')).toBe('/preview-xyz/lab/');
    expect(anchor.getAttribute('target')).toBe('_blank');
  });

  it('plain left-click on secondary: anchor-native (no preventDefault, no navigator callback required)', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    const anchor = screen.getByText('Open Lab').closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(ev);
    // Critical: native navigation must not be suppressed.
    expect(ev.defaultPrevented).toBe(false);
  });

  it('plain left-click on secondary: optional side-effect hook fires, still no preventDefault', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    const anchor = screen.getByText('Open Lab').closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(ev);
    expect(onOpenPlainLab).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('⌘-click on secondary: no intercept (browser owns)', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    const anchor = screen.getByText('Open Lab').closest('a')!;
    fireEvent.click(anchor, { metaKey: true, button: 0 });
    expect(onOpenPlainLab).not.toHaveBeenCalled();
  });

  it('middle-click on secondary: no intercept', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    const anchor = screen.getByText('Open Lab').closest('a')!;
    fireEvent.click(anchor, { button: 1 });
    expect(onOpenPlainLab).not.toHaveBeenCalled();
  });

  // ── Primary: "Continue this frame in Lab" — controller-owned plain-click ──

  it('primary renders as ENABLED anchor with the current-frame href when frame is seedable', () => {
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?from=watch&handoff=t1',
        })}
      />,
    );
    // Primary surfaces visually as "Continue" (compact) but the
    // accessible name is "Continue this frame in Lab" (set via aria-label).
    // Fetch via accessible-name lookup so the assertion is agnostic
    // to the visible-vs-ARIA text split.
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a, button')!;
    expect(primary.tagName).toBe('A');
    expect(primary.getAttribute('href')).toBe('/lab/?from=watch&handoff=t1');
    expect(primary.getAttribute('target')).toBe('_blank');
  });

  it('primary renders as DISABLED button with tooltip reason when frame is not seedable', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    // Primary surfaces visually as "Continue" (compact) but the
    // accessible name is "Continue this frame in Lab" (set via aria-label).
    // Fetch via accessible-name lookup so the assertion is agnostic
    // to the visible-vs-ARIA text split.
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a, button')!;
    expect(primary.tagName).toBe('BUTTON');
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    // Reason surfaces via native `title` tooltip + accessible name.
    expect(primary.getAttribute('title')).toMatch(/can\u2019t be continued/i);
    expect(primary.getAttribute('aria-label')).toMatch(/can\u2019t be continued/i);
  });

  it('plain left-click on primary: controller is SOLE nav owner (preventDefault + callback)', () => {
    // Click-ownership invariant preserved from the split-button
    // design — the anchor's cached href can go stale if playback
    // advances between mint and click; only the controller's
    // remint-if-stale path is authoritative for plain-click.
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
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    primary.dispatchEvent(ev);
    expect(onOpenCurrentFrameLab).toHaveBeenCalledTimes(1);
    // Anchor's native nav MUST be suppressed. Otherwise plain-click
    // would open two tabs (anchor-native with cached href + controller
    // programmatic with remint result).
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
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    primary.dispatchEvent(ev);
    expect(onOpenCurrentFrameLab).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('⌘-click on primary: native browser new-tab (cached href, no controller intercept)', () => {
    // Modified click fall-through to the anchor's native path is the
    // documented escape hatch; the controller's mint-on-hover signal
    // ensures the cached href is populated before the user clicks.
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
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a')!;
    fireEvent.click(primary, { metaKey: true, button: 0 });
    expect(onOpenCurrentFrameLab).not.toHaveBeenCalled();
  });

  // ── Mint-on-intent: hover/focus fires onContinueIntent so the cached
  //    href is populated BEFORE the user clicks. Idle debounces via
  //    onContinueIdle. Gated on currentFrameAvailable so non-seedable
  //    frames don't trigger writes. ──

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
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a')!;
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
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a')!;
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
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a')!;
    fireEvent.pointerLeave(primary);
    expect(onContinueIdle).toHaveBeenCalledTimes(1);
  });

  it('disabled primary does NOT fire onContinueIntent on hover (no mint when gated)', () => {
    // Defence-in-depth: even if the UI shows the disabled primary,
    // hovering over it MUST NOT trigger a handoff-token mint. The
    // disabled button doesn't have the pointer handlers wired at all,
    // but asserting the invariant protects against a future regression
    // that puts the handlers on both branches.
    const onContinueIntent = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onContinueIntent })} />);
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('button')!;
    fireEvent.pointerEnter(primary);
    expect(onContinueIntent).not.toHaveBeenCalled();
  });
});
