import type { ReactElement } from 'react';
import { OPENROUTER_AUTH_FAILED_MESSAGE } from '@shared/constants/ai';
import { Button } from '../../components/ui/button';

/**
 * The failed turn's error above the composer. A refused OpenRouter key is
 * recognised by main's one typed message, never by matching provider text, and
 * gets the way to fix it: the OpenRouter row in AI Providers. The key itself is
 * never shown here, so nothing about it can be echoed.
 */
export function ChatErrorNotice({ error, onOpenProviderSettings }: {
  readonly error: string;
  readonly onOpenProviderSettings: () => void;
}): ReactElement {
  const authFailed = error === OPENROUTER_AUTH_FAILED_MESSAGE;
  return (
    <div
      data-testid="chat-error-message"
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-danger/10 p-2 text-2xs text-danger"
    >
      <p className="min-w-0 flex-1">{error}</p>
      {authFailed && (
        <Button variant="outline" size="chip" data-testid="chat-error-open-providers" onClick={onOpenProviderSettings}>
          Open AI Providers
        </Button>
      )}
    </div>
  );
}
