# Atom Dojo Documentation

**Atom Dojo** is an interactive molecular dynamics playground that runs entirely in your browser. Build carbon nanostructures, pull on them with real physics, record the trajectory, and publish it as a one-click share link. Two frontends cooperate: **Lab** at `/lab/` for authoring and simulation, **Watch** at `/watch/` for playback and review. A Cloudflare backend (Pages Functions + D1 + R2) handles share links, accounts, and moderation.

> See the repo-root [README](../README.md) for product marketing: live demo, screencast, sample capsule, and physics citation.

## What You Can Do Today

- Build and simulate carbon structures in Lab — drag, twist, collide, and watch bonds form and break.
- Export the trajectory as a compact **capsule** (`.atomdojo`) or a full history (`.atomdojo-history`).
- Open an exported file in Watch, scrub the timeline, and share the link.
- From any frame in Watch, click **Interact From Here** to hand off the scene to Lab and take over the engine.
- Share a capsule link anywhere — every `/c/:code` page renders a 1200×630 social preview card, and account upload lists show per-row thumbnails (see [operations.md](operations.md) for the `/api/capsules/:code/preview/poster` endpoint and the `CAPSULE_PREVIEW_DYNAMIC_FALLBACK` env var).

## Repository At A Glance

| Directory | Purpose |
|---|---|
| `lab/` | Lab frontend: authoring, simulation loop, React UI, Three.js renderer |
| `watch/` | Watch frontend: capsule/history playback, review, handoff trigger |
| `viewer/` | Thin static XYZ viewer (distinct from Watch) |
| `src/` | Shared TypeScript core: history schema, topology, UI primitives, handoff contract |
| `functions/` | Cloudflare Pages Functions: share links, auth, moderation APIs |
| `workers/` | Cloudflare cron worker (capsule cleanup, reconciliation) |
| `sim/`, `ml/` | Python research and ML surrogate tooling |
| `migrations/` | D1 schema migrations |
| `structures/` | Bundled sample structures |
| `public/`, `account/`, `privacy/`, `privacy-request/`, `terms/` | Static assets and policy/account surfaces |
| `scripts/` | Build and maintenance scripts |
| `tests/` | Unit (Vitest) and end-to-end (Playwright) tests |
| `docs/` | This directory |

## Quick Start

```bash
npm install              # first time only
npm run dev              # Vite dev server with HMR
# → Lab:   http://localhost:5173/lab/
# → Watch: http://localhost:5173/watch/

npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
```

Optional — Python physics tests (requires `numpy`, `numba`):

```bash
python -m pytest tests/test_*.py -v
```

## Read This Next

| Doc | When to read |
|---|---|
| [architecture.md](architecture.md) | New engineers and maintainers — system mental model, Lab/Watch/shared/backend boundaries, key runtime flows |
| [viewer.md](viewer.md) | UI/UX contributors — Lab and Watch viewer behavior, Watch→Lab entry control, tooltip contract |
| [physics.md](physics.md) | Anyone touching force calculation — Tersoff potential, integrator, units, validation |
| [testing.md](testing.md) | Before every merge — test ladder, pass criteria, manual WebGL checks, Pages-dev E2E lane |
| [operations.md](operations.md) | Deploying or on-call — backend runbook, endpoints, cron, privacy-request operator flow |
| [contributing.md](contributing.md) | Adding code — code style, architecture rules, extension points |
| [decisions.md](decisions.md) | Why things are shaped this way — historical rationale |
| [scaling-research.md](scaling-research.md) | Performance research — browser limits, collision benchmarks |
| [ml-surrogate.md](ml-surrogate.md) | Deferred ML track — force decomposition, training notes |
| [structure-library.md](structure-library.md) | Bundled structures — generation pipeline, CLI usage |
| [glossary.md](glossary.md) | Terminology — Lab, Watch, capsule, handoff, share link, and internal terms used in architecture.md |

## Before Merge

Automated gates (`typecheck`, `test:unit`, `test:e2e`, `build`) run in CI on every push and PR. Manual WebGL-dependent checks live in [testing.md](testing.md); run them before tagging a release or deploying to production.
