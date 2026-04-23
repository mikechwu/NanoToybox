/**
 * Publish-error taxonomy.
 *
 * Co-locating these classes in `publish-size.ts` would conflate
 * size-formatting helpers with general publish-state errors.
 * `publish-size.ts` keeps its narrower responsibility (parsing 413
 * bodies, formatting size messages) and MAY import these classes to
 * throw them, but no longer defines them.
 *
 * Every catch site MUST use the `is*Error` type guards rather than
 * structural sniffing or bare `instanceof` — the guards are the public
 * narrowing API.
 */

export class PublishOversizeError extends Error {
  readonly kind = 'publish-oversize' as const;
  readonly actualBytes: number | null;
  readonly maxBytes: number | null;
  readonly source: 'preflight' | '413';
  constructor(opts: {
    actualBytes: number | null;
    maxBytes: number | null;
    source: 'preflight' | '413';
    message: string;
  }) {
    super(opts.message);
    this.name = 'PublishOversizeError';
    this.actualBytes = opts.actualBytes;
    this.maxBytes = opts.maxBytes;
    this.source = opts.source;
  }
}

export function isPublishOversizeError(
  err: unknown,
): err is PublishOversizeError {
  return err instanceof PublishOversizeError;
}

export class CapsuleSnapshotStaleError extends Error {
  readonly kind = 'snapshot-stale' as const;
  constructor(message = 'Capsule export inputs changed since selection.') {
    super(message);
    this.name = 'CapsuleSnapshotStaleError';
  }
}

export function isCapsuleSnapshotStaleError(
  err: unknown,
): err is CapsuleSnapshotStaleError {
  return err instanceof CapsuleSnapshotStaleError;
}
