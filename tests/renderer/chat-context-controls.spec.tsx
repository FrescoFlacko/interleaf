// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { ChatAddContextMenu } from '../../src/renderer/features/chat/ChatAddContextMenu';
import { ChatContextShelf } from '../../src/renderer/features/chat/ChatContextShelf';
import { cleanContextControlState } from '../../src/renderer/features/chat/clean-context-readiness';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type { AIProviderStatus, ChatContextItem, ChatMessage, ChatSession } from '@shared/types/ai';
import type { DocumentLocation, DocumentMetadata } from '@shared/types/document';
import { renderWithChatStore } from '../helpers/chat-store';
import { stubBridge } from '../helpers/interleaf-api';

/**
 * The context shelf docked above the Chat field, and the footer's Add context
 * control. The shelf names the first attachment and counts the rest; the full
 * list, with removal, opens on demand. Add context attaches the entire document
 * or a page range. A whole document is one attachment, so the shelf shows it
 * once, first, and that one entry is where it is removed.
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

const quote: ChatContextItem = {
  ...wholeDocument,
  id: 'ctx-quote',
  kind: 'selection',
  excerptText: 'text',
  location: { format: 'pdf', pageIndex: 2 },
  displayLabel: '“Hiring now rewards people who can show their judgement on real work…”',
};

const pages: ChatContextItem = {
  ...wholeDocument,
  id: 'ctx-pages',
  kind: 'range',
  excerptText: 'text',
  location: { format: 'pdf', pageIndex: 11 },
  displayLabel: 'Pages 12–14',
};

const note: ChatContextItem = {
  ...wholeDocument,
  id: 'ctx-note',
  kind: 'location',
  excerptText: 'text',
  location: { format: 'pdf', pageIndex: 20 },
  displayLabel: 'Page 21',
};

type HarnessOptions = {
  readonly contextItems?: readonly ChatContextItem[];
  readonly activeSession?: ChatSession | null;
  readonly document?: DocumentMetadata;
  readonly isStreaming?: boolean;
};

type Handlers = {
  readonly addEntireDocument: Mock<(document: DocumentMetadata, location: DocumentLocation) => Promise<boolean>>;
  readonly removeContext: Mock<(contextItemId: string) => Promise<void>>;
  readonly addPageRange: Mock<(document: DocumentMetadata, pageStart: number, pageEnd: number) => Promise<boolean>>;
};

/** Mirrors the readiness rule the panel supplies, rather than a stand-in. */
function controlFor(activeSession: ChatSession | null, isStreaming: boolean) {
  return cleanContextControlState({
    activeSession,
    sessionProvider: { id: 'claude', name: 'Claude' } as AIProviderStatus,
    messages: [{ role: 'assistant', status: 'complete', content: 'answer', ordinal: 1 } as ChatMessage],
    providerDiscovery: 'succeeded',
    providerReady: true,
    isStreaming,
    isLoading: false,
    isCleaningContext: false,
  });
}

let chat: ChatStore;
let getContextBudget: Mock;

beforeEach(() => {
  chat = createChatStore();
  getContextBudget = vi.fn(() => Promise.resolve(null));
  stubBridge({ chat: { getContextBudget }, ai: { listProviders: vi.fn(() => Promise.resolve([])) } });
  useUiStore.setState({ rightTab: 'chat' });
});

afterEach(() => {
  cleanup();
  chat.dispose();
});

/**
 * The shelf and the Add control wired as the panel wires them: one shared Add
 * ref, and a removal that — like main's — takes the item out of the list once
 * it resolves.
 */
function renderHarness(options: HarnessOptions = {}): Handlers {
  const activeSession = options.activeSession === undefined ? session : options.activeSession;
  const isStreaming = options.isStreaming ?? false;
  const control = controlFor(activeSession, isStreaming);
  const handlers: Handlers = {
    addEntireDocument: vi.fn(() => Promise.resolve(true)),
    removeContext: vi.fn(() => Promise.resolve()),
    addPageRange: vi.fn(() => Promise.resolve(true)),
  };

  function Harness() {
    const [items, setItems] = useState<readonly ChatContextItem[]>(options.contextItems ?? []);
    const addContextRef = useRef<HTMLButtonElement>(null);
    const removeContext = async (contextItemId: string): Promise<void> => {
      await handlers.removeContext(contextItemId);
      setItems((current) => current.filter((item) => item.id !== contextItemId));
    };
    return (
      <>
        <ChatContextShelf
          activeSession={activeSession}
          contextItems={items}
          isStreaming={isStreaming}
          disabled={control.contextMutationsDisabled}
          cleanContext={{ control, onClean: vi.fn(() => Promise.resolve(false)) }}
          addContextRef={addContextRef}
          removeContext={removeContext}
        />
        <ChatAddContextMenu
          activeDocument={options.document ?? activeDocument}
          currentPage={3}
          explicitLocation={null}
          contextItems={items}
          disabled={control.contextMutationsDisabled}
          triggerRef={addContextRef}
          addEntireDocument={handlers.addEntireDocument}
          addPageRange={handlers.addPageRange}
        />
      </>
    );
  }

  renderWithChatStore(chat, <Harness />);
  return handlers;
}

async function openAddContext(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('chat-pages-trigger'));
  return screen.findByTestId('chat-pages-popover');
}

async function openShelfList(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('chat-context-summary'));
  return screen.findByTestId('chat-context-manage');
}

describe('the context shelf', () => {
  it('names a single attachment on one line, with its list only on demand', async () => {
    renderHarness({ contextItems: [quote] });
    const summary = screen.getByTestId('chat-context-summary');

    expect(summary).toHaveAccessibleName(`Context, 1 item: ${quote.displayLabel}`);
    expect(summary).toHaveTextContent(`Context${quote.displayLabel}`);
    expect(summary).toHaveAttribute('aria-haspopup', 'dialog');
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    // No count for a lone item, and no list painted until it is asked for.
    expect(summary.querySelector('.chat-context-shelf-count')).toBeNull();
    expect(screen.queryByTestId('chat-context-list')).toBeNull();

    const list = within(await openShelfList()).getByTestId('chat-context-list');
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(within(list).getByTitle(quote.displayLabel)).toBeInTheDocument();
  });

  it('summarises several attachments as the first and a count, and lists every one', async () => {
    renderHarness({ contextItems: [quote, pages, note] });
    const summary = screen.getByTestId('chat-context-summary');
    expect(summary).toHaveAccessibleName(`Context, 3 items: ${quote.displayLabel}`);
    expect(summary.querySelector('.chat-context-shelf-count')).toHaveTextContent('+2');

    const popover = await openShelfList();
    expect(within(popover).getByRole('heading')).toHaveTextContent('AI context · 3 items');
    const rows = within(within(popover).getByTestId('chat-context-list')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([quote.displayLabel, pages.displayLabel, note.displayLabel]);
    for (const item of [quote, pages, note]) {
      expect(within(popover).getByRole('button', { name: `Remove ${item.displayLabel} from AI context` })).toBeEnabled();
    }
  });

  it('shows an attached whole document once, first, and removes it from that one entry', async () => {
    const { removeContext } = renderHarness({ contextItems: [quote, wholeDocument] });
    const summary = screen.getByTestId('chat-context-summary');
    // Attached after the quote, still listed before it.
    expect(summary).toHaveAccessibleName('Context, 2 items: Entire document');
    expect(screen.queryByRole('button', { name: 'Entire document' })).toBeNull();

    const popover = await openShelfList();
    const rows = within(popover).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['entire_document', 'selection']);
    expect(within(popover).getAllByText('Entire document')).toHaveLength(1);
    fireEvent.click(within(popover).getByRole('button', { name: 'Remove Entire document from AI context' }));
    await waitFor(() => { expect(removeContext).toHaveBeenCalledWith('ctx-whole'); });
    await waitFor(() => { expect(summary).toHaveAccessibleName(`Context, 1 item: ${quote.displayLabel}`); });
  });

  it('with nothing attached, keeps the wheel and an honest empty line rather than a 0%', async () => {
    renderHarness();
    const bar = screen.getByTestId('chat-context-bar');
    expect(within(bar).getByTestId('chat-context-summary')).toHaveTextContent('No context attached');
    const wheel = within(bar).getByTestId('chat-context-budget');
    expect(wheel).toHaveAccessibleName('Context window: usage statistics unavailable');
    expect(wheel.querySelector('[data-budget-ring="unknown"]')).not.toBeNull();
    expect(bar.textContent).not.toMatch(/\d+\s*%/u);
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalledWith('session-1'); });
  });

  it('takes no line at all before a conversation has anything to report', () => {
    renderHarness({ activeSession: null });
    expect(screen.queryByTestId('chat-context-bar')).toBeNull();
    // Context can still be added: attaching starts the conversation.
    expect(screen.getByTestId('chat-pages-trigger')).toBeEnabled();
  });

  it('draws the context-window wheel once, at its own edge', () => {
    renderHarness({ contextItems: [quote, pages] });
    const bar = screen.getByTestId('chat-context-bar');
    expect(screen.getAllByTestId('chat-context-budget')).toHaveLength(1);
    expect(bar.lastElementChild).toBe(screen.getByTestId('chat-context-budget'));
  });
});

describe('removing from the shelf', () => {
  it('keeps focus on a surviving remove button, then hands it to Add context after the last', async () => {
    renderHarness({ contextItems: [quote, pages] });
    const popover = await openShelfList();

    fireEvent.click(within(popover).getByRole('button', { name: `Remove ${quote.displayLabel} from AI context` }));
    const survivor = await within(popover).findByRole('button', { name: `Remove ${pages.displayLabel} from AI context` });
    await waitFor(() => { expect(document.activeElement).toBe(survivor); });
    expect(within(popover).getAllByRole('listitem')).toHaveLength(1);

    fireEvent.click(survivor);
    await waitFor(() => { expect(screen.queryByTestId('chat-context-manage')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByTestId('chat-pages-trigger')); });
    expect(screen.getByTestId('chat-context-summary')).toHaveTextContent('No context attached');
  });

  it('offers no removal on an archived conversation, and no adding either', async () => {
    renderHarness({ activeSession: { ...session, isArchived: true }, contextItems: [quote] });
    expect(screen.getByTestId('chat-pages-trigger')).toBeDisabled();
    // What it read stays readable.
    const popover = await openShelfList();
    expect(within(popover).getByTitle(quote.displayLabel)).toBeInTheDocument();
    expect(within(popover).queryByRole('button', { name: /^Remove/u })).toBeNull();
  });

  it('withholds removal and adding while a turn streams', async () => {
    renderHarness({ contextItems: [quote], isStreaming: true });
    expect(screen.getByTestId('chat-pages-trigger')).toBeDisabled();
    const popover = await openShelfList();
    expect(within(popover).getByRole('button', { name: `Remove ${quote.displayLabel} from AI context` })).toBeDisabled();
  });

  it('closes its list on Escape without the key escaping, and returns focus to the summary', async () => {
    renderHarness({ contextItems: [quote, pages] });
    const popover = await openShelfList();
    await waitFor(() => { expect(popover.contains(document.activeElement)).toBe(true); });

    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(popover, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    await waitFor(() => { expect(screen.queryByTestId('chat-context-manage')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByTestId('chat-context-summary')); });
  });
});

describe('Add context', () => {
  it('is an icon button named for what it opens', () => {
    renderHarness();
    const trigger = screen.getByTestId('chat-pages-trigger');
    expect(trigger).toHaveAccessibleName('Add context');
    expect(trigger).toHaveAttribute('title', 'Add context');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger.textContent).toBe('');
    expect(trigger.querySelector('svg')).not.toBeNull();
  });

  it('attaches the entire document from its first action, then closes back to the button', async () => {
    const { addEntireDocument, removeContext } = renderHarness({ contextItems: [quote] });
    const trigger = screen.getByTestId('chat-pages-trigger');
    const popover = await openAddContext();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', popover.id);
    const action = within(popover).getByRole('button', { name: 'Entire document' });
    await waitFor(() => { expect(document.activeElement).toBe(action); });

    fireEvent.click(action);
    await waitFor(() => { expect(addEntireDocument).toHaveBeenCalledTimes(1); });
    expect(addEntireDocument.mock.calls[0]?.[1]).toEqual({ format: 'pdf', pageIndex: 2 });
    expect(removeContext).not.toHaveBeenCalled();
    await waitFor(() => { expect(screen.queryByTestId('chat-pages-popover')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(trigger); });
  });

  it('marks the entire document as added once main holds it, and opens on the range instead', async () => {
    renderHarness({ contextItems: [wholeDocument] });
    const popover = await openAddContext();
    const action = within(popover).getByRole('button', { name: 'Entire document' });
    expect(action).toBeDisabled();
    expect(action).toHaveAccessibleDescription('Added');
    await waitFor(() => {
      expect(document.activeElement).toBe(within(popover).getByLabelText('Start page for context'));
    });
  });

  it('stays available before the first conversation exists, since attaching starts one', async () => {
    renderHarness({ activeSession: null });
    const popover = await openAddContext();
    expect(within(popover).getByRole('button', { name: 'Entire document' })).toBeEnabled();
    expect(within(popover).getByTestId('chat-pages-submit')).toBeEnabled();
  });

  it('offers no range for a document that has no pages', async () => {
    renderHarness({ document: { ...activeDocument, format: 'markdown', pageCount: null } });
    const popover = await openAddContext();
    expect(within(popover).getByRole('button', { name: 'Entire document' })).toBeEnabled();
    expect(within(popover).queryByLabelText('Start page for context')).toBeNull();
  });

  it('closes on Escape without the key escaping, and returns focus to the button', async () => {
    renderHarness();
    const popover = await openAddContext();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(popover, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    await waitFor(() => { expect(screen.queryByTestId('chat-pages-popover')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByTestId('chat-pages-trigger')); });
  });

  it('keeps Tab inside the popover', async () => {
    renderHarness();
    const popover = await openAddContext();
    const controls = [...popover.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
    const last = controls.at(-1)!;
    act(() => { last.focus(); });
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(controls[0]);
    fireEvent.keyDown(controls[0]!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('validates the page range before asking main, and closes once it is added', async () => {
    const { addPageRange } = renderHarness();
    const popover = await openAddContext();
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

  it('never submits the composer form it sits in when a range is added', async () => {
    const composerSubmit = vi.fn((event: { preventDefault: () => void }) => { event.preventDefault(); });
    const addContextRef = { current: null as HTMLButtonElement | null };
    const addPageRange = vi.fn(() => Promise.resolve(true));
    renderWithChatStore(chat,
      <form onSubmit={composerSubmit}>
        <ChatAddContextMenu
          activeDocument={activeDocument}
          currentPage={3}
          explicitLocation={null}
          contextItems={[]}
          disabled={false}
          triggerRef={addContextRef}
          addEntireDocument={vi.fn(() => Promise.resolve(true))}
          addPageRange={addPageRange}
        />
      </form>
    );
    const popover = await openAddContext();
    fireEvent.submit(within(popover).getByTestId('chat-pages-submit').closest('form')!);
    await waitFor(() => { expect(addPageRange).toHaveBeenCalledTimes(1); });
    expect(composerSubmit).not.toHaveBeenCalled();
    // Portalled out of the composer, so no form is nested inside another.
    expect(popover.closest('form')).toBeNull();
  });

  it('closes when the pointer goes down outside it, and returns focus to the button', async () => {
    renderHarness();
    await openAddContext();
    fireEvent.pointerDown(document.body);
    await waitFor(() => { expect(screen.queryByTestId('chat-pages-popover')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByTestId('chat-pages-trigger')); });
  });

  it('never stands open beside the shelf list', async () => {
    renderHarness({ contextItems: [quote] });
    await openShelfList();
    const trigger = screen.getByTestId('chat-pages-trigger');
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    await screen.findByTestId('chat-pages-popover');
    await waitFor(() => { expect(screen.queryByTestId('chat-context-manage')).toBeNull(); });
  });
});

describe('accessibility', () => {
  it('passes an audit with the Add context popover open', async () => {
    renderHarness({ contextItems: [quote, wholeDocument] });
    await openAddContext();
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('passes an audit with the shelf list open', async () => {
    renderHarness({ contextItems: [quote, wholeDocument, pages] });
    await openShelfList();
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
