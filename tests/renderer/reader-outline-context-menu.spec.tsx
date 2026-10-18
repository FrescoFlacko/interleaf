// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { DocumentMetadata, TableOfContentsItem } from '@shared/types/document';
import { ReaderOutlineSidebar } from '../../src/renderer/features/reader/components/ReaderOutlineSidebar';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useAgentStore } from '../../src/renderer/stores/use-agent-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { testDocumentAdapter } from '../helpers/document-adapter';
import { testReaderSession } from '../helpers/reader-session';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const documentFixture: DocumentMetadata = {
  id: 'toc-menu-document',
  title: 'TOC menu test',
  author: null,
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 1,
  fileMtimeMs: 1,
  fileHash: 'toc-menu-hash',
  pageCount: 12,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  source: null,
};

const outline: readonly TableOfContentsItem[] = [
  { id: 'chapter-1', title: 'Chapter 1', level: 0, location: { format: 'pdf', pageIndex: 1 }, children: [] },
  { id: 'chapter-2', title: 'Chapter 2', level: 0, location: { format: 'pdf', pageIndex: 5 }, children: [] },
];

afterEach(() => {
  cleanup();
  useReaderStore.setState({ session: null, tableOfContents: [], isTocOpen: false, pageCount: 0, currentPage: 1 });
  chat.setState({ error: null, addPageRange: vi.fn(() => Promise.resolve(true)) });
  useAgentStore.setState({ error: null, contextPacket: null, pendingContext: null, attachPageRange: vi.fn(() => Promise.resolve(true)) });
  useUiStore.setState({ showRightTab: useUiStore.getInitialState().showRightTab });
});

describe('Reader TOC context menu', () => {
  test('opens from a row right click, dispatches the exact inclusive range to Chat, and closes', async () => {
    const addPageRange = vi.fn(() => Promise.resolve(true));
    const showRightTab = vi.fn();
    useReaderStore.setState({ session: testReaderSession(documentFixture), tableOfContents: outline, isTocOpen: true, pageCount: 12 });
    chat.setState({ addPageRange });
    useUiStore.setState({ showRightTab });

    renderWithChatStore(chat, <ReaderOutlineSidebar />);
    const row = screen.getByTestId('toc-item-chapter-1');
    fireEvent.contextMenu(row, { clientX: 300, clientY: 200 });
    expect(screen.getByRole('menu', { name: 'Actions for Chapter 1' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Add section to AI Chat' })).toBeTruthy();
    expect(screen.getByRole('menu').parentElement).toBe(document.body);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add section to AI Chat' }));
    await waitFor(() => { expect(addPageRange).toHaveBeenCalledWith(documentFixture, 2, 5); });
    expect(showRightTab).toHaveBeenCalledWith('chat');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('opens through the keyboard equivalent, returns focus, and dispatches Agent range', async () => {
    const attachPageRange = vi.fn(() => Promise.resolve(true));
    const showRightTab = vi.fn();
    useReaderStore.setState({ session: testReaderSession(documentFixture), tableOfContents: outline, isTocOpen: true, pageCount: 12 });
    useAgentStore.setState({ attachPageRange });
    useUiStore.setState({ showRightTab });

    renderWithChatStore(chat, <ReaderOutlineSidebar />);
    const row = screen.getByTestId('toc-item-chapter-2');
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add section to Agent' }));
    await waitFor(() => { expect(attachPageRange).toHaveBeenCalledWith(documentFixture, 6, 12, undefined, expect.objectContaining({ onFailure: expect.any(Function) })); });
    expect(showRightTab).toHaveBeenCalledWith('agent');
    await waitFor(() => { expect(document.activeElement).toBe(row); });
  });

  test('closes on Escape and on outline close', () => {
    useReaderStore.setState({ session: testReaderSession(documentFixture), tableOfContents: outline, isTocOpen: true, pageCount: 12 });
    renderWithChatStore(chat, <ReaderOutlineSidebar />);
    const row = screen.getByTestId('toc-item-chapter-1');
    fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByTestId('close-toc-button'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('switches to the requested composer and exposes a safe error when attachment is unavailable', async () => {
    const showRightTab = vi.fn();
    useReaderStore.setState({ session: testReaderSession(documentFixture), tableOfContents: outline, isTocOpen: true, pageCount: 12 });
    chat.setState({ addPageRange: vi.fn(() => Promise.resolve(false)), error: null });
    useUiStore.setState({ showRightTab });

    renderWithChatStore(chat, <ReaderOutlineSidebar />);
    fireEvent.contextMenu(screen.getByTestId('toc-item-chapter-1'), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add section to AI Chat' }));
    await waitFor(() => {
      expect(showRightTab).toHaveBeenCalledWith('chat');
      expect(chat.getState().error).toBe('Could not attach this outline section.');
    });
  });

  test('passes native Markdown block bounds to Chat instead of fabricating PDF pages', async () => {
    const markdownDocument: DocumentMetadata = { ...documentFixture, id: 'toc-markdown', fileHash: 'toc-markdown-hash', format: 'markdown', pageCount: null };
    const addSelectionContext = vi.fn(() => Promise.resolve(true));
    const showRightTab = vi.fn();
    useReaderStore.setState({
      session: testReaderSession(markdownDocument, { adapter: testDocumentAdapter('markdown', {
        extractText: async function* () {
          await Promise.resolve();
          yield { id: 'b2', documentId: markdownDocument.id, ordinal: 2, text: 'Introduction text', tokenCount: 2, location: { format: 'markdown', blockIndex: 2 }, heading: 'Introduction', pageLabel: null };
          yield { id: 'b3', documentId: markdownDocument.id, ordinal: 3, text: 'More introduction', tokenCount: 2, location: { format: 'markdown', blockIndex: 3 }, heading: null, pageLabel: null };
          yield { id: 'b5', documentId: markdownDocument.id, ordinal: 5, text: 'Next text', tokenCount: 2, location: { format: 'markdown', blockIndex: 5 }, heading: 'Next', pageLabel: null };
        },
      }) }),
      tableOfContents: [
        { id: 'intro', title: 'Introduction', level: 0, location: { format: 'markdown', blockIndex: 2, headingId: 'intro' }, children: [] },
        { id: 'next', title: 'Next', level: 0, location: { format: 'markdown', blockIndex: 5, headingId: 'next' }, children: [] },
      ],
      isTocOpen: true,
    });
    chat.setState({ addSelectionContext });
    useUiStore.setState({ showRightTab });

    renderWithChatStore(chat, <ReaderOutlineSidebar />);
    fireEvent.contextMenu(screen.getByTestId('toc-item-intro'), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add section to AI Chat' }));
    await waitFor(() => {
      expect(addSelectionContext).toHaveBeenCalledWith(
        markdownDocument,
        expect.objectContaining({ format: 'markdown', startBlockIndex: 2, endBlockIndex: 4 }),
        false,
      );
      expect(showRightTab).toHaveBeenCalledWith('chat');
    });
  });

  test('uses actual extracted EPUB spine hrefs for both descriptor endpoints', async () => {
    const epubDocument: DocumentMetadata = { ...documentFixture, id: 'toc-epub-range', fileHash: 'toc-epub-range-hash', format: 'epub', pageCount: null };
    const addSelectionContext = vi.fn(() => Promise.resolve(true));
    useReaderStore.setState({
      session: testReaderSession(epubDocument, { adapter: testDocumentAdapter('epub', {
        extractText: async function* () {
          await Promise.resolve();
          yield* [0, 1, 2, 3, 4].map((unit) => ({
            id: `epub-${String(unit)}`, documentId: epubDocument.id, ordinal: unit, text: `Spine ${String(unit)}`,
            tokenCount: 2, location: { format: 'epub' as const, cfi: `epubcfi(/6/${String((unit + 1) * 2)})`, spineHref: `OPS/chapter-${String(unit + 1)}.xhtml` },
            heading: null, pageLabel: `Section ${String(unit + 1)}`,
          }));
        },
      }) }),
      tableOfContents: [
        { id: 'chapter-a', title: 'Chapter A', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/2)', spineHref: 'TOC/chapter-a.xhtml' }, children: [] },
        { id: 'chapter-b', title: 'Chapter B', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/8)', spineHref: 'TOC/chapter-b.xhtml' }, children: [] },
      ],
      isTocOpen: true,
    });
    chat.setState({ addSelectionContext });

    renderWithChatStore(chat, <ReaderOutlineSidebar />);
    fireEvent.contextMenu(screen.getByTestId('toc-item-chapter-a'), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add section to AI Chat' }));
    await waitFor(() => {
      expect(addSelectionContext).toHaveBeenCalledWith(
        epubDocument,
        expect.objectContaining({
          format: 'epub', startSpineHref: 'OPS/chapter-1.xhtml', endSpineHref: 'OPS/chapter-3.xhtml', endCfi: 'epubcfi(/6/6)',
        }),
        false,
      );
    });
  });

  test('uses the next top-level heading as a parent section boundary, including descendants', async () => {
    const addPageRange = vi.fn(() => Promise.resolve(true));
    useReaderStore.setState({
      session: testReaderSession(documentFixture),
      tableOfContents: [
        {
          id: 'parent', title: 'Parent', level: 0, location: { format: 'pdf', pageIndex: 0 },
          children: [
            { id: 'child-a', title: 'Child A', level: 1, location: { format: 'pdf', pageIndex: 1 }, children: [] },
            { id: 'child-b', title: 'Child B', level: 1, location: { format: 'pdf', pageIndex: 3 }, children: [] },
          ],
        },
        { id: 'sibling', title: 'Sibling', level: 0, location: { format: 'pdf', pageIndex: 5 }, children: [] },
      ],
      isTocOpen: true,
      pageCount: 12,
    });
    chat.setState({ addPageRange });

    renderWithChatStore(chat, <ReaderOutlineSidebar />);
    fireEvent.contextMenu(screen.getByTestId('toc-item-parent'), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add section to AI Chat' }));
    await waitFor(() => { expect(addPageRange).toHaveBeenCalledWith(documentFixture, 1, 5); });
  });

  test('reports a truthful EPUB error when a TOC target has no safe subsection boundary', async () => {
    const epubDocument: DocumentMetadata = { ...documentFixture, id: 'toc-epub', fileHash: 'toc-epub-hash', format: 'epub', pageCount: null };
    const showRightTab = vi.fn();
    const addSelectionContext = vi.fn(() => Promise.resolve(true));
    useReaderStore.setState({
      session: testReaderSession(epubDocument),
      tableOfContents: [
        { id: 'epub-heading', title: 'Heading', level: 0, location: { format: 'epub', cfi: 'epubcfi(/6/2)', spineHref: 'OPS/chapter.xhtml#heading' }, children: [] },
      ],
      isTocOpen: true,
    });
    chat.setState({ addSelectionContext });
    useUiStore.setState({ showRightTab });

    renderWithChatStore(chat, <ReaderOutlineSidebar />);
    fireEvent.contextMenu(screen.getByTestId('toc-item-epub-heading'), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add section to AI Chat' }));
    await waitFor(() => {
      expect(chat.getState().error).toBe('This EPUB outline entry does not expose a safe subsection boundary.');
      expect(showRightTab).toHaveBeenCalledWith('chat');
      expect(addSelectionContext).not.toHaveBeenCalled();
    });
  });

  describe('an Agent section that finishes after the reader moved on', () => {
    const markdownBook: DocumentMetadata = { ...documentFixture, id: 'toc-markdown-a', fileHash: 'toc-markdown-a-hash', format: 'markdown', pageCount: null };
    const sectionOutline: readonly TableOfContentsItem[] = [
      { id: 'section', title: 'Section', level: 0, location: { format: 'markdown', blockIndex: 0 }, children: [] },
    ];

    const succeed = (): void => undefined;
    const fail = (): void => { throw new Error('The old reader failed.'); };

    /** Opens the book with section text held back until `release`, and asks for it from the outline. */
    function addHeldSection(afterRelease: () => void): { readonly release: () => void } {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const adapter = testDocumentAdapter('markdown', {
        extractText: async function* () {
          await held;
          afterRelease();
          yield { id: 'block-0', documentId: markdownBook.id, ordinal: 0, text: 'Section text', tokenCount: 1, location: { format: 'markdown' as const, blockIndex: 0 }, heading: null, pageLabel: null };
        },
      });
      useReaderStore.setState({ session: testReaderSession(markdownBook, { adapter }), tableOfContents: sectionOutline, isTocOpen: true });
      renderWithChatStore(chat, <ReaderOutlineSidebar />);
      fireEvent.contextMenu(screen.getByTestId('toc-item-section'), { clientX: 300, clientY: 200 });
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add section to Agent' }));
      return { release };
    }

    test.each([
      ['succeeds', succeed],
      ['fails', fail],
    ])('opens no tab and shows no error in the next book when it %s', async (_outcome, afterRelease) => {
      const showRightTab = vi.fn();
      useUiStore.setState({ showRightTab });
      const { release } = addHeldSection(afterRelease);

      useReaderStore.setState({ session: testReaderSession({ ...markdownBook, id: 'toc-markdown-b' }) });
      release();
      await new Promise((resolve) => { setTimeout(resolve, 30); });

      expect(useAgentStore.getState().error).toBeNull();
      expect(useAgentStore.getState().contextPacket).toBeNull();
      expect(showRightTab).not.toHaveBeenCalled();
    });

    test('still explains a failure in the book it came from', async () => {
      const showRightTab = vi.fn();
      useUiStore.setState({ showRightTab });
      const { release } = addHeldSection(fail);

      release();

      await waitFor(() => { expect(useAgentStore.getState().error).toBe('The old reader failed.'); });
      expect(showRightTab).toHaveBeenCalledWith('agent');
    });

    test('attaches the section, named by its blocks, in the book it came from', async () => {
      const showRightTab = vi.fn();
      useUiStore.setState({ showRightTab });
      const { release } = addHeldSection(succeed);

      release();

      await waitFor(() => { expect(showRightTab).toHaveBeenCalledWith('agent'); });
      expect(useAgentStore.getState().contextPacket?.selection.exactQuote).toBe('Section text');
      expect(useAgentStore.getState().contextPacket?.scopeLabel).toBe('Block 1');
    });
  });
});
