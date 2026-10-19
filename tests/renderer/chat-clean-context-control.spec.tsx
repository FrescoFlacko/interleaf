// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { createRef } from 'react';
import { ChatAddContextMenu } from '../../src/renderer/features/chat/ChatAddContextMenu';
import { ChatContextShelf } from '../../src/renderer/features/chat/ChatContextShelf';
import { cleanContextControlState } from '../../src/renderer/features/chat/clean-context-readiness';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import type {
  AIProviderStatus,
  ChatContextBudget,
  ChatMessage,
  ChatContextItem,
  ChatSession,
} from '@shared/types/ai';
import type { DocumentMetadata } from '@shared/types/document';
import { stubBridge } from '../helpers/interleaf-api';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

/**
 * The conversation's compaction control.
 *
 * Clean Context is a real provider call that rewrites what future turns see, so
 * it has to be discoverable, named exactly that, explain itself before it runs,
 * show that it is running, and be unavailable whenever main would refuse it.
 *
 * It is offered in the context-window panel the composer's wheel opens — beside
 * the figures that say whether this conversation needs compacting — and not in
 * the attached-context row, which manages what is attached and nothing else.
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
  source: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
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

/** One packed request for this session, as main publishes it. */
const budget: ChatContextBudget = {
  sessionId: session.id,
  providerId: 'claude',
  modelId: 'claude-opus-5',
  usedTokens: 2_400,
  totalTokens: 8_000,
  accuracy: 'estimated',
  reservedOutputTokens: 1_000,
  sourceCount: 1,
  breakdown: {
    systemPromptTokens: 200,
    userPromptTokens: 100,
    historyTokens: 300,
    documentContextTokens: 700,
    documentSerializationTokens: 250,
    safetyHeadroomTokens: 100,
    reservedResponseTokens: 1_000,
  },
};

const chip: ChatContextItem = {
  id: 'ctx-1',
  sessionId: session.id,
  documentHash: 'a'.repeat(64),
  kind: 'selection',
  sourceRef: {},
  excerptText: 'text',
  excerptHash: 'b'.repeat(64),
  location: { format: 'pdf', pageIndex: 2 },
  provenance: {},
  displayLabel: 'Page 3 selection',
  pinned: true,
  createdAt: '2026-09-12T00:00:00.000Z',
};

type Overrides = {
  canCleanContext?: boolean;
  isCleaningContext?: boolean;
  cleanContext?: () => Promise<boolean>;
  activeSession?: ChatSession | null;
  messages?: readonly ChatMessage[];
};

/** One settled turn, at the ordinal the conversation stored it at. */
function completedTurn(ordinal: number): ChatMessage {
  return { role: 'assistant', status: 'complete', content: 'answer', ordinal } as ChatMessage;
}

// The readiness rule itself decides presence and availability, so every case
// here is the same refusal main would make rather than a hand-written stand-in.
function controlFor(overrides: Overrides) {
  const activeSession = overrides.activeSession === undefined ? session : overrides.activeSession;
  return cleanContextControlState({
    activeSession,
    sessionProvider: { id: 'claude', name: 'Claude' } as AIProviderStatus,
    messages: overrides.messages ?? [completedTurn(1)],
    providerDiscovery: 'succeeded',
    providerReady: overrides.canCleanContext ?? true,
    isStreaming: false,
    isLoading: false,
    isCleaningContext: overrides.isCleaningContext ?? false,
  });
}

let getContextBudget: Mock;
let listProviders: Mock;

/** The shelf's wheel, with the panel's Clean Context wiring attached. */
async function openStatsPanel(overrides: Overrides = {}): Promise<{
  cleanContext: Mock;
  panel: HTMLElement;
  wheel: HTMLElement;
}> {
  const cleanContext = overrides.cleanContext ?? vi.fn(() => Promise.resolve(true));
  const activeSession = overrides.activeSession === undefined ? session : overrides.activeSession;
  renderWithChatStore(chat,
    <ChatContextShelf
      activeSession={activeSession}
      contextItems={[chip]}
      isStreaming={false}
      disabled={controlFor(overrides).contextMutationsDisabled}
      cleanContext={{ control: controlFor(overrides), onClean: cleanContext }}
      addContextRef={createRef<HTMLButtonElement>()}
      removeContext={vi.fn(() => Promise.resolve())}
    />
  );
  const wheel = await screen.findByTestId('chat-context-budget');
  act(() => { wheel.click(); });
  return { cleanContext: cleanContext as Mock, panel: screen.getByTestId('chat-context-budget-popover'), wheel };
}

/** The context shelf and the footer's Add context control, as the panel wires them. */
function renderBar(overrides: Overrides = {}): void {
  const activeSession = overrides.activeSession === undefined ? session : overrides.activeSession;
  const disabled = controlFor(overrides).contextMutationsDisabled;
  const addContextRef = createRef<HTMLButtonElement>();
  renderWithChatStore(chat,
    <>
      <ChatContextShelf
        activeSession={activeSession}
        contextItems={[chip]}
        isStreaming={false}
        disabled={disabled}
        cleanContext={{ control: controlFor(overrides), onClean: vi.fn(() => Promise.resolve(true)) }}
        addContextRef={addContextRef}
        removeContext={vi.fn(() => Promise.resolve())}
      />
      <ChatAddContextMenu
        activeDocument={activeDocument}
        currentPage={3}
        explicitLocation={null}
        contextItems={[chip]}
        disabled={disabled}
        triggerRef={addContextRef}
        addEntireDocument={vi.fn(() => Promise.resolve(true))}
        addPageRange={vi.fn(() => Promise.resolve(true))}
      />
    </>
  );
}

/** Opens a popover from its trigger and returns it. */
function openFrom(triggerTestId: string, popoverTestId: string): HTMLElement {
  act(() => { screen.getByTestId(triggerTestId).click(); });
  return screen.getByTestId(popoverTestId);
}

describe('Clean Context control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getContextBudget = vi.fn(() => Promise.resolve(budget));
    listProviders = vi.fn(() => Promise.resolve([]));
    chat.setState({ providerBindingRevision: 0, providers: [] });
    useUiStore.setState({ rightTab: 'chat' });
    stubBridge({ chat: { getContextBudget }, ai: { listProviders } });
  });

  afterEach(() => {
    cleanup();
  });

  it('is gone from the context shelf, which keeps only what it names and the wheel', async () => {
    renderBar();
    const bar = screen.getByTestId('chat-context-bar');
    expect(within(bar).queryByTestId('chat-clean-context-trigger')).toBeNull();
    expect(bar.textContent).not.toContain('Clean Context');
    const summary = screen.getByTestId('chat-context-summary');
    expect(summary).toHaveAccessibleName(`Context, 1 item: ${chip.displayLabel}`);
    expect(summary.textContent).toContain(chip.displayLabel);
    // Compaction is reached through the wheel at the shelf's edge, not a button of its own.
    expect(await within(bar).findByTestId('chat-context-budget')).toBeTruthy();
    // Adding context lives with the field, outside the shelf.
    expect(within(bar).queryByTestId('chat-pages-trigger')).toBeNull();
    expect(screen.getByTestId('chat-pages-trigger')).toBeEnabled();
  });

  it('is offered in the context-window panel as a text-only button named Clean Context', async () => {
    const { panel } = await openStatsPanel();
    const trigger = within(panel).getByTestId('chat-clean-context-trigger');

    // Located in the panel that already carries the truthful figures.
    expect(panel.textContent).toContain('2,400 / 8,000 tokens');
    expect(screen.getByTestId('chat-context-budget-breakdown')).toBeTruthy();

    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.textContent).toBe('Clean Context');
    expect(trigger).toHaveAccessibleName('Clean Context');
    expect(trigger).toBeEnabled();
    // Text only: nothing in the icon vocabulary means "compact this
    // conversation", so no glyph is drawn beside the words.
    expect(trigger.querySelector('svg')).toBeNull();
    expect(trigger.querySelector('img')).toBeNull();

    // And nowhere else in the application's chat surfaces.
    expect(screen.getAllByTestId('chat-clean-context-trigger')).toHaveLength(1);
  });

  it('explains what it will do inline, and only runs once confirmed', async () => {
    const { cleanContext, panel } = await openStatsPanel();
    const trigger = within(panel).getByTestId('chat-clean-context-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');

    act(() => { trigger.click(); });
    const confirm = screen.getByTestId('chat-clean-context-confirm-region');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.getAttribute('aria-controls')).toBe(confirm.id);
    // It names the provider it will call and says the chips go away.
    expect(confirm.textContent).toContain('Claude Code · claude-opus-5');
    expect(confirm.textContent).toMatch(/attached context/i);
    expect(cleanContext).not.toHaveBeenCalled();

    // The question is asked inside the panel rather than in a dialog on top of
    // it: one top layer, one Escape target, one scroll container.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBe(panel);

    act(() => { screen.getByTestId('chat-clean-context-cancel').click(); });
    expect(screen.queryByTestId('chat-clean-context-confirm-region')).toBeNull();
    expect(cleanContext).not.toHaveBeenCalled();
    await waitFor(() => { expect(document.activeElement).toBe(trigger); });
    // Cancelling the question leaves the figures it was asked about on screen.
    expect(screen.getByTestId('chat-context-budget-popover')).toBeVisible();

    act(() => { trigger.click(); });
    act(() => { screen.getByTestId('chat-clean-context-confirm').click(); });
    expect(cleanContext).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('chat-clean-context-confirm-region')).toBeNull();
  });

  it('dismisses the question on Escape without running, then closes the panel', async () => {
    const { cleanContext, panel, wheel } = await openStatsPanel();
    const trigger = within(panel).getByTestId('chat-clean-context-trigger');
    act(() => { trigger.click(); });
    expect(screen.getByTestId('chat-clean-context-confirm-region')).toBeTruthy();

    // The innermost thing Escape can close answers first.
    fireEvent.keyDown(screen.getByTestId('chat-clean-context-confirm-region'), { key: 'Escape' });
    expect(screen.queryByTestId('chat-clean-context-confirm-region')).toBeNull();
    expect(screen.getByTestId('chat-context-budget-popover')).toBeVisible();
    expect(cleanContext).not.toHaveBeenCalled();
    await waitFor(() => { expect(document.activeElement).toBe(trigger); });

    // A second Escape closes the panel and hands the reader back to the wheel.
    fireEvent.keyDown(trigger, { key: 'Escape' });
    // The panel fades out (100ms), inert while it leaves.
    await waitFor(() => { expect(screen.queryByTestId('chat-context-budget-popover')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).toBe(wheel); });
    expect(cleanContext).not.toHaveBeenCalled();
  });

  it('leaves the reader where they are when Escape arrives from outside the panel', async () => {
    const { cleanContext, panel } = await openStatsPanel();
    act(() => { within(panel).getByTestId('chat-clean-context-trigger').click(); });
    expect(screen.getByTestId('chat-clean-context-confirm-region')).toBeTruthy();

    // The reader has tabbed on: the panel and its question go away, but their
    // focus is theirs and is not pulled back to a control they have left.
    const elsewhere = document.body.appendChild(document.createElement('button'));
    act(() => { elsewhere.focus(); });
    fireEvent.keyDown(elsewhere, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('chat-clean-context-confirm-region')).toBeNull();
      expect(screen.queryByTestId('chat-context-budget-popover')).toBeNull();
    });
    expect(cleanContext).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('keeps offering compaction for a conversation main has no usage figures for', async () => {
    // The accounting is main's in-memory record of the last packed request, so a
    // restored, rebound or evicted conversation has none. That says nothing about
    // whether it can be compacted, and the control must not vanish with it.
    getContextBudget.mockResolvedValue(null);
    const { cleanContext, panel, wheel } = await openStatsPanel();
    expect(wheel).toHaveAccessibleName('Context window: usage statistics unavailable');
    expect(wheel).toHaveAttribute('data-budget-total', 'unavailable');
    expect(wheel.querySelector('[data-budget-ring]')).toHaveAttribute('data-budget-ring', 'unknown');

    // No aggregate, proportion, bar or itemisation is invented for it.
    expect(within(panel).getByTestId('chat-context-budget-unavailable').textContent).toContain('unavailable');
    expect(within(panel).queryByTestId('chat-context-budget-tokens')).toBeNull();
    expect(within(panel).queryByTestId('chat-context-budget-percentage')).toBeNull();
    expect(within(panel).queryByTestId('chat-context-budget-breakdown')).toBeNull();
    expect(panel.textContent).not.toMatch(/\d%/);

    // And Clean Context behaves exactly as it does beside the figures.
    const trigger = within(panel).getByTestId('chat-clean-context-trigger');
    expect(trigger.textContent).toBe('Clean Context');
    expect(trigger).toBeEnabled();
    act(() => { trigger.click(); });
    expect(cleanContext).not.toHaveBeenCalled();
    act(() => { screen.getByTestId('chat-clean-context-confirm').click(); });
    expect(cleanContext).toHaveBeenCalledTimes(1);
  });

  it('renders no wheel at all with neither figures nor a compaction to offer', async () => {
    getContextBudget.mockResolvedValue(null);
    renderWithChatStore(chat,
      <ChatContextShelf
        activeSession={{ ...session, isArchived: true }}
        contextItems={[chip]}
        isStreaming={false}
        disabled
        cleanContext={{
          control: controlFor({ activeSession: { ...session, isArchived: true } }),
          onClean: vi.fn(() => Promise.resolve(true)),
        }}
        addContextRef={createRef<HTMLButtonElement>()}
        removeContext={vi.fn(() => Promise.resolve())}
      />
    );
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalled(); });
    expect(screen.queryByTestId('chat-context-budget')).toBeNull();
    expect(screen.queryByTestId('chat-clean-context-trigger')).toBeNull();
    // The attachment is still named; only the claim about the window is absent.
    expect(screen.getByTestId('chat-context-summary')).toHaveTextContent(chip.displayLabel);
  });

  it('shows the in-progress state and refuses a second run', async () => {
    const { cleanContext, panel } = await openStatsPanel({ isCleaningContext: true });
    const trigger = within(panel).getByTestId('chat-clean-context-trigger');
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('chat-clean-context-status').textContent).toContain('Cleaning');
    act(() => { trigger.click(); });
    expect(screen.queryByTestId('chat-clean-context-confirm-region')).toBeNull();
    expect(cleanContext).not.toHaveBeenCalled();
  });

  it('goes quiet once every settled turn is already summarised, and returns with a new one', async () => {
    // Main refuses a clean that would summarise nothing, so the control must not
    // offer one: the boundary in the session projection is what decides.
    const summarised = { activeSession: { ...session, compactedThroughOrdinal: 1 } };
    await openStatsPanel({ ...summarised, messages: [completedTurn(1)] });
    expect(screen.getByTestId('chat-clean-context-trigger')).toBeDisabled();
    cleanup();

    await openStatsPanel({ ...summarised, messages: [completedTurn(1), completedTurn(3)] });
    expect(screen.getByTestId('chat-clean-context-trigger')).toBeEnabled();
    cleanup();

    // A turn past the boundary that has not settled is not one to summarise yet.
    await openStatsPanel({
      ...summarised,
      messages: [completedTurn(1), { ...completedTurn(2), status: 'streaming' }],
    });
    expect(screen.getByTestId('chat-clean-context-trigger')).toBeDisabled();
  });

  it('is unavailable whenever main would refuse the request', async () => {
    await openStatsPanel({ canCleanContext: false });
    expect(screen.getByTestId('chat-clean-context-trigger')).toBeDisabled();
    cleanup();

    // An archived conversation cannot be compacted at all, so nothing is shown —
    // the figures it packed still are.
    await openStatsPanel({ activeSession: { ...session, isArchived: true } });
    expect(screen.queryByTestId('chat-clean-context-trigger')).toBeNull();
    expect(screen.getByTestId('chat-context-budget-tokens')).toBeTruthy();
  });

  it('carries no accessibility violations with the question open, at a narrow width', async () => {
    // A pane this narrow is the width the composer's controls already survive;
    // the panel is a column that wraps rather than a row that overflows.
    document.documentElement.style.width = '320px';
    const { panel } = await openStatsPanel();
    act(() => { within(panel).getByTestId('chat-clean-context-trigger').click(); });
    expect(screen.getByTestId('chat-clean-context-confirm-region')).toBeVisible();

    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
    document.documentElement.style.removeProperty('width');
  });

  it('withholds every context mutation of this conversation while it is cleaning', () => {
    // Main refuses all three while a compaction runs, and the commit clears the
    // chips itself, so neither the shelf nor Add context may offer them.
    renderBar({ isCleaningContext: true });
    expect(screen.getByTestId('chat-pages-trigger')).toBeDisabled();
    // What is attached can still be read while it runs; it just cannot be changed.
    const list = openFrom('chat-context-summary', 'chat-context-manage');
    expect(within(list).getByRole('button', { name: `Remove ${chip.displayLabel} from AI context` })).toBeDisabled();
    cleanup();

    // And offers them again as soon as it is not.
    renderBar();
    expect(screen.getByTestId('chat-pages-trigger')).toBeEnabled();
    const menu = openFrom('chat-pages-trigger', 'chat-pages-popover');
    expect(within(menu).getByRole('button', { name: 'Entire document' })).toBeEnabled();
    act(() => { screen.getByTestId('chat-context-summary').click(); });
    expect(within(screen.getByTestId('chat-context-manage')).getByRole('button', { name: `Remove ${chip.displayLabel} from AI context` })).toBeEnabled();
  });
});
