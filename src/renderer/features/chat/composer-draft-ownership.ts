/**
 * Who the words in the composer belong to.
 *
 * The composer holds its text in component state, which by itself belongs to
 * the panel rather than to any conversation: without an owner, text typed in
 * one document or session stays on screen when another is opened, and a failure
 * recovered for the first would be offered for sending into the second. The
 * conversation on screen is the owner, and this decides what the composer holds
 * whenever that owner or the store's recovery changes.
 */

/** The conversation a composer's text belongs to, as one comparable value. */
export function composerOwnerKey(
  document: { readonly id: string } | null | undefined,
  sessionId: string | null
): string {
  return `${document?.id ?? ''}\u0000${sessionId ?? ''}`;
}

export type DraftPlacement = {
  /** The text to put in the composer, or `null` to leave it untouched. */
  readonly draft: string | null;
  /** Whether the store's recovery has now been handed over and should be dropped. */
  readonly consumeRecovery: boolean;
};

const UNCHANGED: DraftPlacement = { draft: null, consumeRecovery: false };

/**
 * What the composer should hold, given who owns it now.
 *
 * On a change of owner the composer is reset. An ordinary draft that was typed
 * but never sent is not carried across and not parked — leaving a conversation
 * discards it, which is the one rule that cannot show a reader their words
 * under a conversation that never had them.
 *
 * A failed submission does survive, because there is no Retry control: the
 * exact words are handed back so they can be edited or sent again. They are
 * handed back once. Consuming the recovery is what stops an edited or cleared
 * one from reappearing later; from then on the words are the composer's.
 *
 * Within one conversation a recovery is placed only into an empty composer. A
 * reader who began typing the next message while the failed one was in flight
 * keeps what they typed, and the store goes on holding the failed text.
 */
export function placeComposerDraft(input: {
  readonly ownerChanged: boolean;
  readonly recovered: string | null;
  readonly currentDraft: string;
}): DraftPlacement {
  const recovered = input.recovered === null || input.recovered.length === 0 ? null : input.recovered;
  if (input.ownerChanged) return { draft: recovered ?? '', consumeRecovery: recovered !== null };
  if (recovered === null || input.currentDraft.trim().length > 0) return UNCHANGED;
  return { draft: recovered, consumeRecovery: true };
}
