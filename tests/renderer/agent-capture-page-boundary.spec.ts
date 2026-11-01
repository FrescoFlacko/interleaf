// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentMetadata } from '@shared/types/document';
import { PdfAdapter } from '../../src/renderer/features/reader/adapters/pdf-adapter';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { testReaderSession } from '../helpers/reader-session';

/**
 * A whole-book capture that can no longer land stops reading the PDF at the
 * next page boundary, including inside a long run of pages with no text, which
 * yield nothing a caller could stop on. A pdf.js request already issued is
 * awaited, never claimed to be interrupted; no further page is requested after
 * it. The real `PdfAdapter.extractText` reads a synthetic document whose page
 * requests are counted and whose first text request is held open.
 */

function pdf(id: string, pageCount: number): DocumentMetadata {
  return {
    id, title: `Book ${id}`, author: null, format: 'pdf', storageMode: 'managed', fileSize: 1, fileMtimeMs: 1,
    fileHash: `${id}-hash`, pageCount, folderId: null, storageHealth: 'ok', readingPosition: null,
    createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z', source: null,
  };
}

type Reads = { getPage: number; getTextContent: number };

/**
 * Opens a synthetic PDF in a real adapter: `text(page)` is each page's text
 * ('' for a page with none), page 1's text request waits for `firstPage`, and
 * `onGetPage` runs as each page is requested.
 */
function syntheticPdf(
  book: DocumentMetadata,
  text: (page: number) => string,
  firstPage: Promise<void>,
  failFirst = false,
  onGetPage: (page: number) => void = () => undefined,
) {
  const reads: Reads = { getPage: 0, getTextContent: 0 };
  const proxy = {
    numPages: book.pageCount ?? 0,
    getPage: async (pageNumber: number) => {
      reads.getPage += 1;
      onGetPage(pageNumber);
      await Promise.resolve();
      return {
        getTextContent: async () => {
          reads.getTextContent += 1;
          if (pageNumber === 1) await firstPage;
          if (pageNumber === 1 && failFirst) throw new Error('Synthetic page read failed.');
          const value = text(pageNumber);
          return { items: value.length > 0 ? [{ str: value, hasEOL: false }] : [] };
        },
      };
    },
  };
  const adapter = new PdfAdapter();
  // The adapter's document and page count are set by `open`; a synthetic document is seated the same way.
  Reflect.set(adapter, 'pdfDoc', proxy);
  Reflect.set(adapter, 'pageCount', book.pageCount ?? 0);
  useReaderStore.setState({ session: testReaderSession(book, { adapter }) });
  return reads;
}

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** Lets every queued page request run, so a reader that keeps going shows it. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

const ONLY_LAST_PAGE = (pages: number) => (page: number): string => (page === pages ? `Last page ${String(page)}` : '');

afterEach(() => {
  useReaderStore.setState({ session: null });
  useAgentStore.setState({ contextPacket: null, pendingContext: null, error: null, documentId: null, activeSession: null, sessions: [], events: [], loading: false });
});

describe('Agent whole-book capture: page-boundary cancellation in the PDF reader', () => {
  const withdrawals: readonly (readonly [string, (book: DocumentMetadata) => void])[] = [
    ['Cancel', () => { useAgentStore.getState().cancelContextCapture(); }],
    ['Remove', () => { useAgentStore.getState().clearContextPacket(); }],
    ['a newer choice', (book) => { void useAgentStore.getState().attachSectionContext(book, { format: 'pdf', pageIndex: 0 }, 'Section', 'Chosen text'); }],
  ];

  for (const [name, withdraw] of withdrawals) {
    it(`stops after the outstanding page read when ${name} withdraws it inside a run of blank pages`, async () => {
      const book = pdf(`book-blank-${name}`, 1_000);
      const firstPage = gate();
      const reads = syntheticPdf(book, ONLY_LAST_PAGE(1_000), firstPage.promise);

      const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 });
      await settle();
      expect(reads).toEqual({ getPage: 1, getTextContent: 1 });
      withdraw(book);
      firstPage.open();

      await expect(attaching).resolves.toBe(false);
      await settle();
      // The outstanding request was awaited; no later page was asked for.
      expect(reads).toEqual({ getPage: 1, getTextContent: 1 });
      expect(useAgentStore.getState().error).toBeNull();
      expect(useAgentStore.getState().contextPacket?.selection.exactQuote ?? null).not.toBe('Last page 1000');
    });
  }

  it('stops at the page boundary when its own signal aborts inside a run of blank pages', async () => {
    const book = pdf('book-blank-abort', 1_000);
    const firstPage = gate();
    const reads = syntheticPdf(book, ONLY_LAST_PAGE(1_000), firstPage.promise);
    const controller = new AbortController();

    const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 }, undefined, { signal: controller.signal });
    await settle();
    controller.abort();
    firstPage.open();

    await expect(attaching).resolves.toBe(false);
    await settle();
    expect(reads).toEqual({ getPage: 1, getTextContent: 1 });
    expect(useAgentStore.getState().error).toBeNull();
    expect(useAgentStore.getState().contextPacket).toBeNull();
  });

  it('does not report the read failure of a capture already cancelled', async () => {
    const book = pdf('book-obsolete-failure', 1_000);
    const firstPage = gate();
    const reads = syntheticPdf(book, ONLY_LAST_PAGE(1_000), firstPage.promise, true);
    const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 });
    await settle();
    useAgentStore.getState().cancelContextCapture();
    firstPage.open();

    await expect(attaching).resolves.toBe(false);
    expect(reads).toEqual({ getPage: 1, getTextContent: 1 });
    expect(useAgentStore.getState().error).toBeNull();
    expect(useAgentStore.getState().pendingContext).toBeNull();
  });

  it('stops between pages when withdrawn while a later blank page is being read', async () => {
    const book = pdf('book-blank-later', 1_000);
    const firstPage = gate();
    // Cancelled while page 5's request is in flight: that request settles,
    // and its text is not asked for, nor any later page.
    const reads = syntheticPdf(book, ONLY_LAST_PAGE(1_000), firstPage.promise, false, (page) => {
      if (page === 5) useAgentStore.getState().cancelContextCapture();
    });
    const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 });
    firstPage.open();

    await expect(attaching).resolves.toBe(false);
    await settle();
    expect(reads).toEqual({ getPage: 5, getTextContent: 4 });
  });

  it('a capture that stays chosen still reads every page, in order, skipping blank ones', async () => {
    const book = pdf('book-valid', 6);
    const firstPage = gate();
    const texts: Record<number, string> = { 1: 'Alpha', 3: 'Gamma', 6: 'Zeta' };
    const reads = syntheticPdf(book, (page) => texts[page] ?? '', firstPage.promise);

    const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 });
    await settle();
    firstPage.open();

    await expect(attaching).resolves.toBe(true);
    expect(reads).toEqual({ getPage: 6, getTextContent: 6 });
    const packet = useAgentStore.getState().contextPacket;
    expect(packet?.selection.exactQuote).toBe('Alpha\n\nGamma\n\nZeta');
    expect(packet?.scopeLabel).toBe('Entire document');
    expect(packet?.provenance.truncated).toBe(false);
    expect(packet?.document.id).toBe(book.id);
  });

  it('a read failure of a capture that stays chosen is still reported', async () => {
    const book = pdf('book-valid-failure', 3);
    const firstPage = gate();
    syntheticPdf(book, () => 'Text', firstPage.promise, true);

    const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 });
    firstPage.open();

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().error).toBe('Synthetic page read failed.');
  });
});
