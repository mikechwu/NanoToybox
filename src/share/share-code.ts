/**
 * Share-code generation, normalization, validation, and display formatting.
 *
 * Share codes are 12-character Crockford Base32 random tokens (~60 bits of entropy).
 * They are case-insensitive and avoid ambiguous characters (0/O, 1/I/L).
 *
 * Owns:        code generation, normalization, validation, display formatting
 * Depends on:  nothing (pure functions)
 * Called by:    src/share/publish-core.ts (generation on persist),
 *              functions/api/capsules/[code].ts (normalization on resolve),
 *              watch/js/watch-controller.ts (normalization on user input)
 */

// Crockford Base32 alphabet: 0-9 A-Z excluding I, L, O, U
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SHARE_CODE_LENGTH = 12;

// Crockford normalization: map commonly confused characters
const CROCKFORD_DECODE_MAP: Record<string, string> = {
  O: '0',
  o: '0',
  I: '1',
  i: '1',
  L: '1',
  l: '1',
};

const CROCKFORD_VALID = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** Generate a 12-character Crockford Base32 random share code. */
export function generateShareCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SHARE_CODE_LENGTH));
  let code = '';
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    code += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return code;
}

/**
 * Normalize user input to a canonical share code.
 *
 * Accepts all user-paste shapes:
 *   - raw code: "7M4K2D8Q9T1V"
 *   - grouped code: "7M4K-2D8Q-9T1V"
 *   - share URL: "https://atomdojo.pages.dev/c/7M4K2D8Q9T1V"
 *   - Watch URL: "https://atomdojo.pages.dev/watch/?c=7M4K2D8Q9T1V"
 *   - relative paths: "/c/7M4K2D8Q9T1V", "/watch/?c=7M4K2D8Q9T1V"
 *
 * Returns null if the input cannot be parsed to a valid share code.
 */
export function normalizeShareInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let candidate: string | null = null;

  // Try parsing as a URL or path
  if (trimmed.includes('/') || trimmed.includes('?')) {
    candidate = extractCodeFromUrlOrPath(trimmed);
  }

  // If URL extraction didn't work, treat the whole input as a raw/grouped code
  if (candidate === null) {
    candidate = trimmed;
  }

  // Normalize: uppercase, remove hyphens, apply Crockford decode map
  candidate = candidate
    .toUpperCase()
    .replace(/-/g, '')
    .split('')
    .map((ch) => CROCKFORD_DECODE_MAP[ch] ?? ch)
    .join('');

  return isValidShareCode(candidate) ? candidate : null;
}

/** Validate that a string is a well-formed share code (12 Crockford Base32 chars). */
export function isValidShareCode(code: string): boolean {
  return CROCKFORD_VALID.test(code);
}

/** Format a share code for display with grouping: 7M4K-2D8Q-9T1V */
export function formatShareCode(code: string): string {
  if (code.length !== SHARE_CODE_LENGTH) return code;
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

// ── Internal helpers ──

function extractCodeFromUrlOrPath(input: string): string | null {
  // Handle absolute URLs — parse with URL constructor
  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      const url = new URL(input);
      return extractFromParsedUrl(url.pathname, url.searchParams);
    } catch {
      return null;
    }
  }

  // Handle relative paths like /c/CODE or /watch/?c=CODE
  // Use a dummy base to parse with URL constructor
  try {
    const url = new URL(input, 'https://placeholder.local');
    return extractFromParsedUrl(url.pathname, url.searchParams);
  } catch {
    return null;
  }
}

function extractFromParsedUrl(
  pathname: string,
  searchParams: URLSearchParams,
): string | null {
  // Check /c/:code pattern
  const cMatch = pathname.match(/\/c\/([^/?#]+)/);
  if (cMatch) return cMatch[1];

  // Check ?c= query parameter (e.g., /watch/?c=CODE)
  const cParam = searchParams.get('c');
  if (cParam) return cParam;

  return null;
}
