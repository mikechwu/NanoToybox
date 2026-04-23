/**
 * atomdojo-cron-sweeper — companion Worker for the Pages project.
 *
 * Invokes the admin sweep endpoints on a schedule. Pages Functions cannot
 * register `scheduled` handlers, so this thin Worker sits alongside the
 * Pages deployment and POSTs to the admin routes with a shared secret.
 *
 * The admin-gate in the Pages Functions codebase accepts either:
 *   - local operator (DEV_ADMIN_ENABLED + localhost) — not applicable here
 *   - production cron: X-Cron-Secret header matching env.CRON_SECRET
 *
 * This Worker uses the latter path. CRON_SECRET must be provisioned via
 * `wrangler secret put CRON_SECRET` in BOTH this Worker and the Pages
 * project, with identical values.
 *
 * Schedule routing (cron pattern → target endpoint):
 *   "0 *\/6 * * *"  → /api/admin/sweep/sessions
 *   "10 *\/6 * * *" → /api/admin/sweep/guest-expires (offset from sessions)
 *   "30 3 * * *"    → /api/admin/sweep/orphans
 *   "15 4 * * 0"    → /api/admin/sweep/audit?mode=scrub (weekly, Sunday)
 *   "45 4 * * 0"    → /api/admin/sweep/audit?mode=delete-abuse-reports
 *
 * Each tick:
 *   1. POST to the target with X-Cron-Secret
 *   2. Log status + JSON body summary
 *   3. On non-2xx, throw so the Worker's built-in retry logic kicks in
 */

export interface Env {
  PAGES_BASE_URL: string;
  CRON_SECRET: string;
}

/** Mapping from cron pattern → admin sweep path. Keeps the dispatch
 *  table in the code, not spread across config. */
const CRON_ROUTES: Record<string, string> = {
  '0 */6 * * *': '/api/admin/sweep/sessions',
  // Guest Quick Share expiry sweep. 10-minute offset from the sessions
  // sweep so the two 6-hourly ticks never fire simultaneously against
  // the same D1 database, keeping per-isolate D1 bursts predictable.
  '10 */6 * * *': '/api/admin/sweep/guest-expires',
  '30 3 * * *': '/api/admin/sweep/orphans',
  // Weekly audit retention — scrub sensitive fields, then delete the
  // narrow abuse_report class that offers no forensics value past 180d.
  // Two separate ticks so a failure in one mode does not block the
  // other and Cloudflare's per-tick retry stays meaningful.
  '15 4 * * 0': '/api/admin/sweep/audit?mode=scrub',
  '45 4 * * 0': '/api/admin/sweep/audit?mode=delete-abuse-reports',
};

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runScheduled(event.cron, env));
  },

  // Optional fetch handler for manual operator invocation against the
  // deployed Worker (e.g. curl with the right secret). Keeps a single
  // codepath between scheduled and manual invocation.
  //
  // Security-first ordering: authenticate BEFORE parsing any operator
  // input. Without this ordering the Worker would leak route existence
  // via 400 "Usage: …" responses to unauthenticated callers, which
  // contradicts the admin-gate contract used throughout the project.
  // Unauthorized → 404 indistinguishable from "no route here".
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // (1) Auth — constant-time compare. A missing/mismatched secret
    //     yields the same 404 the Pages admin gate returns.
    const presented = request.headers.get('X-Cron-Secret') ?? '';
    if (
      !env.CRON_SECRET ||
      env.CRON_SECRET.length === 0 ||
      !constantTimeEqual(presented, env.CRON_SECRET)
    ) {
      return new Response('Not found', { status: 404 });
    }

    // (2) Operator input parse — only reachable after auth succeeds.
    const url = new URL(request.url);
    const target = url.searchParams.get('target');
    if (
      !target
      || !['sessions', 'orphans', 'audit-scrub', 'audit-delete', 'guest-expires'].includes(target)
    ) {
      return new Response(
        'Usage: GET /?target=sessions|orphans|audit-scrub|audit-delete|guest-expires',
        { status: 400 },
      );
    }

    const pathByTarget: Record<string, string> = {
      sessions: '/api/admin/sweep/sessions',
      orphans: '/api/admin/sweep/orphans',
      'audit-scrub': '/api/admin/sweep/audit?mode=scrub',
      'audit-delete': '/api/admin/sweep/audit?mode=delete-abuse-reports',
      'guest-expires': '/api/admin/sweep/guest-expires',
    };
    const result = await invokeSweep(pathByTarget[target], env);
    return Response.json(result, { status: result.ok ? 200 : 502 });
  },
};

/** Length-aware constant-time string comparison. Matches the helper
 *  in functions/admin-gate.ts to keep the auth contract consistent
 *  across the Pages admin routes and this companion Worker. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function runScheduled(cronPattern: string, env: Env): Promise<void> {
  const path = CRON_ROUTES[cronPattern];
  if (!path) {
    console.error(`[cron-sweeper] unknown cron pattern: ${cronPattern}`);
    return;
  }
  const result = await invokeSweep(path, env);
  if (!result.ok) {
    // Throw so Cloudflare's scheduled-retry semantics can re-fire.
    throw new Error(
      `[cron-sweeper] sweep failed: ${path} → ${result.status} ${result.bodyPreview}`,
    );
  }
}

interface SweepResult {
  ok: boolean;
  status: number;
  bodyPreview: string;
}

/**
 * POST to the given admin sweep path with the shared cron secret.
 * Exported for testability.
 */
export async function invokeSweep(
  path: string,
  env: Env,
  fetchFn: typeof fetch = fetch,
): Promise<SweepResult> {
  if (!env.CRON_SECRET || env.CRON_SECRET.length === 0) {
    return { ok: false, status: 0, bodyPreview: 'CRON_SECRET not configured' };
  }
  const url = `${env.PAGES_BASE_URL.replace(/\/+$/, '')}${path}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'X-Cron-Secret': env.CRON_SECRET },
  });
  const text = await res.text().catch(() => '');
  return {
    ok: res.ok,
    status: res.status,
    bodyPreview: text.slice(0, 200),
  };
}
