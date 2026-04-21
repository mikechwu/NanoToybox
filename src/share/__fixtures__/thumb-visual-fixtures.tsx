/**
 * Shared fixture renderer for the account-row thumbnail.
 *
 * One function-per-fixture, each returning the SVG markup for a
 * named capsule fixture at a given render size. The same helper is
 * consumed by:
 *
 *   - `tests/unit/current-thumb-render.test.tsx` — vitest snapshot of
 *     the exact rendered SVG source.
 *   - `tests/e2e/thumb-visual.spec.ts` — Playwright browser-level
 *     visual regression; the spec loads a static HTML harness that
 *     this helper prepared on the vitest pass, avoiding
 *     snapshot-scraping and the "Playwright test-loader wraps React
 *     nodes" issue.
 *
 * Calling this helper from the vitest pass (as a side effect of the
 * snapshot test) keeps BOTH gates in sync — when the renderer
 * changes, the vitest snapshot is refreshed and the Playwright HTML
 * harness is regenerated from the same code path. There is no
 * tooling-format coupling between the two.
 *
 * Pure React/Node module; no DOM, no Playwright, no Cloudflare APIs.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CurrentThumbSvg,
  type CurrentThumbStylePreset,
} from '../capsule-preview-current-thumb';
import { ACCOUNT_THUMB_SIZE } from '../capsule-preview-thumb-size';
import { deriveAccountThumb } from '../capsule-preview-account-derive';
import { projectCapsuleToSceneJson } from '../publish-core';
import {
  makeC60Capsule,
  makeGrapheneCapsule,
  makeSimpleOrganicCapsule,
} from './capsule-preview-structures';
import type { PreviewThumbV1 } from '../capsule-preview-scene-store';
import type { AtomDojoPlaybackCapsuleFileV1 } from '../../history/history-file-v1';

/** Named capsule fixtures available to the visual-render helpers.
 *  Adding a fixture here makes it available to both vitest + the
 *  Playwright harness without further plumbing. */
export const NAMED_CAPSULE_FIXTURES = {
  c60: makeC60Capsule,
  graphene: makeGrapheneCapsule,
  glycine: makeSimpleOrganicCapsule,
} as const;

export type NamedCapsuleFixture = keyof typeof NAMED_CAPSULE_FIXTURES;

export const NAMED_FIXTURE_KEYS: ReadonlyArray<NamedCapsuleFixture>
  = Object.keys(NAMED_CAPSULE_FIXTURES) as NamedCapsuleFixture[];

function buildCapsule(name: NamedCapsuleFixture): AtomDojoPlaybackCapsuleFileV1 {
  return NAMED_CAPSULE_FIXTURES[name]();
}

/** Produce the exact `PreviewThumbV1` the account route receives for
 *  a given named fixture — runs the capsule through the real publish
 *  pipeline (`projectCapsuleToSceneJson`) and the read-path helper
 *  (`deriveAccountThumb`). */
export function thumbForFixture(name: NamedCapsuleFixture): PreviewThumbV1 {
  const capsule = buildCapsule(name);
  const sceneJson = projectCapsuleToSceneJson(capsule);
  if (!sceneJson) {
    throw new Error(`thumbForFixture: projection returned null for ${name}`);
  }
  const thumb = deriveAccountThumb(sceneJson);
  if (!thumb) {
    throw new Error(`thumbForFixture: derivation returned null for ${name}`);
  }
  return thumb;
}

/** Render the account-row thumb SVG for a named fixture, at a given
 *  size, through an optional style preset. Default size is the shared
 *  `ACCOUNT_THUMB_SIZE` so moving that constant moves every
 *  downstream test and harness at once.
 *
 *  A deterministic `gradientId` is always passed so the rendered
 *  markup is reproducible across runs (the production renderer
 *  uses `crypto.randomUUID` to sidestep HMR collisions, which
 *  otherwise makes snapshots non-deterministic). */
export function renderFixtureThumbSvg(
  name: NamedCapsuleFixture,
  opts: { size?: number; style?: CurrentThumbStylePreset } = {},
): string {
  const thumb = thumbForFixture(name);
  const size = opts.size ?? ACCOUNT_THUMB_SIZE;
  return renderToStaticMarkup(
    <CurrentThumbSvg
      thumb={thumb}
      size={size}
      style={opts.style}
      gradientId={`fixture-${name}`}
    />,
  );
}

/** Standard HTML harness that wraps a thumb SVG in an account-row-
 *  like context (matching background + ink tokens). Used by the
 *  Playwright visual regression to screenshot a faithful cell. */
export function buildThumbHtmlHarness(opts: {
  svgMarkup: string;
  size: number;
  /** Ambient background color of the account row at rest. Mirrors
   *  the `--color-surface` token of the light account theme. */
  background?: string;
  /** `currentColor` the background rect resolves to outside the
   *  account CSS scope. */
  ink?: string;
}): string {
  const bg = opts.background ?? '#faf8f4';
  const ink = opts.ink ?? '#444444';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: ${bg};
    color: ${ink};
    font-family: ui-sans-serif, system-ui, -apple-system;
  }
  body { padding: 8px; }
  #thumb-host {
    width: ${opts.size}px;
    height: ${opts.size}px;
    display: inline-block;
  }
  #thumb-host svg { display: block; }
</style>
</head>
<body>
<div id="thumb-host">${opts.svgMarkup}</div>
</body>
</html>`;
}
