// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { createRef } from 'react';
import { ChatContextShelf } from '../../src/renderer/features/chat/ChatContextShelf';
import { createChatStore, type ChatStore } from '../../src/renderer/stores/use-chat-store';
import { renderWithChatStore } from '../helpers/chat-store';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';
import { chatContextBudgetSchema } from '@shared/schemas/ai';
import type { ChatContextBudget, ChatContextItem, ChatSession } from '@shared/types/ai';
import type { CleanContextWiring } from '../../src/renderer/features/chat/ChatContextBudgetMeter';
import { cleanContextControlState } from '../../src/renderer/features/chat/clean-context-readiness';
import { stubBridge } from '../helpers/interleaf-api';

let chat: ChatStore;
beforeEach(() => {
  chat = createChatStore();
});
afterEach(() => {
  chat.dispose();
});

const session: ChatSession = {
  id: 's-1',
  documentId: 'd-1',
  documentHash: 'hash',
  title: 'Session',
  providerId: 'openrouter',
  modelId: 'test/model',
  reasoningEffort: null,
  messageCount: 2,
  previewText: null,
  isArchived: false,
  compactedThroughOrdinal: null,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};

/**
 * One packed request as main publishes it: an aggregate with the itemisation
 * that adds up to it. Every figure the panel prints comes from here, so the
 * fixture is validated against the boundary schema rather than trusted.
 */
const budget: ChatContextBudget = {
  sessionId: 's-1',
  providerId: 'openrouter',
  modelId: 'test/model',
  usedTokens: 2_400,
  totalTokens: 8_000,
  accuracy: 'estimated',
  reservedOutputTokens: 1_000,
  sourceCount: 3,
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

/**
 * The compaction wiring the chat panel derives for a session with no settled
 * turn yet: the control is part of a live conversation but has nothing to clean.
 */
function cleanContextFor(activeSession: ChatSession | null): CleanContextWiring {
  return {
    control: cleanContextControlState({
      activeSession,
      sessionProvider: undefined,
      messages: [],
      providerDiscovery: 'succeeded',
      providerReady: true,
      isStreaming: false,
      isLoading: false,
      isCleaningContext: false,
    }),
    onClean: () => Promise.resolve(false),
  };
}

/**
 * The wheel as the composer draws it: at the edge of the context shelf, which
 * reads main's accounting once and hands the readout to the wheel.
 */
function Meter({ activeSession, contextItems, isStreaming, cleanContext }: {
  readonly activeSession: ChatSession | null;
  readonly contextItems: readonly ChatContextItem[];
  readonly isStreaming: boolean;
  readonly cleanContext: CleanContextWiring;
}) {
  return (
    <ChatContextShelf
      activeSession={activeSession}
      contextItems={contextItems}
      isStreaming={isStreaming}
      disabled={false}
      cleanContext={cleanContext}
      addContextRef={createRef<HTMLButtonElement>()}
      removeContext={() => Promise.resolve()}
    />
  );
}

const NO_FIGURES_LABEL = 'Context window: usage statistics unavailable';

/**
 * A live session always keeps the wheel for its compaction, so a readout with
 * nothing to claim shows as the unavailable wheel rather than disappearing.
 */
function expectNoFigures(): void {
  const meter = screen.getByTestId('chat-context-budget');
  expect(meter.getAttribute('data-budget-total')).toBe('unavailable');
  expect(meter.getAttribute('aria-label')).toBe(NO_FIGURES_LABEL);
}

/** The wheel once main's accounting for a packed request has landed in it. */
function findMeasuredMeter(): Promise<HTMLElement> {
  return waitFor(() => {
    const meter = screen.getByTestId('chat-context-budget');
    expect(meter.getAttribute('aria-label')).not.toBe(NO_FIGURES_LABEL);
    return meter;
  });
}

/** The panel fades out (100ms), inert while it leaves, then unmounts. */
function expectPopoverGone(): Promise<void> {
  return waitFor(() => {
    expect(screen.queryByTestId('chat-context-budget-popover')).toBeNull();
  });
}

let getContextBudget: Mock;
let listProviders: Mock;

function install(): void {
  stubBridge({ chat: { getContextBudget }, ai: { listProviders } });
}

/**
 * The one thing Settings does to the chat store when the configured provider
 * model changes: re-read the providers. Nothing about the session row moves.
 */
function saveProviderSettings(): void {
  act(() => { void chat.getState().refreshProviders(); });
}

/** A reply the test settles by hand, to control arrival order. */
function deferred(): { promise: Promise<ChatContextBudget | null>; settle: (value: ChatContextBudget | null) => void } {
  let settle: (value: ChatContextBudget | null) => void = () => undefined;
  const promise = new Promise<ChatContextBudget | null>((resolve) => { settle = resolve; });
  return { promise, settle };
}

describe('ChatContextBudgetMeter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getContextBudget = vi.fn(() => Promise.resolve(budget));
    listProviders = vi.fn(() => Promise.resolve([]));
    chat.setState({ providerBindingRevision: 0, providers: [] });
    useUiStore.setState({ rightTab: 'chat' });
    install();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a named wheel button when main supplies a real total', async () => {
    const { container } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );

    const meter = await findMeasuredMeter();
    // A real button, so Enter and Space activate it without any key handling of
    // our own, and the browser's own focus and disabled semantics apply.
    expect(meter.tagName).toBe('BUTTON');
    expect(meter).toHaveAttribute('type', 'button');
    expect(meter.getAttribute('data-budget-total')).toBe('known');
    expect(meter.getAttribute('aria-label')).toContain('30% used, last request used 2,400 of 8,000 tokens');
    // The tooltip is the same text, so hovering the ring states its proportion.
    expect(meter).toHaveAttribute('title', meter.getAttribute('aria-label'));
    expect(meter.getAttribute('aria-label')).toContain('estimated');

    const ring = container.querySelector('svg')!;
    expect(ring.getAttribute('aria-hidden')).toBe('true');
    expect(ring.getAttribute('data-budget-ring')).toBe('known');
    expect(container.querySelector('.chat-design-budget-ring-value')).not.toBeNull();

    // Nothing is disclosed until the reader asks, and the composer row carries
    // no prose of its own.
    expect(meter).toHaveAttribute('aria-haspopup', 'dialog');
    expect(meter).toHaveAttribute('aria-expanded', 'false');
    expect(meter).not.toHaveAttribute('aria-controls');
    expect(screen.queryByTestId('chat-context-budget-popover')).toBeNull();
  });

  it('draws no proportion, and says why, when no total context window is available', async () => {
    getContextBudget.mockResolvedValue({ ...budget, totalTokens: null, sourceCount: 1 });
    const { container } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );

    const meter = await findMeasuredMeter();
    expect(meter.getAttribute('data-budget-total')).toBe('unavailable');
    // No denominator, so no arc at all: an unfilled ring would read as a
    // measured zero.
    expect(container.querySelector('.chat-design-budget-ring-value')).toBeNull();
    expect(container.querySelector('svg')!.getAttribute('data-budget-ring')).toBe('unknown');
    expect(meter.getAttribute('aria-label')).toContain('total unavailable');
    expect(meter.getAttribute('aria-label')).toContain('estimated');
    expect(meter.getAttribute('aria-label')).not.toContain(' of ');

    act(() => { meter.click(); });
    // The aggregate is still printed; only the proportion is withheld, because
    // there is no denominator to take a proportion against.
    expect(screen.getByTestId('chat-context-budget-tokens').textContent).toBe('2,400 tokens');
    expect(screen.queryByTestId('chat-context-budget-percentage')).toBeNull();
    expect(screen.queryByTestId('chat-context-budget-reserved-band')).toBeNull();
    expect(screen.getByTestId('chat-context-budget-estimate-label').textContent).toContain('Estimated tokens');
    // Each itemised row falls back to exact tokens rather than a share.
    expect(screen.getByTestId('chat-context-budget-breakdown').textContent).toContain('300 tokens');
    expect(screen.getByTestId('chat-context-budget-unknown-total').textContent)
      .toContain('total context window for this model is unavailable');
  });

  it('opens an anchored popover carrying the whole truthful figure', async () => {
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    const meter = await findMeasuredMeter();

    act(() => { meter.click(); });
    const popover = screen.getByTestId('chat-context-budget-popover');
    expect(meter).toHaveAttribute('aria-expanded', 'true');
    expect(meter.getAttribute('aria-controls')).toBe(popover.id);
    expect(popover.getAttribute('role')).toBe('dialog');
    // The panel is named by its own heading rather than repeating the trigger.
    expect(screen.getByRole('dialog', { name: 'Context window' })).toBe(popover);
    // Focus lands in the panel so the text is reached rather than hunted for.
    expect(document.activeElement).toBe(popover);

    expect(screen.getByTestId('chat-context-budget-tokens').textContent).toBe('2,400 / 8,000 tokens');
    expect(screen.getByTestId('chat-context-budget-percentage').textContent).toBe('30%');
    // The figures are labelled as estimates rather than explained in prose.
    expect(screen.getByTestId('chat-context-budget-estimate-label').textContent).toContain('Estimated tokens');
    expect(screen.queryByTestId('chat-context-budget-summary')).toBeNull();
    expect(popover.textContent).not.toContain('Last request sent');
    expect(popover.textContent).not.toContain('rather than the prompt you are writing');
    // The breakdown the removed paragraph described is still there in full.
    expect(screen.getByTestId('chat-context-budget-breakdown')).toBeTruthy();
    expect(screen.queryByTestId('chat-context-budget-unknown-total')).toBeNull();
  });

  it('itemises the request into grouped rows that add up to the aggregate it prints', async () => {
    // The fixture is what main is contractually allowed to publish.
    expect(chatContextBudgetSchema.safeParse(budget).success).toBe(true);

    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    const meter = await findMeasuredMeter();
    act(() => { meter.click(); });

    const breakdown = screen.getByTestId('chat-context-budget-breakdown');
    const rows = [...breakdown.querySelectorAll('.chat-design-budget-row')].map((row) => ({
      label: row.querySelector('dt')!.textContent,
      value: row.querySelector('dd')!.textContent,
      kind: row.getAttribute('data-budget-row'),
    }));

    expect(rows).toEqual([
      { label: 'System instructions', value: '200 · 2.5%', kind: 'charge' },
      { label: 'Current prompt', value: '100 · 1.3%', kind: 'charge' },
      { label: 'Chat history', value: '300 · 3.8%', kind: 'charge' },
      { label: 'Sources and provenance', value: '700 · 8.8%', kind: 'charge' },
      { label: 'of which serialization overhead', value: '250 · 3.1%', kind: 'share' },
      { label: 'Safety headroom', value: '100 · 1.3%', kind: 'charge' },
      { label: 'Reserved for response', value: '1,000 · 12.5%', kind: 'charge' },
    ]);

    // The charges — every row but the share, which is part of the row above it
    // — are exactly the aggregate the heading prints.
    const charged = rows
      .filter((row) => row.kind === 'charge')
      .reduce((total, row) => total + Number(row.value.split(' · ')[0]!.replace(/,/g, '')), 0);
    expect(charged).toBe(budget.usedTokens);
    expect(screen.getByTestId('chat-context-budget-tokens').textContent).toBe('2,400 / 8,000 tokens');

    // Interleaf sends no tools, so no tool row is invented to fill the shape.
    expect(breakdown.textContent).not.toContain('Tool');
  });

  it('draws actual use and the response reserve as separate bands', async () => {
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    const meter = await findMeasuredMeter();
    act(() => { meter.click(); });

    const popover = screen.getByTestId('chat-context-budget-popover');
    // 1,400 of 8,000 was actually spent; the other 1,000 is held for the answer.
    expect(popover.querySelector<HTMLElement>('.chat-design-budget-bar-use')!.style.width).toBe('17.5%');
    expect(screen.getByTestId('chat-context-budget-reserved-band').style.width).toBe('12.5%');
    expect(popover.textContent).toContain('Reserved for response');
  });

  it('omits a charge of zero rather than listing it', async () => {
    // A first turn has no history to replay and no reserve to hold back.
    getContextBudget.mockResolvedValue({
      ...budget,
      usedTokens: 1_100,
      reservedOutputTokens: 0,
      breakdown: { ...budget.breakdown, historyTokens: 0, reservedResponseTokens: 0 },
    });
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    const meter = await findMeasuredMeter();
    act(() => { meter.click(); });

    const breakdown = screen.getByTestId('chat-context-budget-breakdown');
    expect(breakdown.textContent).not.toContain('Chat history');
    expect(breakdown.textContent).not.toContain('Reserved for response');
    expect(screen.queryByTestId('chat-context-budget-reserved-band')).toBeNull();
    expect(screen.getByTestId('chat-context-budget-tokens').textContent).toBe('1,100 / 8,000 tokens');
  });

  it('escalates through the warning and error thresholds on the wheel and in the panel', async () => {
    getContextBudget.mockResolvedValue(budget);
    const { rerender } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );
    const meter = await findMeasuredMeter();
    expect(meter.getAttribute('data-budget-level')).toBe('normal');
    act(() => { meter.click(); });
    expect(screen.queryByTestId('chat-context-budget-warning')).toBeNull();
    act(() => { screen.getByTestId('chat-context-budget-close').click(); });

    const escalate = async (usedTokens: number, messageCount: number, level: string): Promise<void> => {
      getContextBudget.mockResolvedValue({
        ...budget,
        usedTokens,
        breakdown: { ...budget.breakdown, documentContextTokens: usedTokens - 1_700 },
      });
      rerender(
        <Meter
          activeSession={{ ...session, messageCount }}
          contextItems={[]}
          isStreaming={false}
          cleanContext={cleanContextFor({ ...session, messageCount })}
        />
      );
      await waitFor(() => {
        expect(screen.getByTestId('chat-context-budget').getAttribute('data-budget-level')).toBe(level);
      });
    };

    // 75% of the window is where quality starts to be at stake, 90% where it is.
    await escalate(6_000, 3, 'warning');
    act(() => { screen.getByTestId('chat-context-budget').click(); });
    expect(screen.getByTestId('chat-context-budget-percentage').textContent).toBe('75%');
    expect(screen.getByTestId('chat-context-budget-warning').textContent).toContain('Quality may decline');
    act(() => { screen.getByTestId('chat-context-budget-close').click(); });

    await escalate(7_600, 4, 'error');
    act(() => { screen.getByTestId('chat-context-budget').click(); });
    expect(screen.getByTestId('chat-context-budget-percentage').textContent).toBe('95%');
    expect(screen.getByTestId('chat-context-budget-warning')).toBeInTheDocument();
  });

  it('carries no accessibility violations with the panel open', async () => {
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    const meter = await findMeasuredMeter();
    act(() => { meter.click(); });
    expect(screen.getByTestId('chat-context-budget-popover')).toBeVisible();

    // The panel is portalled to the body, so the whole document is scanned
    // rather than the trigger's own subtree.
    const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('closes on Escape, on Close and on a press outside, and restores focus once', async () => {
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    const meter = await findMeasuredMeter();

    act(() => { meter.click(); });
    fireEvent.keyDown(screen.getByTestId('chat-context-budget-popover'), { key: 'Escape' });
    await expectPopoverGone();
    expect(meter).toHaveAttribute('aria-expanded', 'false');
    expect(meter).not.toHaveAttribute('aria-controls');
    await waitFor(() => { expect(document.activeElement).toBe(meter); });

    act(() => { meter.click(); });
    act(() => { screen.getByTestId('chat-context-budget-close').click(); });
    await expectPopoverGone();
    await waitFor(() => { expect(document.activeElement).toBe(meter); });

    // A press elsewhere dismisses without yanking focus away from wherever the
    // reader just pressed.
    act(() => { meter.click(); });
    act(() => { fireEvent.pointerDown(document.body); });
    await expectPopoverGone();

    // Pressing the wheel again while open closes it rather than reopening.
    act(() => { meter.click(); });
    expect(screen.getByTestId('chat-context-budget-popover')).toBeVisible();
    act(() => { meter.click(); });
    await expectPopoverGone();
  });

  it('closes on Escape after the reader has tabbed out of the panel, and leaves focus alone', async () => {
    renderWithChatStore(chat,
      <>
        <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
        <button type="button" data-testid="composer-stand-in">Send</button>
      </>
    );
    const meter = await findMeasuredMeter();
    act(() => { meter.click(); });
    expect(document.activeElement).toBe(screen.getByTestId('chat-context-budget-popover'));

    // Tab is not trapped, so the reader carries on into the rest of the panel.
    // A key handler on the popover would stop hearing Escape at this point.
    const elsewhere = screen.getByTestId('composer-stand-in');
    act(() => { elsewhere.focus(); });
    fireEvent.keyDown(elsewhere, { key: 'Escape' });

    await expectPopoverGone();
    expect(meter).toHaveAttribute('aria-expanded', 'false');
    // Focus stays where the reader put it: closing does not drag them back.
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(elsewhere);
  });

  it('claims Escape only while the panel is open, and gives the key back when it closes', async () => {
    // Standing in for the application's own Escape router, which only prevents
    // the default when a top layer is open and never closes it for us.
    const seen: string[] = [];
    const appRouter = (event: KeyboardEvent): void => { seen.push(event.key); };
    document.addEventListener('keydown', appRouter);

    const { unmount } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );
    const meter = await findMeasuredMeter();

    // Closed, the key is none of our business and reaches the router untouched.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(seen).toEqual(['Escape']);

    // Open, exactly one listener answers, in the capture phase, so the router
    // never gets to swallow the key while our dialog stays on screen.
    act(() => { meter.click(); });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await expectPopoverGone();
    expect(seen).toEqual(['Escape']);

    // Closed again, nothing of ours is left behind interfering.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(seen).toEqual(['Escape', 'Escape']);

    // And tearing the panel down while it is open takes its listener with it.
    act(() => { meter.click(); });
    unmount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(seen).toEqual(['Escape', 'Escape', 'Escape']);
    document.removeEventListener('keydown', appRouter);
  });

  it('takes the portalled panel away when another companion tab is shown', async () => {
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    const meter = await findMeasuredMeter();
    act(() => { meter.click(); });
    expect(screen.getByTestId('chat-context-budget-popover')).toBeVisible();

    // The chat panel is hidden rather than unmounted when the reader switches
    // tab from the keyboard, and the panel lives on the body: without this it
    // would keep floating over Annotations with nothing beneath it.
    act(() => { useUiStore.getState().setRightTab('annotations'); });
    await expectPopoverGone();
    expect(document.body.querySelector('.chat-design-popover')).toBeNull();
    expect(meter).toHaveAttribute('aria-expanded', 'false');
    expect(meter).not.toHaveAttribute('aria-controls');
  });

  it('takes the popover away with the figure it described', async () => {
    const { rerender } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );
    const meter = await findMeasuredMeter();
    act(() => { meter.click(); });
    expect(screen.getByTestId('chat-context-budget-popover')).toBeVisible();

    getContextBudget.mockImplementation(() => new Promise<ChatContextBudget>(() => undefined));
    rerender(
      <Meter
        activeSession={{ ...session, id: 's-2' }}
        contextItems={[]}
        isStreaming={false}
        cleanContext={cleanContextFor({ ...session, id: 's-2' })}
      />
    );
    // The panel stays for the new session's compaction, but no figure from the
    // other session's request is left in it, and the readout blanks before the
    // new session's read answers.
    expect(screen.getByTestId('chat-context-budget-popover')).toBeVisible();
    expect(screen.queryByTestId('chat-context-budget-tokens')).toBeNull();
    expectNoFigures();
  });

  it('shows no figures when the session has packed no request yet', async () => {
    getContextBudget.mockResolvedValue(null);
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalled(); });
    expectNoFigures();
  });

  it('renders nothing without a session, and asks main for nothing', () => {
    renderWithChatStore(chat, <Meter activeSession={null} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(null)} />);
    expect(screen.queryByTestId('chat-context-budget')).toBeNull();
    expect(getContextBudget).not.toHaveBeenCalled();
  });

  it('drops a reply that belongs to another session', async () => {
    getContextBudget.mockResolvedValue({ ...budget, sessionId: 's-other' });
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalled(); });
    expectNoFigures();
  });

  it('drops a reply packed under a different provider', async () => {
    getContextBudget.mockResolvedValue({ ...budget, providerId: 'claude' });
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalled(); });
    expectNoFigures();
  });

  it('blanks the readout while a provider change keeping the same model refreshes', async () => {
    const { rerender } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );
    await findMeasuredMeter();

    const pending = deferred();
    getContextBudget.mockImplementation(() => pending.promise);
    rerender(
      <Meter
        activeSession={{ ...session, providerId: 'claude' }}
        contextItems={[]}
        isStreaming={false}
        cleanContext={cleanContextFor({ ...session, providerId: 'claude' })}
      />
    );
    // Same model id, different provider: the cached figure describes neither.
    expectNoFigures();
    expect(getContextBudget).toHaveBeenCalledTimes(2);

    pending.settle({ ...budget, providerId: 'claude', usedTokens: 900 });
    const meter = await findMeasuredMeter();
    expect(meter.getAttribute('aria-label')).toContain('900 of 8,000');
  });

  it('blanks the readout while a model change refreshes', async () => {
    const { rerender } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );
    await findMeasuredMeter();

    const pending = deferred();
    getContextBudget.mockImplementation(() => pending.promise);
    rerender(
      <Meter
        activeSession={{ ...session, modelId: 'other/model' }}
        contextItems={[]}
        isStreaming={false}
        cleanContext={cleanContextFor({ ...session, modelId: 'other/model' })}
      />
    );
    expectNoFigures();

    // Main has packed nothing under the new binding yet.
    pending.settle(null);
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalledTimes(2); });
    expectNoFigures();
  });

  it('blanks and re-reads when settings move the effective model of an unchanged session', async () => {
    // The session is stored as `openrouter/auto` and never changes: only the
    // configured OpenRouter model behind it moves, from A to B.
    const auto: ChatSession = { ...session, modelId: 'openrouter/auto' };
    const modelA: ChatContextBudget = { ...budget, modelId: 'model-a', usedTokens: 2_400 };
    const modelB: ChatContextBudget = { ...budget, modelId: 'model-b', usedTokens: 5_100 };
    const stale = deferred();
    const fresh = deferred();
    getContextBudget
      .mockImplementationOnce(() => Promise.resolve(modelA))
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);

    const { rerender } = renderWithChatStore(chat,
      <Meter activeSession={auto} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(auto)} />
    );
    const shown = await findMeasuredMeter();
    expect(shown.getAttribute('aria-label')).toContain('2,400 of 8,000');

    // Settings saves model B and refreshes providers. Nothing else changes.
    saveProviderSettings();
    expectNoFigures();
    expect(getContextBudget).toHaveBeenCalledTimes(2);

    // The next send lands, so main is asked again while the first re-read is
    // still outstanding.
    rerender(
      <Meter
        activeSession={{ ...auto, messageCount: 3 }}
        contextItems={[]}
        isStreaming={false}
        cleanContext={cleanContextFor({ ...auto, messageCount: 3 })}
      />
    );
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalledTimes(3); });
    expectNoFigures();

    // A delayed reply carrying model A's packing must not be painted back on.
    stale.settle(modelA);
    await act(async () => { await stale.promise; });
    expectNoFigures();

    // Only a real packed request under model B brings the readout back.
    fresh.settle(modelB);
    await act(async () => { await fresh.promise; });
    expect(screen.getByTestId('chat-context-budget').getAttribute('aria-label')).toContain('5,100 of 8,000');
  });

  it('discards a reply that arrives after a newer read', async () => {
    const first = deferred();
    const second = deferred();
    getContextBudget.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const { rerender } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );
    rerender(
      <Meter
        activeSession={{ ...session, modelId: 'other/model' }}
        contextItems={[]}
        isStreaming={false}
        cleanContext={cleanContextFor({ ...session, modelId: 'other/model' })}
      />
    );
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalledTimes(2); });

    second.settle({ ...budget, modelId: 'other/model', usedTokens: 500 });
    const meter = await findMeasuredMeter();
    expect(meter.getAttribute('aria-label')).toContain('500 of 8,000');

    // The stale first read lands last and must not overwrite the newer figure.
    first.settle(budget);
    await Promise.resolve();
    expect(screen.getByTestId('chat-context-budget').getAttribute('aria-label')).toContain('500 of 8,000');
  });

  it('keeps the completed request on screen while the next one streams, and promotes it only at the end', async () => {
    const completed: ChatContextBudget = { ...budget, usedTokens: 2_400 };
    const inProgress: ChatContextBudget = { ...budget, usedTokens: 6_800 };
    getContextBudget.mockResolvedValue(completed);

    const { rerender } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );
    const meter = await findMeasuredMeter();
    expect(meter.getAttribute('aria-label')).toContain('2,400 of 8,000');
    expect(getContextBudget).toHaveBeenCalledTimes(1);

    // The reader sends again. Main records what it packed before the provider
    // emits its first token, so anything read now is the turn being answered.
    getContextBudget.mockResolvedValue(inProgress);
    rerender(
      <Meter
        activeSession={{ ...session, messageCount: 3 }}
        contextItems={[]}
        isStreaming
        cleanContext={cleanContextFor({ ...session, messageCount: 3 })}
      />
    );
    await act(async () => { await Promise.resolve(); });

    // Main is not asked at all, and the wheel still describes the request that
    // actually finished rather than relabelling the one in flight.
    expect(getContextBudget).toHaveBeenCalledTimes(1);
    expect(meter.getAttribute('aria-label')).toContain('2,400 of 8,000');
    expect(meter.getAttribute('aria-label')).not.toContain('6,800');
    act(() => { meter.click(); });
    expect(screen.getByTestId('chat-context-budget-tokens').textContent).toBe('2,400 / 8,000 tokens');
    expect(screen.getByTestId('chat-context-budget-popover').textContent).not.toContain('6,800');
    act(() => { screen.getByTestId('chat-context-budget-close').click(); });

    // The answer lands: only now is the new packing a completed request.
    rerender(
      <Meter
        activeSession={{ ...session, messageCount: 4 }}
        contextItems={[]}
        isStreaming={false}
        cleanContext={cleanContextFor({ ...session, messageCount: 4 })}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('chat-context-budget').getAttribute('aria-label')).toContain('6,800 of 8,000');
    });
    expect(getContextBudget).toHaveBeenCalledTimes(2);
  });

  it('shows no figures while the very first request is still streaming', async () => {
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming cleanContext={cleanContextFor(session)} />);
    await act(async () => { await Promise.resolve(); });

    // There is no completed request to describe, and the one being answered is
    // not one, so the honest state is no indicator rather than a borrowed figure.
    expect(getContextBudget).not.toHaveBeenCalled();
    expectNoFigures();
  });

  it('drops a read asked for before the turn began rather than letting it land mid-stream', async () => {
    const pending = deferred();
    getContextBudget.mockImplementation(() => pending.promise);

    const { rerender } = renderWithChatStore(chat,
      <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />
    );
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalledTimes(1); });

    // The next turn starts while that read is still in flight.
    rerender(
      <Meter
        activeSession={{ ...session, messageCount: 3 }}
        contextItems={[]}
        isStreaming
        cleanContext={cleanContextFor({ ...session, messageCount: 3 })}
      />
    );

    // It answers late, carrying the packing for the turn being answered right
    // now. It must not slip in behind the streaming guard and be presented as
    // the last completed request.
    pending.settle({ ...budget, usedTokens: 7_100 });
    await act(async () => { await pending.promise; });
    expectNoFigures();
    expect(getContextBudget).toHaveBeenCalledTimes(1);
  });

  it('shows no figures when the budget cannot be read', async () => {
    getContextBudget.mockRejectedValue(new Error('session is gone'));
    renderWithChatStore(chat, <Meter activeSession={session} contextItems={[]} isStreaming={false} cleanContext={cleanContextFor(session)} />);
    await waitFor(() => { expect(getContextBudget).toHaveBeenCalled(); });
    expectNoFigures();
  });
});
