import { type ReactElement } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { Button } from '../../components/ui/button';
import { useOnboardingStore } from '../../stores/use-onboarding-store';

/**
 * The entry point an existing install gets instead of an automatic wizard.
 *
 * An upgrade must never be interrupted by a flow the user did not ask for
 * (AC 2), so this is a non-modal, dismissible offer: it takes no focus, blocks
 * nothing, and saying no once stops it returning. Setup stays reachable from
 * Settings afterwards.
 */
export function OnboardingEntryBanner(): ReactElement | null {
  const launchState = useOnboardingStore((state) => state.launchState);
  const status = useOnboardingStore((state) => state.status);
  const open = useOnboardingStore((state) => state.open);
  const openWizard = useOnboardingStore((state) => state.openWizard);
  const dismissEntryPoint = useOnboardingStore((state) => state.dismissEntryPoint);

  const offered =
    launchState !== null &&
    !launchState.shouldAutoOpen &&
    (launchState.verdict === 'upgraded-install' || launchState.verdict === 'not-started') &&
    status === 'not-started';

  if (!offered || open) return null;

  return (
    <div
      data-testid="onboarding-entry-banner"
      className="pointer-events-auto fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border-subtle bg-bg-primary px-4 py-3 shadow-lg"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-text-primary">Set up AI providers?</p>
          <p className="text-xs text-text-secondary">
            Optional. Your settings, library and annotations stay exactly as they are.
          </p>
        </div>
        <button
          type="button"
          onClick={dismissEntryPoint}
          aria-label="Dismiss setup offer"
          data-testid="onboarding-entry-dismiss"
          className="rounded p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <AppIcon name="close" size={14} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="chip"
          data-onboarding-opener="entry-banner"
          data-testid="onboarding-entry-open"
          onClick={() => { openWizard({ stage: 'welcome', openerId: 'entry-banner' }); }}
        >
          Start setup
        </Button>
        <Button variant="ghost" size="chip" data-testid="onboarding-entry-not-now" onClick={dismissEntryPoint}>
          Not now
        </Button>
      </div>
    </div>
  );
}
