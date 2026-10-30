import { useCallback, useRef, useState } from 'react';
import { bridge } from '../../app/api-client';
import type { ProviderStatuses } from './use-provider-statuses';

export type LocalConnection = {
  readonly checking: boolean;
  /**
   * Re-probes the local server, adopts the result, and tells Reader Chat to
   * re-read. Never rejects.
   */
  readonly refresh: () => Promise<void>;
  /** The explicit check: waits for `saved`, then refreshes. */
  readonly check: (saved: Promise<void>) => Promise<void>;
};

/**
 * Owns the local provider's status refresh and its explicit connection check.
 *
 * There is no separate local-connection IPC because there is nothing extra to
 * ask: `detect()` already performs the read-only model listing that a
 * connection test consists of, so this is a status refresh rather than a new
 * privileged surface. `forceRefresh` skips main's short status cache, which is
 * the whole point of a check the user asked for; it remains the same
 * read-only listing and still starts no inference.
 */
export function useLocalConnection({ adoptStatus, onProvidersChanged }: {
  readonly adoptStatus: ProviderStatuses['adoptStatus'];
  readonly onProvidersChanged: () => void;
}): LocalConnection {
  const [checking, setChecking] = useState(false);
  /** Numbers local re-probes so only the newest one is adopted and announced. */
  const refreshRef = useRef(0);
  // The settings coordinator holds on to `refresh`, so it reads the newest
  // notification callback rather than the one from its first render.
  const onProvidersChangedRef = useRef(onProvidersChanged);
  onProvidersChangedRef.current = onProvidersChanged;

  /**
   * The freshness snapshot only reaches surfaces that subscribe to it, and the
   * chat store is not one of them: it re-reads the provider list over IPC when
   * `onProvidersChanged` fires. So a refresh that stops at adopting the status
   * updates this dialog and leaves the chat store holding the previous
   * server's catalog — which is precisely the model a session created next
   * would use. Main's cache is refreshed before the notification, so the list
   * the store then reads is the new endpoint's.
   *
   * Refreshes are numbered because they are started by writes the user can
   * make faster than a probe completes. A slower answer for a replaced
   * endpoint must neither reinstate that catalog nor fire a notification after
   * the newer answer has already been adopted.
   */
  const refresh = useCallback(async (): Promise<void> => {
    const refreshId = ++refreshRef.current;
    try {
      const status = await bridge.ai.getProviderStatus('local', { forceRefresh: true });
      if (refreshId !== refreshRef.current) return;
      adoptStatus(status);
      onProvidersChangedRef.current();
    } catch {
      // Endpoint and transport failures already surface as the provider's own
      // typed status message; a thrown IPC error carries nothing safe to add.
    }
  }, [adoptStatus]);

  const check = async (saved: Promise<void>): Promise<void> => {
    setChecking(true);
    try {
      // A check has to describe the endpoint that is *saved*, since that is the
      // one a chat will use. Waiting for any queued settings write means the
      // result cannot belong to the previous address while the new one is still
      // in flight. The panel separately refuses to run this against an unsaved
      // draft, so the two together leave no window where they disagree.
      await saved;
      await refresh();
    } finally {
      setChecking(false);
    }
  };

  return { checking, refresh, check };
}
