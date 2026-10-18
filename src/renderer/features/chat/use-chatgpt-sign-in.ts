import { useRef, useState } from 'react';
import { bridge } from '../../app/api-client';
import type { ProviderStatuses } from './use-provider-statuses';
import type { SettingsFeedback } from './use-settings-feedback';

export type ChatGptSignIn = {
  readonly signingIn: boolean;
  readonly signIn: () => Promise<void>;
};

/**
 * Owns the main-owned ChatGPT sign-in for the Codex row.
 *
 * The browser flow is provider-owned and can outlive this dialog, so its
 * result is published to every status consumer, not only to this list.
 */
export function useChatGptSignIn({ providers, feedback, onProvidersChanged }: {
  readonly providers: Pick<ProviderStatuses, 'supersede' | 'isCurrent' | 'adoptStatus'>;
  readonly feedback: SettingsFeedback;
  readonly onProvidersChanged: () => void;
}): ChatGptSignIn {
  const [signingIn, setSigningIn] = useState(false);
  const inFlightRef = useRef(false);

  const signIn = async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    // This user action supersedes an older status probe. Its result must not
    // be overwritten when that probe resolves after the sign-in flow.
    const requestId = providers.supersede();
    setSigningIn(true);
    feedback.clear();
    try {
      const status = await bridge.ai.signInWithChatGPT();
      if (!providers.isCurrent(requestId)) return;
      providers.adoptStatus(status);
      if (status.authentication === 'connected') {
        feedback.announce('Signed in with ChatGPT. Your subscription is now available for Reader AI Chat.');
        onProvidersChanged();
      } else {
        feedback.fail('ChatGPT sign-in was not completed. Try again or check the Codex CLI installation.');
      }
    } catch {
      if (!providers.isCurrent(requestId)) return;
      // Keep provider/CLI diagnostics in the redacted main-process log only.
      feedback.fail('ChatGPT sign-in could not be completed. Try again.');
    } finally {
      inFlightRef.current = false;
      setSigningIn(false);
    }
  };

  return { signingIn, signIn };
}
