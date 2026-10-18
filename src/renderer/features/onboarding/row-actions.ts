import { useUiStore } from '../../stores/use-ui-store';
import { useOnboardingStore } from '../../stores/use-onboarding-store';
import type { OnboardingProviderRow, OnboardingRowAction } from './onboarding-rows';
import { installationHelpUrl } from './installation-help';
import { bridge } from '../../app/api-client';

/**
 * What a row's own action does.
 *
 * Every branch here is an existing main-owned entry point or the established
 * external-link boundary. Nothing downloads, installs or runs anything on the
 * user's behalf, and no branch sends a prompt.
 */

export const ROW_ACTION_LABELS: Readonly<Record<OnboardingRowAction, string>> = {
  'install-help': 'Installation help',
  'add-openrouter-key': 'Add OpenRouter key',
  'configure-local-endpoint': 'Configure local server',
  'sign-in-chatgpt': 'Sign in with ChatGPT',
  // Named for what it does. It checks reachability and lists models; it sends
  // no prompt and consumes no credits, so it must not read like a model call.
  'test-connection': 'Check connection',
  retry: 'Retry',
};

export function useRowAction(): (row: OnboardingProviderRow, action: OnboardingRowAction) => void {
  const refreshProvider = useOnboardingStore((state) => state.refreshProvider);
  const refreshDiscovery = useOnboardingStore((state) => state.refreshDiscovery);

  return (row, action) => {
    switch (action) {
      case 'install-help': {
        const url = installationHelpUrl(row.id);
        // The established external boundary only: Interleaf downloads nothing
        // and runs nothing on the user's behalf (§6 rule 6).
        if (url !== null) void bridge.app.openExternal(url);
        return;
      }
      case 'add-openrouter-key':
      case 'configure-local-endpoint': {
        useUiStore.getState().openSettings('ai');
        return;
      }
      case 'sign-in-chatgpt': {
        // Main owns the sign-in; the wizard only re-reads the result.
        void bridge.ai
          .signInWithChatGPT()
          .catch(() => undefined)
          .finally(() => { void refreshProvider('codex'); });
        return;
      }
      case 'test-connection': {
        // The existing credential-vault connectivity check: it reaches the
        // provider and lists models, and runs no inference (§7). The row is
        // re-read afterwards so the result is shown as detection, not as a
        // separate claim the wizard makes on its own.
        void bridge.credentials
          .testOpenRouterConnection()
          .catch(() => undefined)
          .finally(() => { void refreshProvider('openrouter'); });
        return;
      }
      case 'retry': {
        if (row.chatProviderId !== null) void refreshProvider(row.chatProviderId);
        else void refreshDiscovery();
        return;
      }
    }
  };
}
