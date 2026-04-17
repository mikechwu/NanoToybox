## Summary

<!-- Brief description of changes -->

## Manual Verification (WebGL-dependent)

These checks cannot run in headless CI. Complete before merging to main:

- [ ] **Main app:** `/lab/` — Add structure → place on canvas → verify atom count → Settings → Clear → verify "Empty playground"
- [ ] **Settings:** Open/close settings sheet, switch Dark/Light theme
- [ ] **Viewer:** `/viewer/` — Drag-drop `.xyz` file → atoms and bonds render
- [ ] **Watch→Lab handoff** (only if touched): open a shared capsule in `/watch/` → "Open in Lab" → scene hydrates; if the handoff payload/schema changed, also confirm a pre-change link still deserializes
- [ ] **Scene replacement** (only if touched): any path that swaps scene contents uses `clearScene + appendMolecule` rather than `restoreCheckpoint` / `restoreState`

> Automated checks (typecheck [frontend + functions + cron Worker], build, Playwright E2E, deploy smoke) run in CI.
> See [docs/README.md](docs/README.md#pre-deploy-manual-checklist-webgl-dependent) for details.
