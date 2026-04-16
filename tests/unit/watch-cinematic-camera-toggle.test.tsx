/**
 * @vitest-environment jsdom
 */
/**
 * WatchCinematicCameraToggle — React surface tests.
 *
 * Covers the four status-line branches (disabled/paused/no-target/
 * active) and the toggle/aria-pressed contract the controller wires
 * into `setCinematicCameraEnabled`.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WatchCinematicCameraToggle } from '../../watch/js/components/WatchCinematicCameraToggle';

afterEach(() => { cleanup(); });

function renderToggle(overrides: Partial<React.ComponentProps<typeof WatchCinematicCameraToggle>> = {}) {
  const onToggle = vi.fn();
  const props = {
    enabled: true,
    active: true,
    pausedForUserInput: false,
    eligibleClusterCount: 2,
    onToggle,
    ...overrides,
  };
  render(<WatchCinematicCameraToggle {...props} />);
  return { onToggle };
}

describe('WatchCinematicCameraToggle', () => {
  it('renders label + active status copy by default', () => {
    renderToggle();
    expect(screen.getByText('Cinematic Camera')).toBeTruthy();
    expect(screen.getByText('Keeps major clusters framed')).toBeTruthy();
  });

  it('shows paused copy when pausedForUserInput=true', () => {
    renderToggle({ pausedForUserInput: true });
    expect(screen.getByText('Paused while you adjust the camera')).toBeTruthy();
  });

  it('shows waiting copy when eligibleClusterCount=0', () => {
    renderToggle({ eligibleClusterCount: 0, active: false });
    expect(screen.getByText('Waiting for major clusters')).toBeTruthy();
  });

  it('shows Off copy when enabled=false', () => {
    renderToggle({ enabled: false, active: false });
    // "Off" appears in both status and button; both are expected.
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
  });

  it('aria-pressed reflects enabled + aria-label flips with state', () => {
    const { rerender } = render(
      <WatchCinematicCameraToggle
        enabled
        active
        pausedForUserInput={false}
        eligibleClusterCount={2}
        onToggle={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Turn Cinematic Camera off' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    rerender(
      <WatchCinematicCameraToggle
        enabled={false}
        active={false}
        pausedForUserInput={false}
        eligibleClusterCount={0}
        onToggle={() => {}}
      />,
    );
    const offBtn = screen.getByRole('button', { name: 'Turn Cinematic Camera on' });
    expect(offBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking the button invokes onToggle', () => {
    const { onToggle } = renderToggle();
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
