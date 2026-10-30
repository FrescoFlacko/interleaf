import { useCallback, useState } from 'react';
import { reportRejection } from '@shared/models/caught-error';
import { parseOpenRouterKeyPreview, type OpenRouterKeyPreview } from '@shared/schemas/credential-preview';
import type { AIProviderStatus } from '@shared/types/ai';
import { bridge } from '../../app/api-client';

export type OpenRouterRemoval = {
  readonly configured: boolean;
  readonly keyPreview: OpenRouterKeyPreview | null;
  /** Live provider status after the removal, when it could be re-read. */
  readonly providerStatus: AIProviderStatus | null;
};

/**
 * Deletes the stored OpenRouter credential through the main-owned bridge.
 *
 * The reply is the masked status that replaced it, re-validated here before the
 * UI adopts it. Nothing is staged and nothing is decrypted, so a key the current
 * OS key can no longer read is removable like any other.
 */
async function removeStoredOpenRouterKey(): Promise<OpenRouterRemoval> {
  const status = await bridge.credentials.clearOpenRouterKey();
  return {
    configured: status.configured,
    keyPreview: parseOpenRouterKeyPreview(status.keyPreview),
    providerStatus: await readOpenRouterProviderStatus(),
  };
}

export type OpenRouterRemovalControl = {
  /** True while a deletion is in flight, so Remove cannot be double-fired. */
  readonly removingKey: boolean;
  /**
   * True once the stored credential has actually been deleted in this session,
   * so Done stops demanding a key the reader deliberately removed.
   */
  readonly credentialRemoved: boolean;
  readonly removeKey: () => void;
  /** Forgets the session's removal, for a reopened dialog or a saved new key. */
  readonly resetRemoval: () => void;
};

/**
 * Owns the immediate removal of the stored OpenRouter credential.
 *
 * Nothing is staged: the deletion happens as soon as it is requested, and the
 * caller applies the masked status that replaced it. A failure reports only a
 * safe message and leaves the caller's configured state untouched, so the panel
 * keeps saying whatever is actually still stored.
 */
export function useOpenRouterKeyRemoval(handlers: {
  readonly onStart: () => void;
  readonly onRemoved: (removal: OpenRouterRemoval) => void;
  readonly onFailed: (message: string) => void;
}): OpenRouterRemovalControl {
  const [removingKey, setRemovingKey] = useState(false);
  const [credentialRemoved, setCredentialRemoved] = useState(false);
  const { onStart, onRemoved, onFailed } = handlers;

  const removeKey = useCallback(() => {
    if (removingKey) return;
    setRemovingKey(true);
    onStart();
    void reportRejection(
      removeStoredOpenRouterKey().then((removal) => {
        setCredentialRemoved(!removal.configured);
        onRemoved(removal);
      }),
      (caught) => { onFailed(removalErrorMessage(caught)); },
    ).finally(() => { setRemovingKey(false); });
  }, [removingKey, onStart, onRemoved, onFailed]);

  const resetRemoval = useCallback(() => { setCredentialRemoved(false); }, []);
  return { removingKey, credentialRemoved, removeKey, resetRemoval };
}

/** The safe message for a removal that did not happen. */
function removalErrorMessage(cause: Error | null): string {
  return cause instanceof Error ? cause.message : 'The OpenRouter API key could not be removed.';
}

async function readOpenRouterProviderStatus(): Promise<AIProviderStatus | null> {
  try {
    return await bridge.ai.getProviderStatus('openrouter');
  } catch {
    // A stale provider row is not worth replacing the removal's own result;
    // the next status load corrects it.
    return null;
  }
}
