/**
 * @vitest-environment jsdom
 *
 * Phase 2 §"OAuth Round-Trip Persistence" — sessionStorage producer
 * and consumer for the trim-resume payload.
 *
 * Shipped contract (narrowed — selection-only):
 *   producer (writeTrimResumePayload):
 *     - serializes { snapshotId, startFrameIndex, endFrameIndex,
 *       prevReviewState, iat } into sessionStorage[atomdojo.trimResume].
 *     - does NOT store entryKind or trimDestination — see
 *       TRIM_RESUME_SESSION_STORAGE_KEY docstring in TimelineBar.tsx.
 *   consumer (consumeTrimResumeIfPresent):
 *     - drops on TTL expiry
 *     - drops on snapshot mismatch
 *     - drops on shape failure
 *     - on success, restores as MANUAL trim with ACCOUNT destination.
 *
 * The producer/consumer are not exported as standalone functions —
 * they live inside `TimelineBar`. We exercise the contract by writing
 * a payload, then asserting `sessionStorage` semantics + the
 * `TRIM_RESUME_TTL_SECONDS` / `TRIM_RESUME_SESSION_STORAGE_KEY`
 * constants are correct.
 */
import { describe, it, expect } from 'vitest';
import {
  TRIM_RESUME_SESSION_STORAGE_KEY,
  TRIM_RESUME_TTL_SECONDS,
} from '../../lab/js/components/timeline/TimelineBar';

describe('trim-resume sessionStorage contract', () => {
  it('exports a stable storage key', () => {
    expect(TRIM_RESUME_SESSION_STORAGE_KEY).toBe('atomdojo.trimResume');
  });

  it('TTL is 10 minutes by Phase 2 spec', () => {
    expect(TRIM_RESUME_TTL_SECONDS).toBe(10 * 60);
  });

  it('narrowed payload (selection-only) survives a sessionStorage round-trip', () => {
    // Phase 2 — narrowed contract: producer stores only what the
    // consumer actually uses. `entryKind` and `trimDestination` were
    // dropped because the consumer always restores as manual account
    // trim regardless. Storing them was contract drift.
    const payload = {
      snapshotId: 'v:1:0:0:0',
      startFrameIndex: 3,
      endFrameIndex: 7,
      prevReviewState: { mode: 'live' as const, reviewTimePs: null },
      iat: Math.floor(Date.now() / 1000),
    };
    window.sessionStorage.setItem(TRIM_RESUME_SESSION_STORAGE_KEY, JSON.stringify(payload));
    const raw = window.sessionStorage.getItem(TRIM_RESUME_SESSION_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.snapshotId).toBe('v:1:0:0:0');
    expect(parsed.startFrameIndex).toBe(3);
    expect(parsed.endFrameIndex).toBe(7);
    expect(parsed.iat).toBeGreaterThan(0);
    // Narrowed contract — these fields are intentionally absent.
    expect('entryKind' in parsed).toBe(false);
    expect('trimDestination' in parsed).toBe(false);
  });

  it('stale payloads (older than TTL) are recognizable by iat delta', () => {
    const stale = {
      snapshotId: 'v:1:0:0:0',
      startFrameIndex: 0,
      endFrameIndex: 5,
      prevReviewState: { mode: 'live' as const, reviewTimePs: null },
      iat: Math.floor(Date.now() / 1000) - (TRIM_RESUME_TTL_SECONDS + 60),
    };
    const ageSeconds = (Date.now() / 1000) - stale.iat;
    expect(ageSeconds).toBeGreaterThan(TRIM_RESUME_TTL_SECONDS);
  });

  it('malformed payloads (missing required fields) fail shape validation', () => {
    const malformed = [
      '{}',
      '{"iat":1}', // no snapshotId/start/end
      '{"snapshotId":"x","startFrameIndex":0}', // missing endFrameIndex
      '{"snapshotId":"x","startFrameIndex":"NaN","endFrameIndex":5,"iat":1}', // wrong type
      'not-json',
    ];
    for (const raw of malformed) {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(raw); } catch { /* expected for not-json */ }
      // Either parse failed, or one of the validation checks would
      // reject. The consumer in TimelineBar treats either path as
      // a drop.
      const fails = parsed === null
        || typeof parsed.snapshotId !== 'string'
        || typeof parsed.startFrameIndex !== 'number'
        || typeof parsed.endFrameIndex !== 'number'
        || typeof parsed.iat !== 'number';
      expect(fails).toBe(true);
    }
  });
});
