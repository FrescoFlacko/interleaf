export const SELECTION_NOTE_HIGHLIGHT_NAME = 'interleaf-note-selection';

/**
 * The passage a selection note is being written about, kept visibly marked
 * while the note field owns focus and the browser selection has collapsed.
 *
 * It is a temporary paint, not an annotation: it reads as the reader's own
 * selection rather than a saved highlight or a search match, and it is
 * removed the moment the note closes or the passage stops being the target.
 * The tint is translucent and leaves the text color alone, so glyphs drawn
 * beneath a transparent text layer, as in a PDF, stay readable.
 * Like search, it registers in the window of the document holding the text,
 * so an ebook section paints inside its own iframe.
 */

function ensureSelectionNoteStyles(doc: Document): void {
  const styleId = 'interleaf-note-selection-styles';
  if (doc.getElementById(styleId)) return;
  const style = doc.createElement('style');
  style.id = styleId;
  style.textContent = `
    ::highlight(${SELECTION_NOTE_HIGHLIGHT_NAME}) {
      background-color: var(--selection-translucent, rgba(3, 105, 161, 0.25));
    }
    @media (forced-colors: active) {
      ::highlight(${SELECTION_NOTE_HIGHLIGHT_NAME}) {
        background-color: Highlight;
        color: HighlightText;
      }
    }
  `;
  doc.head.appendChild(style);
}

/**
 * Drops whitespace so a DOM range can be matched against the captured text,
 * which an adapter may join differently or cut short for a long passage.
 */
function normalized(text: string): string {
  return text.replace(/\s+/gu, '');
}

function selectedRangeIn(doc: Document | null, text: string): Range | null {
  const selection = doc?.getSelection() ?? null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return normalized(range.toString()).startsWith(text) ? range.cloneRange() : null;
}

/**
 * A copy of the live browser range behind the reader's current selection, or
 * null when none matches its text. Ebook sections select inside iframes, so
 * the reader's frames are searched after the top document.
 */
export function liveSelectionRange(reader: Element | null, selectedText: string): Range | null {
  const text = normalized(selectedText);
  if (!reader || text.length === 0) return null;
  const top = selectedRangeIn(reader.ownerDocument, text);
  if (top && reader.contains(top.commonAncestorContainer)) return top;
  for (const frame of reader.querySelectorAll('iframe')) {
    const range = selectedRangeIn(frame.contentDocument, text);
    if (range) return range;
  }
  return null;
}

/** Paints the range and returns the cleanup that removes exactly this paint. */
export function paintSelectionNote(range: Range): () => void {
  const doc = range.startContainer.ownerDocument;
  const view = doc?.defaultView;
  if (!doc || !view || range.collapsed) return () => undefined;
  ensureSelectionNoteStyles(doc);
  const highlight = new view.Highlight(range);
  view.CSS.highlights.set(SELECTION_NOTE_HIGHLIGHT_NAME, highlight);
  return () => {
    if (view.CSS.highlights.get(SELECTION_NOTE_HIGHLIGHT_NAME) === highlight) {
      view.CSS.highlights.delete(SELECTION_NOTE_HIGHLIGHT_NAME);
    }
  };
}
