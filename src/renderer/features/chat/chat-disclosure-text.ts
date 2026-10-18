import type { ChatContextDisclosure } from '@shared/types/ai';

/**
 * What a context disclosure says to the reader.
 *
 * Each reason is a different statement about the answer above it, and the
 * difference matters: one says the turn carried less of a document than the
 * reader attached, another says it answered from a particular part of it. The
 * wording lives apart from the bubble because it is the substance of the note
 * rather than its presentation.
 */
export function disclosureDetail(disclosure: ChatContextDisclosure): string {
  const counts = `${String(disclosure.includedChunks)} of ${String(disclosure.totalChunks)} chunks included; ${String(disclosure.omittedChunks)} omitted`;
  // A pinned whole document too large for the model is not partially included
  // by accident: only context near the reader's current position was sent, and
  // the note has to say so rather than imply the rest was merely trimmed.
  if (disclosure.reason === 'nearby_context_only') return nearbyDetail(disclosure, counts);
  const limit =
    disclosure.reason === 'model_context_window'
      ? 'model context window limit'
      : 'maximum sources per request limit';
  return `“${disclosure.displayLabel}” (${counts} due to ${limit}).`;
}

/**
 * Named in the document's own units when the format has them, so the reader can
 * check the answer against the pages that were actually sent. A format without
 * page numbering says only that the context was nearby, which is all it knows.
 */
function nearbyDetail(disclosure: ChatContextDisclosure, counts: string): string {
  const sent = `“${disclosure.displayLabel}” is too large for this model, so only context near your current position was included`;
  const where = disclosure.includedLabel ?? null;
  return where === null ? `${sent} (${counts}).` : `${sent}: ${where} (${counts}).`;
}
