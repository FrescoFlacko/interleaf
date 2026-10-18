import type { ChatCitation } from '@shared/types/ai';

/**
 * A citation marker as the model writes it, `[src-1]`. Whether a marker is a
 * citation is decided only by the turn's validated citation envelope: a marker
 * the envelope does not name is ordinary text and is left exactly as written.
 */
export const CITATION_MARKER_PATTERN = /\[([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]/gu;

/**
 * The id main gives every grounded source it sends a model (`src-1`, `src-2`,
 * …). Only a marker of this shape can be waiting for its envelope while an
 * answer streams; any other bracketed text is ordinary text throughout.
 */
const GROUNDED_SOURCE_ID_PATTERN = /^src-[1-9][0-9]{0,8}$/u;

export function isGroundedSourceId(sourceId: string): boolean {
  return GROUNDED_SOURCE_ID_PATTERN.test(sourceId);
}

/** The short label a known citation is shown with: its page, else its heading. */
export function chatCitationLabel(citation: ChatCitation): string {
  if (citation.pageLabel) {
    const raw = citation.pageLabel.trim();
    const cleanNum = raw.replace(/^page\s+/iu, '');
    return `p. ${cleanNum}`;
  }
  return citation.heading ?? citation.label;
}
