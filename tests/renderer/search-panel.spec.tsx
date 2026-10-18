// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { SearchPanel } from '../../src/renderer/features/search/SearchPanel';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useSearchStore } from '../../src/renderer/stores/use-search-store';
import type { DocumentMetadata } from '@shared/types/document';
import type { SearchHit, SearchMatchAnchor } from '@shared/types/search';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';

const document: DocumentMetadata = {
  id: 'doc-1', title: 'Consensus Notes', author: 'Ada', format: 'docx', storageMode: 'link',
  fileSize: 10, fileMtimeMs: 1, fileHash: 'hash-1', pageCount: 2,   folderId: null, storageHealth: 'ok', readingPosition: null,
  createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  source: null,
};

const hit = {
  chunkId: 'generation:0', documentId: 'doc-1', documentTitle: 'Consensus Notes',
  documentAuthor: 'Ada', documentHash: 'hash-1', ordinal: 0,
  excerpt: 'A quorum overlaps another quorum.',
  location: { format: 'docx' as const, paragraphIndex: 7, characterStart: 0, characterEnd: 30, renderedPageIndex: 1 },
  heading: 'Safety', pageLabel: 'Rendered page 2', rank: -1, anchor: null,
};
const hitAnchor: SearchMatchAnchor = {
  version: 1, chunkId: hit.chunkId, documentId: hit.documentId, documentHash: hit.documentHash,
  location: hit.location, queryTerms: ['quorum'],
  ranges: [{ start: 2, end: 8, text: 'quorum', queryTermIndex: 0, queryTermIndices: [0] }],
};

describe('SearchPanel', () => {
  const searchDocument = vi.fn<(documentId: string, query: string, limit?: number) => Promise<readonly SearchHit[]>>(
    () => Promise.resolve([hit])
  );
  const resolveHit = vi.fn<(documentId: string, documentHash: string, chunkId: string, query: string) => Promise<SearchMatchAnchor | null>>(
    () => Promise.resolve(hitAnchor)
  );
  const goToLocation = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    searchDocument.mockClear();
    resolveHit.mockClear();
    goToLocation.mockClear();
    stubBridge({
      search: { searchDocument, resolveHit },
      library: { closeDocument: vi.fn(() => Promise.resolve()) },
    });
    useReaderStore.setState({ session: testReaderSession(document), goToLocation });
    useSearchStore.setState({
      indexStates: {
        'doc-1': {
          documentId: 'doc-1', documentHash: 'hash-1', status: 'ready', totalChunks: 12,
          indexedChunks: 12, estimatedTokens: 3_200, errorMessage: null,
          updatedAt: '2026-08-24T00:00:00.000Z',
        },
      },
      activeIndexingDocumentId: null,
      reindexNonce: 0,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('searches the open document and navigates from a plain-text provenance chip', async () => {
    render(<SearchPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('12 passages indexed.');
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'quorum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => { expect(searchDocument).toHaveBeenCalledWith('doc-1', 'quorum', 50); });
    expect(screen.getByTestId('search-result-excerpt').textContent).toBe('A quorum overlaps another quorum.');
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'edited without submit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Jump to Rendered page 2 in Consensus Notes' }));
    await waitFor(() => {
      expect(resolveHit).toHaveBeenCalledWith('doc-1', 'hash-1', 'generation:0', 'quorum');
      expect(goToLocation).toHaveBeenCalledWith(hit.location);
    });
    expect(useReaderStore.getState().searchHighlightRequest?.query).toBe('quorum');
  });

  it('marks only exact whole-token matches in the card, in any casing, from the executed query', async () => {
    searchDocument.mockResolvedValueOnce([{
      ...hit,
      heading: 'Quorum safety',
      excerpt: 'A QUORUM of quorums; quorum-based voting needs no quorumless fallback.',
    } satisfies SearchHit]);
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'Quorum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: 'Jump to Rendered page 2 in Consensus Notes' });

    const excerpt = screen.getByTestId('search-result-excerpt');
    // `QUORUM` and the `quorum` of `quorum-based` are the token; `quorums` and
    // `quorumless` are different tokens and stay unmarked.
    expect([...excerpt.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['QUORUM', 'quorum']);
    expect(excerpt.textContent).toBe('A QUORUM of quorums; quorum-based voting needs no quorumless fallback.');
    expect([...screen.getByTestId('search-result-heading').querySelectorAll('mark')].map((mark) => mark.textContent))
      .toEqual(['Quorum']);

    // Editing the input does not repaint cards produced by the executed query.
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'voting' } });
    expect([...excerpt.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['QUORUM', 'quorum']);
  });

  it('preserves main-owned reading order, labels each location, and keeps excerpts as text', async () => {
    const earlier = {
      ...hit,
      chunkId: 'generation:earlier',
      excerpt: '<img src=x onerror=alert(1)> earlier passage',
      pageLabel: 'Rendered page 1',
      location: { format: 'docx' as const, paragraphIndex: 1, renderedPageIndex: 0 },
    } satisfies SearchHit;
    const later = {
      ...hit,
      chunkId: 'generation:later',
      excerpt: 'later passage',
      pageLabel: 'Rendered page 10',
      location: { format: 'docx' as const, paragraphIndex: 10, renderedPageIndex: 9 },
    } satisfies SearchHit;
    searchDocument.mockResolvedValueOnce([earlier, later]);

    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'passage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: 'Jump to Rendered page 10 in Consensus Notes' });

    const list = screen.getByRole('list', { name: 'Search results' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.getAttribute('aria-posinset'))).toEqual(['1', '2']);
    expect(items.map((item) => item.getAttribute('aria-setsize'))).toEqual(['2', '2']);
    expect(within(items[0]!).getByRole('button').textContent).toContain('Rendered page 1');
    expect(within(items[1]!).getByRole('button').textContent).toContain('Rendered page 10');
    // Markup-looking excerpt text stays inert text, marks and all.
    expect(within(items[0]!).getByTestId('search-result-excerpt').textContent)
      .toBe('<img src=x onerror=alert(1)> earlier passage');
    expect(within(items[0]!).queryByRole('img')).toBeNull();
    expect(within(items[0]!).getByTestId('search-result-excerpt').innerHTML).not.toContain('<img');
    expect([...items[0]!.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['passage']);
  });

  it('searches only the open document and offers no library scope', async () => {
    searchDocument.mockResolvedValueOnce([]);
    render(<SearchPanel />);
    expect(screen.queryByRole('button', { name: 'Library' })).toBeNull();
    expect(screen.queryByLabelText('Search scope')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'missing' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Search' }).closest('form')!);
    await waitFor(() => { expect(searchDocument).toHaveBeenCalledWith('doc-1', 'missing', 50); });
    expect(screen.getByRole('status')).toHaveTextContent('0 results.');
  });

  it('does not search when no document is open', () => {
    useReaderStore.setState({ session: null });
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'quorum' } });
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Search' }).closest('form')!);
    expect(searchDocument).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Open a document to build its search index.');
  });

  it('passes an automated accessibility audit with a provenance result', async () => {
    const { container } = render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'quorum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: 'Jump to Rendered page 2 in Consensus Notes' });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('discards an older search response after the active document changes', async () => {
    let release: ((value: readonly SearchHit[]) => void) | undefined;
    searchDocument.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'quorum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => { expect(searchDocument).toHaveBeenCalled(); });
    act(() => {
      useReaderStore.setState({ session: testReaderSession({ ...document, id: 'doc-2', fileHash: 'hash-2', title: 'Other' }) });
    });
    await act(async () => { release?.([hit]); await Promise.resolve(); });
    expect(screen.queryByTestId('search-result-excerpt')).toBeNull();
    expect(screen.getByRole('button', { name: 'Search' })).not.toBeDisabled();
  });

  it('clears query and results at close, then ignores a late response and same-document reopen', async () => {
    let release: ((value: readonly SearchHit[]) => void) | undefined;
    searchDocument.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search indexed text');
    fireEvent.change(input, { target: { value: 'quorum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => { expect(searchDocument).toHaveBeenCalled(); });

    await act(async () => { await useReaderStore.getState().closeDocument(); });
    expect(input).toHaveValue('');
    expect(screen.queryByTestId('search-result-excerpt')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Open a document to build its search index.');

    await act(async () => { release?.([hit]); await Promise.resolve(); });
    expect(screen.queryByTestId('search-result-excerpt')).toBeNull();

    act(() => { useReaderStore.setState({ session: testReaderSession(document) }); });
    await waitFor(() => { expect(input).toHaveValue(''); });
    expect(screen.queryByTestId('search-result-excerpt')).toBeNull();
  });

  it('refuses navigation when main reports that a hit revision is stale', async () => {
    resolveHit.mockResolvedValueOnce(null);
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText('Search indexed text'), { target: { value: 'quorum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const jump = await screen.findByRole('button', { name: 'Jump to Rendered page 2 in Consensus Notes' });
    fireEvent.click(jump);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/result is stale/i);
    });
    expect(goToLocation).not.toHaveBeenCalled();
  });

  it('settles a pending search when an older mounted result is opened meanwhile', async () => {
    let release: ((value: readonly SearchHit[]) => void) | undefined;
    searchDocument
      .mockResolvedValueOnce([hit])
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search indexed text');
    fireEvent.change(input, { target: { value: 'quorum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const oldJump = await screen.findByRole('button', { name: 'Jump to Rendered page 2 in Consensus Notes' });

    fireEvent.change(input, { target: { value: 'new query' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    fireEvent.click(oldJump);
    await waitFor(() => { expect(resolveHit).toHaveBeenCalled(); });
    expect(resolveHit).toHaveBeenCalledWith('doc-1', 'hash-1', 'generation:0', 'quorum');
    await act(async () => { release?.([]); await Promise.resolve(); });

    expect(screen.getByRole('button', { name: 'Search' })).not.toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('0 results.');
  });

  it('does not let a late navigation completion repaint after a newer search starts', async () => {
    let releaseNavigation: ((value: SearchMatchAnchor | null) => void) | undefined;
    resolveHit.mockImplementationOnce(() => new Promise((resolve) => { releaseNavigation = resolve; }));
    searchDocument.mockResolvedValueOnce([hit]).mockResolvedValueOnce([]);
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search indexed text');
    fireEvent.change(input, { target: { value: 'quorum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const oldJump = await screen.findByRole('button', { name: 'Jump to Rendered page 2 in Consensus Notes' });
    fireEvent.click(oldJump);
    fireEvent.change(input, { target: { value: 'new query' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await act(async () => { releaseNavigation?.(hitAnchor); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('0 results.'));
    expect(goToLocation).not.toHaveBeenCalled();
    expect(useReaderStore.getState().searchHighlightRequest).toBeNull();
  });
});
