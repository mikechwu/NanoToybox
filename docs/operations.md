# Operations — Atom Dojo share-link deployment

Operational runbook for the production Atom Dojo deployment (Lab + Watch + Viewer
backed by Cloudflare Pages Functions, D1, and R2). The other `docs/` files cover
architecture and code; this one is for operators keeping the deployed system
healthy.

Audience: on-call operator with `wrangler` configured and access to the
Cloudflare dashboard for the `atomdojo` project.

---

## Open Items

Operational gaps the team is explicitly aware of. Entries stay here
until closed, either by a follow-up ticket landing the missing work or
by an update to the main runbook sections above.

- *(none at this time — the D138 subject-cluster rollout landed under
  Lane A. Both the local-dev backfill
  (`npm run capsule-preview:backfill:local`) and the production
  wrapper (`npm run capsule-preview:backfill:prod`) are live. A
  post-backfill verification query is under "Rollout procedure for
  a thumb-algorithm change" below; the stale-row transition is
  regression-locked by
  `tests/unit/backfill-stale-row-integration.test.ts`. If any future
  rollout defers its backfill wrapper, the rollout-incomplete block
  belongs in this section.)*

---

## Deployment topology

- **Cloudflare Pages** project `atomdojo` — serves Lab (`/lab/`), Watch
  (`/watch/`), Viewer (`/viewer/`) static assets plus all Pages Functions
  under `functions/` (auth, capsule publish/resolve, admin). The auth
  surface includes the OAuth start/callback endpoints, the session /
  logout endpoints, and `GET /auth/popup-complete` — a static-HTML Pages
  Function that runs inside the OAuth popup after the callback, notifies
  the opener via `postMessage` + `BroadcastChannel`, and closes itself.
  It enforces a strict CSP and is whitelisted by `validateReturnTo` in
  `functions/oauth-state.ts`.
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

Production values live in Cloudflare (never in git). `.dev.vars` is for
local development only and must never contain production values. OAuth
client IDs are public identifiers (not secrets); they live in
`wrangler.toml` under `[vars]` alongside bindings. Only the `*_SECRET`
values are stored as encrypted Pages Secrets.

| Value | Kind | Where | Purpose |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Public var | `wrangler.toml` `[vars]` | Google OAuth app identifier |
| `GITHUB_CLIENT_ID` | Public var | `wrangler.toml` `[vars]` | GitHub OAuth app identifier |
| `CAPSULE_PREVIEW_DYNAMIC_FALLBACK` | Public var | `wrangler.toml` `[vars]` | Feature flag (default `"on"`) gating dynamic Satori-rendered poster fallback for `GET /api/capsules/:code/preview/poster`. Allowlist parser: only `on` / `true` / `1` enable; anything else (`off`, `disabled`, typos, empty) disables. See *Capsule preview poster* below for rollback procedure. |
| `GOOGLE_CLIENT_SECRET` | Secret | Pages Secret | Google OAuth app secret |
| `GITHUB_CLIENT_SECRET` | Secret | Pages Secret | GitHub OAuth app secret |
| `SESSION_SECRET` | Secret | Pages Secret | Single key for OAuth signed-state HMAC, session cookie signing, and abuse-report IP hashing. One rotate point, three dependents — read the rotation section before touching it. |
| `CRON_SECRET` | Secret | Pages Secret **AND** cron Worker secret (IDENTICAL byte-for-byte) | Authorizes the production automation path to `/api/admin/*` endpoints (see `functions/admin-gate.ts`). |
| `AUTH_DEV_USER_ID` / `DEV_ADMIN_ENABLED` | **NEVER in production** | — | Local dev bypass only. Setting either in the production Pages project breaks the admin gate (`DEV_ADMIN_ENABLED=true` would expose admin routes to any request with a spoofed `Host: localhost` header that survives Cloudflare normalization, and `AUTH_DEV_USER_ID` would attach a fixed identity to every unauthenticated request). |

Cloudflare Pages treats `wrangler.toml` as the source of truth for public
vars and bindings. Once `[vars]` is defined in source, the dashboard's
plain-env-var editor is disabled (only Secrets remain editable in the
dashboard). To change a client ID, edit `wrangler.toml` and redeploy.

Provision secrets via `wrangler` (or paste-one-shot via the dashboard —
either works for secrets):

```bash
# Pages project secrets
wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=atomdojo
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
| `15 4 * * 0` | `POST /api/admin/sweep/audit?mode=scrub` | Weekly (Sun 04:15 UTC). NULL `ip_hash`, `user_agent`, and — for `abuse_report` + `moderation_delete` only — `reason` on `capsule_share_audit` rows older than 180 days. Event skeleton is retained for forensics. |
| `45 4 * * 0` | `POST /api/admin/sweep/audit?mode=delete-abuse-reports` | Weekly (Sun 04:45 UTC). Row-delete `event_type='abuse_report'` audit rows older than 180 days; also row-deletes `privacy_requests` past the 180-day SLA window. |

Stream live Worker logs during investigation:

```bash
cd workers/cron-sweeper
wrangler tail
# or, from repo root: npm run cron:tail
```

---

## Auth session endpoint & cookies

### `GET /api/auth/session` contract

Always responds **200 OK**. The body discriminates on `status`:

```json
{ "status": "signed-in",  "userId": "...", "displayName": "...", "createdAt": "2026-04-13T12:34:56.000Z" }
// or
{ "status": "signed-out" }
```

(`createdAt` is the `users.created_at` ISO-8601 string from D1, not a numeric epoch.)

401 is **reserved for protected-action endpoints** (e.g. `POST
/api/capsules/publish`). A 401 from `/api/auth/session` itself is a
regression and should be paged — clients treat non-200 as "unverified"
and leave any existing local session state untouched, which would mask a
real signed-out state.

Response headers (set on every response, including signed-out):

- `Cache-Control: no-store, private`
- `Pragma: no-cache`
- `Vary: Cookie`

The client-side hydrate at `/lab/` and `/watch/` passes
`cache: 'no-store'` to `fetch('/api/auth/session')` — defense in depth
with the server headers. Both layers must be in place; if an operator
ever adds an edge cache rule over `/api/auth/*`, the `Vary: Cookie` +
`Cache-Control: no-store` must be preserved or sessions will be served
to the wrong users.

**Opportunistic cookie clear.** If the request carries a session cookie
but the resolved auth is null (session row missing, expired, or points
at a deleted user), the endpoint appends a `Set-Cookie` that clears the
stale cookie. The browser converges to a clean signed-out state without
a separate logout round-trip. This is the same branch that emits
`[auth.session.user-missing]` when the orphan is a dangling user FK (see
*Operational signals* below).

### Cookie variants

The cookie name is protocol-scoped so the HTTPS cookie retains
`__Host-` prefix guarantees (host-only, Secure, path=/) while local
development over plain HTTP still gets a working session.

| Environment | Cookie name | Attributes |
|---|---|---|
| Production / any HTTPS deployment | `__Host-atomdojo_session` | `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only (no `Domain`) |
| Local dev over plain HTTP (`http://localhost:*`) | `atomdojo_session_dev` | `HttpOnly`, `SameSite=Lax`, `Path=/` (no `Secure`, no `__Host-` prefix) |

The client-side `hasSessionCookie` helper scopes by
`location.protocol`: on `https:` it looks only for
`__Host-atomdojo_session`; on `http:` it looks only for
`atomdojo_session_dev`. This prevents a stale dev cookie on a
deployed-over-HTTP test rig from being mistaken for a real production
session, and vice-versa.

### `authenticateRequest` middleware

`functions/auth-middleware.ts` resolves the session cookie to a
`(session, user)` pair via a single `LEFT JOIN sessions → users` query.
Orphan handling:

- **Orphan session (user row deleted):** the JOIN returns a session row
  with null user columns. Middleware returns null auth AND fires a
  fire-and-forget `DELETE FROM sessions WHERE id = ?` so the row doesn't
  keep triggering the branch.
- **Dedupe:** a per-isolate `Set<string>` of session IDs under active
  delete attempt prevents hammering D1 if the delete keeps failing. The
  set is **hard-capped at 256** entries (re-initialized when the ceiling
  is hit) so a pathological cascade can't leak memory.
- **Delete failure logging:** `[auth.orphan-delete-failed]` with a short
  session-id prefix only (never the full session id — those are bearer
  tokens). Persistent volume here indicates D1 unavailability rather
  than an auth logic bug.

This in-band cleanup is a **secondary net** to the cron sweeper's
session sweep (`POST /api/admin/sweep/sessions`, every 6h), which
already catches expired sessions and orphan session rows referencing
deleted users. Middleware cleanup shortens the window between user
delete and session invalidation from up-to-6h to "next request". The
sweeper remains the authoritative cleanup for sessions that never get
touched again.

### Accepted `returnTo` / post-auth redirect targets

`validateReturnTo` in `functions/oauth-state.ts` is the whitelist for
post-OAuth redirect targets. Currently accepted values:

- `/lab/` and `/lab/?authReturn=1`
- `/watch/`
- `/viewer/`
- `/auth/popup-complete` — used by the popup flow; the HTML at this
  route does the opener-notify + self-close dance.

Any new Pages route that needs to receive a post-auth redirect must be
added to this whitelist; otherwise the OAuth callback will reject it
and fall back to `/lab/`.

---

## Operational signals

Grep targets for `wrangler pages deployment tail` during auth incident
response. These are log prefixes emitted by normal code paths — most
are informational unless volume spikes, but a couple are regression
canaries.

### Server-side (Pages Functions)

| Prefix | Where | Meaning |
|---|---|---|
| `[auth.orphan-delete-failed]` | `functions/auth-middleware.ts` | Fire-and-forget DELETE for an orphaned session row (user deleted under it) failed. Sustained volume = D1 availability issue, not a logic bug. Logged with short sid-prefix only. |
| `[auth.session.user-missing]` | `functions/api/auth/session.ts` defensive branch | Session cookie resolved to a valid session row but the `users` SELECT returned no row. Paired with the opportunistic cookie clear; presence means the session endpoint is converging a stale client, but a steady stream here in the absence of real user deletions suggests a regression in the session-endpoint `users` SELECT (e.g. a column typo) — investigate before it silently signs everyone out. |
| `REPORT_DEDUP_DISABLED` | `functions/api/capsules/[code]/report.ts` | See alerting table — repeated here because it's grep-shaped the same way. |
| `R2_UPLOADED_MISSING` | `functions/api/admin/sweep/orphans.ts` | See alerting table. |
| `PUBLISH_RECONCILE_LOST` | `functions/api/capsules/publish.ts` | See alerting table. |
| `[capsule-poster]` | `functions/api/capsules/[code]/preview/poster.ts` | One structured-JSON line per poster-route response: `{"code":"...","mode":"stored\|generated\|error\|flag-off\|inaccessible","durationMs":N,"status":N,"cause":"..."}`. `mode` discriminates the served path; `cause` carries a stable prefix on the non-happy modes (and, on `mode:'generated'`, optionally carries `bondless-heal-failed:<reason>` when the read-time heal of a legacy bondless row fell through and a bondless scene was served — query this in one stream to find successful renders still serving without bonds). V2 taxonomy (full list — all non-success causes funnel through `serveTerminalFallback` so the response stays a valid 200 PNG with `Cache-Control: public, max-age=60`, EXCEPT `module-import-failed:*` which emits `Cache-Control: no-cache, no-store, must-revalidate` so a bad deploy doesn't lock edge caches onto the fallback PNG for 60 s): `satori-threw:<msg>`, `module-import-failed:<msg>`, `r2-miss`, `dynamic-not-png:Nb`, `stored-not-png:Nb`, `fallback-fetch-failed:<msg>` (combined with original cause via `;`), `scene-missing` (lazy-backfill hit but R2 blob absent), `capsule-parse-failed:<msg>` (R2 blob present but rejected by `validateCapsuleFile`), `no-dense-frames` (capsule's `timeline.denseFrames[]` empty). Aggregate by `mode` to track stored-hit vs dynamic-render vs error rates; alert on a sustained `error` rate or any `module-import-failed:` (indicates a `@cloudflare/pages-plugin-vercel-og` regression). |
| `[capsule-poster] bondless-heal-failed: <reason> share=<code>` | `functions/api/capsules/[code]/preview/poster.ts` | Synchronous read-time heal of a bondless legacy row (`scene.thumb.atoms` populated, no bonds anywhere) failed; the route falls through and serves whatever bondless scene it has (a bondless poster is strictly better than the terminal fallback). Reasons mirror `rebakeSceneFromR2`: `blob-missing`, `blob-read-failed:<msg>`, `capsule-parse-failed:<msg>`, `no-dense-frames`, `scene-empty`. The structured `[capsule-poster]` success log emitted for the same request carries `cause: bondless-heal-failed:<reason>` on `mode:'generated'` so both signals can be correlated in one stream. One-offs are expected for rows whose R2 blob is missing (orphan-sweeper pending); a sustained rate means the heal is failing for rows with live blobs and publish-pipeline regression is likely. |
| `[capsule-poster] scene-parse-failed for share=<code>` | `functions/api/capsules/[code]/preview/poster.ts` | `preview_scene_v1` was non-NULL but `parsePreviewSceneV1` returned null (malformed JSON, wrong `v`, non-finite coords, etc.). Route falls through to `rebakeSceneFromR2`. One-offs are single bad historical rows; sustained volume suggests the writer is emitting bad scenes. |
| `[account.capsules] bondless-heal-failed: <reason> share=<code>` | `functions/api/account/capsules/index.ts` | Background (`ctx.waitUntil`) heal for a bondless row queued by the account-list endpoint failed. The response is already sent — same bondless data the user saw now; the next page load reflects the healed row once a later heal succeeds. Capped at **3 background heals per account-list request** to bound R2 traffic when a user's feed contains many legacy rows from the same launch period. |
| `[preview-heal] write-failed: <msg>` | `src/share/capsule-preview-heal.ts` | D1 UPDATE after a successful in-memory rebake failed. The render/return is already computed from the freshly projected scene, so the current request succeeds; the next request retries the write. Persistent volume = D1 write pressure on `capsule_share.preview_scene_v1`. |
| `[<tag>] background-rejected: <msg>` | `functions/_lib/wait-until.ts` | Detached promise scheduled via `scheduleBackground` rejected. Current `<tag>` values: `publish` (publish-audit and success-counter writes from `functions/api/capsules/publish.ts`), `account.capsules` (background bondless heals from `functions/api/account/capsules/index.ts`). Systematic volume for one tag = the corresponding background path (audit write / heal / counter) is failing at the edge. Without this wrapper the rejection would vanish into a silent `.catch` — presence of the log is a reliability floor, not itself an incident unless sustained. |
| `[scene-store] thumb-malformed: <reason>` | `src/share/capsule-preview-scene-store.ts` | Parsed `preview_scene_v1` storage carried an invalid `thumb` field; scene is still returned, thumb is dropped (read path falls back to live sampling). Reasons: `invalid-rev`, `no-atoms`, `atom-not-an-object`, `atom-nonfinite-or-malformed`, `bond-not-an-object`, `bond-nonint-indices`. One-offs are a single bad historical row; a sustained rate means the writer is emitting malformed thumbs and needs investigation. |
| `[scene-store] thumb-rev-stale count=<N> stored=<X> current=<Y> — re-bake via backfill to restore full-fidelity bonds` | `src/share/capsule-preview-scene-store.ts` | Stored thumb is at an older revision than `CURRENT_THUMB_REV`; read path falls back to live sampling. **Rate-limited**: `warnStaleRevOnce` emits at milestones (1, 10, 100, 1000, …) per distinct stored rev per worker isolate — one stray row logs once, a stuck backfill over 100k rows also stays readable. `count=N` reads as "Nth time this isolate has seen rev=X"; comparing counts across isolates after a deploy gives the lag shape. Rate should drop to zero once the post-rev-bump backfill completes (see *Rollout procedure for a thumb-algorithm change* below). |
| `[scene-store] derive-threw: <msg>` | `src/share/capsule-preview-scene-store.ts` | Entry-level catch in `derivePreviewThumbV1`. The account list endpoint no longer 500s on one bad row — it returns `null` and the client renders a placeholder. Persistent volume indicates a projection bug, not a data issue. |
| `[publish] preview-scene-skipped: <msg>` | `src/share/publish-core.ts` | Publish succeeded but the preview-scene projection failed; row stored with `preview_scene_v1 = NULL`, later backfillable by `scripts/backfill-preview-scenes.ts` or by the poster route's lazy-backfill path. |
| `[publish] stored-thumb-skipped: <errName>:<msg> atoms=N bonds=M` | `src/share/publish-core.ts` | Narrow catch around the full-atoms thumb builder only. Poster scene still valid, thumb absent — read path falls back to live sampling. Distinct from `preview-scene-skipped` (which indicates the whole scene failed). |
| `[publish] bonds-skipped: <msg>` | `src/share/publish-core.ts` | Bond derivation step threw; poster is atoms-only. Cosmetic degradation; no downstream data loss. |
| `[publish] cluster-select: mode=<m> size=<sel>/<full> components=<n> meaningful=<n> fallback=<bool> reason=<r>` | `src/share/publish-core.ts` | Per-publish cluster-selection diagnostics (ADR D138). `mode` is `full-frame` or `largest-bonded-cluster`; `reason` is `none` / `no-bonds` / `no-meaningful` / `dominance-failed` / `mode-full-frame`. Watch the guard-pass vs. `dominance-failed` ratio after a rollout — a sudden shift toward `dominance-failed` means capsules have become more balanced and the guard is preserving them, which is the intended behavior. |
| `preview_backfill_run` audit event (`capsule_share_audit`) | `functions/api/admin/backfill-preview-scenes.ts` | One event per backfill invocation. Severity: `info` = clean sweep, `warning` = partial success (some rows failed but ≥ 1 updated), `critical` = pure failure (0 updated, ≥ 1 failed — endpoint returns HTTP 500). `details_json` carries `{ dryRun, force, pageSize, currentThumbRev, scanned, updated, skipped, failedCount }`. When to investigate: any `critical` emission, or sustained `warning` over successive runs. |
| `[backfill] start rev=<N> force=<bool> pageSize=<N> dryRun=<bool> verbose=<bool>` | `functions/api/admin/backfill-preview-scenes.ts` | Emitted at endpoint entry. Pair with the matching `[backfill] done` line. |
| `[backfill] done scanned=<N> updated=<N> skipped=<N> failed=<N> severity=<s>` | `functions/api/admin/backfill-preview-scenes.ts` | Emitted after the library call, before the audit event write. Per-row failure detail stays in the library's own `[backfill]` verbose logs, not in the summary. |

### Client-side (browser console, surfaces as error events)

Emitted by the `/lab/` and `/watch/` auth reconciler. These are
user-visible only via browser devtools, but they're useful when an
operator is pairing with a reporting user during an incident.

| Prefix | Meaning |
|---|---|
| `[auth] logout returned {status}; will reconcile` | `POST /api/auth/logout` returned a non-2xx. Client proceeds to reconcile by re-fetching `/api/auth/session`; final truth comes from the session endpoint, not the logout response. |
| `[auth] logout transport failed; will reconcile` | Logout fetch threw (offline, CORS, etc). Same reconcile path. |
| `[auth] session fetch {reason}` | Non-ok response from `/api/auth/session` during hydrate. `{reason}` is the HTTP status or a transport error tag. |
| `[auth] session fetch {reason} → keep {status}` | Same as above, but the client had a prior known-good session and is preserving it (`keep signed-in` / `keep signed-out`) across the transient failure rather than flipping state on an unverified response. |
| `[auth] session fetch {reason} → unverified` | Non-ok session fetch with no prior known state; client enters the unverified tri-state (neither signed-in nor signed-out until the next successful fetch). |
| `[auth] resume-intent sentinel persists after clear` | `sessionStorage.removeItem('atomdojo.resumePublish')` was issued but a subsequent read still returned the key. Extremely rare (sessionStorage quirk or extension interference); investigate if an operator sees this alongside user reports of duplicate publish attempts post-login. |
| `[auth] resume-intent clear failed` | `sessionStorage.removeItem` threw. Usually disabled storage or private-browsing quota. |
| `[auth] popup-complete handler failed` | The opener-side `handleAuthComplete` (postMessage / BroadcastChannel listener) threw. Auth state may not be hydrated. The opener does NOT auto-poll; the next user-driven action (opening Transfer dialog → opportunistic `hydrateAuthSession`, or a manual page reload) refreshes the session state. The popup-complete landing page itself surfaces a "Close this tab and refresh the Lab tab" hint when neither channel delivers. |
| `[auth] dropping auth-complete message from unexpected origin` | A `message` event with the auth-complete shape arrived from an origin that did not match the Lab tab's `window.location.origin`. The handler dropped it (security-correct). On a Vite dev host (port 5173) this commonly indicates a popup that landed on `:8788` — run the Lab under `npm run cf:dev` or use the same host for both. |
| `[auth] OAuth popup skipped — running on Vite dev host` | Dev-only signal: `tryBeginOAuthPopup` short-circuited because the Lab is on Vite (port != 8788), where `/auth/{provider}/start` 404s. The popup-blocked UX surfaces (Retry / Continue-in-tab / Back). Production traffic never emits this. |

### Client-side (Watch→Lab handoff, browser console)

Emitted during the Watch→Lab handoff funnel (the Watch-side primary
button, currently labeled **"Interact From Here"**; previously "Continue" /
"Remix" / "From this frame"). The secondary disclosure option is labeled
**"Open a Fresh Lab"** (previously "Open Lab"). Watch writes
the paused frame (positions + velocities + color assignments + orbit
camera + small metadata) to `localStorage` and opens
`/lab/?from=watch&handoff=<token>`; Lab consumes, scrubs the URL, and
hydrates the scene inside a transactional apply with rollback. Every
failure mode logs a greppable tag before (or instead of) surfacing an
error banner — user reports almost always correlate with one of these.

| Prefix | Meaning |
|---|---|
| `[lab.boot] watch handoff hydrated: { atomCount, historyKind, velocitySource, unresolvedVelocityFraction, colorAssignmentCount, hasCamera }` | Happy path. `historyKind` discriminates which seed flavor was consumed. `velocitySource` is one of `restart` / `central-difference` / `forward-difference` / `backward-difference` / `mixed` / `none` — the dominant per-atom tag collapsed to a single label at build time. `unresolvedVelocityFraction` (0..1) is the fraction of atoms whose velocity could not be resolved and were null-promoted; anything non-zero indicates partial motion-state fidelity. `colorAssignmentCount` is the number of bonded-group color assignments carried; 0 means the Lab side will wipe prior color state on apply (REPLACE semantics, not additive). `hasCamera` is true when the seed carried an orbit-camera snapshot (position/target/up/fovDeg); false falls back to `renderer.fitCamera()`. Informational — there is NO arrival-provenance pill in the UI; hydrate success is the rendered scene plus this trace. |
| `[lab.boot] watch handoff hydrate failed: <reason> <cause>` | Hydration reached the transactional apply stage (`lab/js/runtime/handoff/hydrate-from-watch-seed.ts`) and threw; the transaction rolled back to the pre-hydrate snapshot (including color assignments and camera pose). `<reason>` is one of: `worker-restore-rejected` (worker refused to accept the restored atom/bond/velocity state — often a worker-bundle regression; correlate with `[worker] failure during hydrate transaction …`), `physics-commit-threw` (main-thread physics engine rejected the commit, e.g. shape mismatch between seed and engine arrays), `renderer-stage-threw` (Three.js/renderer rebuild failed — typically a GPU-context loss or buffer-size mismatch), `registry-register-threw` (bonded-group registry rejected the appearance/color re-registration — usually a color-assignment with unknown atomIds that survived validation), `runtime-not-ready` (hydrate was dispatched before the Lab scene-runtime finished its own boot; race condition, expect this only on extremely slow cold loads), `rollback-also-failed` (the originating failure triggered rollback and the rollback itself threw — `<cause>` is shaped `{ originatingCause, rollbackSubFailures }` with both halves preserved instead of swallowed). Paired with a default-scene fallback load. |
| `[lab.boot] watch handoff rejected: <reason>` | Handoff failed the consume-side validator before any runtime work started. `<reason>` is one of `stale` (token older than TTL), `missing-entry` (token URL present but no matching `localStorage` entry — expected if the other tab already consumed, or if the writer was suppressed by storage-unavailable), `malformed-seed`, `wrong-version`, `wrong-source`, `wrong-mode`, `parse-error`. `stale`/`missing-entry` are the two the user is most likely to surface via the banner copy below. The others indicate a writer/reader version skew and should be correlated with recent deploys. |
| `[lab.boot] default-scene fallback load failed: <err>` | The default-scene load attempted after a rejected or failed handoff itself failed. This is the terminal error path — the Lab will render its "Couldn't load the default scene" banner. If you see this without a preceding handoff rejection, it's a plain default-scene regression, not a handoff issue. |
| `[watch] handoff write failed: <kind> <message>` | Watch-side writer failed. `<kind>` is `storage-unavailable` (private-browsing, extension-blocked, or no DOM storage at all) or `quota-exceeded` (origin `localStorage` ceiling hit; the writer pre-sweeps prior handoff entries before surfacing the error, so a persistent rate of this in the absence of other heavy `localStorage` writers indicates something outside our namespace is consuming quota). The user sees one of the two storage banners listed below. |
| `[worker] failure: <reason> — rebuilding local physics for sync fallback` | Generic worker-append failure outside a hydrate transaction. Scene-runtime tears down the worker and continues in sync mode; the user sees the "Simulation worker is unavailable…" banner. Sustained volume indicates a worker-bundle regression (check recent changes under `src/md/worker/`). |
| `[worker] failure during hydrate transaction — deferring to hydrate rollback: <reason>` | Worker failed mid-hydrate; the hydration lock intercepted the tear-down so the hydrate can roll back atomically rather than leaving a half-applied scene. Paired with the `[lab.boot] watch handoff hydrate failed: …` entry above. |
| `[scene-runtime] worker append failed — tearing down worker, falling back to sync mode` | Companion to the `[worker] failure: …` entry emitted by the scene-runtime side of the tear-down. Presence of one without the other is a regression (the two logs bracket the same transition). |

### Client-side sentinels (browser storage, not logs)

Not log prefixes, but operators should know what's in browser storage
when debugging with a user. Keys are split by storage class and TTL.

**`sessionStorage` (per-tab, cleared on tab close):**

- `atomdojo.onboardingDismissed` — boolean-ish; set when the user
  dismisses the onboarding modal. Purely client-side; no backend
  touchpoint.
- `atomdojo.resumePublish` — structured JSON
  `{ kind, provider, iat }` with a 10-minute TTL. Set when the user
  clicked publish while signed-out and the auth flow was deferred;
  read on the post-auth return to resume the interrupted action.
  Self-clears on consume; stale entries are ignored via the `iat` TTL
  check.
- (Arrival pill removed — the "Interact From Here" redesign (formerly
  the Continue-centric redesign) deleted the Watch→Lab arrival pill.
  Hydrate success now = rendered scene + the `[lab.boot] watch handoff
  hydrated` console.info trace; there is no arrival UI. The
  `atomdojo.watchHandoffPillDismissed:<token>`
  key is no longer written by current builds. Operators may still see
  legacy keys in long-lived `sessionStorage` snapshots from pre-pill-
  removal sessions; they are inert and can be safely ignored.)

**`localStorage` (per-origin, persistent until cleared):**

- `atomdojo.watchLabHandoff:<token>` — Watch→Lab handoff payload,
  10-minute TTL enforced at read time. Value is a small JSON envelope
  wrapping base64-encoded `Float64Array`s of positions + velocities,
  plus color assignments (stable-id quartets: `{id, atomIds[], colorHex,
  sourceGroupId}` — no dense indices on the wire) and an orbit-camera
  snapshot (`{position, target, up, fovDeg}`). Seed-size hard caps live
  in `src/watch-lab-handoff/watch-lab-handoff-shared.ts`:
  `SEED_MAX_ATOMS = 50_000` and `SEED_MAX_BONDS = 100_000`. A Float64
  positions array at the atom cap is 50_000 × 3 × 8 = 1.2 MB raw → ~1.6
  MB base64; velocities double that. Typical 264-atom capsule frame is
  <500 KB total. Origin `localStorage` quota is ~5–10 MB per browser
  (implementation-defined), so any single token is well under budget
  even near the cap. Tokens are one-shot: Lab consumes (removes) the
  entry on first successful read via `removeWatchToLabHandoff`, and the
  URL query params are scrubbed post-consume so a reload can't replay.
  Watch pre-sweeps orphan entries under this prefix before each write
  (TTL sweep uses the same 10-minute threshold), bounding worst-case
  accumulation if a user repeatedly opens handoffs but never lands on
  the Lab tab. The Watch controller's current-frame href cache mints a
  new token only when the identity tuple changes — positions, bonds,
  velocities, color assignments, and a quantized camera identity
  (`POSITION_Q = 0.01`, `FOV_Q = 0.5`); on a cache miss the prior token
  is purged via `removeWatchToLabHandoff` before the new one is written,
  so the prefix never grows unboundedly on rapid pose tweaks.

When a user reports a handoff failure, first ask them to open devtools
→ Application → Storage and confirm whether any
`atomdojo.watchLabHandoff:*` keys are present. Zero keys + a Lab URL
carrying `?from=watch&handoff=<token>` matches the `missing-entry`
rejection reason.

### User-reported error banner copy (grep-to-root-cause)

Support reports usually quote the banner text verbatim. Map to code
path before asking the user to reproduce:

Banner copy references the Watch→Lab handoff by the current primary-CTA
label **"Interact From Here"**. The copy has already cycled through
earlier wordings ("remix" → "Continue" → "Interact From Here"); older
support tickets may still quote the prior strings verbatim, so all
forms are kept in this table.

| Banner text | Root-cause path |
|---|---|
| "This Interact From Here link has expired. Open it again from Watch to try once more." (legacy: "This Continue link has expired. …" / "This remix link has expired. …") | `[lab.boot] watch handoff rejected: stale` — token older than the TTL (10 min in production; `?e2eHandoffTtlMs=<ms>` override is test-only). |
| "This Interact From Here link is no longer available. Open it again from Watch to try once more." (legacy: "This Continue link is no longer available. …" / "This remix link is no longer available. …") | `[lab.boot] watch handoff rejected: missing-entry` — either the other tab already consumed the token and cleared it via `removeWatchToLabHandoff` (benign — reload of the Lab tab after arrival), or the writer-side entry never landed (check for `[watch] handoff write failed: …`). |
| "Your browser is blocking storage, so the current frame can't be prepared. …" | `[watch] handoff write failed: storage-unavailable` — private browsing, Storage-API permissions, or extension blocking. Watch-side only; no Lab-side log. |
| "Browser storage is full, so the current frame can't be prepared. …" | `[watch] handoff write failed: quota-exceeded` — retry sweeps prior handoff entries first (TTL sweep over `atomdojo.watchLabHandoff:*`); if this still surfaces, a non-atomdojo writer is consuming the origin's `localStorage` quota. |
| "Couldn't restore the scene from Watch. The default scene is loading instead." | `[lab.boot] watch handoff hydrate failed: <reason> …` — the transactional hydrate rolled back. `<reason>` narrows the cause: `worker-restore-rejected`, `physics-commit-threw`, `renderer-stage-threw`, `registry-register-threw`, `runtime-not-ready`, or `rollback-also-failed`. See the signal table above for per-reason triage. The default-scene fallback is attempted immediately after the rollback completes. |
| "Couldn't load the default scene. Please reload the page." | `[lab.boot] default-scene fallback load failed: …` — see the signal table above. Often chained after a hydrate failure when the fallback path itself blows up. |
| "Simulation worker is unavailable. Running locally — performance may be reduced." | `[worker] failure: … — rebuilding local physics for sync fallback` — worker append failed outside a hydrate transaction. |
| "Simulation worker disconnected during timeline restart. Running locally — performance may be reduced." | `reinitWorker` → `restoreState` failed during a worker re-init (timeline restart / scrub). Scene continues in sync mode; same degraded-performance story as the generic worker-unavailable banner. |

### Watch→Lab URL query params

`/lab/` honors the following query params in addition to `?authReturn=1`
(already covered under `validateReturnTo`). All four are consumed and
scrubbed from the URL after the Lab boot pipeline reads them, so reload
is always a clean state:

| Param | Purpose |
|---|---|
| `?from=watch` | Signals a pending Watch→Lab handoff. Required pair with `handoff`. |
| `?handoff=<token>` | Opaque token naming the `atomdojo.watchLabHandoff:<token>` `localStorage` entry. One-shot; consumed (removed) by Lab on first successful read. |
| `?e2e=1` | Test hook. On Watch it installs `window._watchOpenFile` + `window._watchScrub` harness helpers; on Lab it exposes `window._getUIState`. Never set by production user flows. If you see this in a user-reported URL, either they pasted a test-harness URL or an automation tool is running — not a production support case. |
| `?e2eHandoffTtlMs=<ms>` | Test-only TTL override for the handoff stale-check. Ignored unless `?e2e=1` is also present. Production uses the hard-coded 10-minute TTL. |

The one-shot scrub is what prevents reload-replay: once Lab consumes
the token, the URL no longer carries it, and a browser reload lands on
a plain `/lab/` with no pending handoff. If a user reports that a
reload "recovered" a failed handoff, that's a bug — file it, don't
dismiss it.

---

## Capsule preview poster endpoint (V2)

`GET /api/capsules/:code/preview/poster` serves the 1200×630 PNG used by
OpenGraph / Twitter / link-unfurl consumers. The endpoint multiplexes
four served paths and registers four cache tiers; the served path is
visible in the `[capsule-poster]` log line's `mode` field.

V2 rendering is driven by the **publish-time preview scene** persisted
in `capsule_share.preview_scene_v1` (migration `0009`), not by sampling
the R2 blob at poster-request time. The dynamic Satori path reads the
stored projection; on a cache miss (row has `preview_scene_v1 IS NULL`)
the route lazy-backfills by fetching the R2 blob, projecting the scene,
and writing it back to D1.

### Read-time auto-heal for bondless legacy rows

Early publish-time bakes ran a projection-visibility filter and a
small-cluster bond-skip gate that produced rows with
`scene.thumb.atoms` populated but both `scene.bonds` and
`scene.thumb.bonds` empty ("bondless"). Detection is
`sceneIsBondless(scene)` in `src/share/capsule-preview-heal.ts`. The two
read paths repair these rows transparently:

- **Poster route (synchronous heal).** On a bondless detection, the
  poster handler calls `healBondlessRow(env, row)` BEFORE rendering so
  the served PNG carries bonds. The heal fetches the R2 blob,
  re-projects via `projectCapsuleToSceneJson`, and
  `UPDATE capsule_share SET preview_scene_v1 = ? WHERE id = ?` is
  issued **unconditionally** (not `WHERE preview_scene_v1 IS NULL` — the
  overwrite is the point). On heal failure the route serves whatever
  bondless scene was already in D1 and emits `cause:
  bondless-heal-failed:<reason>` on the `mode:'generated'` success log.
- **Account API (background heal).** The account-list handler returns
  the current (possibly bondless) page data immediately, then queues up
  to **3 heals per request** via `ctx.waitUntil` through the shared
  `scheduleBackground` wrapper. The next page load reflects the healed
  row. The cap bounds R2 traffic when a feed has many legacy rows from
  the same launch period.

Both paths share `rebakeSceneFromR2` in
`src/share/capsule-preview-heal.ts`. D1 write failures inside the heal
log as `[preview-heal] write-failed: <msg>` and do NOT flip the heal's
success flag — the fresh scene is already in memory for the current
render/return, and the next request retries the write. Failure reason
values are `blob-missing`, `blob-read-failed:<msg>`,
`capsule-parse-failed:<msg>`, `no-dense-frames`, `scene-empty`.

The explicit read-time heal is **independent of the backfill
scripts**. It repairs rows as users encounter them; the admin backfill
(below) repairs rows proactively. Both converge on the same
projection, so the order doesn't matter and neither is required to
run for the system to keep healing itself.

### Response contract & cache tiers

| `mode` | Status | Body | `Cache-Control` | Notes |
|---|---|---|---|---|
| `stored` | 200 | PNG (R2-stored poster) | `public, max-age=31536000, immutable` | Stored asset for the capsule exists in R2. Browser- and edge-cacheable for one year; the R2 key is content-addressed so the URL changes when the asset does. |
| `generated` | 200 | PNG (Satori-rendered from `preview_scene_v1`) | `public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` + `ETag: "v2-<FNV1a32 over [TEMPLATE_VERSION, scene.hash, sanitizedTitle, shareCode]>"` | Dynamic render per request via `@cloudflare/pages-plugin-vercel-og`. Short browser cache, longer edge cache, day-long SWR window. Gated by `CAPSULE_PREVIEW_DYNAMIC_FALLBACK`. |
| `error` (terminal `/og-fallback.png`) | 200 | PNG (`public/og-fallback.png`, 1200×630) | `public, max-age=60` | Last-resort fallback when both stored and dynamic paths fail. Short cache so a fix propagates fast. |
| `error` (1×1 safety net) | 200 | 1×1 PNG | `public, max-age=60` | Reached only when even `/og-fallback.png` fetch fails. Short cache; presence in logs (`fallback-fetch-failed:` cause) is itself a signal. |
| `flag-off` / `inaccessible` | 404 | — | `public, max-age=60` | Capsule row is moderation-deleted, account-deleted, or the flag is off and no stored asset exists. Short cache so a flag flip or moderation reverse takes effect within a minute. |

All responses include `Access-Control-Allow-Origin: *` and
`X-Content-Type-Options: nosniff` so external unfurlers (Slack, Discord,
Twitter, iMessage previewer) can fetch cross-origin without preflight
and browsers don't sniff a fallback to non-PNG MIME.

### Cache-busting URL scheme

`posterUrlFor()` in `src/share/share-record.ts` emits two URL shapes,
keyed by whether a stored R2 poster asset exists for the row:

- **Dynamic** (no stored asset): `/api/capsules/<code>/preview/poster?v=t<TEMPLATE_VERSION>` — currently `?v=t2`. Busts on `TEMPLATE_VERSION` bump.
- **Stored** (R2 asset present): `/api/capsules/<code>/preview/poster?v=p<FNV1a32 first-8-hex of preview_poster_key>`. Busts on any change to the stored key (content-addressed).

`TEMPLATE_VERSION` lives in `src/share/capsule-preview.ts` and is currently `2`.

### Public-API metadata semantics — RELEASE-NOTE

`ShareMetadataResponse.preview` is widened from "present only when a
stored asset exists" to `{posterUrl, width: 1200, height: 630}` for any
accessible row when `CAPSULE_PREVIEW_DYNAMIC_FALLBACK` is on. The
preview block is present even when no stored R2 asset exists —
`posterUrl` may resolve to a dynamically-rendered Satori PNG driven by
`capsule_share.preview_scene_v1`.

External consumers that need to branch on "stored asset exists" must
read `previewStatus === 'ready'`; `preview.posterUrl` presence does
NOT imply a stored asset. This is a contract widening, not a break,
but downstream caches that keyed off "preview present ⇒ stored" need
to be re-checked.

### Feature-flag rollback procedure

`CAPSULE_PREVIEW_DYNAMIC_FALLBACK` lives in `wrangler.toml [vars]`.
**It is not a zero-deploy rollback** — Pages Functions resolve `[vars]`
at deploy time, so changing the value requires a redeploy.

```bash
# 1. Edit wrangler.toml [vars] to disable.
#    (Allowlist parser: only "on"/"true"/"1" enable; "off" disables.)
#
#    [vars]
#    CAPSULE_PREVIEW_DYNAMIC_FALLBACK = "off"
#
# 2. Redeploy.
npx wrangler pages deploy dist --project-name=atomdojo
```

With the flag off, the dynamic Satori path is skipped entirely; the
endpoint still serves stored R2 posters at `mode=stored`, and
otherwise falls through to the 404 `flag-off` mode (or the
terminal `/og-fallback.png` path if a previously-served URL lands here
post-flip). `ShareMetadataResponse.preview` reverts to the pre-V1
"present only when a stored asset exists" semantics. Note that
disabling the flag does NOT affect the `preview_scene_v1` column or
the backfill scripts — those keep running against fresh publishes so
that re-enabling the flag is a single-deploy operation with zero
warm-up.

### Runtime / bundle dependencies

- `@cloudflare/pages-plugin-vercel-og@0.1.2` (pinned exact). Adds
  ~1–2 MB to the Function bundle; the Pages Functions compressed-bundle
  ceiling is 10 MB. If a future bump breaches that ceiling, deploy will
  fail at upload — re-pin or split the dynamic-render path off.
- **No `compatibility_flags = ["nodejs_compat"]` was added** — the
  pinned 0.1.2 version does not require it. If a future upgrade
  introduces a Node-API dependency, the flag must be added to
  `wrangler.toml` in the same commit.
- **Bundled font:** `functions/_lib/fonts/inter-regular.ts`
  (base64-encoded TTF, validated at module init via TTF magic-byte
  check — a corrupt bundle surfaces as `module-import-failed:` in
  the `[capsule-poster]` log and the route falls through to the
  terminal `/og-fallback.png`).
- **Static asset:** `public/og-fallback.png` (1200×630, copied to
  `dist/` by Vite). If this asset is missing from `dist/`, the
  terminal-error path emits `fallback-fetch-failed:` and serves the
  1×1 safety net.
- **Bond rule source.** Publish-time bond derivation uses
  `buildBondTopologyFromAtoms` from `src/topology/` — the same rule
  Lab and Watch use for the live scene. For carbon-only single-cutoff
  scenes the output is byte-identical to the previous
  `deriveBondPairs`, so `CURRENT_THUMB_REV` did NOT bump on the
  switch. At read time the bonded thumb path is configured with
  `minVisibleBondViewbox: Number.NEGATIVE_INFINITY`,
  `relaxedVisibleBondViewbox: Number.NEGATIVE_INFINITY`, and
  `bondsAwareThreshold: 0` so every bond produced by the topology
  builder reaches the renderer — the projection-occlusion filter and
  the `n >= 14` atom-count gate are both bypassed now that the heal +
  backfill paths reliably produce full bond sets.
- **D1 migration `0009_capsule_preview_scene_v1.sql`** — adds a nullable
  `capsule_share.preview_scene_v1 TEXT` column. Additive; NULL for pre-V2
  rows (which the poster route lazy-backfills on first miss). Stored
  JSON shape: `{ v:1, atoms[], bonds?, hash, thumb?: { rev, atoms, bonds? } }`.
  `thumb.rev` is currently `15` (see `CURRENT_THUMB_REV` in
  `src/share/capsule-preview-scene-store.ts`). The rev history is
  maintained in full in the JSDoc above `CURRENT_THUMB_REV` — consult
  that file for the per-rev deltas (pipeline has advanced through
  cluster-selection landing, path-batched renderer, cap raises,
  perspective pinhole camera, single-pass depth-sorted paint, and the
  current `PERSPECTIVE_K_DEFAULT = 3.17` tuning).

### Backfill runbooks (populate `preview_scene_v1`)

Two lanes — production and local dev — both idempotent, both safe to
re-run. The poster route's lazy-backfill path handles any row either
script misses, so V2 can ship before a full backfill completes.

**Production backfill** — `npm run capsule-preview:backfill:prod`:

This wraps `scripts/backfill-preview-scenes-prod.mjs`, a thin HTTP
client that POSTs to the admin-gated Pages Function at
`POST /api/admin/backfill-preview-scenes`. The endpoint runs the
`backfillPreviewScenes` library inside the Pages Function runtime with
real D1 + R2 bindings, records a single `preview_backfill_run` audit
event per invocation, and returns the library's `BackfillSummary` as
JSON.

Always snapshot D1 before a mutating backfill, and smoke-test with
`--dry-run` first:

```bash
wrangler d1 export atomdojo-capsules --output backup.sql

# Step 1 — dry-run smoke test (readback only; no mutations).
npm run capsule-preview:backfill:prod -- \
  --base-url https://atomdojo.pages.dev \
  --admin-secret CRON_SECRET \
  --dry-run --verbose

# Confirm the reported scan count matches the expected stale-row
# count from D1 AND that a `preview_backfill_run` audit row with
# details_json.dryRun === true appears in capsule_share_audit.

# Step 2 — real backfill.
npm run capsule-preview:backfill:prod -- \
  --base-url https://atomdojo.pages.dev \
  --admin-secret CRON_SECRET
```

CLI flags:

- `--base-url` — required. Pages origin of the target deployment.
- `--admin-secret <ENV_VAR>` — name of the process-env variable that
  carries the secret (default `CRON_SECRET`). The wrapper never
  accepts the secret as an inline argument.
- `--force` — rebake every row, including those already at the
  current rev. Operator escape hatch.
- `--page-size N` — override the library default (100).
- `--verbose` — forward the library's per-row success logs to the
  Cloudflare log stream.
- `--dry-run` — scan-only mode. The endpoint executes the SELECT
  loop but swaps the D1 UPDATE for a no-op, then emits a
  `preview_backfill_run` audit row with `details_json.dryRun: true`.

Exit codes: `0` on HTTP 200 + `summary.failed.length === 0`;
non-zero on any HTTP ≥ 400, any row failure, or a missing
admin-secret env var (pre-flight error — no fetch issued).

Audit severity mapping (see `AuditEventType` in
`src/share/audit.ts`):

- `info` — `summary.failed.length === 0`.
- `warning` — some rows failed but at least one updated.
- `critical` — pure failure (`updated === 0 && failed > 0`). The
  endpoint returns HTTP 500 in this case, and the wrapper exits
  non-zero.

**Local dev backfill** — `npm run capsule-preview:backfill:local`
(alias for `node scripts/backfill-local.mjs`). Reads/writes the
Miniflare sqlite under `.wrangler/state/v3/` directly and reads R2
blobs from the on-disk blobstore. Accepts `--force` with the same
semantics as the production script:

```bash
npm run capsule-preview:backfill:local            # rebake null + out-of-rev
npm run capsule-preview:backfill:local -- --force # rebake every row
```

### Rollout procedure for a thumb-algorithm change

When the publish-time thumb projection changes (new featurizer, new
sampling, etc.), the stored thumbs across D1 need to be rebaked. The
system is designed to ship the code change before the backfill
completes — existing rows just fall back to live sampling with a
`[scene-store] thumb-rev-stale` log line until they're updated.

1. Bump `CURRENT_THUMB_REV` in `src/share/capsule-preview-scene-store.ts`.
2. Deploy. New publishes write rows at the new rev immediately. Existing
   rows have their stored `thumb.rev` compared against `CURRENT_THUMB_REV`
   on every read; the mismatch is non-fatal (logs `[scene-store] thumb-rev-stale`
   and falls back to live sampling from the stored atoms array).
3. Run `npm run capsule-preview:backfill:prod` (without `--force`) —
   the rev predicate selects only stale rows, so this is the cheap
   path. Watch the emitted `preview_backfill_run` audit row's
   severity: `info` = clean, `warning` = partial success (re-run the
   same command; the failed rows are auto-reselected next pass),
   `critical` = pure failure (investigate before re-running).
4. **Post-backfill verification.** After the wrapper exits 0, query
   D1 to confirm zero stale rows remain:

   ```bash
   wrangler d1 execute atomdojo-capsules --remote --command \
     "SELECT COUNT(*) AS stale FROM capsule_share \
       WHERE kind = 'capsule' AND status = 'ready' AND \
         (preview_scene_v1 IS NULL \
          OR IFNULL(json_extract(preview_scene_v1, '\$.thumb.rev'), 0) < 15)"
   ```

   The `< 15` predicate must match the current `CURRENT_THUMB_REV`
   in `src/share/capsule-preview-scene-store.ts`; bump both in lockstep
   when the rev advances.

   Expected: `stale = 0`. Any non-zero residual is either (a) rows
   whose R2 blob is missing (orphan-sweeper pending), or (b) rows
   that `preview_backfill_run` flagged as `failed`. Inspect the
   `details_json` on the audit row for the invocation to confirm
   `scanned`, `updated`, and `failedCount` match.
5. Reload one known account page and confirm the affected rows now
   render their baked bonded thumb (not a sparse atoms-only
   fallback). The audit page's **Account-route parity** section
   under §4 shows the exact same code path — if the account row
   looks like the audit page's current-rev "Fresh" panel, the rollout
   has reached that row.
6. The `[scene-store] thumb-rev-stale` log rate should drop to zero
   once the backfill completes. A non-zero steady-state rate after
   that means some rows are failing to update (check `summary.failed`
   from the script) — usually because the R2 blob is missing for a
   row that never got cleaned up by the orphan sweeper.

`force: true` is only required when an algorithm change needs to
propagate to rows that already carry the new rev (e.g. an internal
bug in the v2 pipeline that shipped for some rows before being caught).

### Brand-string note

`'AtomDojo'` (no space) was removed from user-visible output paths.
The canonical brand string is `Atom Dojo`. If you see `AtomDojo` in
a poster body, file it — it indicates a regression in template copy.

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
| `account_delete` with `severity='critical'` | audit event | WARNING | At least one step in the account-deletion cascade failed. `ok:false` was returned to the user. See *Account-deletion cascade incident response*. Filter by `severity='critical'` to distinguish from the normal `severity='warning'` events emitted on clean cascades. |
| `[account.delete-failed]` | log tag | INFO / aggregate | Companion log for the above; carries the full `steps` map for quick grep. One-offs are normal (partial R2 failures self-heal via orphan sweep); a sustained rate indicates D1 or R2 trouble. |

All of the above signals are referenced in code:

- `src/share/rate-limit.ts` — quota accounting and audit calls
- `src/share/audit.ts` — event type enum
- `functions/api/capsules/publish.ts` — publish pipeline
- `functions/api/capsules/[code]/report.ts` — abuse reports
- `functions/api/admin/sweep/orphans.ts` — orphan sweep
- `functions/api/admin/sweep/audit.ts` — audit-retention sweeper
- `functions/api/account/delete.ts` — account-delete cascade

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

### Owner-delete vs moderation-delete (audit distinction)

Capsule deletions flow through the same `deleteCapsule` core in
`src/share/capsule-delete.ts` but fork at the audit-event layer:

- `event_type='owner_delete'` — the user deleted their own capsule via
  `DELETE /api/account/capsules/<code>` (or as part of an account-delete
  cascade, with `reason='account_delete_cascade'`).
- `event_type='moderation_delete'` — an admin deleted via
  `POST /api/admin/capsules/<code>/delete`; `reason` carries the
  operator-supplied moderation note and is PII-class (cleared after 180
  days by the audit-scrub sweeper).

When answering a user's "who deleted my capsule" question or preparing
a legal response, query with the event_type filter — do NOT rely on
`actor` alone, because the owner IS the actor for the cascade path.

```sql
SELECT event_type, actor, created_at, reason, details_json
FROM capsule_share_audit
WHERE share_code = ?
  AND event_type IN ('owner_delete','moderation_delete')
ORDER BY created_at ASC;
```

### Account-deletion cascade incident response

`POST /api/account/delete` is a 6-step cascade (sessions → quota →
capsules → capsules_rescan → oauth → user, plus a final `audit`
emission). The response shape is:

```json
{
  "ok": false,
  "capsuleCount": 3,
  "succeeded": 2,
  "failed": [{ "code": "abc123", "reason": "r2_failed: ..." }],
  "steps": {
    "sessions": "ok",
    "quota": "ok",
    "capsules": "partial: 1 failed",
    "capsules_rescan": "ok",
    "oauth": "ok",
    "user": "ok",
    "audit": "ok"
  }
}
```

`ok:false` means **at least one step's value is not `'ok'`** OR
`failed.length > 0`. Steps are independent — a later-step failure does
NOT undo earlier steps — so the cascade is always resumable by the
user re-hitting the endpoint (every step is idempotent).

Triage when a user reports `ok:false`:

1. Read the `steps` map. Any value other than `'ok'` is a verbatim
   error message from that step (`runStep` in `functions/api/account/delete.ts`).
2. Search for the log tag the handler emits on any failure:

   ```
   [account.delete-failed] user=<id> steps=... failed=<n>
   ```

3. If `steps.capsules` is `"partial: N failed"`, inspect
   `failed[].reason` — `r2_failed: …` means the D1 `capsule_share`
   row is already tombstoned but the R2 blob is still present; the
   daily orphan sweep will pick it up within 24h (the public endpoints
   already gate on `capsule_share.status`).
4. If `steps.user !== 'ok'`, the user row was NOT tombstoned. The
   client cookie is still valid. The user must re-hit the endpoint;
   any outstanding audit event will still be emitted on the retry.
5. The single `account_delete` audit event carries
   `details_json = { capsuleCount, succeeded, failed, steps }` and its
   severity is `critical` when any prior step failed (else `warning`
   — this event is never `info`). Query:

   ```sql
   SELECT created_at, severity, details_json
   FROM capsule_share_audit
   WHERE event_type = 'account_delete' AND actor = ?
   ORDER BY created_at DESC LIMIT 5;
   ```

**Tombstoned user that should not have been.** `users.deleted_at` is
the tombstone column. If a user complains they're suddenly signed out
and `/api/auth/session` returns `signed-out` for their re-login:

```sql
SELECT id, deleted_at FROM users WHERE id = ?;
SELECT event_type, severity, created_at, details_json
FROM capsule_share_audit
WHERE actor = ? AND event_type = 'account_delete'
ORDER BY created_at DESC LIMIT 1;
```

A non-null `deleted_at` paired with an `account_delete` event is a
legitimate self-service delete. A non-null `deleted_at` with NO
matching `account_delete` event is an incident — page immediately and
do NOT clear `deleted_at` without root-causing first. Manual recovery
(last resort, after RCA):

```sql
UPDATE users SET deleted_at = NULL WHERE id = ?;
-- Note: oauth_accounts + sessions were already DELETEd; the user
-- must re-OAuth. capsule_share rows tombstoned under
-- reason='account_delete_cascade' are NOT revived — that flip was
-- authoritative. Do not un-tombstone capsule_share manually without
-- confirming the user wants them live again.
```

### Age-gate / policy acceptance ops

`user_policy_acceptance` rows are written by
`POST /api/account/age-confirmation` (see
`functions/api/account/age-confirmation/index.ts`). Composite PK
`(user_id, policy_kind)` — every acceptance is an UPSERT that updates
`policy_version` + `accepted_at`. One `age_confirmation_recorded`
audit event is emitted per UPSERT (fire-and-forget; a failed audit
does NOT fail the request).

The publish endpoint returns **428 Precondition Required** with body
`{ error: 'age_confirmation_required', policyVersion, message }`
when the authenticated user has no `age_13_plus` row.

D120 update: this path is now a **legacy backstop**. New users have
the row written at OAuth callback time
(`functions/policy-acceptance.ts findOrCreateUserWithPolicyAcceptance`),
so the 428 here covers (a) accounts created before the
post-clickwrap callback write shipped and (b) any account state
created through an unexpected path. Expect this to fire for a
shrinking pre-deploy population.

The Lab Transfer dialog catches `AgeConfirmationRequiredError` and
renders the publish-clickwrap fallback (single Publish button — no
checkbox; clicking IS the consent). The button POSTs to
`/api/account/age-confirmation`, which calls the same
`recordAge13PlusAcceptance` helper as the OAuth callback. A user
stuck in a loop (repeated 428s after clicking Publish) is usually
a client cache / extension issue, but to unblock manually:

```sql
-- Confirm whether the row exists.
SELECT user_id, policy_version, accepted_at
FROM user_policy_acceptance
WHERE user_id = ? AND policy_kind = 'age_13_plus';
```

If the row is missing, either have the user retry the publish-clickwrap
fallback (preferred — it emits the audit event via
`recordAge13PlusAcceptance`), or insert the acceptance on
their behalf **only when you have a support ticket documenting their
confirmation**:

```sql
INSERT INTO user_policy_acceptance (user_id, policy_kind, policy_version, accepted_at)
VALUES (?, 'age_13_plus', '<current POLICY_VERSION>', datetime('now'))
ON CONFLICT(user_id, policy_kind)
  DO UPDATE SET policy_version = excluded.policy_version,
                accepted_at    = excluded.accepted_at;
```

`POLICY_VERSION` drift: the publish 428 only checks for the presence
of any `age_13_plus` row — it does NOT currently compare
`policy_version` against the live constant. An older stored
`policy_version` does not by itself re-block publish. If a future
change bumps the policy and the publish path grows a version check,
update this section.

### Audit retention sweeper

The audit scrub + delete-abuse-reports sweepers are cron-driven
weekly (see *Schedules*). To invoke manually (e.g. after a PII
incident that requires an earlier scrub):

```bash
# Scrub — NULL ip_hash, user_agent, and report/moderation `reason` on
# rows older than 180 days. Non-destructive: event skeleton survives.
curl -X POST "https://atomdojo.pages.dev/api/admin/sweep/audit?mode=scrub" \
  -H "X-Cron-Secret: $CRON_SECRET"

# Delete-abuse-reports — row-delete event_type='abuse_report' rows
# older than 180 days. Also row-deletes privacy_requests past 180d.
curl -X POST "https://atomdojo.pages.dev/api/admin/sweep/audit?mode=delete-abuse-reports" \
  -H "X-Cron-Secret: $CRON_SECRET"

# Optional override (min 7 days, hard-clamped to 10 years):
curl -X POST "https://atomdojo.pages.dev/api/admin/sweep/audit?mode=scrub&maxAgeDays=90" \
  -H "X-Cron-Secret: $CRON_SECRET"
```

Response shape:

```json
{ "ok": true, "ranAt": "...", "mode": "scrub",
  "maxAgeDays": 180, "scrubbed": 1234 }
// or for mode=delete-abuse-reports:
{ "ok": true, "ranAt": "...", "mode": "delete-abuse-reports",
  "maxAgeDays": 180, "deleted": 42 }
```

One `audit_swept` event is emitted per run (NOT per row — per-row
would self-inflate the audit table). `details_json` carries
`{ mode, maxAgeDays, scrubbed?, deleted? }`. Query the last run:

```sql
SELECT created_at, reason, details_json
FROM capsule_share_audit
WHERE event_type = 'audit_swept'
ORDER BY created_at DESC LIMIT 10;
```

**`warnings: ['audit_failed']` in the response.** The destructive
UPDATE/DELETE already ran; only the `audit_swept` event emission
failed (D1 write error). The data-class operation is complete and
safe, but the audit-log has a gap for that run. Action:

1. Grep `wrangler pages deployment tail` for
   `[admin.sweep.audit] audit_swept event write failed` to see the
   underlying D1 error.
2. If it's a transient D1 issue, re-invoke the sweep manually — the
   UPDATE/DELETE is effectively a no-op the second time (scrub
   filter excludes already-NULL rows; delete filter excludes
   already-deleted rows), but the `audit_swept` event will be
   re-attempted and likely land.
3. If D1 is healthy and the event keeps failing, check for a
   migration drift on `capsule_share_audit` (a column-type mismatch
   would surface here).

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
- `0004_capsule_delete_clears_body_metadata.sql` — moderation/owner delete
  clears body metadata at delete time (not just status flip).
- `0005_user_tombstone.sql` — adds `users.deleted_at` tombstone column for
  account-delete cascade.
- `0006_user_policy_acceptance.sql` — `user_policy_acceptance` table
  (composite PK `(user_id, policy_kind)`) for age-13+ clickwrap.
- `0007_privacy_requests.sql` — `privacy_requests` + `privacy_request_quota_window`
  tables for the `/privacy-request` channel.
- `0008_capsule_share_object_key_nullable.sql` — relaxes `object_key NOT NULL`
  so moderation/owner delete can NULL the R2 pointer in place.
- `0009_capsule_preview_scene_v1.sql` — adds nullable `capsule_share.preview_scene_v1 TEXT`
  column for the V2 capsule-preview poster pipeline. NULL for pre-V2 rows;
  populated by `scripts/backfill-preview-scenes.ts` or lazy-backfilled by
  the poster route on first miss. See *Capsule preview poster endpoint (V2)*
  above.

Remote application is automatic on deploy: `.github/workflows/deploy.yml`
runs `wrangler d1 migrations apply atomdojo-capsules --remote` right
before `pages deploy`. `wrangler` tracks applied migrations in a
`d1_migrations` table, so the step is idempotent — repeated runs are
cheap no-ops.

**Only add additive migrations to `migrations/`.** Destructive changes
(column drops, table drops, data-mutating statements) must NOT be
auto-applied in CI. For those, run them manually first via
`wrangler d1 execute atomdojo-capsules --remote --file=migrations/NNNN-destructive.sql`
against a staging DB, verify, then commit the migration file only after
production has been hand-applied and verified.

Manual remote apply (unblock CI or out-of-band schema changes):

```bash
wrangler d1 migrations apply atomdojo-capsules --remote
```

Apply to local dev (uses `--local` wrangler state):

```bash
npm run cf:d1:migrate
```

For a full local rehearsal that mirrors the production deploy pipeline
(`npm run build` → `npm run cf:d1:migrate` → `npx wrangler pages dev dist --port 8788`),
use the bundled launcher:

```bash
npm run app:serve             # full pipeline on :8788
npm run app:serve -- --skip-build --skip-migrate   # fastest inner-loop re-run
```

The script is a thin wrapper around the three commands above; see
`scripts/serve-app.sh --help` for port overrides and auto-open.

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

Session endpoint smoke test (signed-out, no cookie):

```bash
curl -i "https://atomdojo.pages.dev/api/auth/session"
# Expect HTTP/2 200, body {"status":"signed-out"},
# headers include Cache-Control: no-store, private / Vary: Cookie.
# A 401 here is a regression — see Auth session endpoint section.
```

Authenticated publish smoke test (requires a test user's session cookie
— use `__Host-atomdojo_session` for production, `atomdojo_session_dev`
only against a local HTTP dev server):

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

Capsule preview poster smoke test (use any accessible capsule code):

```bash
curl -I "https://atomdojo.pages.dev/api/capsules/<code>/preview/poster"
# Expect 200 with Content-Type: image/png, Access-Control-Allow-Origin: *,
# X-Content-Type-Options: nosniff, and a Cache-Control header matching
# one of the four tiers in the Capsule preview poster section above.
# A stored asset returns max-age=31536000, immutable; a dynamic render
# returns max-age=300, s-maxage=3600, stale-while-revalidate=86400 with
# an ETag of shape "v2-<8hex>" (FNV1a32 over [TEMPLATE_VERSION, scene.hash,
# sanitizedTitle, shareCode]; TEMPLATE_VERSION is currently 2).
#
# Then tail to confirm the structured log line:
wrangler pages deployment tail | grep '\[capsule-poster\]'
# Expect a single JSON line per request with code, mode, durationMs,
# status, and (on non-happy modes) cause.
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
- **Pages Function body-size limit:** publish is capped at 20 MB
  (`MAX_PUBLISH_BYTES` in `src/share/constants.ts`) and enforced in two
  layers by `functions/api/capsules/publish.ts` (fast-reject on
  `Content-Length`, plus authoritative size check after body read).
  Cloudflare's own request body limit is higher, but the Pages Functions
  CPU budget is tighter; capsules near 20 MB may still exceed CPU and
  return 500. If users report this, check `wrangler tail` for
  `Exceeded CPU` errors and consider compressing the capsule payload
  client-side. Note: a 413 returned by the endpoint carries the
  `payload_too_large` JSON envelope and an `X-Max-Publish-Bytes` header
  for the client to surface the current ceiling — do not hard-code the
  limit elsewhere; import from `src/share/constants.ts`.
- **Private R2 bucket is load-bearing.** All capsule reads go through
  Pages Functions which consult `capsule_share.status` first. Making the
  bucket public (even for a "debug" window) would allow deleted /
  moderated capsules to continue serving via direct R2 URLs.
- **Cron Worker free-tier ceiling:** the account can register up to 5 cron
  triggers on the free tier (paid: 250). The sweeper currently uses 4
  (sessions every 6h; orphans daily 03:30 UTC; audit-scrub Sun 04:15 UTC;
  audit-delete-abuse-reports Sun 04:45 UTC). Only one free-tier slot
  remains — adding another schedule requires either collapsing an
  existing trigger or moving the Worker to a paid plan.
- **Watch→Lab handoff is pure client-side.** The `localStorage` handoff
  payload (see *Client-side sentinels*) never crosses an origin boundary
  and never hits the Pages Functions or R2. It costs nothing on the
  backend and there is no server-side rate limit to tune. Seed content
  is hard-capped in source (`SEED_MAX_ATOMS=50_000`,
  `SEED_MAX_BONDS=100_000` in
  `src/watch-lab-handoff/watch-lab-handoff-shared.ts`); the per-token
  size ceiling at the atom cap is ~3 MB base64 (positions + velocities
  Float64 + color assignments + camera metadata). The only external
  capacity ceiling is the browser's per-origin `localStorage` quota
  (~5–10 MB); a 264-atom capsule frame is typically <500 KB, so budget
  is ample even with color + camera metadata. Quota-exceeded retry
  first sweeps prior `atomdojo.watchLabHandoff:*` entries (via the TTL
  sweep + `removeWatchToLabHandoff`) before surfacing the error banner
  — if users still see "Browser storage is full…" after that sweep, a
  non-atomdojo writer on the same origin is consuming quota.
- **Removed flags (watch out for stale URLs / bookmarks).** The
  `REMIX_CURRENT_FRAME_UI_ENABLED` build-time gate has been removed,
  and the `?e2eEnableRemixCurrentFrame=1` URL override no longer does
  anything. Neither is an error to pass — they're silently ignored —
  but user reports that reference either in triage notes predate the
  ship and should be re-verified against the current behavior before
  reproducing.

## Privacy contact channel — `/privacy-request`

The published privacy contact channel is the `/privacy-request` form
(Phase 7 Option B). Submissions land in the `privacy_requests` D1
table. There is no admin UI today; operators read and act on rows via
`wrangler d1 execute`.

**Triage queue:**

```
wrangler d1 execute atomdojo-capsules --remote --command \
  "SELECT id, datetime(created_at, 'unixepoch') AS at, request_type, \
          contact_value, substr(message, 1, 200) AS preview, status \
     FROM privacy_requests \
    WHERE status IN ('pending','in_progress') \
    ORDER BY created_at ASC LIMIT 50;"
```

**Read full message for one request:**

```
wrangler d1 execute atomdojo-capsules --remote --command \
  "SELECT message FROM privacy_requests WHERE id = '<uuid>';"
```

**Mark resolved (or rejected) after acting:**

```
wrangler d1 execute atomdojo-capsules --remote --command \
  "UPDATE privacy_requests \
      SET status = 'resolved', resolved_at = unixepoch(), \
          resolver_note = '<short note>' \
    WHERE id = '<uuid>';"
```

**Per-IP debug (when investigating abuse):**

```
wrangler d1 execute atomdojo-capsules --remote --command \
  "SELECT bucket_start, count FROM privacy_request_quota_window \
    WHERE ip_hash = '<hash>' ORDER BY bucket_start DESC;"
```

**Operator SLA:**

- Acknowledge within 5 business days.
- Resolve within the regulatory windows documented in `/privacy`
  (GDPR Art. 12(3): 30 days extendable to 90; CCPA: 45 days
  extendable to 90; under-13 remediation: 14 days).
- Rows are auto-deleted by the audit-retention sweeper 180 days
  after `resolved_at` (or `created_at` if never resolved).

**Acting on a deletion request through the existing endpoints:**

For a deletion request, the operator can authenticate-as the user
once their identity is verified, then invoke the existing
`POST /api/account/delete` endpoint. There is no separate admin
"delete this account" route — the user-facing endpoint is the
authoritative cascade and the operator path runs the same code.

## Pages-dev E2E lane

The default `npm run test:e2e` runs against `vite preview` (a static
file server) — fast, but cannot exercise Pages Functions. Before a
release that touches the auth/share/account API surface, run the
Pages-dev lane:

```
npm run test:e2e:pages-dev
```

This boots `wrangler pages dev dist` and runs the suite with
`baseURL=http://127.0.0.1:8788`. Specs in
`tests/e2e/pages-dev-flows.spec.ts` are gated to that lane and
exercise:

- `/api/privacy-request/nonce` issuance
- `/api/privacy-request` POST (success, missing nonce, message-too-long)
- Lab transfer dialog signed-out gating with the real
  `/api/auth/session` resolution path

Treated as a deployment-confidence layer — not wired to CI by default
(it would require wrangler in every CI runner). Run it locally before
tagging a release that touches account/, functions/api/account/*, or
functions/api/privacy-request.ts.

`playwright.config.ts` sets `retries: 1`, so a flake-retry is tried
once before a spec is marked failing. An operator investigating a
"transient but reproducible" Playwright failure from CI logs should
confirm the run exhausted the retry before treating it as flake —
the second attempt's output is what carries the actionable failure
trace.

Separately, internal build-gate unit tests (run as part of
`npm run test:unit` on every CI job) prevent dev-only surfaces from
shipping in the production bundle. A regression there surfaces as a
failing unit test before deploy — no operator action is required
unless the test starts failing, in which case the diff that introduced
the dev-only surface needs to be reverted or gated before re-deploy.
