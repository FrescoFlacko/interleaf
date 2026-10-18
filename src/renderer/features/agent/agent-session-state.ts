import type { WorkingDirectorySelectionSource } from '../../stores/use-agent-store';

export function workingDirectorySourceLabel(
  hasDirectory: boolean,
  source: WorkingDirectorySelectionSource
): string {
  if (!hasDirectory) return 'Not selected';
  if (source === 'profile-default') return 'Profile default';
  if (source === 'global-default') return 'Default workspace';
  return 'Per-session override';
}

/**
 * Identity of the diff currently on screen. When it changes the panel closes an
 * open diff, so a refreshed or replaced sandbox can never leave stale workspace
 * content expanded under the previous heading.
 */
export function reviewDiffIdentity(
  sessionId: string | undefined,
  environment: { readonly sessionId: string; readonly diffAvailable: boolean; readonly diff: string | null } | null | undefined
): string | null {
  if (environment === null || environment === undefined) return null;
  // The whole diff, not a sample of it: a change anywhere in it is a different diff.
  return JSON.stringify([sessionId ?? null, environment.sessionId, environment.diffAvailable, environment.diff]);
}
