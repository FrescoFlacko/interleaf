// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HIGHLIGHT_COLOR_CONFIGS } from '@shared/constants/annotations';
import type { Annotation } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { AnnotationBrowser } from '../../src/renderer/features/annotations/AnnotationBrowser';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession, seatReaderAdapter } from '../helpers/reader-session';
import { testLoadedAnnotations } from '../helpers/annotation';
import { chooseValue } from '../helpers/listbox-select';

/**
 * Reference design 4a for the Annotations tab. These assertions hold the parts
 * of the design that carry meaning rather than the parts that are only taste:
 * what a reader's eye reaches first in each row, which colour a row shows, and
 * which single state is worth interrupting them about.
 */

const now = '2026-09-06T00:00:00.000Z';

const documentRecord: DocumentMetadata = {
  id: 'doc-1',
  title: 'Annotated Book',
  author: 'Reader',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 100,
  fileMtimeMs: 1,
  fileHash: 'hash-v1',
  pageCount: 40,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: now,
  updatedAt: now,
  source: null,
};

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    documentHash: 'hash-v1',
    type: 'highlight',
    anchor: {
      format: 'pdf',
      pageIndex: 28,
      pageLabel: '29',
      quote: { exact: 'selected quote', prefix: '', suffix: '' },
    },
    selectedText: 'selected quote',
    note: null,
    label: null,
    color: 'yellow',
    isLocationNote: false,
    status: 'anchored',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const notedHighlight = annotation({
  id: 'ann-noted',
  note: 'The author concedes the point here.',
  color: 'blue',
});

const plainHighlight = annotation({ id: 'ann-plain', color: 'green' });

describe('annotations panel — reference design 4a', () => {
  const page = vi.fn();
  const update = vi.fn();

  beforeEach(() => {
    cleanup();
    const api = testInterleafApi({
      annotations: { list: vi.fn(() => Promise.resolve([])), page, update },
    });
    stubBridge(api);
    useAnnotationStore.getState().reset();
    useAnnotationStore.setState({ loaded: testLoadedAnnotations('doc-1') });
    useReaderStore.setState({ session: testReaderSession(documentRecord), currentPage: 29 });
    page.mockResolvedValue({ items: [notedHighlight, plainHighlight], total: 2, offset: 0, limit: 50 });
    update.mockResolvedValue(notedHighlight);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function renderBrowser(): Promise<void> {
    render(<AnnotationBrowser />);
    await screen.findAllByTestId('annotation-row');
  }

  it('heads the panel with a title, a compact count of the open document, and an inset search', async () => {
    await renderBrowser();

    expect(screen.getByRole('heading', { name: 'Annotations', level: 2 })).toBeInTheDocument();

    // The count is scale, not decoration: it names the real total and the
    // document it belongs to, so a filtered view can never read as the whole.
    expect(screen.getByTestId('annotation-count-label')).toHaveTextContent('2 in this document');

    const search = screen.getByLabelText('Search annotations');
    // The magnifier is the shared HugeIcons wrapper, not a typographic glyph.
    const searchRow = search.parentElement;
    expect(searchRow?.querySelector('svg[data-icon="search"]')).not.toBeNull();
  });

  it('offers one row of filter chips with live counts and a compact sort', async () => {
    page.mockImplementation((_id: string, filter?: { type?: string; limit?: number }) => {
      if (filter?.limit === 1) {
        const totals: Record<string, number> = { highlight: 2, note: 3, bookmark: 1 };
        return Promise.resolve({ items: [], total: totals[filter.type ?? ''] ?? 0, offset: 0, limit: 1 });
      }
      return Promise.resolve({ items: [notedHighlight, plainHighlight], total: 2, offset: 0, limit: 50 });
    });
    await renderBrowser();

    const chips = screen.getByTestId('annotation-filter-chips');
    await waitFor(() => { expect(within(chips).getByRole('button', { name: /^All/u })).toHaveTextContent('6'); });
    expect(within(chips).getByRole('button', { name: /^Highlights/u })).toHaveTextContent('2');
    expect(within(chips).getByRole('button', { name: /^Notes/u })).toHaveTextContent('3');

    // Chips are a pressed-state control set, so the active filter is announced
    // rather than only drawn.
    const highlights = within(chips).getByRole('button', { name: /^Highlights/u });
    expect(screen.getByRole('button', { name: /^All/u })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(highlights);
    expect(highlights).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(page).toHaveBeenCalledWith('doc-1', expect.objectContaining({ type: 'highlight', limit: 50 }));
    });

    chooseValue(screen.getByLabelText('Sort annotations'), 'created_asc');
    await waitFor(() => {
      expect(page).toHaveBeenCalledWith('doc-1', expect.objectContaining({ sort: 'created_asc', limit: 50 }));
    });
  });

  it('leads each row with the reader’s own note and demotes the quote beneath it', async () => {
    await renderBrowser();
    const row = screen.getAllByTestId('annotation-row')[0]!;

    const body = within(row).getByTestId('annotation-note-body');
    const quote = within(row).getByTestId('annotation-quote');
    expect(body).toHaveTextContent('The author concedes the point here.');
    // The reader's words come first in DOM and reading order; the passage they
    // were written against supports them.
    expect(body.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quote.tagName).toBe('BLOCKQUOTE');
  });

  it('carries the annotation’s real marker colour on the rail and the quote', async () => {
    await renderBrowser();
    const [noted, plain] = screen.getAllByTestId('annotation-row');

    // Not a generic accent: the rail and the marker show the colour the reader
    // actually chose, so scanning by colour matches the page.
    expect(within(noted!).getByTestId('annotation-rail')).toHaveStyle({
      background: HIGHLIGHT_COLOR_CONFIGS.blue.hexValue,
    });
    expect(within(plain!).getByTestId('annotation-quote-marker')).toHaveStyle({
      background: HIGHLIGHT_COLOR_CONFIGS.green.cssRgba,
    });

    // A highlight with no note yet shows its quote at full strength — that
    // quote is the annotation — and offers the note that is missing.
    expect(within(plain!).queryByTestId('annotation-note-body')).toBeNull();
    expect(within(plain!).getByRole('button', { name: 'Add note' })).toBeInTheDocument();
    expect(within(noted!).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('states type and location in plain words and never labels a working anchor', async () => {
    await renderBrowser();
    const row = screen.getAllByTestId('annotation-row')[0]!;

    expect(within(row).getByTestId('annotation-meta-type')).toHaveTextContent('Highlight');
    expect(within(row).getByTestId('annotation-meta-location')).toHaveTextContent('Page 29');

    // The 4a design drops the Anchored badge entirely: an intact anchor is the
    // expectation and says nothing.
    expect(screen.queryByText('Anchored')).toBeNull();
    expect(screen.queryByText('Unanchored · note preserved')).toBeNull();
    expect(screen.queryByTestId('annotation-unanchored-warning')).toBeNull();

    // A markdown anchor is located by block, in the same plain words.
    cleanup();
    page.mockResolvedValue({
      items: [annotation({
        id: 'ann-md',
        anchor: { format: 'markdown', quote: { exact: 'x', prefix: '', suffix: '' }, blockIndex: 1 },
      })],
      total: 1,
      offset: 0,
      limit: 50,
    });
    await renderBrowser();
    expect(screen.getByTestId('annotation-meta-location')).toHaveTextContent('Block 2');
    for (const testId of ['annotation-meta-type', 'annotation-meta-location']) {
      expect(screen.getByTestId(testId).className).not.toMatch(/uppercase|font-mono/u);
    }
  });

  it('warns only for a lost anchor and routes re-attachment through the reader', async () => {
    const goToAnnotation = vi.fn(() => Promise.resolve());
    seatReaderAdapter(testDocumentAdapter('pdf', { goToAnnotation }));
    const moved = annotation({ id: 'ann-moved', status: 'unanchored', note: 'Still readable.' });
    page.mockResolvedValue({ items: [moved], total: 1, offset: 0, limit: 50 });
    await renderBrowser();

    const row = screen.getByTestId('annotation-row');
    // The warning names the thing that actually moved. `moved` is a highlight
    // carrying a note, and it is the highlight that lost its anchor.
    expect(within(row).getByTestId('annotation-unanchored-warning')).toHaveTextContent(
      'Text moved — this highlight lost its place in the page'
    );
    // The note itself survives the lost anchor and stays readable and editable.
    expect(within(row).getByTestId('annotation-note-body')).toHaveTextContent('Still readable.');
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    // Jumping to a place the annotation no longer has would be a false claim,
    // so the route offered is re-attachment instead.
    expect(within(row).queryByRole('button', { name: 'Jump' })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: /^Re-attach/u }));
    await waitFor(() => { expect(goToAnnotation).toHaveBeenCalledWith(moved); });
    // The panel claims only what it did — opening the location — not that the
    // anchor was repaired.
    expect(await screen.findByTestId('annotation-reattach-notice')).toHaveTextContent('Opened the recorded location');
  });

  it('names the kind of annotation that lost its place, not always a note', async () => {
    // A reader with a mixed panel has to be able to tell which of their marks
    // came adrift. Calling a bookmark "this note" describes something they
    // never made.
    const cases: readonly (readonly [Partial<Annotation>, string])[] = [
      [{ type: 'highlight' }, 'this highlight lost its place'],
      [{ type: 'note', isLocationNote: true }, 'this note lost its place'],
    ];

    for (const [overrides, expected] of cases) {
      cleanup();
      page.mockResolvedValue({
        items: [annotation({ id: 'ann-moved', status: 'unanchored', ...overrides })],
        total: 1,
        offset: 0,
        limit: 50,
      });
      await renderBrowser();
      expect(screen.getByTestId('annotation-unanchored-warning')).toHaveTextContent(expected);
    }
  });

  it('sends a bookmark to its page instead of offering re-attachment', async () => {
    // A bookmark names a page, not a passage. Its empty quote cannot resolve
    // against the page text, which must not read as a mark that lost its place.
    const goToAnnotation = vi.fn(() => Promise.resolve());
    seatReaderAdapter(testDocumentAdapter('pdf', { goToAnnotation }));
    const bookmark = annotation({ id: 'ann-bookmark', type: 'bookmark', status: 'unanchored', note: null });
    page.mockResolvedValue({ items: [bookmark], total: 1, offset: 0, limit: 50 });
    await renderBrowser();

    const row = screen.getByTestId('annotation-row');
    expect(within(row).queryByTestId('annotation-unanchored-warning')).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Re-attach/u })).toBeNull();
    const go = within(row).getByRole('button', { name: 'Go to Page 29' });
    expect(go).toHaveTextContent('Go to page');
    fireEvent.click(go);
    await waitFor(() => { expect(goToAnnotation).toHaveBeenCalledWith(bookmark); });
  });

  it('names each colour swatch by its own colour and the row it belongs to', async () => {
    await renderBrowser();
    const row = screen.getAllByTestId('annotation-row')[0]!;

    const yellow = within(row).getByRole('button', { name: 'Yellow highlight for Page 29' });
    expect(within(row).getByRole('button', { name: 'Blue highlight for Page 29' })).toHaveAttribute('aria-pressed', 'true');
    expect(yellow).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(yellow);
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'ann-noted', color: 'yellow' });
    });
  });

  it('keeps the overflow menu operable and returning focus from the keyboard', async () => {
    await renderBrowser();
    const trigger = screen.getAllByTestId('annotation-row-menu')[0]!;
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Delete' }));

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(trigger);
  });

  it('passes a WCAG audit in its redesigned form, including a lost-anchor row, with keyboard-reachable controls', async () => {
    page.mockResolvedValue({
      items: [notedHighlight, plainHighlight, annotation({ id: 'ann-moved', status: 'unanchored', note: 'Moved.' })],
      total: 3,
      offset: 0,
      limit: 50,
    });
    const { container } = render(<AnnotationBrowser />);
    await screen.findAllByTestId('annotation-row');

    // Defect 20 keyboard equivalence: the non-modal note popover leaves the
    // sidebar as the keyboard browse/edit route, so the saved note is listed as
    // plain text and every control is natively focusable with no positive
    // tabindex. Real Tab traversal and key activation need a browser.
    expect(screen.getByRole('list', { name: 'Saved annotations' })).toHaveTextContent('The author concedes the point here.');
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')
    ).filter((el) => el.getAttribute('tabindex') !== '-1');
    expect(focusables.length).toBeGreaterThan(0);
    for (const el of focusables) {
      expect(Number.parseInt(el.getAttribute('tabindex') ?? '0', 10)).not.toBeGreaterThan(0);
    }

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
