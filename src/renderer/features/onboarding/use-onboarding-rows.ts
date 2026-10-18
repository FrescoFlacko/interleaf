import { useMemo } from 'react';
import { useOnboardingStore } from '../../stores/use-onboarding-store';
import { deriveOnboardingRows, type OnboardingProviderRow } from './onboarding-rows';

/**
 * The §4 rows for the current observation.
 *
 * Each input is subscribed to individually and the rows are derived in a memo:
 * `deriveOnboardingRows` builds a fresh array every call, so selecting it
 * directly would hand `useSyncExternalStore` a new snapshot on every render.
 */
export function useOnboardingRows(): readonly OnboardingProviderRow[] {
  const chatProbes = useOnboardingStore((state) => state.chatProbes);
  const agentProfiles = useOnboardingStore((state) => state.agentProfiles);
  const agentDiscoveryPending = useOnboardingStore((state) => state.agentDiscoveryPending);
  const agentDetectionPending = useOnboardingStore((state) => state.agentDetectionPending);
  const openRouterCredential = useOnboardingStore((state) => state.openRouterCredential);

  return useMemo(
    () =>
      deriveOnboardingRows({
        chatProbes,
        agentProfiles,
        agentDiscoveryPending,
        agentDetectionPending,
        openRouterCredential,
      }),
    [chatProbes, agentProfiles, agentDiscoveryPending, agentDetectionPending, openRouterCredential]
  );
}
