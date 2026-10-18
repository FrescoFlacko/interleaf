import { useEffect, useRef, useState } from 'react';
import { createChatStore, type ChatStore } from './use-chat-store';

/**
 * One chat controller whose lifetime is the calling component's.
 *
 * `dispose()` is terminal, so it cannot run in a plain effect cleanup:
 * StrictMode unmounts and remounts every effect once, and the replayed mount
 * would keep a dead controller. The cleanup therefore only schedules disposal
 * for the next microtask, and a remount of the same component cancels it. The
 * replay runs synchronously within one commit, so it always lands first; a
 * real unmount has no remount, and the controller is disposed.
 */
export function useOwnedChatStore(): ChatStore {
  const [store] = useState(createChatStore);
  const pendingDisposal = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => {
    if (pendingDisposal.current !== null) pendingDisposal.current.cancelled = true;
    pendingDisposal.current = null;
    return () => {
      const disposal = { cancelled: false };
      pendingDisposal.current = disposal;
      queueMicrotask(() => {
        if (!disposal.cancelled) store.dispose();
      });
    };
  }, [store]);
  return store;
}
