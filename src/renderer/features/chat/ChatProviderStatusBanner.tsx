import type { ProviderDiscoveryState } from '../../stores/use-chat-store';
import { LoadingShimmerText } from '../../components/LoadingShimmer';

type ChatProviderStatusBannerProps = {
  /** How discovery stands for the open document. */
  readonly discovery: ProviderDiscoveryState;
  /** Whether a successful current probe found a provider that can run a turn. */
  readonly hasReadyProvider: boolean;
  readonly onOpenProviderSettings: () => void;
  readonly onRetryDiscovery: () => void;
};

/**
 * What the panel may say about provider readiness at the top of Reader Chat.
 *
 * Discovery probes external CLIs and a loopback server, so it can take seconds
 * and it can fail. Three different situations are three different notices: a
 * probe still running is a wait, a probe that failed is an unknown the reader
 * can retry, and only a probe that came back with nothing supports the verdict
 * that no provider is ready. Saying the last one in place of the first two
 * would describe the reader's setup on evidence nobody has.
 */
export function ChatProviderStatusBanner({
  discovery,
  hasReadyProvider,
  onOpenProviderSettings,
  onRetryDiscovery,
}: ChatProviderStatusBannerProps) {
  if (discovery === 'loading') {
    return (
      <p
        data-testid="provider-discovery-loading"
        role="status"
        className="shrink-0 rounded-lg border border-border-subtle bg-bg-surface p-3 text-xs text-text-secondary"
      >
        <LoadingShimmerText>Checking available AI providers…</LoadingShimmerText>
      </p>
    );
  }
  if (discovery === 'failed') {
    return (
      <div
        data-testid="provider-discovery-failed"
        role="alert"
        className="shrink-0 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
      >
        <p className="font-semibold">Could not check AI providers</p>
        <p className="mt-1 leading-relaxed">
          The check for available providers did not finish, so Reader Chat cannot start or send a conversation right now.
          Your saved conversations are still readable.
        </p>
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            data-testid="retry-provider-discovery"
            onClick={onRetryDiscovery}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90"
          >
            Check Again
          </button>
          <button
            type="button"
            onClick={onOpenProviderSettings}
            className="rounded-md border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }
  if (hasReadyProvider) return null;
  return (
    <div data-testid="no-provider-banner" className="shrink-0 rounded-lg border border-border-subtle bg-bg-surface p-3 text-xs">
      <p className="font-semibold text-text-primary">No AI Provider Ready</p>
      <p className="mt-1 leading-relaxed text-text-secondary">
        Reader Chat requires a configured provider. Sign in with ChatGPT in Settings to use your ChatGPT subscription, or configure another provider.
      </p>
      <button
        type="button"
        onClick={onOpenProviderSettings}
        className="mt-2.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:opacity-90"
      >
        Configure Providers
      </button>
    </div>
  );
}
