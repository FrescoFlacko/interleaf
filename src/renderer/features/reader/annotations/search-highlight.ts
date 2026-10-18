export const SEARCH_HIGHLIGHT_NAME = 'interleaf-search';
export const MAX_SEARCH_HIGHLIGHT_RANGES = 32;

/**
 * The CSS Custom Highlight API of the window a document belongs to.
 *
 * An ebook section paints in its own iframe, so the registry and constructor
 * come from that document's window rather than the reader's.
 */
type HighlightApi = {
  readonly registry: HighlightRegistry;
  readonly Highlight: typeof Highlight;
};

/** A document detached from any window has nothing to paint into. */
function getHighlightApi(doc: Document): HighlightApi | null {
  const view = doc.defaultView;
  if (!view) return null;
  return { registry: view.CSS.highlights, Highlight: view.Highlight };
}

/** Only live ranges are ever registered here; a static range has no text. */
function isLiveRange(range: AbstractRange): range is Range {
  return 'cloneRange' in range;
}

function ensureSearchHighlightStyles(doc: Document): void {
  const styleId = 'interleaf-search-highlight-styles';
  if (doc.getElementById(styleId)) return;
  const style = doc.createElement('style');
  style.id = styleId;
  style.textContent = `
    ::highlight(${SEARCH_HIGHLIGHT_NAME}) {
      background-color: var(--search-mark, #fde68a);
      color: inherit;
      text-decoration: underline 2px solid var(--warning, #7a4508);
      text-decoration-skip-ink: none;
    }
    @media (forced-colors: active) {
      ::highlight(${SEARCH_HIGHLIGHT_NAME}) {
        background-color: Highlight;
        color: HighlightText;
        text-decoration: underline;
      }
    }
  `;
  doc.head.appendChild(style);
}

export function clearSearchHighlight(doc: Document): void {
  getHighlightApi(doc)?.registry.delete(SEARCH_HIGHLIGHT_NAME);
}

export function applySearchHighlight(doc: Document, ranges: readonly Range[]): number {
  const api = getHighlightApi(doc);
  if (!api) return 0;
  ensureSearchHighlightStyles(doc);
  const bounded = ranges
    .filter((range) => !range.collapsed && range.startContainer.ownerDocument === doc && range.endContainer.ownerDocument === doc)
    .slice(0, MAX_SEARCH_HIGHLIGHT_RANGES);
  if (bounded.length === 0) {
    api.registry.delete(SEARCH_HIGHLIGHT_NAME);
    return 0;
  }
  api.registry.set(SEARCH_HIGHLIGHT_NAME, new api.Highlight(...bounded));
  return bounded.length;
}

export function searchHighlightRanges(doc: Document): readonly Range[] {
  const api = getHighlightApi(doc);
  if (!api) return [];
  const highlight = api.registry.get(SEARCH_HIGHLIGHT_NAME);
  if (!highlight) return [];
  return Array.from(highlight).filter(isLiveRange);
}
