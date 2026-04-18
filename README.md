# Atom Dojo (formerly NanoToybox)

**An interactive molecular dynamics playground that runs entirely in your browser.**

The public product is **Atom Dojo**; the repository, the npm package name, and parts of the internal documentation still use **NanoToybox** during the transition.

Try it now: **[atomdojo.pages.dev](https://atomdojo.pages.dev/lab/)** — no install, no sign-up to play.

https://github.com/user-attachments/assets/4de8167f-9bdc-4a9f-b5ee-2d8b42f60bd8

Watch the trajectory from the clip above: **[atomdojo.pages.dev/c/SS78S460KEFB](https://atomdojo.pages.dev/c/SS78S460KEFB)** — scrub it, then hit **Interact From Here** to take over the interactive engine from any frame.

<sub>Demo assets above (the video and the capsule link) are monitored documentation surfaces — treat them as part of the product. If either stops resolving, regenerate and update this section; see [docs/operations.md](docs/operations.md) for the capsule-durability checklist.</sub>

---

## What is Atom Dojo?

Atom Dojo bridges the gap between static chemistry textbooks and heavyweight academic MD codes like LAMMPS or GROMACS. It lets you reach into a carbon nanostructure and pull on it — drag a buckyball, twist a graphene sheet, collide two nanotubes — and the carbon responds through the **Tersoff bond-order potential**, a widely used classical interatomic model for covalent solids (parameters from J. Tersoff, *Phys. Rev. B* **39**, 5566 (1989); the model family is commonly referenced as "Tersoff 1988").

Forces are computed analytically every frame (F = −∇E) by a browser-side Tersoff engine. By default Atom Dojo runs a WebAssembly kernel inside a Web Worker; if Wasm is unavailable the engine falls back to a JavaScript kernel, and if the worker stalls it falls back again to synchronous main-thread execution. Bond breakage, reformation, and thermal vibration all emerge from the integration — nothing is pre-animated.

When you create a structural snap or a clean collision, one click publishes the trajectory as a compact binary "capsule" to a short URL. Anyone can watch the cinematic replay, and with one click jump into the interactive engine at the exact frame you shared — atoms, velocities, bonds, camera, and authored colors all preserved.

It is not a replacement for production MD codes. It is an interactive front door to the same family of physics.

---

## Core features

### The physics sandbox (Lab)

- **Tersoff bond-order potential for carbon** — C kernel compiled to WebAssembly (Emscripten) runs as the default, ~11% faster than the JavaScript fallback on ~2,400-atom scenes. `?kernel=js` forces the JS path for debugging.
- **Worker-first physics with graceful fallback** — simulation runs off the main thread via a snapshot protocol; if the worker stalls (5 s warning, 15 s fatal) the engine recovers or falls back to synchronous execution rather than freezing the page.
- **Velocity Verlet integrator** — symplectic, time-reversible, second-order accurate. Approximates NVE (energy-conserving) when damping is off; an adjustable slider lets you dissipate energy from zero to heavy.
- **Three.js rendering with InstancedMesh** — thousands of atoms drawn in two GPU draw calls with PBR materials and camera-relative lighting.
- **Direct manipulation** — drag single atoms, translate molecules, or apply torque to spin structures; full touch support on mobile.
- **15 pre-relaxed geometries** — C60 / C180 / C540 / C720 buckyballs, armchair / zigzag / chiral nanotubes, graphene sheets, diamond.
- **Containment boundary** — soft harmonic wall you can resize or remove, with live atom count and auto-scaling radius.
- **Bonded-group color editing** — paint groups from a swatch popover; color intents persist when bonds break and reform.

### The sharing loop (Watch)

- **Cinematic dual-cadence camera** — automatically frames the most prominent bonded cluster during playback, adapts to playback speed, pauses politely when you take camera control, and resumes after a cooldown.
- **Smooth playback** — recorded frames are upscaled to display rate at render time using interpolation; the default strategy is linear (the only stable method), with Hermite (velocity-based) and Catmull-Rom available as experimental options in settings.
- **Full transport controls** — play / pause / scrub / step, repeat, and a logarithmic speed dial from 0.5× to 20×.
- **Interact From Here** — a transactional handoff from Watch to Lab: scrub to any frame, click the primary pill, and a fresh Lab tab opens already loaded with that exact state (atoms, velocities, bonds, camera, and authored colors). Failures roll back cleanly to the default scene with a toast.
- **Capsule + full-history file support** — opens both the compact capsule format (position + authored appearance) and full simulation histories that carry bonds and motion state.

### Cloud architecture

Atom Dojo's share-link layer runs entirely on the **Cloudflare serverless stack**. Heavy compute (physics, rendering) lives in the browser; Cloudflare hosts the publishing, storage, and remix-loop machinery.

- **Pages Functions + D1** — Cloudflare's serverless SQL database (SQLite-compatible) handles OAuth (Google, GitHub), hardened `__Host-` session cookies, CSRF nonces, cursor-paginated account APIs, audit logs, and per-user + per-IP rate limits.
- **R2 object storage** — stores capsule bodies, addressed by 12-character Crockford Base32 share codes (e.g. `7M4K-2D8Q-9T1V`). R2's zero-egress pricing means bandwidth costs don't scale with traffic — only per-operation and storage fees apply.
- **Transactional hydration** — the Watch→Lab handoff coordinates the physics engine, worker, renderer, scene/store state, and the metadata/identity/appearance layers, with rollback to the pre-hydrate scene on any failure.
- **Privacy and safety** — server-enforced 13+ age gate on sign-in and publish, CSRF-protected privacy-request form with deduplication and 180-day retention, and a companion cron Worker that expires sessions, sweeps orphaned R2 objects, and runs audit-retention passes.

These features are **designed with COPPA and GDPR obligations in mind**; they have not been externally audited and no compliance certification is claimed.

---

## Repository layout

```
lab/             Interactive playground (React + Three.js + Worker)
lab/wasm/        Browser-side Wasm artifact (tersoff.js + tersoff.wasm)
watch/           Read-only trajectory viewer with smooth playback
viewer/          Minimal static trajectory viewer (drag-drop .xyz)
account/         Account self-service entrypoint
privacy/         Privacy policy entrypoint
terms/           Terms of service entrypoint
privacy-request/ GDPR / CCPA contact-form entrypoint
src/             Shared logic — topology, history schema, design tokens, policy
sim/             Python validation/reference engine; C Tersoff source in sim/wasm/
ml/              Force-decomposition + ML-surrogate pipeline (research, deferred)
functions/       Cloudflare Pages Functions (share-link backend)
workers/         Companion cron Worker for sweeps and retention
migrations/      D1 schema migrations
structures/      15 pre-relaxed canonical structures
docs/            Developer documentation
tests/           Unit (Vitest) + E2E (Playwright) + Python physics tests
```

---

## Run it locally

### Frontend only (no backend needed)

```bash
git clone https://github.com/mikechwu/NanoToybox.git
cd NanoToybox
npm install
npm run dev
# Open http://localhost:5173/lab/
```

### Full stack with share-link publishing

```bash
npm run build           # build dist/ first — Wrangler serves from it
npm run cf:d1:migrate   # apply D1 migrations to the local SQLite shim
npm run cf:dev          # wrangler pages dev with full D1 / R2 / Functions bindings
# Open http://localhost:8788/lab/
```

The full-stack flow needs OAuth credentials and a `SESSION_SECRET` in `.dev.vars`. See [docs/operations.md](docs/operations.md) for the runbook.

### Tests and checks

```bash
npm run typecheck             # TypeScript across frontend, functions, cron worker
npm run test:unit             # Vitest unit tests
npm run test:e2e              # Playwright against the Vite dev server
npm run test:e2e:pages-dev    # Playwright against `wrangler pages dev` (covers Functions)
```

### Scientific validation (Python)

A Python reference engine lives in `sim/`, and its validation suite is at `tests/test_*.py`. Optional but recommended when touching physics, structure generation, or force derivation:

```bash
pip install numpy numba matplotlib
python -m pytest tests/test_*.py -v
```

See [docs/testing.md](docs/testing.md) for the full test ladder and pass criteria.

---

## Documentation

- [Architecture](docs/architecture.md) — module map, data flow, state ownership across the physics, worker, renderer, and UI layers
- [Physics](docs/physics.md) — Tersoff potential, units, validation against the Python reference
- [Structure Library](docs/structure-library.md) — the 15 canonical structures and how they were generated
- [Viewer](docs/viewer.md) — Watch app behavior and the Watch→Lab handoff contract
- [Decisions](docs/decisions.md) — design rationale behind the big tradeoffs
- [Scaling Research](docs/scaling-research.md) — real-time browser limits and benchmarks
- [Testing](docs/testing.md) — test ladder, pass criteria, and the Pages-dev E2E lane
- [Operations](docs/operations.md) — deployment runbook, secrets, sweeps, reconciliation
- [Contributing](docs/contributing.md) — workflow, conventions, shared utilities
- [ML Surrogate](docs/ml-surrogate.md) — force decomposition and training pipeline (deferred)

---

## Contributing

Contributions are welcome. Start with [docs/contributing.md](docs/contributing.md) for workflow, conventions, and the shared-utility catalog, then file an issue or open a PR. For design discussion before code, start an issue or draft PR with the context first — most of the non-obvious tradeoffs are already captured in [docs/decisions.md](docs/decisions.md).

---

## Support

- **Bug reports and feature requests:** [github.com/mikechwu/NanoToybox/issues](https://github.com/mikechwu/NanoToybox/issues)
- **Privacy or data requests:** the in-app [privacy-request form](https://atomdojo.pages.dev/privacy-request/)

---

## Acknowledgments

- **Jerry Tersoff** for the bond-order empirical potential (*Phys. Rev. B* **39**, 5566 (1989)).
- **Three.js** for the WebGL rendering primitives.
- **Cloudflare** for the serverless platform — Pages, Pages Functions, D1, R2, and Workers — that makes the share-and-remix loop viable without running a backend.

---

## License

[MIT](LICENSE) © 2026 Michael Wu.
