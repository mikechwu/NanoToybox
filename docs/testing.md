# Testing & Validation

## Test Ladder

Tests are numbered in order of complexity. Earlier tests must pass before later tests are meaningful.

| Test | File | What it validates | Pass criteria |
|------|------|-------------------|---------------|
| 1 | `test_01_dimer.py` | 2-body pair forces | Energy continuity, F≈-dE/dr (<1e-3), NVE drift <1e-4 |
| 2 | `test_02_angular.py` | 3-body angular forces | Energy varies with angle, force consistency (<1e-3) |
| 3 | `test_03_graphene.py` | Many-body flat system | Bond length ~1.42±5%, NVE drift <1e-3, no collapse |
| 4 | `test_04_c60.py` | Full curved system | 90/90 bonds preserved, NVE drift <1e-3 |
| 5 | `test_05_static_validation.py` | 0K relaxation | All systems converge to Fmax <1e-3, structures stationary at 0K |
| 6 | `test_06_perturbation.py` | Near-equilibrium response | Energy increases on perturbation, oscillates back, no instability |
| 7 | `test_07_multiatom_forces.py` | Multi-atom force accuracy | Finite-diff on relaxed C60/graphene, max error <1e-3 |
| 8 | `test_08_data_loading.py` | ML data pipeline | NPY shapes correct, decomposition verified, no NaN |

## Running Tests

```bash
# Run individual test
python3 tests/test_01_dimer.py

# Run all tests sequentially
for t in tests/test_0*.py; do echo "=== $t ===" && python3 "$t" || echo "FAILED"; done
```

Each test prints PASS/FAIL and returns exit code 0 (pass) or 1 (fail).

## Test Details

### Test 1: 2-Atom Dimer
- Sweeps distance r across cutoff region
- Checks energy is zero beyond cutoff (continuity)
- Verifies F = -dE/dr via finite difference at 7 distances (ε=1e-5 Å)
- Runs 10,000-step NVE with small initial velocity
- **Key metric:** force relative error < 1e-3, NVE drift < 1e-4

### Test 2: 3-Atom Angular
- 3 atoms with variable angle θ (60°–180°)
- Verifies energy varies meaningfully (>0.01 eV range)
- Finite-difference force check at 5 angles, all 9 force components
- **Key metric:** force error < 1e-3, angular sensitivity confirmed

### Test 3: Small Graphene
- 18-atom graphene patch (3×3 cells)
- Thermalized at 50K, 5000-step NVE
- Checks average bond length within 5% of 1.42 Å
- **Key metric:** structural stability, NVE conservation

### Test 4: C60
- 60-atom Buckminsterfullerene
- Thermalized at 100K, 5000-step NVE
- Checks all 90 bonds preserved, radius of gyration stable
- **Key metric:** no bond breaking, NVE drift < 1e-3

### Test 5: Static Validation
- Relaxes dimer, triangle, graphene, C60 to 0K
- Reports residual forces (must be < 1e-3 eV/Å)
- Runs 0K stability check (100 steps, zero velocity → near-zero displacement)
- Saves relaxed structures

### Test 6: Perturbation
- Starts from relaxed structures
- Applies ±0.05 Å random perturbation
- Runs 500-step NVE, verifies sensible oscillation
- **Key metric:** energy increases on perturbation, no explosion

### Test 7: Multi-Atom Forces
- Finite-difference force check on **relaxed** C60 (180 components) and graphene (54 components)
- ε = 1e-5 Å, checks all atoms in all directions
- **Key metric:** max relative error < 1e-3

### Test 8: Data Loading
- Loads all datasets in `data/`
- Verifies NPY array shapes match metadata
- Confirms F_total = F_2body + F_residual to machine precision
- Checks train/val/test split validity

## Output Artifacts

Each test writes results to `outputs/testN_*/`:
- `energy.csv` — energy time series
- `trajectory.xyz` — atomic trajectories
- `energy_components.png` — energy plot (if matplotlib available)

## When to Run Tests

- After **any change** to `sim/potentials/tersoff.py` or `tersoff_fast.py`
- After changing `sim/integrators/velocity_verlet.py`
- After modifying `sim/minimizer.py`
- After modifying structure generators
- Before generating ML training data
- Before claiming any validation result

## Frontend Unit Tests

Automated unit tests live in `tests/unit/` and run via Vitest (`npm run test:unit`). Playwright E2E tests live in `tests/e2e/` and ship in two lanes:

- **Default lane (`npm run test:e2e`)** — `playwright.config.ts`, webServer is `vite preview`. Static assets + mocked `page.route()` specs. Pages-dev-only specs self-skip here.
- **Pages-dev lane (`npm run test:e2e:pages-dev`)** — `playwright.pages-dev.config.ts`, webServer is `wrangler pages dev dist`. Required for specs that hit real Pages Functions (auth, account, privacy). See [Pages-dev E2E lane](#pages-dev-e2e-lane).

Both Playwright configs set `retries: 1`. A handful of integration specs are timing-coupled — worker-stall detection, animation setup — and occasionally trip when the `vite preview` / `wrangler` webServer competes for CPU alongside the spec shard. One retry converts sporadic workerd / timing failures into successes without masking real regressions (a real regression fails both attempts). See the rationale comment at the top of `playwright.config.ts`.

*Per-section test counts below are approximate guides. Contributor-facing docs (contributing.md) omit exact counts entirely to avoid maintenance churn. Run `npx vitest run` for the authoritative total.*

```bash
# Run all unit tests
npx vitest run

# Run a single file
npx vitest run tests/unit/simulation-timeline.test.ts

# Default E2E lane (fast, mocked backend)
npm run test:e2e

# Pages-dev E2E lane (requires `npm run build` + wrangler)
npm run test:e2e:pages-dev
```

### Phase 5 Test Layout

Phase 5 introduced the Cloudflare-backed share/publish stack (Pages Functions + D1 + R2 + a cron Worker). The test surface is organized by ownership rather than by feature: pure shared modules, Workers-typed endpoint handlers, and end-to-end share flows each live in their own group with a tailored tsconfig and mocking pattern.

#### Share Stack Unit Tests (`tests/unit/`)

| Area | File(s) | Purpose |
|------|---------|---------|
| Share pure modules | `share-code.test.ts`, `share-record.test.ts`, `publish-core.test.ts` | Share-code encoding/decoding, publish-record preparation, and the pure publish-core pipeline. No mocks — uses real `crypto.subtle` / `crypto.randomUUID`. |
| Rate limit | `rate-limit.test.ts` | Covers the split quota API (`checkPublishQuota` + `consumePublishQuota`) plus an inline legacy `checkAndConsume` helper to guard the previous single-call shape. |
| Audit | `audit.test.ts` | Day-keyed counters, `hashIp` properties, and the `MAX_AUDIT_REASON_LENGTH` defensive-truncation path. |
| Pages Functions handlers | `admin-gate.test.ts`, `publish-endpoint.test.ts`, `report-endpoint.test.ts`, `admin-delete-endpoint.test.ts`, `admin-orphans-endpoint.test.ts`, `admin-sessions-endpoint.test.ts` | Handler-level tests for `functions/**`. Need Cloudflare Workers globals (`PagesFunction`, `R2Bucket`, `D1Database`) — typechecked under `tsconfig.functions.json`. |
| Cron Worker | `cron-sweeper.test.ts` | The scheduled Worker that sweeps expired/orphaned records. Shares the functions tsconfig for Workers types. |
| Lab publish UI | `timeline-bar-lifecycle.test.tsx` | Transfer dialog, tab availability, busy-guard, warnings pill — plus the Transfer-dialog performance contract (Share-default no-estimate, Download-tab JIT compute, tab-switch cancellation, one-compute-per-session cache, OAuth-resume pause, `scheduleAfterNextPaint` mock pattern) for the lab-side publish UX attached to the timeline bar. |
| Lab layout regression | `timeline-layout.spec.ts` (E2E) | Bounding-box checks for the restart anchor vs. action-zone geometry. Playwright, not Vitest. |

#### Share Stack E2E Tests (`tests/e2e/`)

| File | Purpose |
|------|---------|
| `watch-share.spec.ts` | 13 tests covering landing + top-bar share-code input, `?c=` bootstrap, pasted code/URL/grouped forms, error states, and state preservation across navigation. |
| `timeline-layout.spec.ts` | Action-zone + restart-anchor geometry regression (lab). |
| `fixtures/share-capsule.json` | Minimal valid capsule used to back `page.route()` mocks; must carry the current `bondPolicy: { policyId, cutoff, minDist }` shape. |

E2E specs intercept `/api/capsules/*` with `page.route()` because `vite preview` (the Playwright webServer) does not execute Pages Functions. See [E2E Strategy](#e2e-strategy-share-stack) below.

### Split tsconfig Model

Phase 5 tests ship across three tsconfigs because the frontend and the Pages Functions / cron Worker live in the same repo but compile against different lib sets.

| Config | What it covers | Why |
|--------|---------------|-----|
| `tsconfig.json` (frontend) | `lab/`, `watch/`, `account/**`, `src/**`, `tests/unit/**/*.{ts,tsx}`, `vite.config.ts` | DOM + React + Three.js. `account/**` is included under the frontend gate so the inline `CapsulePreviewThumb` component typechecks alongside the rest of the React surface. Excludes the Workers-typed backend-handler/middleware tests (the exclude list in `tsconfig.json` is authoritative) — including the new `poster-endpoint.test.ts` and `share-page-og.test.ts`, which import from `functions/**` and live under the functions tsconfig — because they import Workers-typed symbols that would fail the DOM-only typecheck. |
| `tsconfig.functions.json` (Workers) | `functions/**`, `functions/**/*.tsx`, `src/share/**`, `src/share/__fixtures__/*.json`, selected `src/history/*-v1.ts`, the Workers-typed test files (Phase 5/6 core: `admin-gate`, `publish-endpoint`, `report-endpoint`, `admin-delete-endpoint`, `admin-orphans-endpoint`, `admin-sessions-endpoint`, `auth-middleware`, `session-endpoint`, `cron-sweeper`; Phase 7 additions: `signed-intents`, `age-confirmation-endpoint`, `audit-sweep-endpoint`, `auth-start-age-intent`, `owner-delete-endpoint`, `publish-age-gate`, `account-delete-cascade`, `account-capsules-pagination`, `privacy-request-endpoint`; Capsule Preview additions: `poster-endpoint`, `share-page-og`, `account-api-preview-thumb`), `workers/cron-sweeper/src/**` | `strict: true`, `types: ["@cloudflare/workers-types"]`, plus Capsule Preview: `jsx: "react-jsx"`, `jsxImportSource: "react"`, `resolveJsonModule: true` (so the Satori-driven poster route under `functions/**/*.tsx` and the shared `src/share/__fixtures__/capsule-preview-frames.json` fixture compile under this config). Gives the handlers and the auth middleware real `PagesFunction`, `R2Bucket`, `D1Database`, `ExecutionContext` types. |
| `workers/cron-sweeper/tsconfig.json` | The cron Worker package itself | Worker has its own `wrangler.toml`/deploy pipeline; its tsconfig keeps deploy-time typechecking independent of the Pages build. |

The partitioning is enforced by `tsconfig.json`'s explicit `exclude` list — the Workers-typed tests are owned by the functions config, so they compile exactly once, under the lib set they actually need. The exclude list grew from 8 entries (Phase 5) → 10 (Phase 6, adding `auth-middleware` + `session-endpoint`) → 18 (Phase 7, adding the nine account-erasure / age-gate / signed-intent backend tests enumerated above), and has since grown further as Capsule Preview V2 + ADR D138 Lane A introduced more Workers-typed tests (`poster-endpoint`, `share-page-og`, `account-api-preview-thumb`, `admin-backfill-preview-scenes`, `backfill-stale-row-integration`, `policy-acceptance`, `oauth-state`, `auth-error-route`, `auth-callback-acceptance`). `tsconfig.json` is the authoritative source if this count drifts. Keep the list in sync whenever a new backend-handler test is introduced: the symptom of forgetting is a DOM-lib typecheck failure on Workers-typed symbols under `npm run typecheck:frontend`. Vitest still discovers and runs every file in `tests/unit/`; the split only affects `tsc`. `npm run typecheck` fans out across all three configs (frontend → functions → cron) so a Workers-typed test file will be typechecked even though `tsconfig.json` excludes it.

### Script Reference

| Script | Runs |
|--------|------|
| `npm run typecheck` | All three tsconfigs in sequence (frontend → functions → cron). |
| `npm run typecheck:frontend` | `tsc --noEmit` against `tsconfig.json` only. |
| `npm run typecheck:functions` | `tsc --noEmit -p tsconfig.functions.json`. |
| `npm run typecheck:cron` | `tsc --noEmit -p workers/cron-sweeper/tsconfig.json`. |
| `npm run test:unit` | `vitest run` — all Vitest files under `tests/unit/`. |
| `npm run test:e2e` | `playwright test` — all specs under `tests/e2e/` (default lane, `vite preview` webServer; Pages-dev-only specs self-skip here, see [Pages-dev E2E lane](#pages-dev-e2e-lane)). |
| `npm run test:e2e:pages-dev` | Phase 7 lane: `playwright test` against `playwright.pages-dev.config.ts`, which boots `wrangler pages dev dist`. Runs specs that require real Pages Functions (static policy routes, age-gate UX, account delete-all). Requires `npm run build` first. |
| `npm run build` | `vite build` — produces `dist/` consumed by `app:serve` / `cf:dev` / pages-dev E2E lane. |
| `npm run app:serve` | Canonical local-dev entrypoint: `npm run build → npm run cf:d1:migrate → npx wrangler pages dev dist --port 8788`. Use this when iterating on Lab or Watch — both depend on Pages Functions. Supports `--skip-build`, `--skip-migrate`, `--port`, `--open`. |
| `npm run cf:dev` | `wrangler pages dev dist` — full local backend with Functions + D1 + R2 bindings. Equivalent to the last step of `app:serve` when you do not need the build + migrate preflight. |
| `npm run dev` | `vite` dev server — frontend only, no Functions. Not sufficient for Lab (Lab shell boots against `/api/*` and `/auth/*`, which 404 under vite). |
| `npm run cf:d1:migrate` | Applies migrations to the local D1 (`atomdojo-capsules`). |
| `npm run cron:dev` / `cron:deploy` / `cron:tail` | Local/prod lifecycle for the cron-sweeper Worker. |
| `npm run seed:capsule` | Seeds a sample capsule into local R2/D1 for manual testing (defaults to `tests/e2e/fixtures/poster-smoke-capsule.json`). |

### Mock Patterns for Pages Functions Handlers

Handler tests share a small but consistent recipe. The goal is to exercise the real handler end-to-end (request parsing, auth, quota, audit, R2/D1 writes, response shaping) while keeping the collaborators swappable.

1. **Hoisted `vi.fn` mocks via `vi.hoisted()`** — every collaborator (auth, quota, audit, publish-core) is a hoisted function reference so `vi.mock()` can capture it before imports resolve. The pattern:

   ```ts
   const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
   vi.mock('../../src/share/auth-middleware', async () => {
     const actual = await vi.importActual<typeof import('../../src/share/auth-middleware')>(
       '../../src/share/auth-middleware',
     );
     return { ...actual, authenticateRequest: (...args: unknown[]) => authMock(...args) };
   });
   ```

   Each `beforeEach` resets the mock; tests call `authMock.mockResolvedValue(...)` to script the path under test.
2. **Mock D1 that implements the SQL dialect (not the method surface)** — the rate-limit and publish code use real SQL (`COALESCE(SUM(…))`, `IN (…)`, upserts, `LIMIT 1`). The mock D1 in these tests parses the prepared statement and returns dialect-correct results rather than stubbing by method name. This catches SQL-shape regressions that a `vi.fn().mockResolvedValue(...)` stub would miss.
3. **Minimal handler context constructed by hand** — tests build `context = { request, env, params }` directly (see the `makeContext()` helper pattern in `publish-endpoint.test.ts`) rather than reaching for a full `EventContext`. Handlers only read `.request` and `.env`, so the minimal shape is cast via `as unknown as Parameters<typeof onRequestPost>[0]`.
4. **Real `Request` objects** — `new Request('http://localhost/api/capsules/publish', { method, headers, body })` exercises the real Web Fetch API surface, avoiding header/method-parsing mocks.
5. **Workers types required** — because the handler signatures reference `PagesFunction`, `R2Bucket`, and `D1Database`, these files only typecheck under `tsconfig.functions.json` (see [Split tsconfig Model](#split-tsconfig-model)).

#### Reference Fixture Helpers (`publish-endpoint.test.ts`)

Two helpers in `tests/unit/publish-endpoint.test.ts` are the canonical templates for new endpoint tests:

- **`minimalValidCapsule()`** — the smallest JSON blob that passes `preparePublishRecord`. It pins:
  - `format: 'atomdojo-history'`, `version: 1`, `kind: 'capsule'`
  - A valid `producer`, `simulation.units`, `atoms`, and `timeline.denseFrames` with monotonic `timePs`
  - **`bondPolicy: { policyId, cutoff, minDist }`** — the current shape. Legacy `{ cutoff, minDist }` without `policyId` is rejected by the importer and will cause tests to fail.
- **`makePermissiveEnv()`** — returns `{ env, r2Puts, r2Deletes }`. The returned `env.DB` answers every prepared statement with `{ success: true }` / `null` / empty results, and `env.R2_BUCKET` captures `put`/`delete` calls into the returned arrays so tests can assert on the key names that were written. Use this when you want to focus on handler behavior (auth, quota, audit, response shape) rather than on D1 / R2 wire semantics.

New endpoint tests should prefer these helpers over ad-hoc fixtures so the expected-valid-shape invariant has a single owner.

### E2E Strategy: Share Stack {#e2e-strategy-share-stack}

Playwright's `webServer` runs `vite preview` against `dist/`, which serves static assets only — `functions/**` is **not** executed. To test the full watch-share UX without standing up `wrangler pages dev`, the specs intercept every `/api/capsules/**` request with `page.route()` and reply with a fixture-backed response:

```ts
await page.route('**/api/capsules/**', (route) => {
  // return the share-capsule fixture or a scripted error
});
```

Important fixture contract: `tests/e2e/fixtures/share-capsule.json` must use the current `bondPolicy: { policyId, cutoff, minDist }` shape. The legacy `{ cutoff, minDist }` form is rejected by the capsule importer and will break the watch flow under test. If you regenerate this fixture, preserve `policyId: 'default-carbon-v1'` (or the current default) alongside `cutoff` and `minDist`.

For tests that need the real backend (rare — typically manual verification, not CI), run `npm run build && npm run cf:dev` and point Playwright at `http://localhost:8788` instead of the `vite preview` default.

### Phase 6 Test Layout (Auth & Account UX)

Phase 6 layered a popup-first Google/GitHub OAuth flow, an account chip in the top bar, and a session/logout reconciliation loop on top of the Phase 5 share stack. The test surface follows the same partitioning as Phase 5: React + Zustand + auth-runtime tests sit under the frontend tsconfig, while the auth middleware and the `/api/auth/session` endpoint sit under the functions tsconfig so they can use Cloudflare Workers types.

#### Frontend Auth UX (`tests/unit/auth-ux.test.tsx`)

| File | Purpose |
|------|---------|
| `auth-ux.test.tsx` | ~100+ tests exercising the transfer dialog, `AccountControl`, `hydrateAuthSession`, `auth-runtime` popup flow, resume-publish intent, kind-tagged `shareError`, and `resetTransientState`. Runs under the frontend tsconfig (jsdom + React). |

Grouped by describe block:

- **Transfer dialog auth gating** — "Checking sign-in…" while loading; Google + GitHub buttons when signed out; Publish button when signed in; `onSignIn({ resumePublish: true })` wiring; default tab falls back to Download when Share is not wired.
- **AccountControl top bar** — renders nothing while loading; Sign-in trigger with Google + GitHub when signed out; account chip with display name + Sign out when signed in; truncated user id fallback when display name is null; plain disclosure pattern (trigger uses `aria-haspopup="true"` not `"menu"`, no `role=menu` / `role=menuitem` on signed-in / signed-out / unverified popovers).
- **`hydrateAuthSession`** — settles to signed-in on 200; cache:no-store + credentials:same-origin on the probe; settles to signed-out on 200 `{ status: signed-out }` (NOT 401); unexpected 401 treated as server error; preserves current session on network failure; first-load network failure or 5xx settles to unverified; malformed 200 settles to unverified; separates transport failure from body-parse failure in logs; drops late fetch writes when a newer authoritative state lands first (hydrate sequence-token race); returns a defensive copy.
- **`publishCapsule` Retry-After rendering** — numeric seconds → "try again in Ns."; HTTP-date / garbage / missing / zero / negative → generic copy; fractional seconds round up.
- **Unverified auth state** — neutral "Can't verify" note with Retry button (not OAuth prompt) in the transfer dialog; "Sign-in unknown" retry-only menu (no OAuth providers) in `AccountControl`.
- **Kind-tagged `shareError`** — 429 rate-limit messages are NOT rendered as an auth-note after an external signed-out flip (prevents 429-into-signed-out bleed); 401 recovery still surfaces the auth-note (auth-kind errors route into the signed-out branch). `shareError` is preserved when transitioning signed-in → signed-out (so the 401 recovery note survives), and cleared when transitioning signed-out → signed-in (prevents stale bleed).
- **Resume-publish intent** — `onSignIn({ resumePublish: true })` stores a structured JSON payload with `iat` + provider; no-resume invocation does NOT store a payload; `consumeResumePublishIntent` requires BOTH the `?authReturn=1` query marker and a fresh payload (within TTL), and returns false otherwise; malformed payload is cleaned up; `requestShareTabOpen` / `consumeShareTabOpen` one-shot flag semantics. Iat finiteness guard rejects NaN / Infinity / negative values, and the sentinel is still cleared when the marker is present even on rejection.
- **`onSignOut` reconciliation** — success flips to signed-out and schedules NO reconciliation; 5xx flips the UI to signed-out and then reconciles via `/session` after a delay; transport failure schedules reconciliation.
- **`AuthState` narrow helpers** — `setAuthLoading` / `setAuthSignedIn` / `setAuthSignedOut` / `setAuthUnverified` enforce the `(status, session)` invariant.
- **`resetTransientState`** — clears `authPopupBlocked` and `shareTabOpenRequested` one-shot flags; preserves `auth.status` / `auth.session` identity across the reset (including the signed-out identity, not re-initialized to loading).
- **401 recovery** — on `AuthRequiredError` from publish, session is nulled and the prompt re-renders with the inline note.
- **`TopRightControls` layout (jsdom)** — `AccountControl` and `FPSDisplay` sit inside a single `.topbar-right` container; long display names don't spill out; the account menu uses `.account-control` as its positioning ancestor.
- **`auth-runtime` popup OAuth flow** — `window.open` is tried first and there is NO silent fallback to `location.assign`; popup-blocked sets `authPopupBlocked` on the store and does NOT navigate; each retry tries `window.open` fresh (no sticky hint); `onSignInSameTab` commits the destructive redirect for the pending descriptor, and is a no-op when there is no pending descriptor; successful popup on retry clears the popup-blocked flag.
- **postMessage + BroadcastChannel handler** — same-origin postMessage triggers hydrate + opens Share tab when resume intent was set; cross-origin and malformed payloads are ignored; stale intents (>TTL) do NOT auto-open Share.
- **Popup-blocked Retry / Continue-in-tab / Back prompts** (both transfer dialog and `AccountControl`) — Retry re-invokes `onSignIn` with the pending descriptor; Continue-in-tab invokes `onSignInSameTab`; Back invokes `onDismissPopupBlocked` and restores the provider picker; popup-blocked copy names the blocked provider. Publish-initiated Back clears the `sessionStorage` resume-publish sentinel; top-bar (non-publish) Back leaves it untouched; an end-to-end scenario verifies Share does NOT auto-open after an unrelated top-bar sign-in that followed a dismissed publish-block.
- **Onboarding sessionStorage dismissal** — `markOnboardingDismissed` writes the session sentinel; `isOnboardingEligible` returns false when the sentinel is set; eligibility returns to true after sessionStorage is cleared (full browser restart analogue); `markOnboardingDismissed` logs a warning when `sessionStorage.setItem` throws (private browsing).
- **Vite dev-host guard** — `http://localhost:5173` (Vite dev) skips `window.open` and sets `authPopupBlocked` directly; `http://localhost:8788` (wrangler pages dev) DOES attempt `window.open`; production HTTPS DOES attempt `window.open`.
- **`detachAuthCompleteListener` singleton semantics** — a second attach returns the SAME detach reference as the first; detach truly removes the listener (subsequent postMessage fires no handler); a cross-origin postMessage on a Vite dev host logs a dev diagnostic.
- **Resilience under store / storage failures** — the message handler catches errors from `handleAuthComplete` (no unhandled rejection); `onDismissPopupBlocked` logs an error if `sessionStorage.removeItem` silently fails.
- **popup-complete HTML contract** — the popup-complete document includes `postMessage`, a `BroadcastChannel` fallback, a stuck-state DOM, and a strict CSP.

#### Auth Middleware (`tests/unit/auth-middleware.test.ts`)

| File | Purpose |
|------|---------|
| `auth-middleware.test.ts` | New in Phase 6. Orphan-session LEFT JOIN behavior, `hasSessionCookie` protocol scoping, orphan DELETE dedupe + logging. Runs under `tsconfig.functions.json` for Workers types. |

- **`authenticateRequest` orphan-session handling** — returns userId for a valid session whose user row still exists; returns null AND deletes the orphan session when the user row is missing; returns null when the session row itself is missing (no DELETE side effect); returns null for expired session (`expires_at` past), idle-expired session (`last_seen_at > 30d`), missing Cookie header, or Cookie header without the session cookie.
- **`hasSessionCookie` protocol scoping** — `https + __Host-atomdojo_session` → true; `http://localhost + atomdojo_session_dev` → true; https + dev-cookie only → false (wrong cookie for protocol); http + `__Host-` cookie only → false (wrong cookie for protocol); missing Cookie header or Cookie present without session cookie → false.
- **Orphan DELETE dedupe + logging (H5)** — logs with the `[auth.orphan-delete-failed]` prefix when DELETE fails; dedupes the DELETE for the same orphan sessionId within one isolate lifetime.

#### Session Endpoint (`tests/unit/session-endpoint.test.ts`)

| File | Purpose |
|------|---------|
| `session-endpoint.test.ts` | New in Phase 6. `GET /api/auth/session` response contract: anti-cache headers, signed-in / signed-out payload shape, opportunistic `Set-Cookie` clear on stale cookie, dev-cookie variant, user-row-missing race guard and logging. Runs under `tsconfig.functions.json`. |

- **Response contract** — always sets no-cache headers; signed-in returns 200 with user fields and NO `Set-Cookie`; signed-out with a stale session cookie returns 200 + `Set-Cookie` that clears it; signed-out WITHOUT any session cookie returns 200 and NO `Set-Cookie`; signed-out with a non-session cookie only returns 200 and NO `Set-Cookie`.
- **User-row-missing race guard** — authenticated userId but missing user row returns 200 signed-out + cookie-clear; the branch logs with the `[auth.session.user-missing]` prefix (M1).
- **Dev-cookie variant** — HTTP + stale `atomdojo_session_dev` cookie: signed-out + `Set-Cookie` clears the dev cookie; HTTP + only `__Host-` cookie (wrong protocol for it): no self-heal fires.

#### Top-Right Layout E2E (`tests/e2e/topbar-right-layout.spec.ts`)

| File | Tests | What it validates |
|------|------:|-------------------|
| `topbar-right-layout.spec.ts` | 4 | Playwright geometry regression for the top-right flex container under signed-in, long-display-name, signed-out, and mobile viewport scenarios. |

- **Signed-in** — account chip and FPS display sit inside one `.topbar-right` container and do not overlap.
- **Long display name** — truncates via ellipsis; chip and FPS do not collide.
- **Signed-out** — "Sign in" trigger renders inside `.topbar-right`; the opened menu stays inside the viewport.
- **Mobile viewport** — chip and FPS remain disjoint and inside the viewport.

### Phase 7 Test Layout (Account-Erasure Surface)

Phase 7 added the account-lifecycle / account-erasure surface: signed intents (HMAC + freshness + kind), a shared capsule-delete core used by both admin and owner paths, age confirmation, audit sweeps, the publish-time age precondition, cascaded account deletion, paginated capsule enumeration, and the privacy-request intake endpoint. Backend handlers follow the same tsconfig/mocking pattern as Phase 5/6 (hoisted `vi.fn`, SQL-dialect D1 mock, hand-built minimal context, real `Request` objects) and are typechecked under `tsconfig.functions.json`; the UI tests sit under the frontend tsconfig (jsdom + React + fetch stubs). A new Pages-dev-only E2E lane runs specs that need real Pages Functions.

#### Account-Erasure Unit Tests (`tests/unit/`)

| File | Purpose |
|------|---------|
| `signed-intents.test.ts` | HMAC signing + freshness window + kind-mismatch rejection for the signed-intent helper used by age-gate and privacy flows. Typechecked under functions tsconfig. |
| `capsule-delete-core.test.ts` | Shared delete core: admin-actor vs owner-actor branches, R2-failure rollback, idempotent retry semantics, `object_key` set to NULL on success. |
| `owner-delete-endpoint.test.ts` | Owner `DELETE /api/account/capsules/:code` returns 404 on cross-user access (no existence disclosure). Typechecked under functions tsconfig. |
| `age-confirmation-endpoint.test.ts` | `POST /api/account/age-confirmation` UPSERT idempotency and the body-`user_id` vs session-`user_id` contract. Typechecked under functions tsconfig. |
| `audit-sweep-endpoint.test.ts` | `audit-sweep` scrub mode vs delete-abuse-reports mode. Typechecked under functions tsconfig. |
| `publish-age-gate.test.ts` | Publish endpoint returns `428 Precondition Required` when the caller has not accepted the current age policy (point-read against `user_policy_acceptance`). Typechecked under functions tsconfig. |
| `auth-start-age-intent.test.ts` | `ageIntent` enforcement inside `functions/auth/{google,github}/start.ts`. Typechecked under functions tsconfig. |
| `account-delete-cascade.test.ts` | Cascade order, partial-failure behavior, and the rule that an audit-log failure folds into `ok:false` rather than being silently swallowed. Typechecked under functions tsconfig. |
| `account-capsules-pagination.test.ts` | Paginated capsule listing: cursor base64url encoding/decoding round-trip with correct padding. Typechecked under functions tsconfig. |
| `account-delete-all-loop.test.tsx` | Bulk delete-all client loop: cap-hit reporting, per-item failure surfacing (jsdom + fetch stub). Runs under frontend tsconfig. |
| `policy-acceptance.test.ts` | D120 — covers `recordAge13PlusAcceptance` (UPSERT + best-effort audit) and the four-branch matrix of `findOrCreateUserWithPolicyAcceptance` (marker absent / present × new / existing account). Includes the atomicity guard (induced batch failure leaves no partially-committed rows). Typechecked under functions tsconfig. |
| `oauth-state.test.ts` | D120 — sign + verify round-trip for the new `age13PlusConfirmed` and `agePolicyVersion` payload fields, backward-compat for in-flight pre-deploy state, and HMAC tampering rejection. Typechecked under functions tsconfig. |
| `auth-error-route.test.ts` | D120 — `/auth/error` landing page contract: 200, `Cache-Control: no-store`, whitelisted `reason`/`provider` query params, no raw-input reflection (XSS guard). Typechecked under functions tsconfig. |
| `privacy-request-endpoint.test.ts` | 13 cases over `POST /api/privacy-request`: full request-body validation + the signed-nonce contract. Typechecked under functions tsconfig. |

Existing fixtures updated for Phase 7 (called out because a fresh contributor will trip over them):

- `publish-endpoint.test.ts` — the `makeContext()` mock D1 returns `{ok: 1}` only when the prepared statement references `user_policy_acceptance`, so the publish endpoint's age-gate point-read passes through without having to re-stub the whole D1 mock.
- `admin-delete-endpoint.test.ts` — fixtures gained a `share_code` column because the shared delete core reads it.
- `auth-ux.test.tsx` — D120: assertions cover the clickwrap rendering + JIT fetch + `authSignInAttempt` store state. The `age-gate-checkbox-refresh.test.tsx` file was deleted (the AgeGateCheckbox component is gone; the JIT fetch removes the refresh-interval/stale-token machinery the deleted test guarded).

#### Account-Erasure E2E Specs (`tests/e2e/`)

| File | Lane | Purpose |
|------|------|---------|
| `policy-routes.spec.ts` | static (default `vite preview`) | 5 tests + 1 skipped over the static policy routes served under `/legal/**` / privacy / terms. Does not need Pages Functions. |
| `pages-dev-flows.spec.ts` | **Pages-dev-only** | Account-erasure happy paths that need real Pages Functions: age-gate bootstrap, signed-intent round-trip, delete-all loop against the dev backend. Self-skipped outside the `pages-dev` Playwright project (see below). |

#### Pages-dev E2E Lane {#pages-dev-e2e-lane}

Phase 7 introduced a second Playwright config — **`playwright.pages-dev.config.ts`** — for specs that require real Pages Functions (D1, R2, Workers bindings). The default `playwright.config.ts` boots `vite preview`, which serves static assets only; that is fine for mocked `page.route()` specs but cannot exercise `/api/auth/*`, `/api/account/*`, or `/api/privacy-request`.

**How the gating works.** Specs that target the pages-dev lane guard themselves inside a `test.beforeEach` hook:

```ts
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'pages-dev', 'Requires wrangler pages dev');
});
```

That means `pages-dev-flows.spec.ts` and `poster-smoke.spec.ts` are harmless to `npm run test:e2e` (both self-skip under the default project name) but become live under `npm run test:e2e:pages-dev`, whose config defines a project named `pages-dev`. See [Capsule Preview V2 Test Layout](#capsule-preview-v2-test-layout) for the poster-smoke probe breakdown and the `--binding DEV_ADMIN_ENABLED=true` env detail.

**Prerequisites.**

- Run `npm run build` first so `dist/` is fresh — `playwright.pages-dev.config.ts`'s `webServer` runs `wrangler pages dev dist`, not `vite dev`.
- Local D1 must already be migrated (`npm run cf:d1:migrate`).
- `wrangler` must be on `PATH` and logged in for the bindings the config references; missing bindings will surface as startup failures from the webServer, not as spec failures.

**When to run it.**

- Before merging any change that touches `functions/auth/**`, `functions/account/**`, `functions/privacy-request/**`, the signed-intent helper, or the shared capsule-delete core.
- Before merging changes to age-gate UX that depend on real `/api/account/age-confirmation` responses (mocked `page.route()` is not sufficient — the signed-nonce round-trip must hit the real endpoint).
- Not required for pure lab/watch UI changes; the default lane remains the fast feedback loop for those.

### Capsule Preview V2 Test Layout

Capsule Preview V2 replaced the V1 descriptor/figure builder with a scene-based pipeline: `buildPreviewSceneFromCapsule` extracts a `PreviewScene` directly from stored frames, `projectCapsuleToSceneJson` bakes it into a storable `preview_scene_v1` payload, and `derivePreviewThumbV1` projects that payload into the `PreviewThumbV1` the account list + share card consume. The title sanitizer survives unchanged. The OG-image route still lives under `functions/`, now keyed by a scene-hash ETag (`"v2-<8hex>"`). Backend routes still follow the Phase 5/6/7 mocking pattern (hoisted `vi.fn`, real `Request` objects, hand-built minimal context); the pure V2 modules and the inline `CapsulePreviewThumb` sit under the frontend tsconfig (jsdom). The deterministic-poster smoke still runs on the pages-dev Playwright lane with its ETag regex broadened to `^"v\d+-[0-9a-f]{8}"$`.

#### V1 → V2 Disposition

| Test file | V1 → V2 |
|-----------|---------|
| `capsule-preview.test.ts` | **Deleted** (V1 descriptor builder gone) |
| `capsule-preview-figure.test.ts` | **Deleted** (V1 synthetic figure gone) |
| `capsule-preview-sanitize.test.ts` | **Kept** unchanged — title sanitizer still load-bearing |
| `capsule-preview-frame.test.ts` | **New** — `buildPreviewSceneFromCapsule` extraction, color resolution, bounds, `PreviewSceneBuildException` kinds |
| `capsule-preview-colors.test.ts` | **New** — CPK fallback, per-group fan-out, malformed-assignment tolerance |
| `capsule-preview-camera.test.ts` | **New** — PCA classification {spherical, planar, linear, general, degenerate}, sign normalization, determinism |
| `capsule-preview-project.test.ts` | **New** — fit-to-bounds, depth sort, `deriveBondPairs` edge cases |
| `capsule-preview-sampling.test.ts` | **New** — `sampleEvenly`, `sampleForSilhouette` (extrema + FPS, small-target correctness), `sampleForBondedThumb` (graph-aware BFS) |
| `capsule-preview-scene-store.test.ts` | **New** — serialize/parse round-trip, `sceneHash`, `derivePreviewThumbV1` (stored-thumb fast path, bonds-aware gate at `BONDS_AWARE_SOURCE_THRESHOLD=14`, refit glyph-aware fill, atoms-only fallback, per-atom degree cap, visibility filter, Tier 1/Tier 2 policy) |
| `capsule-preview-dense-outcomes.test.ts` | **New** — synthetic graphene/CNT/fullerene/crystal fixtures; asserts majority produce bonded thumbs |
| `capsule-preview-pipeline.test.ts` | **New** — full pipeline: real C60 / graphene / CNT capsules through `projectCapsuleToSceneJson → derivePreviewThumbV1`; stored thumb at `CURRENT_THUMB_REV`, visible bonds, distinct geometry |
| `account-api-preview-thumb.test.ts` | **New** — account list hot-path: no R2 reads, bonds stripped for sparse scenes, dense-with-long-bonds fixture produces bonded thumb, null for malformed `preview_scene_v1` (functions tsconfig) |
| `poster-endpoint.test.ts` | **Rewritten** — scene-hash-bound ETag `"v2-<8hex>"`, lazy-backfill path, new `cause:` taxonomy (`scene-missing`, `capsule-parse-failed`, `no-dense-frames`, …); `__setRendererForTesting` seam preserved |
| `share-page-og.test.ts` | **Rewritten** — `?v=t2` cache key + `preview_scene_v1: null` field added to row fixture; og:image flag on/off, 404 paths, alt-text construction preserved |
| `account-capsule-row.test.tsx` | **Rewritten** — `CapsulePreviewThumb({thumb})` consumes `PreviewThumbV1` verbatim; atoms-only and bonds-aware regimes (atoms re-enabled — the atoms-only, visual-distinctiveness, and renderer/derivation-coupling describe blocks are all live, not skipped); `PlaceholderThumb` for null; renderer/derivation coupling locks (atom radius ≤ 2.8 in bonded mode, etc.). Also pins the three-stroke cylinder-bond structure: each bond is a `<g data-role="bond-pair">` wrapping `<line data-role="bond-edge">` + `<line data-role="bond-body">` + `<line data-role="bond-highlight">` in that paint order, with decreasing stroke widths. DOM-cost bound is **≤ 150 elements** for 24 atoms + 24 bonds (3 lines per bond + `<g>` wrapper pushed the cap from the old 120 after the cylinder-rendering refactor). The former "bucket quantization" atom-radius test is gone — it is replaced by a "perspective cue as ±15% multiplier" test that uses stored per-atom `r` as a relative scalar clamped to `[0.85×, 1.15×]` around the bond-length-derived base. |
| `share-record.test.ts` | **Rewritten** — `preview_scene_v1` field added to `CapsuleShareRow` |
| `publish-core.test.ts` | **Rewritten** — asserts `previewSceneV1Json` non-null on valid capsules, determinism |
| `poster-smoke.spec.ts` (E2E) | **Updated** — ETag regex broadened to `^"v\d+-[0-9a-f]{8}"$` (matches V2's `v2-…`); seeds a dimer capsule |
| `capsule-preview-sketch.test.ts` | **New** — unit coverage for the unified sketch renderer (`src/share/capsule-preview-sketch.ts`): three scene adapters, primitives builder in both `flat`/`cpk` modes and depth-aware / depth-free paths, `renderPreviewSketchSvgString` output, `renderPreviewSketchSvgNode` contract (React `isValidElement` + `renderToStaticMarkup` round-trip), stored-scene adapter round-trip, and an adversarial 3-atom case for `deriveBondPairsForProjectedScene` index-drift safety. |
| `capsule-preview-audit-metrics.test.ts` | **New** — deterministic render-quality assertions turned into numerical CI gates: C60 cage coherence (convex-hull fill + centroid-distance stddev), graphene planar spread (covariance eigenvalue ratio + bond-length uniformity), CNT tube aspect ratio, thumb-preset scale-down retention, and dense-noisy fallback guard. |
| `capsule-preview-poster-figure.test.ts` | **New** — poster-preset figure invariants across structural and mixed-element fixtures: bond presence, atom/bond layering order, pane-occupancy band (dominant-axis fill ≥ 60% + edge-clipping guard), CPK color preservation, and a "no ghost edges" endpoint check. |
| `current-thumb-ink-sync.test.ts` | **New** — parses the light-scope `--color-text` token in `public/account-layout.css` and asserts it matches the `CURRENT_THUMB_DEFAULT_INK` constant in `src/share/capsule-preview-current-thumb.tsx` (with hex normalization). CI-enforced mirror contract: editing either side without updating the other fails this test. |
| `capsule-preview-cluster-select.test.ts` | **New** (D138) — selector library: single dominant cluster, equal-size guard rejection, water-style fragmentation rejection, deterministic tie-break via `minAtomId`, defensive duplicate-atomId `minSourceIndex` fallback, zero-bond short-circuit (spies `computeConnectedComponents`), `mode: 'full-frame'` opt-out, bounds recompute, index remap, per-atom field preservation, and the close-approach proximity-fusion contract (exact diagnostics asserted at two cutoffs). Uses three new fixtures: `makeFragmentedCapsule`, `makeTwoEqualFragmentsCapsule`, `makeCloseApproachCapsule`. `capsule-preview-poster-figure.test.ts` now also asserts the close-approach proximity-fusion contract end-to-end through `projectCapsuleToSceneJson`. |
| `admin-backfill-preview-scenes.test.ts` | **New** (Lane A) — lives under `tsconfig.functions.json` with the other admin-endpoint tests. Covers: admin-gate denial → 404, cron-secret pass-through → library call with the forwarded flags, success returns `BackfillSummary` (200), partial-failure stays 200 with `warning` audit severity, pure-failure returns 500 with `critical` severity, and the `preview_backfill_run` audit-event contract (eventType, severity mapping, `details_json` shape). |
| `backfill-prod-wrapper.test.ts` | **New** (Lane A) — plain Node unit test covering the `.mjs` wrapper's contract with mocked `globalThis.fetch`: header shape (`X-Cron-Secret`, `Content-Type`), body shape (`force`, `pageSize`, `verbose`, `dryRun`), non-zero exit on HTTP ≥ 400, non-zero exit on `summary.failed.length > 0`, zero exit on clean success, and the pre-flight error when the admin-secret env var is missing. |
| `backfill-stale-row-integration.test.ts` | **New** (Lane A) — end-to-end integration against the admin endpoint + library + account-derivation chain. Seeds a simulated D1 row with an embedded `rev: 2` thumb, asserts `deriveAccountThumb` ignores the stale embedded thumb and live-samples via the scene-store fallback (fires `thumb-rev-stale`), invokes `onRequestPost` from `functions/api/admin/backfill-preview-scenes.ts`, and asserts the row's stored `preview_scene_v1.thumb.rev` now equals `CURRENT_THUMB_REV` with the bonded thumb on the fast path. Typechecked under functions tsconfig. |
| `capsule-preview-c60-recognizability.test.ts` | **New** — recognizability floor for the C60 cage under the shipped thumb pipeline (96 px, 48/48 caps): `deriveAccountThumb` returns a bonded thumb, bond count well above the legacy 6-bond floor, bonded subgraph is a single connected component, atom coverage spans broadly in both axes, and a meaningful fraction of sampled atoms carry at least one bond. Guards against the "scattered dots" regression the original data-shape tests missed. |
| `capsule-preview-perspective-bake.test.ts` | **New** — perspective-bake invariants for Path A (publish-time pinhole): stored per-atom `rMin / rMax` equals the theoretical `K / (K+1) = 0.6` at `PERSPECTIVE_K_DEFAULT = 1.5`; `projectPreviewScenePerspective` and the audit-page `renderPerspectiveSketch` resolve the SAME camera on the same scene (both go through `deriveMinorAxisCamera`), verified via per-atom depth-order equivalence; and the orthographic poster path still produces uniform atom radii (no perspective bleed into the 1200×630 OG poster). |
| `capsule-preview-audit-account-parity.test.ts` | **New** (ADR D138 follow-up) — locks the contract that the preview-audit page and the account route both derive thumbs through `deriveAccountThumb` (`src/share/capsule-preview-account-derive.ts`). Asserts byte-equivalence between audit and account output on (a) a fresh rev-CURRENT row with embedded thumb (stored-thumb fast path) and (b) a stale row with the embedded thumb dropped (live-sampling fallback), plus the invariant that fresh and stale output differ so reviewers can distinguish "needs backfill" from "current". Runs over C60 and graphene fixtures. |
| `preview-audit-production-exclusion.test.ts` | **New** — production-exclusion guard for the preview-audit dev workbench. Runs the real `vite build` programmatically (with `PREVIEW_AUDIT_BUILD` explicitly unset) into a scoped tmp outDir and asserts (a) no Rollup chunk/asset `fileName` contains `preview-audit`, (b) no chunk's `facadeModuleId` or imported modules trace back to `preview-audit/`, (c) recursive walk of `outDir` finds no `preview-audit`-named files, and (d) the legacy filesystem heuristics (no `preview-audit/` folder, no `preview-audit.html`, no `preview-audit-*` asset chunk) still hold. Mirrors the two-layer gate: `vite.config.ts` only registers the Rollup input when `command === 'serve' || PREVIEW_AUDIT_BUILD === '1'`, and `preview-audit/main.tsx` throws on `import.meta.env.PROD` as defence-in-depth. |
| `current-thumb-render.test.tsx` | **New** — render-level gate for `CurrentThumbSvg` at the shipped `ACCOUNT_THUMB_SIZE`. SSR-renders the shared fixture helper, snapshots the SVG markup per named fixture (`c60`, `graphene`, `glycine`), and as a `beforeAll` side effect writes one static HTML harness per fixture to `tests/e2e/fixtures/thumb-visual/{c60,graphene,glycine}.html` so the Playwright `thumb-visual.spec.ts` visual-regression suite can reload it byte-for-byte. Locks the shipped visual grammar (EXPERIMENTAL preset: `<defs>` + `<radialGradient>`, three-stroke cylinder-bond paint order `data-role="bond-edge"` → `"bond-body"` → `"bond-highlight"` asserted via `indexOf` ordering), the viewBox, the shipped width/height, and the "C60 at raised caps" shape invariants (≥36 atoms, ≥30 bonds). |

Shared fixtures under `src/share/__fixtures__/`:

- `capsule-preview-frames.json` — raw projected-scene fixture JSON consumed by the pure scene-extraction / pipeline tests. Replaces the V1 `capsule-preview-inputs.json`.
- `capsule-preview-structures.ts` — deterministic capsule fixture builders (`makeC60Capsule`, `makeGrapheneCapsule`, `makeCntCapsule`, `makeSparseSmallCapsule`, `makeDenseNoisyCapsule`, `makeWaterClusterCapsule`, `makeOxidePatchCapsule`, `makeSimpleOrganicCapsule`, `makeFragmentedCapsule`, `makeTwoEqualFragmentsCapsule`, `makeCloseApproachCapsule`). Single source of truth consumed by pipeline tests, dense-outcome tests, audit-metrics / poster-figure / recognizability tests, and the preview-audit dev workbench. Every builder uses fixed inputs — byte-equal output every call.
- `thumb-visual-fixtures.tsx` — shared fixture renderer backing BOTH the vitest snapshot gate (`tests/unit/current-thumb-render.test.tsx`) and the Playwright visual-regression harness (`tests/e2e/thumb-visual.spec.ts`). Exports `NAMED_CAPSULE_FIXTURES` (`c60`, `graphene`, `glycine`) plus `renderFixtureThumbSvg`, `buildThumbHtmlHarness`, and `thumbForFixture`. The vitest pass SSR-renders the SVG and writes one HTML harness per fixture to `tests/e2e/fixtures/thumb-visual/{c60,graphene,glycine}.html` so the Playwright spec can navigate via `file://` without depending on React, react-dom/server, or Vitest's snapshot format at runtime.

Tsconfig residency: the pure V2 modules (`capsule-preview-{frame,colors,camera,project,sampling,scene-store,dense-outcomes,pipeline}.test.ts`) share frontend infrastructure (React, DOM, Three math types) and stay under `tsconfig.json` (frontend). `account-api-preview-thumb.test.ts`, `poster-endpoint.test.ts`, and `share-page-og.test.ts` remain Workers-typed and live under `tsconfig.functions.json`.

#### Outcome-Level vs Contract-Level Coverage

V2 introduces **pipeline-path / outcome-level** assertions alongside the per-module contract tests. These catch product regressions that contract tests cannot — a test can prove `derivePreviewThumbV1` returns a well-typed payload while the end-to-end pipeline silently drops every bond. Load-bearing outcome assertions:

- `capsule-preview-pipeline.test.ts` — "derived thumbs for dense fixtures carry bonds with visible segments": real C60 must produce ≥2 visible bonds after the full publish → derive pipeline.
- `capsule-preview-scene-store.test.ts` — "refit stretches a shrunken storage layout to fill the thumb (glyph-aware)": guards against margin over-reservation.
- `capsule-preview-dense-outcomes.test.ts` — synthetic dense fixtures (graphene/CNT/fullerene/crystal): asserts the majority produce bonded thumbs, not atoms-only.

Treat the pure scene-extraction / sampling / scene-store tests as contract tests (module I/O under well-defined inputs) and the pipeline / dense-outcomes / account-hot-path tests as the product-behavior gate.

#### Capsule Preview V2 E2E (`tests/e2e/`)

| File | Lane | Purpose |
|------|------|---------|
| `poster-smoke.spec.ts` | **Pages-dev-only** | Three probes against the dev poster pipeline. Self-skipped outside the `pages-dev` Playwright project (same `test.beforeEach` gate documented above). Seeds a dimer capsule. |

The three probes are intentionally tiered:

1. **Probe 1: unknown share code → 404.** Proves the route module's TOP-LEVEL imports resolve under workerd. Does NOT exercise the lazy import or Satori.
2. **Probe 2: GET `/og-fallback.png` → 200, IHDR-asserted 1200×630.** Proves static-asset bundling.
3. **Probe 3: deterministic seeded path.** POSTs the checked-in dimer fixture to `/api/admin/seed`, then GETs the dynamic poster and asserts 200, `image/png`, V2 cache-control, ETag matching `^"v\d+-[0-9a-f]{8}"$` (accepts V2's `v2-…`), PNG signature, IHDR 1200×630, and body > 1000 bytes (excludes the 1×1 fallback). This is the probe that exercises the lazy import, the Satori render, and the bundled font end-to-end.

Pages-dev lane env: `playwright.pages-dev.config.ts` launches wrangler with `--binding DEV_ADMIN_ENABLED=true` so the admin seed endpoint is reachable from localhost. The admin gate stays defense-in-depth (localhost hostname check), so flipping the binding does not weaken production posture.

Fixtures: `tests/e2e/fixtures/poster-smoke-capsule.json` — the minimal valid capsule Probe 3 seeds. This fixture is also the default payload for `npm run seed:capsule`.

When to run: before merging any change that touches the poster route, the scene-extraction / projection / sampling / scene-store / sanitizer modules, the `/c/:code` HTML route, the bundled poster font, or the inline `CapsulePreviewThumb`. Mocked `page.route()` is not sufficient for Probe 3 — the Satori render must hit the real worker.

### Known Pre-Existing Flake: `worker-integration.spec.ts`

`tests/e2e/worker-integration.spec.ts` has a timing-sensitive stall-detection test that is intermittently flaky under cumulative CPU/GC pressure from earlier specs in the same run (notably `smoke.spec.ts`'s bench-wasm path and the React UI suite). It was classified on 2026-04-13 and is **not** a Phase 2 or Phase 5 regression. See the file-header comment in that spec for the full reproduction/isolation notes, bisection result, and retry guidance — do not treat full-suite failures here as signals for share-stack work. Both Playwright configs ship `retries: 1` specifically to absorb this class of load-sensitive workerd failures without masking real regressions.

### Timeline Subsystem (~200 tests across 11 files)

| File | Tests | What it validates |
|------|------:|-------------------|
| `simulation-timeline.test.ts` | 28+ | Core SimulationTimeline: recording frames, retention limits, review mode entry/exit, scrub to arbitrary frame, restart from timeline, truncation on re-record, motion preservation across restore, arming lifecycle |
| `timeline-bar-lifecycle.test.tsx` | 87 | TimelineBar unified shell: invariant lane skeleton across all modes (time + overlay-zone + track + action-zone), off/ready use simple label not segmented switch, active uses two-segment mode switch, bidirectional mode switch (onEnterReview, onReturnToLive), Review segment disabled when no recorded range, restart anchor edge clamping (0% at 5%, 100% at 95%), restart-affordance two-element contract (the restart pill is a `<span class="timeline-restart-anchor">` wrapping a `<button class="timeline-restart-button">` — the test asserts the two-element anchor+button structure and that there is **no** wrapping `ActionHint` tooltip on restart; this is a regression lock against the removed duplicate hint), clear confirmation dialog flow (confirm fires, cancel safe), format correctness across all unit ranges (fs/ps/ns/µs with exact string assertions), mode transitions (off→ready→active store changes, startup null→installed), accessibility labels (return-to-sim, restart-with-time, clear trigger), no old row1/row2 layout remnants, thick track across all states, lane structure identical for short and long time values, hint tooltip visibility (6 tests: start recording hint on hover+delay, simulation segment hint in review, review segment hint with range, disabled review hint via focus when no range, restart anchor hint on hover, clear trigger hint on hover — all use `vi.useFakeTimers()` + `fireEvent.mouseEnter` + `vi.advanceTimersByTime(HINT_DELAY_MS)` and assert `timeline-hint--visible` class), export dialog tests use capsule/full format options (no replay). Also covers the Transfer-dialog performance contract (Transfer INP fix): Share-default no-compute, Download-tab JIT compute, close/tab-switch/unmount cancel of scheduled work, one-compute-per-session cache + reset on reopen, pause-fires-on-Share-default / on-OAuth-resume, Transfer-click-survives-pause-throw, failed-estimates-retry-on-tab-switch. Uses top-of-file `vi.mock('.../timeline-after-paint', ...)` exporting a `vi.fn` with a `beforeEach` synchronous-default reset so individual tests can override via `mockImplementation` and a `captureScheduledWork()` helper for cancellation tests. |
| `timeline-recording-orchestrator.test.ts` | 9 | Orchestrator arming, recording cadence (frame capture rate), review-mode blocking of new recordings, sim-time advancement during recording, reset behavior |
| `timeline-recording-policy.test.ts` | 5 | Arm/disarm/re-arm lifecycle, policy state transitions |
| `timeline-subsystem.test.ts` | 11 | Subsystem boundary isolation, clearAndDisarm, teardown cleanup, isInReview predicate, installStoreCallbacks wiring, placement-does-not-arm regression tests |
| `timeline-arming-wiring.test.ts` | 10 | Store callback integration: placement, pause, speed, physics settings do not arm; atom interaction arms after placement |
| `interaction-dispatch-arming.test.ts` | 16 | Real createInteractionDispatch: arming on startDrag/startMove/startRotate/flick regardless of worker state; continuation events do not arm; worker mirroring independent of arming |
| `store-callbacks-arming.test.ts` | 7 | Real registerStoreCallbacks: chooser, dock, and settings callbacks verified through actual store surface |
| `reconciled-steps.test.ts` | 4 | Snapshot deduplication — ensures reconciled steps don't produce duplicate frames |
| `timeline-after-paint.test.ts` | 8 | `scheduleAfterNextPaint` helper behind the Transfer INP fix: synchronous return, rAF-then-setTimeout ordering (proves the paint yield), cancel before rAF, cancel between rAF and setTimeout, cancel after completion is a no-op, exactly one rAF per schedule, partial-global fallback to setTimeout pair when rAF is missing, atomic pair-selection when only one of rAF/cAF is present |
| `timeline-performance.test.ts` | 15 | `measureSync` wrapper: success path (returns value, emits `performance.measure`, clears marks), failure path (rethrows, emits measure on throw, clears marks on throw), API-missing fallback, and the invariant that instrumentation failures never replace the work() result or the rethrown error |

### Restart & State Restore (11 tests across 2 files)

| File | Tests | What it validates |
|------|------:|-------------------|
| `restart-state-adapter.test.ts` | 8 | State serialization round-trip, application to simulation, no-interaction-restore (preserving untouched state) |
| `worker-lifecycle-restore.test.ts` | 3 | Restore success reactivates worker, restore failure tears down, error during restore tears down |

### Worker Bridge (3 new tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `worker-bridge-direct.test.ts` | 3 | restoreState posts correct command to worker, resolves on success acknowledgement, crash yields failure |

### Physics Timing (10 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `physics-timing.test.ts` | 10 | Derived simulation rate, damping invariance across speed changes, setTimeConfig parameter application, engine parameterization consistency |

### Highlight Composition (13 tests in 1 file + shared helpers)

| File | Tests | What it validates |
|------|------:|-------------------|
| `renderer-interaction-highlight.test.ts` | 13 | Panel/interaction layer independence, real InstancedMesh creation, overlap counts, review-visibility restoration, disposal cleanup, multi-molecule regression |
| `highlight-test-utils.ts` | — | Shared helpers: `makeStateFake()` (minimal state-only renderer fake), `makeRealMeshCtx()` (real THREE geometry context) |

### Highlight Runtime Gating (5 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-group-highlight.test.ts` | 5 | Tracked highlight gating when `canTrackBondedGroupHighlight` is false |

Tests live in a `"tracked highlight gating"` describe block and verify the store behaves correctly when the tracking capability is disabled:

- `toggleSelectedGroup` no-ops when `canTrackBondedGroupHighlight` is false
- `setHoveredGroup` still works when tracking disabled
- `clearHighlight` safe when tracking disabled
- `syncToRenderer` self-heals stale tracked state when feature gated off
- hover works again after stale tracked state self-healed

Tests are organized in 3 layers, each catching a different class of regression:

| Layer | Tests | What it proves |
|-------|------:|----------------|
| **State-level channel** | 6 | Panel and interaction state are independent channels. Setting one does not clobber, clear, or overwrite the other. Clearing interaction leaves panel intact. Panel updates during active interaction do not corrupt interaction state. |
| **Real-mesh** | 5 | Actual `InstancedMesh` objects created via real THREE geometry. Both meshes coexist with correct `.count`. Partial overlap: atom in both sets rendered on both layers with exact counts. Review hide followed by live `_updateGroupHighlight()` restores `mesh.visible`. `disposeHighlightLayers` resets all state including intensity defaults (`'selected'` / `'hover'`). |
| **Integration regression** | 1 | Reproduces the original bug: bonded-group selection on molecule A (panel channel) + rotate molecule B (interaction channel). Both highlights must remain visible and independently clearable. |

Key test scenarios:

- Panel stays visible during interaction (concurrent coexistence)
- Partial overlap: atom in both sets rendered on both layers with exact counts
- Review hide then live update restores `mesh.visible`
- `disposeHighlightLayers` resets all state including intensity defaults
- Multi-molecule regression: select group A, rotate group B, both visible

### Renderer Atom Color Overrides (8 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `renderer-atom-color-overrides.test.ts` | 8 | Root-cause fix for authored color visibility via `_applyAtomColorOverrides`: material becomes white when overrides active (neutral multiply), overridden atoms get HSL-lifted per-instance colors, non-overridden atoms receive theme atom color as instance color, clearing overrides restores material to theme color, instance colors reset to white on clear, override colors visibly distinct from default atom color, theme switch with active overrides keeps material white (re-applies overrides), CONFIG `atomColorOverride` minSaturation/minLightness in reasonable perceptual-lift range. |

### App Orchestration Tests

Architecture extractions should be guarded at the extracted owner, not only through indirect helper tests.

| File | Purpose |
|------|---------|
| `frame-runtime.test.ts` | Per-frame pipeline ordering (worker-mode sequencing proof, review-mode gating, drag-refresh gating, sync-mode fallback, placement framing integration: framing runs during placement, orbit-follow suppressed, idle shrink allowed, drag framing + reprojection, drag reprojection not called when idle) |
| `app-lifecycle.test.ts` | Teardown sequence ordering (exact dependency-ordered call sequence, subscription cleanup, partial-init safety) |

### UI Components (58 tests across 2 files)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-groups-panel.test.tsx` | 51 | Full BondedGroupsPanel contract (see breakdown below) |
| `status-bar-precedence.test.tsx` | 7 | Rewritten for message-only contract: status message precedence rules across simulation states |

Previously-skipped StatusBar tests have been unskipped and now pass.

#### BondedGroupsPanel Test Breakdown (51 tests)

Tests cover the disclosure pattern, two-level UI, highlight wiring, color editing, popover layout, highlight hide behavior, buildGroupColorLayout, and config contracts:

**Disclosure pattern:** panel expanded by default with large clusters visible, header shows Collapse when expanded and Expand when collapsed, aria-expanded toggles correctly on header click, header click collapses everything.

**Core panel behavior:** returns null when no groups, small-clusters button expands only small groups, side-class defaults, side-right class when store side is right.

**Highlight hide (tracking disabled):** row click does not toggle selection, row has no button role or tabIndex, selected-row class not applied, hover preview still works, Clear Highlight hidden even with legacy `hasTrackedBondedHighlight`, color chip still works, Center and Follow still work when tracking disabled, panel visible in review with historical groups, panel hidden in review when no groups projected, bonded-group select gated off in review, bonded-group hover works in review, keyboard Enter/Space does not toggle selection when tracked highlight is disabled.

**Color chip and popover:** color chip visible in every row without requiring selection, chip defaults to base atom color (no inline style), clicking chip opens portalled popover (not a grid-row child), chip click does not toggle row selection (independent of selection), choosing a swatch calls `onApplyGroupColor` (7 swatches: 6 presets + original), second chip click closes popover, clicking backdrop closes popover, row gets `bonded-groups-color-open` class when popover active.

**Popover structure (honeycomb layout):** popover has honeycomb layout with default swatch in center and 6 preset swatches in computed ring, default swatch in hex center clears color, preset swatch in hex ring applies color.

**Hover clearing regressions:** hover clears when cursor leaves row, moving across rows switches preview correctly, opening color popover clears hover preview.

**Original-color swatch and multi-color chip:** popover has original-color swatch instead of clear button (calls `clearGroupColor`), clicking original-color swatch calls onClearGroupColor, original-color swatch gets active class when no override exists, multi-color group chip shows conic gradient (2+ authored colors), colored + default atoms shows conic gradient with `var(--atom-base-color)` segment, single-color chip shows solid background (not conic gradient) when ALL atoms have same override, portalled popover does not keep `hoveredBondedGroupId` alive.

**buildGroupColorLayout:** default option placed in primary slot, secondary preserves original preset order, primary is null when no default option exists, works with varying palette sizes.

**computeHexGeometry:** adjacent swatches do not overlap at active scale (tested for n=3,4,5,6,8,10), container fits all swatches including scaled edges, n=1 handled without division by zero, ring slot positions do not overlap for 6 presets (pairwise distance check).

**Config contracts:** selected highlight opacity/emissive below readability thresholds, hover highlight more subtle than selected (opacity, emissive, scale), every theme defines numeric atom color for CSS and renderer parity.

### Placement Solver (117 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `placement-solver.test.ts` | 117 | PCA shape classification, camera frame, molecule frame, orientation selection, no-initial-bond feasibility, rigid transform, full solver integration, continuity sweeps, roll stability, 3-layer acceptance gates |

Tests use perspective projection via the shared `projectToScreen()` (matches renderer FOV=50 deg) and 2D PCA via `projected2DPCA()` for stable visible-axis measurement.

Real library structure data is used alongside synthetic shapes: CNT (20 atoms spanning all Y rings from `cnt_5_5_5cells.xyz`) and graphene (18 atoms from `graphene_6x6.xyz`).

#### 3-Layer Acceptance Architecture

The acceptance tests use three intentionally overlapping layers. All three must pass; each catches a different class of regression.

| Layer | What it proves | Failure means |
|-------|---------------|---------------|
| **[policy conformance]** | Solver output matches `chooseCameraFamily()` | Implementation disagrees with the current product rule. Does NOT prove the rule itself is correct. |
| **[external oracle]** | Hand-written canonical backstop with stable expected families | Policy helper or geometry selector changed behavior on a case that was previously validated by hand. NOT derived from policy helpers. |
| **[observable behavior]** | Policy-independent user-facing sanity: readability ratios, orbit stability, plane projected shape | Preview may look wrong to the user regardless of which family the solver chose. Can detect a bad product rule. |

**[policy conformance]** tests assert the solver's visible long-axis angle matches the family returned by `chooseCameraFamily()`. They prove implementation conformance to the current rule, not product correctness. Covers both line-dominant and plane-dominant regimes across front, side, and oblique views.

**[external oracle]** tests are an independent canonical backstop: a small set of stable hand-written expected families. Currently mostly vertical-family because the scorer architecture (pure target-axis extent) makes stable horizontal line cases rare. This is a known property of the scorer, not a test gap. Failure here warrants investigating whether a policy change was intentional.

**[observable behavior]** tests validate what the user actually sees without referencing any policy helper: readability ratios (visible extent vs 3D extent), orbit stability (angle drift under small camera perturbation), and plane projected shape (2D PCA aspect ratio confirms face-on presentation). These can detect a bad product rule that the other two layers would miss.

### Placement Camera Framing (20 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `placement-camera-framing.test.ts` | 13 | Pure framing solver: no-adjustment fast path, target shift toward edge pressure, distance increase for wide unions, asymmetric margins, near-plane safety, orientation independence, visible-anchor filtering, adaptive search regression (visible-anchor vs offscreen, edge-drag target-shift preference, no over-depth), drag offset geometry (grabbed-point plane, non-origin preview, camera rotation compensation) |
| `placement-drag-lifecycle.test.ts` | 7 | Controller-path drag lifecycle: pointer capture acquired on pointerdown, pointerleave does not abort drag with capture, pointerup releases capture, pointercancel aborts, per-frame reprojection runs during drag, capture-failure fallback (pointerleave aborts when capture unsupported) |

### Review Mode UI Lock (35 tests across 6 files)

| File | Tests | What it validates |
|------|------:|-------------------|
| `review-ui-lock-selector.test.ts` | 4 | Selector: live mode all false, review mode all true, tooltip text content (asserts `REVIEW_LOCK_TOOLTIP` contains 'read-only' and 'Simulation'), tooltip vs status copy |
| `review-ui-lock-guards.test.ts` | 7 | Runtime guards: onAdd, onPause, onModeChange, onAddMolecule, onSelectStructure, onClear blocked in review with hint; all work in live |
| `review-lock-dom-structure.test.tsx` | 9 | DOM contract: li is direct child of ul, no timeline-hint-anchor class, tooltip inside li not wrapping (asserts `REVIEW_LOCK_TOOLTIP` content), keyboard-focusable, tooltip not inside dimmed wrapper, bottom-start placement, selector integration (tooltip wording consistency with updated `REVIEW_LOCK_TOOLTIP`) |
| `review-locked-interaction-hook.test.tsx` | 4 | Shared hook: click triggers status hint, Enter triggers hint, Space triggers hint, show/hide tooltip timing |
| `dock-bar-review-lock.test.tsx` | 8 | DockBar: Add review-locked, Pause review-locked, Segmented items disabled, ActionHint tooltips on disabled items, Settings not locked, live mode normal, blocked click, live/review segmented structural parity |
| `structure-chooser-review-lock.test.tsx` | 4 | StructureChooser: rows wrapped in review lock, tooltips present, click shows hint not callback, live mode normal |

### Dock Layout Stability (6 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `dock-bar-layout-stability.test.tsx` | 6 | 4 named slot wrappers, paused toggle preserves slot structure, Pause/Resume in same slot, mode slot contains segmented, placement maps to same slots, grid structure |

### Bonded Group Runtime & Store (20 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-groups.test.ts` | 20 | Projection, reconciliation, store behavior, and partitioning (see breakdown below) |

Tests cover connected-component projection, stable tie ordering, merge/split reconciliation, no-op suppression, panel store behavior, group partitioning, and selection ownership:

**Projection:** projects components sorted by size desc, minAtomIndex correct, empty/null physics produce empty groups, reset clears groups.

**Stable tie ordering:** equal-size groups maintain order across projections.

**Merge reconciliation:** merged group inherits ID from largest-overlap predecessor.

**Split reconciliation:** larger-overlap child inherits original ID, smaller child gets new ID.

**No-op suppression:** minAtomIndex change triggers store update, new equal-size groups sort by minAtomIndex fallback, identical projections do not trigger store update.

**Panel store behavior:** `bondedGroupsExpanded` defaults to true (expanded by default), `toggleBondedGroupsExpanded` toggles in both directions, `resetTransientState` preserves expanded preference and clears groups, `bondedSmallGroupsExpanded` defaults to false and toggles, `resetTransientState` collapses small groups.

**Partitioning:** partitions into large and small buckets, custom threshold works.

**Selection ownership:** `projectNow` does not clear `selectedBondedGroupId`, `reset` does not clear `selectedBondedGroupId`.

### Bonded Group Pre-Feature (17 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-group-prefeature.test.ts` | 17 | Display source: live resolution, review resolution, null case, strict review (no live fallback). Capabilities: live allows all, review blocks mutation but allows inspect/target/edit, live mode `canTrackBondedGroupHighlight` false, review mode `canTrackBondedGroupHighlight` false. Appearance: group color writes atom overrides, clear removes overrides, syncToRenderer drives renderer, syncGroupIntents propagates to uncolored atoms, syncGroupIntents does NOT overwrite existing overrides from merged groups, pruning (group disappears then intent pruned), clearGroupColor removes intent so syncGroupIntents won't re-apply. Wiring: initial sync with preloaded store, applyGroupColor drives renderer. Persistence: colors survive timeline mode transitions, annotation-global semantics. Stable-ID capture: stable atom IDs captured at group color assignment time, identity preserved across frame reordering. Identity drift: group identity tracked across topology changes, drift detected when atom membership diverges beyond threshold. Coordinator lifecycle: coordinator initializes with preloaded state, coordinator tears down cleanly on file change, coordinator reset does not leak subscriptions. |

### Shared History Modules & Watch App

| File | What it validates |
|------|-------------------|
| `shared-history-modules.test.ts` | Shared history modules and watch app components (see breakdown below) |

**detectHistoryFile:** valid files, non-objects, wrong format, missing fields.

**validateFullHistoryFile:** structural guards (malformed envelopes, null internals, per-frame shape), simulation/atom field guards, semantic checks (maxAtomCount, frameCount, durationPs, positions length, monotonic ordering, atomId uniqueness, bond validation with endpoint range checks).

**computeConnectedComponents:** zero atoms, zero bonds, single component, multiple components, out-of-range bond indices.

**createBondedGroupProjection:** projection, reconciliation, reset.

**loadHistoryFile:** all LoadDecision branches (supported, unsupported replay/version, invalid JSON/format/validation).

**importFullHistory:** Float64Array conversion, bond tuple conversion, restartAlignedToDense flag, checkpoint normalization.

**createWatchPlaybackModel:** load/unload, 4 sampling channels, binary search edge cases, time clamping (NaN, out-of-range).

**createWatchBondedGroups:** group computation, memoization by frameId, reset.

**End-to-end pipeline:** load → import → playback → groups.

*As of Capsule Preview V2, the unit suite (Vitest — ~180+ test files under `tests/unit/`) plus the Playwright default lane (13 spec files under `tests/e2e/`, of which two — `poster-smoke.spec.ts` and `pages-dev-flows.spec.ts` — self-skip outside the pages-dev lane) pass across the lab + watch + share + auth + account-erasure + handoff + capsule-preview surfaces. Run `npx vitest run` for the authoritative live unit total, `npm run test:e2e` for the default E2E lane, and `npm run test:e2e:pages-dev` for the pages-dev lane.*

### Bond Topology Parity (23 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bond-topology-parity.test.ts` | 23 | Shared bond topology builders, engine parity, ordering contract, timeline continuity (see breakdown below) |

**BondRuleSet:** `createBondRules` precomputes squared values and returns correct `maxPairDistance`.

**buildBondTopologyFromAtoms (shared naive builder):** empty atoms produce empty bonds, dimer at 1.42 Ang produces one bond, atoms at 3.0 Ang produce no bond, triangle produces three bonds in ascending (i,j) order, mixed geometry respects minDist filter (0-3 too close), pair-aware heterogeneous rules produce different bonds than global cutoff (tight rules block C-O and H-O while keeping C-H).

**buildBondTopologyAccelerated (shared accelerated builder):** rejects non-null elements at runtime (JS/any-typed callers), n=0 with prepopulated outBonds returns 0, dimer matches naive builder, triangle produces ascending (i,j) order, output-buffer reuse reuses existing tuple entries in-place, workspace grows transparently when n exceeds initial capacity.

**PhysicsEngine.updateBondList() parity with shared builder:** dimer engine.getBonds() matches naive builder, triangle ascending (i,j) order matches naive, engine with no-bond pair returns empty, mixed two bonds (0-1 + 1-3) with minDist blocking 0-3.

**Bond ordering contract:** triangle produces bonds in ascending (i,j) order: [0,1], [0,2], [1,2].

**Timeline/export continuity:** captureRestartFrameData produces the same bond tuples as getBonds.

**buildBondTopologyFromPositions (lower-level shared builder):** pair-aware element lookup with heterogeneous rule set, elementById null uses global-rule fast path, throws on missing element ID when elementById is provided, output ordering is ascending (i, j).

### Watch Topology Reconstruction (53 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-topology-sources.test.ts` | 53 | Topology source abstraction, stored vs reconstructed parity, reduced-history import validation, bond-policy resolution, controller integration, capsule schema validation, capsule importer, appearance import, getInteractionAtTime, export builder, legacy normalization (see breakdown below) |

**BOND_DEFAULTS shared source of truth:** exports cutoff and minDist with expected values.

**StoredTopologySource:** returns restart-frame topology at or before time, returns null before first frame, reset clears the reference.

**ReconstructedTopologySource:** reconstructs bonds from dense-frame positions, uses dense-frame frameId, cache object-identity (same frame returns same instance), cache invalidation (different frame returns new instance), reset clears cache and reference, works with non-contiguous stable atom IDs (10, 42).

**Topology parity (stored vs reconstructed):** same geometry produces same bond tuples.

**validateReducedFile:** accepts a valid reduced file, rejects missing simulation, rejects missing denseFrames, rejects wrong kind.

**importReducedAsCapsule (legacy reduced normalization):** imports a valid reduced file (normalizes to capsule kind), rejects non-monotonic timePs, rejects duplicate atom IDs, rejects atomId not in atom table, rejects duplicate atomIds within frame, accepts non-contiguous stable IDs, rejects unsupported indexingModel, rejects non-string element, rejects non-finite scalars, rejects NaN/Infinity in positions, rejects invalid bondPolicy, legacy file with no bondPolicy resolves to BOND_DEFAULTS via buildExportBondPolicy(), preserves frame-local interaction/boundary payloads, preserves optional title/description from legacy metadata, validates simulation.units.

**Bonded-group parity (stored vs reconstructed topology):** same topology input produces same bonded-group summaries.

**Controller loads all file kinds:** full-history file loads and produces topology, reduced-history file loads (normalized to capsule), capsule file loads end-to-end (loader → importer → playback → topology → interpolation), reduced-history scrub + smooth playback + topology + groups work end-to-end.

**File-declared bondPolicy overrides BOND_DEFAULTS in reconstruction:** tighter cutoff produces fewer bonds than default.

**buildCapsuleInterpolationCapability:** marks compatible adjacent frames as bracketSafe, marks last frame as last-frame, all hermiteSafe are 0 (no restart data), all velocityReason are restart-misaligned.

**createWatchTrajectoryInterpolationForCapsule:** linear interpolation works between compatible dense frames, Hermite selected on capsule files falls back to linear, Catmull-Rom selected on capsule files falls back to linear, variable-n bracket degrades conservatively.

**validateCapsuleFile:** accepts valid capsule file, rejects missing bondPolicy, rejects wrong kind, rejects empty denseFrames.

**importCapsuleHistory:** valid capsule import, required bondPolicy, frameId monotonicity, appearance import (present/absent/unknown atomId/malformed colorHex), interaction import (present/absent/unknown frameId/non-monotonic/unknown atomId/missing target/wrong target length/NaN target/unknown kind), units validation (missing/wrong time/wrong length), dense frames have interaction: null and boundary: {}.

**getInteractionAtTime:** returns interaction event at exact frame time, interpolates between bracketing frames, returns null before first interaction, returns null after last interaction, handles non-monotonic query times gracefully.

**export builder:** builds capsule export from playback model, preserves topology and appearance through round-trip, export file validates against capsule schema, exported bondPolicy matches source.

**legacy reduced normalization:** kind erased to capsule, frame-local interaction preserved, bondPolicy defaults to BOND_DEFAULTS, null appearance/interaction/frameIdToIndex, preserves title/description metadata, validates units.

**buildExportBondPolicy:** returns valid BondPolicyV1 from BOND_DEFAULTS.

**loader accepts capsule kind:** capsule file detected and supported, capsule with appearance passes, capsule without bondPolicy rejected.

**LoadedWatchHistory is 2-way union:** capsule has kind=capsule, full has kind=full.

**history-file-loader:** accepts capsule files, accepts reduced files (legacy), still accepts full files, still rejects replay files.

### Capsule Parity (21 golden tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `capsule-parity.test.ts` | 21 | Golden parity tests across topology, appearance, interaction, sparsification, and file size (see breakdown below) |

**Topology parity:** capsule topology matches full-history topology at sampled timestamps, bond counts identical across file kinds, bonded-group structure consistent between capsule and full representations.

**Appearance parity:** authored atom color overrides round-trip through capsule export/import, appearance data preserved across capsule serialization, color assignments survive capsule normalization.

**Interaction parity:** interaction events preserved in capsule format, getInteractionAtTime returns correct interaction data from capsule files, interaction timestamps align with dense frame boundaries.

**Sparsification parity:** sparsified capsule retains topology fidelity at sampled frames, reduced frame count does not corrupt bond or group structure, interpolation between sparse frames maintains structural consistency.

**File size:** capsule file size is strictly smaller than equivalent full-history file, size reduction scales with sparsification level.

### Watch Controller & Parity (~40+ tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-parity.test.ts` | ~35 | Watch controller lifecycle, lab/watch parity, playback speed (see breakdown below) |
| `watch-react-integration.test.tsx` | ~7 | React component integration: landing/workspace transition, error banners, playback bar, bonded-groups panel, top bar badge, WatchCanvas mock |

#### watch-parity.test.ts Breakdown

**partitionBondedGroups shared extraction:** default threshold, custom threshold, empty groups.

**BondedGroupSummary consolidation:** lab selector re-exports same function reference.

**Controller lifecycle:** initial snapshot, subscribe/unsubscribe, error on invalid file, referential snapshot stability.

**Controller with valid file:** load, togglePlay, scrub, transactional second-file open.

**File load initial time:** currentTimePs at first frame, not 0; file replacement resets correctly.

**Lab/watch parity on same file:** topology at sampled timestamps, bonded-group counts, metadata match.

**Playback speed x1 canonical rate:** rate independent of file length, short file takes real seconds.

#### watch-react-integration.test.tsx Breakdown

**Landing vs workspace transition:** component renders landing or workspace based on controller state.

**Error banner:** shown on landing and during workspace (transactional failure).

**Playback bar:** reflects playing state.

**Bonded-groups panel:** expand/collapse.

**Top bar file-kind badge:** displays correct file kind.

**WatchCanvas mocked:** Three.js incompatible with jsdom.

### Watch Camera Input (22 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-camera-input.test.ts` | 22 | Camera orbit, triad interaction, pointer capture, contextmenu, blur/touchcancel (see breakdown below) |

**Shared gesture constants:** exports expected constant values (TRIAD_DRAG_COMMIT_PX, TAP_INTENT_PREVIEW_MS, TAP_MAX_DURATION_MS, DOUBLE_TAP_WINDOW_MS), all positive numbers.

**Camera-input lifecycle:** create/destroy without errors, contextmenu listener removed on destroy.

**Desktop orbit:** left-drag on background starts orbit and calls applyOrbitDelta, right-drag starts orbit, pointer capture acquired on orbit start, middle-click does not start orbit (OrbitControls owns dolly).

**Desktop triad click parity:** left-click on triad does NOT call snapToAxis (lab has no desktop triad click), left-click on triad starts orbit instead (everything = orbit on desktop).

**Contextmenu suppression:** prevents default on contextmenu events.

**Blur handler:** window blur resets gesture state (subsequent move does not orbit).

**Mobile 1-finger orbit:** 1-finger drag on background starts orbit, 2-finger transition cancels active orbit.

**Mobile triad interaction:** triad drag below commit threshold does NOT orbit, drag above threshold orbits, tap on axis endpoint calls snapToAxis, tap on center zone does NOT snap (waits for double-tap), double-tap on center calls animatedResetView.

**Mobile touchcancel:** resets all gesture state on touchcancel.

**Controller lifecycle wiring:** watch-controller imports and uses createWatchCameraInput and createWatchOverlayLayout, detachRenderer tears down overlayLayout then cameraInput then renderer (ordering verification).

**WatchRenderer Round 3 adapter interface:** interface has all 10 Round 3 methods (9 interaction + setOverlayLayout).

**No duplicate orbit-math:** watch-camera-input does not import from orbit-math.ts (uses renderer adapter).

### Watch Overlay Layout (18 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-overlay-layout.test.ts` | 18 | Triad sizing formulas, ResizeObserver, retry loop, device mode (see breakdown below) |

**Playback bar selector contract:** WatchApp.tsx has `data-watch-bottom-chrome` attribute on bottom chrome wrapper, watch-overlay-layout queries `[data-watch-bottom-chrome]`.

**Triad sizing formulas:** desktop formula `min(200, max(120, floor(W * 0.10)))` with clamp to min 120 and max 200, phone formula `min(140, max(96, floor(W * 0.15)))` with clamp to max 140.

**Triad bottom positioning:** desktop fixed bottom = 12; phone and tablet both clear the playback bar when `[data-watch-bottom-chrome]` is in DOM (tablet parity added because watch's full-width bottom chrome overlaps lab's fixed-12 offset); phone uses `TRIAD_BOTTOM_STARTUP_FALLBACK` when the playback bar is not yet in the DOM.

**Triad left inset:** uses `--safe-left` CSS variable + 6, defaults to 6 when variable not set.

**scheduleFirstLayout retry loop:** phone: scheduled RAF retry finds bar after insertion and attaches observer, desktop: initial layout completes without retry.

**ResizeObserver on playback bar:** attaches observer in phone mode when bar exists, does NOT attach in desktop mode, disconnects observer when switching out of phone mode, observer callback triggers re-layout, disconnect on destroy.

**Overlay layout lifecycle:** destroy removes resize and orientationchange listeners.

### Bonded Group Color Assignments (17 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `bonded-group-color-assignments.test.ts` | 17 | Shared pure color module: override projection, chip state, hex geometry (see breakdown below) |

**rebuildOverridesFromDenseIndices:** empty map from empty assignments, maps atom indices to colors, later assignments win for overlapping indices.

**computeGroupColorState:** returns default for empty atom list, returns default when no overrides match, returns single when all atoms have same color, returns multi when atoms have different colors, returns multi with hasDefault when some atoms are uncolored, caps to 4 unique colors.

**chipBackgroundValue:** returns undefined for default state, returns hex for single color, returns conic-gradient for multi color, includes atom-base-color fallback when hasDefault is true, returns string not React.CSSProperties.

**computeHexGeometry:** returns non-zero radius for 6 items, returns zero radius for 0 or 1 items.

**GROUP_COLOR_OPTIONS + buildGroupColorLayout:** 7 options (1 default + 6 presets), splits default into primary and presets into secondary.

**Shared module purity:** shared module does not import React or Zustand, chip-style helper does not import React.

### Watch Bonded Group Appearance (14 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-bonded-group-appearance.test.ts` | 14 | Stable atomId assignments, per-frame projection, controller lifecycle (see breakdown below) |

**WatchBondedGroupAppearance:** initial state (no assignments, default color state), applyGroupColor freezes stable atomIds not dense slots, per-frame projection maps atomIds to current dense slots across reordered frames, silently skips atomIds not present in current frame, clearGroupColor removes assignments for that group, clearAllColors resets everything and passes null to renderer, reset clears assignments on file load, getGroupColorState reflects current overrides, replacing color for same group replaces prior assignment.

**Renderer _getDisplayedAtomCount regression:** renderer.ts uses `_reviewAtomCount` in review mode, `_applyAtomColorOverrides` uses `_getDisplayedAtomCount` not `_atomCount` directly, updateReviewFrame re-applies authored overrides at end.

**Controller lifecycle wiring:** controller imports and creates appearance domain, `appearance.reset()` is called in openFile not detachRenderer.

### Watch Playback Speed (27 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-playback-speed.test.ts` | 27 | Speed math, log mapping, repeat modulo, step semantics, directional playback (see breakdown below) |

**Shared constants:** SPEED_MIN < SPEED_DEFAULT < SPEED_MAX, SPEED_PRESETS contains min/default/max.

**Logarithmic slider mapping:** sliderToSpeed(0) = SPEED_MIN, sliderToSpeed(1) = SPEED_MAX, roundtrip speedToSlider(sliderToSpeed(t)) identity, roundtrip sliderToSpeed(speedToSlider(s)) identity, 1x is at ~19% of slider travel, clamps input outside [0,1].

**formatSpeed:** sub-10 shows one decimal (e.g., "1.0x"), 10+ shows integer (e.g., "16x").

**WatchPlaybackModel speed:** default speed is 1x, setSpeed clamps to [SPEED_MIN, SPEED_MAX], advance uses speed multiplier, advance clamps dtMs to GAP_CLAMP_MS, load resets speed to default.

**WatchPlaybackModel repeat:** default repeat is false, repeat wraps time at end using modulo, without repeat pauses at end, load resets repeat to false.

**WatchPlaybackModel step:** stepForward advances to next dense frame, stepForward at last frame is no-op, stepBackward moves to previous dense frame, stepBackward at first frame is no-op, step pauses playback, step from mid-frame goes to adjacent frame.

**Directional playback:** startDirectionalPlayback(1) sets direction and playing, startDirectionalPlayback(-1) enables backward advance, stopDirectionalPlayback pauses and resets direction, backward playback clamps to start when not repeating, backward playback wraps when repeating, seekTo resets direction, stepForward resets direction.

### Watch Round 5 UI (48 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-round5-ui.test.tsx` | 48 | Dock hold-to-play, settings sheet, timeline scrub, rerender-during-hold regression, Round 6 Smooth toggle behavioral tests, fallback/disabled-note conditional rendering (see breakdown below) |

**Hold threshold constant:** HOLD_PLAY_THRESHOLD_MS is a positive number under 300ms.

**WatchDock structure:** source has transport cluster, utility cluster, and settings zones. Dock CSS uses fixed-width grid for transport cluster (no layout shift).

**WatchSettingsSheet structure:** uses shared sheet lifecycle hook (not local mount/animate state), imports help content from settings-content.ts, uses shared Segmented component for theme and text-size, help action uses a real button not div role="button".

**Watch settings content:** WATCH_HELP_SECTIONS has expected sections (Playback, Camera, File).

**WatchTimeline structure:** uses thick review track variant, uses pointer events for scrubbing (not native range).

**Shared CSS token contracts:** core-tokens.css defines layout geometry tokens, bottom-region.css uses shared width token, sheet-shell.css uses shared sheet width token.

**Playback direction model:** playback model has no setPlaying method (unified direction model), isPlaying is derived from playDirection.

**WatchDock behavioral:** renders transport controls (Back, Play, Fwd), Play button calls onTogglePlay, Settings button calls onOpenSettings, Repeat button calls onToggleRepeat and reflects active state, disabled when canPlay is false. Round 6 additions: Smooth toggle calls onToggleSmoothPlayback when clicked, Smooth toggle shows visible "Smooth" text label, Smooth toggle uses `watch-dock__smooth` class (not icon-only `watch-dock__small`), Smooth toggle reflects active state via `aria-pressed` + `.active` class.

**WatchSettingsSheet behavioral:** renders when open, does not render when closed, Escape calls onClose, backdrop click calls onClose, shows file info from props, Help button opens help content and Back returns. Round 6 additions: Smooth Playback group is rendered with experimental note, diagnostic fallback note is hidden when selectedMode is linear, diagnostic fallback note is hidden when experimental method runs cleanly (active == selected), diagnostic fallback note shows when experimental method falls back AND smooth is on, diagnostic fallback note hidden when smooth is OFF (neutral disabled-note appears instead).

**WatchDock hold-to-play:** short tap Back calls onStepBackward (not directional play), short tap Fwd calls onStepForward, hold Back past threshold calls onStepBackward (nudge) + onStartDirectionalPlayback(-1), hold Fwd past threshold calls onStepForward (nudge) + onStartDirectionalPlayback(1), release after hold calls onStopDirectionalPlayback, rerender during active hold does NOT cancel the gesture (regression: React re-render with new callback identities no longer kills the hold via effect cleanup).

**WatchTimeline behavioral:** renders time labels and track, uses thick review track variant, pointerDown on track calls onScrub, fill width reflects progress, thumb position reflects progress, pointerMove while captured calls onScrub with updated position, setPointerCapture failure: initial scrub + drag continuation both work via dragActive fallback.

### Shared Sheet Lifecycle Hook (7 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `use-sheet-lifecycle.test.tsx` | 7 | Mount/animate/escape/transition lifecycle shared across lab and watch (see breakdown below) |

Tests use a `SheetHarness` component that exposes hook state via data attributes.

**useSheetLifecycle:** starts unmounted when closed, mounts when opened, sets animating after reflow, unmounts after transitionend on close, calls onClose on Escape when provided, does not call onClose on Escape when not provided, lab-style usage without onClose works.

### Watch Round 6 Trajectory Interpolation (63 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-round6-interpolation.test.ts` | 63 | Interpolation strategy math, capability layer, fallback policy, cursor cache, output buffer, registry extensibility, partial-write tolerance, controller pipeline, lifecycle (see breakdown below) |

**InterpolationCapability:** bracketSafe is 1 for interpolatable brackets and 0 for last frame, bracketSafe is 0 on variable-n bracket with bracket-n-mismatch reason, hermiteSafe derived correctly from bracketSafe + velocityReason, velocityReason is restart-misaligned when count/time do not match, emits restart-count-mismatch diagnostic when counts differ, velocities-implausible sanity check flags affected frames and emits diagnostic, window4Safe is 0 at timeline edges, denseToRestartIndex valid where alignment holds and -1 otherwise.

**LinearStrategy math:** passes through start knot (alpha = 0), midpoint is the average of endpoint positions, reproduces a knot exactly when timePs lands on an interior frame.

**HermiteStrategy math:** passes through knots exactly (alpha = 0 for an interior knot), uses FS_PER_PS to scale velocities (single source of truth from shared units module), declines with velocities-unavailable when hermiteSafe is 0.

**CatmullRomStrategy math:** passes through interior knots exactly, declines with insufficient-frames at timeline edge, declines with window-mismatch when n differs inside the 4-frame window.

**Conservative fallback policy (at-or-before):** returns importer first-frame reference at timeline start, returns importer last-frame reference at timeline end, returns bracket.prev (never bracket.next) on variable-n, smoothPlayback disabled returns at-or-before reference with fallback=disabled, scrub through variable-n region never surfaces future coordinates.

**Strategy registry extensibility:** registers a synthetic experimental strategy and produces capability-declined fallback, partial-write tolerance (garbage writer declines, linear full-overwrite produces correct result), unregistered mode falls back to linear with capability-declined, registry metadata is readable and includes availability field, getRegisteredMethods returns a stable frozen reference (no churn), getRegisteredMethods reference changes only after registerStrategy, dev-only strategies are in registry but UI can filter them by availability.

**Cursor cache policy:** forward same-bracket reuses the cursor (single binary search), forward bracket-cross advances cursor by one without new binary search, backward delta triggers a full binary search, reset() clears cursor so first resolve after reset triggers binary search.

**Output buffer lifecycle:** consecutive interpolated calls return the same Float64Array reference, boundary fallback returns the importer reference (different object), no new Float64Array allocation on consecutive interpolated frames.

**Method-specific gating:** linear never declines over an interpolatable bracket, when selected method runs cleanly activeMethod === selectedMode and fallbackReason === "none", Hermite declines on variable-n bracket.

**Controller unified render pipeline (grep meta-tests):** watch-controller source has exactly one direct call to interpolation.resolve(), exactly one direct call to renderer.updateReviewFrame(), exactly four physical applyReviewFrameAtTime call sites (tick, renderAtCurrentTime, openFile, createRenderer), RAF tick uses render=false followed by updateFollow + renderer.render.

**Controller smooth-playback lifecycle:** setSmoothPlayback flips settings and publishes a new snapshot, setInterpolationMode updates snapshot, default snapshot has smoothPlayback=true, interpolationMode=linear, activeMethod=linear, fallback=none.

**LoadedFullHistory Round 6 fields:** includes velocityUnit, interpolationCapability, and importDiagnostics.

**Single-frame history fallback:** returns the only frame as importer reference.

**Capability layer -- atomId mismatch cases:** bracketReason is bracket-atomids-mismatch when adjacent atomIds differ, runtime returns bracket.prev with atomids-mismatch when bracket has atomId divergence, velocityReason is atomids-mismatch when dense/restart atomIds diverge at a frame, window4Reason is window-atomids-mismatch when atomIds diverge inside the 4-frame window, velocityReason is restart-n-mismatch when dense.n !== restart.n at a frame.

**Cursor cache -- additional invalidation cases:** large forward jump triggers a fresh binary search, repeat-wrap (end to start) triggers a fresh binary search.

**Runtime lifecycle -- reset / dispose:** reset() clears cursor cache counter, reset() does not affect output buffer identity, two runtimes are independent (no shared state), dispose() clears registry so subsequent resolve routes to linear fallback.

**Controller -- diagnostic reset + boundary:** default snapshot importDiagnostics is an empty readonly array, lastFallbackReason starts as "none" and active method as "linear".

**Snapshot change detection (Round 6 fields):** smoothPlayback toggle fires a subscriber notification, setInterpolationMode fires a subscriber notification.

### Watch Architecture Ownership Boundaries (28 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-architecture.test.ts` | 28 | Shared viewer defaults, document service, playback model policy, controller facade delegation, ownership boundaries, decoupling guards (see Round 1 architecture section above) |

Round 6 update: the ownership boundary test for controller file-parsing imports now enforces that type-only imports from `full-history-import` are allowed (for capability-layer fields and import diagnostics in the snapshot interface), while runtime imports remain forbidden. The test uses a regex that matches `import { ... } from './full-history-import'` but not `import type { ... } from './full-history-import'`.

### Watch Round 6 E2E (14 tests)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-round6.spec.ts` | 14 | Landing, file load, dock Smooth toggle, settings sheet, Hermite scrub-to-interior-bracket, fallback note visibility, phone layout geometry (see breakdown below) |

Uses a 5-frame two-atom fixture (`tests/e2e/fixtures/watch-two-atom.json`) and `?e2e=1` test hooks (`_getWatchState`, `_watchOpenFile`, `_watchToggleSmooth`, `_watchSetInterpolationMode`, `_watchScrub`).

**Landing + boot:** watch page boots without errors, landing page shows Open File button.

**File load + initial state:** file loads via test hook and transitions to playback view (atomCount=2, frameCount=5, fileKind=full), after file load defaults are smooth=on, method=linear, activeMethod=linear.

**Dock Smooth toggle:** smooth toggle button exists in the dock with correct default state (on), clicking smooth toggle flips state and updates aria-pressed.

**Settings sheet:** opens and contains Smooth Playback group and experimental note, interpolation method picker changes mode via test hook, Hermite on a Hermite-safe file scrub to interior bracket confirms activeMethod=hermite, fallback note is hidden when linear selected, settings sheet closes via Escape.

**Dock layout:** utility zone contains repeat (icon) + smooth (text label) + speed, smooth toggle shows visible "Smooth" text.

**Responsive dock (phone emulation at 375x812):** dock fits cleanly at phone width with no child overflow, no clipping, utility cluster has no internal scrollable overflow, every utility child stays within dock right edge, utility cluster does not overlap into transport cluster, Smooth text label and repeat icon are both visible.

### Cinematic Camera Pure Module (tests across 1 file)

| File | Tests | What it validates |
|------|------:|-------------------|
| `cinematic-camera.test.ts` | — | Speed-profile scaling, clamp helper, target resolver, cooldown predicate, normalization, custom-tuning propagation (see breakdown below) |

**Speed-profile scaling:** baseline 1x, 4x, 20x ceiling, 0.5x floor, degenerate inputs.

**Clamp helper:** clamps values within specified bounds.

**Target resolver:** small-cluster exclusion, null-group/atom handling, stability gate, unreconciled-clusters distinction, center/radius/min/max clamp.

**Cooldown predicate:** window bounds, non-monotonic clock clamp.

**Normalization:** invalid fields fall back, min <= max enforcement, boolean validation, exponent preservation.

**Custom-tuning propagation:** custom speed tuning values propagate through the pipeline.

### Renderer Camera Interaction Gate (tests across 1 file)

| File | Tests | What it validates |
|------|------:|-------------------|
| `renderer-camera-interaction.test.ts` | — | Gate contract (imports real `camera-interaction-gate.ts`, NOT a test-local copy), Renderer structural assertions, behavioral prototype test (see breakdown below) |

**Gate contract (real module):** programmatic updates silent, user gestures emit phases, interleaved updates, stray post-damping changes ignored, nested suppress, phantom end guard, reset.

**Renderer structural assertions:** import/callsite counts.

**Behavioral prototype test:** `_updateControlsSilently` with synthetic `this`.

### Watch Cinematic Camera Service (tests across 1 file)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-cinematic-camera.test.ts` | — | State/gating, gesture phase gating, setEnabled clears gesture state, continuity, config propagation, lifecycle (see breakdown below) |

**State/gating:** defaults, setEnabled, manualFollow, cooldown, resume.

**Gesture phase gating:** held gesture past cooldown, end releases, change-only semantics.

**setEnabled clears gesture state:** toggling enabled off resets active gesture tracking.

**Continuity:** no self-cooldown loop.

**Config propagation:** custom speedTuning, custom userIdleResumeMs.

**Lifecycle:** attachRenderer, idempotent swap, resetForFile, dispose.

### Watch Cinematic Camera Toggle (tests across 1 file)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-cinematic-camera-toggle.test.tsx` | — | React toggle: label render, aria-pressed/aria-label, click handler, data-status attribute (see breakdown below) |

**Label:** renders "Cinematic Camera" text.

**Accessibility:** aria-pressed reflects enabled state, aria-label flips on/off.

**Click handler:** onClick fires onToggle.

**Data attribute:** data-status reflects the status enum value.

### Watch Cinematic Camera Integration (tests across 1 file)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-cinematic-camera-integration.test.ts` | — | Behavioral integration: real createWatchCameraInput + real service via stubbed renderer in jsdom (see breakdown below) |

**Held-pointer drag:** keeps paused beyond cooldown, release starts cooldown window, resume after window.

**Phase trace assertion:** verifies the correct sequence of phase transitions through the integration pipeline.

### Watch Cinematic Camera Controller Wiring (tests across 1 file)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-cinematic-camera-controller.test.ts` | — | Controller-wiring: real createWatchController with mocked factories (see breakdown below) |

**Phase forwarding:** camera-input opts forward phases to cinematic service's markUserCameraInteraction.

**Lifecycle:** attachRenderer lifecycle wiring.

### Cinematic Camera Shared Test Helper

| File | Tests | What it validates |
|------|------:|-------------------|
| `tests/helpers/watch-renderer-stub.ts` | — | Shared WatchRenderer stub (jsdom + Node-safe). Used by service, integration, and controller tests. |

### Watch→Lab Handoff Surface

The Watch→Lab entry is a read-only-review-to-editable-scene handoff: Watch produces a seed payload, the URL carries an opaque entry token, and Lab boot consumes-or-falls-back. The primary Watch-side CTA is labeled **"Interact From Here"** (accent-filled pill; the secondary option **"Open a Fresh Lab"** lives in a caret-toggled disclosure popover). The seed carries `colorAssignments` (stable-id color quartets), an optional orbit `camera` pose, and a refined `provenance` block with `velocitySource` (`'restart' | 'central-difference' | 'forward-difference' | 'backward-difference' | 'mixed' | 'none'`) and `unresolvedVelocityFraction`. The test surface covers four layers — transport (write + read + URL composer), seed shape (normalize + build predicate + builder, including camera + colorAssignments + velocitySource), Lab-side hydrate (transactional apply + rollback reasons + adapter wrapper, including camera snapshot apply and bonded-group appearance restore), and UI surfaces (primary pill + caret-disclosure popover + toast copy). Regression-lock invariants live in the E2E spec because the only reliable way to catch them is against the real Watch→Lab boot sequence.

#### Handoff Transport (`tests/unit/`)

| File | Purpose |
|------|---------|
| `watch-lab-handoff.test.ts` | Writer + consumer roundtrip; `WatchHandoffWriteError` classification (storage-unavailable vs. quota-exceeded); read-path `SecurityError` coverage; retry reclassification across the same key; Firefox `NS_ERROR_DOM_QUOTA_REACHED` detection (the Firefox DOMException name that Chromium's `QuotaExceededError` check misses). |
| `watch-lab-href.test.ts` | URL composer: `?from=watch&entry=…` token encoding invariants. |
| `watch-handoff-url.test.ts` | `isWatchHandoffBoot()` predicate in `src/watch-lab-handoff/watch-handoff-url.ts` — the single source of truth that gates both Lab's pending-handoff boot (`_hasPendingWatchHandoff`) and the onboarding-overlay suppression (`isOnboardingEligible`). Pins the accepted query-flag shapes and the one-call-per-load contract before the URL consume path scrubs the flag. |

#### Seed Shape (`tests/unit/`)

| File | Purpose |
|------|---------|
| `watch-lab-normalize-seed.test.ts` | `normalizeWatchSeed` shape invariants. Pins the collapsed payload view: `localStructureAtoms`, `velocities`, `bonds`, `boundary`, `workerConfig`, `provenance` (with `velocitySource` + `unresolvedVelocityFraction`), `colorAssignments`, `camera`, `n`. Legacy-token defaults are pinned here: legacy tokens without camera → `null`; without colorAssignments → `[]`; 2-field provenance → `velocitySource` derived from `velocitiesAreApproximated` (true → `'mixed'`, false → `'restart'`), `unresolvedVelocityFraction` → `0`. Defensive `VALID_VELOCITY_SOURCES` coercion is exercised for direct-call paths that bypass the validator. This is the single source of truth for what a seed is — new fields must be added here first. |
| `watch-lab-seed-build.test.ts` | `canBuildWatchLabSceneSeed` predicate + seed builder coverage (what Watch states are eligible to produce a seed, and what the builder emits for each, including `getColorAssignments` / `getOrbitCameraSnapshot` plumbing, per-atom velocity-source tagging collapsed to a single tag, pre-null-promotion `unresolvedVelocityFraction`, and the unknown-atomId-dropped warn path). |

#### Entry Control UI (`tests/unit/`)

| File | Purpose |
|------|---------|
| `watch-lab-entry-control.test.tsx` | 21 cases. React test for the Watch→Lab entry control's current shape: a single accent-filled primary pill (`LAB_ENTRY_PRIMARY_LABEL` = *"Interact From Here"*) plus a caret (`LAB_ENTRY_CARET_LABEL`) that toggles a disclosure popover containing the secondary option (`LAB_ENTRY_SECONDARY_TITLE` = *"Open a Fresh Lab"*). Secondary is accessed via `.watch-lab-entry__caret` click + `LAB_ENTRY_SECONDARY_TITLE` title lookup — there are no "Open Lab" / "Continue" text queries. Asserts **disclosure semantics, not menu semantics**: caret carries `aria-haspopup="true"` and the popover is `role="group"` with `aria-label` derived from `LAB_ENTRY_CARET_LABEL`; neither `role="menu"` nor `role="menuitem"` appears anywhere. Also pins hover-tooltip ↔ popover mutual exclusion (`data-menu-open="true"` gate) and the disabled-primary reason copy via `LAB_ENTRY_PRIMARY_DISABLED_REASON`. Enforces the click-ownership contract (primary anchor vs. secondary anchor paths do not double-fire). |
| `watch-lab-entry-new-tab.test.tsx` | 4 cases. `target=_blank` behavior on both surfaces (primary pill + disclosure-secondary anchor). Secondary access follows the same caret-open-then-query pattern. |
| `watch-lab-entry-gate.test.ts` | P1 seed-identity cache invalidation (cache must flush when the underlying seed changes) + P2 fail-closed click (click path refuses to navigate when the seed build fails rather than leaking a stale href). |
| `watch-lab-entry-href-cache.test.ts` | Cache + debounce contract: href is memoized per seed identity and recomputation is debounced across rapid state changes. The identity tuple includes a quantized `cameraIdentity` (`POSITION_Q = 0.01`, `FOV_Q = 0.5`) alongside the other four components; cache hits require ALL 5 identity components to match, and the click path re-reads live camera and purges stale tokens via `removeWatchToLabHandoff` on miss. |
| `watch-lab-entry-write-failure.test.ts` | Storage-unavailable vs. quota-exceeded copy surfacing — the two `WatchHandoffWriteError` classes must render distinct user-facing strings. |
| `watch-lab-toast-aria.test.tsx` | ARIA contract on both toast surfaces (live-region + role). |

#### Atom-Interaction Hint (`tests/unit/`)

| File | Purpose |
|------|---------|
| `hint-target.test.ts` | Target-atom selection for the Lab "Drag any atom to start" floating bubble. Pins the 2D convex-hull + centermost-pick algorithm (picks a stable referent atom so the bubble does not jitter between frames) and the camera-projection inputs. Tail-less design is assumed — the test does not assert a tail geometry. |

##### Coverage Gap: Primary-Tooltip Auto-Cue Milestone Hook

The Watch primary tooltip ("Interact From Here") fires a 5-second 1-3-1 auto-cue animation on two timeline milestones (50% and 100%) at most once per file each. The semantics — once-per-file (resets on `fileIdentity` change), arm-then-fire (milestone must be observed with `currentTimePs < threshold` before it can fire; deep-links that resume past a threshold do NOT cue), and paused-seek coalescing (a 10%→95% scrub while paused fires the end cue only) — all live in `watch/js/hooks/use-timeline-milestone-tokens.ts`. **This hook is currently not unit-tested.** Future coverage should exercise: file-identity reset, arm-before-fire gating, end-first coalescing of simultaneous milestones, and the reduced-motion CSS-var collapse. The shared lower-level primitive `src/ui/use-timed-cue.ts` (`useTimedCue({ triggerToken, durationMs })`) is likewise a candidate for coverage.

#### Playback + Document Helpers (`tests/unit/`)

| File | Purpose |
|------|---------|
| `watch-lab-playback-helpers.test.ts` | Playback model helpers used by the seed builder to select the frame-at-time slice. |
| `watch-lab-document-service.test.ts` | `shareCode` metadata plumbing through the document service (the seed preserves the originating capsule's share-code on the handoff payload). |

#### Lab-Side Hydrate (`tests/unit/`)

| File | Purpose |
|------|---------|
| `lab-scene-hydrate-from-seed.test.ts` | Transactional hydrate against a seeded scene: success path plus **every rollback reason** (schema mismatch, worker-not-active, renderer-append failure, post-append invariant failure). Includes the worker not-active fail-fast rollback — if the worker is not ready when hydrate runs, the transaction must roll back cleanly without leaving a half-applied scene. Also covers camera-snapshot apply (falls back to `renderer.fitCamera()` when `seed.camera === null`); color re-indexing via Watch atomId → display slot (seed.atoms[i].id) → Lab atomId (tracker `assignedIds[slot]`), dropping atoms whose full resolution chain fails; REPLACE-semantics color restore (unconditional on success, empty array wipes prior Lab state); rollback restores both color (`restoreAssignments(capture)`) and camera (`applyOrbitCameraSnapshot(capture.camera)`); and rollback sub-failures accumulated into `cause: { originatingCause, rollbackSubFailures }` rather than swallowed. The `appendMolecule` velocity-delivery contract is validated: the worker writes `engine.vel.set(velocities, atomOffset*3)` BEFORE `sceneVersion++`, so the first post-append snapshot carries real momentum (previously the reconciler zeroed main-thread velocities on the first frameResult); length-mismatch warns rather than silently clipping. |
| `scene-runtime-hydrate-wrapper.test.ts` | Adapter layer that wraps the hydrate call for scene-runtime consumers. Covers deps missing, worker rejection, hydration-lock set/clear semantics, and the pause-sync-await contract (pause must be awaited before the mutate step; otherwise a pending physics tick can race the hydrate). |

#### Registry Snapshots (`tests/unit/`)

| File | Purpose |
|------|---------|
| `atom-metadata-registry-snapshot.test.ts` | Atom-metadata registry snapshot/restore roundtrip (used to re-seat authored atom metadata across a hydrate). |
| `timeline-atom-identity-snapshot.test.ts` | Timeline atom-identity snapshot/restore roundtrip (stable IDs survive the seed → hydrate path). |
| `bonded-group-appearance-runtime-snapshot.test.ts` | Bonded-group appearance runtime `snapshotAssignments()` + `restoreAssignments(prev)` roundtrip. Pins REPLACE semantics (not additive), structural deep-copy isolation, and use as the rollback capture/restore for color state across a Watch→Lab hydrate. |

#### Lab Entry Contrast (`tests/unit/`)

| File | Purpose |
|------|---------|
| `lab-entry-contrast.test.ts` | §9.1.1 contrast table. Re-derives WCAG 2.1 contrast ratios from the live `THEMES` object under both light and dark themes and fails CI on any target regression. This is an algorithmic re-derivation, not a snapshot — palette edits that drop contrast below the §9.1.1 target will surface here rather than needing a manual audit. |

#### Hydrate-Related Regression Guards (extensions to existing files)

| File | What changed |
|------|--------------|
| `frame-runtime.test.ts` | Now includes a hydration-lock gating assertion: while the hydration lock is set, the per-frame pipeline must not advance physics (the lock is the atomic boundary for a seed-hydrate transaction). |
| `physics-checkpoint.test.ts` | New tests for `clearScene + restoreCheckpoint` workspace allocation (ensures workspace is re-provisioned, not reused with stale sizes) and for empty-atoms init not null-dereffing (previously crashed on zero-atom restore). |
| `physics-timing.test.ts` | Three-arg `setTimeConfig` damping-window fidelity: the damping window must be preserved exactly when the third argument is passed through the seed's `workerConfig`. |
| `worker-bridge-direct.test.ts` | `latestSnapshot` cleared on `restoreState` start, and cleared again on mutation acknowledgement when `sceneVersion` advances. Prevents a hydrated scene from inheriting a stale pre-hydrate snapshot. |

#### Watch→Lab Entry E2E (`tests/e2e/watch-lab-entry.spec.ts`)

| File | Tests | What it validates |
|------|------:|-------------------|
| `watch-lab-entry.spec.ts` | 12 | Full Watch→Lab entry contract, including the two regression-lock invariants and the camera-continuity spec documented below. The secondary anchor is a disclosure popover entry; specs that need it first click the caret (`await page.locator('.watch-lab-entry__caret').click()`) and then resolve the option inside `.watch-lab-entry__secondary`. |

Fixtures: `tests/e2e/fixtures/watch-two-atom.json` (full-history) and `tests/e2e/fixtures/watch-capsule-bug-repro.json` (capsule). The capsule fixture is the creative-seed variant that reproduced the original hydrate regression and is retained specifically to guard against re-introduction.

Test hooks: `_watchOpenFile(text, name)`, `_watchScrub(timePs)`, and `_getWatchCameraSnapshot` are all gated on `?e2e=1` (Watch side). `_getLabCameraSnapshot` is exposed **unconditionally** on the Lab side — the Lab tab opened from Watch does not carry the `?e2e=1` query param, so the observability hook must be available without the gate for camera-continuity assertions to work.

Covered cases:

1. **Primary "Interact From Here" anchor targets `/lab/`** — baseline anchor wiring for the accent-filled primary pill. The secondary ("Open a Fresh Lab") anchor is reached through the caret-disclosure popover (`.watch-lab-entry__caret` → `.watch-lab-entry__secondary`) and is asserted the same way.
2. **Stale handoff → toast + URL scrubbed + ARIA** — stale `?entry=…` token produces the recovery toast, the URL is scrubbed so reload does not re-trigger it, and the toast has correct ARIA.
3. **Missing-entry → distinct "no longer available" toast** — the missing-entry path must use a different string than the stale path (users can tell them apart).
4. **Malformed handoff → silent (console.warn only)** — garbage tokens do not pop a toast; they log and fall through to a clean default boot.
5. **"Interact From Here" primary enabled as `<a>` for multi-frame fixture** — the primary CTA is a real anchor (not a button) so middle-click / cmd-click produce the expected OS behavior. The disclosure-secondary "Open a Fresh Lab" is likewise a real `<a>` inside the popover (accessed after the caret-open step).
6. **Happy path full-history** — load → scrub → click → Lab hydrates the handoff scene (atom count > 0, handoff query param consumed).
7. **Pending-handoff stale-token fallback** — when the token is stale at boot, the fallback path loads the default scene (user is never stranded on a blank canvas).
8. **Pending-handoff boot NEVER renders default C60 (no flash)** — regression-lock. Polls `atomCount` every 50ms through boot and asserts no sample ever equals 60 (the default-C60 size). Catches any transient render of the default scene between token consume and seed apply; even a single flashed frame of the wrong scene would fail this.
9. **Worker init race regression** — regression-lock. After the handoff query param is scrubbed (hydrate committed), polls `atomCount` for 2s and asserts it stays at the seed count. Catches the class of bug where a late worker init message reverts the hydrated scene back to the default.
10. **Happy path capsule (approximated-velocities variant)** — capsule bug-repro fixture; scene must stay stable for 500ms post-commit (no late mutation).
11. **No `?from=watch` → silent normal boot** — the Lab entry surface must be inert when the query flag is absent.
12. **Camera continuity Watch→Lab** — uses `_getWatchCameraSnapshot` (gated `?e2e=1`) and `_getLabCameraSnapshot` (unconditional) to assert that the Lab orbit pose after hydrate matches the Watch pose at the moment the primary "Interact From Here" pill was clicked, within the quantization tolerance. Guards the `applyOrbitCameraSnapshot` path (cancels animation, sets camera + target + up, updates projection matrix if FOV changed, recomputes focus distance) and the live camera re-read on the click path.

##### Regression-Lock Invariants (prose)

Two tests in the spec above exist specifically as regression locks — they do not exercise a feature, they guard against a class of bug that has historically been easy to re-introduce. Both are written as polling invariants because the bug-class is a transient visible state that a single-shot assertion would miss.

- **"Pending-handoff boot: default C60 is NEVER rendered."** Before the seed is applied, Lab boot must not render the default scene at all — not even for one frame. The test polls the window's atom-count hook every 50ms across the full boot window and fails if any sample equals 60 (the default-C60 atom count). This is strictly stronger than asserting the final state: it catches any intermediate flash of the default scene between token consume and seed apply. Any change that re-introduces a "render default, then swap" boot path will fail this.
- **"Worker init race: hydrated scene does not revert."** After the `handoff` URL query param is scrubbed (signaling the hydrate committed), the test polls `atomCount` for 2 full seconds and asserts it never diverges from the seed count. This catches the specific class of bug where a worker-init completion message arrives after hydrate and naively resets the scene — the test fails the moment the atom count drifts back toward the default.

##### E2E Conventions Reinforced by This Spec

The Watch→Lab spec is representative of the current E2E pattern and contributor-facing examples should reflect these conventions:

- **Console capture on failure** — specs attach a `page.on('console', …)` collector so that when a polling invariant trips, the test failure message includes the browser console transcript. Without this, "atom count was 60 at t=250ms" is uninvestigable.
- **Sample-trace error messages** — polling assertions (as in tests 8 and 9) format the failure message with the full sample trace, not just the offending sample. The trace makes it obvious whether the bug is a single-frame flash, a steady-state regression, or a drift-over-time race.
- **Polling invariants for transient states** — when the bug class is a transient wrong state (not a final-state mismatch), the test must poll across the window in which the wrong state could appear. A single `expect(atomCount).toBe(n)` right after the URL handoff token is scrubbed would pass even while the bug is present.

## Frontend Smoke Test

Manual verification checklist for the interactive page (`lab/index.html`). Run after any changes to `lab/` code.

### Setup
```bash
npm run app:serve
# Open http://localhost:8788/lab/
```

`npm run app:serve` is the canonical local-dev entrypoint: it runs
`npm run build → npm run cf:d1:migrate → npx wrangler pages dev dist --port 8788`
in sequence, which is required because Lab boots against Pages Functions
at `/api/*` and `/auth/*` (a bare `npm run dev` / vite-only server 404s on
those routes and Lab silently fails to hydrate).

### Checklist

| # | Test | Expected |
|---|------|----------|
| 1 | Page loads | C60 renders with atoms and bonds visible |
| 2 | Switch structure | New structure loads, old one clears completely |
| 3 | Atom mode: left-drag on atom | Highlight (cool blue), spring line shows, atom follows cursor |
| 3a | Hold pointer still during drag | Force line endpoint keeps updating as atom moves under spring tension (per-frame reprojection) |
| 4 | Release drag | Atom retains momentum, structure vibrates naturally |
| 5 | Ctrl+click on atom (any mode) | Molecule rotates, spring line visible |
| 6 | Right-drag | Camera orbits around structure |
| 7 | Scroll wheel | Camera zooms in/out |
| 8 | Reset View (in Settings sheet Scene section) | Camera returns to default front view |
| 9 | Help drill-in | Tap Help in settings → help page appears. Tap Back → returns to settings. |
| 10 | Theme toggle | Dark/light switch — all UI elements adapt |
| 11 | Settings sheet | Sliders in Simulation/Interaction sections adjust drag strength, rotation strength, and damping in real-time |
| 11a | Damping at 0 | After drag/rotate, molecule vibrates indefinitely (NVE) |
| 11b | Damping raised | Vibration decays visibly; at max, motion stops almost instantly |
| 12 | Large structure (C720) | Loads without crash, interaction works at reduced FPS |
| 13 | XYZ axes indicator | Visible in corner, rotates with camera |
| 14 | Hint text | Fades on first atom interaction |
| 15 | Move mode: hover atom | Full bonded group highlights (not just the hovered atom) |
| 15a | Move mode: drag atom | Entire molecule translates, group highlight + blue force line |
| 15b | Release in Move mode, damping=0 | Molecule coasts (approximately NVE) |
| 15c | Release in Move mode, damping>0 | Motion decays visibly |
| 16 | Rotate mode: hover atom | Full bonded group highlights |
| 16a | Rotate mode: 1-finger drag on atom (mobile) | Molecule rotates (torque), group highlight |
| 17 | Switch mode during idle | No side effects, next interaction uses new mode |
| 18 | Ctrl+click in Atom/Move mode | Rotates molecule (shortcut override) |
| 19 | Move mode on C60 vs C720 | Both respond without being sluggish or explosive (subjective) |
| 20 | Mobile: 2-finger gesture in any mode | Always camera pinch/pan |
| 21 | Mobile: add 2nd finger during interaction | Active interaction cancelled, camera takes over |
| 22 | Load new structure while in Move mode | Mode persists, new structure responds to Move |
| 23 | Move mode: drag atom on intact C60 | Entire molecule translates (all atoms in one component) |
| 24 | Atom mode: pull atom until bond breaks, then Move mode on main fragment | Only the connected fragment translates, detached atoms stay |
| 25 | Rotate mode on intact structure | Molecule rotates normally |
| 26 | Rotate mode after fragmenting structure | Only the picked fragment rotates |
| 27 | Reset after fragmentation, Move mode | Full molecule translates again (components reset with bonds) |
| 28 | Atom mode: push two fragments close until bonds form, then Move mode | Merged fragment moves as one patch |
| 29 | Move mode: vigorous drag causing bonds to break mid-interaction | Detached atoms stop following after next bond refresh (~0.08s). Expected behavior |
| 30 | Move/Rotate near bond cutoff distance | Patch scope may change as bonds flicker. Expected behavior with cutoff-only detection (no hysteresis) |
| 31 | Add Molecule to empty scene | Preview appears centered in current viewport, Place creates real molecule |
| 32 | Add second molecule | Preview appears tangent to existing molecule, adjacent in current view |
| 33 | Drag preview, then Place | Preview becomes real atoms, simulation resumes |
| 34 | Cancel during placement | Preview removed, scene unchanged |
| 35 | Move mode: drag molecule A into molecule B | Collision occurs, Tersoff forces engage |
| 36 | Move mode on molecule A in 2-molecule scene | Only A's component translates (component-aware) |
| 37 | Clear playground | All molecules removed, scene empty |
| 38 | Camera during placement | Right-drag orbits, scroll zooms. Preview reprojects after camera gesture |
| 39 | Esc during placement (desktop) | Placement cancelled |
| 40 | Add molecule with rotated camera | Preview tangent direction adapts to camera orientation |
| 41 | Start preview drag, add 2nd finger for camera | Preview drag cancels cleanly, camera takes over, no state leaks |
| 42 | Clear playground, then orbit camera | Camera orbits around origin (0,0,0), not stale scene center |
| 43 | Clear playground, then Add Molecule | Preview appears centered in viewport at molecule-appropriate depth |
| 44 | Clear + Add + Atom drag | First molecule after Clear responds to all interaction modes correctly |
| 45 | Switch structure during placement | Select different structure in chooser sheet while preview is active — old preview replaced cleanly, new preview appears |
| 46a | Place confirms preview | Tap dock Add (shows "Place") while preview active — preview commits to scene, dock exits placement mode |
| 46b | Chooser replaces preview | Open chooser and select a different structure while preview is active — old preview replaced, new preview appears |
| 47 | Rapid structure switching in chooser sheet | Click two different structures quickly — only the last-clicked preview appears, first is discarded |
| 48 | Stale load failure during switching | If first structure fails to load after second was selected, error does not corrupt the active preview |
| 49 | Clear during pending preview load | Click Add Molecule, select structure, then Clear before preview appears — no preview appears after Clear |
| 50 | Escape during pending preview load (desktop) | Press Escape while structure is loading — load is cancelled, no preview appears |
| 51 | Preview drag on elongated structure (e.g., CNT) near bond region | Drag starts predictably; nearby atom is preferred when visually intended (CONFIG.picker.previewAtomPreference threshold) |

#### Placement Camera Framing
- [ ] Add a molecule to an existing scene → camera should NOT jump, preview and scene both visible
- [ ] If preview already fits in view → camera should not move at all
- [ ] Drag preview toward edge → camera smoothly makes room (target shift preferred over zoom-out)
- [ ] Drag preview past canvas boundary → drag continues (pointer capture), preview follows cursor
- [ ] Release drag → preview stays in place, camera settles smoothly
- [ ] Click Place → camera does NOT snap to new molecule (Policy A: no focus retarget on commit)
- [ ] After Place, click Center → camera animates to newly placed molecule (explicit focus works)

#### Review Mode UI Lock
- [ ] Enter review mode by scrubbing timeline → dock Add, Atom/Move/Rotate, Pause/Resume appear visually disabled
- [ ] Desktop: hover over disabled Add → tooltip shows "Review mode is read-only..."
- [ ] Desktop: hover over disabled Atom/Move/Rotate segment → each shows tooltip
- [ ] Mobile: tap disabled Add → transient status hint appears explaining review exits
- [ ] Mobile: tap disabled mode segment → same status hint
- [ ] Settings sheet: Add Molecule and Clear appear disabled with hint on hover/tap
- [ ] Structure chooser (if open): rows appear locked, click shows hint instead of placing
- [ ] Click Live → exit review, all controls re-enabled immediately
- [ ] Click Restart → exit review, controls re-enabled, simulation resumes from scrub point

#### Dock Stability
- [ ] Toggle Pause ↔ Resume repeatedly → Add, mode selector, and Settings do not shift
- [ ] Atom / Move / Rotate spacing looks identical in live and review modes

#### Bonded Group Architecture
- [ ] Bonded-group panel visible and expanded by default in live mode
- [ ] Bonded-group panel visible in review mode with historical topology
- [ ] Hover preview works in both live and review modes
- [ ] Persistent click-to-select is hidden (canTrackBondedGroupHighlight: false)
- [ ] Color editing, Center, Follow work in both live and review
- [ ] Theme change preserves authored atom color overrides
- [ ] Structure append preserves authored atom color overrides

| 52 | Speed 0.5x | Motion visibly slower |
| 53 | Speed 2x | Visibly faster, stable |
| 54 | Max mode on C720 | Tracks live max |
| 55 | Pause | Physics freezes, camera works |
| 56 | Resume | No catch-up burst |
| 57 | Tab switch/return | No burst |
| 58 | Speed change mid-interaction | No position jump |
| 59 | maxSpeed < 0.5x heavy scene | Fixed buttons disabled, Max still works |
| 60 | Add molecule while at 4x speed | Warm-up re-entered, speed caps at 1x briefly, buttons update |
| 61 | Clear heavy scene, add small molecule | No stale overload state, speed adapts to new workload |
| 62 | Sustained overload → scene lightens | maxSpeed recovers smoothly over ~1s |
| 63 | Warm-up: fixed speed buttons | Disabled/dimmed during warm-up, Max still enabled |
| 64 | Warm-up: Estimating status | Shows "Estimating..." after clear + add or molecule append |
| 65 | Pause/resume visual update | Screen updates immediately on toggle (forced render) |
| 66 | Placement enter/exit visual update | Screen updates immediately (forced render) |
| 67 | Mobile: tap status area | Diagnostics (ms/fps) expand for ~5s, then collapse |
| 68 | Drag atom far from molecule | Simulation stays responsive (no sparse-domain slowdown) |
| 69 | Fragment molecule into scattered atoms | No FPS drop from spread atoms |
| 70 | Two molecules placed far apart | Smooth interaction, no stutter |
| 71 | Move molecules together and apart repeatedly | No stutter or memory growth |
| 72 | Contain mode: fling atom outward | Atom bounces back from invisible boundary, stays in scene |
| 73 | Remove mode: fling atom outward | Atom deleted when it crosses boundary, atom count decreases |
| 74 | Remove mode: fling fragment (bonded pair) | Both atoms in fragment deleted when past boundary |
| 75 | Atom count in Settings sheet | Placed row shows historical total. Active row appears after boundary removal showing e.g. "57 (3 removed)" |
| 76 | Add molecule after Remove empties scene | Wall resets, new molecule gets fresh boundary |
| 77 | Switch Contain → Remove during flight | Atom that was bouncing back now flies freely and gets deleted |
| 78 | Boundary toggle in Settings sheet (Boundary section) | Contain/Remove buttons toggle correctly, visual feedback |

**Transaction rollback verification:**

- **Automated physics tests:** open `lab/test-rollback.html` in a browser (requires serving from repo root). Tests physics append/rollback/clear/invariants/components directly against the real `PhysicsEngine` class. Does NOT test the full `commitMolecule` orchestration path (renderer + session state coordination).
- **Manual commit-path testing:** set `CONFIG.debug.failAfterPhysicsAppend = true` or `CONFIG.debug.failRendererAppend = true` in config.ts, then place a molecule via the UI. Verify: placement fails gracefully, no orphan meshes, physics atom count restored, scene molecule list unchanged. Set `CONFIG.debug.assertions = true` to enable post-append invariant checks inside the rollback-protected block.
- **Coverage summary:** physics-level transaction safety is automated; full commit-path rollback (physics + renderer + session) requires manual flag toggling and UI interaction. Both complement manual smoke tests for interaction flow.
- **Future milestone — full integration test harness:** automate commitMolecule transaction path (physics + renderer + session coordination), preview hit-preference threshold tests (atom-vs-bond within/outside CONFIG.picker.previewAtomPreference), and remove CDN dependency from test page. Tracked as a separate infrastructure investment.

### Manual Runtime Checks

After changes to UI controllers or main.ts composition:

| # | Check | How to verify |
|---|-------|--------------|
| A1 | Overlay exclusivity | Open settings → tap Add → settings closes, chooser opens |
| A2 | Dock placement mode | Start placement → Place/Cancel in dock, Mode hidden, Pause/Settings disabled |
| A3 | Device-mode switch | Switch between device modes (responsive emulation or window resize) → overlays close on mode change, dock/sheet layout adapts |
| A4 | Theme across all panels | Toggle theme in settings → all panels adapt |
| A5 | Sheet close transition | Close sheet → no stale `sheet-visible` class after transition |
| A6a | Canvas dismiss (desktop) | Open settings → click canvas → sheet closes, no camera interaction starts. Click FPS/hint/info → sheet stays open |
| A6b | Backdrop dismiss (phone/tablet) | Open settings on phone/tablet → tap dimmed backdrop outside dock → sheet closes |
| A7 | Dock interactive with sheet open | Open settings → tap Pause → sheet stays open, pause toggles. Tap mode seg → mode changes, sheet stays |
| A8 | Chooser Recent row | Place a molecule → tap Add → chooser opens with pinned "Recent" row at top → tap it → placement starts |
| A9 | Hint above dock | On tablet/desktop, hint text does not overlap the floating dock pill |
| A10 | Triad sizing | On desktop, axis triad is visibly larger (~140–200px). On tablet/desktop, triad is corner-anchored, not pushed up by dock |
| A11 | Placement coachmark | Tap Add → pick structure → "Tap Place to add it" appears in hint area → tap Place → coachmark disappears |
| A12 | Coachmark + overlay | During placement, open Settings → coachmark hides immediately (no fade), no generic hint text visible under sheet |
| A13 | Text Size setting | Settings → Appearance → toggle Large → all text visibly larger. Toggle Normal → text returns to baseline. Segmented indicator aligned at both sizes |
| A14 | Info card reduced | Top-left card shows only status text (no "NanoToybox" title), smaller padding |

### Mobile Camera Orbit (Phase 1A)

Test on phone and iPad after changes to triad interaction or input.ts touch handling:

| # | Check | How to verify |
|---|---|---|
| B1 | Triad visible and touchable | On phone, triad is large enough to touch confidently (96-120px). Arrows and labels are clearly visible. |
| B2 | Triad drag orbits camera | 1-finger drag on triad rotates the camera smoothly. Drag-up = camera rotates down ("dragging the world"). |
| B3 | Atom interaction preserved | 1-finger drag on atom still triggers current interaction mode (Atom/Move/Rotate). No false triad captures. |
| B4 | 2-finger unchanged | Pinch to zoom and 2-finger drag to pan still work. 2nd finger during triad drag cancels triad and hands off. |
| B5 | Coachmark timing | On first mobile session: "Drag triad to rotate view" appears after ~3s of idle. Does NOT appear if user interacts immediately, or if sheet/placement is open. |
| B6 | Triad pulse | When coachmark appears, triad brightens briefly then fades back (~600ms). Visual tie between text and control. |
| B7 | First-attempt success | A first-time user can find the triad and drag it successfully on their first try without reading help text. |
| B8 | Desktop unaffected | On desktop, right-drag still orbits via OrbitControls. Triad is smaller (desktop size). No coachmark shown. |

### Mobile Camera Orbit (Phase 1B — Background Orbit)

Test on phone and iPad after changes to background orbit or coachmark v2:

| # | Check | How to verify |
|---|---|---|
| C1 | Background miss orbits | 1-finger drag on empty space (no atom) rotates the camera. Same drag direction as triad. |
| C2 | Atom hit still wins | 1-finger drag on an atom triggers interaction (drag/move/rotate), not camera orbit. No ambiguity. |
| C3 | Background orbit cue | When background orbit starts, triad brightens. When finger lifts, triad returns to normal intensity. |
| C4 | 2nd finger cancels | During background orbit, place a second finger → orbit cancels, 2-finger zoom/pan takes over. Triad cue clears. |
| C5 | Coachmark v2 for returning users | Clear mobile-orbit-v1 but not v2 from localStorage. Reload → v2 coachmark shows: "Drag triad anytime · Drag clear background when available". Does NOT show if v1 hasn't been dismissed yet. |
| C6 | Parity check | Same 100px drag on triad and on empty space produces identical rotation (both use applyOrbitDelta). Verify on phone and iPad. No momentum difference — both paths stop immediately on finger lift. |

**Orbit parity note:** Both triad drag and background orbit use the same
`applyOrbitDelta(dx, dy)` function with `CONFIG.orbit.rotateSpeed = 0.005` rad/px.
They are guaranteed identical — same code path, same constant. OrbitControls is NOT
used for mobile 1-finger orbit; it only handles desktop right-drag and 2-finger
mobile zoom/pan. Desktop right-drag speed (`controls.rotateSpeed`) is set independently
in `renderer.ts` and is decoupled from mobile orbit speed.

### Mobile Camera Orbit (Phase 2 — Canonical View Snaps)

Test on phone and iPad after changes to axis snap, double-tap reset, or tap-intent highlight:

| # | Check | How to verify |
|---|---|---|
| D1 | Single tap snaps to nearest axis | Rotate triad to show X prominently → tap near X tip → camera animates to +X view over ~300ms |
| D2 | All 6 views reachable | Tap near each of ±X, ±Y, ±Z endpoints → camera snaps to that view. Negative tails work when visible. |
| D3 | Double-tap center resets | Double-tap the center of the triad → camera animates to default front view (0, 0, 15) |
| D4 | Tap-intent highlight | Touch and hold triad (>150ms, don't move) → nearest axis endpoint shows a white sphere highlight. Start dragging → highlight disappears. |
| D5 | Drag still works | Drag on triad orbits normally. Tap-intent highlight does not interfere with drag gesture. |
| D6 | Center home glyph | Small gray dot visible at triad center — indicates double-tap reset target. |
| D7 | Snap preserves distance | After snap, camera distance from target is the same as before snap. |
| D8 | Sub-threshold jitter = tap only | Touch triad, move < 5px, release → camera does NOT orbit during the gesture. Only snap fires on release. |
| D9 | Non-center double-tap = two snaps | Double-tap near +X tip → two snap gestures (not a reset). Only double-tap in the center zone (near home glyph) triggers reset. |

### Camera Behavior (Quaternion Orbit + Parity)

Test after changes to applyOrbitDelta, resetView, fitCamera, or desktop input routing:

| # | Check | How to verify |
|---|---|---|
| E1 | Over-the-top orbit | Drag triad upward past the north pole → camera continues smoothly over the top, no wall or snap. |
| E2 | Reset after over-the-top | After E1, call resetView (double-tap triad center) → camera returns to default front view with level horizon (up=Y). |
| E3 | fitCamera levels camera | Load a structure while camera is in a rolled orientation → fitCamera levels the camera (up=Y) and centers on structure. |
| E4 | Desktop/mobile orbit parity | On desktop, right-drag produces the same rotation direction and speed as mobile triad drag or background orbit. |
| E5 | Desktop orbit at canvas edge | Right-drag orbit, move pointer outside canvas → orbit continues (pointer capture). Release mouse → orbit ends cleanly. |
| E6 | Snap after free rotation | Orbit to an arbitrary orientation, tap axis end → snap works correctly from any starting orientation. |

### Object View Controls and Onboarding

Test after changes to CameraControls, OnboardingOverlay, or object-view controls.

#### A. Manual Behavior Checks

| # | Check | How to verify |
|---|---|---|
| F1 | Center button | Tap Center → camera frames the focused molecule (or nearest if none focused). |
| F2 | Follow button (enable) | Tap Follow → resolves a target and begins continuous tracking. Button shows active visual state. |
| F3 | Follow button (disable) | While following, tap Follow → tracking stops. Button returns to inactive state. |
| F4 | Follow with no molecules | Tap Follow on empty scene → nothing happens (follow stays off). |
| F5 | Onboarding overlay appears | On page load, after scene content loads, a welcome overlay appears centered on screen. |
| F6 | Onboarding dismisses on tap | Tap anywhere on the overlay → it animates toward the Settings button and disappears. |
| F7 | Onboarding reappears on reload | After dismissing, reload the page → overlay reappears. |
| F8 | Settings help includes Object View | Open Settings > Controls → "Object View" section lists Center and Follow. |
| F9 | Progressive coachmark: snap hint | After first orbit drag on mobile → "Tap an axis end on the triad to snap to that view" appears (once per session, idle-gated). |
| F10 | Coachmark + overlay exclusivity | Coachmark visible → open settings → coachmark dismissed immediately. |
| | **F11–F18 require `CONFIG.camera.freeLookEnabled = true` (disabled by default)** | |
| F11 | Mode toggle | When freeLookEnabled: tap mode button toggles "Free"/"Orbit". When disabled (default): no mode button renders. |
| F12 | Return to Object (Free-Look) | In Free-Look, tap Return → camera flies to last focused molecule, returns to Orbit mode. |
| F13 | Free-Look look-around | In Free-Look, drag background (mobile) or right-drag (desktop) → camera yaw/pitch in place. |
| F14 | Free-Look WASD (desktop) | In Free-Look, WASD translates camera. Keys ignored when input/button/sheet focused. |
| F15 | Free-Look R key (desktop) | In Free-Look, R levels the camera. Ignored when form control focused. |
| F16 | Free-Look Freeze | When moving in Free-Look, Freeze button (✕) appears → tap stops flight velocity. |
| F17 | Free-Look recovery: Esc | In Free-Look with nothing else open, Esc returns to Orbit. |
| F18 | Free-Look axis-snap disabled | In Free-Look, tap axis end on triad → no snap. |
| F19 | Free-Look focus-select | In Free-Look, tap/click atom → molecule marked as orbit target. No drag interaction starts. |
| F20 | Keyboard guard | In Free-Look, focus a settings slider → type WASD → camera does NOT move. |

#### B. Engineering Verification

| # | Invariant | What to check |
|---|-----------|--------------|
| G1 | Follow returns false with no molecules | `onEnableFollow()` returns false and `orbitFollowEnabled` stays false when molecule list is empty. |
| G2 | Onboarding readiness gate | `isOnboardingEligible()` requires atomCount > 0, no open sheets, no placement, no review mode. |
| G3 | Onboarding E2E suppression | Adding `?e2e=1` to the URL suppresses the onboarding overlay entirely. |
| G4 | Sink animation timing | `SINK_DURATION_MS` in OnboardingOverlay.tsx matches CSS `--onboarding-sink-duration`. |

### E2E Test Conventions

- **`gotoApp(page, baseURL, path)`** from `tests/e2e/helpers.ts` — appends `?e2e=1` for onboarding suppression. All `/lab/` navigation in non-onboarding specs must use `gotoApp()`.
- **`dismissOnboardingIfPresent(page)`** — local helper in `camera-onboarding.spec.ts` that waits for the overlay, clicks to dismiss, and waits for removal. Used by onboarding tests that need the overlay to appear first.
- **Why:** Page-lifetime onboarding blocks pointer events until dismissed. Tests that don't test onboarding need the `?e2e=1` bypass via `gotoApp()`.

### Visual-regression (`tests/e2e/thumb-visual.spec.ts`) platform policy

The account-row thumb visual gate uses Playwright's `toHaveScreenshot()` against committed PNG baselines under `tests/e2e/thumb-visual.spec.ts-snapshots/`. Baselines are **Chromium + Darwin only today** — `*-chromium-darwin.png`.

- **Local (macOS):** runs as a hard gate. `npm run test:e2e -- thumb-visual.spec.ts` compares pixels against the committed PNGs with a 2% pixel-ratio tolerance. The committed baselines live at `tests/e2e/thumb-visual.spec.ts-snapshots/{c60,glycine,graphene}-chromium-darwin.png` and were last regenerated after the atoms-re-enabled + cylinder-bond refactor (the rendered bytes changed; the SVG snapshot under `tests/unit/__snapshots__/current-thumb-render.test.tsx.snap` was refreshed in the same pass).
- **Linux / CI:** the spec self-skips via `test.skip(process.platform !== 'darwin', …)` — Playwright's default behavior on a missing baseline is to fail, so unconditional Linux runs would turn clean CI red. The vitest render gate (`current-thumb-render.test.tsx`) still runs cross-platform and locks the SVG source, so the Linux skip only drops the pixel-level compare. Adding Linux baselines is a future choice gated on a pinned CI image.
- **Single source of truth:** the SVG comes from the shared helper in `src/share/__fixtures__/thumb-visual-fixtures.tsx`. Vitest writes `tests/e2e/fixtures/thumb-visual/*.html` on every pass; Playwright navigates via `file://`. No snapshot-text scraping.
- **Workflow when the renderer changes:**
  1. `npx vitest run --update tests/unit/current-thumb-render.test.tsx` refreshes the SVG snapshot AND rewrites the HTML harnesses.
  2. `npx playwright test tests/e2e/thumb-visual.spec.ts --update-snapshots` refreshes the PNG baselines on the current platform.
  3. Commit both changes together.

### Code Review Invariants

Check during PRs that modify controller modules:

| # | Invariant | What to check |
|---|-----------|--------------|
| R1 | No duplicate listeners | Each DOM element has one event handler per event type |
| R2 | Controller destroy() complete | Every addEventListener has matching removeEventListener in destroy() |
| R3 | State ownership respected | New state writes go through the authoritative writer (see architecture.md) |
| R4 | No controller cross-imports | Controllers don't import each other — use callbacks via main.ts |
| R5 | New globals tracked | Any new window/document listener uses addGlobalListener() |
