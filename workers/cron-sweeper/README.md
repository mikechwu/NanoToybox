# atomdojo-cron-sweeper

Companion Cloudflare Worker for the AtomDojo Pages project. Invokes the
admin sweep endpoints (`/api/admin/sweep/sessions` and `/api/admin/sweep/orphans`)
on a schedule. Pages Functions do not support scheduled handlers, so
this Worker deploys separately.

## Schedule

| Cron | Endpoint | Purpose |
|------|----------|---------|
| `0 */6 * * *` | `POST /api/admin/sweep/sessions` | Clean expired + idle sessions, prune stale quota buckets |
| `30 3 * * *` | `POST /api/admin/sweep/orphans` | Delete R2 blobs older than 24h with no matching D1 row |

The sessions sweep is a safety net, not the primary orphan-session
collector. `functions/auth-middleware.ts` deletes orphan sessions
in-band: any request whose cookie references a deleted-user row
triggers a fire-and-forget `DELETE FROM sessions WHERE id = ?` (with
per-isolate dedupe). The cron still catches expired/idle sessions and
orphan sessions that never receive another auth-checked request, so
orphan counts in the sweep summary should be small in practice.

## One-time setup

```bash
cd workers/cron-sweeper

# 1. Provision the shared secret — MUST match the value in the Pages project.
#    Rotate by repeating both steps below with the same new value.
wrangler secret put CRON_SECRET

# (Separately, in the Pages project root:)
wrangler pages secret put CRON_SECRET --project-name=atomdojo

# 2. If the Pages deployment is not at the default URL, override PAGES_BASE_URL:
#    edit wrangler.toml [vars].PAGES_BASE_URL, or set at deploy time.

# 3. Deploy
wrangler deploy
```

## Manual invocation (operator smoke test)

The Worker also exposes a `fetch` handler so an operator can trigger
either sweep on demand against the deployed Worker:

```bash
curl -X GET "https://atomdojo-cron-sweeper.<account>.workers.dev/?target=sessions" \
  -H "X-Cron-Secret: $CRON_SECRET"
curl -X GET "https://atomdojo-cron-sweeper.<account>.workers.dev/?target=orphans" \
  -H "X-Cron-Secret: $CRON_SECRET"
```

The `?target` must be `sessions` or `orphans`. Without a valid
`X-Cron-Secret` header, every request returns 404 (no route existence
leak to unauthorized callers).

## Why a shared secret and not OAuth?

The admin sweep endpoints are infrastructure, not per-user actions.
OAuth would couple scheduled automation to a specific operator session.
A rotated shared secret is the right primitive: the secret lives only
in Worker/Pages config, never in source, and can be rotated without
user impact.

## Verifying

Check the Worker Cron event log in the Cloudflare dashboard. A healthy
run logs a JSON summary of the sweep result. A failed run throws, which
Cloudflare records as a cron error and surfaces in alerts.
