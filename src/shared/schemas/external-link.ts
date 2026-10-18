import { z } from 'zod';
import type { PortableMember } from '../models/portable';

/**
 * The one shape of link Interleaf will hand to the operating system.
 *
 * Links arrive from documents, which are untrusted data: a PDF annotation or an
 * imported article can name any target it likes. Handing one to the desktop is
 * the moment that data becomes an action outside the application, so the target
 * is re-derived from the string rather than inspected: it must parse as an
 * absolute URL, be http or https, name a host, carry no embedded credentials,
 * and stay within a bounded length. Anything else is not opened at all — there
 * is no partial or "best effort" form of this operation.
 *
 * Both sides of the bridge use this function. The renderer's use only spares
 * the user a pointless round trip; main validates again on receipt, because the
 * renderer is untrusted and a preload check proves nothing about what main was
 * asked to do.
 */
export const MAX_EXTERNAL_URL_LENGTH = 2048;

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The canonical absolute http/https form of `raw`, or `null` when it is not a
 * link that may be opened.
 */
export function parseExternalHttpUrl(raw: PortableMember): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EXTERNAL_URL_LENGTH) return null;
  // A URL is a single token: whitespace inside it means the string was never one
  // link, and control characters have no business reaching a shell-adjacent API.
  if (/[\s\u0000-\u001f\u007f]/u.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.hostname.length === 0) return null;
  // `https://user:secret@host/` would leak a credential to the browser, its
  // history and any handler behind it.
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.href.length > MAX_EXTERNAL_URL_LENGTH) return null;
  return parsed.href;
}

export const openExternalRequestSchema = z
  .object({ url: z.string().min(1).max(MAX_EXTERNAL_URL_LENGTH) })
  .strict();

export type OpenExternalRequest = z.infer<typeof openExternalRequestSchema>;

/** Whether the operating system accepted the link. */
export const openExternalResultSchema = z.object({ opened: z.boolean() }).strict();

export type OpenExternalResult = z.infer<typeof openExternalResultSchema>;
