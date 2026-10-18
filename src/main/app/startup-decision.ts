import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * Main-owned decision about whether startup may continue.
 *
 * The pre-rebrand profile and database adoptions run before any application
 * state exists. Both fail closed: an unsafe layout on disk (a symlinked
 * profile, a half-applied move) must stop the process rather than let it fall
 * through to a freshly created empty profile or database, which would look to
 * the user like their library had vanished. Making that a value keeps the
 * decision pure and testable without an Electron process.
 */
export type StartupDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'abort'; readonly reason: string };

export const CONTINUE_STARTUP: StartupDecision = { kind: 'continue' };

export function abortStartup(reason: string): StartupDecision {
  return { kind: 'abort', reason };
}

/**
 * Throws on an abort decision. Bootstrap's existing fatal-error path logs the
 * redacted diagnostic, tears down whatever was created, tells the user, and
 * quits — so the legacy data on disk is left exactly as it was found.
 */
export function assertStartupContinues(decision: StartupDecision): void {
  if (decision.kind === 'abort') {
    throw new InterleafError('internal', `Startup stopped: ${decision.reason}`);
  }
}
