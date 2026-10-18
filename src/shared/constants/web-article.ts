/**
 * Shape rules for a submitted article URL that both processes can read.
 *
 * These live outside `@shared/schemas` on purpose: the renderer shows the same
 * wording before it spends an IPC round trip, and importing the Zod schema
 * module would pull the validator into the untrusted bundle for a hint string.
 * Nothing here is a security control. Scheme, port, credentials, resolved
 * address, and every redirect hop are decided by main's address policy, which
 * runs regardless of what the renderer believed.
 */

/**
 * Upper bound on a submitted article URL.
 *
 * Long enough for real article permalinks with tracking query strings, short
 * enough that the renderer cannot push an unbounded string through IPC before
 * main's address policy runs.
 */
export const MAX_WEB_ARTICLE_URL_LENGTH = 2048;

/**
 * Images one article snapshot may hold: the bound extraction validates its IR
 * against, the media phase archives no more than, and the summary states.
 */
export const MAX_WEB_ARTICLE_IMAGES = 40;

/**
 * Blocks one article snapshot may hold, validated by the extraction schema.
 *
 * It is also the number of image candidates extraction recognizes in one
 * article, and so the ceiling on the count it reports leaving behind. A
 * candidate could at most have become one image block; every candidate within
 * this bound is either archived or counted omitted, which is what keeps the
 * reported partition exact.
 */
export const MAX_WEB_ARTICLE_BLOCKS = 4000;

const HTTP_SCHEME_PREFIX = /^https?:\/\//i;

const WEB_ARTICLE_URL_MESSAGES = {
  empty: 'Enter a web address.',
  tooLong: 'That web address is too long.',
  invalidCharacters: 'That web address contains invalid characters.',
  notHttp: 'Enter a full http:// or https:// address.',
} as const;

/**
 * Whitespace plus C0 control characters (0x00–0x1f) and DEL (0x7f).
 * Checked with character codes to avoid control characters in regular expressions.
 */
function hasForbiddenUrlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 32 || code === 127) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the first structural problem with a URL, or `null` when it is shaped
 * like something main can safely attempt.
 */
export function webArticleUrlProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return WEB_ARTICLE_URL_MESSAGES.empty;
  if (trimmed.length > MAX_WEB_ARTICLE_URL_LENGTH) return WEB_ARTICLE_URL_MESSAGES.tooLong;
  if (hasForbiddenUrlCharacters(trimmed)) return WEB_ARTICLE_URL_MESSAGES.invalidCharacters;
  if (!HTTP_SCHEME_PREFIX.test(trimmed)) return WEB_ARTICLE_URL_MESSAGES.notHttp;
  return null;
}

/** Longest site name kept alongside a stored snapshot. */
export const MAX_WEB_ARTICLE_SITE_NAME_LENGTH = 256;

/**
 * Bounds a stored provenance URL, which is stricter than a submitted one.
 *
 * A submitted URL is a user's best guess and only has to be worth attempting.
 * A stored one is a fact the app will later show, compare, and open, so it must
 * already be the exact canonical string `URL` produces: `http`/`https`, no
 * credentials, no fragment, a real host, and identical to its own re-serialized
 * form. Requiring the round trip is what makes the value comparable — two
 * spellings of one address cannot both be stored — and it leaves nothing for a
 * later reader to have to re-normalize.
 *
 * Returns the first problem, or `null` when the value is storable.
 */
export function webArticleProvenanceUrlProblem(value: string): string | null {
  if (value.length === 0) return 'Source URL is empty.';
  if (value.length > MAX_WEB_ARTICLE_URL_LENGTH) return 'Source URL is too long.';
  if (hasForbiddenUrlCharacters(value)) return 'Source URL contains invalid characters.';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Source URL is not a valid absolute URL.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Source URL must be an http or https address.';
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return 'Source URL must not contain credentials.';
  }
  if (parsed.hostname.length === 0) return 'Source URL must have a host.';
  // `hash` is empty for a bare trailing `#`, so the raw string is checked too.
  if (parsed.hash.length > 0 || value.includes('#')) {
    return 'Source URL must not contain a fragment.';
  }
  if (parsed.toString() !== value) return 'Source URL is not in canonical form.';
  return null;
}
