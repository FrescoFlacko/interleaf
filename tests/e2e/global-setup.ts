import { assertOfflinePathIsSafe } from './offline-environment';

/**
 * Refuses to start the suite unless the offline guarantee holds.
 *
 * The guarantee is only worth anything if it is checked before the first
 * application launch rather than discovered afterwards in a bill, so this runs
 * once, ahead of every spec, and throwing here aborts the run.
 */
export default function globalSetup(): void {
  assertOfflinePathIsSafe();
}
