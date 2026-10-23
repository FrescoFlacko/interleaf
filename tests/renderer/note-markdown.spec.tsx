// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { Annotation } from '@shared/types/annotation';
import type { DocumentMetadata } from '@shared/types/document';
import { AnnotationBrowser } from '../../src/renderer/features/annotations/AnnotationBrowser';
import { NotePopover } from '../../src/renderer/features/reader/components/NotePopover';
import { useAnnotationStore } from '../../src/renderer/stores/use-annotation-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { stubBridge, testInterleafApi } from '../helpers/interleaf-api';
import { testReaderSession } from '../helpers/reader-session';
import { testLoadedAnnotations } from '../helpers/annotation';

const now = '2026-09-05T00:00:00.000Z';

/** The reported AI Chat answer shape: heading + list + strong + code span. */
const NOTE_SOURCE = '## Finding\n\n- **First** item\n- Second item with `code`';
const HOSTILE_SOURCE =
  '<img src="x" onerror="alert(1)">\n\n![pixel](https://example.com/x.png)\n\n[data](data:text/html,bad) and [https](https://example.com)\n\nSee [src-1] for the source.';
const POPOVER_RECT = { left: 10, top: 40, right: 210, bottom: 60 };

const documentRecord: DocumentMetadata = {
  id: 'doc-1',
  title: 'Annotated Book',
  author: 'Reader',
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 100,
  fileMtimeMs: 1,
  fileHash: 'hash-v1',
  pageCount: 5,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: now,
  updatedAt: now,
  source: null,
};

function savedNote(note: string): Annotation {
  return {
    id: 'ann-note',
    documentId: 'doc-1',
    documentHash: 'hash-v1',
    type: 'note',
    anchor: { format: 'pdf', pageIndex: 1, quote: { exact: '', prefix: '', suffix: '' } },
    selectedText: null,
    note,
    label: null,
    color: null,
    isLocationNote: true,
    status: 'anchored',
    createdAt: now,
    updatedAt: now,
  };
}

/** Asserts the semantic Markdown result of NOTE_SOURCE inside one surface. */
function expectRenderedFinding(surface: HTMLElement): void {
  const scope = within(surface);
  expect(scope.getByRole('heading', { name: 'Finding', level: 2 })).toBeInTheDocument();
  expect(scope.getByText('First').closest('strong')).not.toBeNull();
  expect(scope.getByText('code').tagName).toBe('CODE');
  expect(scope.getAllByRole('listitem')).toHaveLength(2);
  expect(surface.textContent).not.toContain('## Finding');
  expect(surface.textContent).not.toContain('**First**');
  expect(surface.textContent).not.toContain('`code`');
}

/** A plain-text note keeps every line, separated by a rendered line break. */
function expectPlainLines(surface: HTMLElement): void {
  const scope = within(surface);
  expect(scope.getByText('Plain note line one.')).toBeInTheDocument();
  expect(scope.getByText('Plain note line two.')).toBeInTheDocument();
  expect(surface.querySelector('br')).not.toBeNull();
}

function renderPopover(note: string): void {
  render(
    <NotePopover
      phase="open"
      rect={POPOVER_RECT}
      content={{ note }}
      onClose={vi.fn()}
    />,
  );
}

describe('saved note Markdown rendering', () => {
  const page = vi.fn();
  const update = vi.fn();

  beforeEach(() => {
    cleanup();
    const api = testInterleafApi({
      annotations: {
        create: vi.fn(),
        list: vi.fn(() => Promise.resolve([])),
        page,
        update,
        delete: vi.fn(),
        repairAnchor: vi.fn(),
      },
      clipboard: { writeText: vi.fn(() => Promise.resolve({ copied: true as const, characterCount: 1 })) },
    });
    stubBridge(api);
    useAnnotationStore.getState().reset();
    useAnnotationStore.setState({ loaded: testLoadedAnnotations('doc-1') });
    useReaderStore.setState({ session: testReaderSession(documentRecord), currentPage: 2 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** Renders the Annotations panel and returns the saved note's list entry. */
  async function renderBrowserWith(note: string): Promise<HTMLElement> {
    const items = [savedNote(note)];
    page.mockResolvedValue({ items, total: items.length, offset: 0, limit: 50 });
    render(<AnnotationBrowser />);
    return waitFor(() => {
      const entry = screen.getByTestId('annotation-page-list').firstElementChild;
      expect(entry).toBeInstanceOf(HTMLElement);
      return entry as HTMLElement;
    });
  }

  it('renders saved Markdown notes with semantic elements in the annotations panel', async () => {
    const entry = await renderBrowserWith(NOTE_SOURCE);
    expectRenderedFinding(entry);
  });

  it('renders saved Markdown notes with semantic elements in the reader note popover', () => {
    renderPopover(NOTE_SOURCE);
    expectRenderedFinding(screen.getByTestId('note-popover-body'));
  });

  it('keeps plain-text note lines readable and separated in both surfaces', async () => {
    const plain = 'Plain note line one.\nPlain note line two.';
    const entry = await renderBrowserWith(plain);
    expectPlainLines(within(entry).getByTestId('markdown-content'));

    renderPopover(plain);
    expectPlainLines(screen.getByTestId('note-popover-body'));
  });

  it('edits the raw Markdown source and saves it unchanged', async () => {
    const revised = `${NOTE_SOURCE}\n- Third item with [a link](https://example.com)`;
    update.mockResolvedValue(savedNote(revised));
    await renderBrowserWith(NOTE_SOURCE);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Note text')).toHaveValue(NOTE_SOURCE);

    // The Markdown source is written verbatim: no rendering, no escaping.
    fireEvent.change(screen.getByLabelText('Note text'), { target: { value: revised } });
    fireEvent.click(screen.getByRole('button', { name: /^Done/u }));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ documentId: 'doc-1', id: 'ann-note', note: revised });
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('closes an unchanged Markdown note without rewriting it', async () => {
    await renderBrowserWith(NOTE_SOURCE);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /^Done/u }));
    await waitFor(() => { expect(screen.queryByLabelText('Note text')).toBeNull(); });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps raw HTML, images, unsafe links, and citation-like text inert in saved notes', async () => {
    const entry = await renderBrowserWith(HOSTILE_SOURCE);
    const body = within(entry).getByTestId('markdown-content');

    expect(within(body).getByTestId('markdown-raw-html')).toHaveTextContent('<img src="x" onerror="alert(1)">');
    expect(within(body).getByTestId('markdown-image-inert')).toHaveTextContent('[pixel]');
    expect(within(body).getAllByTestId('markdown-link-inert')).toHaveLength(2);
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('a')).toBeNull();
    expect(body.querySelector('script')).toBeNull();
    expect(
      Array.from(body.querySelectorAll('*')).some((element) =>
        Array.from(element.attributes).some((attribute) => /^on/iu.test(attribute.name))
      )
    ).toBe(false);

    // A saved note does not carry the chat citation envelope: [src-1] stays text.
    expect(body).toHaveTextContent('See [src-1] for the source.');
    expect(within(body).queryByRole('button')).toBeNull();
  });

  it('passes an accessibility audit with a rendered Markdown note popover', async () => {
    const { container } = render(
      <NotePopover
        phase="open"
        rect={POPOVER_RECT}
        content={{ note: NOTE_SOURCE }}
        onClose={vi.fn()}
      />,
    );

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
