/**
 * Unit tests for the shared status text formatter.
 *
 * This is the single source of truth for the React FPSDisplay component.
 */
import { describe, it, expect } from 'vitest';
import { formatStatusText, type StatusInputs } from '../../page/js/format-status';

const BASE: StatusInputs = {
  workerStalled: false,
  paused: false,
  placementActive: false,
  placementStale: false,
  warmUpComplete: true,
  overloaded: false,
  effectiveSpeed: 1.0,
  fps: 60,
  rafIntervalMs: 16.67,
  baseStepsPerSecond: 240,
  dt: 0.5,
  compact: false,
};

function fmt(overrides: Partial<StatusInputs> = {}): string {
  return formatStatusText({ ...BASE, ...overrides });
}

describe('formatStatusText', () => {
  it('shows "Simulation stalled..." when workerStalled', () => {
    expect(fmt({ workerStalled: true })).toBe('Simulation stalled...');
  });

  it('shows paused with detail in non-compact mode', () => {
    expect(fmt({ paused: true })).toContain('Paused');
    expect(fmt({ paused: true })).toContain('fps');
  });

  it('shows paused with 0 ps/s in compact mode', () => {
    expect(fmt({ paused: true, compact: true })).toBe('Paused · 0 ps/s');
  });

  it('shows "Simulation catching up..." when placement is stale', () => {
    expect(fmt({ placementActive: true, placementStale: true })).toBe('Simulation catching up...');
  });

  it('shows "Placing..." when placement is active but fresh', () => {
    const text = fmt({ placementActive: true });
    expect(text).toContain('Placing...');
  });

  it('shows "Estimating..." during warm-up', () => {
    expect(fmt({ warmUpComplete: false })).toBe('Estimating...');
  });

  it('shows "Hardware-limited" when overloaded', () => {
    expect(fmt({ overloaded: true })).toContain('Hardware-limited');
    expect(fmt({ overloaded: true })).toContain('ps/s');
  });

  it('shows normal sim speed and ps/s rate', () => {
    const text = fmt();
    expect(text).toContain('Sim 1.0x');
    expect(text).toContain('ps/s');
    expect(text).toContain('fps');
  });

  it('respects compact mode (omits detail)', () => {
    const full = fmt({ compact: false });
    const compact = fmt({ compact: true });
    expect(full).toContain('ms ·');
    expect(compact).not.toContain('ms ·');
  });

  it('priority: stalled > paused > placement > estimating > overloaded > normal', () => {
    // All flags true — stalled should win
    expect(fmt({ workerStalled: true, paused: true, placementActive: true })).toBe('Simulation stalled...');
    // Paused + placement — paused should win
    expect(fmt({ paused: true, placementActive: true })).toContain('Paused');
    // Placement + estimating — placement should win
    expect(fmt({ placementActive: true, warmUpComplete: false })).toContain('Placing');
  });
});
