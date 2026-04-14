# Operations — AtomDojo share-link deployment

Operational runbook for the production AtomDojo deployment (Lab + Watch + Viewer
backed by Cloudflare Pages Functions, D1, and R2). The other `docs/` files cover
architecture and code; this one is for operators keeping the deployed system
healthy.

Audience: on-call operator with `wrangler` configured and access to the
Cloudflare dashboard for the `atomdojo` project.

---

## Deployment topology

- **Cloudflare Pages** project `atomdojo` — serves Lab (`/lab/`), Watch
  (`/watch/`), Viewer (`/viewer/`) static assets plus all Pages Functions
  under `functions/` (auth, capsule publish/resolve, admin).
- **D1 database** binding `DB` → `atomdojo-capsules`. Migrations live in
  `migrations/`, applied via `wrangler d1 migrations apply`.
- **R2 bucket** binding `R2_BUCKET` → `atomdojo-capsules-prod`. **Private —
  never expose this bucket publicly.** Objects are served only via
  authenticated Pages Functions; direct R2 access would bypass the
  `capsule_share.status` gate (moderation deletes would be ineffective).
- **Companion Worker** `atomdojo-cron-sweeper` (source at
  `workers/cron-sweeper/`) — calls the Pages admin sweep endpoints on a
  schedule. Deployed separately because Pages Functions have no scheduled
  handler.
- **OAuth apps** — Google + GitHub. Callback URIs must be registered in the
  provider dashboards as:
  - `https://atomdojo.pages.dev/auth/google/callback`
  - `https://atomdojo.pages.dev/auth/github/callback`

---

## Required secrets

All secrets live in Cloudflare (never in git). `.dev.vars` is for local
development only and must never contain production values.

| Secret | Where | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Pages | Google OAuth |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Pages | GitHub OAuth |
| `SESSION_SECRET` | Pages | Single key for OAuth signed-state HMAC, session cookie signing, and abuse-report IP hashing. One rotate point, three dependents — read the rotation section before touching it. |
| `CRON_SECRET` | Pages **AND** cron Worker (IDENTICAL byte-for-byte) | Authorizes the production automation path to `/api/admin/*` endpoints (see `functions/admin-gate.ts`). |
| `AUTH_DEV_USER_ID` / `DEV_ADMIN_ENABLED` | **NEVER in production** | Local dev bypass only. Setting either in the production Pages project breaks the admin gate (`DEV_ADMIN_ENABLED=true` would expose admin routes to any request with a spoofed `Host: localhost` header that survives Cloudflare normalization, and `AUTH_DEV_USER_ID` would attach a fixed identity to every unauthenticated request). |

Provision with `wrangler`:

```bash
# Pages project secrets
wrangler pages secret put GOOGLE_CLIENT_ID     --project-name=atomdojo
wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=atomdojo
wrangler pages secret put GITHUB_CLIENT_ID     --project-name=atomdojo
wrangler pages secret put GITHUB_CLIENT_SECRET --project-name=atomdojo
wrangler pages secret put SESSION_SECRET       --project-name=atomdojo
wrangler pages secret put CRON_SECRET          --project-name=atomdojo

# Cron Worker secrets (CRON_SECRET must match Pages value)
cd workers/cron-sweeper
wrangler secret put CRON_SECRET
```

Verify with `wrangler pages secret list --project-name=atomdojo` and
`wrangler secret list` (inside `workers/cron-sweeper/`).

---

## Schedules

Configured in `workers/cron-sweeper/wrangler.toml`. The Worker POSTs to the
Pages admin endpoints with `X-Cron-Secret: $CRON_SECRET`.

| Cron pattern | Endpoint | Purpose |
|---|---|---|
| `0 */6 * * *` | `POST /api/admin/sweep/sessions` | Delete expired + idle sessions, prune stale quota buckets, clean up abandoned OAuth state records. Cheap, frequent. |
| `30 3 * * *` | `POST /api/admin/sweep/orphans` | Delete R2 objects under `capsules/` older than 24h with no matching D1 row (the narrow window where R2 put succeeded but D1 persist + rollback both failed). |

Stream live Worker logs during investigation:

```bash
cd workers/cron-sweeper
wrangler tail
# or, from repo root: npm run cron:tail
```

---

## WAF rate-limit rules (per-IP)

Configure in **Cloudflare dashboard → Security → WAF → Rate limiting rules**.
The in-code quota in `src/share/rate-limit.ts` is per-**user** (10
publishes/24h); the per-**IP** limit is a separate WAF layer and both must be
in place.

- **Publish per IP**
  - When: hostname `eq` `atomdojo.pages.dev` AND path `eq` `/api/capsules/publish`
  - Rate: 30 requests per 1 minute per IP
  - Action: Block for 10 minutes
- **Resolve per IP**
  - When: hostname `eq` `atomdojo.pages.dev` AND path `contains` `/api/capsules/`
  - Rate: 300 requests per 1 minute per IP
  - Action: Managed Challenge

If you ever point the deployment at a custom hostname, update these rules.

---

## Alerting (MUST configure)

Wire each signal to the team's paging / alerting system. Signals are either
audit-event rows in D1 (`capsule_share_audit.event_type`) or grep-able
`[id=...]` log tags emitted by `wrangler tail`.

| Signal | Kind | Severity | Action |
|---|---|---|---|
| `publish_quota_accounting_failed` | audit event | CRITICAL | Counter drifted after a real publish succeeded. If sustained, quota is no longer enforceable for that user. Freeze the account or require re-auth until reconciled. See *Reconciliation* below. |
| `PUBLISH_RECONCILE_LOST` | log tag | CRITICAL | Both the consume AND the reconciliation audit write failed. The publish is live with no record in either counter or audit. Page immediately; reconcile from R2 + D1 state. |
| `orphan_sweep_failed` | audit event | WARNING | R2 API contract drift (missing `uploaded`) or partial sweep failure. Storage may be growing without cleanup. Investigate within one business day. |
| `REPORT_DEDUP_DISABLED` | log tag | WARNING | `SESSION_SECRET` not configured on the Pages project — abuse-report de-dup is off, spam risk elevated. Provision the secret. |
| `R2_UPLOADED_MISSING` | log tag | INFO / aggregate | Per-object signal emitted during orphan sweep when `R2ObjectList` returns an entry without `uploaded`. One is noise; a sustained rate promotes to `orphan_sweep_failed`. |

All five signals are referenced in code:

- `src/share/rate-limit.ts` — quota accounting and audit calls
- `src/share/audit.ts` — event type enum
- `functions/api/capsules/publish.ts` — publish pipeline
- `functions/api/capsules/[code]/report.ts` — abuse reports
- `functions/api/admin/sweep/orphans.ts` — orphan sweep

---

## Reconciliation procedures

### `publish_quota_accounting_failed`

The publish succeeded (D1 `capsule_share` row + R2 blob both exist, and the
`publish_success` audit row was written), but the quota counter increment
failed. Under normal conditions this is one "free" publish per event. During
a sustained D1 outage it is unbounded and a determined user could publish
until the outage clears.

Reconcile (do this per affected `actor`, i.e. user_id):

```sql
-- 1. Count successful publishes in the rolling quota window.
SELECT COUNT(*) AS actual
FROM capsule_share_audit
WHERE actor = ?            -- user_id
  AND event_type = 'publish_success'
  AND occurred_at_ms >= ?; -- window start (now - 24h in ms)

-- 2. Count what the quota counter thinks happened in the same window.
SELECT COALESCE(SUM(count), 0) AS recorded
FROM publish_quota_window
WHERE user_id = ?
  AND window_start_ms >= ?;
```

Backfill the difference (`actual - recorded`) by incrementing the current
quota bucket for that user. If the user has been pathologically exceeding
quota (>2× the configured limit), freeze the account in D1 until root cause
is identified:

```sql
UPDATE users SET status = 'frozen' WHERE id = ?;
```

### `PUBLISH_RECONCILE_LOST`

Same as above but the audit row also failed, so there's no record that the
publish happened. Walk R2 `capsules/` looking for blobs with no matching
`capsule_share` row younger than the orphan sweep floor (24h), and
cross-reference against the `capsule_share` rows created in the same window
to identify the "successful publish with no audit" cases. Synthesize the
missing audit rows before running the backfill above.

### Orphaned R2 blobs

The scheduled orphan sweeper runs daily at 03:30 UTC. To invoke manually,
always dry-run first:

```bash
# Dry run — lists candidates but deletes nothing.
curl -X POST "https://atomdojo.pages.dev/api/admin/sweep/orphans?dry=1" \
  -H "X-Cron-Secret: $CRON_SECRET"

# Response includes: scanned, candidates, deleted, deletedKeys[].
```

When the candidate list looks right, re-run without `?dry=1`:

```bash
curl -X POST "https://atomdojo.pages.dev/api/admin/sweep/orphans" \
  -H "X-Cron-Secret: $CRON_SECRET"
```

Optional `?max=N` query param caps deletions per invocation (default 100,
hard cap 1000). Only objects under the `capsules/` prefix older than 24h
are ever touched.

### Moderation delete (admin)

```bash
curl -X POST "https://atomdojo.pages.dev/api/admin/capsules/<code>/delete" \
  -H "X-Cron-Secret: $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"reason":"abuse — CSAM report"}'
```

Response shape:

```json
{
  "shareCode": "abc123",
  "status": "deleted",
  "alreadyDeleted": false,
  "r2Deleted": true,
  "r2Error": null
}
```

The endpoint is idempotent: retrying a call where `r2Deleted: false` is safe
and will re-attempt the R2 delete. Even if you never retry, the orphan
sweeper will pick up the blob after 24h — the `capsule_share.status` flip
happens first, so the capsule is immediately unreachable via the public
endpoints regardless of R2 cleanup state.

---

## Secret rotation

### SESSION_SECRET

Rotating `SESSION_SECRET` cascades across three subsystems:

- **OAuth in-flight state** — all currently-issued signed-state tokens are
  invalidated (10-minute window). Users mid-login will see an error and
  must restart the flow.
- **Abuse-report IP de-dup** — `capsule_share_audit.ip_hash` values from
  before rotation no longer match new hashes for the same IP. The 24h
  de-dup window effectively resets; expect a brief spike of duplicate-looking
  abuse reports for ~24h.
- **Session cookies** — every user's cookie signature becomes invalid and
  they must re-login on their next authenticated request.

Sequence:

```bash
# 1. Generate a new high-entropy value (32+ bytes base64 is fine).
wrangler pages secret put SESSION_SECRET --project-name=atomdojo

# 2. Deploy is immediate — no app redeploy needed, the next request reads
#    the new secret.
```

Then monitor `publish_rejected_quota` and `abuse_report` rates for 24h. An
abnormal spike during that window is expected (de-dup reset); persistent
elevation after 48h indicates real abuse or a misconfiguration.

### CRON_SECRET

Rotation must be atomic across Pages AND the cron Worker. If they drift,
scheduled sweeps start getting 404s (the admin gate returns 404 on mismatch
— see `functions/admin-gate.ts`).

```bash
# 1. Pick a new value; keep it in a paste buffer for the next two commands.
NEW_VALUE="$(openssl rand -base64 32)"

# 2. Pages side.
wrangler pages secret put CRON_SECRET --project-name=atomdojo
# (paste $NEW_VALUE when prompted)

# 3. Worker side — must match exactly.
cd workers/cron-sweeper
wrangler secret put CRON_SECRET
# (paste the same $NEW_VALUE)

# 4. Verify with a manual sweep invocation.
curl -X POST "https://atomdojo.pages.dev/api/admin/sweep/sessions" \
  -H "X-Cron-Secret: $NEW_VALUE"
# A 2xx response confirms the new secret is live on both sides.
```

### OAuth secrets

Rotate in the provider dashboard (Google Cloud Console / GitHub Developer
Settings), then update the corresponding Pages secret:

```bash
wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=atomdojo
# or
wrangler pages secret put GITHUB_CLIENT_SECRET --project-name=atomdojo
```

Users already signed in via cookie are unaffected — the OAuth secret is only
used during the token exchange on the callback endpoint. Only in-flight
auth flows will break; users just retry the login.

---

## Migrations

Current migrations (in `migrations/`, applied in order by wrangler):

- `0001_capsule_share.sql` — `capsule_share`, `users`, `oauth_accounts`,
  `sessions` tables + indices.
- `0002_audit_quota_counters.sql` — `capsule_share_audit`,
  `publish_quota_window`, `usage_counter`.
- `0003_capsule_object_key_index.sql` — `idx_capsule_object_key` (required
  for orphan sweep performance — without it, the D1 join per R2 object is
  O(N²) over the full share table).

Apply to remote:

```bash
wrangler d1 migrations apply atomdojo-capsules --remote
```

Apply to local dev (uses `--local` wrangler state):

```bash
npm run cf:d1:migrate
```

Check what's been applied on remote:

```bash
wrangler d1 migrations list atomdojo-capsules --remote
```

---

## Health checks

Unauthenticated callers to admin endpoints must receive **404 Not Found**
(not 403) — this is intentional, so admin route existence doesn't leak:

```bash
curl -I https://atomdojo.pages.dev/api/admin/seed
curl -I https://atomdojo.pages.dev/api/admin/sweep/sessions
curl -I https://atomdojo.pages.dev/api/admin/sweep/orphans
# All three should return HTTP/2 404.
```

Authenticated sweep smoke test (confirms `CRON_SECRET` is correctly wired):

```bash
curl -X POST "https://atomdojo.pages.dev/api/admin/sweep/sessions" \
  -H "X-Cron-Secret: $CRON_SECRET"
# Expect 200 with a small JSON body summarizing the sweep.
```

Authenticated publish smoke test (requires a test user's session cookie):

```bash
curl -X POST "https://atomdojo.pages.dev/api/capsules/publish" \
  -H "Cookie: __Host-atomdojo_session=<session>" \
  -H "Content-Type: application/json" \
  --data-binary "@path/to/test.atomdojo"
# Expect 201 with { shareCode, url } (plus optional warnings[]).
```

Public resolve smoke test (any capsule code from the above):

```bash
curl -I "https://atomdojo.pages.dev/api/capsules/<code>"
curl -I "https://atomdojo.pages.dev/c/<code>"
# Expect 200 / redirect respectively.
```

---

## Known issues / operational notes

- **Quota is not a hard ceiling.** The split-API pattern
  (`checkPublishQuota` → persist → `consumePublishQuota`) has bounded
  overshoot under normal burst conditions and unbounded overshoot during
  a sustained D1 outage. If a hard cap becomes required (billing, legal),
  upgrade to a Durable-Object-backed counter. See `src/share/rate-limit.ts`
  for the current design rationale.
- **`SESSION_SECRET` rotation** resets the 24h abuse-report de-dup window —
  see the rotation section above. Don't rotate during an active moderation
  incident unless you have to.
- **OAuth account linking:** each `(provider, provider_account_id)` pair is
  one user. A person signing in via Google and then via GitHub gets two
  separate accounts by design. A future enhancement is an explicit
  user-initiated "link accounts" UI; until then, don't merge accounts
  manually in D1 without understanding the `sessions` and
  `capsule_share.user_id` implications.
- **Pages Function body-size limit:** publish is capped at 10 MB in
  `functions/api/capsules/publish.ts` (fast-reject on `Content-Length`,
  plus authoritative size check after body read). Cloudflare's own request
  body limit is higher, but the Pages Functions CPU budget is tighter;
  capsules near 10 MB may still exceed CPU and return 500. If users report
  this, check `wrangler tail` for `Exceeded CPU` errors and consider
  compressing the capsule payload client-side.
- **Private R2 bucket is load-bearing.** All capsule reads go through
  Pages Functions which consult `capsule_share.status` first. Making the
  bucket public (even for a "debug" window) would allow deleted /
  moderated capsules to continue serving via direct R2 URLs.
- **Cron Worker free-tier ceiling:** the account can register up to 5 cron
  triggers on the free tier (paid: 250). The sweeper currently uses 2. If
  you add more schedules, verify the plan.
