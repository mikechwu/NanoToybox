/**
 * @vitest-environment jsdom
 *
 * Render-level gate for `CurrentThumbSvg` at the SHIPPED display
 * size (`ACCOUNT_THUMB_SIZE`). Runs SSR through the shared fixture
 * renderer, snapshots the SVG, AND writes a static HTML harness
 * under `tests/e2e/fixtures/thumb-visual/` as a side effect so the
 * Playwright visual-regression spec can reload it byte-for-byte
 * without scraping vitest's snapshot format.
 *
 * The user-observed "unrecognizable at 40 px" failure mode kept
 * passing the data-shape tests because those asserted derived
 * geometry, not the final rendered SVG. This file fills that gap
 * in three ways:
 *
 *   1. Lock the shipped visual grammar (flat-black atoms + white-
 *      bond with black border) at the shared display size.
 *   2. Snapshot the SVG markup for every named fixture so any
 *      renderer tweak that shifts pixels is visible in diff review.
 *   3. Regenerate the Playwright HTML harness at the same time, so
 *      both gates always pin to the same code path.
 *
 * Running:
 *   npx vitest run tests/unit/current-thumb-render.test.tsx
 *   npx vitest run --update tests/unit/current-thumb-render.test.tsx
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  NAMED_FIXTURE_KEYS,
  renderFixtureThumbSvg,
  buildThumbHtmlHarness,
  thumbForFixture,
} from '../../src/share/__fixtures__/thumb-visual-fixtures';
import {
  CURRENT_THUMB_STYLE,
} from '../../src/share/capsule-preview-current-thumb';
import { ACCOUNT_THUMB_SIZE } from '../../src/share/capsule-preview-thumb-size';

const HARNESS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..', 'e2e', 'fixtures', 'thumb-visual',
);

beforeAll(() => {
  // Write one HTML harness per named fixture. Committing these
  // files lets the Playwright spec navigate via `file://` with no
  // runtime dependency on React, react-dom/server, or the Vitest
  // snapshot format. The files regenerate on every vitest pass, so
  // they are kept in sync with the shipped renderer.
  fs.mkdirSync(HARNESS_DIR, { recursive: true });
  for (const name of NAMED_FIXTURE_KEYS) {
    const svg = renderFixtureThumbSvg(name);
    const html = buildThumbHtmlHarness({
      svgMarkup: svg,
      size: ACCOUNT_THUMB_SIZE,
    });
    fs.writeFileSync(path.join(HARNESS_DIR, `${name}.html`), html);
  }
});

describe('CurrentThumbSvg — shipped-size render gate', () => {
  it(`emits the shipped visual grammar at ACCOUNT_THUMB_SIZE=${ACCOUNT_THUMB_SIZE}`, () => {
    const svg = renderFixtureThumbSvg('c60');
    expect(svg).toContain(`width="${ACCOUNT_THUMB_SIZE}"`);
    expect(svg).toContain(`height="${ACCOUNT_THUMB_SIZE}"`);
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain('data-role="bond-border"');
    expect(svg).toContain('data-role="bond-fill"');
    expect(svg).toContain(`stroke="${CURRENT_THUMB_STYLE.bondFillStroke}"`);
    expect(svg).toContain(`stroke="${CURRENT_THUMB_STYLE.bondBorderStroke}"`);
    // Under the EXPERIMENTAL-grammar preset atoms fill via
    // `url(#gradient)`, not a flat hex. Assert each gradient stop
    // reaches the rendered SVG (React SSR kebab-cases the
    // `stopColor` prop → `stop-color` attribute).
    expect(svg).toContain(`stop-color="${CURRENT_THUMB_STYLE.atomFillMid}"`);
    expect(svg).toContain(`stop-color="${CURRENT_THUMB_STYLE.atomHighlight}"`);
    expect(svg).toContain(`stop-color="${CURRENT_THUMB_STYLE.atomShadow}"`);
    expect(svg).toContain('<defs>');
    expect(svg).toContain('<radialGradient');
  });

  it('renders bonds border-below-fill in DOM paint order', () => {
    const svg = renderFixtureThumbSvg('c60');
    const borderIdx = svg.indexOf('data-role="bond-border"');
    const fillIdx = svg.indexOf('data-role="bond-fill"');
    expect(borderIdx).toBeGreaterThan(0);
    expect(fillIdx).toBeGreaterThan(borderIdx);
  });

  for (const name of NAMED_FIXTURE_KEYS) {
    it(`produces a stable ${name} golden SVG markup`, () => {
      expect(renderFixtureThumbSvg(name)).toMatchSnapshot(`${name}.svg`);
    });
  }

  it('derives the expected thumb shape for C60 at the raised caps', () => {
    // Locks the pipeline-level invariants alongside the render test,
    // so a cap regression (e.g. ROW_*_CAP silently reverting) shows
    // up here with a clear signal.
    const thumb = thumbForFixture('c60');
    expect(thumb.atoms.length).toBeGreaterThanOrEqual(36);
    expect((thumb.bonds ?? []).length).toBeGreaterThanOrEqual(30);
  });
});
