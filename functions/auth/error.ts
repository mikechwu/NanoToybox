/**
 * GET /auth/error?reason=acceptance_failed&provider=google
 *
 * Friendly landing page for OAuth callback failures. Currently only
 * surfaced when `findOrCreateUserWithPolicyAcceptance` cannot record
 * the 13+ acceptance row (e.g., brand-new account whose OAuth state
 * predates the post-clickwrap deploy, or a transient D1 error).
 *
 * Contract:
 *
 *   - whitelists `reason` and `provider`. Anything else falls through
 *     to a generic copy. The validated enum drives the rendered text;
 *     raw query values are NEVER reflected into the HTML, so a link
 *     like `/auth/error?reason=<script>alert(1)</script>` cannot
 *     inject markup.
 *
 *   - returns 200 (the request itself is fine — the previous OAuth
 *     callback already redirected here).
 *
 *   - emits `Cache-Control: no-store` so a recovery page isn't cached
 *     on the user's device or by intermediaries.
 *
 *   - does NOT read or set any session cookie. The matching callback
 *     bails before `createSessionAndRedirect`, so the invariant
 *     "callback acceptance failure ⇒ no session" holds end-to-end.
 *
 * The Retry link returns the user to /lab/, where the existing entry
 * points (AccountControl, Transfer dialog) reinitiate OAuth from a
 * clean state — the next attempt mints fresh OAuth state with the
 * `age13PlusConfirmed` marker and succeeds atomically.
 */

const KNOWN_REASONS = ['acceptance_failed', 'oauth_failed'] as const;
const KNOWN_PROVIDERS = ['google', 'github'] as const;

type Reason = (typeof KNOWN_REASONS)[number];
type Provider = (typeof KNOWN_PROVIDERS)[number];

function whitelistReason(raw: string | null): Reason {
  return KNOWN_REASONS.includes(raw as Reason) ? (raw as Reason) : 'oauth_failed';
}

function whitelistProvider(raw: string | null): Provider | null {
  return KNOWN_PROVIDERS.includes(raw as Provider) ? (raw as Provider) : null;
}

function providerLabel(p: Provider | null): string {
  if (p === 'google') return 'Google';
  if (p === 'github') return 'GitHub';
  return 'your provider';
}

function bodyForReason(reason: Reason, provider: Provider | null): string {
  const provLabel = providerLabel(provider);
  if (reason === 'acceptance_failed') {
    return (
      `<p>Sign-in with ${provLabel} succeeded, but we couldn't finish ` +
      `recording your agreement to our policies. No account session ` +
      `was created. Please try again.</p>`
    );
  }
  return (
    `<p>Sign-in with ${provLabel} did not finish. No account session ` +
    `was created. Please try again.</p>`
  );
}

function renderHtml(reason: Reason, provider: Provider | null): string {
  return (
    '<!doctype html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Sign-in didn\'t finish — atomdojo</title>' +
    '<style>' +
    'body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'color:#222;background:#fafafa;padding:32px 16px;margin:0;}' +
    'main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;' +
    'border-radius:8px;padding:24px;}' +
    'h1{font-size:20px;margin:0 0 12px;}' +
    'p{margin:0 0 16px;}' +
    'nav a{margin-right:16px;color:#06c;text-decoration:underline;}' +
    'nav a:focus-visible{outline:2px solid #06c;outline-offset:2px;}' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<main>' +
    '<h1>Sign-in didn\'t finish</h1>' +
    bodyForReason(reason, provider) +
    '<nav aria-label="Recovery actions">' +
    '<a href="/lab/">Try again</a>' +
    '<a href="/privacy/">Privacy Policy</a>' +
    '<a href="/terms/">Terms</a>' +
    '</nav>' +
    '</main>' +
    '</body>' +
    '</html>'
  );
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  const reason = whitelistReason(url.searchParams.get('reason'));
  const provider = whitelistProvider(url.searchParams.get('provider'));
  return new Response(renderHtml(reason, provider), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};
