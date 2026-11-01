// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { DocumentDetailsModal } from '../../src/renderer/features/library/components/LibraryModals';
import type { DocumentIndexState } from '@shared/types/search';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * The document details dialog: its action surface, the rows it prints, and
 * the estimated token count it reads from the search index.
 *
 * Read is the only visible command; Move, Remove from folder and Delete live
 * behind one compact overflow menu. The dialog is a reader's summary, so the
 * site name, capture time and content hash stay stored on the document but
 * are not printed.
 */

const ROW_TESTID = 'document-details-estimated-tokens';

function makeDocument(id: string, overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    id,
    title: `Document ${id}`,
    author: 'A. Author',
    format: 'pdf',
    storageMode: 'managed',
    fileSize: 9_999_999,
    fileMtimeMs: 1,
    fileHash: `hash-${id}`,
    pageCount: 20,
    source: null,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

const INDEX_COMMON = {
  documentId: 'doc-a',
  documentHash: 'hash-doc-a',
  totalChunks: 12,
  indexedChunks: 12,
  updatedAt: '2026-09-05T00:00:00.000Z',
};

/** A ready index; the other statuses carry no estimate, so they are constants. */
function indexState(
  overrides: Partial<Pick<DocumentIndexState, 'documentId' | 'documentHash'>> & { readonly estimatedTokens?: number | null } = {}
): DocumentIndexState {
  return { ...INDEX_COMMON, status: 'ready', estimatedTokens: 128_450, errorMessage: null, ...overrides };
}

const INDEXING_STATE: DocumentIndexState = { ...INDEX_COMMON, status: 'indexing', estimatedTokens: null, errorMessage: null };
const FAILED_STATE: DocumentIndexState = { ...INDEX_COMMON, status: 'failed', estimatedTokens: null, errorMessage: 'Extraction failed.' };

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const DOC_A = makeDocument('doc-a');
const DOC_B = makeDocument('doc-b');
const filedPdf = makeDocument('doc-pdf', { folderId: 'folder-1' });

const capturedArticle = makeDocument('doc-web', {
  format: 'markdown',
  fileHash: 'a91f0c3d8b7e5a2419c6d0f38b7e5a2419c6d0f38b7e5a2419c6d0f38b7e5a24',
  source: {
    kind: 'web',
    url: 'https://www.justinmklam.com/posts/2026/02/beginners-guide-split-keyboards/',
    siteName: 'justinmklam.com',
    capturedAt: '2026-09-05T12:00:00.000Z',
  },
});

type Handlers = {
  onClose?: () => void;
  onOpen?: (doc: DocumentMetadata) => void;
  onMove?: (doc: DocumentMetadata, target: HTMLElement | null) => void;
  onRemoveFromFolder?: (doc: DocumentMetadata) => void;
  onDelete?: (doc: DocumentMetadata, target: HTMLElement | null) => void;
};

function renderModal(doc: DocumentMetadata = DOC_A, handlers: Handlers = {}) {
  return render(
    <DocumentDetailsModal
      document={doc}
      onClose={handlers.onClose ?? vi.fn()}
      onOpen={handlers.onOpen ?? vi.fn()}
      onMove={handlers.onMove ?? vi.fn()}
      onRemoveFromFolder={handlers.onRemoveFromFolder ?? vi.fn()}
      onDelete={handlers.onDelete ?? vi.fn()}
    />
  );
}

async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('document-details-actions-trigger'));
  return screen.findByRole('menu', { name: 'Document actions' });
}

function rowValue(): string {
  return screen.getByTestId(ROW_TESTID).textContent;
}

const getIndexState = vi.fn<(documentId: string) => Promise<DocumentIndexState | null>>();

beforeEach(() => {
  vi.clearAllMocks();
  getIndexState.mockReset().mockResolvedValue(indexState());
  stubBridge({ search: { getIndexState } });
});

afterEach(() => {
  cleanup();
});

describe('Document details actions', () => {
  it('offers Read as the only visible command and no redundant footer Close', async () => {
    renderModal(filedPdf);
    const dialog = await screen.findByTestId('document-details-modal');

    expect(screen.getByTestId('open-reader-button')).toBeInTheDocument();
    // The header X remains the close affordance; a second labelled Close button
    // in the footer restated it.
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close document details' })).toBeInTheDocument();

    // Move / Remove from folder / Delete are no longer large peers of Read.
    expect(within(dialog).queryByRole('button', { name: 'Move...' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(dialog).queryByTestId('remove-from-folder-button')).toBeNull();

    const trigger = within(dialog).getByTestId('document-details-actions-trigger');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a labelled keyboard-navigable menu holding the secondary actions', async () => {
    renderModal(filedPdf);
    await screen.findByTestId('document-details-modal');

    const trigger = screen.getByTestId('document-details-actions-trigger');
    const menu = await openMenu();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Move...',
      'Remove from folder',
      'Delete',
    ]);
    await waitFor(() => { expect(document.activeElement).toBe(items[0]); });

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Tab and continues in dialog order, even past the dialog\'s pending initial-focus frame', async () => {
    // The dialog claims initial focus on an animation frame; when the user
    // opens the actions menu and Tabs before that frame runs, the frame would
    // otherwise fire afterwards and yank focus back to the top of the dialog.
    // Holding the frames here makes that ordering explicit instead of
    // depending on how loaded the machine is.
    const frames: FrameRequestCallback[] = [];
    const scheduleFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => frames.push(callback));
    const onClose = vi.fn();
    try {
      renderModal(filedPdf, { onClose });
      await screen.findByTestId('document-details-modal');
      const trigger = screen.getByTestId('document-details-actions-trigger');
      const menu = await openMenu();
      fireEvent.keyDown(menu, { key: 'Tab' });
      await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
      // Forward Tab reaches the dialog's next control, Read, not the trigger again.
      const read = screen.getByTestId('open-reader-button');
      expect(document.activeElement).toBe(read);
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(onClose).not.toHaveBeenCalled();

      // Run the dialog's still-pending initial-focus frame.
      for (const frame of [...frames]) frame(0);
      expect(document.activeElement).toBe(read);
    } finally {
      scheduleFrame.mockRestore();
    }
  });

  it('closes on Shift+Tab and returns focus to the Actions trigger', async () => {
    renderModal(filedPdf);
    await screen.findByTestId('document-details-modal');

    const trigger = screen.getByTestId('document-details-actions-trigger');
    const menu = await openMenu();
    fireEvent.keyDown(menu, { key: 'Tab', shiftKey: true });
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps roving Home and End focus inside the open menu', async () => {
    renderModal(filedPdf);
    await screen.findByTestId('document-details-modal');

    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitem');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('dismisses the menu on an outside pointer press without closing the dialog', async () => {
    const onClose = vi.fn();
    renderModal(filedPdf, { onClose });
    await screen.findByTestId('document-details-modal');
    await openMenu();

    fireEvent.pointerDown(screen.getByTestId('document-details-modal'));
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hides Remove from folder for a document that is not in a folder', async () => {
    renderModal({ ...filedPdf, folderId: null });
    await screen.findByTestId('document-details-modal');

    const menu = await openMenu();
    expect(within(menu).queryByText('Remove from folder')).toBeNull();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
  });

  it('routes each menu command to the same handler the footer buttons used', async () => {
    const onMove = vi.fn();
    const onDelete = vi.fn();
    const onRemoveFromFolder = vi.fn();
    const onClose = vi.fn();

    renderModal(filedPdf, { onMove, onDelete, onRemoveFromFolder, onClose });
    await screen.findByTestId('document-details-modal');
    await openMenu();
    fireEvent.click(screen.getByTestId('document-details-move'));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0]?.[0]).toBe(filedPdf);
    expect(onClose).toHaveBeenCalled();

    cleanup();
    onClose.mockClear();
    renderModal(filedPdf, { onMove, onDelete, onRemoveFromFolder, onClose });
    await screen.findByTestId('document-details-modal');
    await openMenu();
    fireEvent.click(screen.getByTestId('remove-from-folder-button'));
    expect(onRemoveFromFolder).toHaveBeenCalledWith(filedPdf);

    cleanup();
    onClose.mockClear();
    renderModal(filedPdf, { onMove, onDelete, onRemoveFromFolder, onClose });
    await screen.findByTestId('document-details-modal');
    await openMenu();
    // Delete still hands off to the confirmation dialog rather than deleting.
    fireEvent.click(screen.getByTestId('document-details-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]?.[0]).toBe(filedPdf);
  });
});

describe('Document details rows', () => {
  it('keeps the source address and prints neither the rows that restated it nor the content hash', async () => {
    renderModal(capturedArticle);
    const dialog = await screen.findByTestId('document-details-modal');

    expect(screen.getByTestId('document-details-source-url').textContent).toBe(capturedArticle.source!.url);
    expect(dialog.textContent).toContain('Source');

    expect(screen.queryByText('Saved from')).toBeNull();
    expect(screen.queryByTestId('document-details-source-site')).toBeNull();
    expect(screen.queryByText('Captured')).toBeNull();
    expect(screen.queryByTestId('document-details-source-captured')).toBeNull();
    // The address is printed once, and the moment of capture is not printed
    // beside it in any locale form.
    expect(dialog.textContent).not.toContain(
      new Date(capturedArticle.source!.capturedAt).toLocaleString()
    );

    expect(screen.queryByText('SHA-256 Hash')).toBeNull();
    expect(dialog.textContent).not.toContain(capturedArticle.fileHash);
  });

  it('shows no source row at all for a document that was not captured from the web', async () => {
    renderModal({ ...capturedArticle, format: 'pdf', source: null });
    const dialog = await screen.findByTestId('document-details-modal');

    expect(screen.queryByTestId('document-details-source-url')).toBeNull();
    expect(dialog.textContent).toContain('Storage Mode');
  });
});

describe('Document details estimated token count', () => {
  it('shows a truthful loading state and then the locale-formatted estimate', async () => {
    const gate = deferred<DocumentIndexState | null>();
    getIndexState.mockReturnValueOnce(gate.promise);
    renderModal();

    // Truthful while the async state loads: never a fabricated number.
    expect(rowValue()).toContain('Estimated tokens');
    expect(rowValue()).not.toMatch(/\d/u);

    gate.resolve(indexState({ estimatedTokens: 128_450 }));
    await waitFor(() => {
      expect(rowValue()).toContain((128_450).toLocaleString());
    });
    // Never derived from the fixture's file size.
    expect(rowValue()).not.toContain('9,999,999');
    expect(getIndexState).toHaveBeenCalledWith('doc-a');
  });

  it.each([
    ['indexing', INDEXING_STATE, /indexing/iu],
    ['failed', FAILED_STATE, /failed/iu],
    ['not indexed', null, /not indexed/iu],
    ['ready but unavailable', indexState({ estimatedTokens: null }), /unavailable/iu],
  ])('reports a truthful %s state instead of a number', async (_label, state, pattern) => {
    getIndexState.mockResolvedValue(state);
    renderModal();

    await waitFor(() => { expect(rowValue()).toMatch(pattern); });
    expect(rowValue()).not.toMatch(/\d{2,}/u);
  });

  it('displays the exact zero a ready empty index reports', async () => {
    getIndexState.mockResolvedValue(indexState({ estimatedTokens: 0 }));
    renderModal();

    await waitFor(() => { expect(rowValue()).toContain('Estimated tokens0'); });
    expect(rowValue()).not.toMatch(/unavailable/iu);
  });

  it('reports a truthful state when the index state lookup rejects', async () => {
    getIndexState.mockRejectedValue(new Error('IPC failure'));
    renderModal();

    await waitFor(() => { expect(rowValue()).toMatch(/unavailable/iu); });
    expect(rowValue()).not.toMatch(/\d{2,}/u);
  });

  it('ignores a late response for a document the dialog no longer shows', async () => {
    const slow = deferred<DocumentIndexState | null>();
    getIndexState.mockImplementation((documentId) =>
      documentId === 'doc-a'
        ? slow.promise
        : Promise.resolve(indexState({ documentId: 'doc-b', documentHash: 'hash-doc-b', estimatedTokens: 42 }))
    );

    const { rerender } = renderModal(DOC_A);
    rerender(
      <DocumentDetailsModal document={DOC_B} onClose={vi.fn()} onOpen={vi.fn()} onMove={vi.fn()} onRemoveFromFolder={vi.fn()} onDelete={vi.fn()} />
    );
    await waitFor(() => { expect(rowValue()).toContain((42).toLocaleString()); });

    // doc-a's request resolves last; it must not overwrite doc-b's details.
    slow.resolve(indexState({ documentId: 'doc-a', estimatedTokens: 999_999 }));
    await Promise.resolve();
    await waitFor(() => { expect(rowValue()).toContain((42).toLocaleString()); });
    expect(rowValue()).not.toContain((999_999).toLocaleString());
  });

  it('keeps dialog focus and accessibility contracts with the new row', async () => {
    renderModal();
    await waitFor(() => { expect(rowValue()).toContain((128_450).toLocaleString()); });

    const dialog = screen.getByTestId('document-details-modal');
    await waitFor(() => {
      expect(document.activeElement === null || dialog.contains(document.activeElement)).toBe(true);
    });

    const results = await axe.run(dialog, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);

    // The row is a plain readout: it must not become a focus stop.
    const row = screen.getByTestId(ROW_TESTID);
    expect(row.querySelector('button, a, input, [tabindex]')).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(row.contains(document.activeElement)).toBe(false);
  });
});
