import { ChatContextUsageDetails, TITLE_ID } from './ChatContextUsageDetails';
import type { ContextWindowReadout } from './context-window-readout';

/**
 * The statistics half of the context-window panel.
 *
 * With main's accounting in hand it is the usual itemisation. Without it the
 * panel says so in one sentence and shows no aggregate, proportion, bar or
 * breakdown — an invented zero would read as a measured one — while the panel
 * around it keeps offering `Clean Context`, which needs no figures to be safe.
 */
export function ChatContextWindowBody({ readout }: { readonly readout: ContextWindowReadout }) {
  if (readout.budget === null) {
    return (
      <>
        <h3 id={TITLE_ID} className="text-xs font-semibold text-text-primary">Context window</h3>
        <p
          data-testid="chat-context-budget-unavailable"
          className="text-2xs leading-snug text-text-secondary"
        >
          Context usage is unavailable until this conversation has a message to measure.
        </p>
      </>
    );
  }
  return (
    <ChatContextUsageDetails
      budget={readout.budget}
      total={readout.total}
      usedPercentage={readout.usedPercentage}
    />
  );
}
