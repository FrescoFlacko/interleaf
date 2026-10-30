// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentContextPacket } from '@shared/types/agent';
import type { DocumentMetadata, NormalizedTextChunk } from '@shared/types/document';
import { AGENT_MAX_CONTEXT_TEXT_LENGTH } from '@shared/schemas/agent';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { stubBridge } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';

/**
 * Agent context is captured from the open book. These cases pin what a reader
 * is told was attached to what was actually captured, and keep a slow capture
 * from landing after a newer choice or in another book.
 */

function pdf(id: string, pageCount: number): DocumentMetadata {
  return {
    id, title: `Book ${id}`, author: null, format: 'pdf', storageMode: 'managed', fileSize: 1, fileMtimeMs: 1,
    fileHash: `${id}-hash`, pageCount, folderId: null, storageHealth: 'ok', readingPosition: null,
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', source: null,
  };
}

function markdown(id: string): DocumentMetadata {
  return { ...pdf(id, 0), format: 'markdown', pageCount: null };
}

function pageChunk(documentId: string, pageIndex: number, text: string): NormalizedTextChunk {
  return {
    id: `${documentId}-${String(pageIndex)}`, documentId, ordinal: pageIndex, text, tokenCount: 1,
    location: { format: 'pdf', pageIndex }, heading: null, pageLabel: String(pageIndex + 1),
  };
}

function blockChunk(documentId: string, blockIndex: number, text: string): NormalizedTextChunk {
  return {
    id: `${documentId}-${String(blockIndex)}`, documentId, ordinal: blockIndex, text, tokenCount: 1,
    location: { format: 'markdown', blockIndex }, heading: null, pageLabel: null,
  };
}

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** A PDF whose page text is released only when the test opens the gate. */
function gatedPdf(document: DocumentMetadata, text: string, held: Promise<void>): void {
  const adapter = testDocumentAdapter('pdf', {
    extractText: async function* () {
      await held;
      for (let index = 0; index < (document.pageCount ?? 0); index += 1) yield pageChunk(document.id, index, `${text} ${String(index + 1)}`);
    },
  });
  useReaderStore.setState({ session: testReaderSession(document, { adapter }) });
}

function packetFor(document: DocumentMetadata, quote: string): AgentContextPacket {
  return {
    version: 1,
    document: { id: document.id, hash: document.fileHash, title: document.title, author: null },
    selection: {
      exactQuote: quote,
      anchor: { format: 'pdf', quote: { exact: quote, prefix: '', suffix: '' }, pageIndex: 0 },
      location: { format: 'pdf', pageIndex: 0 },
      surroundingText: null,
    },
    provenance: { source: 'interleaf-reader-selection', capturedAt: '2026-10-13T00:00:00.000Z', contentIsUntrustedReference: true, truncated: false },
  };
}

afterEach(() => {
  useReaderStore.setState({ session: null });
  useAgentStore.setState({ contextPacket: null, error: null, documentId: null, activeSession: null, sessions: [], events: [], loading: false });
});

describe('Agent book context: stale captures', () => {
  it('does not land a page range from the previous book after the reader switches books', async () => {
    const bookA = pdf('book-a', 4);
    const bookB = pdf('book-b', 4);
    const held = gate();
    gatedPdf(bookA, 'Book A page', held.promise);

    const attaching = useAgentStore.getState().attachPageRange(bookA, 1, 2);
    useReaderStore.setState({ session: testReaderSession(bookB) });
    held.open();

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBeNull();
    expect(useAgentStore.getState().error).toBeNull();
  });

  it('keeps Remove authoritative over a whole-book capture that was still extracting', async () => {
    const book = pdf('book-remove', 3);
    const held = gate();
    gatedPdf(book, 'Text', held.promise);

    const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 });
    useAgentStore.getState().clearContextPacket();
    held.open();

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBeNull();
  });

  it('treats clearing the selection as the same explicit choice as Remove', async () => {
    const book = pdf('book-clear-selection', 3);
    const held = gate();
    gatedPdf(book, 'Text', held.promise);

    const attaching = useAgentStore.getState().attachPageRange(book, 1, 2);
    expect(useAgentStore.getState().pendingContext).not.toBeNull();
    useAgentStore.getState().clearSelection();
    expect(useAgentStore.getState().pendingContext).toBeNull();
    held.open();

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBeNull();
  });

  it('lets a newer selection win over an older page capture that settles later', async () => {
    const book = pdf('book-newer', 3);
    const held = gate();
    gatedPdf(book, 'Old page', held.promise);

    const attaching = useAgentStore.getState().attachPageRange(book, 1, 1);
    useAgentStore.getState().setSelection(
      book,
      { format: 'pdf', quote: { exact: 'Newer selection', prefix: '', suffix: '' }, pageIndex: 2 },
      'Newer selection',
    );
    held.open();
    await attaching;

    expect(useAgentStore.getState().contextPacket?.selection.exactQuote).toBe('Newer selection');
  });

  it('drops a closed book\'s context before the next book is opened', async () => {
    const bookA = pdf('book-closed', 2);
    useAgentStore.setState({ documentId: bookA.id, contextPacket: packetFor(bookA, 'A text') });
    stubBridge({
      agent: {
        listProfiles: () => Promise.resolve([]),
        listSessions: () => Promise.resolve([]),
        listWorkingDirectories: () => Promise.resolve([]),
        getModeAvailability: () => Promise.resolve([]),
        onEvent: () => () => undefined,
      },
    });

    await useAgentStore.getState().hydrate(null);
    await useAgentStore.getState().hydrate('book-next');

    expect(useAgentStore.getState().contextPacket).toBeNull();
  });
});

describe('Agent book context: what is attached is real text', () => {
  it('fails clearly when the requested pages have no readable text and keeps the prior attachment', async () => {
    const book = pdf('book-scanned', 5);
    const adapter = testDocumentAdapter('pdf', {
      extractText: async function* () { await Promise.resolve(); yield pageChunk(book.id, 4, 'Only the last page has text'); },
    });
    useReaderStore.setState({ session: testReaderSession(book, { adapter }) });
    const prior = packetFor(book, 'Prior selection');
    useAgentStore.setState({ contextPacket: prior });

    await expect(useAgentStore.getState().attachPageRange(book, 1, 2)).resolves.toBe(false);

    expect(useAgentStore.getState().contextPacket).toBe(prior);
    expect(useAgentStore.getState().error).toMatch(/no readable text/iu);
  });

  it('never attaches the document title in place of whole-book text', async () => {
    const book = markdown('book-empty');
    const adapter = testDocumentAdapter('markdown', {
      extractText: async function* () { await Promise.resolve(); yield blockChunk(book.id, 0, '   '); },
    });
    useReaderStore.setState({ session: testReaderSession(book, { adapter }) });

    await expect(useAgentStore.getState().attachEntireDocument(book, { format: 'markdown', blockIndex: 0 })).resolves.toBe(false);

    expect(useAgentStore.getState().contextPacket).toBeNull();
    expect(useAgentStore.getState().error).toMatch(/no readable text/iu);
  });

  it('keeps a valid attachment when a whole-book capture fails', async () => {
    const book = markdown('book-throws');
    const adapter = testDocumentAdapter('markdown', {
      extractText: async function* () { await Promise.resolve(); yield* []; throw new Error('Extraction failed.'); },
    });
    useReaderStore.setState({ session: testReaderSession(book, { adapter }) });
    const prior = packetFor(pdf('other', 1), 'Kept');
    useAgentStore.setState({ contextPacket: prior });

    await expect(useAgentStore.getState().attachEntireDocument(book, { format: 'markdown', blockIndex: 0 })).resolves.toBe(false);

    expect(useAgentStore.getState().contextPacket).toBe(prior);
    expect(useAgentStore.getState().error).toBe('Extraction failed.');
  });

  it('never attaches a section label in place of empty section text', async () => {
    const book = markdown('book-section');
    useReaderStore.setState({ session: testReaderSession(book) });
    await expect(useAgentStore.getState().attachSectionContext(book, { format: 'markdown', blockIndex: 3 }, 'Blocks 4–6', '')).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBeNull();
    expect(useAgentStore.getState().error).toMatch(/no readable text/iu);
  });

  it('carries truncation reported by the section extractor into the packet', async () => {
    const book = markdown('book-section-truncated');
    useReaderStore.setState({ session: testReaderSession(book) });
    await expect(useAgentStore.getState().attachSectionContext(book, { format: 'markdown', blockIndex: 0 }, 'Blocks 1–9', 'Short prefix', true)).resolves.toBe(true);
    expect(useAgentStore.getState().contextPacket?.provenance.truncated).toBe(true);
  });
});

describe('Agent book context: page-range bounds', () => {
  it.each([
    { name: 'a fractional start', start: 1.5, end: 2 },
    { name: 'a zero start', start: 0, end: 2 },
    { name: 'an end before the start', start: 3, end: 2 },
    { name: 'an end past the last page', start: 1, end: 9 },
    { name: 'more than the maximum range', start: 1, end: 400 },
    { name: 'a non-finite end', start: 1, end: Number.POSITIVE_INFINITY },
  ])('rejects $name in the store without touching the attachment', async ({ start, end }) => {
    const book = pdf('book-bounds', start === 1 && end === 400 ? 1_000 : 5);
    useReaderStore.setState({ session: testReaderSession(book) });
    const prior = packetFor(book, 'Prior');
    useAgentStore.setState({ contextPacket: prior });

    await expect(useAgentStore.getState().attachPageRange(book, start, end, 'Explicit text')).resolves.toBe(false);

    expect(useAgentStore.getState().contextPacket).toBe(prior);
    expect(useAgentStore.getState().error).not.toBeNull();
  });

  it('rejects page ranges for a book that has no pages', async () => {
    const book = markdown('book-no-pages');
    await expect(useAgentStore.getState().attachPageRange(book, 1, 1, 'Text')).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBeNull();
  });
});

describe('Agent book context: bounded extraction', () => {
  it('stops reading the book once the whole-book capture is full and says it was truncated', async () => {
    const book = markdown('book-huge');
    let pulled = 0;
    const adapter = testDocumentAdapter('markdown', {
      extractText: async function* () {
        for (let index = 0; index < 1_000; index += 1) {
          await Promise.resolve();
          pulled += 1;
          yield blockChunk(book.id, index, 'x'.repeat(10_000));
        }
      },
    });
    useReaderStore.setState({ session: testReaderSession(book, { adapter }) });

    await expect(useAgentStore.getState().attachEntireDocument(book, { format: 'markdown', blockIndex: 0 })).resolves.toBe(true);

    expect(useAgentStore.getState().contextPacket?.provenance.truncated).toBe(true);
    expect(pulled).toBeLessThan(Math.ceil(AGENT_MAX_CONTEXT_TEXT_LENGTH / 10_000) + 3);
  });

  it('stops reading pages after the last requested page', async () => {
    const book = pdf('book-pages', 500);
    let pulled = 0;
    const adapter = testDocumentAdapter('pdf', {
      extractText: async function* () {
        for (let index = 0; index < 500; index += 1) {
          await Promise.resolve();
          pulled += 1;
          yield pageChunk(book.id, index, `Page ${String(index + 1)}`);
        }
      },
    });
    useReaderStore.setState({ session: testReaderSession(book, { adapter }) });

    await expect(useAgentStore.getState().attachPageRange(book, 2, 3)).resolves.toBe(true);

    expect(useAgentStore.getState().contextPacket?.selection.exactQuote).toBe('Page 2\n\nPage 3');
    expect(useAgentStore.getState().contextPacket?.provenance.truncated).toBe(false);
    expect(pulled).toBeLessThanOrEqual(4);
  });
});

describe('Agent book context: the latest choice is authoritative at landing', () => {
  it('does not attach text the caller already held for a book the reader has since left', async () => {
    const bookA = markdown('book-explicit-a');
    const bookB = markdown('book-explicit-b');
    useReaderStore.setState({ session: testReaderSession(bookA) });
    useAgentStore.setState({ documentId: bookA.id });

    const attaching = useAgentStore.getState().attachSectionContext(bookA, { format: 'markdown', blockIndex: 0 }, 'Block 1', 'A text');
    useReaderStore.setState({ session: testReaderSession(bookB) });

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBeNull();
  });

  it('does not land after the same book reopens in a new reader', async () => {
    const book = pdf('book-reopened', 2);
    const held = gate();
    gatedPdf(book, 'Old reader', held.promise);

    const attaching = useAgentStore.getState().attachPageRange(book, 1, 1);
    useReaderStore.setState({ session: testReaderSession(book) });
    held.open();

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBeNull();
    expect(useAgentStore.getState().error).toBeNull();
  });

  it('keeps Remove authoritative between a finished capture and its landing', async () => {
    const book = markdown('book-microtask');
    useReaderStore.setState({ session: testReaderSession(book) });

    const attaching = useAgentStore.getState().attachSectionContext(book, { format: 'markdown', blockIndex: 0 }, 'Block 1', 'A text');
    queueMicrotask(() => { useAgentStore.getState().clearContextPacket(); });

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBeNull();
  });

  it('withholds a failure from a capture that Remove superseded', async () => {
    const book = pdf('book-superseded-failure', 2);
    const held = gate();
    gatedPdf(book, '', held.promise);

    const attaching = useAgentStore.getState().attachPageRange(book, 1, 1);
    useAgentStore.getState().clearContextPacket();
    held.open();

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().error).toBeNull();
  });

  it('names the whole document in the packet it produces, through to the run summary', async () => {
    const book = markdown('book-whole');
    useReaderStore.setState({ session: testReaderSession(book) });

    await expect(useAgentStore.getState().attachEntireDocument(book, { format: 'markdown', blockIndex: 0 }, 'Whole text')).resolves.toBe(true);

    expect(useAgentStore.getState().contextPacket?.scopeLabel).toBe('Entire document');
  });
});

describe('Agent book context: a capture in progress is shown and can be withdrawn', () => {
  it('shows what is being attached until it lands', async () => {
    const book = pdf('book-pending', 3);
    const held = gate();
    gatedPdf(book, 'Text', held.promise);

    const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 });
    expect(useAgentStore.getState().pendingContext?.label).toBe('Entire document');
    held.open();

    await expect(attaching).resolves.toBe(true);
    expect(useAgentStore.getState().pendingContext).toBeNull();
  });

  it('cancels only the capture in progress and keeps the prior attachment', async () => {
    const book = pdf('book-cancel', 3);
    const prior = packetFor(book, 'Prior');
    useAgentStore.setState({ contextPacket: prior });
    const held = gate();
    gatedPdf(book, 'Text', held.promise);

    const attaching = useAgentStore.getState().attachEntireDocument(book, { format: 'pdf', pageIndex: 0 });
    useAgentStore.getState().cancelContextCapture();
    held.open();

    await expect(attaching).resolves.toBe(false);
    expect(useAgentStore.getState().pendingContext).toBeNull();
    expect(useAgentStore.getState().contextPacket).toBe(prior);
    expect(useAgentStore.getState().error).toBeNull();
  });

  it('withdraws through its own signal without undoing a newer choice', async () => {
    const book = pdf('book-signal', 3);
    const held = gate();
    gatedPdf(book, 'Text', held.promise);
    const older = new AbortController();

    const first = useAgentStore.getState().attachPageRange(book, 1, 1, undefined, { signal: older.signal });
    const second = useAgentStore.getState().attachPageRange(book, 2, 2);
    older.abort();
    expect(useAgentStore.getState().pendingContext?.label).toBe('Page 2');
    held.open();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(useAgentStore.getState().contextPacket?.scopeLabel).toBe('Page 2');
  });

  it('never begins a capture whose signal was already aborted', async () => {
    const book = markdown('book-early-abort');
    useReaderStore.setState({ session: testReaderSession(book) });
    const prior = packetFor(book, 'Prior');
    useAgentStore.setState({ contextPacket: prior });
    const aborted = new AbortController();
    aborted.abort();

    await expect(useAgentStore.getState().attachSectionContext(book, { format: 'markdown', blockIndex: 0 }, 'Block 1', 'Text', false, { signal: aborted.signal })).resolves.toBe(false);
    expect(useAgentStore.getState().contextPacket).toBe(prior);
    expect(useAgentStore.getState().pendingContext).toBeNull();
  });
});
