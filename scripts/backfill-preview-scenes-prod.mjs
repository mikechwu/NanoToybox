#!/usr/bin/env node
/**
 * scripts/backfill-preview-scenes-prod.mjs — production preview scene
 * backfill (ADR D138, Lane A).
 *
 * Thin HTTP client around `POST /api/admin/backfill-preview-scenes`,
 * the admin-gated Pages Function that runs `backfillPreviewScenes`
 * inside the Cloudflare runtime with real D1 + R2 bindings. This
 * wrapper is the documented operator entrypoint; the `.ts` library
 * itself stays pure (no `main`, no arg parsing).
 *
 * Usage:
 *   node scripts/backfill-preview-scenes-prod.mjs \
 *     --base-url https://atomdojo.pages.dev \
 *     --admin-secret CRON_SECRET \
 *     [--force] [--page-size N] [--verbose] [--dry-run]
 *
 * Header contract:
 *   X-Cron-Secret: <process.env[$ADMIN_SECRET_ENV]>
 *   Content-Type:  application/json
 *
 * Exit codes:
 *   0 — HTTP 200 and summary.failed.length === 0
 *   non-zero — any HTTP >= 400, or summary.failed.length > 0, or a
 *              pre-flight error (missing secret env var).
 */

class ArgParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgParseError';
  }
}

function requireValue(argv, i, flag) {
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new ArgParseError(
      `[backfill-prod] missing value for ${flag} — a truncated argv would otherwise silently fall back to defaults.`,
    );
  }
  return next;
}

function parseArgs(argv) {
  const out = {
    baseUrl: null,
    adminSecretEnv: 'CRON_SECRET',
    force: false,
    pageSize: null,
    verbose: false,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--base-url':
        out.baseUrl = requireValue(argv, i, '--base-url');
        i++;
        break;
      case '--admin-secret':
        out.adminSecretEnv = requireValue(argv, i, '--admin-secret');
        i++;
        break;
      case '--force':
        out.force = true;
        break;
      case '--page-size': {
        const raw = requireValue(argv, i, '--page-size');
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new ArgParseError(`[backfill-prod] invalid --page-size: ${raw}`);
        }
        out.pageSize = n;
        i++;
        break;
      }
      case '--verbose':
        out.verbose = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      default:
        throw new ArgParseError(`[backfill-prod] unknown argument: ${arg}`);
    }
  }
  return out;
}

async function main(argv, env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgParseError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  if (!args.baseUrl) {
    console.error('[backfill-prod] --base-url is required (e.g. https://atomdojo.pages.dev)');
    return 2;
  }
  const secret = env[args.adminSecretEnv];
  if (!secret) {
    console.error(
      `[backfill-prod] admin secret env var "${args.adminSecretEnv}" is not set`
        + ' — export it before invoking. No fetch issued.',
    );
    return 2;
  }

  const url = `${args.baseUrl.replace(/\/$/, '')}/api/admin/backfill-preview-scenes`;
  const body = {
    force: args.force,
    dryRun: args.dryRun,
    verbose: args.verbose,
  };
  if (args.pageSize != null) body.pageSize = args.pageSize;

  console.log(
    `[backfill-prod] start url=${url} force=${args.force} dryRun=${args.dryRun}`
      + ` pageSize=${args.pageSize ?? 'default'} verbose=${args.verbose}`,
  );

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Cron-Secret': secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[backfill-prod] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const text = await response.text();
  if (response.status >= 400) {
    console.error(
      `[backfill-prod] endpoint returned ${response.status}:`,
      text,
    );
    return 1;
  }

  let summary;
  try {
    summary = JSON.parse(text);
  } catch {
    console.error('[backfill-prod] response was not valid JSON:', text);
    return 1;
  }

  console.log('[backfill-prod] done', JSON.stringify(summary));
  const failedCount = Array.isArray(summary?.failed) ? summary.failed.length : 0;
  if (failedCount > 0) {
    console.error(`[backfill-prod] ${failedCount} row(s) failed — see summary.failed for details`);
    return 1;
  }
  return 0;
}

// Library export for tests (dynamic-import-friendly). The test file
// invokes `main(...)` with an explicit argv + env.
export { main, parseArgs };

// Execute when run as a script. `import.meta.url` ends with the file
// path; the second-to-last process.argv entry under Node is the
// actually-invoked script.
const isMain = process.argv[1]
  && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv).then((code) => process.exit(code));
}
