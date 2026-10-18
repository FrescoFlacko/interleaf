import { useEffect, useState } from 'react';
import type { AIProviderStatus, ChatSession } from '@shared/types/ai';

type ChatWebSearchInput = {
  /** `null` while no conversation is open, so the composer's choice binds. */
  readonly session: ChatSession | null;
  /** The provider bound to the open conversation. */
  readonly sessionProvider: AIProviderStatus | undefined;
  /** The provider the composer is previewing for the next conversation. */
  readonly composerProvider: AIProviderStatus | undefined;
};

export type ChatWebSearchTurn = {
  /** Whether the provider that will run the turn hosts web search itself. */
  readonly supported: boolean;
  /** The opt-in as it actually stands for the next turn. */
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  /**
   * Reads the opt-in for the turn being sent and clears it in the same call.
   * Web access is a per-turn decision: an opt-in that survived its turn would
   * spend the user's money on searches they did not ask for.
   */
  readonly consume: () => boolean;
};

/**
 * Owns the per-turn web-search opt-in for one chat panel.
 *
 * The capability is read from the provider that will actually run the turn,
 * never from the one the composer happens to be previewing, and a provider
 * without the capability must not leave a stale opt-in behind — so the state is
 * reset rather than merely ignored when support disappears.
 */
export function useChatWebSearch({
  session,
  sessionProvider,
  composerProvider,
}: ChatWebSearchInput): ChatWebSearchTurn {
  const [enabled, setEnabled] = useState(false);
  const provider = session ? sessionProvider : composerProvider;
  const supported = provider?.capabilities.hostedWebSearch === true;

  useEffect(() => {
    if (!supported && enabled) setEnabled(false);
  }, [enabled, supported]);

  const active = enabled && supported;
  return {
    supported,
    enabled: active,
    setEnabled,
    consume: () => {
      setEnabled(false);
      return active;
    },
  };
}
