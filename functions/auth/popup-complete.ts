/**
 * GET /auth/popup-complete — tiny landing page that closes an OAuth popup.
 *
 * Flow:
 *   1. Lab opens an auth popup via window.open(/auth/{provider}/start?returnTo=/auth/popup-complete)
 *   2. Provider consent → provider callback → session cookie set.
 *   3. Server redirects the popup to this page.
 *   4. This page notifies the opener via TWO channels, in order of preference:
 *        a. window.opener.postMessage({ type: 'atomdojo-auth-complete' }, origin)
 *        b. BroadcastChannel('atomdojo-auth').postMessage(...)  (same-origin only)
 *      The dual-channel notification handles the case where a
 *      Cross-Origin-Opener-Policy response severed `window.opener` — the
 *      postMessage silently fails delivery, but the BroadcastChannel picks
 *      up the signal on the opener's tab.
 *   5. The popup attempts `window.close()`. If that also fails (e.g.
 *      popups opened through a cross-origin redirect chain that Safari
 *      won't close), a 300ms timer updates the DOM with a stuck-state
 *      recovery message so the user has an actionable hint instead of
 *      staring at a spinner.
 *
 * Security:
 *   - postMessage targets window.location.origin — not '*' — so the
 *     message is delivered only if the opener is same-origin.
 *   - BroadcastChannel is same-origin by definition; no new security
 *     envelope beyond postMessage.
 *   - The message carries no secrets. The session cookie is HttpOnly
 *     and already set on the opener's origin by the callback redirect.
 *   - No user-controlled data is echoed into the HTML. All strings are
 *     static literals.
 */

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Signing you in…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0b0d10; color: #d0d4da;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; align-items: center; justify-content: center; }
  .card { text-align: center; padding: 24px 32px; max-width: 360px; }
  .spinner { width: 24px; height: 24px; border-radius: 50%;
    border: 2px solid #3a4048; border-top-color: #d0d4da;
    animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .note { color: #8a9099; font-size: 12px; margin-top: 8px; }
  .stuck-title { font-size: 15px; font-weight: 500; margin: 0 0 6px; }
  .stuck-note { color: #8a9099; font-size: 12px; line-height: 1.5; }
  [data-state="stuck"] .spinner { display: none; }
</style>
</head>
<body>
<main class="card" id="card">
  <div class="spinner" aria-hidden="true"></div>
  <p id="primary">Signing you in…</p>
  <p class="note" id="secondary">You can close this tab if it doesn't close automatically.</p>
</main>
<script>
(function () {
  var POPUP_STUCK_DELAY_MS = 300;
  function showStuck() {
    try {
      var card = document.getElementById('card');
      if (card) card.setAttribute('data-state', 'stuck');
      var primary = document.getElementById('primary');
      if (primary) {
        primary.className = 'stuck-title';
        primary.textContent = 'Sign-in completed.';
      }
      var secondary = document.getElementById('secondary');
      if (secondary) {
        secondary.className = 'stuck-note';
        secondary.textContent =
          'We couldn\\'t notify the original tab automatically. ' +
          'Close this tab and refresh the Lab tab to continue.';
      }
    } catch (_) { /* best-effort DOM update */ }
  }

  var notified = false;

  // Channel 1: direct postMessage to opener. Fails when window.opener is
  // null/closed/severed-by-COOP.
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        { type: 'atomdojo-auth-complete' },
        window.location.origin
      );
      notified = true;
    }
  } catch (_) { /* opener may be cross-origin or gone — fall through to BroadcastChannel */ }

  // Channel 2: BroadcastChannel same-origin fallback. Works even when
  // window.opener is severed, as long as the opener tab is still open
  // on the same origin and subscribed.
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      var bc = new BroadcastChannel('atomdojo-auth');
      bc.postMessage({ type: 'atomdojo-auth-complete' });
      // Give the message a tick to flush before close() might tear down
      // the channel; we deliberately don't close bc here because the
      // browser closes it on document unload anyway.
      notified = true;
    }
  } catch (_) { /* older browsers — show stuck state below */ }

  if (!notified) {
    // Neither channel delivered. Tell the user what to do; don't
    // attempt to close since a best-effort postMessage below would be
    // pointless too.
    showStuck();
    return;
  }

  // Give the message 50ms to flush, then try to close. If close()
  // doesn't succeed (Safari cross-origin-chain restriction, or an
  // extension intercepted the open), surface the stuck-state hint
  // a bit later so the user isn't left staring at a spinner.
  setTimeout(function () {
    try { window.close(); } catch (_) { /* ignore */ }
    setTimeout(function () {
      // If we're still rendering, close() didn't take effect.
      if (!document.hidden) showStuck();
    }, POPUP_STUCK_DELAY_MS);
  }, 50);
}());
</script>
</body>
</html>
`;

export const onRequestGet: PagesFunction = async () => {
  return new Response(HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Strict CSP: allow only same-origin + the inline bootstrap script
      // (the only inline code on the page). No external loads, no eval.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
};
