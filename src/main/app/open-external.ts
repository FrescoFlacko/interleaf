import {
  parseExternalHttpUrl,
  type OpenExternalRequest,
  type OpenExternalResult,
} from '@shared/schemas/external-link';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  confirmExternalLinkTarget,
  handOffToDesktop,
  type OpenExternalDeps,
} from './external-link-handoff';

export type { OpenExternalDeps };

/**
 * Leaving the application for a link found in a document.
 *
 * The link is untrusted data whichever surface it came from, so the target is
 * re-derived here rather than trusted because preload validated it: absolute,
 * http or https, with a host and no embedded credentials. A renderer that asks
 * for anything else is answered with a typed validation error and nothing
 * leaves the process.
 * Nothing derived from the target is recorded — not the URL, not the scheme,
 * not the host. A refusal by the operating system is reported as "not opened"
 * rather than raised: from the reader's side the click simply did nothing, and
 * there is no useful distinction to draw inside a document.
 *
 * When the reader has asked to confirm external links, the confirmation is
 * taken after the target has been re-derived, so the dialog shows exactly the
 * link that would be handed to the desktop. Declining is reported as
 * "not opened" too.
 */
export async function openExternalFromDocument(
  request: OpenExternalRequest,
  deps: OpenExternalDeps
): Promise<OpenExternalResult> {
  const canonical = parseExternalHttpUrl(request.url);
  if (canonical === null) {
    throw new InterleafError('validation', 'Only absolute http and https links can be opened.');
  }
  if (!(await confirmExternalLinkTarget(canonical, deps))) {
    deps.log.info('An external link was not confirmed');
    return { opened: false };
  }
  if (!(await handOffToDesktop(canonical, deps.openExternal, deps.log))) {
    return { opened: false };
  }
  deps.log.info('Opened an external link');
  return { opened: true };
}
