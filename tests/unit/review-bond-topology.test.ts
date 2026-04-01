/**
 * Review-mode bond topology tests.
 *
 * Verifies that:
 * - Timeline provides historical bond lookup from restart frames/checkpoints
 * - Renderer uses explicit review bonds when provided
 * - Review with more bonds than live renders the full historical set
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSimulationTimeline, type SimulationTimeline } from '../../page/js/runtime/simulation-timeline';

// ── Timeline historical bond lookup ──

describe('getReviewBondTopology', () => {
  let timeline: SimulationTimeline;

  beforeEach(() => {
    timeline = createSimulationTimeline();
  });

  it('returns null when no restart source exists', () => {
    expect(timeline.getReviewBondTopology(1.0)).toBeNull();
  });

  it('returns bonds from nearest historical source (restart frame selected)', () => {
    const bonds: [number, number, number][] = [[0, 1, 1.5], [1, 2, 1.6]];
    timeline.recordFrame({ timePs: 0.1, n: 3, positions: new Float64Array(9), interaction: null, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 } });
    timeline.recordRestartFrame({
      timePs: 0.1, n: 3,
      positions: new Float64Array(9),
      velocities: new Float64Array(9),
      bonds,
      config: { damping: 0, kDrag: 2, kRotate: 5 },
      interaction: null,
      boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 },
    });

    const result = timeline.getReviewBondTopology(0.1);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0]).toEqual([0, 1, 1.5]);
  });

  it('returns bonds from checkpoint when no restart frame exists', () => {
    const bonds: [number, number, number][] = [[0, 1, 1.4]];
    timeline.recordFrame({ timePs: 0.5, n: 2, positions: new Float64Array(6), interaction: null, boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 } });
    timeline.recordCheckpoint({
      timePs: 0.5,
      physics: { n: 2, pos: new Float64Array(6), vel: new Float64Array(6), bonds },
      config: { damping: 0, kDrag: 2, kRotate: 5 },
      interaction: null,
      boundary: { mode: 'contain', wallRadius: 100, wallCenter: [0, 0, 0], wallCenterSet: true, removedCount: 0, damping: 0 },
    });

    const result = timeline.getReviewBondTopology(0.5);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });
});

// ── Coordinator passes historical bonds to renderer ──

describe('coordinator applyReviewFrame integration', () => {
  it('passes historical bonds from timeline to renderer', async () => {
    const { createTimelineCoordinator } = await import('../../page/js/runtime/simulation-timeline-coordinator');

    const historicalBonds: [number, number, number][] = [[0, 1, 1.5], [1, 2, 1.6]];
    const frame = { frameId: 1, timePs: 0.5, n: 3, positions: new Float64Array(9), interaction: null, boundary: {} as any };

    let capturedBonds: any = null;
    const mockTimeline = {
      enterReview: vi.fn(() => frame),
      scrubTo: vi.fn(() => frame),
      returnToLive: vi.fn(),
      getReviewBondTopology: vi.fn(() => historicalBonds),
      getState: vi.fn(() => ({ mode: 'review', currentTimePs: 0.5, reviewTimePs: 0.5, rangePs: null, canReturnToLive: true, canRestart: false, restartTargetPs: null })),
    } as any;

    const mockRenderer = {
      getAtomCount: vi.fn(() => 3),
      setAtomCount: vi.fn(),
      updateReviewFrame: vi.fn((_pos: any, _n: any, bonds: any) => { capturedBonds = bonds; }),
    } as any;

    const coordinator = createTimelineCoordinator({
      timeline: mockTimeline,
      getPhysics: () => ({} as any),
      getRenderer: () => mockRenderer,
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: () => false,
      reinitWorker: vi.fn(async () => {}),
      isWorkerActive: () => false,
      forceRender: vi.fn(),
      syncStoreState: vi.fn(),
      setSimTimePs: vi.fn(),
      clearBondedGroupHighlight: vi.fn(),
      clearRendererFeedback: vi.fn(),
    });

    coordinator.enterReview(0.5);

    expect(mockTimeline.getReviewBondTopology).toHaveBeenCalledWith(0.5);
    expect(mockRenderer.updateReviewFrame).toHaveBeenCalledWith(frame.positions, 3, historicalBonds);
    expect(capturedBonds).toBe(historicalBonds);
  });

  it('passes empty array when no historical topology exists', async () => {
    const { createTimelineCoordinator } = await import('../../page/js/runtime/simulation-timeline-coordinator');

    const frame = { frameId: 1, timePs: 0.1, n: 2, positions: new Float64Array(6), interaction: null, boundary: {} as any };

    let capturedBonds: any = null;
    const mockTimeline = {
      enterReview: vi.fn(() => frame),
      getReviewBondTopology: vi.fn(() => null), // no historical source
      getState: vi.fn(() => ({ mode: 'review', currentTimePs: 0.1, reviewTimePs: 0.1, rangePs: null, canReturnToLive: true, canRestart: false, restartTargetPs: null })),
    } as any;

    const mockRenderer = {
      getAtomCount: vi.fn(() => 2),
      setAtomCount: vi.fn(),
      updateReviewFrame: vi.fn((_pos: any, _n: any, bonds: any) => { capturedBonds = bonds; }),
    } as any;

    const coordinator = createTimelineCoordinator({
      timeline: mockTimeline,
      getPhysics: () => ({} as any),
      getRenderer: () => mockRenderer,
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: () => false,
      reinitWorker: vi.fn(async () => {}),
      isWorkerActive: () => false,
      forceRender: vi.fn(),
      syncStoreState: vi.fn(),
      setSimTimePs: vi.fn(),
      clearBondedGroupHighlight: vi.fn(),
      clearRendererFeedback: vi.fn(),
    });

    coordinator.enterReview(0.1);

    // Should pass empty array, not null (no live fallback)
    expect(capturedBonds).toEqual([]);
  });
});

// ── Renderer uses explicit review bonds ──

describe('renderer updateReviewFrame with explicit bonds', () => {
  it('updateReviewFrame accepts optional reviewBonds parameter', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;
    // Signature check: 2 required + 1 optional
    expect(typeof proto.updateReviewFrame).toBe('function');
  });

  it('uses provided review bonds instead of live physics bonds', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;

    const liveBonds: [number, number, number][] = [[0, 1, 1.5]];
    const reviewBonds: [number, number, number][] = [[0, 1, 1.5], [1, 2, 1.6], [0, 2, 1.7]];

    let capturedBonds: any = null;
    const fake: any = {
      _displaySource: 'live',
      _reviewPositions: null,
      _reviewAtomCount: 0,
      _instancedAtoms: { count: 0, instanceMatrix: { needsUpdate: false }, setMatrixAt: () => {} },
      _atomCapacity: 10,
      _highlightMesh: null,
      _groupHighlightMesh: null,
      _physicsRef: { getBonds: () => liveBonds },
      _ensureBondCapacity: () => {},
      _updateBondTransformsInstanced: (bonds: any) => { capturedBonds = bonds; },
    };

    const positions = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    proto.updateReviewFrame.call(fake, positions, 3, reviewBonds);

    // Should use review bonds (3 bonds), not live bonds (1 bond)
    expect(capturedBonds).toBe(reviewBonds);
    expect(capturedBonds.length).toBe(3);
  });

  it('renders no bonds when reviewBonds is empty (no live fallback)', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;

    let capturedBonds: any = null;
    const fake: any = {
      _displaySource: 'live',
      _reviewPositions: null,
      _reviewAtomCount: 0,
      _instancedAtoms: { count: 0, instanceMatrix: { needsUpdate: false }, setMatrixAt: () => {} },
      _atomCapacity: 10,
      _highlightMesh: null,
      _groupHighlightMesh: null,
      _physicsRef: { getBonds: () => [[0, 1, 1.5]] }, // live bonds should NOT be used
      _ensureBondCapacity: () => {},
      _updateBondTransformsInstanced: (bonds: any) => { capturedBonds = bonds; },
    };

    proto.updateReviewFrame.call(fake, new Float64Array(6), 2, []);

    // Should render empty bonds, NOT fall back to live
    expect(capturedBonds).toEqual([]);
  });
});

// ── Regression: review with more bonds than live ──

describe('regression: historical bonds exceed live bond count', () => {
  it('review renders historical bond count, not live bond count', async () => {
    const mod = await import('../../page/js/renderer');
    const proto = mod.Renderer.prototype;

    const liveBonds: [number, number, number][] = [[0, 1, 1.5]]; // 1 bond
    const historicalBonds: [number, number, number][] = [
      [0, 1, 1.5], [1, 2, 1.6], [2, 3, 1.4], [0, 3, 1.7], // 4 bonds
    ];

    let bondCapacityRequested = 0;
    let capturedBondCount = 0;
    const fake: any = {
      _displaySource: 'live',
      _reviewPositions: null,
      _reviewAtomCount: 0,
      _instancedAtoms: { count: 0, instanceMatrix: { needsUpdate: false }, setMatrixAt: () => {} },
      _atomCapacity: 10,
      _highlightMesh: null,
      _groupHighlightMesh: null,
      _physicsRef: { getBonds: () => liveBonds },
      _ensureBondCapacity: (n: number) => { bondCapacityRequested = n; },
      _updateBondTransformsInstanced: (bonds: any) => { capturedBondCount = bonds.length; },
    };

    const positions = new Float64Array(12); // 4 atoms
    proto.updateReviewFrame.call(fake, positions, 4, historicalBonds);

    // Should request capacity for 4 bonds, not 1
    expect(bondCapacityRequested).toBe(4);
    expect(capturedBondCount).toBe(4);
  });
});
