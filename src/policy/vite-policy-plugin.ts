/**
 * Vite plugin: inject the policy config into /privacy and /terms HTML at build time.
 *
 * Replaces:
 *   - `<!--POLICY_META-->`     → two `<meta>` tags (version + active segments)
 *   - `__POLICY_VERSION__`     → POLICY_VERSION literal
 *   - `<!--POLICY_FEATURES-->` → JSON `<script type="application/json" id="policy-features">`
 *
 * Smoke checks (`scripts/deploy-smoke.sh`) and E2E
 * (`tests/e2e/policy-routes.spec.ts`) read the meta tags at runtime, so
 * a phase rollout updates THIS module's source-of-truth and nothing
 * else.
 */

import type { Plugin } from 'vite';
import {
  POLICY_VERSION,
  POLICY_FEATURES,
  activeSegmentsCsv,
} from './policy-config';

const POLICY_PATH_PREFIXES = ['/privacy', '/terms'];

function shouldTransform(path: string | undefined): boolean {
  if (!path) return false;
  return POLICY_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function policyConfigPlugin(): Plugin {
  return {
    name: 'atomdojo-policy-config',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!shouldTransform(ctx.path)) return html;

        const metaBlock = [
          `<meta name="policy-version" content="${POLICY_VERSION}">`,
          `<meta name="policy-active-segments" content="${activeSegmentsCsv()}">`,
        ].join('\n  ');

        const featuresBlock = `<script type="application/json" id="policy-features">${JSON.stringify(POLICY_FEATURES)}</script>`;

        // Each placeholder MUST be present — String.replace silently
        // returns the original string when the marker is missing,
        // which would ship a policy page with no version meta tag and
        // pass smoke tests if the assertion isn't strict. Throwing at
        // build time is free and turns a class of silent regressions
        // into a hard CI failure.
        const requirePlaceholder = (marker: string): void => {
          if (!html.includes(marker)) {
            throw new Error(
              `[policy-config-plugin] page ${ctx.path} is missing required placeholder ${marker}`,
            );
          }
        };
        requirePlaceholder('<!--POLICY_META-->');
        requirePlaceholder('<!--POLICY_FEATURES-->');
        requirePlaceholder('__POLICY_VERSION__');

        return html
          .replace('<!--POLICY_META-->', metaBlock)
          .replace('<!--POLICY_FEATURES-->', featuresBlock)
          .replace(/__POLICY_VERSION__/g, POLICY_VERSION);
      },
    },
  };
}
