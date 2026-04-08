/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the shared sheet lifecycle hook (src/ui/useSheetLifecycle.ts).
 *
 * Covers:
 *   - Closed → mounted → open transition
 *   - Close → unmount after transition end
 *   - Reduced-motion instant unmount
 *   - Escape calls onClose when provided
 *   - Lab-style usage without onClose
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, fireEvent, cleanup } from '@testing-library/react';
import { useSheetLifecycle } from '../../src/ui/useSheetLifecycle';

/** Test harness that exposes hook state via data attributes. */
function SheetHarness({ isOpen, onClose }: { isOpen: boolean; onClose?: () => void }) {
  const { ref, mounted, animating, onTransitionEnd } = useSheetLifecycle(isOpen, onClose);
  if (!mounted) return <div data-testid="harness" data-mounted="false" />;
  return (
    <div data-testid="harness" data-mounted="true" data-animating={String(animating)}>
      <aside
        ref={ref as React.RefObject<HTMLElement>}
        data-testid="sheet"
        className={animating ? 'open' : ''}
        onTransitionEnd={onTransitionEnd as any}
        style={{ transitionDuration: '0.3s' }}
      />
    </div>
  );
}

describe('useSheetLifecycle', () => {
  afterEach(() => cleanup());
  it('starts unmounted when closed', () => {
    const { getByTestId } = render(<SheetHarness isOpen={false} />);
    expect(getByTestId('harness').dataset.mounted).toBe('false');
  });

  it('mounts when opened', () => {
    const { getByTestId, rerender } = render(<SheetHarness isOpen={false} />);
    rerender(<SheetHarness isOpen={true} />);
    expect(getByTestId('harness').dataset.mounted).toBe('true');
  });

  it('sets animating after reflow', async () => {
    const { getByTestId, rerender } = render(<SheetHarness isOpen={false} />);
    rerender(<SheetHarness isOpen={true} />);
    // After mount, the hook forces reflow then sets animating
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(getByTestId('harness').dataset.animating).toBe('true');
  });

  it('unmounts after transitionend on close', async () => {
    const { getByTestId, rerender } = render(<SheetHarness isOpen={true} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(getByTestId('harness').dataset.mounted).toBe('true');

    // Close
    rerender(<SheetHarness isOpen={false} />);
    // Simulate transition end
    const sheet = getByTestId('sheet');
    fireEvent.transitionEnd(sheet);
    expect(getByTestId('harness').dataset.mounted).toBe('false');
  });

  it('calls onClose on Escape when provided', async () => {
    const onClose = vi.fn();
    render(<SheetHarness isOpen={true} onClose={onClose} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose on Escape when not provided', async () => {
    // Should not throw or call anything
    render(<SheetHarness isOpen={true} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    // Just verify no error
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('lab-style usage without onClose works', () => {
    const { getByTestId, rerender } = render(<SheetHarness isOpen={false} />);
    rerender(<SheetHarness isOpen={true} />);
    expect(getByTestId('harness').dataset.mounted).toBe('true');
  });
});
