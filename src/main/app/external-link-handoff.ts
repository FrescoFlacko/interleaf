import type { Logger } from '../logging/logger';

export type OpenExternalDeps = {
  /**
   * Hands one already-validated absolute http/https link to the desktop.
   * Production wires Electron's `shell.openExternal`; tests inject their own so
   * a suite never launches a browser.
   */
  readonly openExternal: (url: string) => Promise<void>;
  /**
   * Whether the reader asked to confirm every external link. Read at call time
   * from the persisted settings so a change takes effect on the next click.
   */
  readonly requireConfirmation: () => boolean;
  /**
   * Shows the canonical target in a native dialog and reports the reader's
   * answer. Production wires Electron's `dialog`; tests inject their own.
   */
  readonly confirmExternalLink: (url: string) => Promise<boolean>;
  readonly log: Pick<Logger, 'info' | 'warn'>;
};

/**
 * The two steps that stand between a re-derived target and the desktop: the
 * reader's confirmation, and the hand-off itself.
 *
 * Both take an already-canonical link. Neither records anything derived from
 * it, so a declined or refused link leaves the same trace as any other.
 */

/**
 * Asks the reader about one canonical target when the Privacy preference is on.
 *
 * The preference is read per call, so turning it on or off takes effect on the
 * next click.
 */
export async function confirmExternalLinkTarget(
  canonical: string,
  deps: OpenExternalDeps
): Promise<boolean> {
  if (!deps.requireConfirmation()) return true;
  return await deps.confirmExternalLink(canonical);
}

/**
 * Hands the canonical target to the desktop and reports whether it was taken.
 *
 * A refusal by the operating system is reported rather than raised: from the
 * reader's side the click simply did nothing, and there is no useful
 * distinction to draw inside a document.
 */
export async function handOffToDesktop(
  canonical: string,
  openExternal: (url: string) => Promise<void>,
  log: Pick<Logger, 'warn'>
): Promise<boolean> {
  try {
    await openExternal(canonical);
    return true;
  } catch (error) {
    log.warn('The operating system refused an external link', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}
