/**
 * Tests for src/share/share-record.ts
 *
 * Covers: accessibility predicates, metadata response mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  isAccessibleStatus,
  toMetadataResponse,
  type CapsuleShareRow,
  type ShareRecordStatus,
} from '../../src/share/share-record';

describe('isAccessibleStatus', () => {
  it('returns true for ready', () => {
    expect(isAccessibleStatus('ready')).toBe(true);
  });

  it('returns true for ready_pending_preview', () => {
    expect(isAccessibleStatus('ready_pending_preview')).toBe(true);
  });

  it('returns false for pending_upload', () => {
    expect(isAccessibleStatus('pending_upload')).toBe(false);
  });

  it('returns false for rejected', () => {
    expect(isAccessibleStatus('rejected')).toBe(false);
  });

  it('returns false for deleted', () => {
    expect(isAccessibleStatus('deleted')).toBe(false);
  });
});

function makeRow(overrides: Partial<CapsuleShareRow> = {}): CapsuleShareRow {
  return {
    id: 'test-id',
    share_code: '7M4K2D8Q9T1V',
    status: 'ready',
    owner_user_id: 'user-1',
    object_key: 'capsules/test-id/capsule.atomdojo',
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    app_version: '0.1.0',
    sha256: 'abc123',
    size_bytes: 12345,
    frame_count: 100,
    atom_count: 42,
    max_atom_count: 42,
    duration_ps: 10.5,
    has_appearance: 1,
    has_interaction: 0,
    title: null,
    preview_status: 'none',
    preview_poster_key: null,
    preview_motion_key: null,
    created_at: '2026-04-13T00:00:00Z',
    uploaded_at: '2026-04-13T00:00:00Z',
    published_at: '2026-04-13T00:00:00Z',
    last_accessed_at: null,
    rejection_reason: null,
    ...overrides,
  };
}

describe('toMetadataResponse', () => {
  it('maps basic fields correctly', () => {
    const row = makeRow();
    const meta = toMetadataResponse(row);
    expect(meta.shareCode).toBe('7M4K2D8Q9T1V');
    expect(meta.kind).toBe('capsule');
    expect(meta.version).toBe(1);
    expect(meta.sizeBytes).toBe(12345);
    expect(meta.frameCount).toBe(100);
    expect(meta.atomCount).toBe(42);
    expect(meta.maxAtomCount).toBe(42);
    expect(meta.durationPs).toBe(10.5);
    expect(meta.hasAppearance).toBe(true);
    expect(meta.hasInteraction).toBe(false);
  });

  it('omits preview when preview_status is "none"', () => {
    const row = makeRow({ preview_status: 'none' });
    const meta = toMetadataResponse(row);
    expect(meta.previewStatus).toBe('none');
    expect(meta.preview).toBeUndefined();
  });

  it('omits preview when preview_status is "pending"', () => {
    const row = makeRow({ preview_status: 'pending' });
    const meta = toMetadataResponse(row);
    expect(meta.previewStatus).toBe('pending');
    expect(meta.preview).toBeUndefined();
  });

  it('includes preview.posterUrl when preview_status is "ready"', () => {
    const row = makeRow({
      preview_status: 'ready',
      preview_poster_key: 'capsules/test-id/preview-poster.png',
    });
    const meta = toMetadataResponse(row);
    expect(meta.previewStatus).toBe('ready');
    expect(meta.preview?.posterUrl).toBe('/api/capsules/7M4K2D8Q9T1V/preview/poster');
  });

  it('omits preview even if preview_status=ready but no poster key', () => {
    const row = makeRow({ preview_status: 'ready', preview_poster_key: null });
    const meta = toMetadataResponse(row);
    expect(meta.preview).toBeUndefined();
  });
});
