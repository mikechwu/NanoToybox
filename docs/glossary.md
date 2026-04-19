# Glossary

Canonical terms used across `docs/README.md` and `docs/architecture.md`. Each entry below shows the **exact form** a term takes in prose. Proper nouns are capitalized (`Lab`, `Watch`, `Viewer`, `Atom Dojo`); common nouns are lowercase (`capsule`, `handoff`, `share link`). When any of these terms appears in either doc, it uses the form shown here.

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

## Capsule preview (common nouns — lowercase in prose)

- **Capsule Preview** — the V1 deterministic figure system that powers both the account-row thumbnail and the public OG poster. Proper noun for the subsystem; the rendered artifacts are "preview thumbnail" / "preview poster."
- **CapsulePreviewDescriptor** — presentation-ready, deterministic descriptor produced by `buildCapsulePreviewDescriptor` in `src/share/capsule-preview.ts`. Pure function of `CapsulePreviewInput`; geometry-affecting fields depend ONLY on `shareCode + kind`.
- **figure variant** — one of `lattice-hex | lattice-cubic | cluster-orbital | chain-helix | ring-fused | neutral-brand`. The first five are molecular layouts; `neutral-brand` is the safe wordmark tile rendered for unknown / non-molecular `kind` values (the wrong-audience fallback).
- **TEMPLATE_VERSION** — manually-bumped integer in `src/share/capsule-preview.ts` that busts the dynamic-poster edge cache when the static-figure design changes.
- **stored poster** — pre-rendered PNG persisted in R2 under `preview_poster_key`, served when `preview_status === 'ready'`.
- **dynamic fallback poster** — the Satori-rendered PNG returned by `GET /api/capsules/:code/preview/poster` when no stored asset exists. Gated by `CAPSULE_PREVIEW_DYNAMIC_FALLBACK`.
- **terminal fallback** — the static `public/og-fallback.png` returned when Satori rendering fails. Distinct from "dynamic fallback poster," which is the Satori path itself.

## Backend (common nouns — lowercase in prose)

- **signed intent** — a short-lived signed payload `{ action, payload, exp }` minted by a Function and consumed by a follow-up Function. Replaces session tokens for authenticated mutations.
- **admin gate** — the second check layered on top of `signed intent` for moderation and privacy-operator endpoints. Verifies a signed admin intent against an allowlist; failures are audit-logged.
- **primary-pill contract** — the UI contract enforced by `WatchLabEntryControl`: a single primary pill ("Interact From Here") with a caret-toggled disclosure popover revealing secondary actions; tooltip auto-cues at the 50% and 100% timeline milestones, once per file.

## File-extension brand

- **atomdojo** — lowercase file-extension brand (`.atomdojo`, `.atomdojo-history`, R2 key namespace). Distinct from the product name "Atom Dojo."
