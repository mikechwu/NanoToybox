/**
 * @vitest-environment jsdom
 */
/**
 * Tests for Round 5 playback model extensions: speed, repeat, step.
 * Also covers shared playback-speed-constants (log mapping, formatting).
 */

import { describe, it, expect } from 'vitest';
import {
  SPEED_MIN, SPEED_MAX, SPEED_DEFAULT, SPEED_PRESETS, PLAYBACK_GAP_CLAMP_MS,
  sliderToSpeed, speedToSlider, formatSpeed,
} from '../../src/config/playback-speed-constants';
import { createWatchPlaybackModel } from '../../watch/js/playback/watch-playback-model';
import { importFullHistory } from '../../watch/js/document/full-history-import';

// ── Shared constants ──

describe('playback-speed-constants', () => {
  it('SPEED_MIN < SPEED_DEFAULT < SPEED_MAX', () => {
    expect(SPEED_MIN).toBeLessThan(SPEED_DEFAULT);
    expect(SPEED_DEFAULT).toBeLessThan(SPEED_MAX);
  });

  it('SPEED_PRESETS contains min, default, and max', () => {
    expect(SPEED_PRESETS).toContain(SPEED_MIN);
    expect(SPEED_PRESETS).toContain(SPEED_DEFAULT);
    expect(SPEED_PRESETS).toContain(SPEED_MAX);
  });
});

// ── Log mapping ──

describe('logarithmic slider mapping', () => {
  it('sliderToSpeed(0) = SPEED_MIN', () => {
    expect(sliderToSpeed(0)).toBeCloseTo(SPEED_MIN, 5);
  });

  it('sliderToSpeed(1) = SPEED_MAX', () => {
    expect(sliderToSpeed(1)).toBeCloseTo(SPEED_MAX, 5);
  });

  it('roundtrip: speedToSlider(sliderToSpeed(t)) ≈ t', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(speedToSlider(sliderToSpeed(t))).toBeCloseTo(t, 5);
    }
  });

  it('roundtrip: sliderToSpeed(speedToSlider(s)) ≈ s', () => {
    for (const s of [0.5, 1, 2, 4, 8, 16, 20]) {
      expect(sliderToSpeed(speedToSlider(s))).toBeCloseTo(s, 3);
    }
  });

  it('1x is at ~19% of slider travel', () => {
    const t = speedToSlider(1);
    expect(t).toBeGreaterThan(0.15);
    expect(t).toBeLessThan(0.25);
  });

  it('clamps input outside [0,1]', () => {
    expect(sliderToSpeed(-1)).toBeCloseTo(SPEED_MIN, 5);
    expect(sliderToSpeed(2)).toBeCloseTo(SPEED_MAX, 5);
  });
});

// ── formatSpeed ──

describe('formatSpeed', () => {
  it('sub-10: one decimal', () => {
    expect(formatSpeed(1)).toBe('1.0x');
    expect(formatSpeed(0.5)).toBe('0.5x');
    expect(formatSpeed(4)).toBe('4.0x');
  });

  it('10+: integer', () => {
    expect(formatSpeed(16)).toBe('16x');
    expect(formatSpeed(20)).toBe('20x');
  });
});

// ── Playback model speed ──

function makeHistory(): string {
  return JSON.stringify({
    format: 'atomdojo-history', version: 1, kind: 'full',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-07T00:00:00Z' },
    simulation: { title: null, description: null, units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 2, durationPs: 100, frameCount: 3, indexingModel: 'dense-prefix' },
    atoms: { atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0,0,0, 1,0,0], interaction: null, boundary: {} },
        { frameId: 1, timePs: 50, n: 2, atomIds: [0, 1], positions: [0.1,0,0, 1.1,0,0], interaction: null, boundary: {} },
        { frameId: 2, timePs: 100, n: 2, atomIds: [0, 1], positions: [0.2,0,0, 1.2,0,0], interaction: null, boundary: {} },
      ],
      restartFrames: [
        { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0,0,0, 1,0,0], velocities: [0,0,0, 0,0,0], bonds: [{ a: 0, b: 1, distance: 1.42 }], config: { damping: 0.995, kDrag: 1.2, kRotate: 0.6, dtFs: 0.5, dampingRefDurationFs: 2.0 }, interaction: null, boundary: {} },
      ],
      checkpoints: [],
    },
  });
}

function loadModel() {
  const pm = createWatchPlaybackModel();
  const history = importFullHistory(JSON.parse(makeHistory()));
  pm.load(history);
  return pm;
}

describe('WatchPlaybackModel speed', () => {
  it('default speed matches SPEED_DEFAULT', () => {
    const pm = loadModel();
    expect(pm.getSpeed()).toBe(SPEED_DEFAULT);
  });

  it('setSpeed clamps to [SPEED_MIN, SPEED_MAX]', () => {
    const pm = loadModel();
    pm.setSpeed(0.1);
    expect(pm.getSpeed()).toBe(SPEED_MIN);
    pm.setSpeed(100);
    expect(pm.getSpeed()).toBe(SPEED_MAX);
  });

  it('advance uses speed multiplier', () => {
    const pm = loadModel();
    pm.startPlayback();
    pm.setSpeed(10);
    pm.advance(100); // 100ms at 10x
    // dtPs = min(100, 250) * 0.00012 * 10 = 0.12
    expect(pm.getCurrentTimePs()).toBeCloseTo(0.12, 4);
  });

  it('advance clamps dtMs to GAP_CLAMP_MS', () => {
    const pm = loadModel();
    pm.startPlayback();
    pm.setSpeed(20);
    pm.advance(2000); // 2000ms but clamped to 250ms
    // dtPs = min(2000, 250) * 0.00012 * 20 = 0.6
    expect(pm.getCurrentTimePs()).toBeCloseTo(0.6, 4);
  });

  it('load resets speed to default', () => {
    const pm = loadModel();
    pm.setSpeed(10);
    const history = importFullHistory(JSON.parse(makeHistory()));
    pm.load(history);
    expect(pm.getSpeed()).toBe(SPEED_DEFAULT);
  });
});

// ── Repeat ──

describe('WatchPlaybackModel repeat', () => {
  it('default repeat is true', () => {
    const pm = loadModel();
    expect(pm.getRepeat()).toBe(true);
  });

  it('repeat wraps time at end using modulo', () => {
    const pm = loadModel();
    pm.setRepeat(true);
    pm.startPlayback();
    pm.setSpeed(SPEED_MAX);
    // Advance far past end (100ps)
    for (let i = 0; i < 10000; i++) pm.advance(16.67);
    // Should still be playing (not paused at end)
    expect(pm.isPlaying()).toBe(true);
    expect(pm.getCurrentTimePs()).toBeLessThan(100);
    expect(pm.getCurrentTimePs()).toBeGreaterThanOrEqual(0);
  });

  it('without repeat, pauses at end', () => {
    const pm = loadModel();
    pm.setRepeat(false);
    pm.startPlayback();
    pm.setSpeed(SPEED_MAX);
    for (let i = 0; i < 10000; i++) pm.advance(16.67);
    expect(pm.isPlaying()).toBe(false);
    expect(pm.getCurrentTimePs()).toBe(100);
  });

  it('load resets repeat to true (default on)', () => {
    const pm = loadModel();
    pm.setRepeat(false);
    pm.load(importFullHistory(JSON.parse(makeHistory())));
    expect(pm.getRepeat()).toBe(true);
  });
});

// ── Step ──

describe('WatchPlaybackModel step', () => {
  it('stepForward advances to next dense frame', () => {
    const pm = loadModel();
    expect(pm.getCurrentTimePs()).toBe(0);
    pm.stepForward();
    expect(pm.getCurrentTimePs()).toBe(50);
    pm.stepForward();
    expect(pm.getCurrentTimePs()).toBe(100);
  });

  it('stepForward at last frame is no-op', () => {
    const pm = loadModel();
    pm.setCurrentTimePs(100);
    pm.stepForward();
    expect(pm.getCurrentTimePs()).toBe(100);
  });

  it('stepBackward moves to previous dense frame', () => {
    const pm = loadModel();
    pm.setCurrentTimePs(100);
    pm.stepBackward();
    expect(pm.getCurrentTimePs()).toBe(50);
    pm.stepBackward();
    expect(pm.getCurrentTimePs()).toBe(0);
  });

  it('stepBackward at first frame is no-op', () => {
    const pm = loadModel();
    pm.stepBackward();
    expect(pm.getCurrentTimePs()).toBe(0);
  });

  it('step pauses playback', () => {
    const pm = loadModel();
    pm.startPlayback();
    expect(pm.isPlaying()).toBe(true);
    pm.stepForward();
    expect(pm.isPlaying()).toBe(false);
  });

  it('step from mid-frame goes to adjacent frame', () => {
    const pm = loadModel();
    pm.setCurrentTimePs(25); // between frame 0 (t=0) and frame 1 (t=50)
    // Currently displayed frame is 0 (at or before 25)
    pm.stepForward();
    expect(pm.getCurrentTimePs()).toBe(50); // frame 1
  });
});

// ── Directional playback ──

describe('WatchPlaybackModel directional playback', () => {
  it('startDirectionalPlayback(1) sets direction and playing', () => {
    const pm = loadModel();
    pm.startDirectionalPlayback(1);
    expect(pm.isPlaying()).toBe(true);
    expect(pm.getPlaybackDirection()).toBe(1);
  });

  it('startDirectionalPlayback(-1) enables backward advance', () => {
    const pm = loadModel();
    pm.setCurrentTimePs(50);
    pm.startDirectionalPlayback(-1);
    pm.advance(100); // backward at x1
    expect(pm.getCurrentTimePs()).toBeLessThan(50);
  });

  it('stopDirectionalPlayback pauses and resets direction', () => {
    const pm = loadModel();
    pm.startDirectionalPlayback(1);
    pm.stopDirectionalPlayback();
    expect(pm.isPlaying()).toBe(false);
    expect(pm.getPlaybackDirection()).toBe(0);
  });

  it('backward playback clamps to start when not repeating', () => {
    const pm = loadModel();
    pm.setRepeat(false);
    pm.setCurrentTimePs(0.01);
    pm.startDirectionalPlayback(-1);
    pm.setSpeed(SPEED_MAX);
    for (let i = 0; i < 1000; i++) pm.advance(250);
    expect(pm.isPlaying()).toBe(false);
    expect(pm.getCurrentTimePs()).toBe(0);
  });

  it('backward playback wraps when repeating', () => {
    const pm = loadModel();
    pm.setCurrentTimePs(0.01);
    pm.setRepeat(true);
    pm.startDirectionalPlayback(-1);
    pm.setSpeed(SPEED_MAX);
    for (let i = 0; i < 100; i++) pm.advance(250);
    expect(pm.isPlaying()).toBe(true);
    expect(pm.getCurrentTimePs()).toBeGreaterThan(0);
  });

  it('seekTo resets direction', () => {
    const pm = loadModel();
    pm.startDirectionalPlayback(-1);
    pm.seekTo(50);
    expect(pm.getPlaybackDirection()).toBe(0);
  });

  it('stepForward resets direction', () => {
    const pm = loadModel();
    pm.startDirectionalPlayback(1);
    pm.stepForward();
    expect(pm.getPlaybackDirection()).toBe(0);
  });
});
