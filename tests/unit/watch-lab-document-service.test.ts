/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import {
  createWatchDocumentService,
  deriveDocumentKey,
  fnv1a32Hex,
  type DocumentMetadata,
} from '../../watch/js/watch-document-service';

/** Build a capsule file minimal enough to pass the importer. */
function makeMinimalCapsuleFile(): string {
  const capsule = {
    format: 'atomdojo-history',
    version: 1,
    kind: 'capsule',
    producer: { app: 'lab', appVersion: 'test', exportedAt: new Date().toISOString() },
    simulation: {
      units: { time: 'ps', length: 'angstrom' },
      maxAtomCount: 2,
      durationPs: 0.1,
      frameCount: 2,
      indexingModel: 'dense-prefix',
    },
    atoms: { atoms: [ { id: 0, element: 'C' }, { id: 1, element: 'C' } ] },
    bondPolicy: { policyId: 'default-carbon-v1', cutoff: 1.9, minDist: 1.1 },
    timeline: {
      denseFrames: [
        {
          frameId: 0,
          timePs: 0,
          n: 2,
          atomIds: [0, 1],
          positions: [0, 0, 0, 1, 0, 0],
        },
        {
          frameId: 1,
          timePs: 0.1,
          n: 2,
          atomIds: [0, 1],
          positions: [0, 0, 0, 1.05, 0, 0],
        },
      ],
    },
  };
  return JSON.stringify(capsule);
}

function makeBlob(contents: string): Blob {
  return new Blob([contents], { type: 'application/json' });
}

describe('fnv1a32Hex', () => {
  it('returns a deterministic 8-char hex string', () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
    const h = fnv1a32Hex(bytes);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(h).toBe(fnv1a32Hex(bytes));
  });

  it('differs between different inputs', () => {
    const a = fnv1a32Hex(new Uint8Array([0]));
    const b = fnv1a32Hex(new Uint8Array([1]));
    expect(a).not.toBe(b);
  });
});

describe('deriveDocumentKey', () => {
  const base: DocumentMetadata = {
    fileName: null,
    fileKind: null,
    atomCount: 0,
    frameCount: 0,
    maxAtomCount: 0,
    documentFingerprint: null,
    fileByteLength: null,
    shareCode: null,
  };

  it('returns share: prefix when shareCode present', () => {
    expect(deriveDocumentKey({ ...base, shareCode: 'abc123' })).toBe('share:abc123');
  });

  it('returns file: prefix when fingerprint + byteLength present', () => {
    expect(deriveDocumentKey({
      ...base,
      documentFingerprint: 'deadbeef',
      fileByteLength: 2048,
    })).toBe('file:deadbeef:2048');
  });

  it('returns null when unloaded', () => {
    expect(deriveDocumentKey(base)).toBeNull();
  });
});

describe('WatchDocumentService lifecycle (rev 6)', () => {
  it('prepare computes fingerprint + byteLength from the slice ONLY (bounded allocation)', async () => {
    const svc = createWatchDocumentService();
    const contents = makeMinimalCapsuleFile();
    // Wrap in a File so .name survives.
    const blob = makeBlob(contents);
    const file = new File([blob], 'test-capsule.atomdojo', { type: 'application/json' });
    const result = await svc.prepare(file);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(result.fileByteLength).toBe(file.size);
    expect(result.fileName).toBe('test-capsule.atomdojo');
  });

  it('commit(local) stores all extras + null shareCode', async () => {
    const svc = createWatchDocumentService();
    const file = new File([makeMinimalCapsuleFile()], 'x.atomdojo');
    const prep = await svc.prepare(file);
    if (prep.status !== 'ready') throw new Error('prepare failed');
    svc.commit(prep.history, prep.fileName, {
      fingerprint: prep.fingerprint,
      fileByteLength: prep.fileByteLength,
      shareCode: null,
    });
    const meta = svc.getMetadata();
    expect(meta.fileName).toBe('x.atomdojo');
    expect(meta.documentFingerprint).toBe(prep.fingerprint);
    expect(meta.fileByteLength).toBe(prep.fileByteLength);
    expect(meta.shareCode).toBeNull();
  });

  it('commit(shared) stores shareCode AND fingerprint (both live together)', async () => {
    const svc = createWatchDocumentService();
    const file = new File([makeMinimalCapsuleFile()], 'share-x.atomdojo');
    const prep = await svc.prepare(file);
    if (prep.status !== 'ready') throw new Error('prepare failed');
    svc.commit(prep.history, prep.fileName, {
      fingerprint: prep.fingerprint,
      fileByteLength: prep.fileByteLength,
      shareCode: 'abc-123',
    });
    expect(svc.getMetadata().shareCode).toBe('abc-123');
    expect(svc.getMetadata().documentFingerprint).toBe(prep.fingerprint);
  });

  it('local commit after shared commit overwrites shareCode to null', async () => {
    const svc = createWatchDocumentService();
    const shared = await svc.prepare(new File([makeMinimalCapsuleFile()], 's.atomdojo'));
    if (shared.status !== 'ready') throw new Error('prepare failed');
    svc.commit(shared.history, shared.fileName, {
      fingerprint: shared.fingerprint,
      fileByteLength: shared.fileByteLength,
      shareCode: 'abc-123',
    });
    expect(svc.getMetadata().shareCode).toBe('abc-123');
    const local = await svc.prepare(new File([makeMinimalCapsuleFile()], 'l.atomdojo'));
    if (local.status !== 'ready') throw new Error('prepare failed');
    svc.commit(local.history, local.fileName, {
      fingerprint: local.fingerprint,
      fileByteLength: local.fileByteLength,
      shareCode: null,
    });
    expect(svc.getMetadata().shareCode).toBeNull();
    expect(svc.getMetadata().documentFingerprint).toBe(local.fingerprint);
  });

  it('saveForRollback + restoreFromRollback preserves ALL new fields', async () => {
    const svc = createWatchDocumentService();
    const prep = await svc.prepare(new File([makeMinimalCapsuleFile()], 'a.atomdojo'));
    if (prep.status !== 'ready') throw new Error('prepare failed');
    svc.commit(prep.history, prep.fileName, {
      fingerprint: prep.fingerprint,
      fileByteLength: prep.fileByteLength,
      shareCode: 'xyz',
    });
    const saved = svc.saveForRollback();
    svc.clear();
    expect(svc.getMetadata().fileName).toBeNull();
    svc.restoreFromRollback(saved);
    expect(svc.getMetadata().fileName).toBe('a.atomdojo');
    expect(svc.getMetadata().shareCode).toBe('xyz');
    expect(svc.getMetadata().documentFingerprint).toBe(prep.fingerprint);
    expect(svc.getMetadata().fileByteLength).toBe(prep.fileByteLength);
  });

  it('clear() resets every new field to null/0', async () => {
    const svc = createWatchDocumentService();
    const prep = await svc.prepare(new File([makeMinimalCapsuleFile()], 'a.atomdojo'));
    if (prep.status !== 'ready') throw new Error('prepare failed');
    svc.commit(prep.history, prep.fileName, {
      fingerprint: prep.fingerprint,
      fileByteLength: prep.fileByteLength,
      shareCode: 'xyz',
    });
    svc.clear();
    const meta = svc.getMetadata();
    expect(meta.documentFingerprint).toBeNull();
    expect(meta.fileByteLength).toBeNull();
    expect(meta.shareCode).toBeNull();
  });
});
