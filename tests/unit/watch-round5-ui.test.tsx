/**
 * @vitest-environment jsdom
 */
/**
 * UI regression tests for Round 5 shell: dock transport, settings, timeline.
 *
 * Covers:
 *   - Dock renders transport controls
 *   - Settings sheet opens/closes
 *   - Hold threshold constant is shared
 *   - PlaybackSpeedControl uses log mapping
 *   - Transport slot layout stability (fixed-width grid)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { HOLD_PLAY_THRESHOLD_MS } from '../../src/config/playback-speed-constants';

// ── Hold threshold is shared ──

describe('Hold threshold constant', () => {
  it('HOLD_PLAY_THRESHOLD_MS is a positive number under 300ms', () => {
    expect(typeof HOLD_PLAY_THRESHOLD_MS).toBe('number');
    expect(HOLD_PLAY_THRESHOLD_MS).toBeGreaterThan(0);
    expect(HOLD_PLAY_THRESHOLD_MS).toBeLessThan(300);
  });
});

// ── Dock structure ──

describe('WatchDock structure', () => {
  it('dock source has transport cluster, utility cluster, and settings zones', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/components/WatchDock.tsx', 'utf-8');
    expect(source).toContain('watch-dock__transport');
    expect(source).toContain('watch-dock__utility');
    expect(source).toContain('IconSettings');
  });

  it('dock CSS uses fixed-width grid for transport cluster (no layout shift)', async () => {
    const fs = await import('fs');
    const css = fs.readFileSync('watch/css/watch-dock.css', 'utf-8');
    expect(css).toContain('grid-template-columns: repeat(3');
    expect(css).toContain('--dock-slot-action');
  });
});

// ── Settings sheet ──

describe('WatchSettingsSheet structure', () => {
  it('uses shared sheet lifecycle hook (not local mount/animate state)', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/components/WatchSettingsSheet.tsx', 'utf-8');
    expect(source).toContain('useSheetLifecycle');
    // Should not have local mounted/animating state — those come from the hook
    expect(source).not.toContain("useState<'idle'");
    expect(source).not.toContain('setMounted');
  });

  it('imports help content from settings-content.ts', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/components/WatchSettingsSheet.tsx', 'utf-8');
    expect(source).toContain('WATCH_HELP_SECTIONS');
    expect(source).toContain('settings-content');
  });

  it('uses shared Segmented component for theme and text-size', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/components/WatchSettingsSheet.tsx', 'utf-8');
    expect(source).toContain("from '../../../lab/js/components/Segmented'");
    expect(source).toContain('watch-theme');
    expect(source).toContain('watch-text-size');
  });

  it('help action uses a real button, not div role="button"', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/components/WatchSettingsSheet.tsx', 'utf-8');
    expect(source).toContain('button className="group-item group-item--action"');
    expect(source).not.toContain('role="button"');
  });
});

// ── Settings content ──

describe('Watch settings content', () => {
  it('WATCH_HELP_SECTIONS has expected sections', async () => {
    const { WATCH_HELP_SECTIONS } = await import('../../watch/js/settings-content');
    expect(WATCH_HELP_SECTIONS.length).toBeGreaterThanOrEqual(4);
    const titles = WATCH_HELP_SECTIONS.map(s => s.title);
    expect(titles).toContain('Playback');
    expect(titles).toContain('Camera');
    expect(titles).toContain('File');
  });
});

// ── Timeline ──

describe('WatchTimeline structure', () => {
  it('uses thick review track variant', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/components/WatchTimeline.tsx', 'utf-8');
    expect(source).toContain('timeline-track--thick');
  });

  it('uses pointer events for scrubbing (not native range)', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/components/WatchTimeline.tsx', 'utf-8');
    expect(source).toContain('onPointerDown');
    expect(source).toContain('setPointerCapture');
    expect(source).not.toContain('type="range"');
  });
});

// ── Shared CSS contracts ──

describe('Shared CSS token contracts', () => {
  it('core-tokens.css defines layout geometry tokens', async () => {
    const fs = await import('fs');
    const css = fs.readFileSync('src/ui/core-tokens.css', 'utf-8');
    expect(css).toContain('--bottom-region-width');
    expect(css).toContain('--sheet-width');
    expect(css).toContain('--tl-shell-height');
    expect(css).toContain('--tl-time-width');
    expect(css).toContain('--dock-slot-action');
  });

  it('bottom-region.css uses shared width token', async () => {
    const fs = await import('fs');
    const css = fs.readFileSync('src/ui/bottom-region.css', 'utf-8');
    expect(css).toContain('var(--bottom-region-width');
  });

  it('sheet-shell.css uses shared sheet width token', async () => {
    const fs = await import('fs');
    const css = fs.readFileSync('src/ui/sheet-shell.css', 'utf-8');
    expect(css).toContain('var(--sheet-width');
  });
});

// ── Directional playback model ──

describe('Playback direction model (unified state)', () => {
  it('playback model has no setPlaying method (unified direction model)', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/watch-playback-model.ts', 'utf-8');
    // Interface should not have setPlaying
    expect(source).not.toMatch(/setPlaying\(/);
  });

  it('isPlaying is derived from playDirection', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('watch/js/watch-playback-model.ts', 'utf-8');
    expect(source).toContain('isPlaying: () => _playDirection !== 0');
  });
});

// ══════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — actual React rendering + interaction
// ══════════════════════════════════════════════════════════

// ── WatchDock behavioral tests ──

import { WatchDock } from '../../watch/js/components/WatchDock';

function renderDock(overrides: Partial<React.ComponentProps<typeof WatchDock>> = {}) {
  const props: React.ComponentProps<typeof WatchDock> = {
    playing: false,
    canPlay: true,
    speed: 1,
    repeat: false,
    playDirection: 0,
    onTogglePlay: vi.fn(),
    onStepForward: vi.fn(),
    onStepBackward: vi.fn(),
    onSpeedChange: vi.fn(),
    onToggleRepeat: vi.fn(),
    onOpenSettings: vi.fn(),
    onStartDirectionalPlayback: vi.fn(),
    onStopDirectionalPlayback: vi.fn(),
    ...overrides,
  };
  return { ...render(<WatchDock {...props} />), props };
}

describe('WatchDock behavioral', () => {
  afterEach(() => cleanup());

  it('renders transport controls (Back, Play, Fwd)', () => {
    const { container } = renderDock();
    const buttons = container.querySelectorAll('.dock-item');
    // At least 5: Back, Play, Fwd, Repeat, Settings
    expect(buttons.length).toBeGreaterThanOrEqual(5);
  });

  it('Play button calls onTogglePlay', () => {
    const { container, props } = renderDock();
    // Play button is the middle transport button (2nd dock-item in the transport cluster)
    const transport = container.querySelector('.watch-dock__transport');
    const buttons = transport!.querySelectorAll('.dock-item');
    fireEvent.click(buttons[1]); // Play/Pause is the middle one
    expect(props.onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it('Settings button calls onOpenSettings', () => {
    const { container, props } = renderDock();
    // Settings is the last dock-item
    const allButtons = container.querySelectorAll('.dock-item');
    const settingsBtn = allButtons[allButtons.length - 1];
    fireEvent.click(settingsBtn);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('Repeat button calls onToggleRepeat and reflects active state', () => {
    const { container, props, rerender } = renderDock({ repeat: false });
    const repeatBtn = container.querySelector('.watch-dock__small');
    expect(repeatBtn).not.toBeNull();
    fireEvent.click(repeatBtn!);
    expect(props.onToggleRepeat).toHaveBeenCalledTimes(1);

    // Re-render with repeat=true — button should have .active class
    cleanup();
    const { container: c2 } = renderDock({ repeat: true });
    const repeatBtn2 = c2.querySelector('.watch-dock__small');
    expect(repeatBtn2!.classList.contains('active')).toBe(true);
  });

  it('disabled when canPlay is false', () => {
    const { container } = renderDock({ canPlay: false });
    const transport = container.querySelector('.watch-dock__transport');
    const buttons = transport!.querySelectorAll('.dock-item');
    for (const btn of buttons) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

// ── WatchSettingsSheet behavioral tests ──

import { WatchSettingsSheet } from '../../watch/js/components/WatchSettingsSheet';
import { WatchTimeline } from '../../watch/js/components/WatchTimeline';

function renderSheet(overrides: Partial<React.ComponentProps<typeof WatchSettingsSheet>> = {}) {
  const props: React.ComponentProps<typeof WatchSettingsSheet> = {
    isOpen: true,
    onClose: vi.fn(),
    theme: 'light',
    textSize: 'normal',
    onSetTheme: vi.fn(),
    onSetTextSize: vi.fn(),
    atomCount: 100,
    frameCount: 50,
    fileKind: 'full',
    endTimePs: 100,
    startTimePs: 0,
    ...overrides,
  };
  return { ...render(<WatchSettingsSheet {...props} />), props };
}

describe('WatchSettingsSheet behavioral', () => {
  afterEach(() => cleanup());

  it('renders when open', async () => {
    const { container } = renderSheet({ isOpen: true });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(container.querySelector('.sheet')).not.toBeNull();
  });

  it('does not render when closed', () => {
    const { container } = renderSheet({ isOpen: false });
    expect(container.querySelector('.sheet')).toBeNull();
  });

  it('Escape calls onClose', async () => {
    const { props } = renderSheet({ isOpen: true });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click calls onClose', async () => {
    const { container, props } = renderSheet({ isOpen: true });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const backdrop = container.querySelector('.sheet-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows file info from props', async () => {
    const { container } = renderSheet({ atomCount: 42, frameCount: 10, fileKind: 'full' });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const text = container.textContent ?? '';
    expect(text).toContain('42');
    expect(text).toContain('10');
    expect(text).toContain('full');
  });

  it('Help button opens help content, Back returns', async () => {
    const { container } = renderSheet({ isOpen: true });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Find and click the Help action button
    const helpBtn = container.querySelector('.group-item--action');
    expect(helpBtn).not.toBeNull();
    fireEvent.click(helpBtn!);

    // Help content should now be visible
    const text = container.textContent ?? '';
    expect(text).toContain('Playback');
    expect(text).toContain('Camera');

    // Back button should exist
    const backBtn = container.querySelector('.watch-help-back');
    expect(backBtn).not.toBeNull();
    fireEvent.click(backBtn!);

    // Should be back to main settings
    const textAfter = container.textContent ?? '';
    expect(textAfter).toContain('Settings');
    expect(textAfter).toContain('Appearance');
  });
});

// ── WatchDock hold-to-play behavioral tests ──

describe('WatchDock hold-to-play', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('short tap Back calls onStepBackward (not directional play)', () => {
    const { container, props } = renderDock();
    const transport = container.querySelector('.watch-dock__transport');
    const backBtn = transport!.querySelectorAll('.dock-item')[0];

    fireEvent.pointerDown(backBtn, { pointerId: 1 });
    fireEvent.pointerUp(backBtn, { pointerId: 1 });

    expect(props.onStepBackward).toHaveBeenCalledTimes(1);
    expect(props.onStartDirectionalPlayback).not.toHaveBeenCalled();
  });

  it('short tap Fwd calls onStepForward (not directional play)', () => {
    const { container, props } = renderDock();
    const transport = container.querySelector('.watch-dock__transport');
    const fwdBtn = transport!.querySelectorAll('.dock-item')[2];

    fireEvent.pointerDown(fwdBtn, { pointerId: 1 });
    fireEvent.pointerUp(fwdBtn, { pointerId: 1 });

    expect(props.onStepForward).toHaveBeenCalledTimes(1);
    expect(props.onStartDirectionalPlayback).not.toHaveBeenCalled();
  });

  it('hold Back past threshold calls onStepBackward (nudge) + onStartDirectionalPlayback(-1)', () => {
    const { container, props } = renderDock();
    const transport = container.querySelector('.watch-dock__transport');
    const backBtn = transport!.querySelectorAll('.dock-item')[0];

    fireEvent.pointerDown(backBtn, { pointerId: 1 });
    vi.advanceTimersByTime(HOLD_PLAY_THRESHOLD_MS + 10);

    expect(props.onStepBackward).toHaveBeenCalledTimes(1);
    expect(props.onStartDirectionalPlayback).toHaveBeenCalledWith(-1);
  });

  it('hold Fwd past threshold calls onStepForward (nudge) + onStartDirectionalPlayback(1)', () => {
    const { container, props } = renderDock();
    const transport = container.querySelector('.watch-dock__transport');
    const fwdBtn = transport!.querySelectorAll('.dock-item')[2];

    fireEvent.pointerDown(fwdBtn, { pointerId: 1 });
    vi.advanceTimersByTime(HOLD_PLAY_THRESHOLD_MS + 10);

    expect(props.onStepForward).toHaveBeenCalledTimes(1);
    expect(props.onStartDirectionalPlayback).toHaveBeenCalledWith(1);
  });

  it('release after hold calls onStopDirectionalPlayback', () => {
    const { container, props } = renderDock();
    const transport = container.querySelector('.watch-dock__transport');
    const fwdBtn = transport!.querySelectorAll('.dock-item')[2];

    fireEvent.pointerDown(fwdBtn, { pointerId: 1 });
    vi.advanceTimersByTime(HOLD_PLAY_THRESHOLD_MS + 10);
    fireEvent.pointerUp(fwdBtn, { pointerId: 1 });

    expect(props.onStopDirectionalPlayback).toHaveBeenCalledTimes(1);
  });

  it('rerender during active hold does NOT cancel the gesture (regression)', () => {
    // This tests the exact bug where React re-render (from snapshot update after
    // startDirectionalPlayback) created new callback identities, which triggered
    // effect cleanup that called onStopPlay, killing the hold immediately.
    const onStop = vi.fn();
    const onStart = vi.fn();
    const onStep = vi.fn();
    const { container, rerender } = render(
      <WatchDock
        playing={false} canPlay={true} speed={1} repeat={false} playDirection={0}
        onTogglePlay={vi.fn()} onStepForward={onStep} onStepBackward={vi.fn()}
        onSpeedChange={vi.fn()} onToggleRepeat={vi.fn()} onOpenSettings={vi.fn()}
        onStartDirectionalPlayback={onStart} onStopDirectionalPlayback={onStop}
      />
    );
    const transport = container.querySelector('.watch-dock__transport');
    const fwdBtn = transport!.querySelectorAll('.dock-item')[2];

    // Start hold
    fireEvent.pointerDown(fwdBtn, { pointerId: 1 });
    vi.advanceTimersByTime(HOLD_PLAY_THRESHOLD_MS + 10);
    expect(onStart).toHaveBeenCalledWith(1);
    onStop.mockClear();

    // Simulate parent rerender with NEW callback identities (the old failure mode)
    rerender(
      <WatchDock
        playing={true} canPlay={true} speed={1} repeat={false} playDirection={1}
        onTogglePlay={vi.fn()} onStepForward={vi.fn()} onStepBackward={vi.fn()}
        onSpeedChange={vi.fn()} onToggleRepeat={vi.fn()} onOpenSettings={vi.fn()}
        onStartDirectionalPlayback={vi.fn()} onStopDirectionalPlayback={onStop}
      />
    );

    // The hold should NOT have been canceled by the rerender
    expect(onStop).not.toHaveBeenCalled();

    // Only release should stop it
    fireEvent.pointerUp(fwdBtn, { pointerId: 1 });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

// ── WatchTimeline behavioral tests ──

describe('WatchTimeline behavioral', () => {
  afterEach(() => cleanup());

  function renderTimeline(overrides: Partial<React.ComponentProps<typeof WatchTimeline>> = {}) {
    const props = {
      currentTimePs: 50,
      startTimePs: 0,
      endTimePs: 100,
      onScrub: vi.fn(),
      ...overrides,
    };
    return { ...render(<WatchTimeline {...props} />), props };
  }

  it('renders time labels and track', () => {
    const { container } = renderTimeline();
    const times = container.querySelectorAll('.timeline-time');
    expect(times.length).toBe(2); // current + end
    expect(container.querySelector('.timeline-track')).not.toBeNull();
    expect(container.querySelector('.timeline-fill')).not.toBeNull();
    expect(container.querySelector('.timeline-thumb')).not.toBeNull();
  });

  it('uses thick review track variant', () => {
    const { container } = renderTimeline();
    const track = container.querySelector('.timeline-track');
    expect(track!.classList.contains('timeline-track--thick')).toBe(true);
  });

  it('pointerDown on track calls onScrub', () => {
    const { container, props } = renderTimeline({ startTimePs: 0, endTimePs: 100 });
    const track = container.querySelector('.timeline-track')!;
    // Mock getBoundingClientRect for deterministic positioning
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 10, height: 10 }),
    });
    // Mock setPointerCapture
    (track as any).setPointerCapture = vi.fn();
    (track as any).hasPointerCapture = vi.fn(() => false);

    // Click at 50% = 100px of 200px width
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 });
    expect(props.onScrub).toHaveBeenCalledTimes(1);
    const scrubValue = (props.onScrub as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(scrubValue).toBeCloseTo(50, 0); // 50% of 0..100
  });

  it('fill width reflects progress', () => {
    const { container } = renderTimeline({ currentTimePs: 25, startTimePs: 0, endTimePs: 100 });
    const fill = container.querySelector('.timeline-fill') as HTMLElement;
    expect(fill.style.width).toBe('25%');
  });

  it('thumb position reflects progress', () => {
    const { container } = renderTimeline({ currentTimePs: 75, startTimePs: 0, endTimePs: 100 });
    const thumb = container.querySelector('.timeline-thumb') as HTMLElement;
    expect(thumb.style.left).toBe('75%');
  });

  it('pointerMove while captured calls onScrub with updated position', () => {
    const { container, props } = renderTimeline({ startTimePs: 0, endTimePs: 100 });
    const track = container.querySelector('.timeline-track')!;
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 10, height: 10 }),
    });
    (track as any).setPointerCapture = vi.fn();
    (track as any).hasPointerCapture = vi.fn(() => true); // captured

    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 });
    expect(props.onScrub).toHaveBeenCalledTimes(1);

    // Drag to 75% (150px of 200px)
    fireEvent.pointerMove(track, { clientX: 150, pointerId: 1 });
    expect(props.onScrub).toHaveBeenCalledTimes(2);
    const dragValue = (props.onScrub as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(dragValue).toBeCloseTo(75, 0);
  });

  it('setPointerCapture failure: initial scrub + drag continuation both work', () => {
    const { container, props } = renderTimeline({ startTimePs: 0, endTimePs: 100 });
    const track = container.querySelector('.timeline-track')!;
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 10, height: 10 }),
    });
    // Make setPointerCapture throw — simulates unsupported capture
    (track as any).setPointerCapture = vi.fn(() => { throw new Error('Not supported'); });
    (track as any).hasPointerCapture = vi.fn(() => false);

    // Initial click should still work via dragActive fallback
    fireEvent.pointerDown(track, { clientX: 60, pointerId: 1 });
    expect(props.onScrub).toHaveBeenCalledTimes(1);
    const scrubValue = (props.onScrub as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(scrubValue).toBeCloseTo(30, 0); // 60/200 = 30%

    // Drag continuation should ALSO work via dragActive ref (capture is unavailable)
    fireEvent.pointerMove(track, { clientX: 120, pointerId: 1 });
    expect(props.onScrub).toHaveBeenCalledTimes(2);
    const dragValue = (props.onScrub as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(dragValue).toBeCloseTo(60, 0); // 120/200 = 60%

    // pointerUp clears dragActive — subsequent move should NOT scrub
    fireEvent.pointerUp(track, { pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 180, pointerId: 1 });
    expect(props.onScrub).toHaveBeenCalledTimes(2); // no additional call
  });
});
