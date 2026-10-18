import type { ChatSession } from '@shared/types/ai';

type PanelAvailabilityInput = {
  readonly activeSession: ChatSession | null;
  readonly activeSessionProviderReady: boolean;
  /** Readiness of the provider a *new* conversation would be bound to. */
  readonly currentProviderReady: boolean;
  readonly isStreaming: boolean;
  readonly isLoading: boolean;
  readonly isCleaningContext: boolean;
  readonly draft: string;
};

/** Which of the panel's actions the current conversation can serve right now. */
export type PanelAvailability = {
  readonly composerDisabled: boolean;
  /** Provider/model pickers and the other per-conversation chrome. */
  readonly controlsDisabled: boolean;
  readonly canSend: boolean;
  readonly canCreateSession: boolean;
};

/**
 * Whether the provider the next turn would use is ready. With no conversation
 * yet, the first send creates one bound to the provider the composer shows, so
 * that provider is the one whose readiness counts.
 */
function canTakeTurn(input: PanelAvailabilityInput): boolean {
  if (input.activeSession === null) return input.currentProviderReady;
  return !input.activeSession.isArchived && input.activeSessionProviderReady;
}

/**
 * The panel's action availability, derived in one place.
 *
 * A clean rewrites the transcript a turn would extend and main refuses every
 * mutation of that conversation while it runs, so the surface offers none of
 * them. It is the conversation in view that is busy, not the panel: another
 * session stays fully usable.
 */
export function panelAvailability(input: PanelAvailabilityInput): PanelAvailability {
  const { activeSession } = input;
  // Anything that is already changing this conversation withholds the actions
  // that would change it again.
  const busy = input.isStreaming || input.isLoading || input.isCleaningContext;
  const archived = activeSession?.isArchived ?? false;
  const turnProviderReady = canTakeTurn(input);
  return {
    composerDisabled: busy || !turnProviderReady,
    controlsDisabled: busy || archived,
    canSend:
      turnProviderReady &&
      input.draft.trim().length > 0 &&
      !input.isLoading &&
      !input.isCleaningContext,
    canCreateSession: input.currentProviderReady && !busy,
  };
}
