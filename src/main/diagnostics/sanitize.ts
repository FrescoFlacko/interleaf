import { redactString } from '../logging/logger';

/**
 * Free-text sanitizing for the diagnostics report.
 *
 * Applied in main to the user's optional issue description before it is
 * previewed, sent or exported, and again to any analysis a provider returns.
 * It removes common credential shapes (through the shared logging redactor),
 * email addresses, absolute file paths, URLs with credentials or queries, and
 * control characters, then bounds the result. It is a best-effort filter for
 * accidental disclosure, not an anonymity guarantee: the user still reviews
 * the exact text before anything leaves the window.
 */

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/gu;
const URL_WITH_DETAIL = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`]+/giu;
/** Absolute POSIX paths with at least two segments, `~/` paths and Windows drive or UNC paths. */
const POSIX_PATH = /(?:^|(?<=[\s"'`(=:,;[{<]))(?:~\/(?:[^\s/"'`<>|]+\/)*|\/(?:[^\s/"'`<>|]+\/)+)[^\s/"'`<>|]*/gu;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s"'`<>|]*|\\\\[^\s\\"'`<>|]+\\[^\s"'`<>|]*/gu;
/** Every C0/C1 control except tab and newline, plus bidirectional overrides. */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/gu;

export function sanitizeFreeText(value: string, maxLength: number): string {
  let text = value.length > maxLength * 2 ? value.slice(0, maxLength * 2) : value;
  text = text.replace(/\r\n?/gu, '\n').replace(CONTROL, '');
  text = redactUrls(text);
  text = text.replace(EMAIL, '[email]');
  text = text.replace(WINDOWS_PATH, '[path]').replace(POSIX_PATH, '[path]');
  // The shared redactor removes token shapes, secret assignments and home paths.
  text = redactString(text);
  text = text.replace(/\n{4,}/gu, '\n\n\n').trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

/** Keeps a URL's scheme and host only; user info, path and query may identify someone. */
function redactUrls(text: string): string {
  return text.replace(URL_WITH_DETAIL, (match) => {
    try {
      const url = new URL(match);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[url]';
      return `${url.protocol}//${url.hostname}`;
    } catch {
      return '[url]';
    }
  });
}
