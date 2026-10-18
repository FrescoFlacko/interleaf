import { parseExternalHttpUrl } from '@shared/schemas/external-link';
import { bridge } from '../../app/api-client';

/**
 * Following a link out of a document.
 *
 * The renderer never navigates and never opens a window: it names one absolute
 * http/https target and main decides whether that target may leave the
 * application at all. This function exists so every reader surface asks in the
 * same way and none of them reaches for Electron directly.
 *
 * A target that is not a plain external link — an in-document `#` anchor, a
 * `javascript:` or `file:` URL, a relative path, anything oversized or
 * malformed — is simply not asked about. It stays inert, and the caller is told
 * nothing was opened rather than being handed a failure to report: the reader
 * clicked something that was never a way out of the document.
 */
export async function openExternalLink(url: string): Promise<boolean> {
  const canonical = parseExternalHttpUrl(url);
  if (canonical === null) return false;
  try {
    const result = await bridge.app.openExternal(canonical);
    return result.opened;
  } catch {
    // Main refused. That is nothing the reader can act on in the middle of a
    // document, and it may not become a navigation attempt here.
    return false;
  }
}
