/**
 * @vitest-environment jsdom
 */
/**
 * Rev 7 — verify the Lab-entry surface always opens in a new tab.
 *
 * Behavioral invariants (current, post rev 7 follow-ups):
 *   1. Rendered anchors carry `target="_blank"` + `rel="noopener noreferrer"`
 *      so middle-click, ⌘-click, right-click, AND plain left-click all
 *      land in a new tab without a window.opener reference. The browser
 *      performs the navigation natively — the click handler does NOT
 *      call `preventDefault()`.
 *   2. `controller.openLab()` is a programmatic fallback for non-anchor
 *      callers. It invokes `window.open(href, '_blank',
 *      'noopener,noreferrer')` and does NOT try to detect popup
 *      blocking from the return value: per the HTML spec, `window.open`
 *      with `noopener` returns `null` even on success, so a null-check
 *      cannot distinguish "blocked" from "opened." The earlier draft
 *      of this test asserted a false-positive error banner on the null
 *      return; that was the bug users reported ("new tab opens BUT
 *      error banner appears anyway"). Removed.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WatchLabEntryControl } from '../../watch/js/components/WatchLabEntryControl';

afterEach(cleanup);

describe('WatchLabEntryControl — new-tab navigation markup (paired-actions panel)', () => {
  it('secondary "Open Lab" anchor carries target="_blank" and rel="noopener noreferrer"', () => {
    render(
      <WatchLabEntryControl
        enabled
        currentFrameAvailable={false}
        plainLabHref="/lab/"
        currentFrameLabHref={null}
        onOpenPlainLab={vi.fn()}
        onOpenCurrentFrameLab={vi.fn()}
      />,
    );
    const anchor = screen.getByText('Open Lab').closest('a')!;
    expect(anchor.getAttribute('target')).toBe('_blank');
    const rel = (anchor.getAttribute('rel') ?? '').split(/\s+/);
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('primary "Continue this frame in Lab" anchor also carries target="_blank" + rel when seedable', () => {
    render(
      <WatchLabEntryControl
        enabled
        currentFrameAvailable
        plainLabHref="/lab/"
        currentFrameLabHref="/lab/?from=watch&handoff=t1"
        onOpenPlainLab={vi.fn()}
        onOpenCurrentFrameLab={vi.fn()}
      />,
    );
    // Primary renders as an anchor when the frame is seedable.
    // Accessible name carries the full "Continue this frame in Lab";
    // visible text is the compact "Continue".
    const primary = screen.getByLabelText(/continue this frame in lab/i).closest('a')!;
    expect(primary.getAttribute('target')).toBe('_blank');
    const rel = (primary.getAttribute('rel') ?? '').split(/\s+/);
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });
});

describe('controller.openLab — window.open contract (rev 7)', () => {
  it('invokes window.open with _blank + noopener,noreferrer', async () => {
    const openSpy = vi.fn(() => ({ focus: () => {} }) as unknown as Window);
    vi.stubGlobal('open', openSpy);
    try {
      const mod = await import('../../watch/js/watch-controller');
      const controller = mod.createWatchController();
      controller.openLab();
      expect(openSpy).toHaveBeenCalledTimes(1);
      const [href, target, features] = openSpy.mock.calls[0] as unknown as [string, string, string];
      expect(href).toMatch(/\/lab\//);
      expect(target).toBe('_blank');
      expect(features).toContain('noopener');
      expect(features).toContain('noreferrer');
      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does NOT surface an error when window.open returns null (noopener success vs. block are indistinguishable)', async () => {
    // Per HTML spec, `window.open(..., 'noopener')` returns `null` on
    // SUCCESS — the opener handle is deliberately withheld. A null
    // check cannot distinguish that from a blocked popup, so any
    // error-surfacing heuristic based on the return value produces
    // false positives on every successful new-tab open. Verified by
    // user report: "the tab opened AND the banner fired." We no longer
    // try to detect blocking from the null return; we call window.open
    // and trust it.
    const openSpy = vi.fn(() => null);
    vi.stubGlobal('open', openSpy);
    try {
      const mod = await import('../../watch/js/watch-controller');
      const controller = mod.createWatchController();
      expect(() => controller.openLab()).not.toThrow();
      expect(openSpy).toHaveBeenCalled();
      // Critical: no false-positive error banner.
      const snap = controller.getSnapshot();
      expect(snap.error).toBeNull();
      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
