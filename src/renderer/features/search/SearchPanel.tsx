import { useEffect, useId, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import type { DocumentMetadata } from '@shared/types/document';
import type { SearchHit } from '@shared/types/search';
import { selectActiveDocument, useReaderStore } from '../../stores/use-reader-store';
import { useSearchStore } from '../../stores/use-search-store';
import { AppIcon } from '../../components/AppIcon';
import { SearchMatchText } from './SearchMatchText';
import { bridge } from '../../app/api-client';

function provenance(hit: SearchHit): string {
  if (hit.pageLabel) return hit.pageLabel;
  if (hit.location.format === 'pdf') return `Page ${String(hit.location.pageIndex + 1)}`;
  if (hit.location.format === 'pptx') return `Slide ${String((hit.location.renderedPageIndex ?? 0) + 1)}`;
  if (hit.location.format === 'docx') return `Paragraph ${String(hit.location.paragraphIndex + 1)}`;
  if (hit.location.format === 'markdown') return hit.heading ?? `Block ${String(hit.location.blockIndex + 1)}`;
  if (hit.location.format === 'mobi') return `Section ${String(hit.location.sectionIndex + 1)}`;
  return hit.heading ?? 'Passage';
}

function documentIdentity(document: DocumentMetadata | null): string {
  if (document === null) return '';
  return `${document.id}\u0000${document.fileHash}`;
}

export function SearchPanel() {
  const inputId = useId();
  const activeDocument = useReaderStore(selectActiveDocument);
  const openDocument = useReaderStore((state) => state.openDocument);
  const goToLocation = useReaderStore((state) => state.goToLocation);
  const requestSearchHighlight = useReaderStore((state) => state.requestSearchHighlight);
  const clearSearchHighlight = useReaderStore((state) => state.clearSearchHighlight);
  const searchHighlightAnnouncement = useReaderStore((state) => state.searchHighlightAnnouncement);
  const indexState = useSearchStore((state) =>
    activeDocument ? state.indexStates[activeDocument.id] : undefined
  );
  const transientResetRevision = useSearchStore((state) => state.transientResetRevision);
  const requestReindex = useSearchStore((state) => state.requestReindex);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly SearchHit[]>([]);
  /** Immutable query that produced the currently rendered result cards. */
  const [resultsQuery, setResultsQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [message, setMessage] = useState('');
  const previousDocumentId = useRef<string | null>(null);
  const appliedResetRevision = useRef(transientResetRevision);
  const searchSequence = useRef(0);
  const navigationSequence = useRef(0);

  useEffect(() => {
    if (appliedResetRevision.current === transientResetRevision) return;
    appliedResetRevision.current = transientResetRevision;
    searchSequence.current += 1;
    navigationSequence.current += 1;
    setQuery('');
    setResults([]);
    setResultsQuery('');
    setIsSearching(false);
    setMessage('');
    clearSearchHighlight();
  }, [clearSearchHighlight, transientResetRevision]);

  useEffect(() => {
    const nextId = activeDocument?.id ?? null;
    if (nextId !== previousDocumentId.current) {
      searchSequence.current += 1;
      navigationSequence.current += 1;
      setIsSearching(false);
      setResults([]);
      setResultsQuery('');
      setMessage('');
      if (nextId === null) setQuery('');
      clearSearchHighlight();
      previousDocumentId.current = nextId;
    }
  }, [activeDocument, clearSearchHighlight]);

  async function runSearch(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    // Search covers the open document only; with none open there is nothing to search.
    if (!trimmed || !activeDocument) return;
    navigationSequence.current += 1;
    clearSearchHighlight();
    setIsSearching(true);
    setMessage('Searching…');
    const sequence = ++searchSequence.current;
    const requestedDocumentIdentity = documentIdentity(activeDocument);
    const resetRevision = useSearchStore.getState().transientResetRevision;
    try {
      const hits = await bridge.search.searchDocument(activeDocument.id, trimmed, 50);
      const currentDocument = selectActiveDocument(useReaderStore.getState());
      if (
        sequence !== searchSequence.current ||
        resetRevision !== useSearchStore.getState().transientResetRevision ||
        documentIdentity(currentDocument) !== requestedDocumentIdentity
      ) return;
      setResults(hits);
      setResultsQuery(trimmed);
      setMessage(`${String(hits.length)} ${hits.length === 1 ? 'result' : 'results'}.`);
    } catch (error) {
      if (
        sequence !== searchSequence.current ||
        resetRevision !== useSearchStore.getState().transientResetRevision ||
        documentIdentity(selectActiveDocument(useReaderStore.getState())) !== requestedDocumentIdentity
      ) return;
      setResults([]);
      setResultsQuery('');
      setMessage(error instanceof Error ? error.message : 'Search failed.');
    } finally {
      if (sequence === searchSequence.current) setIsSearching(false);
    }
  }

  async function jump(hit: SearchHit): Promise<void> {
    const executedQuery = resultsQuery;
    if (!executedQuery) return;
    const sequence = ++navigationSequence.current;
    const resetRevision = useSearchStore.getState().transientResetRevision;
    clearSearchHighlight();
    const anchor = await bridge.search.resolveHit(hit.documentId, hit.documentHash, hit.chunkId, executedQuery);
    if (
      sequence !== navigationSequence.current ||
      resetRevision !== useSearchStore.getState().transientResetRevision
    ) return;
    if (!anchor) {
      setResults((current) => current.filter((candidate) => candidate.chunkId !== hit.chunkId));
      setMessage('That result is stale because the document changed. Search again.');
      return;
    }
    if (activeDocument?.id === hit.documentId) await goToLocation(anchor.location);
    else await openDocument(hit.documentId, anchor.location);
    if (
      sequence !== navigationSequence.current ||
      resetRevision !== useSearchStore.getState().transientResetRevision
    ) {
      clearSearchHighlight();
      return;
    }
    requestSearchHighlight({
      documentId: hit.documentId,
      documentHash: hit.documentHash,
      query: executedQuery,
      location: anchor.location,
      anchor,
    });
  }

  const indexLabel = !activeDocument
    ? 'Open a document to build its search index.'
    : indexState?.status === 'indexing'
      ? `Indexing ${String(indexState.indexedChunks)} passages…`
      : indexState?.status === 'ready' && indexState.documentHash === activeDocument.fileHash
        ? `${String(indexState.totalChunks)} passages indexed.`
        : indexState?.status === 'failed'
          ? indexState.errorMessage
          : 'Waiting to index this document.';

  return (
    <section data-testid="search-panel" aria-labelledby="search-panel-heading" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0">
        <h2 id="search-panel-heading" className="text-sm font-semibold">Full-text search</h2>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">Search the open document's text and jump to its source.</p>
      </div>
      <form className="mt-3 flex shrink-0 gap-2" onSubmit={(event) => { void runSearch(event); }}>
        <label htmlFor={inputId} className="sr-only">Search indexed text</label>
        <input
          id={inputId}
          type="search"
          value={query}
          maxLength={200}
          onChange={(event) => { setQuery(event.target.value); }}
          placeholder="Search passages…"
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-surface px-2.5 py-1.5 text-xs focus:border-accent focus:outline-hidden"
        />
        <button type="submit" disabled={!activeDocument || isSearching || query.trim().length === 0} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50">Search</button>
      </form>

      <div className="mt-2 flex shrink-0 items-start justify-between gap-2 text-xs text-text-secondary">
        <p role="status" aria-live="polite">{searchHighlightAnnouncement || message || indexLabel}</p>
        {activeDocument && indexState?.status === 'failed' && (
          <button type="button" onClick={requestReindex} className="shrink-0 text-accent hover:underline">Retry index</button>
        )}
      </div>

      <ol className="mt-3 flex-1 min-h-0 space-y-2 overflow-y-auto pr-0.5" aria-label="Search results">
        {results.map((hit, index) => (
          <li
            key={hit.chunkId}
            aria-posinset={index + 1}
            aria-setsize={results.length}
            className="rounded-lg border border-border-subtle bg-bg-surface p-3"
          >
            <p className="text-xs font-semibold text-text-primary">{hit.documentTitle}</p>
            {hit.heading && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                <SearchMatchText text={hit.heading} query={resultsQuery} testId="search-result-heading" />
              </p>
            )}
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              <SearchMatchText text={hit.excerpt} query={resultsQuery} testId="search-result-excerpt" />
            </p>
            <button
              type="button"
              aria-label={`Jump to ${provenance(hit)} in ${hit.documentTitle}`}
              onClick={() => { void jump(hit); }}
              className="mt-2 inline-flex items-center gap-1 rounded-full border border-accent/40 px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent/10"
            >
              {provenance(hit)}
              <AppIcon name="forward" size={12} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
