/**
 * Tests for src/share/share-record.ts
 *
 * Covers: accessibility predicates, metadata response mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  isAccessibleStatus,
  isDynamicPreviewFallbackEnabled,
  toMetadataResponse,
  type CapsuleShareRow,
  type ShareRecordStatus,
} from '../../src/share/share-record';
import { TEMPLATE_VERSION } from '../../src/share/capsule-preview';

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
    preview_scene_v1: null,
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

  it('includes preview.posterUrl with stored cache key when preview_status is "ready"', () => {
    // Stored-asset key first 8 hex chars become the `?v=p…` cache key (spec §12).
    const row = makeRow({
      preview_status: 'ready',
      preview_poster_key: 'capsules/abc123def456/preview-poster.png',
    });
    const meta = toMetadataResponse(row);
    expect(meta.previewStatus).toBe('ready');
    expect(meta.preview?.posterUrl).toMatch(
      /^\/api\/capsules\/7M4K2D8Q9T1V\/preview\/poster\?v=p[0-9a-f]{8}$/,
    );
    expect(meta.preview?.width).toBe(1200);
    expect(meta.preview?.height).toBe(630);
  });

  it('omits preview when preview_status=ready, no poster key, and dynamic flag off', () => {
    const row = makeRow({ preview_status: 'ready', preview_poster_key: null });
    const meta = toMetadataResponse(row, { dynamicFallbackEnabled: false });
    expect(meta.preview).toBeUndefined();
  });

  // ─── V1 capsule-preview cases (spec §8) ─────────────────────────────────

  it('V1: accessible row with no stored asset + flag on → dynamic poster URL', () => {
    const row = makeRow({ preview_status: 'pending', preview_poster_key: null });
    const meta = toMetadataResponse(row, { dynamicFallbackEnabled: true });
    expect(meta.preview?.posterUrl).toBe(
      `/api/capsules/7M4K2D8Q9T1V/preview/poster?v=t${TEMPLATE_VERSION}`,
    );
    expect(meta.preview?.width).toBe(1200);
    expect(meta.preview?.height).toBe(630);
  });

  it('V1: accessible row + flag off → preview.posterUrl absent', () => {
    const row = makeRow({ preview_status: 'pending', preview_poster_key: null });
    const meta = toMetadataResponse(row, { dynamicFallbackEnabled: false });
    expect(meta.preview).toBeUndefined();
  });

  it('V1: previewStatus === "ready" remains the proxy for stored-asset existence — independent of preview.posterUrl presence', () => {
    // With flag on, both the dynamic-fallback row and the stored row will
    // expose preview.posterUrl. They must remain distinguishable via
    // previewStatus, NOT via the presence of preview.posterUrl.
    const dynamicRow = makeRow({ preview_status: 'pending', preview_poster_key: null });
    const storedRow = makeRow({
      preview_status: 'ready',
      preview_poster_key: 'capsules/abcdef0123/preview-poster.png',
    });
    const dynamic = toMetadataResponse(dynamicRow, { dynamicFallbackEnabled: true });
    const stored = toMetadataResponse(storedRow, { dynamicFallbackEnabled: true });
    expect(dynamic.preview).toBeDefined();
    expect(stored.preview).toBeDefined();
    expect(dynamic.previewStatus).toBe('pending');
    expect(stored.previewStatus).toBe('ready');
  });

  it('V1: inaccessible row + flag on → no dynamic poster URL', () => {
    const row = makeRow({ status: 'rejected', preview_status: 'none', preview_poster_key: null });
    const meta = toMetadataResponse(row, { dynamicFallbackEnabled: true });
    expect(meta.preview).toBeUndefined();
  });

  it('V1: stored asset takes precedence over dynamic flag', () => {
    const row = makeRow({
      preview_status: 'ready',
      preview_poster_key: 'capsules/abcdef0123/preview-poster.png',
    });
    const meta = toMetadataResponse(row, { dynamicFallbackEnabled: true });
    expect(meta.preview?.posterUrl).toMatch(/\?v=p[0-9a-f]{8}$/);
  });
});

describe('isDynamicPreviewFallbackEnabled', () => {
  it('defaults to true when unset', () => {
    expect(isDynamicPreviewFallbackEnabled({})).toBe(true);
  });
  it('is true for "on"', () => {
    expect(isDynamicPreviewFallbackEnabled({ CAPSULE_PREVIEW_DYNAMIC_FALLBACK: 'on' })).toBe(true);
  });
  it('is false for "off"', () => {
    expect(isDynamicPreviewFallbackEnabled({ CAPSULE_PREVIEW_DYNAMIC_FALLBACK: 'off' })).toBe(false);
  });
  it('is false for "false"', () => {
    expect(isDynamicPreviewFallbackEnabled({ CAPSULE_PREVIEW_DYNAMIC_FALLBACK: 'false' })).toBe(false);
  });
  it('is false for "0"', () => {
    expect(isDynamicPreviewFallbackEnabled({ CAPSULE_PREVIEW_DYNAMIC_FALLBACK: '0' })).toBe(false);
  });
});
