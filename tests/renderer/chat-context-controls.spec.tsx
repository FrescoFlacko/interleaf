// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { ChatContextBar } from '../../src/renderer/features/chat/ChatContextBar';
import { cleanContextControlState } from '../../src/renderer/features/chat/clean-context-readiness';
import type { AIProviderStatus, ChatContextItem, ChatMessage, ChatSession } from '@shared/types/ai';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';

/**
 * The attached-context row above the composer field: the `@ Add context` pill
 * and the count lead it, then removable chips and the single Entire document
 * toggle. A whole document is one attachment, so it has exactly one
 * representation, and that representation both attaches and removes it.
 */

const activeDocument: DocumentMetadata = {
  id: 'doc-1',
  title: 'Architecture Guide',
  author: null,
  format: 'pdf',
  storageMode: 'managed',
  fileSize: 10,
  fileMtimeMs: 1,
  fileHash: 'a'.repeat(64),
  pageCount: 40,
  folderId: null,
  storageHealth: 'ok',
  readingPosition: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  source: null,
};

const session: ChatSession = {
  id: 'session-1',
  documentId: 'doc-1',
  documentHash: 'a'.repeat(64),
  title: 'Chat',
  providerId: 'claude',
  modelId: 'claude-opus-5',
  reasoningEffort: null,
  messageCount: 4,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

const wholeDocument: ChatContextItem = {
  id: 'ctx-whole',
  sessionId: session.id,
  documentHash: 'a'.repeat(64),
  kind: 'entire_document',
  sourceRef: {},
  excerptText: '',
  excerptHash: 'b'.repeat(64),
  location: { format: 'pdf', pageIndex: 0 },
  provenance: {},
  displayLabel: 'Entire document',
  pinned: true,
  createdAt: '2026-09-12T00:00:00.000Z',
};

const selectionChip: ChatContextItem = {
  ...wholeDocument,
  id: 'ctx-selection',
  kind: 'selection',
  excerptText: 'text',
  location: { format: 'pdf', pageIndex: 2 },
  displayLabel: 'Page 3 selection',
};

type BarOptions = {
  readonly contextItems?: readonly ChatContextItem[];
  readonly activeSession?: ChatSession | null;
  readonly document?: DocumentMetadata;
};

type Handlers = {
  readonly addEntireDocument: Mock<(document: DocumentMetadata, location: DocumentLocation) => Promise<boolean>>;
  readonly removeContext: Mock<(contextItemId: string) => Promise<void>>;
  readonly addPageRange: Mock<(document: DocumentMetadata, pageStart: number, pageEnd: number) => Promise<boolean>>;
};

/** Mirrors the readiness rule the panel supplies, rather than a stand-in. */
function controlFor(activeSession: ChatSession | null) {
  return cleanContextControlState({
    activeSession,
    sessionProvider: { id: 'claude', name: 'Claude' } as AIProviderStatus,
    messages: [{ role: 'assistant', status: 'complete', content: 'answer', ordinal: 1 } as ChatMessage],
    providerDiscovery: 'succeeded',
    providerReady: true,
    isStreaming: false,
    isLoading: false,
    isCleaningContext: false,
  });
}

function renderBar(options: BarOptions = {}): Handlers {
  const activeSession = options.activeSession === undefined ? session : options.activeSession;
  const handlers: Handlers = {
    addEntireDocument: vi.fn(() => Promise.resolve(true)),
    removeContext: vi.fn(() => Promise.resolve()),
    addPageRange: vi.fn(() => Promise.resolve(true)),
  };
  render(
    <ChatContextBar
      activeDocument={options.document ?? activeDocument}
      currentPage={3}
      explicitLocation={null}
      activeSession={activeSession}
      contextItems={options.contextItems ?? []}
      disabled={controlFor(activeSession).contextMutationsDisabled}
      addEntireDocument={handlers.addEntireDocument}
      addPageRange={handlers.addPageRange}
      removeContext={handlers.removeContext}
    />
  );
  return handlers;
}

async function openPopover(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('chat-pages-trigger'));
  return screen.findByTestId('chat-pages-popover');
}

afterEach(() => { cleanup(); });

describe('the single Entire document control', () => {
  it('represents an attached whole document exactly once, beside the other chips', async () => {
    const { removeContext } = renderBar({ contextItems: [selectionChip, wholeDocument] });

    const toggles = screen.getAllByRole('button', { name: 'Entire document' });
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chat-context-summary')).toHaveTextContent('Context · 2 items');

    // No second representation: the removable chip list carries the selection
    // and nothing that stands for the same whole-document attachment.
    const list = screen.getByTestId('chat-context-list');
    expect(within(list).getByRole('button', { name: 'Entire document' })).toBe(toggles[0]);
    expect(within(list).queryByRole('button', { name: /Remove Entire document/u })).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove Page 3 selection from AI context' }));
    await waitFor(() => { expect(removeContext).toHaveBeenCalledWith('ctx-selection'); });
  });

  it('presses both ways: attaching the intent, then removing the stored item', async () => {
    const { addEntireDocument, removeContext } = renderBar();

    const toggle = screen.getByRole('button', { name: 'Entire document' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    await waitFor(() => { expect(addEntireDocument).toHaveBeenCalledTimes(1); });
    expect(addEntireDocument.mock.calls[0]?.[1]).toEqual({ format: 'pdf', pageIndex: 2 });
    expect(removeContext).not.toHaveBeenCalled();
    cleanup();

    // Main is the authority on what is attached, so the pressed state follows
    // the stored item rather than the click, and pressing again removes it by id.
    const attached = renderBar({ contextItems: [wholeDocument] });
    const pressed = screen.getByRole('button', { name: 'Entire document' });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pressed);
    await waitFor(() => { expect(attached.removeContext).toHaveBeenCalledWith('ctx-whole'); });
    expect(attached.addEntireDocument).not.toHaveBeenCalled();
  });

  it('is the shared companion chip that Agent Mode also draws', () => {
    renderBar();
    const toggle = screen.getByRole('button', { name: 'Entire document' });
    expect(toggle).toHaveClass('companion-whole-doc');
    expect(toggle).toHaveTextContent(/^Entire document$/);
    expect(toggle.querySelector('svg')).not.toBeNull();
  });

  it('stays available before the first conversation exists, since attaching starts one', () => {
    renderBar({ activeSession: null });
    expect(screen.getByRole('button', { name: 'Entire document' })).toBeEnabled();
    expect(screen.getByTestId('chat-pages-trigger')).toBeEnabled();
  });

  it('is withheld on an archived conversation, which offers no remove controls', () => {
    renderBar({ activeSession: { ...session, isArchived: true }, contextItems: [selectionChip] });
    expect(screen.getByRole('button', { name: 'Entire document' })).toBeDisabled();
    expect(screen.getByTestId('chat-pages-trigger')).toBeDisabled();
    expect(within(screen.getByTestId('chat-context-list')).queryByRole('button', { name: /^Remove/u })).toBeNull();
  });
});

describe('the compact Add trigger', () => {
  it('is the leading "@ Add context" pill and keeps its specific name', () => {
    renderBar();
    const trigger = screen.getByTestId('chat-pages-trigger');

    expect(trigger).toHaveAccessibleName('Add pages to AI context');
    expect(trigger).toHaveAttribute('title', 'Add pages to AI context');
    expect(trigger.textContent).toBe('@Add context');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByTestId('chat-context-summary').firstElementChild).toBe(trigger);
    expect(screen.getByTestId('chat-context-summary')).toHaveTextContent('Context · 0 items');
  });

  it('names itself for a document that has no pages to add, and offers no range', async () => {
    const markdown = { ...activeDocument, format: 'markdown', pageCount: null } as DocumentMetadata;
    renderBar({ document: markdown });
    expect(screen.getByTestId('chat-pages-trigger')).toHaveAccessibleName('Add context');
    expect(within(await openPopover()).queryByLabelText('Start page for context')).toBeNull();
  });

  it('opens the popover, keeps focus in it, and closes on Escape without the key escaping', async () => {
    renderBar();
    const trigger = screen.getByTestId('chat-pages-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    const popover = await openPopover();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', popover.id);
    expect(popover).toHaveAttribute('role', 'dialog');
    // The whole document has one control, in the row; the popover only adds pages.
    expect(within(popover).queryByRole('button', { name: 'Entire document' })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(popover).getByLabelText('Start page for context'));
    });

    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(popover, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    await waitFor(() => { expect(screen.queryByTestId('chat-pages-popover')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(trigger); });
  });

  it('validates the page range before asking main, and closes once it is added', async () => {
    const { addPageRange } = renderBar();
    const popover = await openPopover();
    expect(within(popover).getByLabelText('Start page for context')).toHaveValue(3);
    fireEvent.change(within(popover).getByLabelText('End page for context'), { target: { value: '1' } });
    fireEvent.click(within(popover).getByTestId('chat-pages-submit'));
    expect(await screen.findByTestId('chat-pages-error')).toBeTruthy();
    expect(within(popover).getByLabelText('Start page for context')).toHaveAttribute('aria-invalid', 'true');
    expect(addPageRange).not.toHaveBeenCalled();

    fireEvent.change(within(popover).getByLabelText('End page for context'), { target: { value: '5' } });
    fireEvent.click(within(popover).getByTestId('chat-pages-submit'));
    await waitFor(() => { expect(addPageRange).toHaveBeenCalledWith(activeDocument, 3, 5); });
    await waitFor(() => { expect(screen.queryByTestId('chat-pages-popover')).toBeNull(); });
  });

  it('closes when the pointer goes down outside it', async () => {
    renderBar();
    await openPopover();
    fireEvent.pointerDown(document.body);
    await waitFor(() => { expect(screen.queryByTestId('chat-pages-popover')).toBeNull(); });
  });

  it('passes an accessibility audit with the popover open', async () => {
    renderBar({ contextItems: [selectionChip, wholeDocument] });
    await openPopover();
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
