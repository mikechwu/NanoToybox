/**
 * POST /api/admin/backfill-preview-scenes — preview scene-store rebake
 * entrypoint (ADR D138, Lane A).
 *
 * Authoritative server-side path for running the `backfillPreviewScenes`
 * library against real D1 + R2 bindings. Mirrors the structure of the
 * existing `functions/api/admin/sweep/*.ts` endpoints: admin-gated via
 * `requireAdminOr404`, returns a `BackfillSummary` JSON, records a
 * single `preview_backfill_run` audit event per invocation.
 *
 * Called by `scripts/backfill-preview-scenes-prod.mjs` (npm run
 * `capsule-preview:backfill:prod`). See docs/operations.md for the
 * operational runbook.
 */

import type { Env } from '../../env';
import { requireAdminOr404 } from '../../admin-gate';
import { recordAuditEvent, type AuditSeverity } from '../../../src/share/audit';
import { backfillPreviewScenes } from '../../../scripts/backfill-preview-scenes';
import { CURRENT_THUMB_REV } from '../../../src/share/capsule-preview-scene-store';

interface BackfillBody {
  force?: boolean;
  pageSize?: number;
  verbose?: boolean;
  dryRun?: boolean;
}

async function parseBody(request: Request): Promise<BackfillBody> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return {};
  try {
    const raw = await request.text();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: BackfillBody = {};
    if (typeof parsed.force === 'boolean') out.force = parsed.force;
    if (typeof parsed.pageSize === 'number' && Number.isFinite(parsed.pageSize)) {
      out.pageSize = parsed.pageSize;
    }
    if (typeof parsed.verbose === 'boolean') out.verbose = parsed.verbose;
    if (typeof parsed.dryRun === 'boolean') out.dryRun = parsed.dryRun;
    return out;
  } catch {
    return {};
  }
}

function severityFor(
  failedCount: number,
  updated: number,
): AuditSeverity {
  if (failedCount === 0) return 'info';
  if (updated > 0) return 'warning';
  return 'critical';
}

function resolveActor(request: Request, env: Env): 'admin' | 'sweeper' {
  if (env.DEV_ADMIN_ENABLED === 'true') {
    const host = new URL(request.url).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'admin';
  }
  return 'sweeper';
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const denied = requireAdminOr404(request, env);
  if (denied) return denied;

  const body = await parseBody(request);
  const force = body.force === true;
  const pageSize = typeof body.pageSize === 'number' ? body.pageSize : 100;
  const verbose = body.verbose === true;
  const dryRun = body.dryRun === true;

  console.info(
    `[backfill] start rev=${CURRENT_THUMB_REV} force=${force} pageSize=${pageSize}`
      + ` dryRun=${dryRun} verbose=${verbose}`,
  );

  // In dry-run we still pass into the library, but we swap the D1 writer
  // for a no-op wrapper so no rows mutate. The library's SELECT loop
  // stays intact — operators use dry-run to see the scan count before
  // committing to a rebake.
  const db = dryRun ? wrapForDryRun(env.DB) : env.DB;
  const r2 = env.R2_BUCKET;

  const summary = await backfillPreviewScenes({
    db: db as unknown as Parameters<typeof backfillPreviewScenes>[0]['db'],
    r2: r2 as unknown as Parameters<typeof backfillPreviewScenes>[0]['r2'],
    pageSize,
    verbose,
    force,
    currentThumbRev: CURRENT_THUMB_REV,
  });

  const failedCount = summary.failed.length;
  const severity = severityFor(failedCount, summary.updated);

  console.info(
    `[backfill] done scanned=${summary.scanned} updated=${summary.updated}`
      + ` skipped=${summary.skipped} failed=${failedCount} severity=${severity}`,
  );

  await recordAuditEvent(env.DB, {
    eventType: 'preview_backfill_run',
    actor: resolveActor(request, env),
    severity,
    details: {
      dryRun,
      force,
      pageSize,
      currentThumbRev: CURRENT_THUMB_REV,
      scanned: summary.scanned,
      updated: summary.updated,
      skipped: summary.skipped,
      failedCount,
    },
  });

  const status = severity === 'critical' ? 500 : 200;
  return new Response(JSON.stringify(summary), {
    status,
    headers: { 'content-type': 'application/json' },
  });
};

/**
 * Wrap the D1 binding so every `prepare(...).bind(...).run(...)` on an
 * UPDATE statement becomes a no-op. Reads still execute against the
 * real D1 — dry-run is a "scan count only" path.
 */
function wrapForDryRun(db: Env['DB']): Env['DB'] {
  const realPrepare = db.prepare.bind(db);
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = realPrepare(sql);
          const trimmed = sql.trimStart().toUpperCase();
          const isMutation = trimmed.startsWith('UPDATE ')
            || trimmed.startsWith('INSERT ')
            || trimmed.startsWith('DELETE ');
          if (!isMutation) return stmt;
          return new Proxy(stmt, {
            get(innerTarget, innerProp, innerReceiver) {
              if (innerProp === 'bind') {
                return (..._binds: unknown[]) => ({
                  run: async () => ({ success: true } as unknown),
                  first: async () => null,
                  all: async () => ({ success: true, results: [] }),
                });
              }
              return Reflect.get(innerTarget, innerProp, innerReceiver);
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Env['DB'];
}
