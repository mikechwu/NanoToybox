/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

afterEach(cleanup);
import { WatchLabEntryControl } from '../../watch/js/components/WatchLabEntryControl';
import { WatchLabHint, resolveHintPlacement } from '../../watch/js/components/WatchLabHint';

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

describe('WatchLabEntryControl', () => {
  it('renders primary anchor + caret when enabled', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    expect(screen.getByText('Open in Lab')).toBeTruthy();
    expect(screen.getByLabelText('More ways to open Lab')).toBeTruthy();
  });

  it('renders nothing when disabled', () => {
    const { container } = render(<WatchLabEntryControl {...makeProps({ enabled: false })} />);
    expect(container.querySelector('.watch-lab-entry')).toBeNull();
  });

  it('primary anchor has correct href', () => {
    render(<WatchLabEntryControl {...makeProps({ plainLabHref: '/preview-xyz/lab/' })} />);
    const anchor = screen.getByText('Open in Lab').closest('a')!;
    expect(anchor.getAttribute('href')).toBe('/preview-xyz/lab/');
  });

  it('unmodified left-click on primary: anchor-native navigation (no preventDefault)', () => {
    // Rev 7 (revised): anchor is SOLE nav owner. The component does
    // NOT preventDefault, so the browser's `target="_blank"` opens the
    // new tab. The optional `onOpenPlainLab` side-effect hook fires
    // only if wired — production omits it. Earlier revisions called
    // preventDefault + a controller nav hook, which either produced a
    // duplicate tab (without preventDefault) or a false-positive
    // popup-blocker banner (with preventDefault + noopener null-return).
    render(<WatchLabEntryControl {...makeProps()} />);
    const anchor = screen.getByText('Open in Lab').closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(ev);
    // Critical: native navigation must not be suppressed.
    expect(ev.defaultPrevented).toBe(false);
  });

  it('unmodified left-click on primary: optional side-effect hook fires when wired, still no preventDefault', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    const anchor = screen.getByText('Open in Lab').closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(ev);
    expect(onOpenPlainLab).toHaveBeenCalledTimes(1);
    // Hook fires, but navigation is STILL native — no preventDefault.
    expect(ev.defaultPrevented).toBe(false);
  });

  it('regression: single-owner primary click (no onOpenPlainLab wired, no other side effect)', () => {
    // Lock in the split-ownership contract at the component boundary.
    // Without a wired hook, the plain-click handler must do nothing
    // other than let the anchor navigate. Production WatchApp wiring
    // omits onOpenPlainLab for exactly this reason.
    const { container } = render(<WatchLabEntryControl {...makeProps()} />);
    const anchor = screen.getByText('Open in Lab').closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(container.querySelector('.watch-lab-entry')).toBeTruthy();
  });

  it('⌘-click (metaKey) does NOT intercept — browser handles it', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    const anchor = screen.getByText('Open in Lab').closest('a')!;
    fireEvent.click(anchor, { metaKey: true, button: 0 });
    expect(onOpenPlainLab).not.toHaveBeenCalled();
  });

  it('middle-click (button=1) does NOT intercept', () => {
    const onOpenPlainLab = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onOpenPlainLab })} />);
    const anchor = screen.getByText('Open in Lab').closest('a')!;
    fireEvent.click(anchor, { button: 1 });
    expect(onOpenPlainLab).not.toHaveBeenCalled();
  });

  it('opening the caret does NOT call onCaretOpen when currentFrameAvailable is false', () => {
    // Rev 7 follow-up P0 — UI hardening: defence-in-depth alongside the
    // controller's feature-flag guard. When the current-frame path is
    // unavailable (feature flag off, singleton capsule, etc.), opening
    // the dropdown must not notify the controller to mint a handoff
    // token. Visual disable + this no-mint hook together close the
    // side-effect surface while the item is gated.
    const onCaretOpen = vi.fn();
    render(<WatchLabEntryControl {...makeProps({ onCaretOpen })} />);
    const caret = screen.getByLabelText('More ways to open Lab');
    fireEvent.click(caret);
    // Dropdown still opens (to show the disabled caption).
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(onCaretOpen).not.toHaveBeenCalled();
  });

  it('opening the caret DOES call onCaretOpen when currentFrameAvailable is true', () => {
    const onCaretOpen = vi.fn();
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?from=watch&handoff=t1',
          onCaretOpen,
        })}
      />,
    );
    const caret = screen.getByLabelText('More ways to open Lab');
    fireEvent.click(caret);
    expect(onCaretOpen).toHaveBeenCalledTimes(1);
  });

  it('caret button toggles aria-expanded', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    const caret = screen.getByLabelText('More ways to open Lab');
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('true');
  });

  it('Arrow-Down on caret opens the dropdown', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    const caret = screen.getByLabelText('More ways to open Lab');
    caret.focus();
    fireEvent.keyDown(caret, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('Escape on open dropdown closes and refocuses caret', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    const caret = screen.getByLabelText('More ways to open Lab');
    caret.focus();
    fireEvent.keyDown(caret, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(caret);
  });

  it('dropdown renders DISABLED button + caption when currentFrameAvailable === false', () => {
    render(<WatchLabEntryControl {...makeProps()} />);
    const caret = screen.getByLabelText('More ways to open Lab');
    fireEvent.click(caret);
    // Disabled menuitem is a <button disabled role="menuitem">
    const item = screen.getByRole('menuitem');
    expect(item.tagName).toBe('BUTTON');
    expect((item as HTMLButtonElement).disabled).toBe(true);
    // Caption visible inline
    expect(screen.getByText('Not seedable from this frame')).toBeTruthy();
  });

  it('dropdown renders ENABLED anchor when currentFrameLabHref set', () => {
    render(
      <WatchLabEntryControl
        {...makeProps({
          currentFrameAvailable: true,
          currentFrameLabHref: '/lab/?from=watch&handoff=t1',
        })}
      />,
    );
    const caret = screen.getByLabelText('More ways to open Lab');
    fireEvent.click(caret);
    const item = screen.getByRole('menuitem');
    expect(item.tagName).toBe('A');
    expect(item.getAttribute('href')).toBe('/lab/?from=watch&handoff=t1');
  });

  it('unmodified click on enabled dropdown: controller is SOLE nav owner (preventDefault + callback, not anchor)', () => {
    // Rev 7 revised — current-frame ownership contract:
    //   plain left-click → preventDefault + onOpenCurrentFrameLab
    //   (controller remints if stale and calls window.open)
    // This is intentionally DIFFERENT from the primary path because
    // the current-frame href can go stale between menu-open and click;
    // only the controller has the remint logic. Locking the anchor's
    // navigation on plain-click prevents a race where the browser
    // follows the cached (potentially stale) URL before the controller
    // can re-mint.
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
    const caret = screen.getByLabelText('More ways to open Lab');
    fireEvent.click(caret);
    const item = screen.getByRole('menuitem');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    item.dispatchEvent(ev);
    expect(onOpenCurrentFrameLab).toHaveBeenCalledTimes(1);
    // Critical: anchor's native nav MUST be suppressed — controller
    // is the sole navigator. Without this, plain-click would open two
    // tabs (one anchor-native with the cached href, one controller-
    // programmatic with the remint result).
    expect(ev.defaultPrevented).toBe(true);
  });

  it('regression: plain-click on current-frame anchor never produces two navigators', () => {
    // Belt-and-suspenders check on the split-ownership contract.
    // Under the rev-7-revised rules, exactly one of the two paths
    // must own the plain click:
    //   primary       → native anchor, callback optional
    //   current-frame → controller callback, anchor suppressed
    // A spy that asserts the handler is called exactly once AND the
    // anchor was suppressed covers the duplicate-tab regression
    // path reported by the user.
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
    fireEvent.click(screen.getByLabelText('More ways to open Lab'));
    const item = screen.getByRole('menuitem');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    item.dispatchEvent(ev);
    // Exactly one navigator fired (the controller callback), and the
    // anchor's native nav was suppressed. No duplicate-tab path.
    expect(onOpenCurrentFrameLab).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('WatchLabHint', () => {
  it('renders nothing when hint is null', () => {
    const { container } = render(<WatchLabHint hint={null} onDismiss={vi.fn()} />);
    expect(container.querySelector('.watch-lab-hint')).toBeNull();
  });

  it('renders the message, role=status, aria-live=polite, aria-atomic', () => {
    render(<WatchLabHint hint={{ id: 'timeline_halfway', message: 'Play with the scene yourself →', tone: 'milestone' }} onDismiss={vi.fn()} />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.textContent).toContain('Play with the scene yourself');
  });

  it('close button calls onDismiss with the hint id', () => {
    const onDismiss = vi.fn();
    render(<WatchLabHint hint={{ id: 'timeline_halfway', message: 'x', tone: 'milestone' }} onDismiss={onDismiss} />);
    const close = screen.getByLabelText('Dismiss hint');
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledWith('timeline_halfway');
  });

  it('Escape dismisses the hint when no menu/dialog is focused', () => {
    const onDismiss = vi.fn();
    render(<WatchLabHint hint={{ id: 'timeline_halfway', message: 'x', tone: 'milestone' }} onDismiss={onDismiss} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('timeline_halfway');
  });

  it('Escape does NOT dismiss when focus is inside a menu (ancestry check)', () => {
    const onDismiss = vi.fn();
    render(
      <>
        <div role="menu">
          <button>menu item</button>
        </div>
        <WatchLabHint hint={{ id: 'timeline_halfway', message: 'x', tone: 'milestone' }} onDismiss={onDismiss} />
      </>,
    );
    const menuItem = screen.getByText('menu item');
    menuItem.focus();
    fireEvent.keyDown(menuItem, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('WatchLabHint placement — DOM integration (rev 6 follow-up P2)', () => {
  // JSDOM does not implement ResizeObserver. FakeRO captures the callback
  // so tests can invoke it directly — this matches production, where the
  // observer callback fires when the documentElement resizes (e.g. soft
  // toolbar reflow that does NOT dispatch `window.resize`).
  interface FakeROInstance {
    observe: (el: Element) => void;
    unobserve: () => void;
    disconnect: ReturnType<typeof vi.fn>;
    _cb: ResizeObserverCallback;
    _target?: Element;
  }
  const installedObservers: FakeROInstance[] = [];
  let originalRO: typeof ResizeObserver | undefined;
  beforeEach(() => {
    originalRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    installedObservers.length = 0;
    class FakeRO implements FakeROInstance {
      _cb: ResizeObserverCallback;
      _target?: Element;
      disconnect = vi.fn();
      constructor(cb: ResizeObserverCallback) {
        this._cb = cb;
        installedObservers.push(this);
      }
      observe(el: Element) { this._target = el; }
      unobserve() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
  });

  function fireResizeObserverCallback() {
    // Wrap in act() so React flushes the `setPlacement` state update
    // before the test assertion reads `data-placement`. Synchronous
    // RO callbacks in production get the same treatment via React's
    // scheduler; in tests we have to do it explicitly.
    act(() => {
      for (const ro of installedObservers) {
        ro._cb([], ro as unknown as ResizeObserver);
      }
    });
  }

  function mockViewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  }

  function mockRect(el: Element, rect: Partial<DOMRect>) {
    (el as HTMLElement).getBoundingClientRect = () => ({
      left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON() { return {}; },
      ...rect,
    }) as DOMRect;
  }

  function renderWithAnchor(bubbleWidth = 280) {
    // The component reads `root.parentElement` as the anchor for
    // measurement. Mirror that in the test — wrap the hint in a div
    // that stands in for `.watch-lab-entry-anchor`.
    const { container } = render(
      <div className="watch-lab-entry-anchor">
        <WatchLabHint hint={{ id: 'timeline_halfway', message: 'x', tone: 'milestone' }} onDismiss={vi.fn()} />
      </div>,
    );
    const anchor = container.firstElementChild as HTMLElement;
    const bubble = container.querySelector('.watch-lab-hint') as HTMLElement;
    // Default bubble size that fits the above-right placement.
    mockRect(bubble, { width: bubbleWidth, height: 64 });
    return { anchor, bubble };
  }

  it('sets data-placement="above-left" when anchor sits at the left edge (narrow phone)', () => {
    mockViewport(390, 844);
    const { anchor, bubble } = renderWithAnchor();
    // Anchor at far-left: right-aligned bubble would overflow viewport.
    mockRect(anchor, { left: 20, right: 80, top: 600, bottom: 632 });
    // Nudge ResizeObserver via a window resize event — the measurement
    // effect listens for `resize`.
    fireEvent(window, new Event('resize'));
    expect(bubble.getAttribute('data-placement')).toBe('above-left');
  });

  it('sets data-placement="below" when there is no room above the anchor', () => {
    mockViewport(1280, 800);
    const { anchor, bubble } = renderWithAnchor();
    // Anchor near top → bubble (64 px) cannot fit above (margin 8).
    mockRect(anchor, { left: 100, right: 200, top: 30, bottom: 62 });
    fireEvent(window, new Event('resize'));
    expect(bubble.getAttribute('data-placement')).toBe('below');
  });

  it('default data-placement="above-right" on mount (no resize, default rects)', () => {
    mockViewport(1280, 800);
    const { container } = render(
      <div className="watch-lab-entry-anchor">
        <WatchLabHint
          hint={{ id: 'timeline_halfway', message: 'test', tone: 'milestone' }}
          onDismiss={vi.fn()}
        />
      </div>,
    );
    const bubble = container.querySelector('.watch-lab-hint') as HTMLElement;
    // No rect stubbing, no resize — verify the initial state is the
    // safe default (resolver returns 'above-right' when measurements
    // are zero / anchor missing).
    expect(bubble.getAttribute('data-placement')).toBe('above-right');
  });

  it('updates data-placement via the ResizeObserver callback (soft reflow)', () => {
    mockViewport(1280, 800);
    const { anchor, bubble } = renderWithAnchor();
    // Anchor at far-left; right-aligned bubble would overflow.
    mockRect(anchor, { left: 20, right: 80, top: 600, bottom: 632 });
    // No window resize — fire ONLY the ResizeObserver callback. This
    // covers soft toolbar reflows where the viewport reports the same
    // innerWidth/Height but the documentElement's layout changed.
    fireResizeObserverCallback();
    expect(bubble.getAttribute('data-placement')).toBe('above-left');
  });

  it('disconnects the ResizeObserver and removes the resize listener on unmount', () => {
    mockViewport(1280, 800);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <div className="watch-lab-entry-anchor">
        <WatchLabHint
          hint={{ id: 'timeline_halfway', message: 'test', tone: 'milestone' }}
          onDismiss={vi.fn()}
        />
      </div>,
    );
    expect(installedObservers.length).toBe(1);
    const ro = installedObservers[0];
    unmount();
    expect(ro.disconnect).toHaveBeenCalled();
    expect(removeSpy.mock.calls.some((c) => String(c[0]) === 'resize')).toBe(true);
    removeSpy.mockRestore();
  });

  it('updates data-placement after a viewport resize', () => {
    mockViewport(1280, 800);
    const { anchor, bubble } = renderWithAnchor();
    // Start wide: default above-right fits.
    mockRect(anchor, { left: 1100, right: 1200, top: 700, bottom: 730 });
    fireEvent(window, new Event('resize'));
    expect(bubble.getAttribute('data-placement')).toBe('above-right');
    // Shrink viewport + move anchor to the left edge; placement MUST flip.
    mockViewport(390, 844);
    mockRect(anchor, { left: 20, right: 80, top: 600, bottom: 632 });
    fireEvent(window, new Event('resize'));
    expect(bubble.getAttribute('data-placement')).toBe('above-left');
  });
});

describe('resolveHintPlacement (pure resolver)', () => {
  const viewport = { width: 1280, height: 800 };
  const bubbleSize = { width: 280, height: 64 };

  it('default: above-right when anchor sits near the right of a wide viewport', () => {
    const anchorRect = { left: 1100, right: 1200, top: 700, bottom: 730 };
    expect(resolveHintPlacement({ anchorRect, bubbleSize, viewport })).toBe('above-right');
  });

  it('fallback: above-left when right-aligned bubble would clip the left edge', () => {
    // Anchor is near the left edge (common on narrow phones), so
    // right-aligned bubble (width 280) would overflow the viewport.
    const anchorRect = { left: 20, right: 80, top: 600, bottom: 632 };
    expect(
      resolveHintPlacement({
        anchorRect,
        bubbleSize: { width: 280, height: 64 },
        viewport: { width: 390, height: 844 },
      }),
    ).toBe('above-left');
  });

  it('fallback: below when there is not enough room above the anchor', () => {
    // Anchor top is 30 px from viewport top; bubble is 64 px tall plus
    // 8 px margin → cannot fit above.
    const anchorRect = { left: 100, right: 200, top: 30, bottom: 62 };
    expect(resolveHintPlacement({ anchorRect, bubbleSize, viewport })).toBe('below');
  });

  it('returns above-right when anchor rect is missing (no measurement)', () => {
    expect(resolveHintPlacement({ anchorRect: null, bubbleSize, viewport })).toBe('above-right');
  });

  it('treats a degenerate all-zero anchor rect as "not yet laid out" → above-right', () => {
    // Mount in JSDOM (or real browser pre-paint) can produce a zero-rect
    // anchor; we should fall back to the default placement rather than
    // misreading "anchor.top === 0" as "no room above" → 'below'.
    const anchorRect = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(resolveHintPlacement({ anchorRect, bubbleSize, viewport })).toBe('above-right');
  });
});
