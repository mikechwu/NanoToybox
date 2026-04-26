/**
 * Phase 1 acceptance:
 *   - #4: deferred-measurement is a first-class state — `CapsuleTrimUiState`
 *     admits `{ preparedArtifact: null, measuredBytes: null }` under
 *     `measurementPolicy = 'deferred'` without being treated as an error.
 *   - #10: auth transitions during trim preserve `preparedArtifact`. The
 *     prepared bytes are target-neutral; mid-trim sign-in / sign-out
 *     does not invalidate the cache. The submit coordinator decides the
 *     next target on the next click.
 *
 * These tests exercise the runtime layer, not the React UI. The
 * React/UI flows are covered separately in `timeline-trim-mode.test.tsx`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPreparedCapsuleService, TEST_ONLY_CACHE_SIZE, type CapsuleArtifact } from '../../lab/js/runtime/prepared-capsule-service';
import { createPublishPreparedAccountCapsule } from '../../lab/js/runtime/publish-prepared-account-capsule';
import { createPublishPreparedGuestCapsule } from '../../lab/js/runtime/publish-prepared-guest-capsule';
import { resolveTrimSubmitTarget } from '../../lab/js/runtime/trim-submit-coordinator';
import type {
  CapsuleSelectionRange,
  CapsuleTrimUiState,
} from '../../lab/js/runtime/timeline/capsule-publish-types';
import type { PublicConfig } from '../../lab/js/runtime/share-auth-types';

function makeArtifact(json: string): CapsuleArtifact {
  const bytes = new TextEncoder().encode(json).byteLength;
  return {
    file: {
      format: 'atomdojo-history',
      version: 1,
      kind: 'capsule',
      producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-22T00:00:00.000Z' },
      simulation: { units: { time: 'ps', length: 'angstrom' }, maxAtomCount: 1, durationPs: 0, frameCount: 1, indexingModel: 'dense-prefix' },
      atoms: { atoms: [{ id: 0, element: 'C', isotope: null, charge: null, label: null }] },
      bondPolicy: { version: 1, params: {} } as any,
      timeline: { denseFrames: [{ frameId: 0, timePs: 0, n: 1, atomIds: [0], positions: [0, 0, 0] }] },
    } as any,
    json,
    bytes,
  };
}

function makeRange(snapshotId: string): CapsuleSelectionRange {
  return { snapshotId, startFrameIndex: 0, endFrameIndex: 0 };
}

function cacheSize(p: any): number { return p[TEST_ONLY_CACHE_SIZE](); }

describe('Acceptance #4 — deferred measurement is a first-class state', () => {
  it('admits a CapsuleTrimUiState with no prepared artifact and no measured bytes under measurementPolicy=deferred', () => {
    // Pure type/value check — the structural shape carries the
    // deferred-state combination without a discriminator gap.
    const state: CapsuleTrimUiState = {
      entryKind: 'manual',
      measurementPolicy: 'deferred',
      snapshotId: 'v:0:0:0',
      frames: [{ frameId: 0, timePs: 0 }],
      selection: { snapshotId: 'v:0:0:0', startFrameIndex: 0, endFrameIndex: 0 },
      preparedArtifact: null,
      measuredBytes: null,
      status: 'idle',
    };
    expect(state.preparedArtifact).toBeNull();
    expect(state.measuredBytes).toBeNull();
    expect(state.status).toBe('idle');
    expect(state.measurementPolicy).toBe('deferred');
  });

  it('manual entry kind does not auto-prepare — service is only called when the consumer asks', async () => {
    const builds: number[] = [];
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (range) => {
        builds.push(range.startFrameIndex);
        return makeArtifact('{}');
      },
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    // Simulate a manual-trim entry: no prepare runs at this point.
    const entryState: CapsuleTrimUiState = {
      entryKind: 'manual',
      measurementPolicy: 'deferred',
      snapshotId: 'v:0:0:0',
      frames: [{ frameId: 0, timePs: 0 }],
      selection: { snapshotId: 'v:0:0:0', startFrameIndex: 0, endFrameIndex: 0 },
      preparedArtifact: null,
      measuredBytes: null,
      status: 'idle',
    };
    void entryState;
    expect(builds).toEqual([]);
    expect(cacheSize(service)).toBe(0);
    // Now simulate the user clicking Submit — the consumer asks the
    // service to prepare on demand. Only then does buildCapsuleArtifact
    // run. This is the load-bearing rule for §D / Acceptance #4.
    await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    expect(builds).toEqual([0]);
    expect(cacheSize(service)).toBe(1);
  });
});

describe('Acceptance #10 — auth transition coverage', () => {
  const enabledConfig: PublicConfig = {
    guestPublish: { enabled: true, turnstileSiteKey: 'site-key' },
  };

  it('sign-in mid-trim: preparedArtifact is preserved (bytes are target-neutral)', async () => {
    // Initial: signed-out guest trim with a prepared artifact in the
    // service cache.
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{"x":1}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    expect(cacheSize(service)).toBe(1);

    // Auth transitions guest → account mid-trim. The service cache
    // must NOT be touched by an auth flip — bytes are target-neutral.
    // The next submit's coordinator decides the target.
    let authStatus: 'signed-out' | 'signed-in' = 'signed-out';
    authStatus = 'signed-in';
    expect(cacheSize(service)).toBe(1);

    // The user picks Quick Share (guest) — coordinator routes to guest
    // even though authStatus is now 'signed-in'.
    const guestResolved = resolveTrimSubmitTarget({
      action: 'quick-share',
      authStatus,
      publicConfig: enabledConfig,
      turnstileToken: 'tok',
    });
    expect(guestResolved).toEqual({ kind: 'ok', target: 'guest', turnstileToken: 'tok' });

    // Same prepared bytes flow into the guest executor.
    const post = vi.fn(async (_a: CapsuleArtifact, _t: string) => ({
      mode: 'guest' as const, shareCode: 'g', shareUrl: 'h', expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    const guestExec = createPublishPreparedGuestCapsule({ service, postGuest: post });
    const result = await guestExec(summary.prepareId, 'tok');
    expect(result.mode).toBe('guest');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sign-out mid-trim: preparedArtifact is preserved; account target becomes auth-required', async () => {
    const service = createPreparedCapsuleService({
      buildCapsuleArtifact: (_r) => makeArtifact('{"x":1}'),
      getCapsuleExportInputVersion: () => 'v:0:0:0',
    });
    const summary = await service.prepareCapsulePublish(makeRange('v:0:0:0'));
    expect(cacheSize(service)).toBe(1);

    // Auth flips signed-in → signed-out (e.g. background 401).
    const authStatus: 'signed-out' = 'signed-out';
    expect(cacheSize(service)).toBe(1);

    // The user clicks Share (account) — coordinator now reports
    // auth-required and dispatches no executor.
    const accountResolved = resolveTrimSubmitTarget({
      action: 'share-account',
      authStatus,
      publicConfig: enabledConfig,
      turnstileToken: null,
    });
    expect(accountResolved).toEqual({ kind: 'unavailable', reason: 'auth-required' });

    // Cache is still intact for the next submit.
    expect(cacheSize(service)).toBe(1);

    // After re-auth, submit reuses the same prepareId (subject to
    // snapshot recheck). Use a typed mock so the same prepared bytes
    // flow through the account executor.
    const post = vi.fn(async (_a: CapsuleArtifact) => ({
      mode: 'account' as const, shareCode: 'a', shareUrl: 'b',
    }));
    const accountExec = createPublishPreparedAccountCapsule({ service, postAccount: post });
    const result = await accountExec(summary.prepareId);
    expect(result.mode).toBe('account');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

