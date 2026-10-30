import { useRef, useState } from 'react';
import { bridge } from '../../app/api-client';
import type { AgentResources } from './use-agent-resources';
import type { OpenRouterSettings } from './use-openrouter-settings';
import type { ProviderStatuses } from './use-provider-statuses';
import type { SettingsDocument } from './use-settings-document';
import type { SettingsFeedback } from './use-settings-feedback';

type SettingsLoadState = 'loading' | 'ready' | 'error';

export type SettingsLoad = {
  readonly state: SettingsLoadState;
  /** Reads every section's data again; a newer load replaces an older one. */
  readonly load: () => Promise<void>;
};

/**
 * Loads the dialog, without making one source wait for another, and hands each
 * feature the part of the answer it owns.
 *
 * Everything the section rail navigates to is a local read — the settings
 * document, the credential status, the agent profiles and their working
 * directories. Provider status is not: it is a live probe of CLIs and of a
 * local endpoint that may be nothing but a closed port, so it can take as long
 * as the slowest of them. Gating readiness on that probe greyed out the entire
 * dialog, including Library, Privacy and Advanced, which have nothing to do
 * with a provider. Readiness is therefore the local read; the provider rows
 * keep their own `Checking…` state and settle into it on their own.
 */
export function useSettingsLoad({ feedback, providers, openRouter, document, agentResources }: {
  readonly feedback: SettingsFeedback;
  readonly providers: Pick<ProviderStatuses, 'probe' | 'adoptProbe'>;
  readonly openRouter: Pick<OpenRouterSettings, 'adoptLoaded' | 'clearFieldErrors' | 'catalog'>;
  readonly document: Pick<SettingsDocument, 'adoptLoaded'>;
  readonly agentResources: Pick<AgentResources, 'adoptLoaded'>;
}): SettingsLoad {
  const [state, setState] = useState<SettingsLoadState>('loading');
  const requestRef = useRef(0);

  /**
   * Adopts the provider list once it settles. Kept off the readiness path, so
   * a failure is reported where the reader can see it instead of pretending
   * the settings document could not be read.
   */
  const settleProviders = async (requestId: number, probe: ReturnType<ProviderStatuses['probe']>): Promise<void> => {
    const outcome = await providers.adoptProbe(probe);
    if (!outcome.failed || requestId !== requestRef.current) return;
    // Without status there is nothing truthful to say about any provider, so
    // a failed probe keeps the retryable load error it always raised.
    setState('error');
    feedback.fail(outcome.message);
  };

  const load = async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setState('loading');
    feedback.clearError();
    openRouter.clearFieldErrors();
    try {
      // The probe's rejection is claimed when it starts rather than at the
      // await below, so a slow local read cannot turn a failed probe into an
      // unhandled rejection.
      const probe = providers.probe();
      const [credentialStatus, settings, profiles] = await Promise.all([
        bridge.credentials.getOpenRouterStatus(),
        bridge.settings.get(),
        bridge.agent.listProfiles().catch(() => []),
      ]);
      const directories = await bridge.agent.listWorkingDirectories();
      if (requestId !== requestRef.current) return;
      openRouter.adoptLoaded(credentialStatus, settings.ai.openRouterModel);
      document.adoptLoaded(settings);
      agentResources.adoptLoaded(profiles, directories);
      setState('ready');
      await settleProviders(requestId, probe);
      await openRouter.catalog.fetch();
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setState('error');
      feedback.fail(err instanceof Error ? err.message : 'Failed to load settings.');
    }
  };

  return { state, load };
}
