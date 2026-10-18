// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LibrarySidebar } from '../../src/renderer/components/LibrarySidebar';
import { ReaderHeaderToolbar } from '../../src/renderer/features/reader/components/ReaderHeaderToolbar';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import type { DocumentMetadata } from '@shared/types/document';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';

/**
 * Emoji glyphs render in the font's own colours and shapes, so they ignore the
 * theme and drift between platforms. These assertions pin the replacement: the
 * rail and toolbar render named icons, and no icon adds a second announcement
 * to a control that is already named. The source-wide emoji scan and the
 * `currentColor` contract live in renderer-icon-sweep.spec.tsx.
 */

const document1: DocumentMetadata = {
  id: 'doc-icons-1',
  title: 'Icon Fixture',
  author: 'Author',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1024,
  fileMtimeMs: 1,
  fileHash: 'hash-icons',
  pageCount: 12,
  folderId: null,
  storageHealth: 'missing',
  storageHealthMessage: 'File not found',
  readingPosition: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: null,
};

function seedLibrary(): void {
  useLibraryStore.setState({
    activeSection: 'all',
    selectedFolderId: null,
    documents: [document1],
    folders: [],
    folderTree: [],
    summary: {
      totalDocuments: 1,
      formatCounts: { pdf: 1, epub: 0, mobi: 0, docx: 0, pptx: 0, markdown: 0 },
      managedCount: 1,
      linkCount: 0,
      // Both footer warnings render, so both replaced ⚠️ sites are covered.
      missingCount: 1,
      changedCount: 1,
      totalFolders: 0,
    },
    isLoading: false,
    isImporting: false,
    errorMessage: null,
    successMessage: null,
  });
}

function seedReader(): void {
  useReaderStore.setState({
    session: testReaderSession({ ...document1, format: 'markdown', storageHealth: 'ok' }, { adapter: testDocumentAdapter('markdown', {
      getCurrentPage: () => 1,
      getReadingLocation: () => ({ location: { format: 'markdown' as const, blockIndex: 0 }, progress: 0 }),
    }) }),
    currentPage: 1,
    pageCount: 3,
    zoom: 1,
    zoomMode: 'fit-width',
    reflowLineHeight: 1.65,
    reflowHorizontalMarginRem: 2.5,
    // A non-empty outline is what renders the Outline control at all.
    tableOfContents: [{ id: 'toc-1', title: 'Chapter 1', level: 1, location: { format: 'markdown', blockIndex: 0 }, children: [] }],
    isLoading: false,
    error: null,
  });
}

/** Every `svg` an `AppIcon` rendered inside `root`. */
function appIcons(root: HTMLElement): SVGElement[] {
  return [...root.querySelectorAll<SVGElement>('svg[data-icon]')];
}

describe('interface glyphs are themed icons, not emoji', () => {
  beforeEach(() => {
    cleanup();
    stubBridge({
      library: { listDocuments: vi.fn(() => Promise.resolve([])) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('the library rail renders semantic icons in place of its emoji', () => {
    seedLibrary();
    const { container } = render(<LibrarySidebar />);

    // One icon per navigation entry, plus one per storage-health warning.
    const names = appIcons(container).map((icon) => icon.getAttribute('data-icon'));
    expect(names).toEqual(
      expect.arrayContaining([
        'library-all',
        'library-continue-reading',
        'library-recently-added',
        'library-recently-read',
        'warning',
      ])
    );

    // The entries keep their own names: the icon must not be announced twice.
    for (const testId of ['nav-all-documents', 'nav-continue-reading', 'nav-recently-added', 'nav-recently-read']) {
      const entry = screen.getByTestId(testId);
      expect(entry.textContent).not.toBe('');
      for (const icon of appIcons(entry)) {
        expect(icon).toHaveAttribute('aria-hidden', 'true');
      }
    }
  });

  test('the reader toolbar renders semantic icons and keeps its accessible names', () => {
    seedReader();
    const { container } = render(<ReaderHeaderToolbar hidden={false} />);

    const names = appIcons(container).map((icon) => icon.getAttribute('data-icon'));
    expect(names).toEqual(
      expect.arrayContaining(['outline', 'display-settings', 'bookmark', 'add-note', 'focus-mode'])
    );

    // Every action is reachable by name, and the two labels that used to carry
    // a glyph inside the accessible name are now clean action names: a screen
    // reader announces "Display settings", not "gear Display settings".
    expect(screen.getByRole('button', { name: 'Toggle table of contents' })).toBe(screen.getByTestId('toggle-toc-button'));
    expect(screen.getByRole('button', { name: 'Display settings' })).toBe(screen.getByTestId('document-settings-button'));
    expect(screen.getByRole('button', { name: 'Add Bookmark' })).toBe(screen.getByTestId('add-bookmark-button'));
    expect(screen.getByRole('button', { name: 'Enter distraction-free focus mode' })).toBe(screen.getByTestId('reader-focus-button'));
    expect(screen.getByRole('button', { name: 'Add note' })).toBeTruthy();

    for (const icon of appIcons(container)) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }

    // No accessible name in the toolbar still spells an icon out as a symbol.
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-label') ?? button.textContent).not.toMatch(/[⚙＋]/u);
    }
  });
});
