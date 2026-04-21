/**
 * Shared `waitUntil` wrapper for Cloudflare Pages Functions.
 *
 * Usage (production):
 *   scheduleBackground(context, someAsyncWork())
 *
 * Usage (minimal vitest context with no `waitUntil` wired up):
 *   scheduleBackground({} as any, someAsyncWork())  // detached
 *
 * The production path forwards to `ctx.waitUntil` so the edge
 * runtime holds the request alive until the detached promise
 * settles. The test path falls back to a detached `.catch` so the
 * promise still runs to completion but its rejection doesn't crash
 * the test harness.
 *
 * Consolidates the inline helpers that previously lived in
 * `functions/api/capsules/publish.ts` and
 * `functions/api/account/capsules/index.ts`.
 */

export interface WaitUntilContext {
  waitUntil?: (p: Promise<unknown>) => void;
}

/** Run `promise` as detached background work. Errors are logged
 *  via `console.warn(\`[${tag}] background-rejected: ...\`)` so a
 *  systematic failure (D1 down, R2 permissions, etc.) surfaces in
 *  the worker log instead of vanishing into a silent
 *  `.catch(() => {})`. */
export function scheduleBackground(
  ctx: WaitUntilContext,
  promise: Promise<unknown>,
  tag: string = 'scheduleBackground',
): void {
  const wrapped = promise.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${tag}] background-rejected: ${msg}`);
  });
  if (typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(wrapped);
  }
  // If `ctx.waitUntil` is absent, the attached `.catch` is enough —
  // the promise will still run and its rejection is logged.
}
