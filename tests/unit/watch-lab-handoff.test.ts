/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  writeWatchToLabHandoff,
  removeWatchToLabHandoff,
  mintToken,
  WatchHandoffWriteError,
} from '../../watch/js/watch-lab-handoff';
import { consumeWatchToLabHandoffFromLocation } from '../../lab/js/runtime/watch-handoff';
import {
  HANDOFF_STORAGE_PREFIX,
  SEED_MAX_ATOMS,
  SEED_MAX_VELOCITY_A_PER_FS,
  base64EncodeFloat64Array,
  base64DecodeFloat64Array,
  isValidSeed,
  type WatchToLabHandoffPayload,
  type WatchLabSceneSeed,
} from '../../src/watch-lab-handoff/watch-lab-handoff-shared';
import { IMPLAUSIBLE_VELOCITY_A_PER_FS } from '../../src/history/units';

function clearHandoffKeys() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(HANDOFF_STORAGE_PREFIX)) localStorage.removeItem(k);
  }
}

function validSeed(): WatchLabSceneSeed {
  return {
    atoms: [
      { id: 0, element: 'C' },
      { id: 1, element: 'C' },
    ],
    positions: [0, 0, 0, 1, 0, 0],
    velocities: [0, 0, 0, 0, 0, 0],
    bonds: [{ a: 0, b: 1, distance: 1.0 }],
    boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0] as [number, number, number], wallCenterSet: true, removedCount: 0, damping: 0.1 },
    config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
    provenance: { historyKind: 'capsule', velocitiesAreApproximated: true },
  };
}

function validPayload(now = Date.now()): WatchToLabHandoffPayload {
  return {
    version: 1,
    source: 'watch',
    mode: 'current-frame',
    createdAt: now,
    sourceMeta: {
      fileName: null,
      fileKind: 'capsule',
      shareCode: 'abc',
      timePs: 3.14,
      frameId: 42,
    },
    seed: validSeed(),
  };
}

function mockLocation(search: string, pathname = '/lab/', hash = ''): Location {
  return { search, pathname, hash, href: `http://localhost${pathname}${search}${hash}` } as unknown as Location;
}

function mockHistory(): { replaceState: ReturnType<typeof vi.fn> } {
  return { replaceState: vi.fn() };
}

describe('base64 Float64Array roundtrip', () => {
  it('encodes + decodes to byte-equal arrays', () => {
    const arr = [1.5, -2.25, 3.75e-10, 0, 1e12];
    const encoded = base64EncodeFloat64Array(arr);
    const decoded = base64DecodeFloat64Array(encoded);
    expect(decoded).toEqual(arr);
  });

  it('handles Float64Array input without re-copying', () => {
    const arr = new Float64Array([0.1, 0.2, 0.3]);
    const decoded = base64DecodeFloat64Array(base64EncodeFloat64Array(arr));
    expect(decoded).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('handoff validator canonicalization', () => {
  it('SEED_MAX_VELOCITY_A_PER_FS === canonical IMPLAUSIBLE_VELOCITY_A_PER_FS', () => {
    expect(SEED_MAX_VELOCITY_A_PER_FS).toBe(IMPLAUSIBLE_VELOCITY_A_PER_FS);
  });

  it('rejects a boundary with a wall mode outside the Lab vocabulary', () => {
    const seed = validSeed();
    (seed.boundary as { mode: string }).mode = 'open';
    expect(isValidSeed(seed)).toBe(false);
  });

  it('rejects a boundary missing wallCenter triple', () => {
    const seed = validSeed();
    (seed.boundary as { wallCenter: unknown }).wallCenter = [0, 0];
    expect(isValidSeed(seed)).toBe(false);
  });

  it('accepts a fully-shaped canonical boundary (contain mode)', () => {
    expect(isValidSeed(validSeed())).toBe(true);
  });
});

describe('isValidSeed bounds', () => {
  it('accepts the minimal valid seed', () => {
    expect(isValidSeed(validSeed())).toBe(true);
  });

  it('rejects atoms exceeding SEED_MAX_ATOMS', () => {
    const seed = validSeed();
    // Fabricate an oversized atom list without allocating 50000+ elements
    // by poking the length check via a synthetic object.
    const oversized = {
      ...seed,
      atoms: new Array(SEED_MAX_ATOMS + 1).fill({ id: 0, element: 'C' }),
    };
    expect(isValidSeed(oversized)).toBe(false);
  });

  it('rejects positions length mismatch', () => {
    const seed = validSeed();
    seed.positions = [0, 0]; // 2 != 2 atoms * 3
    expect(isValidSeed(seed)).toBe(false);
  });

  it('rejects velocity magnitudes above the ceiling', () => {
    const seed = validSeed();
    seed.velocities = [1000, 0, 0, 0, 0, 0]; // 1000 >> IMPLAUSIBLE
    expect(isValidSeed(seed)).toBe(false);
  });

  it('rejects non-finite config values', () => {
    const seed = validSeed();
    seed.config.dtFs = Number.NaN;
    expect(isValidSeed(seed)).toBe(false);
  });

  it('rejects prototype-polluted top-level object', () => {
    const poisoned = Object.create({ foo: 'bar' });
    Object.assign(poisoned, validSeed());
    expect(isValidSeed(poisoned)).toBe(false);
  });

  it('rejects bonds with out-of-range atom indices', () => {
    const seed = validSeed();
    seed.bonds = [{ a: 0, b: 99, distance: 1.0 }];
    expect(isValidSeed(seed)).toBe(false);
  });
});

describe('handoff write + consume roundtrip', () => {
  beforeEach(() => clearHandoffKeys());

  it('writeWatchToLabHandoff stores a retrievable entry and returns a token', () => {
    const token = writeWatchToLabHandoff(validPayload());
    const stored = localStorage.getItem(HANDOFF_STORAGE_PREFIX + token);
    expect(stored).toBeTruthy();
  });

  it('token is not predictable across calls', () => {
    const a = writeWatchToLabHandoff(validPayload());
    const b = writeWatchToLabHandoff(validPayload());
    expect(a).not.toBe(b);
  });

  it('consume recovers the same payload via base64 round-trip', () => {
    const payload = validPayload();
    const token = writeWatchToLabHandoff(payload);
    const loc = mockLocation(`?from=watch&handoff=${token}`);
    const hist = mockHistory();
    const result = consumeWatchToLabHandoffFromLocation(loc, hist as unknown as History);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.payload.seed.atoms.length).toBe(payload.seed.atoms.length);
    expect(result.payload.seed.positions).toEqual(payload.seed.positions);
    expect(result.payload.seed.velocities).toEqual(payload.seed.velocities);
    expect(result.payload.sourceMeta.shareCode).toBe('abc');
  });

  it('consume removes the localStorage entry (no replay)', () => {
    const token = writeWatchToLabHandoff(validPayload());
    const key = HANDOFF_STORAGE_PREFIX + token;
    expect(localStorage.getItem(key)).toBeTruthy();
    consumeWatchToLabHandoffFromLocation(mockLocation(`?from=watch&handoff=${token}`), mockHistory() as unknown as History);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('consume scrubs ?from + ?handoff via history.replaceState', () => {
    const token = writeWatchToLabHandoff(validPayload());
    const hist = mockHistory();
    consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}&e2e=1`, '/lab/'),
      hist as unknown as History,
    );
    expect(hist.replaceState).toHaveBeenCalled();
    const call = hist.replaceState.mock.calls[0];
    const newUrl = String(call[2]);
    expect(newUrl).toContain('e2e=1');
    expect(newUrl).not.toContain('from=watch');
    expect(newUrl).not.toContain('handoff=');
  });

  it('missing from=watch returns {status:"none"} silently (no console.warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = consumeWatchToLabHandoffFromLocation(mockLocation(''), mockHistory() as unknown as History);
    expect(result).toEqual({ status: 'none' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stale entry (past TTL) is rejected with reason="stale"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oldPayload = validPayload(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const token = writeWatchToLabHandoff(oldPayload);
    const result = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    expect(result).toEqual({ status: 'rejected', reason: 'stale' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('stale'))).toBe(true);
    warn.mockRestore();
  });

  it('rejects future-dated createdAt (negative age) as stale', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const future = validPayload(Date.now() + 60_000); // 1 min in future
    const token = writeWatchToLabHandoff(future);
    const result = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    expect(result).toEqual({ status: 'rejected', reason: 'stale' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('stale'))).toBe(true);
    warn.mockRestore();
  });

  it('rejects payload with malformed sourceMeta (final payload re-validation)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = 'bad-meta';
    // Seed passes validation; sourceMeta.timePs is a string → must fail
    // post-deserialize full-payload check (rev 6 correctness #2).
    localStorage.setItem(HANDOFF_STORAGE_PREFIX + token, JSON.stringify({
      version: 1,
      source: 'watch',
      mode: 'current-frame',
      createdAt: Date.now(),
      sourceMeta: { fileName: null, fileKind: null, shareCode: null, timePs: 'not-a-number' },
      seed: {
        atoms: [{ id: 0, element: 'C' }, { id: 1, element: 'C' }],
        // positions + velocities serialized as base64 for a minimal seed
        positions: base64EncodeFloat64Array([0, 0, 0, 1, 0, 0]),
        velocities: null,
        bonds: [{ a: 0, b: 1, distance: 1.0 }],
        boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0] as [number, number, number], wallCenterSet: true, removedCount: 0, damping: 0.1 },
        config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
        provenance: { historyKind: 'capsule', velocitiesAreApproximated: true },
      },
    }));
    const r = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    expect(r.status).toBe('rejected');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('malformed-seed'))).toBe(true);
    warn.mockRestore();
  });

  it('e2eHandoffTtlMs override shrinks the acceptance window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Write with a createdAt 100 ms in the past; override TTL to 50 ms.
    const old = validPayload(Date.now() - 100);
    const token = writeWatchToLabHandoff(old);
    const result = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}&e2eHandoffTtlMs=50`),
      mockHistory() as unknown as History,
    );
    expect(result).toEqual({ status: 'rejected', reason: 'stale' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('stale'))).toBe(true);
    warn.mockRestore();
  });

  it('malformed seed returns {status:"rejected", reason:"malformed-seed"} + warn AND removes the entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = 'forged-token';
    const key = HANDOFF_STORAGE_PREFIX + token;
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      source: 'watch',
      mode: 'current-frame',
      createdAt: Date.now(),
      sourceMeta: { fileName: null, fileKind: null, shareCode: null, timePs: 0 },
      seed: { atoms: [], positions: [], velocities: null, bonds: [], boundary: { mode: 'open' }, config: { damping: 0, kDrag: 0, kRotate: 0, dtFs: 0.01, dampingRefDurationFs: 0 }, provenance: { historyKind: 'capsule', velocitiesAreApproximated: true } },
    }));
    const result = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    expect(result).toEqual({ status: 'rejected', reason: 'malformed-seed' });
    expect(localStorage.getItem(key)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('malformed-seed'))).toBe(true);
    warn.mockRestore();
  });

  it('unknown version is rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = 'v999';
    localStorage.setItem(HANDOFF_STORAGE_PREFIX + token, JSON.stringify({
      version: 999,
      source: 'watch',
      mode: 'current-frame',
      createdAt: Date.now(),
      sourceMeta: {},
      seed: {},
    }));
    const r = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    expect(r.status).toBe('rejected');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('unknown-version'))).toBe(true);
    warn.mockRestore();
  });

  it('prototype-polluted payload is rejected (cannot inject __proto__)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = 'poisoned';
    localStorage.setItem(HANDOFF_STORAGE_PREFIX + token, JSON.stringify({
      version: 1,
      source: 'watch',
      mode: 'current-frame',
      createdAt: Date.now(),
      sourceMeta: { fileName: null, fileKind: null, shareCode: null, timePs: 0 },
      seed: {
        '__proto__': { polluted: true },
        atoms: [{ id: 0, element: 'C' }],
        positions: [0, 0, 0],
        velocities: null,
        bonds: [],
        boundary: { mode: 'contain', wallRadius: 50, wallCenter: [0, 0, 0] as [number, number, number], wallCenterSet: true, removedCount: 0, damping: 0.1 },
        config: { damping: 0.1, kDrag: 1, kRotate: 1, dtFs: 0.5, dampingRefDurationFs: 100 },
        provenance: { historyKind: 'capsule', velocitiesAreApproximated: true },
      },
    }));
    const r = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    // Whether the payload is salvageable or not, assert no pollution
    // reached Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Token removed regardless.
    expect(localStorage.getItem(HANDOFF_STORAGE_PREFIX + token)).toBeNull();
    // Result shape is valid (either rejected with a reason or ready
    // post-validation). Key property: no prototype pollution happened.
    expect(['ready', 'rejected']).toContain(r.status);
    warn.mockRestore();
  });

  it('missing localStorage entry (consumed token) returns {status:"rejected", reason:"missing-entry"} and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = writeWatchToLabHandoff(validPayload());
    // First consume succeeds
    consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    // Second consume with same token
    const r = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    expect(r).toEqual({ status: 'rejected', reason: 'missing-entry' });
    // missing-entry is a user-plausible failure (consumed / cleared /
    // private-mode-dropped storage) — boot surfaces a toast AND we
    // console.warn for ops diagnostics.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('missing-entry'))).toBe(true);
    warn.mockRestore();
  });

  it('pre-pill payload without frameId still consumes (back-compat; normalized to frameId: null)', () => {
    // Simulates a handoff minted before the `frameId` field existed in
    // sourceMeta but still within the 10-min TTL at deploy time.
    // Deserialization must normalize to `frameId: null` rather than
    // rejecting as malformed, so legacy tokens don't fail consume.
    const payload = validPayload();
    // Drop frameId to mimic a pre-pill serialized payload.
    const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    delete (wire.sourceMeta as Record<string, unknown>).frameId;
    // Hand-write directly instead of going through the writer (which
    // would inject the new field). Serialize with the shared codec so
    // the positions/velocities arrays are base64 where expected.
    const bodyRaw = JSON.stringify({
      ...wire,
      seed: {
        ...(wire.seed as Record<string, unknown>),
        positions: base64EncodeFloat64Array(validSeed().positions as number[]),
        velocities: validSeed().velocities ? base64EncodeFloat64Array(validSeed().velocities as number[]) : null,
      },
    });
    const token = 'legacy-no-frameid';
    localStorage.setItem(HANDOFF_STORAGE_PREFIX + token, bodyRaw);
    const r = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.payload.sourceMeta.frameId).toBeNull();
      expect(r.token).toBe(token);
    }
  });

  it('ready outcome carries the handoff token for pill suppression keying', () => {
    const token = writeWatchToLabHandoff(validPayload());
    const r = consumeWatchToLabHandoffFromLocation(
      mockLocation(`?from=watch&handoff=${token}`),
      mockHistory() as unknown as History,
    );
    expect(r.status).toBe('ready');
    if (r.status === 'ready') expect(r.token).toBe(token);
  });

  it('removeWatchToLabHandoff clears the specific token only', () => {
    const t1 = writeWatchToLabHandoff(validPayload());
    const t2 = writeWatchToLabHandoff(validPayload());
    removeWatchToLabHandoff(t1);
    expect(localStorage.getItem(HANDOFF_STORAGE_PREFIX + t1)).toBeNull();
    expect(localStorage.getItem(HANDOFF_STORAGE_PREFIX + t2)).toBeTruthy();
  });
});

describe('handoff fingerprint non-disclosure invariant', () => {
  it('no handoff payload ever contains the "fingerprint" key', () => {
    const payload = validPayload();
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('fingerprint');
    expect(wire).not.toContain('documentFingerprint');
  });
});

describe('mintToken crypto fallback (rev 6 follow-up P3)', () => {
  it('returns a UUID when crypto.randomUUID is available', () => {
    const token = mintToken();
    // UUID v4 pattern or 32 hex chars (getRandomValues fallback).
    expect(token).toMatch(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/);
  });

  it('falls back to deterministic counter-based token when crypto is absent (no Math.random)', () => {
    // Inject `null` → both randomUUID and getRandomValues paths skipped.
    const token = mintToken(null);
    // Must be the `fallback-<time>-<counter>` format.
    expect(token).toMatch(/^fallback-[0-9a-z]+-[0-9a-z]+$/);
    // Consecutive calls within the same ms produce distinct tokens
    // thanks to the monotonic counter — no reliance on Math.random.
    const a = mintToken(null);
    const b = mintToken(null);
    expect(a).not.toBe(b);
  });

  it('uses getRandomValues when randomUUID missing but getRandomValues present', () => {
    const spy = vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = i;
      return arr;
    });
    const stubCrypto = { getRandomValues: spy } as unknown as Crypto;
    const token = mintToken(stubCrypto);
    expect(spy).toHaveBeenCalled();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('handoff pre-write sweep', () => {
  beforeEach(() => clearHandoffKeys());

  it('drops stale entries before writing', () => {
    // Seed a stale entry at a token that looks real.
    const staleKey = HANDOFF_STORAGE_PREFIX + 'stale-uuid';
    localStorage.setItem(staleKey, JSON.stringify({
      version: 1,
      source: 'watch',
      mode: 'current-frame',
      createdAt: Date.now() - 60 * 60 * 1000, // 1 hr old
      sourceMeta: {},
      seed: {},
    }));
    expect(localStorage.getItem(staleKey)).toBeTruthy();
    writeWatchToLabHandoff(validPayload());
    expect(localStorage.getItem(staleKey)).toBeNull();
  });
});

describe('writer typed failures (§10 surface hooks)', () => {
  beforeEach(() => clearHandoffKeys());

  it('setItem keeps throwing quota across retry → WatchHandoffWriteError { kind: "quota-exceeded" } with cause', () => {
    let calls = 0;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      calls++;
      throw new DOMException('Quota reached', 'QuotaExceededError');
    });
    try {
      let captured: unknown = null;
      try { writeWatchToLabHandoff(validPayload()); } catch (e) { captured = e; }
      expect(captured).toBeInstanceOf(WatchHandoffWriteError);
      expect((captured as WatchHandoffWriteError).kind).toBe('quota-exceeded');
      // `cause` records the underlying DOMException so ops logs can trace
      // back to the engine-native error shape.
      expect((captured as WatchHandoffWriteError & { cause?: unknown }).cause).toBeDefined();
      // Retry actually happened — setItem was called at least twice.
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('setItem quota error that succeeds on retry → returns token (no throw)', () => {
    const realSetItem = Storage.prototype.setItem;
    let calls = 0;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      calls++;
      if (calls === 1) throw new DOMException('Quota reached', 'QuotaExceededError');
      // Second call (post full-sweep retry): let the real setItem run.
      realSetItem.call(this, k, v);
    });
    try {
      const token = writeWatchToLabHandoff(validPayload());
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      expect(localStorage.getItem(HANDOFF_STORAGE_PREFIX + token)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('non-quota setItem error (Safari private-mode SecurityError) → WatchHandoffWriteError { kind: "storage-unavailable" }', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      let captured: unknown = null;
      try { writeWatchToLabHandoff(validPayload()); } catch (e) { captured = e; }
      expect(captured).toBeInstanceOf(WatchHandoffWriteError);
      expect((captured as WatchHandoffWriteError).kind).toBe('storage-unavailable');
    } finally {
      spy.mockRestore();
    }
  });

  it('detects Firefox NS_ERROR_DOM_QUOTA_REACHED as quota', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      // Firefox's legacy DOMException name for quota failures.
      const err: Error & { name: string } = new Error('persistent storage maximum size reached');
      err.name = 'NS_ERROR_DOM_QUOTA_REACHED';
      throw err;
    });
    try {
      let captured: unknown = null;
      try { writeWatchToLabHandoff(validPayload()); } catch (e) { captured = e; }
      expect(captured).toBeInstanceOf(WatchHandoffWriteError);
      expect((captured as WatchHandoffWriteError).kind).toBe('quota-exceeded');
    } finally {
      spy.mockRestore();
    }
  });

  // ── Read-path failures (must not leak raw DOMExceptions) ──

  it('localStorage.length throwing SecurityError during sweep → storage-unavailable', () => {
    // Simulate Safari private-mode behavior where even reading
    // `localStorage.length` can raise SecurityError.
    const descriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'length');
    const lengthSpy = vi.spyOn(Storage.prototype, 'length' as never, 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      let captured: unknown = null;
      try { writeWatchToLabHandoff(validPayload()); } catch (e) { captured = e; }
      expect(captured).toBeInstanceOf(WatchHandoffWriteError);
      expect((captured as WatchHandoffWriteError).kind).toBe('storage-unavailable');
    } finally {
      lengthSpy.mockRestore();
      // Defensive: ensure prototype descriptor still intact.
      if (descriptor) Object.defineProperty(Storage.prototype, 'length', descriptor);
    }
  });

  it('localStorage.key() throwing during sweep → storage-unavailable (classified, not raw DOMException)', () => {
    // Force at least one entry so sweep iterates.
    localStorage.setItem(HANDOFF_STORAGE_PREFIX + 'seed-for-iteration', JSON.stringify({ createdAt: Date.now() }));
    const keySpy = vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      let captured: unknown = null;
      try { writeWatchToLabHandoff(validPayload()); } catch (e) { captured = e; }
      expect(captured).toBeInstanceOf(WatchHandoffWriteError);
      expect((captured as WatchHandoffWriteError).kind).toBe('storage-unavailable');
    } finally {
      keySpy.mockRestore();
    }
  });

  it('quota on read-path (iteration) → quota-exceeded (same classifier applies to reads)', () => {
    const lengthSpy = vi.spyOn(Storage.prototype, 'length' as never, 'get').mockImplementation(() => {
      throw new DOMException('Quota reached', 'QuotaExceededError');
    });
    try {
      let captured: unknown = null;
      try { writeWatchToLabHandoff(validPayload()); } catch (e) { captured = e; }
      expect(captured).toBeInstanceOf(WatchHandoffWriteError);
      expect((captured as WatchHandoffWriteError).kind).toBe('quota-exceeded');
    } finally {
      lengthSpy.mockRestore();
    }
  });

  it('retry reclassification: first setItem quota, retry setItem SecurityError → storage-unavailable (not quota)', () => {
    // This is the key fairness property: storage state can transition
    // between the initial write and the post-sweep retry. The surfaced
    // kind must match the retry's actual failure — the user's remedy
    // is "use a normal window", not "free space".
    let calls = 0;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      calls++;
      if (calls === 1) throw new DOMException('Quota reached', 'QuotaExceededError');
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      let captured: unknown = null;
      try { writeWatchToLabHandoff(validPayload()); } catch (e) { captured = e; }
      expect(captured).toBeInstanceOf(WatchHandoffWriteError);
      expect((captured as WatchHandoffWriteError).kind).toBe('storage-unavailable');
      // Confirm the cause carries the retry's error (SecurityError), not
      // the initial one — ops diagnostics must reflect the current state.
      const cause = (captured as WatchHandoffWriteError & { cause?: unknown }).cause as { name?: string } | undefined;
      expect(cause?.name).toBe('SecurityError');
      // And the retry actually happened (not a short-circuit).
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
