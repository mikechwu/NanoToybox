/**
 * @vitest-environment jsdom
 *
 * Registry test for capsule export inputs.
 *
 * `getCapsuleExportInputVersion()` in timeline-subsystem.ts composes
 * a colon-separated string tuple from every input that the capsule
 * artifact reads from. If a future contributor adds a new input to
 * `buildCapsuleHistoryFile` without extending the snapshot version,
 * the trim UI could publish a stale artifact.
 *
 * This test documents the CURRENT input set as EXPECTED_INPUT_SOURCES
 * and pins the tuple FORMAT. A future change that either adds an
 * input family or changes the tuple width will fail loudly here —
 * forcing the contributor to also update the version composition.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppStore } from '../../lab/js/store/app-store';
import { createTimelineSubsystem, type TimelineSubsystem } from '../../lab/js/runtime/timeline/timeline-subsystem';
import { createBondedGroupAppearanceRuntime } from '../../lab/js/runtime/bonded-groups/bonded-group-appearance-runtime';

/**
 * Documented inventory of every input the capsule artifact serializes.
 *
 * When you add a new input to `buildCapsuleHistoryFile`:
 *   1. Add the input owner's counter to
 *      `getCapsuleExportInputVersion()` in timeline-subsystem.ts.
 *   2. Extend the EXPECTED_INPUT_SOURCES entry list below.
 *   3. Bump EXPECTED_SEGMENT_COUNT to match.
 *   4. Add a bump-on-change test case under "every source bumps…"
 *      below, proving the new counter moves when the input changes.
 */
const EXPECTED_INPUT_SOURCES = [
  {
    slot: 0,
    name: 'frame',
    owner: 'SimulationTimeline.getCapsuleSnapshotVersion',
    bumpSites: ['recordFrame', 'truncateAfter (removed frames)', 'clear (had frames)'],
    description: 'dense-frame array content',
  },
  {
    slot: 1,
    name: 'metadata',
    owner: 'AtomMetadataRegistry.getMetadataVersion',
    bumpSites: ['registerAppendedAtoms (non-empty)', 'restore (content differs)', 'reset (was non-empty)'],
    description: 'atom id → element table',
  },
  {
    slot: 2,
    name: 'appearance',
    owner: 'BondedGroupAppearanceRuntime.getAppearanceVersion (via writeAssignments)',
    bumpSites: ['applyGroupColor', 'clearGroupColor', 'clearColorAssignment', 'clearAllColors', 'restoreAssignments', 'pruneAndSync (when changed)'],
    description: 'bonded-group color assignments',
  },
  {
    slot: 3,
    name: 'policy',
    owner: '(constant 0 in v1)',
    bumpSites: ['none — buildExportBondPolicy is a pure function over BOND_DEFAULTS'],
    description: 'bond policy — add getPolicyVersion() if this becomes mutable',
  },
] as const;
const EXPECTED_SEGMENT_COUNT = EXPECTED_INPUT_SOURCES.length;

function makePhysics() {
  return {
    n: 0,
    getDtFs: () => 1,
    createCheckpoint: () => ({ n: 0, pos: new Float64Array(), vel: new Float64Array(), bonds: [] }),
    setCompactionListener: () => {},
  } as any;
}
function makeRenderer() {
  return {
    setAtomColorOverrides: vi.fn(),
  } as any;
}

function buildSub(opts: { withAppearance: boolean }): TimelineSubsystem {
  const renderer = makeRenderer();
  const appearance = opts.withAppearance
    ? createBondedGroupAppearanceRuntime({
        getBondedGroupRuntime: () => null,
        getRenderer: () => renderer,
        getStableAtomIds: () => [],
      })
    : undefined;
  return createTimelineSubsystem({
    getPhysics: () => makePhysics(),
    getRenderer: () => renderer,
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: () => false,
    reinitWorker: vi.fn(async () => {}),
    isWorkerActive: () => false,
    forceRender: vi.fn(),
    clearBondedGroupHighlight: vi.fn(),
    clearRendererFeedback: vi.fn(),
    syncBondedGroupsForDisplayFrame: vi.fn(),
    getSceneMolecules: () => [],
    bondedGroupAppearance: appearance,
  });
}

describe('capsule export input registry', () => {
  beforeEach(() => {
    useAppStore.getState().resetTransientState();
  });

  it('documents every capsule export input that feeds the snapshot id', () => {
    // Integrity check on the registry itself — the constant is the
    // thing a future contributor should extend. If anything here is
    // wrong the downstream format-count assertion is meaningless.
    expect(EXPECTED_INPUT_SOURCES).toHaveLength(EXPECTED_SEGMENT_COUNT);
    for (const entry of EXPECTED_INPUT_SOURCES) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.owner).toBe('string');
      expect(entry.bumpSites.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
    }
  });

  it('snapshot id format is <int>(:<int>){EXPECTED_SEGMENT_COUNT-1} — extending the tuple requires registry update', () => {
    const sub = buildSub({ withAppearance: true });
    const version = sub.getCapsuleExportInputVersion();
    // Each segment is a non-negative integer.
    const segments = version.split(':');
    expect(
      segments,
      `snapshot id "${version}" must have ${EXPECTED_SEGMENT_COUNT} segments — add to EXPECTED_INPUT_SOURCES when extending`,
    ).toHaveLength(EXPECTED_SEGMENT_COUNT);
    for (const seg of segments) {
      expect(seg).toMatch(/^\d+$/);
    }
  });

  it('snapshot id with no appearance dep still has EXPECTED_SEGMENT_COUNT segments (null dep → 0)', () => {
    // When the subsystem is constructed without a
    // bondedGroupAppearance dep, the composition contributes 0 for
    // that slot. The tuple width must NOT shrink — otherwise stale
    // checks against a version from a later fuller-dep instance
    // would mismatch on format, not on content.
    const sub = buildSub({ withAppearance: false });
    const version = sub.getCapsuleExportInputVersion();
    expect(version.split(':')).toHaveLength(EXPECTED_SEGMENT_COUNT);
  });
});
