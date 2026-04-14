/**
 * Privacy-request form runtime.
 *
 * - Fetches a signed CSRF nonce on page load (and refreshes it after
 *   8 minutes — server TTL is 10 min).
 * - Counter UX on the message field; submit stays disabled while over.
 * - Submits to POST /api/privacy-request and renders a status panel
 *   with the assigned id (or a recoverable error).
 */

const NONCE_REFRESH_MS = 8 * 60 * 1000;
const MAX_CHARS = 2000;

interface NonceResponse {
  nonce: string;
  ttlSeconds: number;
}

interface SubmitResponse {
  ok?: boolean;
  id?: string;
  submittedAt?: number;
  error?: string;
  message?: string;
  maxChars?: number;
  actualChars?: number;
}

const form = document.getElementById('privacy-request-form') as HTMLFormElement | null;
const submit = document.getElementById('pr-submit') as HTMLButtonElement | null;
const message = document.getElementById('pr-message') as HTMLTextAreaElement | null;
const counter = document.getElementById('pr-counter') as HTMLDivElement | null;
const status = document.getElementById('pr-status') as HTMLDivElement | null;

let currentNonce: string | null = null;

async function fetchNonce(): Promise<void> {
  try {
    const res = await fetch('/api/privacy-request/nonce', { credentials: 'include' });
    if (!res.ok) throw new Error(`nonce ${res.status}`);
    const data = (await res.json()) as NonceResponse;
    currentNonce = data.nonce;
    updateSubmitState();
  } catch (err) {
    console.error(`[privacy-request] nonce fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    currentNonce = null;
    showStatus('error', 'Could not initialize the form. Please refresh and try again.');
  }
}

function updateSubmitState(): void {
  if (!submit || !message) return;
  const len = message.value.length;
  const overLimit = len > MAX_CHARS;
  submit.disabled = !currentNonce || len === 0 || overLimit;
}

function updateCounter(): void {
  if (!message || !counter) return;
  const len = message.value.length;
  counter.textContent = `${len.toLocaleString()} / ${MAX_CHARS.toLocaleString()} characters`;
  counter.classList.toggle('pr-counter--over', len > MAX_CHARS);
  updateSubmitState();
}

function showStatus(kind: 'ok' | 'error', text: string): void {
  if (!status) return;
  status.hidden = false;
  status.className = `pr-status pr-status--${kind}`;
  status.textContent = text;
}

async function onSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!form || !submit) return;
  if (!currentNonce) {
    showStatus('error', 'No CSRF nonce — please refresh the page.');
    return;
  }
  const data = new FormData(form);
  const payload = {
    contact_value: String(data.get('contact_value') ?? '').trim(),
    request_type: String(data.get('request_type') ?? ''),
    message: String(data.get('message') ?? ''),
    honeypot: String(data.get('honeypot') ?? ''),
    nonce: currentNonce,
  };

  submit.disabled = true;
  try {
    const res = await fetch('/api/privacy-request', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as SubmitResponse;
    if (res.ok && body.ok) {
      showStatus(
        'ok',
        body.id === 'honeypot'
          ? 'Thanks — your request was received.'
          : `Thanks — your request was received. Reference id: ${body.id}.`,
      );
      form.reset();
      updateCounter();
    } else if (res.status === 401) {
      showStatus('error', 'Session expired — please refresh and submit again.');
      await fetchNonce();
    } else if (res.status === 429) {
      showStatus('error', 'Too many requests from this network. Please try again later.');
    } else if (body.error === 'message_too_long') {
      showStatus(
        'error',
        body.message ?? `Message too long. Max ${body.maxChars ?? MAX_CHARS} characters.`,
      );
    } else {
      showStatus('error', body.message ?? `Request failed (${res.status}).`);
    }
  } catch (err) {
    console.error(`[privacy-request] submit failed: ${err instanceof Error ? err.message : String(err)}`);
    showStatus('error', 'Network error — please try again.');
  } finally {
    submit.disabled = false;
    updateSubmitState();
  }
}

if (form && submit && message && counter && status) {
  message.addEventListener('input', updateCounter);
  form.addEventListener('submit', onSubmit);
  void fetchNonce();
  // Refresh inside the server's 10-minute TTL.
  window.setInterval(() => { void fetchNonce(); }, NONCE_REFRESH_MS);
  updateCounter();
}
