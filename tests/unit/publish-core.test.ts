/**
 * Tests for src/share/publish-core.ts
 *
 * Covers: preparePublishRecord validation, metadata extraction, hash computation.
 * persistRecord requires D1 and is tested at integration level.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  preparePublishRecord,
  persistRecord,
  PublishValidationError,
} from '../../src/share/publish-core';

/** Minimal valid capsule file JSON for testing. */
function makeValidCapsuleJson(): string {
  return JSON.stringify({
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: '0.1.0', exportedAt: '2026-04-13T00:00:00Z' },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: 1.0,
      frameCount: 2,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [
      { id: 0, element: 'C' },
      { id: 1, element: 'C' },
    ] },
    bondPolicy: { version: 1, mode: 'auto', rules: [] },
    timeline: {
      denseFrames: [
        { frameId: 0, timePs: 0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 0, 0] },
        { frameId: 1, timePs: 1.0, n: 2, atomIds: [0, 1], positions: [0, 0, 0, 1, 1, 0] },
      ],
    },
  });
}

describe('preparePublishRecord', () => {
  it('prepares a valid capsule', async () => {
    const json = makeValidCapsuleJson();
    const record = await preparePublishRecord({
      capsuleJson: json,
      ownerUserId: 'user-1',
      shareMode: 'account',
      expiresAt: null,
      appVersion: '0.1.0',
    });

    expect(record.id).toBeTruthy();
    expect(record.objectKey).toMatch(/^capsules\/[^/]+\/capsule\.atomdojo$/);
    expect(record.ownerUserId).toBe('user-1');
    expect(record.sizeBytes).toBeGreaterThan(0);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.blob).toBeInstanceOf(Uint8Array);

    // Metadata
    expect(record.metadata.format).toBe('atomdojo-history');
    expect(record.metadata.version).toBe(1);
    expect(record.metadata.kind).toBe('capsule');
    expect(record.metadata.frameCount).toBe(2);
    expect(record.metadata.atomCount).toBe(2);
    expect(record.metadata.maxAtomCount).toBe(2);
    expect(record.metadata.durationPs).toBe(1.0);
    expect(record.metadata.hasAppearance).toBe(false);
    expect(record.metadata.hasInteraction).toBe(false);
  });

  it('detects appearance', async () => {
    const capsule = JSON.parse(makeValidCapsuleJson());
    capsule.appearance = { colorAssignments: [] };
    const record = await preparePublishRecord({
      capsuleJson: JSON.stringify(capsule),
      ownerUserId: 'user-1',
      shareMode: 'account',
      expiresAt: null,
      appVersion: '0.1.0',
    });
    expect(record.metadata.hasAppearance).toBe(true);
  });

  it('detects interaction timeline', async () => {
    const capsule = JSON.parse(makeValidCapsuleJson());
    capsule.timeline.interactionTimeline = { encoding: 'event-stream-v1', events: [] };
    const record = await preparePublishRecord({
      capsuleJson: JSON.stringify(capsule),
      ownerUserId: 'user-1',
      shareMode: 'account',
      expiresAt: null,
      appVersion: '0.1.0',
    });
    expect(record.metadata.hasInteraction).toBe(true);
  });

  it('rejects invalid JSON', async () => {
    await expect(
      preparePublishRecord({
        capsuleJson: '{bad json',
        ownerUserId: 'user-1',
        shareMode: 'account',
        expiresAt: null,
        appVersion: '0.1.0',
      }),
    ).rejects.toThrow(PublishValidationError);
  });

  it('rejects non-capsule kind', async () => {
    const full = JSON.parse(makeValidCapsuleJson());
    full.kind = 'full';
    await expect(
      preparePublishRecord({
        capsuleJson: JSON.stringify(full),
        ownerUserId: 'user-1',
        shareMode: 'account',
        expiresAt: null,
        appVersion: '0.1.0',
      }),
    ).rejects.toThrow(PublishValidationError);
  });

  it('rejects capsule with empty frames', async () => {
    const capsule = JSON.parse(makeValidCapsuleJson());
    capsule.timeline.denseFrames = [];
    await expect(
      preparePublishRecord({
        capsuleJson: JSON.stringify(capsule),
        ownerUserId: 'user-1',
        shareMode: 'account',
        expiresAt: null,
        appVersion: '0.1.0',
      }),
    ).rejects.toThrow(PublishValidationError);
  });

  it('rejects capsule with missing bondPolicy', async () => {
    const capsule = JSON.parse(makeValidCapsuleJson());
    delete capsule.bondPolicy;
    await expect(
      preparePublishRecord({
        capsuleJson: JSON.stringify(capsule),
        ownerUserId: 'user-1',
        shareMode: 'account',
        expiresAt: null,
        appVersion: '0.1.0',
      }),
    ).rejects.toThrow(PublishValidationError);
  });

  it('computes deterministic SHA-256', async () => {
    const json = makeValidCapsuleJson();
    const r1 = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    const r2 = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    expect(r1.sha256).toBe(r2.sha256);
  });

  it('generates different record IDs for same input', async () => {
    const json = makeValidCapsuleJson();
    const r1 = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    const r2 = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    expect(r1.id).not.toBe(r2.id);
  });

  // ── V2 publish-time pre-bake (spec §S1, AC #25) ────────────────────────
  it('V2: attaches previewSceneV1Json for a valid capsule', async () => {
    const r = await preparePublishRecord({
      capsuleJson: makeValidCapsuleJson(),
      ownerUserId: 'u',
      shareMode: 'account',
      expiresAt: null,
      appVersion: '0.1.0',
    });
    expect(r.previewSceneV1Json).not.toBeNull();
    const parsed = JSON.parse(r.previewSceneV1Json!);
    expect(parsed.v).toBe(1);
    expect(parsed.atoms.length).toBe(2);
    expect(parsed.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('V2: previewSceneV1Json is deterministic for identical capsule JSON', async () => {
    const json = makeValidCapsuleJson();
    const r1 = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    const r2 = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    expect(r1.previewSceneV1Json).toBe(r2.previewSceneV1Json);
  });
});

// ── persistRecord tests with mock D1 ──

function makeMockDb(opts: {
  failCount?: number;
  failWithUniqueError?: boolean;
} = {}) {
  let insertAttempts = 0;
  let failsRemaining = opts.failCount ?? 0;
  const inserted: { code: string; id: string }[] = [];

  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn(async () => {
      insertAttempts++;
      if (failsRemaining > 0) {
        failsRemaining--;
        if (opts.failWithUniqueError !== false) {
          throw new Error('UNIQUE constraint failed: capsule_share.share_code');
        } else {
          throw new Error('Database connection error');
        }
      }
      return { success: true };
    }),
  };

  const db = {
    prepare: vi.fn(() => mockStatement),
    _getInsertAttempts: () => insertAttempts,
    _getInserted: () => inserted,
    _mockStatement: mockStatement,
  };

  return db as unknown as D1Database & {
    _getInsertAttempts: () => number;
    _mockStatement: typeof mockStatement;
  };
}

// Minimal D1Database type for test context
type D1Database = import('../../src/share/publish-core').PersistedPublishRecord extends { shareCode: string } ? Parameters<typeof persistRecord>[0] : never;

describe('persistRecord', () => {
  it('succeeds on first attempt', async () => {
    const json = makeValidCapsuleJson();
    const prepared = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    const db = makeMockDb();

    const result = await persistRecord(db, prepared);
    expect(result.shareCode).toBeTruthy();
    expect(result.shareCode).toHaveLength(12);
    expect(result.id).toBe(prepared.id);
    expect(db._getInsertAttempts()).toBe(1);
  });

  it('retries on UNIQUE constraint error and succeeds', async () => {
    const json = makeValidCapsuleJson();
    const prepared = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    const db = makeMockDb({ failCount: 2 }); // fail first 2, succeed on 3rd

    const result = await persistRecord(db, prepared);
    expect(result.shareCode).toBeTruthy();
    expect(db._getInsertAttempts()).toBe(3);
  });

  it('throws after 5 consecutive UNIQUE constraint failures', async () => {
    const json = makeValidCapsuleJson();
    const prepared = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    const db = makeMockDb({ failCount: 5 });

    await expect(persistRecord(db, prepared)).rejects.toThrow(
      'Failed to generate a unique share code after 5 attempts',
    );
    expect(db._getInsertAttempts()).toBe(5);
  });

  it('rethrows non-UNIQUE errors immediately without retry', async () => {
    const json = makeValidCapsuleJson();
    const prepared = await preparePublishRecord({ capsuleJson: json, ownerUserId: 'u', shareMode: 'account', expiresAt: null, appVersion: '0.1.0' });
    const db = makeMockDb({ failCount: 1, failWithUniqueError: false });

    await expect(persistRecord(db, prepared)).rejects.toThrow('Database connection error');
    expect(db._getInsertAttempts()).toBe(1); // no retry
  });
});
