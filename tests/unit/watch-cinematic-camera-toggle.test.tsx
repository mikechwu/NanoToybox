/**
 * @vitest-environment jsdom
 */
/**
 * WatchCinematicCameraToggle — React surface tests.
 *
 * Covers all five status-line branches via the `status` enum and
 * the toggle/aria-pressed contract.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WatchCinematicCameraToggle } from '../../watch/js/components/WatchCinematicCameraToggle';
import type { SnapshotCinematicCameraStatus } from '../../watch/js/watch-cinematic-camera';

afterEach(() => { cleanup(); });

function renderToggle(overrides: Partial<React.ComponentProps<typeof WatchCinematicCameraToggle>> = {}) {
  const onToggle = vi.fn();
  const props = {
    enabled: true,
    active: true,
    status: 'tracking' as SnapshotCinematicCameraStatus,
    onToggle,
    ...overrides,
  };
  render(<WatchCinematicCameraToggle {...props} />);
  return { onToggle };
}

describe('WatchCinematicCameraToggle', () => {
  it('renders label + tracking status copy by default', () => {
    renderToggle();
    expect(screen.getByText('Cinematic Camera')).toBeTruthy();
    expect(screen.getByText('Keeps major clusters framed')).toBeTruthy();
  });

  it('shows paused copy for status=paused', () => {
    renderToggle({ status: 'paused' });
    expect(screen.getByText('Paused while you adjust the camera')).toBeTruthy();
  });

  it('shows waiting-for-clusters copy for status=waiting_major_clusters', () => {
    renderToggle({ status: 'waiting_major_clusters', active: false });
    expect(screen.getByText('Waiting for major clusters')).toBeTruthy();
  });

  it('shows waiting-for-topology copy for status=waiting_topology', () => {
    renderToggle({ status: 'waiting_topology', active: false });
    expect(screen.getByText('Waiting for topology')).toBeTruthy();
  });

  it('shows suppressed-by-follow copy for status=suppressed_by_follow', () => {
    renderToggle({ status: 'suppressed_by_follow', active: false });
    expect(screen.getByText('Off while Follow is active')).toBeTruthy();
  });

  it('shows Off copy for status=off', () => {
    renderToggle({ enabled: false, active: false, status: 'off' });
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
  });

  it('aria-pressed reflects enabled + aria-label flips with state', () => {
    const { rerender } = render(
      <WatchCinematicCameraToggle
        enabled
        active
        status="tracking"
        onToggle={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Turn Cinematic Camera off' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    rerender(
      <WatchCinematicCameraToggle
        enabled={false}
        active={false}
        status="off"
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
