# Atom Dojo Architecture

## What This Document Covers <a id="what-this-covers"></a>

This is the architectural guide to Atom Dojo. It explains the major parts of the system, how they interact, where key logic lives, and the most important runtime flows. It is not a complete source index; when a detail belongs in a sibling doc, this page links out rather than copying.

Scope:

- system-level architecture and module ownership boundaries
- Lab, Watch, shared-core, and backend relationships
- key runtime flows (simulation, export, open, handoff, share, auth)
- state-ownership model

Not covered here (linked instead):

- Tersoff physics and validation → [physics.md](physics.md)
- UI/UX behavior, tooltip and entry-control contracts → [viewer.md](viewer.md)
- Test ladder, gates, WebGL checks → [testing.md](testing.md)
- Deployment, endpoints, cron, privacy operator runbook → [operations.md](operations.md)
- Design rationale and history → [decisions.md](decisions.md)
- How to add code → [contributing.md](contributing.md)
- Product terminology → [glossary.md](glossary.md)

**How this document is structured.** The first five sections are orientation: what the system is, how to find things in the repo, and where the major subsystems live. The sixth section covers the backend. The seventh enumerates the key runtime flows — this is the center of the doc for readers who want to understand behavior rather than structure. The remaining sections cover state ownership and further reading.

**Intended reading order.** A new engineer should read §§1–5 to build a mental model, then skim §7 to see how behavior flows through it. Returning readers can jump directly to a flow in §7 or a folder in §4/§5.

## System Overview <a id="system-map"></a>

Atom Dojo is two browser apps that share a TypeScript core and talk to a Cloudflare backend.

```
┌─────────────────────┐      ┌─────────────────────┐
│  Lab (/lab/)        │      │  Watch (/watch/)    │
│  React + Zustand    │      │  React + Zustand    │
│  Three.js renderer  │      │  Three.js renderer  │
│  Web Worker physics │      │  Playback model     │
└──────────┬──────────┘      └──────────┬──────────┘
           │                            │
           │    ┌──────────────────┐    │
           └────┤  src/ (shared)   ├────┘
                │  history, topology,
                │  watch-lab-handoff,
                │  ui, config,
                │  appearance, input,
                │  camera, share, policy
                └──────────┬───────┘
                           │
                  ┌────────┴────────┐
                  │  Cloudflare     │
                  │  Pages Functions│
                  │  D1 + R2        │
                  │  cron worker    │
                  └─────────────────┘
```

Lab owns authoring and the live physics loop. Watch owns playback of exported histories. They cooperate through the **handoff** contract in `src/watch-lab-handoff/`: Watch builds a seed from the current frame, Lab hydrates it into a live session. The backend stores shared capsules and handles auth, moderation, and privacy flows.

### Why two apps

The split is intentional, not incidental. Lab carries the full weight of the live physics loop: a Web Worker running Tersoff, a Three.js renderer with InstancedMesh, a React tree that commands the runtime, and a timeline that records everything for export. Watch is deliberately lighter — it loads a recorded history, interpolates positions between dense frames, and renders. It has no physics worker and no recording surface. Keeping them separate lets the Watch bundle stay small and fast to load from a share link, and lets Lab evolve its authoring surfaces without dragging review users through breaking changes.

### Why a shared core

A single codebase shared by two apps is tempting but brittle. Instead, `src/` holds only **pure, app-agnostic logic** — schema types, topology primitives, handoff contracts, CSS tokens, design-system hooks. Any module that needs a React tree, a Zustand store, or a Three.js scene stays inside the owning app. The test is simple: if a module imports from `lab/js/` or `watch/js/`, it does not belong in `src/`.

### Where the backend sits

Everything beyond the browser is Cloudflare-native. Pages Functions serve the API surface, D1 holds metadata, R2 holds capsule blobs, and a companion Worker runs scheduled reconciliation. The frontend never writes to D1 or R2 directly; every mutation goes through a Function, and every authenticated mutation uses a signed intent rather than a session token.

## Repository Map <a id="repository-map"></a>

| Directory | Class | Purpose |
|---|---|---|
| `lab/` | product | Lab frontend: authoring, simulation, React UI |
| `watch/` | product | Watch frontend: playback, review, handoff trigger |
| `viewer/` | product | Static XYZ viewer (thin; not Watch) |
| `src/` | shared | Pure TypeScript core used by both apps |
| `functions/` | backend | Pages Functions (share links, auth, moderation, preview poster, admin) |
| `workers/` | backend | Cron worker (cleanup, reconciliation) |
| `preview-audit/` | dev | Dev-only Vite workbench for the capsule-preview render pipeline |
| `sim/` | research | Python reference engine and validation |
| `ml/` | research | Force-decomposition and surrogate experiments |
| `migrations/` | data | D1 schema migrations |
| `structures/` | data | Bundled sample structures |
| `public/`, `account/`, `privacy/`, `privacy-request/`, `terms/` | static | Static assets, policy and account HTML surfaces |
| `scripts/` | ops | Build and maintenance scripts (incl. preview-scene backfill) |
| `tests/` | tests | Vitest unit + Playwright E2E |
| `docs/` | docs | This directory |

The repository is deliberately flat at the top level. Product directories (`lab/`, `watch/`, `viewer/`) sit next to shared code (`src/`), backend (`functions/`, `workers/`), and research (`sim/`, `ml/`). Static policy and account surfaces (`account/`, `privacy/`, `privacy-request/`, `terms/`) are plain HTML served directly; they do not go through the React tree. Hidden tooling directories (build outputs, dependency caches, editor and CI artifacts) are excluded from this map on purpose — they describe a developer's working tree, not the product.

## Frontend Architecture <a id="frontend"></a>

Both Lab and Watch follow the same pattern: a React tree renders the UI, a Zustand store holds user-visible state, and a set of imperative runtime modules mutate the renderer, the physics worker, and the playback model. The two layers are deliberately disjoint — React never reaches into the renderer directly, and the runtime never renders React. They communicate only through store writes (runtime → UI) and command calls (UI → runtime).

This split is the main load-bearing decision in the frontend. It lets the test suite verify UI contracts without spinning up physics, and it lets the physics layer run off-thread without coupling to React's render schedule.

### Lab <a id="lab"></a>

Lab is the authoring surface. Users pick a structure from the library, place it on the canvas, drag and rotate to assemble a scene, run the simulation, record a timeline, and export. Every one of those actions touches the store, which renders the UI, and issues commands into the runtime, which mutates the scene and physics.

The composition root is the top-level entry script under `lab/js/` (`lab/js/main.ts`). It wires a worker, a renderer, a store, and every feature runtime module together in a fixed boot order, then hands control to the per-frame pipeline. Each runtime subfolder owns one subsystem; a small set of top-level seams live at the runtime root on purpose (auth, scene, onboarding, UI bindings, publish-size heuristics, prepared-capsule publisher).

| Folder | Owns |
|---|---|
| `lab/js/app/` | Per-frame update pipeline and app lifecycle (frame-runtime, app-lifecycle) |
| `lab/js/runtime/bonded-groups/` | Bonded-cluster projection, highlight, coordinator, follow actions, authored-color runtime |
| `lab/js/runtime/camera/` | Camera target resolution, focus, orbit-follow |
| `lab/js/runtime/handoff/` | Watch→Lab hydration (watch-handoff, hydrate-from-watch-seed) |
| `lab/js/runtime/interaction/` | Input bindings, interaction dispatch, interaction highlight, drag-target refresh |
| `lab/js/runtime/overlay/` | Overlay layout + runtime, atom interaction hints, review-mode action hints |
| `lab/js/runtime/placement/` | Placement solver + camera framing |
| `lab/js/runtime/timeline/` | Simulation timeline, recording orchestrator, context capture, atom identity, history export, restart-state adapter |
| `lab/js/runtime/worker/` | Worker lifecycle, snapshot reconciler, reconciled steps |
| `lab/js/runtime/` (root) | Top-level seams kept at root by design: auth-runtime, scene-runtime, onboarding, ui-bindings, publish-size, publish-capsule-artifacts (`PreparedCapsulePublisher` — shared prepare/publish seam used by both the publish button and the oversize trim-mode flow), build-capsule-artifact, physics-config-store-sync, publish-errors |
| `lab/js/components/` | React UI: dock, settings sheet, structure chooser, status bar, review-locked controls |
| `lab/js/components/timeline/` | Timeline UI family: TimelineBar, clear/export/transfer dialogs, format, hints, mode switch, performance, after-paint |
| `lab/js/store/` | Zustand store + selectors |

Lab is **React-authoritative** for UI: every surface is a React component backed by Zustand; the imperative runtime modules mutate scene/world state and signal React through the store. The Three.js renderer and the physics Web Worker are the two imperative side systems; the React tree never touches them directly.

Where to add code → see [contributing.md#extension-points](contributing.md#extension-points).

The surface area looks broad, but most features land in exactly one subfolder. The hard calls are when a feature spans subsystems (a new bonded-group highlight that also needs a camera target, for example); those cases are covered in the contributing doc.

### Watch <a id="watch"></a>

Watch is the review surface. Users drag in an exported file or land on a share link, scrub the timeline, and — when something interesting is on screen — click **Interact From Here** to hand the scene off to Lab. Watch never simulates; it interpolates between recorded frames and renders.

The composition root sits under `watch/js/app/`, with a facade module that domain folders wire into. The facade is intentionally large by orchestration, not by logic — the domain work lives in `watch/js/document/`, `watch/js/playback/`, `watch/js/view/`, and siblings.

| Folder | Owns |
|---|---|
| `watch/js/app/` | Composition root: main, react-root, watch-controller (facade) |
| `watch/js/document/` | File intake: document service (transactional open), history file loader, full-history + capsule importers |
| `watch/js/playback/` | Time/frame logic: playback model, trajectory interpolation, frame search |
| `watch/js/playback/topology-sources/` | Topology strategies: stored topology, reconstructed topology |
| `watch/js/view/` | Rendering and camera: renderer, camera input, overlay layout, view service, cinematic camera |
| `watch/js/analysis/` | Bonded-group analysis + authored appearance |
| `watch/js/handoff/` | Watch→Lab seed build, handoff URL, storage token |
| `watch/js/settings/` | Settings state and content copy |
| `watch/js/components/` | React UI: app shell, dock, timeline, settings sheet, bonded-groups panel, canvas, open panel, top bar, playback speed, cinematic camera toggle, Lab-entry control |
| `watch/js/hooks/` | UI hooks (currently use-timeline-milestone-tokens) |

Watch mirrors Lab's React-authoritative pattern. The facade under `watch/js/app/` is intentionally large by orchestration, not by logic — and should stay that way.

One consequence of the facade shape: new Watch features add a domain module and a thin facade method, not a branch inside the controller. A new playback strategy registers with the interpolation registry in `watch/js/playback/`; a new settings pane slots into `watch/js/settings/`. The controller grows by orchestration lines, not by conditionals.

Where to add code → see [contributing.md#extension-points](contributing.md#extension-points).

## Shared Core <a id="shared-core"></a>

`src/` is pure TypeScript used by both apps. Imports from `lab/js/` or `watch/js/` into `src/` are allowed; the reverse is not. Lab-to-Watch (or Watch-to-Lab) imports are forbidden — shared logic lives here.

| Folder | Owns |
|---|---|
| `src/history/` | v1 schema types, dense/restart frame shapes, connected-components, bonded-group projection, file builder, unit constants (FS_PER_PS, IMPLAUSIBLE_VELOCITY) |
| `src/topology/` | Bond rules, bond-topology builder, bond-policy resolver |
| `src/watch-lab-handoff/` | handoff contract types and builders — the single source of truth for WatchLabSceneSeed |
| `src/ui/` | Shared design system: CSS tokens, dock/sheet shells, segmented, timeline track, review parity, bonded-group chip, useSheetLifecycle, device-mode helpers |
| `src/config/` | Product defaults: playback speed constants, viewer defaults, bond defaults |
| `src/appearance/` | Bonded-group color assignments (authored overrides, persistence keys) |
| `src/input/` | Camera gesture constants (shared by Lab + Watch camera input) |
| `src/camera/` | Cinematic camera primitives |
| `src/share/` | Share-code format, share-record shape, capsule-preview V2 pipeline (PCA camera → pinhole perspective projection → cluster-selected subject → scene + thumb store → shared render constants → publish-core single-parse boundary), guest Quick Share primitives (feature flag, Turnstile verifier, share-result union, per-IP rate-limit helpers) |
| `src/policy/` | Policy version + acceptance config (consumed by functions and frontend) |
| `src/format/` | Byte formatting helpers |
| `src/types/` | Shared interface declarations |

UI primitives render behavior is documented in [viewer.md](viewer.md); the share-link wire format is documented in [operations.md](operations.md).

Three domains in this list carry more weight than the others:

- `src/history/` is the schema authority. Every exported file, every capsule, every handoff seed flows through the types here. Breaking changes to the v1 schema require careful migration thought; see [decisions.md](decisions.md).
- `src/watch-lab-handoff/` is the contract between the two apps. Both Watch (seed build) and Lab (hydrate) import from it. It is the only place either app should look up the handoff shape.
- `src/ui/` is the design system. Tokens, dock and sheet shells, segmented controls, timeline track, bonded-group chip styling, and lifecycle hooks all live here. Changes ripple into both Lab and Watch; visual regressions in either app often trace back to a change here.
- `src/share/capsule-preview*` is the V2 preview pipeline — projection, canonical camera, scene-store serializer, shared poster/thumb renderers, and the render constants that bind the account thumb and the OG poster to the same geometry. Two callers consume it: the account-row thumbnail (`account/main.tsx`, decorative SVG from the stored `PreviewThumbV1` payload via `CurrentThumbSvg`) and the dynamic poster Function (`functions/api/capsules/[code]/preview/poster.ts`, Satori `ImageResponse` from the stored `PreviewSceneV1` via `functions/_lib/capsule-preview-image.tsx` + `CurrentPosterSceneSvg`). Both render from bytes that were projected once at publish time from the FIRST dense frame of the capsule, so a given capsule looks identical in the account list and as an OG poster. Module roles:
  - `capsule-preview.ts` — `sanitizeCapsuleTitle`, `TEMPLATE_VERSION = 4`, FNV-1a32 helpers (the title sanitizer here is the sole non-Latin fallback boundary, and `TEMPLATE_VERSION` is the dynamic-poster cache-key constant). `TEMPLATE_VERSION = 4` tracks `CURRENT_SCENE_REV = 2` (the perspective-baked poster scene).
  - `capsule-preview-frame.ts` — `buildPreviewSceneFromCapsule` picks `timeline.denseFrames[0]`.
  - `capsule-preview-colors.ts` — CPK element table + per-bonded-group appearance fan-out.
  - `capsule-preview-sampling.ts` — `sampleEvenly`, `sampleForSilhouette` (extrema + FPS), `sampleForBondedThumb` (graph-aware BFS + connection-count scoring + FPS fill).
  - `capsule-preview-scene-store.ts` — types (`PreviewSceneV1` with `CURRENT_SCENE_REV = 2`, `PreviewStoredThumbV1` with `CURRENT_THUMB_REV = 15`, `PreviewThumbV1`), scene/thumb caps (`SCENE_ATOM_CAP = 5000`, `SCENE_BOND_CAP = 10000`, `ROW_ATOM_CAP_WITH_BONDS = 5000`, `ROW_BOND_CAP = 5000`, `ROW_ATOM_CAP_ATOMS_ONLY = 18`), `buildPreviewSceneV1`, `buildStoredThumbFromFullScene`, `parsePreviewSceneV1` (malformed-thumb and non-finite guards), `derivePreviewThumbV1` (stored-thumb fast path + tiered-visibility live-sampling fallback).
  - `capsule-preview-cluster-select.ts` — `selectPreviewSubjectCluster` picks the largest bonded cluster as the preview subject when the dominance guard passes (D138); otherwise returns the full frame. Shared by the publish pipeline and the audit page so both represent the same subject. "Bonded cluster" here means a proximity-graph connected component — not authoritative molecular connectivity (see D138 scope caveat).
  - `capsule-preview-project.ts` — pinhole perspective 3D → 2D projector (`PERSPECTIVE_K_DEFAULT = 3.17`); `deriveBondPairs` / `deriveBondPairsForProjectedScene` run the distance-cutoff rule from `bondPolicy`.
  - `capsule-preview-camera.ts` — PCA (Jacobi) + `{spherical, planar, linear, general, degenerate}` classification + deterministic sign normalization + fixed 5°/10° tilt; also exposes `deriveMinorAxisCamera` (shared by the baked thumb and the audit page so the published thumb matches the live preview).
  - `capsule-preview-sketch.ts` — reference orthographic SVG sketch renderer with three presets (`AUDIT_LARGE_PRESET`, `POSTER_PRESET`, `THUMB_PRESET`). Not in the production render path — the poster Function and account row consume `CurrentPosterSceneSvg` and `CurrentThumbSvg` directly (below). Retained as a renderer reference whose output invariants are locked by `tests/unit/capsule-preview-sketch.test.ts`, `capsule-preview-audit-metrics.test.ts`, and `capsule-preview-poster-figure.test.ts`.
  - `capsule-preview-sketch-perspective.ts` — pinhole-perspective sketch renderer (single-pass depth-sorted paint list) used by the `preview-audit/` workbench; drives the visual contract that the shipped `CurrentPosterSceneSvg` / `CurrentThumbSvg` are tuned against.
  - `capsule-preview-thumb-render.ts` — shared constants (`BONDED_ATOM_RADIUS = 2.8`, `BOND_STROKE_WIDTH = 2.5`, `MIN_VISIBLE_BOND_VIEWBOX = 3`, `RELAXED_VISIBLE_BOND_VIEWBOX = 2.0`, atoms-only density floor, margin resolvers) imported by BOTH the scene-store visibility filter and the thumb renderer — a single-point coupling that keeps the publish-time refit math in sync with the renderer.
  - `capsule-preview-thumb-size.ts` — `ACCOUNT_THUMB_SIZE = 96` (single source of truth for the account-row thumb surface, mirrored by `public/account-layout.css`).
  - `capsule-preview-bond-scale.ts` — single source of truth for preview sizing, shared by `capsule-preview-current-poster.tsx` and `capsule-preview-current-thumb.tsx`. Exports the C60-calibrated sizing ratios (`K_ATOM = 0.22`, `K_BOND_FILL = 0.15`, `K_BOND_BORDER_DELTA = 0.05`), the cylinder palette (`BOND_CYL_EDGE` / `BOND_CYL_BODY` / `BOND_CYL_HIGHLIGHT` with matching `_MULT` stroke-width fractions), the per-atom perspective clamp (`PERSPECTIVE_MULT_MIN = 0.85`, `PERSPECTIVE_MULT_MAX = 1.15`), and helpers `medianBondLengthVb`, `medianNearestNeighborVb`, `medianStoredR`, `perspectiveMultiplier`. Atom radii render at `K_ATOM · bondVb` on both surfaces; stored `a.r` acts only as a ±15% depth multiplier around the median — that clamp is what keeps the renderer stable across rev bumps.
  - `capsule-preview-heal.ts` — read-time rebake for legacy bondless rows. Exports `sceneIsBondless` (predicate), `rebakeSceneFromR2` (R2 fetch → `projectCapsuleToSceneJson` → conditional D1 UPDATE with `overwrite` flag), and the `healBondlessRow` convenience wrapper (unconditional overwrite). Consumed synchronously by the poster route and via `waitUntil` background by the account API — both paths use the same deterministic projection so concurrent writes stay consistent.
  - `capsule-preview-account-derive.ts` — wires `derivePreviewThumbV1` with the account-row defaults (`ROW_ATOM_CAP_ATOMS_ONLY`, `ROW_ATOM_CAP_WITH_BONDS`, `ROW_BOND_CAP`, `sampleForSilhouette`); the single caller is `functions/api/account/capsules/index.ts`.
  - `capsule-preview-current-poster.tsx` — shared poster SVG (`CurrentPosterSceneSvg`) consumed by the Satori composer at `functions/_lib/capsule-preview-image.tsx`. Imports sizing + palette from `capsule-preview-bond-scale.ts`.
  - `capsule-preview-current-thumb.tsx` — shared thumb SVG (`CurrentThumbSvg`) consumed by `account/main.tsx`. Imports sizing + palette from `capsule-preview-bond-scale.ts`; bonds render as three concentric `<line>` strokes (edge / body / highlight `data-role`s inside a `<g data-role="bond-pair">`) to simulate a lit cylinder. Uses `fill="currentColor"` so ink inherits `--color-text` from `public/account-layout.css` when mounted in the account theme.
  - `publish-core.ts` — `preparePublishRecord` / `projectCapsuleToSceneJson` / `persistRecord`: the single-parse publish pipeline (see §Capsule preview). Bond derivation is unified with the lab / physics path via `buildBondTopologyFromAtoms` (`src/topology/build-bond-topology.ts`) with rules from `createBondRules` (`src/topology/bond-rules.ts`) — no longer a preview-local `deriveBondPairs`.
  - `capsule-preview-denylist.ts` — title denylist (shared with the publish path).
  - `guest-publish-flag.ts` — single `isGuestPublishEnabled(env)` resolver; only the trimmed, case-insensitive strings `"on"`, `"true"`, `"1"` enable guest publish (default OFF). Sole call sites: the guest-publish endpoint (404 gate) and the session Function (publicConfig bridge).
  - `turnstile.ts` — `verifyTurnstileToken` with an explicit 8-second `AbortController` timeout; returns a discriminated union whose failure branches (`siteverify_rejected` / `siteverify_timeout` / `siteverify_network` / `siteverify_unparseable`) never collapse to "allow."
  - `share-result.ts` — canonical `ShareResult` discriminated union (`ShareResultAccount` with `{mode, shareCode, shareUrl}` and `ShareResultGuest` with an added ISO `expiresAt`); both UI layers import from here so result shapes cannot drift.
  - `rate-limit.ts` — in addition to the existing account-publish quota, exports `DEFAULT_GUEST_PUBLISH_QUOTA` plus `checkGuestPublishQuota` / `consumeGuestPublishQuota` / `pruneExpiredGuestPublishQuotaBuckets` over the dedicated `guest_publish_quota_window` table, mirroring the privacy-request quota pattern so the three flows' abuse profiles cannot collide in operator queries.
  - `share-record.ts` — `isAccessibleShare(row, now)` (rename of the pre-guest `isAccessibleStatus(status)` predicate) takes both status AND `expires_at`, so an expired guest row 404s immediately on public routes without waiting for the sweep. Companion export `accessibleShareSqlFragment` carries the matching SQL predicate for D1 queries that need to filter accessibility in-database.

## Backend <a id="backend"></a>

The backend is Cloudflare-native: Pages Functions for APIs, D1 for metadata, R2 for capsule blobs, a companion Worker for scheduled cleanup.

### Services

- **Pages Functions** (`functions/`) serve the API surface: share-link publish/read, auth, account, moderation, policy, privacy-request, admin gate, capsule preview poster (`functions/api/capsules/[code]/preview/poster.ts`), and admin backfill for preview scenes (`functions/api/admin/backfill-preview-scenes.ts`). Publish has two parallel endpoints that write to the same `capsule_share` table, discriminated by `share_mode`: `POST /api/capsules/publish` is authenticated, permanent, and enforces the per-user quota in `publish_quota_window`; `POST /api/capsules/guest-publish` is anonymous, creates a 72-hour expiring share, is Turnstile-gated, enforces a per-IP quota in `guest_publish_quota_window`, and is feature-flagged via `GUEST_PUBLISH_ENABLED` (fail-closed 404 when the flag resolver rejects). One Function per route; shared helpers live at `functions/` root (auth-middleware, http-cache, oauth-helpers, signed-intents, policy-acceptance, admin-gate) and Function-only libs live under `functions/_lib/` (capsule-preview Satori composer at `capsule-preview-image.tsx` + bundled Latin font as base64, since Pages Functions esbuild has no `.ttf` loader; `wait-until.ts` exports `scheduleBackground(ctx, promise, tag)` — the shared wrapper used by publish + account API for logged detached work).
- **D1** is the authoritative metadata store: share records, user accounts, policy acceptance history, audit trail. Schema lives in `migrations/`. Migration `0011_capsule_share_guest.sql` evolves `capsule_share` for Quick Share: `owner_user_id` becomes nullable (NULL for guest rows), `share_mode TEXT NOT NULL DEFAULT 'account'` discriminates the two write paths, `expires_at TEXT` carries the ISO expiry for guest rows (NULL for account rows), a `CHECK` constraint binds the two (`guest ⇒ null owner`, `account ⇒ non-null owner`), and a partial index `idx_capsule_guest_expires` on `expires_at WHERE share_mode='guest' AND status != 'deleted'` keeps the expiry sweep cheap. Migration `0012` adds the dedicated `guest_publish_quota_window` table consumed by the per-IP rate-limit helpers.
- **R2** stores capsule blobs keyed by share code. Blob reads go through a Function to apply privacy and moderation rules.
- **Cron worker** (`workers/cron-sweeper/`) runs scheduled reconciliation: orphan-blob cleanup, abandoned-capsule pruning, audit-log rotation, and guest-share expiry. The guest-expiry tick `"10 */6 * * *"` targets `/api/admin/sweep/guest-expires`, which tombstones rows past their `expires_at` through the shared `deleteCapsule(actor: 'cron')` core — the same path used by account-owner and admin deletions, so blob cleanup, audit emission, and ordering are identical.

The separation matters because the three storage systems fail differently. D1 is strongly consistent and small; losing a row is a correctness bug. R2 is eventually consistent and large; losing a blob is a durability concern the cron reconciles against D1. Pages Functions are stateless; they may be invoked in parallel and must not assume a prior invocation's side effects are visible.

Data plane (capsule fetch from a share URL) is decoupled from control plane (publish, moderate, account). Endpoint-level detail lives in [operations.md](operations.md).

The decoupling is what lets the share-link fetch path be aggressively cacheable while the publish and moderation paths remain authenticated and audited. A `/c/:code` GET can sit behind a CDN edge; a moderation action cannot. Rolling the two together would either force caching off the data plane or push auth into every read.

### Auth <a id="auth"></a>

Sign-in is OAuth-based. Authenticated operations use **signed intents** — short-lived signed payloads minted by a Function, consumed by a follow-up Function or by `lab/js/runtime/auth-runtime.ts` on the client. This keeps mutable-state endpoints statelessly verifiable without a session token on every call.

An **admin gate** wraps moderation and privacy-operator endpoints. The gate checks a signed admin intent plus an allowlist; failures are audit-logged. Rationale for this split is in [decisions.md](decisions.md); endpoint-level detail and on-call playbook are in [operations.md](operations.md).

`GET /api/auth/session` doubles as the client-config bridge: its response carries a `publicConfig.guestPublish: { enabled, turnstileSiteKey }` block (turnstileSiteKey is forced to null when `enabled=false`) so the Lab SPA can decide whether to render the Quick Share UI at boot without a second round-trip. The flag state is the same resolver the guest-publish endpoint gates on, so the client cannot drift out of sync with the server.

Turnstile requires a document-level CSP for the Lab SPA. `public/_headers` attaches that CSP to both `/lab` and `/lab/*` (the two patterns cover the no-trailing-slash form and the splat together), allowing `https://challenges.cloudflare.com` in `script-src`, `frame-src`, and `connect-src`. The popup-complete CSP emitted by `functions/auth/popup-complete.ts` is scoped to the OAuth callback page, has no Turnstile dependency, and stays untouched.

### Privacy and moderation <a id="privacy"></a>

Three contracts live at the boundary:

- **Age gate** — a minimum-age attestation required the first time a user creates an account. Distinct from policy acceptance: the age gate is a one-time check stored as a boolean; it does not track policy versions.
- **Policy acceptance** — tracked in D1 with policy version + timestamp. Re-acceptance is required when the version bumps (version pinned at build time from `src/policy/policy-config.ts`). Whereas the age gate asks "are you old enough," policy acceptance asks "do you agree to this specific version of the terms."
- **Erasure** — user-initiated deletion flows through the `/privacy-request` operator path. Static HTML surfaces live at `privacy/`, `privacy-request/`, and `terms/`. The operator runbook is in [operations.md](operations.md).

These three contracts are enforced at the Function boundary, not in the frontend. A frontend that forgot to check age-gate state cannot cause an age-gated action to succeed; the Function rejects it. The frontend treats the contracts as UX surfaces (disable buttons, show the gate) while the Functions treat them as hard invariants.

## Key Flows <a id="key-flows"></a>

Seven flows cover the majority of product behavior. Each lists the modules involved; implementation details are in the linked code.

The flows are ordered roughly by how often they fire. The Lab simulation loop runs tens of times per second; the others run on user actions or share-link fetches. Reading the loop first sets up vocabulary (store, runtime, reconcile) that the later flows reuse.

### Lab simulation loop <a id="flow-lab-loop"></a>

Each animation frame, Lab runs a deterministic pipeline orchestrated by `lab/js/app/frame-runtime.ts`:

```
RAF tick
  → store snapshot read
  → interaction dispatch (drag/rotate/translate intents → forces)
  → worker command (if worker path)     or     sync physics step
  → snapshot reconcile (positions, velocities, bonds)
  → bonded-group projection (src/history/bonded-group-projection)
  → renderer.update (InstancedMesh)
  → overlay/hint runtime tick
```

Worker stall detection is owned by `lab/js/runtime/worker/worker-lifecycle.ts` (warning then fatal threshold → sync fallback). The composition root is `lab/js/main.ts`. Physics detail and validation are in [physics.md](physics.md).

Two invariants hold every frame: the store snapshot is read once at the top and written once at the bottom, and the renderer update consumes the post-reconcile state — never the pre-step state. The invariants are what let the UI tests assert on store writes, and what lets the physics tests assert on reconciled positions, without either test type needing to mount the full pipeline.

### History export <a id="flow-export"></a>

When the user exports a timeline:

```
user → Export dialog (components/timeline/timeline-export-dialog.tsx)
  → orchestrator (runtime/timeline/timeline-recording-orchestrator)
  → atom-metadata-registry (stable atom-ids across topology changes)
  → history-export (v1 file builder, capsule or full history)
  → download trigger
```

Stable atom-id projection is the critical invariant — it is what lets a restart frame in the export file reconstruct the same atoms in a later Watch or Lab session. Lives in `lab/js/runtime/timeline/timeline-atom-identity.ts`.

A capsule and a full history diverge in what they carry, not in how they are built. A full history records every dense frame plus every restart frame; a capsule records dense frames for smooth playback plus a small number of restart frames at strategic points, optimized for share-link size. Both flow through the same builder; the importer on the Watch side detects kind from the file header.

### Watch file open <a id="flow-watch-open"></a>

File intake is transactional: a failed open never clobbers the current document.

```
user → drag-drop or share-link fetch
  → watch/js/document/watch-document-service.prepare(file)
      (validates, parses, returns 'ready' or 'error')
  → watch-controller commits only on 'ready'
  → watch/js/document/(full-history-import | capsule-history-import)
  → watch/js/playback/watch-playback-model.load(history)
  → renderer + UI bind to playback snapshot
```

Validation failure leaves the previously loaded document intact. The file kind (capsule or full history) is auto-detected in `history-file-loader.ts`.

The transactional shape is what makes this flow worth describing as a flow. A naive "open then replace" sequence would leave the user staring at a broken document every time a file fails to parse. The `prepare/commit` split means a user who drags in a corrupt file simply sees an error toast; the scene they were reviewing is still there.

### Watch→Lab handoff <a id="flow-handoff"></a>

The user clicks **Interact From Here** in Watch and the current frame continues as a live Lab session.

1. `watch/js/components/WatchLabEntryControl.tsx` captures the click and enforces the primary-pill contract (single pill, caret-toggled disclosure; tooltip auto-cues at the 50% and 100% timeline milestones, once per file).
2. `watch/js/handoff/watch-lab-seed.ts` builds a seed (atoms, velocities, bonds, camera pose, authored colors) from the current playback frame, using shape types from `src/watch-lab-handoff/`.
3. `watch/js/handoff/watch-lab-handoff.ts` writes the seed to `localStorage` under a handoff token and opens a `/lab/?from=watch&handoff=…` URL (built by `watch-lab-href.ts`) in a new tab.
4. Lab boot checks the URL flag **before** the default auto-load (`lab/js/main.ts` → `lab/js/runtime/handoff/watch-handoff.ts`) and suppresses the default scene.
5. `lab/js/runtime/handoff/hydrate-from-watch-seed.ts` runs a transactional hydrate: scene atoms, velocities, bonds, authored colors, and camera pose all land in one commit or none.
6. The hydrated scene itself is the arrival acknowledgement — no toast, no arrival pill.

Token, URL flag, and seed shape are defined in `src/watch-lab-handoff/`. Click-ownership and tooltip contracts are in [viewer.md](viewer.md).

The failure modes matter as much as the happy path. A hydrate that partially completes must roll back — Lab should fall back to the default scene rather than ship a mixed state. A handoff URL that lands on a Lab tab whose localStorage no longer has the token (because another tab consumed it, or because storage was cleared) fails silently and boots the default scene. Both cases are covered by the Phase 1 transactional contract documented in [decisions.md](decisions.md).

### Share-link / capsule fetch <a id="flow-share"></a>

From a `/c/:code` URL to a loaded capsule in Watch:

```
GET /c/:CODE
  → Pages Function resolves code → R2 key (D1 lookup)
  → R2 blob fetch (privacy + moderation gate applied)
  → returns capsule bytes + content-type
browser
  → watch/js/document/capsule-history-import parses
  → Watch commits via the standard file-open flow
```

Publish is the reverse: Lab builds the capsule, POSTs to the publish Function, which writes D1 + R2 and returns the short code. Endpoint-level detail is in [operations.md](operations.md).

The privacy and moderation gate on the read path is non-negotiable: a capsule that is pending moderation, has been flagged, or is tied to a user who has requested erasure will not serve its bytes even if the share code still resolves. Failure modes — 404, 403, or a quarantined-capsule response — are documented in [operations.md](operations.md).

### Capsule preview <a id="flow-capsule-preview"></a>

A capsule has two presentation surfaces beyond its bytes: a thumbnail in the account list and an Open Graph poster on a `/c/:code` share. Both render from the **same stored payload**, projected once at publish time from the first dense frame of the capsule.

#### Stored payload (D1 `capsule_share.preview_scene_v1 TEXT NULLABLE`, migration 0009)

A single JSON cell per row carries two artifacts inside one `PreviewSceneV1` shape:

```
{ v: 1,
  atoms: [{x,y,r,c}],           // up to SCENE_ATOM_CAP=5000 — feeds the 1200×630 poster
  bonds?: [{a,b}],              // up to SCENE_BOND_CAP=10000 — indices into atoms[]
  hash: "<8hex FNV-1a32>",      // over the atom array; bond-independent
  thumb?: {                     // pre-baked at publish time from the selected-subject atoms
    rev: 15,                    //   (CURRENT_THUMB_REV, bumps when algorithm changes)
    atoms: [{x,y,r,c}],         //   up to ROW_ATOM_CAP_WITH_BONDS=5000, already refit into the thumb cell
    bonds?: [{a,b}]             //   up to ROW_BOND_CAP=5000 (coverage-selected, cycle-preserving)
  } }
```

The critical property: the `thumb` payload is derived from the **selected-subject atoms** — cluster-filtered when the dominance guard passes (D138), otherwise the full frame — not from the 32-atom poster subset. That avoids the double-downsampling cascade that would erase dense-structure topology (C60 et al.). Atoms + bonds in the thumb are already refit into the account thumb cell (`ACCOUNT_THUMB_SIZE = 96` px, see `src/share/capsule-preview-thumb-size.ts`) in 0..1-normalized space, so the account API emits them verbatim. `rev` lets backfill scripts identify stale rows when the thumb pipeline changes — every observable output change bumps it (currently `15`; the full history lives in the JSDoc above `CURRENT_THUMB_REV`).

#### Publish flow (single-parse boundary)

`src/share/publish-core.ts:preparePublishRecord` runs the whole preview pipeline in memory, with no D1 or R2 I/O:

1. Parse + validate the capsule file.
2. `buildPreviewSceneFromCapsule` picks the first dense frame.
3. `capsule-preview-camera` computes the PCA canonical camera + tilt.
4. `buildBondTopologyFromAtoms` (from `src/topology/build-bond-topology.ts`, with rules from `createBondRules` honoring the capsule's `bondPolicy` — same builder as the physics / loader paths) derives bond pairs on the FULL frame before any sampling so the graph reflects real nearest-neighbor connectivity.
4a. `capsule-preview-cluster-select.selectPreviewSubjectCluster` filters the scene to the largest bonded cluster when the dominance guard accepts it (D138). Falls back to the full frame otherwise. The filtered atoms + bonds feed BOTH the 32-atom poster scene AND the selected-subject thumb below. "Bonded cluster" = connected component of the preview proximity graph; see D138 for the scope caveat.
5. Project the selected-subject scene 3D → 2D and build the 32-atom **poster scene** (`buildPreviewSceneV1`) AND the **selected-subject thumb** (`buildStoredThumbFromFullScene`, capped at `ROW_ATOM_CAP_WITH_BONDS`/`ROW_BOND_CAP`); attach the thumb to the scene. Thumb-bake visibility thresholds are `Number.NEGATIVE_INFINITY` for both strict and relaxed gates, with `bondsAwareThreshold: 0` — small clusters and dense 3D both keep every bond; the depth-sorted paint list in the renderer handles occlusion.
6. Return `previewSceneV1Json` on the `PreparedPublishRecord`.

`persistRecord` INSERTs the JSON into `preview_scene_v1` unchanged. The whole pipeline runs once per publish; read paths never re-project.

#### Read flows

```
GET /api/capsules/:CODE/preview/poster          (functions/api/capsules/[code]/preview/poster.ts)
  → resolve capsule + flags (D1)
  → if preview_status='ready' + preview_poster_key → serve R2 bytes (stored mode)
  else if dynamic fallback flag on →
        parsePreviewSceneV1(row.preview_scene_v1)
        if null → lazy-backfill: R2 blob → project → UPDATE … WHERE preview_scene_v1 IS NULL
        compose ImageResponse via functions/_lib/capsule-preview-image.tsx (Satori, bundled Latin font)
        ETag `"v4-<8hex>"` bound to [TEMPLATE_VERSION, scene.hash, sanitizedTitle, shareCode]
  else            → 404
  any render/import error → terminal /og-fallback.png
  fallthrough             → 1×1 transparent PNG safety net
  every branch            → structured log line
```

Lazy backfill is a one-shot self-heal via `rebakeSceneFromR2` (`src/share/capsule-preview-heal.ts`): a pre-V2 row that still carries `preview_scene_v1 = NULL` triggers a single R2 fetch + projection + conditional UPDATE on the first poster miss; subsequent requests hit the fast path. The conditional `WHERE preview_scene_v1 IS NULL` clause makes a concurrent publish-time write always win.

Legacy bondless rows (pre-topology-unification: `preview_scene_v1` populated, but both `scene.bonds` and `scene.thumb.bonds` empty) trigger a second self-heal via `healBondlessRow` — an unconditional overwrite using the same rebake pipeline. The poster route runs it synchronously so the response carries bonds; the account API runs it via `scheduleBackground` (`waitUntil`) so the current request returns immediately and the next page load reflects the healed row.

Account-page lazy rebake (ADR D135 follow-up, 2026-04-21) generalizes that mechanism into four priority classes — `missing` (priority 1), `parse-failed` (2), `stale-rev` (3), `bondless` (4) — each computed per-row from the page-sized SELECT. Priority 1–3 rows would otherwise render a placeholder or an out-of-date thumb; priority 4 is the historical bondless heal. A D1 column `capsule_share.preview_rebake_claimed_at` (migration `0010`) provides a 90 s TTL lease, claimed atomically via `UPDATE … WHERE claim IS NULL OR claim < ?`. Only rows whose `changes === 1` claim succeeded are handed to the background batch, so two concurrent tabs on the same account never double-heal a row. Per-request start cap: 8 on first-page requests, 5 on cursor-paged requests. **Claim attempts** are separately bounded at 2× the start cap so a page where every early candidate is already lease-held cannot balloon D1 write volume to the full eligible set. The lease-claim path is also **fail-open**: a `UPDATE` that throws logs `heal-claim-failed` and the nomination loop continues with the next candidate — the capsule-list response is never failed by an opportunistic heal write. The background batch runs with `HEAL_CONCURRENCY = 2` and a `HEAL_BUDGET_MS = 25 000` wall-clock deadline; unstarted rows are logged as `deadlined`. Counters distinguish `rebaked` (in-memory projection success) from `persisted` (D1 UPDATE resolved, `meta.changes >= 1`) via `HealResult.persisted`. Clients receive the started share codes as `CapsulesPage.previewPending` and render a shimmer overlay on those rows until a follow-up fetch reports them gone.

Client auto-refresh (`account/main.tsx`) is **first-page-only**: the 8 s post-response timer and the `visibilitychange` listener (≥ 30 s hidden threshold) both skip once the user has fired `onLoadMore()` in the current session. This is the fix for the otherwise-regressive "timer-driven page-1 refetch collapses the user's loaded page 2/3" pattern. `onLoadMore()` additionally clears the pending-heal UI state so the shimmer can't hang on page-1 rows with no timer chasing them. See ADR D135 follow-up in `decisions.md` for the full invariant list.

```
GET /api/account/capsules                       (functions/api/account/capsules/index.ts)
  → authenticate → keyset query of capsule_share (ORDER BY created_at DESC, share_code DESC)
  → derivePreviewThumbV1(row.preview_scene_v1, { sampler: sampleForSilhouette, caps, … })
      fast path: if scene.thumb present at rev ≥ CURRENT_THUMB_REV → return verbatim
      fallback:  atoms-only (≤ROW_ATOM_CAP_ATOMS_ONLY=18) or tiered bonded
                  (≤ROW_ATOM_CAP_WITH_BONDS=5000 atoms + ≤ROW_BOND_CAP=5000 bonds,
                   cycle-preserving picker)
  → return AccountCapsuleSummary[] with `previewThumb: PreviewThumbV1 | null`
```

**No R2 access on the hot path.** Every row is served from the single D1 read. When `preview_scene_v1` is null, malformed, or empty, `derivePreviewThumbV1` returns null and the client renders `PlaceholderThumb` instead.

#### Account UI render (`account/main.tsx`)

The account page is a thin consumer: it imports `CurrentThumbSvg` from `src/share/capsule-preview-current-thumb.tsx` and renders the server-derived payload verbatim in two regimes keyed off payload shape: **atoms-only** (≤ `ROW_ATOM_CAP_ATOMS_ONLY` = 18 atoms) or **bonds-aware** (≤ `ROW_ATOM_CAP_WITH_BONDS` = 5000 atoms + ≤ `ROW_BOND_CAP` = 5000 bonds — effectively unbounded for real capsules; see the JSDoc on the constants for the rationale). Atoms render as individual `<circle>` elements sharing a radial gradient (the shaded-sphere look introduced at `CURRENT_THUMB_REV = 11`); bonds paint in a single depth-sorted pass interleaved with atoms (rev 13) so near-side atoms occlude far-side bonds correctly. The shipped display size is `ACCOUNT_THUMB_SIZE = 96` (from `src/share/capsule-preview-thumb-size.ts`), mirrored in `public/account-layout.css`'s `.acct__upload-thumb`. `PlaceholderThumb` covers `previewThumb: null` rows. The shared SVG sets `fill="currentColor"` so ink inherits `--color-text` from the account CSS theme. Under the hood, `CurrentThumbSvg` imports `capsule-preview-thumb-render.ts` so radius, stroke, and visibility values are the same constants the scene-store uses when filtering bond visibility.

#### Current preview state — single source of truth

Rapid iteration made the preview pipeline easy to describe inconsistently; this section is the authoritative current-state snapshot, updated alongside the code.

- **Account-row thumb surface** — 96 × 96 px; constant in `src/share/capsule-preview-thumb-size.ts`, mirrored by the CSS rule.
- **Account thumb payload caps** — `ROW_ATOM_CAP_WITH_BONDS = 5000`, `ROW_BOND_CAP = 5000`, `ROW_ATOM_CAP_ATOMS_ONLY = 18`. Baked at publish time from the full selected-subject atoms, NOT from the 32-capped stored scene. At 5000 no realistic capsule hits the ceiling — real-world pressure is stored-JSON size and visual density on the 96 × 96 cell, both of which scale with actual atom count.
- **Stored scene (`preview_scene_v1`) caps** — `SCENE_ATOM_CAP = 5000`, `SCENE_BOND_CAP = 10000`. Lifted from 32/64 on 2026-04-21 (D135 follow-up 2) so the stored poster scene reaches the same fidelity as the thumb bake. Paired with the poster renderer retargeting from `scene.thumb` back to `scene.atoms`/`scene.bonds` (`CurrentPosterSceneSvg`); dense cages and multi-component scenes that had bonds visibility-filtered at thumb scale now render their full structural wiring on the 1200×630 OG card.
- **`CURRENT_THUMB_REV`** — `15`. The full per-rev history lives in the JSDoc above the constant in `src/share/capsule-preview-scene-store.ts`; recent milestones: cluster-selection (3), path-batched renderer (4), 96 px pivot (5), shared minor-axis camera (10), `<circle>` + shaded-sphere atoms (11), square perspective target (12), single-pass depth-sorted paint (13), uncapped bond retention (14), `PERSPECTIVE_K_DEFAULT = 3.17` (15). **This constant only versions the thumb payload shape** — poster-scene bake changes now bump `CURRENT_SCENE_REV` instead.
- **`CURRENT_SCENE_REV`** — `2`. Independent revision stamp on the poster scene (`preview_scene_v1.rev`). Introduced 2026-04-21 (D135 follow-up 3) so scene-bake changes (projection target, caps, normalization contract) no longer piggy-back on the thumb rev. Advanced to `2` later the same day (D135 follow-up 4) when the poster bake switched from orthographic to pinhole perspective — stored per-atom `r` now carries real depth scaling, matching the thumb bake's long-standing contract, and the OG poster reads the same depth cues the profile thumb has always had. Rows with `scene.rev < CURRENT_SCENE_REV` (or missing `rev`) are classified `stale-rev` by both the account-page lazy heal and the poster route's synchronous heal — a single `rebakeSceneFromR2` call refreshes both the scene AND the thumb since they're written as one D1 UPDATE.
- **Visual grammar** — `THUMB_STYLE_MINIMAL` (the shipped preset: flat ink atoms over the shared radial-gradient sphere shader; bonds interleaved in the depth-sorted paint list). `THUMB_STYLE_HALOED` exists for audit A/B only; not shipped.
- **Cluster selection** — `selectPreviewSubjectCluster` (ADR D138) runs before sampling. Fallback reasons visible on the `preview-audit/` workbench metadata. Balanced / multi-fragment scenes intentionally preserve the full frame (dominance guard).
- **Dev workbench** — `preview-audit/` (standalone Vite entry; served via `scripts/serve-preview-audit.sh`) exercises `capsule-preview-sketch-perspective.ts` against the fixtures in `src/share/__fixtures__/` so visual regressions in the poster/thumb pipeline are caught before publish.
- **Backfill** — `npm run capsule-preview:backfill:local` (Miniflare state) or `npm run capsule-preview:backfill:prod` (admin endpoint `functions/api/admin/backfill-preview-scenes.ts`, driven by `scripts/backfill-preview-scenes.ts`).

#### Cache-key axes

- **Dynamic posters** bust on `TEMPLATE_VERSION` bump (`?v=t<N>`, currently `t4`). The ETag `"v4-<8hex>"` additionally binds to `scene.hash`, the sanitized title, and the share code.
- **Stored posters** bust on FNV-1a hash of `preview_poster_key` (`?v=p<8hex>`). Re-uploading R2 bytes for a capsule changes the key hash and forces a fresh fetch independent of the template axis.
- `/c/:code` share pages emit the poster URL with `?v=t2` in the OG tag.

Public metadata contract: `ShareMetadataResponse.preview` is `{posterUrl, width: 1200, height: 630}` and is present for any accessible row when the flag is on. Whether stored R2 bytes exist is signaled by `previewStatus === 'ready'`, **not** by the presence of `preview.posterUrl`.

### Auth / signed-intent flow <a id="flow-auth"></a>

Authenticated mutations use a signed short-lived intent rather than a session token:

1. Client requests an intent (for example `POST /auth/intent` with an action and payload).
2. Function verifies identity, signs `{ action, payload, exp }`, returns the token.
3. Client follows up with the intent token in the Authorization header to the target endpoint.
4. Target Function verifies signature and expiry; on success executes the action and audit-logs.

A failed signature check is a hard reject with an audit entry; a failed expiry check is a soft reject that prompts the client to request a fresh intent. The distinction matters because expired intents are benign (clock skew, slow user) while bad signatures are adversarial.

Admin operations add a second check against an allowlist. `lab/js/runtime/auth-runtime.ts` owns the client-side lifecycle. Endpoint-level detail and failure modes are in [operations.md](operations.md).

#### Why signed intents instead of sessions

Session tokens make sense when every request is authenticated against a long-lived identity. Most Atom Dojo mutations are closer to one-shot actions ("publish this capsule", "accept this policy version") than to a continuous session, so the cost of issuing and revoking sessions outweighs the benefit. A signed intent is short-lived, carries the exact action it authorizes, and is verifiable without per-request storage lookups — the Function verifies the signature and the expiry, then runs. The downside is that replay inside the expiry window is possible; the admin-gate allowlist and audit log are the compensating controls.

## State And Ownership <a id="state-and-ownership"></a>

The architecture has a few load-bearing boundaries. Crossing them casually is the single most common way to make the codebase hard to change, so they are worth naming explicitly.

Four distinct ownership domains, intentionally not merged:

- **React / Zustand UI state** — everything the user sees. Lives in `lab/js/store/` and in Watch's component + controller-snapshot layer. React surfaces never mutate physics or renderer state directly; they issue commands to the imperative runtime.
- **Imperative runtime state** — renderer (Three.js), physics worker, playback model. Mutated by `lab/js/runtime/*` and `watch/js/app/watch-controller.ts`. Signals React only through store writes or controller snapshot reads.
- **Shared pure modules** (`src/`) — stateless transforms, types, and constants. No singletons; no side effects at import time.
- **Backend persistence** (D1 + R2) — authoritative metadata and blob storage. Frontend never writes directly; always via a Function. The Function is the policy enforcement point.

The discipline that keeps this stable: React surfaces are declarative, runtime modules are imperative, shared modules are pure, persistence is Function-gated. Rationale is in [decisions.md](decisions.md).

Two consequences worth naming:

- **Tests track the boundary.** UI tests render components with a store stub and assert rendered output; runtime tests drive runtime modules with fake stores and assert imperative calls; shared-module tests are pure-function. The boundary is the reason each test type stays small.
- **Reviews flow one direction.** A store write flowing into a React render is a normal signal path; a React component reaching into a renderer or worker is a red flag. PRs that introduce the latter should either move the logic into a runtime module or wrap it behind a controller command.

## Further Reading <a id="further-reading"></a>

- [viewer.md](viewer.md) — Lab and Watch UI/UX, entry control and tooltip contracts
- [physics.md](physics.md) — Tersoff potential, integrator, units, validation
- [testing.md](testing.md) — test ladder, gates, WebGL checks
- [operations.md](operations.md) — deploy, endpoints, cron, on-call
- [contributing.md](contributing.md) — code style, architecture rules, `#extension-points`
- [decisions.md](decisions.md) — historical rationale
- [scaling-research.md](scaling-research.md) — browser limits, benchmarks
- [ml-surrogate.md](ml-surrogate.md) — deferred ML track
- [structure-library.md](structure-library.md) — bundled structures
- [glossary.md](glossary.md) — terminology

This doc is meant to stay roughly stable. When a subsystem's boundaries shift in a way that changes the story, update the section that carries that story rather than appending a new one. When a subsystem's internal detail shifts, update the linked sibling doc and leave this one alone. The goal is for a reader to be able to come back in six months and still recognize the system from this page.
