import { bridge } from '../../app/api-client';
import { withoutContextItems } from './transcript';
import { errorMessage, type ChatRuntime } from './runtime';

/**
 * Conversations with a `Clean Context` request in flight, by session id.
 *
 * Held per session rather than as one flag, because the reader may navigate away
 * while a clean is running and the conversation they navigate to is not being
 * cleaned. `isCleaningContext` is this set projected onto whichever session is
 * active, so switching away re-enables the session in view and switching back
 * disables it again for exactly as long as its own clean lasts. Main refuses the
 * same operations regardless; this only keeps the UI honest about which
 * conversation is busy.
 */
export class CleaningSessions {
  readonly #sessions = new Set<string>();

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  add(sessionId: string): void {
    this.#sessions.add(sessionId);
  }

  delete(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** Whether the session about to be shown is the one being cleaned. */
  flagFor(sessionId: string | null): boolean {
    return sessionId !== null && this.#sessions.has(sessionId);
  }
}

export async function cleanContext(runtime: ChatRuntime): Promise<boolean> {
  const state = runtime.get();
  const sessionId = state.activeSessionId;
  // Asked of the session itself, not of the published flag: the flag follows
  // whichever conversation is in view, the reservation follows the request.
  if (!sessionId || state.isStreaming || runtime.cleaning.has(sessionId)) return false;
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session || session.isArchived) return false;
  runtime.cleaning.add(sessionId);
  runtime.set({ isCleaningContext: true, error: null, statusMessage: 'Cleaning context…' });
  try {
    const result = await bridge.chat.cleanContext(sessionId);
    runtime.cleaning.delete(sessionId);
    const stillActive = runtime.get().activeSessionId === sessionId;
    // The boundary is committed state and belongs to its own session, so it is
    // recorded whether or not that conversation is still on screen: switching
    // back must read the new boundary, which keeps the control quiet until a
    // completed turn sits past it. Only what the reader can see — the chips and
    // the status line — is bound to the session still being active, so another
    // conversation's chips are never cleared underneath them.
    runtime.set((current) => ({
      sessions: current.sessions.map((entry) =>
        entry.id === sessionId ? { ...entry, compactedThroughOrdinal: result.compactedThroughOrdinal } : entry
      ),
      ...(stillActive
        ? {
            contextItems: withoutContextItems(current.contextItems, result.clearedContextItemIds),
            statusMessage: 'Context cleaned. Earlier messages are now summarised.',
          }
        : {}),
      isCleaningContext: runtime.cleaning.flagFor(current.activeSessionId),
    }));
    return true;
  } catch (error) {
    runtime.cleaning.delete(sessionId);
    // Nothing changed in main, so nothing changes here either.
    runtime.set((current) => ({
      isCleaningContext: runtime.cleaning.flagFor(current.activeSessionId),
      ...(current.activeSessionId === sessionId
        ? { statusMessage: '', error: errorMessage(error instanceof Error ? error : null, 'Could not clean this conversation.') }
        : {}),
    }));
    return false;
  }
}
