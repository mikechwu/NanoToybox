## Summary

<!-- Brief description of changes -->

## Manual Verification (WebGL-dependent)

These checks cannot run in headless CI. Complete before merging to main:

- [ ] **Main app:** `/lab/` — Add structure → place on canvas → verify atom count → Settings → Clear → verify "Empty playground"
- [ ] **Settings:** Open/close settings sheet, switch Dark/Light theme
- [ ] **Viewer:** `/viewer/` — Drag-drop `.xyz` file → atoms and bonds render

> Automated checks (typecheck, build, Playwright E2E, deploy smoke) run in CI.
> See [docs/README.md](docs/README.md#pre-deploy-manual-checklist-webgl-dependent) for details.
