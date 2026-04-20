/**
 * Tests for src/share/capsule-preview-sampling.ts — spec §Helper extraction.
 */

import { describe, it, expect } from 'vitest';
import { sampleEvenly, sampleForSilhouette } from '../../src/share/capsule-preview-sampling';

describe('sampleEvenly', () => {
  it('empty / non-positive target → []', () => {
    expect(sampleEvenly([], 5)).toEqual([]);
    expect(sampleEvenly([1, 2, 3], 0)).toEqual([]);
    expect(sampleEvenly([1, 2, 3], -1)).toEqual([]);
  });

  it('passes through when n <= target', () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(sampleEvenly([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it('target=1 returns the middle element', () => {
    expect(sampleEvenly([1, 2, 3, 4, 5], 1)).toEqual([3]);
  });

  it('keeps endpoints (index 0 and n-1) when target >= 2', () => {
    const out = sampleEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(9);
  });

  it('is strictly monotone (no duplicate indices)', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = sampleEvenly(items, 7);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });

  it('actually fills the requested budget on dense inputs', () => {
    const items = Array.from({ length: 18 }, (_, i) => i);
    const out = sampleEvenly(items, 15);
    expect(out.length).toBe(15);
  });
});

describe('sampleForSilhouette', () => {
  const getX = (p: { x: number; y: number }) => p.x;
  const getY = (p: { x: number; y: number }) => p.y;

  it('empty / non-positive target → []', () => {
    expect(sampleForSilhouette([], 5, getX, getY)).toEqual([]);
    expect(sampleForSilhouette([{ x: 0, y: 0 }], 0, getX, getY)).toEqual([]);
  });

  it('passes through when n <= target', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(sampleForSilhouette(pts, 5, getX, getY)).toEqual(pts);
  });

  it('preserves the four axis extrema on a spread-out cloud', () => {
    // Regular 5×5 grid → extrema are the 4 corners.
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) pts.push({ x: i, y: j });
    }
    const out = sampleForSilhouette(pts, 6, getX, getY);
    const asKeys = new Set(out.map((p) => `${p.x},${p.y}`));
    expect(asKeys.has('0,0')).toBe(true);
    expect(asKeys.has('4,0')).toBe(true);
    expect(asKeys.has('0,4')).toBe(true);
    expect(asKeys.has('4,4')).toBe(true);
  });

  it('picks farther points over neighbors of already-picked ones', () => {
    // Two clusters: dense at (0,0)..(0.1, 0.1) and a single far point at (10, 10).
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 10; i++) pts.push({ x: i * 0.01, y: i * 0.01 });
    pts.push({ x: 10, y: 10 });
    const out = sampleForSilhouette(pts, 4, getX, getY);
    const hasFar = out.some((p) => p.x === 10 && p.y === 10);
    expect(hasFar).toBe(true);
  });

  it('returns items in original array order (stable for bond-index translation)', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: (i * 7) % 11 }));
    const out = sampleForSilhouette(pts, 6, getX, getY);
    // Compare against the source array order by finding each sampled
    // item's original index — that sequence must be monotonically
    // increasing (storage order preserved).
    const origIndices = out.map((o) => pts.indexOf(o));
    for (let i = 1; i < origIndices.length; i++) {
      expect(origIndices[i]).toBeGreaterThan(origIndices[i - 1]);
    }
  });

  it('is deterministic for the same input', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ x: Math.sin(i), y: Math.cos(i * 1.3) }));
    const a = sampleForSilhouette(pts, 10, getX, getY);
    const b = sampleForSilhouette(pts, 10, getX, getY);
    expect(a).toEqual(b);
  });

  it('fills the exact target count (extrema + FPS saturate the budget)', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i % 7 }));
    expect(sampleForSilhouette(pts, 18, getX, getY).length).toBe(18);
  });

  it('respects target=2 (must not overshoot from 4 extrema seeding)', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: (i * 3) % 11 }));
    expect(sampleForSilhouette(pts, 2, getX, getY).length).toBe(2);
  });

  it('respects target=3 (extrema seeding is budget-aware)', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: (i * 3) % 11 }));
    expect(sampleForSilhouette(pts, 3, getX, getY).length).toBe(3);
  });
});
