/**
 * Recovery state for a message that was typed but never sent, held against the
 * conversation that owns it.
 *
 * A pre-send failure can resolve after the user has already moved to another
 * conversation. Writing that outcome into the store at that point would show
 * one conversation's draft and error inside a different one, so the outcome is
 * parked here under the owning document and session and only restored when that
 * conversation is on screen again.
 */
type PendingDraft = {
  readonly draft: string;
  readonly error: string;
};

/**
 * The send that claimed the composer, together with the checks that decide
 * whether it still owns the visible state.
 */
export type PreSendOwner = {
  readonly documentId: string | null;
  readonly sessionId: string;
  readonly draft: string;
  /** True while the owning conversation is the one the user is looking at. */
  readonly isActiveSession: () => boolean;
  /** True while no newer send has taken over the composer. */
  readonly isCurrentSend: () => boolean;
  /** Ends the send's claim on the composer and shows the failure with its draft. */
  readonly showFailure: (error: string) => void;
};

const MAX_PENDING_DRAFTS = 16;
const MAX_SUBMITTED_PROMPTS = 8;

function draftKey(documentId: string | null, sessionId: string): string {
  return `${documentId ?? ''}\u0000${sessionId}`;
}

function evictOldest<V>(entries: Map<string, V>, limit: number): void {
  if (entries.size <= limit) return;
  const oldest = entries.keys().next().value;
  if (oldest !== undefined) entries.delete(oldest);
}

/** The drafts and submitted prompts one chat controller is holding for recovery. */
export class PreSendDrafts {
  readonly #pendingDrafts = new Map<string, PendingDraft>();
  /**
   * The exact words each in-flight turn was submitted with.
   *
   * A turn that fails after it has crossed the bridge — the provider errors, or
   * abandons the stream — is reported by a stream event that carries the request
   * id and nothing the reader wrote. There is no Retry control to re-send it, so
   * the composer has to be given the prompt back, and this is where the prompt
   * waits in the meantime. It is dropped the moment the turn settles, so a
   * finished conversation holds none of it.
   */
  readonly #submittedPrompts = new Map<string, string>();

  /**
   * Settles a send that claimed `isStreaming` but must not reach the provider.
   *
   * The owning send clears the streaming claim and hands the draft to the visible
   * retry UX. Once another conversation is active, the same outcome is parked for
   * the owning conversation instead: the session on screen keeps its own state. A
   * newer send in the same conversation already owns recovery, so it is left
   * alone.
   */
  settlePreSendFailure(owner: PreSendOwner, error: string): void {
    if (!owner.isActiveSession()) {
      this.#pendingDrafts.set(draftKey(owner.documentId, owner.sessionId), { draft: owner.draft, error });
      evictOldest(this.#pendingDrafts, MAX_PENDING_DRAFTS);
      return;
    }
    if (!owner.isCurrentSend()) return;
    owner.showFailure(error);
  }

  /**
   * The error and draft to show when a conversation becomes active, which is
   * nothing at all unless that exact conversation left a failed pre-send behind.
   */
  recoveredDraftState(
    documentId: string | null,
    sessionId: string
  ): { error: string | null; lastFailedDraft: string | null } {
    const pending = this.#pendingDrafts.get(draftKey(documentId, sessionId));
    return { error: pending?.error ?? null, lastFailedDraft: pending?.draft ?? null };
  }

  /** Drops a parked draft once its conversation has consumed or dismissed it. */
  forgetPendingDraft(documentId: string | null, sessionId: string | null): void {
    if (sessionId === null) return;
    this.#pendingDrafts.delete(draftKey(documentId, sessionId));
  }

  clear(): void {
    this.#pendingDrafts.clear();
    this.#submittedPrompts.clear();
  }

  rememberSubmittedPrompt(requestId: string, prompt: string): void {
    this.#submittedPrompts.set(requestId, prompt);
    evictOldest(this.#submittedPrompts, MAX_SUBMITTED_PROMPTS);
  }

  /** The prompt a request was submitted with, removed as it is handed over. */
  takeSubmittedPrompt(requestId: string): string | null {
    const prompt = this.#submittedPrompts.get(requestId);
    this.#submittedPrompts.delete(requestId);
    return prompt ?? null;
  }

  forgetSubmittedPrompt(requestId: string): void {
    this.#submittedPrompts.delete(requestId);
  }
}
