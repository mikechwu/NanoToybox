# Glossary

Canonical terms used across `docs/README.md`, `docs/architecture.md`, `docs/viewer.md`, `docs/operations.md`, and `docs/testing.md`. Each entry below shows the **exact form** a term takes in prose. Proper nouns are capitalized (`Lab`, `Watch`, `Viewer`, `Atom Dojo`); common nouns are lowercase (`capsule`, `handoff`, `share link`). When any of these terms appears in a sibling doc, it uses the form shown here.

## Product (proper nouns — always capitalized)

- **Atom Dojo** — the public product name. (Formerly "NanoToybox"; the repository name and some internal identifiers still use the old name during transition.)
- **Lab** — the authoring and simulation app served at `/lab/`. Users build structures, simulate, record timelines, and export.
- **Watch** — the playback and review app served at `/watch/`. Users open exported histories or capsule share links, scrub, and jump back into Lab from any frame.
- **Viewer** — the thin static XYZ viewer at `/viewer/`. Distinct from Watch; does not support capsule playback or handoff.

Path fragments such as `lab/`, `watch/`, and `viewer/` refer to directories, not to the product nouns, and are written lowercase in those contexts.

## Files and data (common nouns — lowercase in prose)

- **capsule** — compact history export optimized for share links. Carries appearance metadata, interaction state, and enough dense frames for playback. File extension `.atomdojo`.
- **full history** — complete exported simulation with every dense frame and every restart frame. File extension `.atomdojo-history`.
- **dense frame** — per-tick position sample in a history. Many per timeline.
- **restart frame** — seedable state (positions + velocities + config + bonds) recorded at checkpoints. Required to hand off into Lab.
- **atom-id** — stable atom identity carried across frames, topology changes, and handoff. Projected by the timeline subsystem.

## Handoff and sharing (common nouns — lowercase in prose)

- **handoff** — the Watch→Lab scene transfer at a chosen frame. Produces a seed, a localStorage token, and a Lab URL flag.
- **seed** — the serialized `WatchLabSceneSeed` payload Lab consumes during hydration. Carries atoms, velocities, bonds, camera pose, and authored colors.
- **share link** — a URL of the form `/c/:code` that resolves to a stored capsule. Backed by D1 + R2.

## Analysis (common noun — lowercase in prose)

- **bonded group** — a connected-component cluster of bonded atoms. First-class product concept with authored color assignments that persist across topology changes.

## Playback and camera (common nouns — lowercase in prose)

- **review mode** — display-only playback of recorded frames in Lab (entered by scrubbing the timeline or tapping Review). Live-edit actions are blocked at the runtime callback boundary; physics is not mutated.
- **cinematic camera** — Watch's source-attributed auto-framing camera (`src/camera/`, `watch/js/view/` + settings surface). Phase-aware: gesture tracking suppresses auto-motion until the user lets go.
- **Interact From Here** — the primary pill copy for the Watch→Lab entry control. Supersedes the legacy labels "Continue" and "Remix"; operator banner copy in `docs/operations.md` preserves the legacy forms for troubleshooting old share URLs.

## Capsule preview (common nouns — lowercase in prose)

- **Capsule Preview** — the V2 frame-projected scene system that powers both the account-row thumbnail and the public OG poster. Proper noun for the subsystem; the rendered artifacts are "preview thumbnail" / "preview poster."
- **atoms-only thumb** — the degraded per-row thumbnail variant rendered when the stored thumb carries no bonds (or bonds are over the denylist cap). Atoms render as shaded spheres via `CurrentThumbSvg`; no cylinder-bond strokes are emitted. Contrast with "bonded thumb."
- **bonded thumb** — the preferred per-row thumbnail variant rendered when both atoms and bonds are present. Atoms (shaded spheres) and bonds (three-stroke cylinders) are composited by `CurrentThumbSvg` under the shared bond-length-proportional sizing rule. Contrast with "atoms-only thumb."
- **canonical preview camera** — the single deterministic camera pose computed by `src/share/capsule-preview-camera.ts` and shared by poster renderer and thumb renderer, so the stored thumb matches the stored poster framing.
- **CURRENT_THUMB_REV** — integer constant in `src/share/capsule-preview-scene-store.ts` tracking the current `PreviewStoredThumbV1.rev` shape (currently `15`). **Scoped exclusively to the thumb payload**: any change to the bonded sampler, margin math, or visibility filter bumps this. Rebake rule: rows with `preview_scene_v1.thumb.rev < CURRENT_THUMB_REV` are re-baked. The full rev history (2 pre-D138 → 3 cluster-selection → … → 15 pinhole `K=3.17` + self-sizing poster SVG) lives in the JSDoc next to the constant. Poster-scene bake changes do NOT bump this — see {@link CURRENT_SCENE_REV}.
- **CURRENT_SCENE_REV** — integer constant in `src/share/capsule-preview-scene-store.ts` tracking the current `PreviewSceneV1.rev` shape (currently `2`). Introduced 2026-04-21 (D135 follow-up 3) so poster-scene bake changes (projection target, `SCENE_ATOM_CAP` / `SCENE_BOND_CAP`, normalization contract, projection kind) version independently from the thumb algorithm. Rev history: `1` — square 600×600 orthographic bake; `2` — pinhole perspective bake (D135 follow-up 4, same day) so the OG poster carries depth cues matching the profile thumb. Rebake rule: rows with `preview_scene_v1.rev < CURRENT_SCENE_REV` (or missing `rev`, which classifies as rev 0) are re-baked by both the account-page lazy heal and the poster route's synchronous heal. A single `rebakeSceneFromR2` call refreshes the whole `preview_scene_v1` column (scene AND thumb), so the two rev contracts share a single rebake path.
- **subject cluster** — the connected bonded component of `denseFrames[0]` that drives the preview poster + thumb when the dominance guard (D138) accepts it. Otherwise the preview subject reverts to the full frame. "Bonded" means proximity-graph connected, not authoritative molecular connectivity.
- **dominance guard** — the condition under which subject-cluster selection overrides full-frame preview. Constants: `MIN_MEANINGFUL_CLUSTER_SIZE=2`, `DOMINANCE_BY_RATIO=2.0`, `DOMINANCE_BY_FRACTION=0.6`. See D138.
- **cluster-selection diagnostics** — the `PreviewClusterSelectionDiagnostics` bundle returned from `selectPreviewSubjectCluster`; surfaced on the audit page §3 metadata and emitted as the `[publish] cluster-select:` structured log line on every publish.
- **lazy backfill / lazy heal** — on-read rebake performed by the poster route and `/api/account/capsules` (and backfill scripts) across four reason classes: `missing` (row.preview_scene_v1 IS NULL), `parse-failed` (blob present but `parsePreviewSceneV1` returned null), `stale-rev` (stored `thumb.rev < CURRENT_THUMB_REV`), and `bondless` (legacy atoms-only bake). The poster route heals synchronously so the returned poster carries bonds; the account API schedules the heal via `scheduleBackground` / `ctx.waitUntil` and serves current data on the next read. Shared implementation in `src/share/capsule-preview-heal.ts` (`rebakeSceneFromR2`, `healBondlessRow`, `sceneIsBondless`). The account-page loop is described as a **top-of-feed convergence aid** — opportunistic repair of the rows a user most likely sees first, not a bulk-repair mechanism (`/api/admin/backfill-preview-scenes` remains the right tool for that).
- **rebake lease** — the 90 s TTL advisory lock on the `capsule_share.preview_rebake_claimed_at` column (migration `0010`) that dedups lazy rebake work across concurrent tabs and rapid reloads. Atomic claim via `UPDATE … SET preview_rebake_claimed_at = ? WHERE id = ? AND (claim IS NULL OR claim < ?)` — only rows whose `changes === 1` are handed to the batch. TTL-only (no explicit release) so terminal failures don't busy-loop the doomed row.
- **top-of-feed convergence aid** — the design framing for the account-page lazy rebake: repair the stale rows a user most likely sees first (page 1, up to 8 rows per load), letting convergence happen incrementally as the user returns. Not a bulk-repair tool; bulk repair belongs to the admin endpoint.
- **previewPending** — the optional `string[]` field on `CapsulesPage` responses that carries the share codes the server has nominated for background rebake this request. Drives the shimmer overlay on the corresponding account-row thumbnails and, on page 1, arms an 8 s follow-up fetch so the shimmer clears once rebake lands.
- **HealResult.persisted** — boolean on the success variant of `HealResult` distinguishing in-memory rebake (`rebaked`) from committed D1 UPDATE (`persisted`). `rebaked > persisted` in the `heal-batch-done` log line is a D1-write regression signal.
- **preview scene** — the V2 payload stored in the D1 column `preview_scene_v1` (added by `migrations/0009_capsule_preview_scene_v1.sql`). JSON shape `{ v:1, atoms[], bonds?, hash, thumb?: PreviewStoredThumbV1 }`, pre-baked at publish time from the selected-subject atoms (cluster-filtered per D138 when the dominance guard passes, otherwise the full frame).
- **preview_scene_v1** — the D1 TEXT NULLABLE column that holds the per-capsule preview scene JSON. Source of truth for poster + thumb rendering.
- **PreviewSceneV1** — the TypeScript shape stored in the `preview_scene_v1` column: `{ v:1, atoms[], bonds?, hash, thumb? }`. Declared in `src/share/capsule-preview-scene-store.ts`.
- **PreviewStoredThumbV1** — the pre-baked thumb payload embedded in `preview_scene_v1.thumb`, currently at `rev: CURRENT_THUMB_REV` (see that entry for the current value). Shape `{ rev, atoms, bonds? }` — the bytes the account-row thumbnail renders from without running the full pipeline.
- **previewThumb** — the nullable field on `/api/account/capsules` rows (`PreviewThumbV1 | null`) that carries the current-rev stored thumb out to the account UI.
- **canonical PCA camera** — the deterministic PCA basis + sign normalization + scene-shape classification (`spherical | planar | linear | general | degenerate`) + fixed 5°/10° tilt that makes a capsule project to the same 2D scene regardless of stored orientation. Lives in `src/share/capsule-preview-camera.ts`.
- **scene.hash** — the 8-hex FNV-1a32 digest over the projected atom array (bond-independent) inside `PreviewSceneV1`. Binds the dynamic-poster ETag and invalidates caches when any observable render input changes.
- **sampleForSilhouette** — extrema + FPS (farthest-point sampling) sampler used for the 32-atom poster subset. Lives in `src/share/capsule-preview-sampling.ts`.
- **sampleForBondedThumb** — graph-aware BFS + connection-count + FPS-fill sampler that selects a connected subgraph for the thumb, preserving visual structure. Paired with tiered visibility (strict → relaxed → atoms-only fallback).
- **bond-length-proportional sizing rule** — the shared atom-radius + bond-width rule used by both `CurrentPosterSceneSvg` and `CurrentThumbSvg`. Every absolute viewBox-unit size is a fixed fraction of the projected median bond length (`bondVb`): atom radius = `K_ATOM · bondVb` (K_ATOM=0.22), bond cylinder width = `(K_BOND_FILL + K_BOND_BORDER_DELTA) · bondVb` (0.15 + 0.05). Calibrated on C60. Source of truth: `src/share/capsule-preview-bond-scale.ts`.
- **bondVb** — median projected bond length in viewBox units (`medianBondLengthVb`); falls back to `medianNearestNeighborVb` when no bonds are present. Physical-scale proxy that feeds the bond-length-proportional sizing rule.
- **perspective multiplier** — the per-atom ±15% size modulation (`PERSPECTIVE_MULT_MIN=0.85`, `PERSPECTIVE_MULT_MAX=1.15`) applied around the median of stored `a.r`. Preserves the near/far brightness cue without letting the bake's absolute base-radius drive rendered size, which makes the renderer rev-stable across legacy bakes. Helper `perspectiveMultiplier` in `capsule-preview-bond-scale.ts`.
- **cylinder-bond rendering** — the three-stroke bond paint order used by both preview surfaces: `bond-edge` (shadow) → `bond-body` (ambient) → `bond-highlight` (specular), in a light-gray palette (`BOND_CYL_EDGE` / `BOND_CYL_BODY` / `BOND_CYL_HIGHLIGHT`). Replaces the earlier black-border / white-fill bond style. Data-role attributes on thumb lines expose the layer identity to tests.
- **bondless heal** — the specific lazy-backfill path that rebakes a row whose `preview_scene_v1` has atoms but neither `scene.bonds` nor `scene.thumb.bonds`. Driven by `sceneIsBondless` + `healBondlessRow` in `capsule-preview-heal.ts`. Repairs legacy rows baked before `publish-core.ts` switched to the lab/watch `buildBondTopologyFromAtoms` builder with `NEGATIVE_INFINITY` visibility thresholds and `bondsAwareThreshold: 0`.
- **CurrentPosterSceneSvg** — the shared Satori-compatible poster-pane React body (`src/share/capsule-preview-current-poster.tsx`). Default pane size is 600×600 with a dynamic, content-fitted viewBox; consumed by the dynamic poster Function and any downstream tooling that needs the byte-identical baseline.
- **CurrentThumbSvg** — the shared 100×100 (viewBox) account-row thumb React body (`src/share/capsule-preview-current-thumb.tsx`). Consumed by `account/main.tsx` for the production thumb.
- **CURRENT_THUMB_DEFAULT_INK** — TypeScript constant in `capsule-preview-current-thumb.tsx` that mirrors the light-scope `--color-text` token in `public/account-layout.css`. Enforced by `tests/unit/current-thumb-ink-sync.test.ts`; drift between the TS constant and the CSS token fails the test.
- **TEMPLATE_VERSION** — manually-bumped integer in `src/share/capsule-preview.ts` (currently `4`) that busts the dynamic-poster edge cache when the scene-rendering template changes. History: bumped to 3 on 2026-04-21 (D135 follow-up 2/3) when the poster renderer retargeted from `scene.thumb` back to `scene.atoms`/`scene.bonds` + the square-target aspect fix; bumped to 4 later the same day (D135 follow-up 4) when the poster scene bake switched from orthographic to pinhole perspective.
- **stored poster** — pre-rendered PNG persisted in R2 under `preview_poster_key`, served when `preview_status === 'ready'`. Cache key `?v=p<8hex>`.
- **dynamic fallback poster** — the PNG returned by `GET /api/capsules/:code/preview/poster` when no stored asset exists, rendered from `preview_scene_v1`. Cache key `?v=t<TEMPLATE_VERSION>`; ETag `"v<TEMPLATE_VERSION>-<8hex>"` bound to `[TEMPLATE_VERSION, scene.hash, sanitizedTitle, shareCode]`. Gated by `CAPSULE_PREVIEW_DYNAMIC_FALLBACK`.
- **terminal fallback** — the static `public/og-fallback.png` returned when dynamic rendering fails. Distinct from "dynamic fallback poster," which is the scene-projected path itself.

## Backend (common nouns — lowercase in prose)

- **signed intent** — a short-lived signed payload `{ action, payload, exp }` minted by a Function and consumed by a follow-up Function. Replaces session tokens for authenticated mutations.
- **admin gate** — the second check layered on top of `signed intent` for moderation and privacy-operator endpoints. Verifies a signed admin intent against an allowlist; failures are audit-logged.
- **age gate** — the one-time minimum-age attestation required before a user can create an account. Stored as a boolean; distinct from `policy acceptance`.
- **policy acceptance** — versioned terms acceptance tracked in D1 (policy version + timestamp). Re-acceptance is required when the version bumps; version is pinned at build time from `src/policy/policy-config.ts`.
- **erasure** — user-initiated account-and-data deletion flow routed through `/privacy-request`. Backed by a tombstone on the `users` row (not hard-delete) plus an ordered capsule-delete cascade.
- **primary-pill contract** — the UI contract enforced by `WatchLabEntryControl`: a single primary pill ("Interact From Here") with a caret-toggled disclosure popover revealing secondary actions; tooltip auto-cues at the 50% and 100% timeline milestones, once per file.

## File-extension brand

- **atomdojo** — lowercase file-extension brand (`.atomdojo`, `.atomdojo-history`, R2 key namespace). Distinct from the product name "Atom Dojo."
