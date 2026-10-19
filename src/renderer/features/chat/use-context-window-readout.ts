import type { ChatContextItem, ChatSession } from '@shared/types/ai';
import type { CleanContextWiring } from './ChatContextBudgetMeter';
import { contextWindowReadout, showsContextWindow, type ContextWindowReadout } from './context-window-readout';
import { useContextBudget } from './use-context-budget';

type ContextWindowReadoutInput = {
  readonly session: ChatSession | null;
  readonly contextItems: readonly ChatContextItem[];
  readonly isStreaming: boolean;
  readonly cleanContext: CleanContextWiring;
};

/**
 * What the context-window control should report, or `null` when it is absent.
 *
 * The figures are main's accounting for the last request this session packed;
 * nothing here estimates the next one. Main's accounting is held in memory, so a
 * conversation can be compactable with no figures to show for it: the control
 * then still appears, says the statistics are unavailable and offers
 * compaction. Only when there is neither accounting nor a compaction to offer is
 * there nothing to show.
 */
export function useContextWindowReadout({
  session,
  contextItems,
  isStreaming,
  cleanContext,
}: ContextWindowReadoutInput): ContextWindowReadout | null {
  const budget = useContextBudget({ session, contextItems, isStreaming });
  return showsContextWindow(budget, cleanContext) ? contextWindowReadout(budget) : null;
}
