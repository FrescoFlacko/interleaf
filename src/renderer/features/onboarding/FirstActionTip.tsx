import { type ReactElement } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { Button } from '../../components/ui/button';
import { useOnboardingStore } from '../../stores/use-onboarding-store';
import { useChatStore } from '../../stores/use-chat-store';
import { isReaderReady, useReaderStore } from '../../stores/use-reader-store';
import { actionableProviders } from '../../stores/chat/provider-readiness';

/**
 * The first-action tip (stage 5).
 *
 * Deliberately **not** part of the modal: the whole point is that the document
 * stays interactive so the reader can do the thing being described. It appears
 * only with a document genuinely open, never auto-advances, and never
 * fabricates a selection or an answer.
 *
 * *Ask AI about this page* appears only when a current, successful provider
 * check says a provider can actually run a turn. An unfinished or failed check
 * is not permission, so the line is simply absent rather than offered and then
 * refused.
 */
export function FirstActionTip(): ReactElement | null {
  const status = useOnboardingStore((state) => state.status);
  const tipDismissed = useOnboardingStore((state) => state.tipDismissed);
  const wizardOpen = useOnboardingStore((state) => state.open);
  const dismissTip = useOnboardingStore((state) => state.dismissTip);
  const readerReady = useReaderStore(isReaderReady);
  const chatActionable = useChatStore(
    (state) => actionableProviders({ providers: state.providers, providerDiscovery: state.providerDiscovery }).length > 0
  );

  // The tip belongs to a flow the user actually went through, and never
  // competes with the modal for attention.
  const eligible = status === 'completed' || status === 'in-progress';
  if (wizardOpen || tipDismissed || !eligible || !readerReady) return null;

  return (
    <aside
      data-testid="onboarding-first-action-tip"
      aria-label="Getting started tip"
      className="pointer-events-auto fixed bottom-4 left-1/2 z-40 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-border-subtle bg-bg-primary px-4 py-3 shadow-lg"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-text-primary">Try one thing</p>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-text-secondary">
            <li>Select a sentence to highlight it.</li>
            <li>Select a sentence and add a note.</li>
            {chatActionable && <li>Ask AI about this page from the companion panel.</li>}
          </ul>
        </div>
        <button
          type="button"
          onClick={dismissTip}
          aria-label="Dismiss tip"
          data-testid="onboarding-tip-dismiss"
          className="rounded p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <AppIcon name="close" size={14} />
        </button>
      </div>
      <div className="mt-2">
        <Button variant="ghost" size="chip" data-testid="onboarding-tip-got-it" onClick={dismissTip}>
          Got it
        </Button>
      </div>
    </aside>
  );
}
