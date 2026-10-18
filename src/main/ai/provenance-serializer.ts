import { DOMParser } from 'linkedom';
import type { ChatSourceEnvelopeItem } from '@shared/types/ai';
import type { DocumentFormat } from '@shared/types/document';

export type ProvenanceDocument = {
  readonly title: string;
  readonly format: DocumentFormat;
  readonly documentHash: string;
};

/**
 * Builds the provenance envelope through an XML DOM. Document-derived text is
 * assigned only through textContent/setAttribute; it is never interpolated
 * into markup (ADR-0006 and docs/SECURITY.md prompt-injection boundary).
 */
export function serializeProvenanceXml(
  documentInfo: ProvenanceDocument,
  sources: readonly ChatSourceEnvelopeItem[]
): string {
  const document = new DOMParser().parseFromString('<document/>', 'text/xml');
  const root = document.documentElement;
  root.setAttribute('title', documentInfo.title);
  root.setAttribute('format', documentInfo.format);
  root.setAttribute('revision', documentInfo.documentHash);

  for (const source of sources) {
    const element = document.createElement('source');
    element.setAttribute('id', source.sourceId);
    element.setAttribute('label', source.label);
    if (source.pageLabel !== null) element.setAttribute('page', source.pageLabel);
    if (source.heading !== null) element.setAttribute('heading', source.heading);
    element.textContent = source.excerptText;
    root.appendChild(element);
  }
  return root.outerHTML;
}

/**
 * Wraps a stored conversation summary as one untrusted-data element.
 *
 * The summary was written by a model over a transcript the reader partly wrote,
 * so it is untrusted on exactly the terms document text is. It is built through
 * the same DOM path — assigned as `textContent`, never interpolated into markup
 * — and it travels in the request's data block, never in the system prompt.
 */
export function serializeConversationSummaryXml(summary: string): string {
  const document = new DOMParser().parseFromString('<conversation-summary/>', 'text/xml');
  const root = document.documentElement;
  root.textContent = summary;
  return root.outerHTML;
}

/** One turn of a conversation as a compaction call is allowed to see it. */
export type CompactionTranscriptMessage = {
  readonly role: 'user' | 'assistant' | 'system';
  readonly ordinal: number;
  readonly content: string;
};

/**
 * Wraps a compaction input as the `<transcript>` data envelope its system prompt
 * names.
 *
 * The prompt tells the model that everything inside `<transcript>` is untrusted
 * data, so the transcript has to actually be inside it. Every message and the
 * previous summary are assigned through `textContent`, so a message containing
 * `</transcript>`, XML, or instruction-shaped text is escaped into character
 * data and cannot close the envelope or present itself as an instruction.
 */
export function serializeCompactionTranscriptXml(input: {
  readonly previousSummary: string | null;
  readonly messages: readonly CompactionTranscriptMessage[];
}): string {
  const document = new DOMParser().parseFromString('<transcript/>', 'text/xml');
  const root = document.documentElement;
  if (input.previousSummary !== null) {
    const previous = document.createElement('previous-summary');
    previous.textContent = input.previousSummary;
    root.appendChild(previous);
  }
  for (const message of input.messages) {
    const element = document.createElement('message');
    element.setAttribute('role', message.role);
    element.setAttribute('ordinal', String(message.ordinal));
    element.textContent = message.content;
    root.appendChild(element);
  }
  return root.outerHTML;
}

/**
 * Wraps the question a conversation-naming call titles as one untrusted-data
 * element. It is assigned through `textContent`, so markup or an attempt to
 * close the envelope in the question becomes character data.
 */
export function serializeTitleQuestionXml(question: string): string {
  const document = new DOMParser().parseFromString('<first-question/>', 'text/xml');
  const root = document.documentElement;
  root.textContent = question;
  return root.outerHTML;
}
