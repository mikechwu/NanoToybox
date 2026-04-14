# atomdojo-cron-sweeper

Companion Cloudflare Worker for the AtomDojo Pages project. Invokes the
admin sweep endpoints (`/api/admin/sweep/sessions`, `/api/admin/sweep/orphans`,
and `/api/admin/sweep/audit`) on a schedule. Pages Functions do not
support scheduled handlers, so this Worker deploys separately.

## Schedule

| Cron | Endpoint | Purpose |
|------|----------|---------|
| `0 */6 * * *` | `POST /api/admin/sweep/sessions` | Clean expired + idle sessions, prune stale quota buckets |
| `30 3 * * *` | `POST /api/admin/sweep/orphans` | Delete R2 blobs older than 24h with no matching D1 row |
| `15 4 * * 0` | `POST /api/admin/sweep/audit?mode=scrub` | Weekly Sun 04:15 UTC — null `ip_hash`/`user_agent`/`reason` on audit rows older than 180 days |
| `45 4 * * 0` | `POST /api/admin/sweep/audit?mode=delete-abuse-reports` | Weekly Sun 04:45 UTC — row-delete `abuse_report` audit rows older than 180 days |

This is 4 of the 5 cron triggers allowed on the Cloudflare Workers
free tier. Adding a fifth is fine; a sixth requires the paid plan
(which raises the ceiling to 250 crons/account).

The sessions sweep is a safety net, not the primary orphan-session
collector. `functions/auth-middleware.ts` deletes orphan sessions
in-band: any request whose cookie references a deleted-user row
triggers a fire-and-forget `DELETE FROM sessions WHERE id = ?` (with
per-isolate dedupe). The cron still catches expired/idle sessions and
orphan sessions that never receive another auth-checked request, so
orphan counts in the sweep summary should be small in practice.

The two audit sweeps are split into separate ticks (30 min apart) so a
failure in one mode does not block the other and Cloudflare's per-tick
retry semantics stay meaningful for each destructive operation
independently.

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
any sweep on demand against the deployed Worker:

```bash
curl -X GET "https://atomdojo-cron-sweeper.<account>.workers.dev/?target=sessions" \
  -H "X-Cron-Secret: $CRON_SECRET"
curl -X GET "https://atomdojo-cron-sweeper.<account>.workers.dev/?target=orphans" \
  -H "X-Cron-Secret: $CRON_SECRET"
curl -X GET "https://atomdojo-cron-sweeper.<account>.workers.dev/?target=audit-scrub" \
  -H "X-Cron-Secret: $CRON_SECRET"
curl -X GET "https://atomdojo-cron-sweeper.<account>.workers.dev/?target=audit-delete" \
  -H "X-Cron-Secret: $CRON_SECRET"
```

The `?target` must be one of `sessions | orphans | audit-scrub | audit-delete`.
Without a valid `X-Cron-Secret` header, every request returns 404 (no
route existence leak to unauthorized callers).

### When to invoke audit-scrub vs audit-delete

Both modes operate on the same 180-day retention threshold against the
audit log but differ in what they do:

- **`audit-scrub`** — nulls out `ip_hash`, `user_agent`, and `reason`
  columns on rows older than 180 days, preserving the row itself
  (event class, timestamp, actor). Invoke manually for monthly
  housekeeping if a scheduled tick was missed, or immediately after
  a privacy-request retention sweep when you want to accelerate
  redaction rather than wait for the next Sunday tick.

- **`audit-delete`** — row-deletes `abuse_report`-class audit entries
  older than 180 days. Same threshold as scrub, but the `abuse_report`
  event class is dominated by the IP-hash de-dup signal and offers
  limited forensic value past 180 days, so there is no reason to retain
  a scrubbed husk of the row. Invoke manually on the same triggers as
  scrub (missed tick, accelerated retention sweep).

### `warnings: ['audit_failed']` in the 200 body

The audit sweep endpoint emits its own `audit_swept` event to the audit
log after each successful destructive operation. If the destructive
operation succeeded but that follow-up event write failed, the endpoint
still returns 200 and includes `warnings: ['audit_failed']` in the JSON
body. The rows are gone (or scrubbed); only the bookkeeping entry is
missing. Operators should grep for this in `wrangler tail`:

```bash
wrangler tail --format=pretty | grep audit_failed
```

A recurring `audit_failed` warning means the audit write path itself is
degraded and needs investigation (D1 write error, schema drift, etc.),
not that the sweep retried-and-failed.

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
