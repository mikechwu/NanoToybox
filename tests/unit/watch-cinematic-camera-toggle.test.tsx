/**
 * @vitest-environment jsdom
 */
/**
 * WatchCinematicCameraToggle — React surface tests.
 *
 * The toggle is a button with "Cinematic Camera" label + CSS switch.
 * Tests verify aria-pressed, aria-label, and click behavior.
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
  it('renders "Cinematic Camera" label', () => {
    renderToggle();
    expect(screen.getByText('Cinematic Camera')).toBeTruthy();
  });

  it('aria-pressed reflects enabled state', () => {
    renderToggle({ enabled: true });
    const btn = screen.getByRole('button', { name: 'Turn Cinematic Camera off' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('aria-label flips when disabled', () => {
    renderToggle({ enabled: false, active: false, status: 'off' });
    const btn = screen.getByRole('button', { name: 'Turn Cinematic Camera on' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking the button invokes onToggle', () => {
    const { onToggle } = renderToggle();
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('data-status reflects the status enum', () => {
    renderToggle({ status: 'waiting_topology' });
    const el = screen.getByTestId('watch-cinematic-camera-toggle');
    expect(el.getAttribute('data-status')).toBe('waiting_topology');
  });
});
