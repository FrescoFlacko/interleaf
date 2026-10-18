import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import type { DocumentFilter, DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * The saved Library defaults.
 *
 * Hydration happens after the shell is already interactive, so applying the
 * stored preference must never take the reader back out of a view or sort they
 * have just chosen. A change made deliberately in Settings is the one case that
 * overrides the current session.
 */

const listDocuments = vi.fn<(filter: DocumentFilter) => Promise<readonly DocumentMetadata[]>>(
  () => Promise.resolve([])
);

beforeEach(() => {
  listDocuments.mockClear();
  globalThis.window = globalThis as Window & typeof globalThis;
  stubBridge({
    library: {
      listDocuments,
      getContinueReading: () => Promise.resolve([]),
      getRecentlyAdded: () => Promise.resolve([]),
      getRecentlyRead: () => Promise.resolve([]),
    },
  });
  useLibraryStore.setState({
    viewMode: 'grid',
    sortBy: 'recent_added',
    defaultViewMode: 'grid',
    defaultSortBy: 'recent_added',
    viewModeTouched: false,
    sortByTouched: false,
    documents: [],
  });
});

describe('Library defaults hydration', () => {
  it('applies the stored view and sort when nothing has been chosen yet', async () => {
    useLibraryStore.getState().applyLibraryDefaults({ defaultView: 'list', defaultSort: 'title_asc' });

    const state = useLibraryStore.getState();
    expect(state.viewMode).toBe('list');
    expect(state.sortBy).toBe('title_asc');
    expect(state.defaultViewMode).toBe('list');
    expect(state.defaultSortBy).toBe('title_asc');
    // A different sort changes what the library must fetch.
    await vi.waitFor(() => { expect(listDocuments).toHaveBeenCalledOnce(); });
    expect(listDocuments.mock.calls[0]?.[0]).toMatchObject({ sort: 'title_asc' });
  });

  it('does not overwrite a view or sort the reader already chose this session', () => {
    useLibraryStore.getState().setViewMode('list');
    useLibraryStore.getState().setSortBy('recent_read');
    listDocuments.mockClear();

    useLibraryStore.getState().applyLibraryDefaults({ defaultView: 'grid', defaultSort: 'title_desc' });

    const state = useLibraryStore.getState();
    expect(state.viewMode).toBe('list');
    expect(state.sortBy).toBe('recent_read');
    // The stored preference is still recorded for later resets.
    expect(state.defaultViewMode).toBe('grid');
    expect(state.defaultSortBy).toBe('title_desc');
    expect(listDocuments).not.toHaveBeenCalled();
  });

  it('applies a deliberate Settings change immediately', () => {
    useLibraryStore.getState().setViewMode('grid');
    useLibraryStore.getState().setSortBy('recent_read');

    useLibraryStore.getState().applyLibraryDefaults(
      { defaultView: 'list', defaultSort: 'author_asc' },
      { view: true, sort: true }
    );

    expect(useLibraryStore.getState().viewMode).toBe('list');
    expect(useLibraryStore.getState().sortBy).toBe('author_asc');
  });

  it('applies only the forced field, leaving the other live choice alone', () => {
    useLibraryStore.getState().setViewMode('list');
    useLibraryStore.getState().setSortBy('recent_read');

    useLibraryStore.getState().applyLibraryDefaults(
      { defaultView: 'grid', defaultSort: 'author_asc' },
      { view: false, sort: true }
    );

    expect(useLibraryStore.getState().sortBy).toBe('author_asc');
    expect(useLibraryStore.getState().viewMode).toBe('list');
    // The unchanged default is still recorded for a reset or the next launch.
    expect(useLibraryStore.getState().defaultViewMode).toBe('grid');
  });

  it('returns to the stored default sort when the library view is reset', () => {
    useLibraryStore.getState().applyLibraryDefaults({ defaultView: 'grid', defaultSort: 'title_asc' });
    useLibraryStore.getState().setSortBy('recent_read');

    useLibraryStore.getState().resetLibraryView();

    expect(useLibraryStore.getState().sortBy).toBe('title_asc');
    expect(useLibraryStore.getState().activeSection).toBe('all');
  });
});
